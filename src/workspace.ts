/**
 * A63：工作区（Workspace）的前端共享件。
 *
 * ## 为什么单独一个文件
 *
 * 工作目录在本应用里有三个入口 —— 新对话页的输入框、会话栏头的工作区徽标、
 * 徽标面板里的「切换目录」—— 它们共用同一组原语（选目录对话框、在资源
 * 管理器中打开、目录名展示）。这三个入口分散在三个组件里，若各写一份
 * `window.opc?.pickDirectory()`，桥的签名就会有三份，改一次 preload 要
 * 同步改三处，漏一处就是「某个入口在打包态点下去没反应」。
 *
 * ## 浏览器开发态怎么办
 *
 * 本项目坚持「前端不依赖任何 Electron API」：`nodeIntegration: false`、
 * `contextIsolation: true`。浏览器里 `window.opc` 是 undefined，于是：
 *   · `pickDirectory()` 返回 null —— 调用方据此退化成「保留手动输入框」，
 *     而不是摆一个点了没反应的按钮（假控件）；
 *   · `revealInFolder()` 静默跳过 —— 浏览器里本来就没有资源管理器。
 * 两条分支都不抛错、不弹提示：开发态缺的是原生能力，不是用户操作失误。
 *
 * ## 目录名为什么不用 path.basename
 *
 * 渲染进程没有 Node 的 `path`（也没有 `require`），手写一个按 `/` 与 `\`
 * 分割取最后一段的小函数就够了 —— 工作目录只会是这两种分隔符的路径
 * （Windows 本地 / POSIX 本地 / WSL 挂载），不需要完整的路径语法。
 */

/** preload 暴露的桥（A63 起多了两颗）。浏览器开发态整个是 undefined */
interface OpcBridge {
  setTheme?(mode: 'system' | 'light' | 'dark'): void;
  getFilePath?(file: File): string;
  pickDirectory?(): Promise<string | null>;
  revealInFolder?(path: string): void;
  createWorkspace?(): Promise<{ path?: string; error?: string } | null>;
  windowControl?: unknown;
}

function bridge(): OpcBridge | undefined {
  return (window as unknown as { opc?: OpcBridge }).opc;
}

/**
 * 打开系统目录选择对话框。
 *
 * @returns 选中的目录绝对路径；用户取消 / 当前环境没有原生对话框（浏览器
 *          开发态）时返回 null。**null 不是错误**，调用方保持原值即可。
 */
export async function pickDirectory(): Promise<string | null> {
  const fn = bridge()?.pickDirectory;
  if (!fn) return null;
  try {
    return (await fn()) ?? null;
  } catch {
    // 对话框本身出错（极少见：窗口被销毁瞬间点下去之类）。
    // 与「取消」同等对待：不动用户已经选好的值。
    return null;
  }
}

/**
 * 在系统资源管理器（Windows 资源管理器 / macOS Finder）里露出该路径。
 *
 * 路径不存在、或当前环境没有原生能力（浏览器开发态）时静默跳过 ——
 * 调用方在 UI 上已经校验过路径，这里再弹一次错误只会变成噪音。
 */
export function revealInFolder(dir: string): void {
  if (!dir) return;
  try {
    bridge()?.revealInFolder?.(dir);
  } catch {
    // 同上：静默
  }
}

/**
 * 当前环境有没有原生的「选目录」能力。
 *
 * 用来区分两种 null：**不支持**（浏览器开发态，`window.opc` 不在）与
 * **用户取消**（对话框开了但没选）。前者值得在界面上说明一句，后者应当
 * 安静地保持原值 —— 混为一谈就会要么在用户每次取消时弹提示，要么在开发态
 * 摆一个永远没反应的按钮。
 */
export function hasNativeDialogs(): boolean {
  return typeof bridge()?.pickDirectory === 'function';
}

/**
 * A86：新建工作区 —— 选父目录、在里面建一个空文件夹、返回它的绝对路径。
 *
 * 为什么不让后端建：`server/fs.ts` 的定位是**只读**（见那里的三条边界）。
 * 为「新建工作区」给它开一个 mkdir 接口，等于让任意会话可以在任意位置
 * 造目录；而这件事本来只需要一次**用户在原生对话框里的选择**。所以建目录
 * 落在主进程，且父目录必须由用户亲手选。
 *
 * @returns `{ path }` 成功；`{ error }` 失败原因；`null` 用户取消 / 环境不支持
 */
export async function createWorkspace(): Promise<{ path?: string; error?: string } | null> {
  const fn = bridge()?.createWorkspace;
  if (!fn) return null;
  try {
    return (await fn()) ?? null;
  } catch (e) {
    return { error: e instanceof Error ? e.message : '新建工作区失败' };
  }
}

/**
 * 取目录的展示名（路径的最后一段）。
 *
 * 徽标上放不下完整路径，放最后一段（`opc-agent`）刚好；完整路径在徽标的
 * `title` 和弹出面板里各出现一次。两端分隔符都处理：Windows 的 `\` 与
 * POSIX 的 `/`（WSL / Git Bash 里粘过来的路径带 `/`）。
 */
export function dirName(dir: string): string {
  if (!dir) return '';
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}
