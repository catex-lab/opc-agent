/**
 * H-04：护栏时序常量的唯一登记处（SOLUTION-PLAN 1.1c④ / DESIGN-CONSTRAINTS C3）。
 *
 * ## 为什么这些常量要放 shared
 *
 * 护栏四件套跨端耦合：server 的 SSE 心跳必须**短于**前端的静默看门狗阈值，
 * 否则前端会在「对方认真思考」时误判断线；首字护栏（120s）是 canary SDK
 * 预算对齐的锚（canary.ts budgetFor('sdk') 刻意取同一值防误报）。
 * 分散在三个层（server/sse-heartbeat、src/lib/sse-watchdog、server/agents/firstTokenGuard）
 * 时，这层关系只活在注释里；集中到这里，耦合变成编译期可见。
 *
 * ## 纪律（H-04 任务定义）
 *
 * - **只搬家、不改值**：这里的每个值与搬家前逐字一致；调参走 env 覆盖口，
 *   不许就地改默认值。
 * - **闸门兼容**：原文件保留 re-export（verify:sse-heartbeat / verify:sse-watchdog
 *   等闸门从原路径 import，不感知搬家）。
 * - 其余 ~60 条超时/TTL 常量（探测族、适配器族、调度族）暂留原处，
 *   搬家清单见 E:\aiapp\opc\.local-notes\H04-timeout-inventory.md，分批搬。
 */

/** SSE 心跳间隔：server 每 20s 写注释帧唤醒前端 reader.read()。必须 < SILENCE_TIMEOUT_MS。 */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** 前端静默看门狗：60s 无任何帧（含心跳）→ abort 走 seq 重连。必须 > DEFAULT_HEARTBEAT_MS。 */
export const SILENCE_TIMEOUT_MS = 60_000;

/** 静默看门狗的周期检查间隔。 */
export const DEFAULT_CHECK_INTERVAL_MS = 5_000;

/** 首字护栏默认值：SDK/全通道 120s（env OPC_SDK_FIRST_TOKEN_TIMEOUT_MS 可覆盖，下限 15s）。 */
export const FIRST_TOKEN_TIMEOUT_DEFAULT_MS = 120_000;

/** 首字护栏下限：env 调参不许低于此值（防止把护栏调没）。 */
export const FIRST_TOKEN_TIMEOUT_FLOOR_MS = 15_000;

/** E5 断线宽限窗：客户端断开后留 20s 供 /api/runs/:id/stream?after=N 接回，超窗才 abort。 */
export const REATTACH_GRACE_MS = 20_000;
