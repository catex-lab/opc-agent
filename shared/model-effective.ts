/**
 * P1：收到 `run_start.modelEffective` 后**要不要**回显到输入框的判定。
 *
 * ## 为什么要单独一层
 *
 * 「把生效模型写回输入框」听起来一行就够，但它在 A142 的并发模型下是
 * 一个**归属问题**：会话 A 还在流、用户已经切到会话 B，此时 A 迟到的
 * `run_start` 一到就把 B 的输入框改成 A 的模型 —— 修好了「显示不真实」，
 * 换来「显示的是别人的」。这一层把「这一轮属于谁」写成可单测的纯函数，
 * 不让判定散在 React 闭包里。
 *
 * ## 五条出口
 *
 * - `not-declared`：老服务端 / 历史夹具没有 `modelEffective` ⇒ 什么都不做。
 *   它同时是向后兼容的反向探针：`model` 元信息不算数，不许拿它反推。
 * - `already-done`：断线重连会重放 `run_start`，一局只回显一次。
 * - `other-session`：这一轮不属于用户此刻正在看的会话。
 * - `unchanged`：生效值与请求值相同，回显只是多余渲染。
 * - `resolved`：真的发生了替换（或解析成「由 Agent 决定」），应当回显/提示。
 *
 * ⚠️ 纯函数，不许 import server/ 或 src/。
 */

export type EchoReason =
  | 'not-declared'
  | 'already-done'
  | 'other-session'
  | 'unchanged'
  | 'resolved';

export interface EchoDecision {
  /** 是否要通知上层回显 */
  echo: boolean;
  /** 真正生效的模型名；空串 = 不传 --model，由 Agent 自己决定 */
  effective: string;
  /** 用户发起这一轮时选的模型名 */
  requested: string;
  reason: EchoReason;
}

export interface EchoInput {
  /** `run_start.modelEffective`；undefined = 老服务端/夹具没盖章 */
  declared: string | undefined;
  /** 本轮是否已经处理过一次（重连重放） */
  alreadyDone: boolean;
  /** 用户此刻正在看的会话（null = 新对话页，还没落到具体会话） */
  watching: string | null;
  /** 发起这一轮时的会话 id（可能是前端临时 id，也可能是 null） */
  turnSessionId: string | null;
  /** `run_start` 带来的后端真会话 id */
  realSessionId: string;
  /** 发起这一轮时输入框里的模型名 */
  requested: string;
}

/**
 * 「这一轮属于用户此刻正在看的会话吗」。
 *
 * `watching === null` 算归属：新对话页发第一条消息时，界面上并没有别的
 * 会话可看，而这一刻恰恰最容易发生静默替换（新建会话选的模型被白名单换掉）。
 * 其余情况必须 id 相等 —— 注意要同时比 `turnSessionId` 与 `realSessionId`，
 * 因为 `applyInit` 会在中途把临时 id 换成后端真 id，两者都可能是对的那一个。
 */
export function turnBelongsToWatching(input: Pick<EchoInput, 'watching' | 'turnSessionId' | 'realSessionId'>): boolean {
  const { watching, turnSessionId, realSessionId } = input;
  if (watching == null) return true;
  if (watching === realSessionId) return true;
  return turnSessionId != null && watching === turnSessionId;
}

export function decideModelEcho(input: EchoInput): EchoDecision {
  const base = {
    effective: input.declared ?? '',
    requested: input.requested || '',
  };
  // 老服务端 / 夹具：连字段都没有，绝不动输入框
  if (input.declared === undefined) return { ...base, echo: false, reason: 'not-declared' };
  // 重连重放：一局只回显一次
  if (input.alreadyDone) return { ...base, echo: false, reason: 'already-done' };
  // A142：别的会话的 run 不许改「我」的输入框
  if (!turnBelongsToWatching(input)) return { ...base, echo: false, reason: 'other-session' };
  // 没发生替换：不动，也不弹提示
  if (input.declared === base.requested) return { ...base, echo: false, reason: 'unchanged' };
  return { ...base, echo: true, reason: 'resolved' };
}
