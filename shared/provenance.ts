/**
 * 溯源契约（P0）：账号 / 凭据 / 模型清单三处共用。
 *
 * ## 为什么要收成一份
 *
 * 这三处原本各写一套「数据有多新」的口径：账号卡用 `formatAgo(checkedAt)`，
 * 凭据状态用 `formatLocalMinute()` 打绝对时间，模型清单干脆什么都没有。
 * 结果是同一个界面里，「3 分钟前」「2026-11-10 14:33」和一个没有时间的
 * 模型下拉并排出现 —— 用户没法判断哪一份能当事实。
 *
 * 更麻烦的是 `verified`：读到一个本地文件（缓存的 userName、keyblob mtime、
 * 24h 的磁盘目录）**不等于**向服务方验过这张凭据或这份清单。以前界面把
 * 「检测到本地登录态」和真实账号混在一句话里，用户就一直看到同一个过时账号。
 *
 * 所以每份数据都必须带三件事：从哪来（source）、什么时候读的（probedAt）、
 * 有没有真的验过（verified）。`verified` 默认 false、只能由调用方显式给 true，
 * 不许由「读到了文件」反推 —— 这是本模块的红线。
 *
 * ⚠️ 本文件是纯函数 + 类型，不许 import server/ 或 src/ 下任何模块。
 */

/** 一份对外展示的数据的溯源信息 */
export interface Provenance {
  /** 人类可读的来源（写清文件路径 / 接口名，便于用户自己核对） */
  source: string;
  /** 这次读取发生的时刻（epoch ms） */
  probedAt: number;
  /**
   * 是否真的向服务方校验过。
   * 只读本地文件 / 只读缓存一律 false；只有发起过真实业务请求并拿到结果才 true。
   */
  verified: boolean;
  /**
   * 这份数据自己的陈旧阈值（可选）。
   *
   * 不同来源的「多久算旧」根本不是一回事：ZCode 的套餐缓存超过 24h 就
   * 不能当事实，而 Codex 的 `last_refresh` 隔几十天很正常（有 refresh_token）。
   * 统一套 24h 会把后者也说成「已过期」，那同样是失真。缺省用
   * `PROVENANCE_TTL_MS`。
   */
  ttlMs?: number;
  /** 额外的边界说明（为什么这里改不了 / 为什么不算事实） */
  note?: string;
}

export interface ProvenanceInput {
  probedAt?: number;
  verified?: boolean;
  ttlMs?: number;
  note?: string;
  /** 注入时钟，供纯函数测试用；不传就是 Date.now() */
  now?: number;
}

/**
 * 造一份溯源信息。`verified` 不传就是 false —— 宁可少说，不许把「读到」
 * 说成「验过」。
 */
export function makeProvenance(source: string, input: ProvenanceInput = {}): Provenance {
  return {
    source,
    probedAt: input.probedAt ?? input.now ?? Date.now(),
    verified: input.verified === true,
    ...(Number.isFinite(input.ttlMs) && (input.ttlMs as number) > 0
      ? { ttlMs: input.ttlMs as number }
      : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

/** 一天的毫秒数，也是「太久没验过」的默认阈值 */
export const PROVENANCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 「多久以前」的人话。超过一个月退回日期 —— 「37 天前」对判断新鲜度没有帮助。
 * 未来时间（时钟回拨 / 夹具造的数据）一律说「刚刚」，不显示负数。
 */
export function formatAge(probedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(probedAt)) return '时间未知';
  const diff = now - probedAt;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(probedAt).toLocaleDateString('zh-CN');
}

/** 超过 ttlMs 没重新读就算陈旧；未来时间不算陈旧 */
export function isStale(
  probedAt: number,
  ttlMs: number = PROVENANCE_TTL_MS,
  now: number = Date.now()
): boolean {
  if (!Number.isFinite(probedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const age = now - probedAt;
  return age >= 0 && age > ttlMs;
}

/** 前端把后端给的未知结构安全地收成 Provenance（腐败数据不许显示成「已校验」） */
export function asProvenance(value: unknown): Provenance | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.source !== 'string' || !v.source.trim()) return null;
  if (typeof v.probedAt !== 'number' || !Number.isFinite(v.probedAt)) return null;
  return {
    source: v.source,
    probedAt: v.probedAt,
    verified: v.verified === true,
    ...(typeof v.ttlMs === 'number' && Number.isFinite(v.ttlMs) && v.ttlMs > 0
      ? { ttlMs: v.ttlMs }
      : {}),
    ...(typeof v.note === 'string' && v.note ? { note: v.note } : {}),
  };
}

/**
 * 一行可展示的溯源文案。三段永远齐全：来源 · 探测时间 · 校验状态。
 * 缺数据时明确说「未知」，绝不静默省掉 `未校验` 那一段。
 */
export function describeProvenance(
  value: Provenance | null | undefined,
  options: { now?: number; ttlMs?: number } = {}
): string {
  const p = asProvenance(value);
  if (!p) return '数据来源与时间未知';
  const { now = Date.now(), ttlMs = PROVENANCE_TTL_MS } = options;
  const parts = [
    `来源 ${p.source}`,
    `探测于 ${formatAge(p.probedAt, now)}`,
    p.verified ? '已校验' : '未校验',
  ];
  const text = parts.join(' · ');
  // 数据自带的阈值优先：调用方给的只是「没声明时的默认值」
  return isStale(p.probedAt, p.ttlMs ?? ttlMs, now) ? `${text}（已过期，仅供参考）` : text;
}
