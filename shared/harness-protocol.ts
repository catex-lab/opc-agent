/**
 * Harness 进程壳协议常量（M01 / 绞杀者第 1 期，设计 §10.1 方案 A、§7.5）。
 *
 * 这里只放**纯常量与纯类型**：它被 server/、electron/、harness/、src/ 四方
 * 共同 import，不能带任何 Node 依赖或副作用（src 里经 vite 打进渲染端，
 * harness 与 main 经 esbuild 打进各自 CJS 产物）。
 *
 * 形状约定（见各常量注释）：
 *   main ──spawn(env)──▶ harness.cjs ──stdout 握手行──▶ main
 *   渲染端 ──x-opc-token──▶ harness（server 内中间件校验）
 */

/** feature flag：`OPC_HARNESS=0` 关掉新进程壳，回到主进程内联启动的老路 */
export const OPC_HARNESS_ENV = 'OPC_HARNESS';

/** harness 子进程读这里拿本机 token；经 env 传递，**不进 argv**（token 不进命令行） */
export const OPC_LOCAL_TOKEN_ENV = 'OPC_LOCAL_TOKEN';

/**
 * spawn 方声明「stdin 由我握着（pipe 且从不写入）」→ harness 挂 stdin 关闭
 * 监听作父死亡兜底。不声明就不挂（stdio 'ignore' 的 /dev/null 'end' 会立即
 * 误触发；终端 TTY 由 SIGINT 兜底）。
 */
export const OPC_STDIN_PIPE_ENV = 'OPC_HARNESS_STDIN_PIPE';

/** 渲染端 → harness 的鉴权头。token 只活在内存与用户数据目录的 0600 文件里 */
export const OPC_TOKEN_HEADER = 'x-opc-token';

/** 鉴权豁免路径：健康检查要被 main 看门狗与闸门在**无 token** 时探活 */
export const OPC_HEALTH_PATH = '/api/health';

/** token 文件名（落在 OPC_DATA_DIR 下）。main 每次拉起 harness 都重写（换新 token），优雅退出时删除 */
export const OPC_TOKEN_FILE = 'harness-token.json';

/**
 * stdout 握手行前缀。
 *
 * server 启动横幅（╔═...）与各模块日志都往 stdout 打，裸 JSON 行会被日志
 * 噪音淹没、也可能被日志内容撞上。带一个不可能撞上的前缀，main 只认
 * 以它开头的行，其余原样透传到 main 的 console（排障可见）。
 */
export const HANDSHAKE_PREFIX = '@@OPC-HARNESS@@ ';

/** 握手行 payload：ready = 已监听，port 为真实端口（PORT=0 时由系统分配） */
export interface HarnessHandshake {
  type: 'ready';
  port: number;
  pid: number;
}

/** main 侧等握手的最长时间。超过即视为启动失败，交给看门狗重启 */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** 渲染端事件：harness 重启相关的用户可见状态（preload opc.onHarnessEvent） */
export type HarnessUiEvent =
  | { type: 'restarting' }
  | { type: 'recovered'; port: number }
  | { type: 'gave-up' };
