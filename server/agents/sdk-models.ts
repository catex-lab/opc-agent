/**
 * WorkBuddy（SDK 类）模型清单的元数据映射。
 *
 * ## 为什么需要它
 *
 * SDK 有两个取模型的接口：
 *
 *   - `getAvailableModels()`      → 只有 `{ modelId, name }`
 *   - `getAvailableModelsRaw()`   → 同一个清单，但每条带 credits / 中文描述 /
 *                                   上下文长度 / 是否支持图像与推理 / 是否默认
 *
 * 项目一直用的是前一个，于是 WorkBuddy 的模型菜单只有名字 —— 和 opencode 那个
 * bug（A57）是同一类问题：**数据明明拿得到，却在取的时候被丢掉了**。
 * 用户能看到的差别就是：没有「免费 / 付费」，也不知道每个模型多大上下文。
 *
 * ## 免费 / 付费怎么判
 *
 * SDK 给的是 `credits` 倍率字符串，实测三种形态：
 *   `"x0.00"` / `"x0.00 credits"` → 0（本机 hy3 / step-5-preview / deepseek-v4.1-flash 都是 0）
 *   `"x0.34 credits"` / `"x6.67"` → 正数倍率
 *   `""`                          → 未标价（default-model 这类「Auto」以及 custom-local）
 *
 * 只有**能解析出数字**才给角标；解析不出来就留空 —— 和 opencode 那条纪律一致：
 * 标错比不标更糟。
 *
 * ⚠️ `credits` 不是美元，别换算成价格；它是平台自己的计费倍率，原样展示。
 */
import type { ModelOption } from './modelCatalog.js';

/** SDK `getAvailableModelsRaw()` 单条里我们用得到的字段（其余忽略） */
export interface SdkRawModel {
  id?: string;
  name?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  /** 计费倍率，如 `"x0.34 credits"` / `"x0.00"` / `""` */
  credits?: string;
  /** 上下文总窗口（token） */
  maxAllowedSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  onlyReasoning?: boolean;
  isDefault?: boolean;
  /** 平台标记为不可用时不展示 */
  disabled?: boolean;
}

/** 从 `"x0.34 credits"` 里取 0.34；取不到返回 null（**不猜**） */
export function parseCredits(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/x\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function fmtContext(n?: number): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1048576) return `${Math.round(n / 1048576)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * 倍率展示：0.34 → `0.34x`（与官方菜单同款；不做任何货币换算）
 *
 * 固定两位小数、**不要**再过一遍 `Number()` —— 官方菜单就是 `0.14x` / `3.31x` /
 * `6.67x` 这种两位形态，0 也写作 `0.00x`。早先写成 `Number(n.toFixed(2))`，
 * 0 会被还原成数字 0 再拼成 `"0x"`，和官方对不上。
 */
function fmtMultiplier(n: number): string {
  return `${n.toFixed(2)}x`;
}

/** 第二行说明：中文简介 · 上下文 200K（倍率单独右对齐，不混进来） */
export function describeSdkModel(m: SdkRawModel): string | undefined {
  const parts: string[] = [];
  const zh = (m.descriptionZh || m.descriptionEn || '').trim();
  if (zh) parts.push(zh);
  const ctx = fmtContext(m.maxAllowedSize ?? m.maxInputTokens);
  if (ctx) parts.push(`上下文 ${ctx}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * 重名消歧：真实清单里有两条都叫 `Deepseek-V4.1-Flash`
 * （`deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg`，倍率 0.00x / 0.03x），
 * 菜单里两行同名，用户没法判断该点哪个。
 *
 * 做法：**只从 id 本身取差异片段**（同组 id 的公共前缀之后的剩余部分），
 * 追加成 `名字 (sg)`。不翻译、不推断「sg 是新加坡」—— 只把 id 里真实存在的
 * 差异摆出来，宁可朴素也不编造。
 */
function disambiguateNames(entries: { id: string; name: string }[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const arr = groups.get(e.name);
    if (arr) arr.push(e.id);
    else groups.set(e.name, [e.id]);
  }

  const suffixById = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    let prefix = ids[0];
    for (const id of ids) {
      let i = 0;
      while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++;
      prefix = prefix.slice(0, i);
    }
    for (const id of ids) {
      const tail = id.slice(prefix.length).replace(/^[-_:/.]+/, '');
      if (tail) suffixById.set(id, tail);
    }
  }
  return suffixById;
}

/**
 * 把 SDK 原始清单映射成前端模型列表。
 *
 * 顺序**保持 SDK 给的顺序**（Auto 在最前，那是平台自己的默认与推荐顺序），
 * 不像 opencode 那样重排 —— 那是另一个 provider 的目录，排序规则不该互相套用。
 *
 * ## 关于官方菜单的三种标签
 *
 * 官方 App 显示 `Free now` / `Pro Only` / 倍率三样东西。其中：
 *   - `Free now`  ← credits = 0，**能算**，这里映射成「限时免费」
 *   - 倍率        ← credits 数值，**能算**，右对齐显示 `0.34x`
 *   - `Pro Only`  ← 套餐权限位，SDK 的模型清单里**没有任何对应字段**
 *     （已逐条扫过 `plan` / `tier` / `pro` / `access` / `locked` 等关键词，
 *     原始条目只有 credits / 描述 / 上下文 / 模态 / 推理这些能力字段）。
 *     它是官方客户端按**账号订阅状态**贴的标，本应用拿不到账号套餐，
 *     所以**不猜** —— 猜错会让免费用户以为能用，或让 Pro 用户以为不能用。
 */
export function mapSdkModels(raw: unknown[]): {
  models: ModelOption[];
  defaultModel?: string;
} {
  const picked: SdkRawModel[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const m = item as SdkRawModel;
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    if (m.disabled === true) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    picked.push(m);
  }

  const suffixById = disambiguateNames(picked.map(m => ({ id: m.id as string, name: m.name || (m.id as string) })));

  const models: ModelOption[] = [];
  let defaultModel: string | undefined;

  for (const m of picked) {
    const id = m.id as string;
    const credits = parseCredits(m.credits);
    const suffix = suffixById.get(id);
    models.push({
      modelId: id,
      name: `${m.name || id}${suffix ? ` (${suffix})` : ''}`,
      description: describeSdkModel(m),
      tag: credits === null ? undefined : credits === 0 ? '限时免费' : '付费',
      multiplier: credits === null ? undefined : fmtMultiplier(credits),
    });

    if (m.isDefault && !defaultModel) defaultModel = id;
  }

  return { models, defaultModel };
}
