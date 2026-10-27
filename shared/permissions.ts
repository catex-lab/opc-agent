/**
 * 审批选项与拒绝原因码（P4）—— 前后端共用同一份，不再各抄一份。
 *
 * ## 为什么选项要跟适配器能力走
 *
 * 「本会话始终允许」不是一个 UI 文案，而是一句承诺：点了以后，同类工具
 * 必须真的不再问。SDK 适配器可以在自己进程里记住；ACP 由服务端提供
 * `allow_always` 选项；CLI 双向协议的 `can_use_tool` 只认 allow/deny，
 * 没有 always 这一档。给 CLI 也摆一个 always 按钮，就是假功能。
 *
 * 所以选项目录由各适配器声明，UI 只渲染收到的那几档，不自己补齐。
 *
 * ## 拒绝文案为什么分两段
 *
 * 第一段必须说「这是用户的决定，不是工具故障」—— 否则模型会把一次
 * 用户拒绝当成工具报错，换个参数再试一遍，白白烧一轮。第二段给可执行
 * 的替代路径，让模型知道下一步该干什么，而不是原地卡住。
 */

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  /** 稳定 id：前端原样回传，适配器据此选中对应选项 */
  id: string;
  kind: PermissionOptionKind;
  /** 人话标签。ACP 用服务端 `name`，本地目录用中文 */
  label: string;
  /** 作用域 / 安全说明，UI 以 title 展示 */
  note?: string;
}

export type PermissionReasonCode =
  | 'user_rejected'
  | 'user_denied_always'
  | 'rule_blocked'
  | 'timeout'
  | 'cancelled';

export const PERMISSION_REASON_CODES: readonly PermissionReasonCode[] = [
  'user_rejected',
  'user_denied_always',
  'rule_blocked',
  'timeout',
  'cancelled',
];

/** 前端 → 服务端的答复。`message` 仅作为老客户端 / 自定义说明的兜底。 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  optionId?: string;
  reasonCode?: PermissionReasonCode;
  message?: string;
}

const DEFAULT_LABELS: Record<PermissionOptionKind, string> = {
  allow_once: '允许',
  allow_always: '始终允许',
  reject_once: '拒绝',
  reject_always: '始终拒绝',
};

/**
 * SDK 适配器的选项目录。
 *
 * 「始终」的作用域是**本会话 + 本次应用运行**：SDK 没有持久化审批决定的
 * API，我们只在适配器内存里记住工具名。应用重启后失效 —— 这个边界写在
 * `note` 里，界面上能看到，不靠用户猜。
 *
 * 高危检查在记住之前：即使点了「始终允许」，`rm -rf /` 仍会被门禁拒绝。
 */
export const SDK_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  {
    id: 'reject_always',
    kind: 'reject_always',
    label: '本会话始终拒绝',
    note: '本会话内不再询问这个工具；应用重启后失效',
  },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
  {
    id: 'allow_always',
    kind: 'allow_always',
    label: '本会话始终允许',
    note: '本会话内这个工具不再询问；高危操作仍会被门禁拦截',
  },
];

/**
 * CLI 双向模式（A106）的选项目录。
 *
 * 协议只有 `{behavior:"allow"|"deny"}` 两种答复，没有 always ——
 * 这里只摆两档，多一档都是骗人。
 */
export const CLI_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
];

export function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return value === 'allow_once' || value === 'allow_always'
    || value === 'reject_once' || value === 'reject_always';
}

export function isPermissionReasonCode(value: unknown): value is PermissionReasonCode {
  return typeof value === 'string'
    && (PERMISSION_REASON_CODES as readonly string[]).includes(value);
}

export function behaviorOfKind(kind: PermissionOptionKind): 'allow' | 'deny' {
  return kind.startsWith('allow') ? 'allow' : 'deny';
}

export function reasonCodeOfKind(kind: PermissionOptionKind): PermissionReasonCode | undefined {
  if (kind === 'reject_always') return 'user_denied_always';
  if (kind === 'reject_once') return 'user_rejected';
  return undefined;
}

function inferKind(rawKind: unknown, id: string, name: string): PermissionOptionKind | null {
  if (isPermissionOptionKind(rawKind)) return rawKind;

  const hay = `${String(rawKind ?? '')} ${id} ${name}`.toLowerCase();
  const always = /\balways\b|始终|总是|永久/.test(hay);
  const reject = /\breject\b|\bdeny\b|\bno\b|拒绝|不允许/.test(hay);
  const allow = /\ballow\b|\byes\b|\bapprove\b|允许|同意/.test(hay);

  // 两种语义同时出现（如 "don't allow"）时不猜：猜错方向比没有按钮更糟
  if (reject && !allow) return always ? 'reject_always' : 'reject_once';
  if (allow && !reject) return always ? 'allow_always' : 'allow_once';
  return null;
}

/**
 * 把 ACP 的 `session/request_permission.options[]` 归一化成我们的形状。
 *
 * 认不出的 kind 一律丢弃，不做「默认 allow」这种乐观兜底 ——
 * 上游给了一个我们不认识的选项，正确反应是「这一档不展示」。
 */
export function normalizePermissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.optionId === 'string'
      ? o.optionId.trim()
      : typeof o.id === 'string'
        ? o.id.trim()
        : '';
    if (!id || seen.has(id)) continue;

    const name = typeof o.name === 'string'
      ? o.name.trim()
      : typeof o.label === 'string'
        ? o.label.trim()
        : '';
    const kind = inferKind(o.kind, id, name);
    if (!kind) continue;

    seen.add(id);
    out.push({ id, kind, label: name || DEFAULT_LABELS[kind] });
  }
  return out;
}

/**
 * 拒绝文案。第一段定性（不是工具故障），第二段给替代路径。
 */
export function buildDenialMessage(code: PermissionReasonCode, detail?: string): string {
  let text: string;
  switch (code) {
    case 'user_rejected':
      text = '用户拒绝了这次工具调用。这是用户的决定，不是工具故障，请不要原样重试。'
        + '请先说明你的意图，或改用不需要该工具的做法。';
      break;
    case 'user_denied_always':
      text = '用户已在本会话内禁用这个工具。这是用户的决定，不是工具故障，请不要原样重试。'
        + '请改用其他方式完成任务。';
      break;
    case 'rule_blocked':
      text = '该操作被权限门禁拦截，属于策略限制，不是工具故障，请不要原样重试。'
        + '请换一种不需要该操作的方案。';
      break;
    case 'timeout':
      text = '用户没有在时限内答复，已按拒绝处理。这不是工具故障，请不要自动重试。'
        + '请先向用户确认意图。';
      break;
    case 'cancelled':
      text = '本轮已结束，权限请求未获得答复，已按拒绝处理。这不是工具故障，请不要自动重试。';
      break;
  }
  const extra = detail?.trim();
  return extra ? `${text}（依据：${extra}）` : text;
}

export type ParsedPermissionBody =
  | { ok: true; decision: PermissionDecision }
  | { ok: false; error: string };

/**
 * `/api/permission-response` 的边界校验。
 *
 * 非法值一律报错，不静默纠正 —— 把 `behavior:"maybe"` 当成 deny，
 * 用户看到的是「我点了允许，它却拒了」，而日志里一切正常。
 */
export function parsePermissionBody(raw: unknown): ParsedPermissionBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '请求体必须是对象' };
  }
  const o = raw as Record<string, unknown>;
  if (o.behavior !== 'allow' && o.behavior !== 'deny') {
    return { ok: false, error: `行为不合法：${JSON.stringify(o.behavior)}（可选：allow | deny）` };
  }

  let optionId: string | undefined;
  if (o.optionId !== undefined) {
    if (typeof o.optionId !== 'string' || !o.optionId.trim()) {
      return { ok: false, error: 'optionId 必须是非空字符串' };
    }
    optionId = o.optionId.trim();
  }

  let reasonCode: PermissionReasonCode | undefined;
  if (o.reasonCode !== undefined) {
    if (!isPermissionReasonCode(o.reasonCode)) {
      return { ok: false, error: `拒绝原因码不合法：${JSON.stringify(o.reasonCode)}` };
    }
    reasonCode = o.reasonCode;
  }
  if (o.behavior === 'allow' && reasonCode) {
    return { ok: false, error: '允许答复不能携带拒绝原因码' };
  }
  if (o.behavior === 'deny' && !reasonCode) {
    // 老客户端只发 behavior：默认按「用户拒绝」，这是唯一有依据的推断
    reasonCode = 'user_rejected';
  }

  let message: string | undefined;
  if (o.message !== undefined) {
    if (typeof o.message !== 'string') return { ok: false, error: 'message 必须是字符串' };
    message = o.message.trim() || undefined;
  }

  return {
    ok: true,
    decision: {
      behavior: o.behavior,
      ...(optionId ? { optionId } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(message ? { message } : {}),
    },
  };
}

/* ===== A132：审批浮层的四个纯函数 =====
 *
 * 放这里而不是放组件里，是因为这四条全是「用户看到什么 ≠ 实际发生什么」的
 * 判定点，必须在脱机态就能断言（DOM 行为在 Node 里造不出来，但这四条能）。
 */

/**
 * `/api/permission-response` 的响应分类。
 *
 * 旧实现 POST 完不看响应就清空待办槽位：服务端返 404（不存在或已超时）时，
 * 用户以为批过了、实际被拒，而界面上一切正常。三种结果必须分开走。
 *
 * @param status HTTP 状态码；`0` = 请求根本没发出去（断网 / 进程挂了）
 */
export type PermissionAck =
  | { kind: 'settled' }
  | { kind: 'stale' }
  | { kind: 'rejected'; error: string };

export function classifyPermissionAck(status: number, body: unknown): PermissionAck {
  if (status === 200) return { kind: 'settled' };
  if (status === 404) return { kind: 'stale' };
  if (status === 0) return { kind: 'rejected', error: '网络中断，答复未送达' };
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err) return { kind: 'rejected', error: err };
  }
  return { kind: 'rejected', error: `HTTP ${status}` };
}

/**
 * 快捷键选档。
 *
 * 不写死 `allow_once` / `reject_once` 这两个 id —— ACP 的选项 id 由上游给
 * （`normalizePermissionOptions` 只认 kind）。一个候选都没有时返回 undefined，
 * 调用方**什么都不发**：把「没有允许档」兜底成 deny 就是替用户做决定。
 */
export function pickOptionByKind(
  options: readonly PermissionOption[],
  prefix: 'allow' | 'reject'
): PermissionOption | undefined {
  return options.find(o => o.kind.startsWith(prefix));
}

/** 剩余毫秒；缺省（该适配器没有超时兜底）返回 null，UI 据此画「无超时」。 */
export function remainingMs(expiresAt: number | undefined, now: number): number | null {
  if (typeof expiresAt !== 'number') return null;
  return Math.max(0, expiresAt - now);
}

/** `m:ss`，不进位到小时（兜底超时最长就 5 分钟）。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 队列排序：当前会话的排前，组内按到达时间升序。
 *
 * 先来先批而不是后来先批 —— 长任务一直压着短任务，用户会觉得「刚来的没显示」。
 */
export function sortPendingPermissions<T extends { sessionId: string; receivedAt: number }>(
  items: readonly T[],
  currentSessionId: string | null
): T[] {
  return [...items].sort((a, b) => {
    const am = a.sessionId === currentSessionId ? 0 : 1;
    const bm = b.sessionId === currentSessionId ? 0 : 1;
    return am !== bm ? am - bm : a.receivedAt - b.receivedAt;
  });
}
