/**
 * A217：SDK 发送轮次的「失败分类 → 恢复决策」。
 *
 * ## 为什么单独一层
 *
 * 2026-11-13 真机事故里，发送路径只有两种结局：无限等（A214 之前）或
 * 一律报错（A214 之后）。但 `probe()` 早就有 A178 的 initialize 冷启动补偿，
 * 发送路径却没有 —— 于是用户每次重发都冷启动一个新 CLI，稳定卡满 60s
 * `Request timeout: initialize`，前端只看到一句没有上下文的错误。
 *
 * 这里把「什么错、能不能重、拿什么重」收敛成一个**不碰 IO 的纯函数**：
 * 适配器只负责执行决策，闸门可以直接把每种失败形态摆到台面上验证。
 *
 * ## 唯一的安全重试窗口
 *
 * 原注释写「不做轮内重试 —— prompt 可能已在 CLI 侧执行了一半，重放有双重
 * 副作用风险」。这条**依然成立**，但它管的是「已经产出过内容的轮次」。
 * 两种失败有明确的零产出证据：
 *
 *   - `initialize` 超时：CLI 还在握手（加载产品配置 / 鉴权 / 列模型），
 *     prompt 根本没进模型，连工具都没起；
 *   - 首字护栏超时：A214 守的正是 `send() → 首条流事件`，超时意味着
 *     这一轮一个流事件都没到，同样没有任何东西被执行。
 *
 * 所以判据是 `firstTokenSeen === false`，而不是「错误类型看起来像超时」。
 * 只要用户已经看见一个字、一个工具卡，就一律不再重发。
 *
 * ## 两种重试不是一回事
 *
 *   - initialize 超时 → **同模型**重建 CLI（问题在握手，跟选哪个模型无关）；
 *   - 自定义模型首字超时 → **换内置兜底模型**重建 CLI，并如实告知用户
 *     （官方 Model Configuration 明确「保存配置 / Test Connection ≠ 真能跑通一轮」）。
 *
 * 内置模型自己首字超时不重试：那通常是免费模型排队或同账号并发占用，
 * 再等一轮 120s 只是把用户的时间翻倍，如实报错让他自己决定重发更合适。
 *
 * ## 错误分类的口径
 *
 * 依据官方 TypeScript SDK 参考的 `errors_info.category`
 * （`network` / `quota` / `auth` / `model_service` / `cancelled` / `internal`）
 * 与打包 CLI 里实际出现的 `empty_model_response` / `custom_model_auth`，
 * 再补上我们自己的 `initialize-timeout` / `first-token-timeout`（这两类
 * 是**控制请求 / 护栏**层的，不属于模型服务的错误分类）。
 */
import { SDK_DEFAULT_MODEL } from '../../model-routing.js';

export type SdkFailureCategory =
  | 'initialize-timeout'
  | 'first-token-timeout'
  | 'auth'
  | 'quota'
  | 'network'
  | 'model-service'
  | 'empty-model-response'
  | 'cancelled'
  | 'other';

/** 最多自动恢复一次。两次以上只会把「一直没响应」变成「更久没响应」。 */
export const MAX_TURN_RECOVERY_ATTEMPTS = 1;

/**
 * 把一条错误文案归类。顺序即优先级：
 * initialize / 首字护栏是**我们自己的**超时层，必须先于泛化的 `timeout` 匹配；
 * 否则「首字超时：…120 秒…」会被 `network` 的 `/超时/` 吃掉。
 */
export function classifySdkFailure(message: string): SdkFailureCategory {
  const m = String(message ?? '');
  if (/Request timeout:\s*initialize|initialize.*timed out|initialize.*超时/i.test(m)) {
    return 'initialize-timeout';
  }
  if (/首字超时|first[\s_-]?token.*timeout/i.test(m)) return 'first-token-timeout';
  if (/401|403|unauthorized|invalid\s*(api\s*)?(key|token)|token\s*(expired|invalid)|凭据(无效|失效)|认证失败|custom_model_auth/i.test(m)) {
    return 'auth';
  }
  if (/quota|额度|rate[\s_-]?limit|429|too many requests/i.test(m)) return 'quota';
  if (/empty_model_response|did not return a usable response|模型没有返回可用|空响应/i.test(m)) {
    return 'empty-model-response';
  }
  if (/model_service|model service unavailable|模型服务(异常|不可用)/i.test(m)) {
    return 'model-service';
  }
  if (/ECONN|ENOTFOUND|socket|network|502|503|504|timeout|超时|网络/i.test(m)) {
    return 'network';
  }
  if (/cancelled|canceled|已取消|aborted/i.test(m)) return 'cancelled';
  return 'other';
}

/** 分类对应的、用户能直接做的那一步。空串 = 没有额外建议，不硬凑文案。 */
export function failureAdvice(category: SdkFailureCategory): string {
  switch (category) {
    case 'initialize-timeout':
      return 'SDK 冷启动握手超时，请稍后重发；若持续出现请重启应用。';
    case 'first-token-timeout':
      return '可直接重发；若反复出现，建议切换到内置模型或稍后再试。';
    case 'auth':
      return '登录态可能已失效，请在 WorkBuddy 桌面客户端重新登录后再试。';
    case 'quota':
      return '可能是额度用尽或触发限流，请稍后再试或更换模型。';
    case 'network':
      return '请检查网络与代理设置（系统设置 → 网络代理）。';
    case 'model-service':
    case 'empty-model-response':
      return '模型没有返回可用内容，建议切换内置模型后重发。';
    case 'cancelled':
      return '本轮已取消，可直接重发。';
    default:
      return '';
  }
}

/**
 * 自定义模型 id 的判据。
 *
 * `custom-local:` 不是我们拼出来的 —— 官方 SDK 的 `InitializeHandler` 日志里
 * 就把桌面端 models.json 的模型列成 `custom-local:sensenova-…`。
 * 同时兼容 `custom:` 前缀，避免官方以后改命名。
 */
export function isCustomModelId(model: string | undefined | null): boolean {
  if (!model) return false;
  return /^custom(?:-local)?:/i.test(model);
}

/**
 * 兜底模型：用 SDK 自己声明的默认别名（Auto），不硬编码任何具体型号 ——
 * 具体清单会随版本变，写死型号迟早变成「界面能选、实际跑不了」。
 *
 * 可经 `OPC_SDK_FALLBACK_MODEL` 覆盖；设为 `off` 表示禁用降级。
 * 强制 `fallback !== model`：SDK 的 `process-transport.js` 在两者相同时会
 * 直接抛 `Fallback model cannot be the same as the main model.`
 */
export function resolveFallbackModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const raw = (process.env.OPC_SDK_FALLBACK_MODEL ?? '').trim();
  if (raw.toLowerCase() === 'off') return undefined;
  const candidate = raw || SDK_DEFAULT_MODEL;
  return candidate === model ? undefined : candidate;
}

export type RecoveryAction = 'retry-same-model' | 'retry-fallback-model' | 'report';

export interface RecoveryInput {
  category: SdkFailureCategory;
  /** 本轮是否已经向用户产出过任何可见内容（首字 / 工具 / 结果） */
  firstTokenSeen: boolean;
  /** 已经恢复过几次；0 = 首次尝试 */
  attempt: number;
  /** 本机是否真的有 CLI（没有时重试只是多等一轮） */
  hasCli: boolean;
  model?: string;
  fallbackModel?: string;
  /** 首字护栏的秒数，用于如实告知用户等了多久 */
  guardSeconds?: number;
}

export interface RecoveryPlan {
  action: RecoveryAction;
  /** 重试时使用的模型；action='report' 时缺省 */
  model?: string;
  /** 如实告知用户的说明（渲染成 note，不冒充助手正文） */
  notice?: string;
  /** 给用户看的补充建议 */
  advice: string;
  /** 决策理由（日志 / 闸门用，不进 UI） */
  reason: string;
}

/**
 * 唯一入口：给出「要不要重、拿什么重、要不要告诉用户」。
 *
 * 四条硬规矩：
 * 1. 已经产出过内容 ⇒ 永不重试（防重放双重副作用）；
 * 2. 已经恢复过 ⇒ 永不二次重试（防死循环）；
 * 3. 没有 CLI ⇒ 不重试（没有可执行对象）；
 * 4. 只有 initialize 超时 / 自定义模型首字超时这两种形态可恢复。
 */
export function planTurnRecovery(input: RecoveryInput): RecoveryPlan {
  const advice = failureAdvice(input.category);
  const report = (reason: string): RecoveryPlan => ({ action: 'report', advice, reason });

  if (input.firstTokenSeen) return report('本轮已有可见产出，重放会造成双重副作用');
  if (input.attempt >= MAX_TURN_RECOVERY_ATTEMPTS) return report('已经自动恢复过一次，不再重试');
  if (!input.hasCli) return report('本机没有可用 CLI，重试无意义');

  if (input.category === 'initialize-timeout') {
    return {
      action: 'retry-same-model',
      model: input.model,
      advice,
      reason: 'CLI 握手阶段超时、prompt 尚未进入模型：重建进程用同模型再试一次',
    };
  }

  if (
    input.category === 'first-token-timeout' &&
    isCustomModelId(input.model) &&
    input.fallbackModel &&
    input.fallbackModel !== input.model
  ) {
    const waited = input.guardSeconds ? `${input.guardSeconds} 秒` : '护栏时间内';
    return {
      action: 'retry-fallback-model',
      model: input.fallbackModel,
      advice,
      notice:
        `自定义模型「${input.model}」在 ${waited} 内没有任何返回，` +
        `已自动改用内置模型「${input.fallbackModel}」重试。` +
        `本轮没有产生任何内容，不会重复执行指令。`,
      reason: '自定义模型首轮挂起且零产出：换内置兜底模型重建会话，并如实告知',
    };
  }

  return report('不属于可安全恢复的冷启动窗口');
}
