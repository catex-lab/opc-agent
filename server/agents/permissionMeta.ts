/**
 * 待授权请求的服务端元数据（requestId → agentId + toolName）。
 *
 * ## 为什么需要它
 *
 * 「该 Agent 永久」授权在 `POST /api/permission-response` 里落库，落库键是
 * agentId + toolName。前端只回传 requestId —— agentId 绝不能信前端传的
 * （它连哪个 Agent 发起的都不知道，`resolvePermissionAnywhere` 就是为此才
 * 遍历所有 Provider）；toolName 同理。可信来源只有事件流本身：
 *
 *   适配器 yield permission_request ──▶ RunProjector.push 在这里记一条
 *   POST /api/permission-response ──▶ takePendingPermissionMeta 取走落库
 *
 * 单聊、群聊、工作流三条路径全部经过 RunProjector，所以这里是最唯一的
 * 收口点，不需要在每个泵里各记一遍。
 *
 * ## 为什么是独立小模块而不是塞进 permission-grants.ts
 *
 * 本模块必须保持**零依赖**：projector.ts 是「纯逻辑、拿夹具就能单测」的层
 * （多个脱机闸门直接 import 它），一旦这里 import db.ts，那些闸门每次运行
 * 都会把真实 chat.db 打开 —— 正是 `scripts/lib/temp-data-dir.ts` 注释里写过
 * 的那类事故。落库相关的表与查询在 `server/permission-grants.ts`，两者通过
 * index.ts 的路由串起来。
 *
 * 生命周期：permission_request 事件发出时记入，答复被认领（或超时/收尾）
 * 时由路由层取走。为防「永远没人认领」的泄漏，表有硬上限，超限丢最旧的 ——
 * 一条待授权最多活 5 分钟（SDK/CLI 的超时兜底），512 条远超任何真实并发。
 */

export interface PendingPermissionMeta {
  requestId: string;
  agentId: string;
  toolName: string;
  sessionId: string;
  /** 记入时刻（epoch ms），排障用 */
  at: number;
  /**
   * A228：工具输入的一行摘要（投影器在登记时截断）。
   *
   * 为什么在这里而不在通知模块里再取一次：input 只在事件上存在，事件流过
   * 投影器就没了。谁消费 meta 谁都可能想看一眼「它要对什么授权」——
   * 持久授权的落库键不需要它，远程审批的卡片需要。
   * 已由投影器做 JSON 压缩 + 截断 + 敏感扫描（复用 extensions/safety 的口径），
   * 这里只是搬运。
   */
  inputSummary?: string;
}

const MAX_ENTRIES = 512;
const pending = new Map<string, PendingPermissionMeta>();

/**
 * A228：待授权登记的观察钩子（可选）。index.ts 启动时挂上远程审批的外发。
 *
 * 为什么是回调注入而不是 permissionMeta 直接 import 通知模块：本模块必须
 * 保持**零依赖**（见文件头），projector 的脱机闸门直接 import 它——
 * 一旦这里沾上网络/磁盘，那些闸门就要开真端口。回调由宿主注册，
 * 没注册 = 纯记录，行为与 A228 之前完全一致。
 */
let observer: ((meta: PendingPermissionMeta) => void) | null = null;

export function setPendingPermissionObserver(fn: ((meta: PendingPermissionMeta) => void) | null): void {
  observer = fn;
}

/**
 * 记入一条待授权元数据。同一 requestId 重复到达（理论不该发生）以最新为准。
 */
export function recordPendingPermissionMeta(meta: PendingPermissionMeta): void {
  if (!meta.requestId || !meta.agentId || !meta.toolName) return;
  // Map 保持插入序：超限时淘汰最旧的一条（最先插入且仍存在的那个键）
  while (pending.size >= MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  pending.set(meta.requestId, { ...meta });
  try {
    observer?.(pending.get(meta.requestId)!);
  } catch {
    /* 观察者（通知）失败不影响权限链本身 */
  }
}

/**
 * 取走（读 + 删）。落库或清理都走这一个口，保证一条元数据至多被消费一次。
 */
export function takePendingPermissionMeta(requestId: string): PendingPermissionMeta | undefined {
  const key = requestId?.trim();
  if (!key) return undefined;
  const meta = pending.get(key);
  if (meta) pending.delete(key);
  return meta;
}

/** 只读不删（闸门 / 诊断用） */
export function peekPendingPermissionMeta(requestId: string): PendingPermissionMeta | undefined {
  const key = requestId?.trim();
  return key ? pending.get(key) : undefined;
}

/** 测试钩子（照 registry / permissionStore 的先例） */
export function __resetPermissionMetaForTests(): void {
  pending.clear();
}
