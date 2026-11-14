/**
 * 诊断分类学契约（接入架构收敛方案 P0，2026-11-14）。
 *
 * ## 它解决什么问题
 *
 * 「未登录 / 探测失败 / 登录态失效 / 上次失败」过去各自为政：探测启发式
 * （authFiles / authEnvs）、A177 的 probeState 四分类、运行期 recovery 的
 * 四分类、A111 的 raw 旁路——四套口径在四个地方各说各话，名册上的状态
 * 与真实可用性是两套真相。本契约把**所有通道的失败归一到一套分类**，
 * 每类绑定一个用户动作。后续 canary（P1）只认这一套。
 *
 * ## 判定原则（写死）
 *
 * - **一次失败只归一类**，归类由通道层判定（它最清楚），UI 不猜；
 * - 归类顺序沿用 recovery.ts 的既定事实：**quota 先于 auth**——限流时部分
 *   CLI 也会打印 401/unauthorized，先判登录会把用户引去重登一个额度用尽
 *   的账号（那个顺序是踩过坑的，本文件镜像它而不是重新发明）；
 * - 本文件是**纯模块**：不 import 任何 server/ 侧代码（与 permissionMeta
 *   同一条零依赖纪律），前后端共享同一份，漂移由闸门钉住。
 */

/** 诊断分类。全系统（探测 / 运行期 / 未来的 canary）只认这一套。 */
export type DiagnosticClass =
  | 'ok'
  | 'auth_missing'
  | 'auth_expired'
  | 'quota'
  | 'network'
  | 'binary_broken'
  | 'not_installed'
  | 'degraded'
  | 'unknown';

export const DIAGNOSTIC_CLASSES = [
  'ok',
  'auth_missing',
  'auth_expired',
  'quota',
  'network',
  'binary_broken',
  'not_installed',
  'degraded',
  'unknown',
] as const;

/** 每类绑定的用户动作键。UI 据此渲染「下一步」，文案在 i18n（diag.action.*）。 */
export type DiagnosticAction =
  | 'open_login' // 打开/重新登录（登录代管，P2 落地；先跳转详情页登录区）
  | 'open_install' // 查看安装/修复指引（A71 InstallCard）
  | 'switch_model' // 换模型或充值
  | 'check_network' // 检查网络/代理
  | 'view_details' // 查看详情（AgentDetailPanel）
  | null;

export interface DiagnosticMeta {
  /** i18n 文案键：`diag.<class>.label` */
  labelKey: string;
  /** 该类的下一步动作。null = 无需动作（在线） */
  action: DiagnosticAction;
}

export const DIAGNOSTIC_META: Record<DiagnosticClass, DiagnosticMeta> = {
  ok: { labelKey: 'diag.ok.label', action: null },
  auth_missing: { labelKey: 'diag.auth_missing.label', action: 'open_login' },
  auth_expired: { labelKey: 'diag.auth_expired.label', action: 'open_login' },
  quota: { labelKey: 'diag.quota.label', action: 'switch_model' },
  network: { labelKey: 'diag.network.label', action: 'check_network' },
  binary_broken: { labelKey: 'diag.binary_broken.label', action: 'open_install' },
  not_installed: { labelKey: 'diag.not_installed.label', action: 'open_install' },
  degraded: { labelKey: 'diag.degraded.label', action: 'view_details' },
  unknown: { labelKey: 'diag.unknown.label', action: 'view_details' },
};

export function isDiagnosticClass(v: unknown): v is DiagnosticClass {
  return typeof v === 'string' && (DIAGNOSTIC_CLASSES as readonly string[]).includes(v);
}

/** 一条诊断事实。探测、运行期错误、（未来的）canary 都产出它。 */
export interface Diagnostic {
  class: DiagnosticClass;
  /** 产生这条诊断的时刻（ISO）。名册据此显示「最近一次检测」 */
  at: string;
  /** 人类可读的原始细节（错误原文 / probeState 说明）。截断由产生方负责 */
  detail?: string;
  /**
   * 这条诊断的来源。canary（P1）落地前只会有 probe / runtime。
   * 为什么记录来源：同一个 Agent 的「探测说 OK」与「运行期报 401」可能并存，
   * 消费方（名册）按优先级取舍时必须知道每条事实是谁说的。
   */
  source: 'probe' | 'runtime' | 'canary';
}

// ═══════════════ 探测侧映射 ═══════════════

/**
 * 探测侧可用性 → 诊断分类。**纯函数**。
 *
 * 这不是新逻辑，是现有七档 availability 的契约化搬运：
 *   ready → ok；needs-auth → auth_missing；needs-setup / unsupported →
 * binary_broken；unreachable → network；not-installed → not_installed；
 * unknown → unknown（还没探测，诚实未知）。
 */
export type ProbeAvailability =
  | 'ready'
  | 'needs-auth'
  | 'needs-setup'
  | 'unreachable'
  | 'not-installed'
  | 'unsupported'
  | 'unknown';

export function availabilityToDiagnostic(a: ProbeAvailability): DiagnosticClass {
  switch (a) {
    case 'ready':
      return 'ok';
    case 'needs-auth':
      return 'auth_missing';
    case 'needs-setup':
    case 'unsupported':
      return 'binary_broken';
    case 'unreachable':
      return 'network';
    case 'not-installed':
      return 'not_installed';
    case 'unknown':
    default:
      return 'unknown';
  }
}

// ═══════════════ 运行期错误文本归类 ═══════════════

/**
 * 运行期错误文本 → 诊断分类。**纯函数**。
 *
 * 正则口径**镜像** `server/agents/recovery.ts` 的 classifyFailure（quota 先于
 * auth 的顺序是踩过坑的既定事实）——为什么不直接 import：本文件是前后端共享
 * 的零依赖模块，recovery.ts 在 server 侧且带凭据建议等职责；镜像漂移由
 * verify:diag-contract 的「同文本双口径必须同分类」断言钉住（两侧闸门都会
 * 跑同一组样本）。
 *
 * 与 recovery 的差异只有两处，都是**契约需要**而非口径变更：
 *   - ENOENT 类在 recovery 里叫 'not-installed'，这里如实映射为 not_installed；
 *   - unknown 在这里仍然是 unknown（总覆盖率：任何文本都有归类，UI 永远
 *     有得显示），「解析降级」是另一条独立的 DEGRADED 事实，不走文本归类。
 */
const QUOTA_RE =
  /(429|too many requests|rate.?limit|usage limit|quota|insufficient_quota|free usage limit|额度|限流|余额不足|配额)/i;
const AUTH_RE =
  /(401|403|unauthorized|unauthenticated|not logged in|please log ?in|login required|authentication required|invalid api key|missing api key|no api key|token (?:expired|invalid)|credential|未登录|凭据(?:无效|失效)|认证失败|需要先登录)/i;
const MISSING_RE =
  /(ENOENT|not found|未找到|未安装|CLI not found|找不到指定的文件|不在 PATH|command not found|is not recognized)/i;
const NETWORK_RE =
  /(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504|network|proxy|代理|网络不可达|连接超时|tunnel)/i;

export function classifyErrorMessage(message: string): DiagnosticClass {
  const text = message ?? '';
  if (QUOTA_RE.test(text)) return 'quota';
  if (AUTH_RE.test(text)) return 'auth_expired';
  if (MISSING_RE.test(text)) return 'not_installed';
  if (NETWORK_RE.test(text)) return 'network';
  return 'unknown';
}

/**
 * 运行期 auth 错误的 missing/expired 细分。**纯函数**。
 *
 * 文本本身分不出来（401 既可能是没配过也可能是过期了），但**上下文**分得
 * 出来：探测说 ready 却收到 401 = 登录态失效；本来就 needs-auth = 压根没登。
 * `wasReady` 由调用方从上一份状态取，这里不做任何猜测。
 */
export function authDiagnosticFor(wasReady: boolean): 'auth_missing' | 'auth_expired' {
  return wasReady ? 'auth_expired' : 'auth_missing';
}
