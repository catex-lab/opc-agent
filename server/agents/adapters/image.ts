/**
 * 生图 provider（P4-4）。
 *
 * 为什么不复用 AgentProvider：`AgentProvider.send()` 的契约是「流式产出
 * 文本 / 工具调用事件」，而生图是「一次 HTTP 调用 → 一个图像 URL」——
 * 没有增量、也不属于任何 Agent 的会话上下文。硬塞进 AgentEvent 会把
 * text / tool 的语义污染掉（前端会多出一个「空气泡」再被图片覆盖）。
 * 所以这里单独定义一个小得多的 ImageProvider 契约。
 *
 * 本模块**只做 HTTP**，不碰文件系统、不碰数据库：
 *   - 落盘缓存在 `server/image-store.ts`（CogView 返回的是带签名的临时 URL）
 *   - 落库在 HTTP 层（`/api/image`）
 * 这样它可以被单独验证 —— 注入 `fetchImpl` 即可完全离线跑断言。
 *
 * 实测（2026-10-17，本机 `open.bigmodel.cn` 可达）：
 *   - `cogview-3-flash` 可用且免费，返回 `{ created, data:[{ url }] }`；
 *     但产物带水印（URL 形如 `..._watermark.png`），这是免费额度的代价。
 *   - `cogview-4` / `cogview-3-plus` 返回 `code 1113 余额不足或无可用资源包`
 *     —— 密钥有效，只是账户没有付费资源包。因此默认模型取 flash。
 *   - 合法尺寸：1024x1024 / 1344x768 / 768x1344 / 1440x720 / 1024x1536；
 *     `auto` 会被拒（`code 1214 size参数不合法`）。
 */

/** CogView 实测可用的尺寸（`auto` 会被 1214 拒绝，故不列入） */
export type ImageSize = '1024x1024' | '1344x768' | '768x1344' | '1440x720' | '1024x1536';

export const IMAGE_SIZES: readonly ImageSize[] = [
  '1024x1024',
  '1344x768',
  '768x1344',
  '1440x720',
  '1024x1536',
];

export const DEFAULT_IMAGE_SIZE: ImageSize = '1024x1024';

/** 尺寸的中文说明，供 UI 下拉使用 */
export const IMAGE_SIZE_LABELS: Record<ImageSize, string> = {
  '1024x1024': '正方形 1024×1024',
  '1344x768': '横版 1344×768',
  '768x1344': '竖版 768×1344',
  '1440x720': '宽屏 1440×720',
  '1024x1536': '长竖版 1024×1536',
};

export interface ImageGenerationRequest {
  prompt: string;
  /** 不传则用 provider 的 defaultModel */
  model?: string;
  size?: ImageSize;
  /** 用户侧请求 id（智谱用于追踪 / 幂等） */
  requestId?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** 远端图像地址（**带签名、会过期**，落盘由 image-store 负责） */
  url: string;
  model: string;
  size: ImageSize;
  provider: string;
  prompt: string;
}

export type ImageAvailability = 'ready' | 'needs-auth' | 'unreachable';

export interface ImageProviderStatus {
  availability: ImageAvailability;
  /** 面向用户的说明 / 修复指引 */
  message?: string;
  models: string[];
  defaultModel: string;
  sizes: readonly ImageSize[];
}

export interface ImageProvider {
  readonly id: string;
  readonly name: string;
  readonly vendor?: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  /** 同步返回可用性（只查密钥，不打网络，因此不会阻塞名册渲染） */
  status(): ImageProviderStatus;
  generate(req: ImageGenerationRequest, fetchImpl?: typeof fetch): Promise<GeneratedImage>;
}

/** 生图调用失败时抛出的错误，携带足够信息让上层给修复指引 */
export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'balance' | 'invalid' | 'network' | 'upstream',
    readonly raw?: unknown
  ) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

// ============= 智谱 CogView =============

const COGVIEW_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/images/generations';

/**
 * 解析密钥。
 *
 * 同时认 `ZHIPU_API_KEY` 与 `GLM_API_KEY`：智谱在自家 CLI / SDK 里两个名字
 * 都用过，本机实测**两个变量都存在且都能调通** flash 模型。只认一个会造成
 * 「明明配了却报未登录」的假阴性（与 opencode 的 authEnvs 同一教训）。
 */
export function resolveCogViewApiKey(): string | undefined {
  const key = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

/** 智谱业务错误码 → 面向用户的说明 */
function describeUpstreamError(code: string | undefined, message: string): {
  text: string;
  kind: ImageGenerationError['kind'];
} {
  switch (code) {
    case '1113': {
      // 上游文案自带句号（「…请充值。」），直接拼接会出现「。。」
      const detail = message.replace(/[。.]+$/, '');
      return {
        text: `生图账户余额不足或无可用资源包：${detail}。请在 open.bigmodel.cn 充值，或改用免费模型 cogview-3-flash。`,
        kind: 'balance',
      };
    }
    case '1214':
      return { text: `生图参数不合法：${message}`, kind: 'invalid' };
    case '1002':
    case '1001':
      return { text: `生图鉴权失败：${message}`, kind: 'auth' };
    default:
      return { text: `生图失败${code ? `（${code}）` : ''}：${message}`, kind: 'upstream' };
  }
}

export class CogViewProvider implements ImageProvider {
  readonly id = 'cogview';
  readonly name = '智谱 CogView';
  readonly vendor = 'Zhipu AI';
  /**
   * 默认取 flash：本机实测**唯一免费且立即可用**的模型。
   * 默认值选一个要付费才能跑的模型，等于让新用户第一次点生图就失败。
   */
  readonly defaultModel = 'cogview-3-flash';
  readonly models = ['cogview-3-flash', 'cogview-4', 'cogview-3-plus'] as const;
  private readonly endpoint: string;

  constructor(endpoint: string = COGVIEW_ENDPOINT) {
    this.endpoint = endpoint;
  }

  status(): ImageProviderStatus {
    if (!resolveCogViewApiKey()) {
      return {
        availability: 'needs-auth',
        message:
          '未配置智谱密钥。请设置环境变量 ZHIPU_API_KEY 或 GLM_API_KEY 后重启应用（获取地址：open.bigmodel.cn）。',
        models: [...this.models],
        defaultModel: this.defaultModel,
        sizes: IMAGE_SIZES,
      };
    }
    return {
      availability: 'ready',
      models: [...this.models],
      defaultModel: this.defaultModel,
      sizes: IMAGE_SIZES,
    };
  }

  async generate(
    req: ImageGenerationRequest,
    fetchImpl: typeof fetch = fetch
  ): Promise<GeneratedImage> {
    const prompt = (req.prompt || '').trim();
    if (!prompt) {
      throw new ImageGenerationError('生图提示词不能为空', 'invalid');
    }

    const apiKey = resolveCogViewApiKey();
    if (!apiKey) {
      throw new ImageGenerationError(
        '未配置智谱密钥（ZHIPU_API_KEY / GLM_API_KEY），无法生图',
        'auth'
      );
    }

    const model = req.model && req.model.trim() ? req.model.trim() : this.defaultModel;
    const size: ImageSize = req.size && IMAGE_SIZES.includes(req.size) ? req.size : DEFAULT_IMAGE_SIZE;

    const body: Record<string, unknown> = { model, prompt, size };
    if (req.requestId) body.request_id = req.requestId;

    let res: Response;
    try {
      res = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      // 网络层失败（DNS / 代理 / 超时）：与「密钥错」是两回事，分开报，
      // 用户才知道该去查网络而不是去重新申请密钥。
      throw new ImageGenerationError(
        `生图服务不可达（open.bigmodel.cn）：${(err as Error).message}`,
        'network',
        err
      );
    }

    // 读取文本再解析：无论成功失败，智谱都用 JSON 回包说明原因
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw new ImageGenerationError(
        `读取生图响应失败：${(err as Error).message}`,
        'network',
        err
      );
    }

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    const obj = (payload ?? {}) as {
      data?: Array<{ url?: string; b64_json?: string }>;
      error?: { code?: string; message?: string };
      request_id?: string;
    };

    if (obj.error) {
      const { text: msg, kind } = describeUpstreamError(
        obj.error.code,
        obj.error.message || '未知错误'
      );
      throw new ImageGenerationError(msg, kind, obj.error);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ImageGenerationError(
          `生图鉴权失败（HTTP ${res.status}）：请检查 ZHIPU_API_KEY / GLM_API_KEY 是否有效`,
          'auth',
          { status: res.status, text }
        );
      }
      throw new ImageGenerationError(
        `生图服务返回 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`,
        'upstream',
        { status: res.status, text }
      );
    }

    const url = obj.data?.[0]?.url;
    if (!url || typeof url !== 'string') {
      throw new ImageGenerationError(
        '生图响应中没有图像地址（data[0].url 缺失）',
        'upstream',
        payload
      );
    }

    return { url, model, size, provider: this.id, prompt };
  }
}

// ============= 注册表 =============

const PROVIDERS: ImageProvider[] = [new CogViewProvider()];

/** 全部生图 provider（当前仅 CogView） */
export function listImageProviders(): ImageProvider[] {
  return PROVIDERS;
}

/** 按 id 取生图 provider；不传取第一个（当前唯一） */
export function getImageProvider(id?: string): ImageProvider | undefined {
  if (!id) return PROVIDERS[0];
  return PROVIDERS.find(p => p.id === id);
}

/** 聚合状态，供 `GET /api/image/providers` 直接返回 */
export function imageProvidersStatus() {
  return PROVIDERS.map(p => ({
    id: p.id,
    name: p.name,
    vendor: p.vendor,
    // status() 已含 models / defaultModel / sizes，展开即可，不再重复声明
    ...p.status(),
  }));
}
