/**
 * 渲染进程与主进程之间的**最小** IPC 桥。
 *
 * ## 为什么需要它
 *
 * 应用的深浅色由前端 CSS 变量驱动（`--tc-surface-chrome` 等），但
 * **窗口本身的原生属性不由 CSS 画**：
 *   · 窗口底色（`setBackgroundColor`）与原生滚动条取自 `nativeTheme.themeSource`；
 *   · 最小化 / 最大化 / 关闭是窗口操作，页面没有对应能力。
 *
 * 于是会出现这种割裂：用户在设置里固定「深色」，而 Windows 是浅色
 *   → 原生滚动条、原生对话框、窗口底色仍是浅色，压在一整块深色界面上。
 *
 * ## 为什么是「最小」
 *
 * 本项目刻意保持「前端不依赖任何 Electron API」：`nodeIntegration: false`、
 * `contextIsolation: true`、`sandbox: true`。同一份代码在浏览器开发态和
 * 打包态跑的是同一个渲染进程，一旦这里多暴露一个 API，前端就多一条
 * 「只在 Electron 里才有的代码路径」。
 *
 * 所以这里只暴露几件东西，且前端一律用**可选调用**（`window.opc?.`）——
 * 浏览器开发时 `window.opc` 是 undefined，调用被跳过，行为不变：
 *   · `setTheme`      —— 主题偏好同步给原生层；
 *   · `windowControl` —— 自绘标题条上的三个窗口按钮（见 main.ts 的 A24 说明）；
 *   · `getFilePath`   —— 把 File 还原成磁盘绝对路径（A35 附件按钮，纯函数、
 *                        不经过 IPC，Electron 32 之后 `File.path` 已移除，
 *                        官方替代就是 `webUtils.getPathForFile`）；
 *   · `pickDirectory` / `revealInFolder` —— A63 工作区：选目录对话框与
 *                        「在资源管理器中打开」。这两件**没有 Web 等价物**，
 *                        浏览器开发态下返回 null / 空操作，前端据此走
 *                        手动输入路径的兜底（见 workspace.ts）。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('opc', {
  /**
   * 把 `<input type="file">` / 拖拽拿到的 `File` 还原成磁盘绝对路径（A35）。
   *
   * Electron 32 起 `File.path` 已被移除，官方替代就是 `webUtils.getPathForFile`。
   * 输入框的附件按钮需要这个路径 —— 它不是「上传」，而是把本机文件的位置
   * 交给 Agent 自己去读（这正是本地 Agent 与云端聊天机器人的区别）。
   *
   * 浏览器开发态没有这层桥，前端会退化成只显示文件名（见 ChatInput 的
   * getFilePath 兜底），不影响渲染与交互。
   *
   * @param {File} file
   * @returns {string} 绝对路径；拿不到时返回空串
   */
  getFilePath(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  /**
   * 把主题偏好同步给主进程，让它去调 `nativeTheme.themeSource`
   * 和 `mainWindow.setBackgroundColor()`。
   *
   * @param {'system'|'light'|'dark'} mode
   *   'system' → 交给操作系统决定（`nativeTheme.themeSource = 'system'`）
   */
  setTheme(mode) {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
    // fire-and-forget：主题同步失败不该阻塞 UI，也不该弹错误。
    ipcRenderer.send('opc:set-theme', mode);
  },

  /**
   * A63：打开系统目录选择对话框，返回用户选中的目录绝对路径。
   *
   * 用户取消时返回 null（不是抛错、不是空串）——「取消」是一次正常的
   * 用户决定，调用方据此保持原值不动。
   *
   * 浏览器开发态没有主进程可问，`window.opc` 整个是 undefined，
   * 这颗函数根本不存在；前端用可选调用并退化成手动输入路径。
   *
   * @returns {Promise<string|null>} 选中的目录；取消 / 失败返回 null
   */
  pickDirectory() {
    return ipcRenderer.invoke('opc:pick-directory');
  },

  /**
   * A63：在系统资源管理器（macOS Finder / Windows 资源管理器）里露出
   * 指定路径所在的位置并选中它。
   *
   * 路径不存在时 Electron 自己会拒绝（showItemInFolder 返回 false），
   * 这里不额外判存：前一个动作（切换目录）已经校验过，重复 stat 只是多一次
   * 系统调用，而「刚选完的目录瞬间被删」这种竞态不值得为它写分支。
   *
   * @param {string} path 目录或文件的绝对路径
   */
  revealInFolder(path) {
    if (typeof path !== 'string' || !path) return;
    ipcRenderer.invoke('opc:reveal-in-folder', path);
  },

  /**
   * A77：工作区文件面板 —— 用系统默认程序打开一个文件。
   *
   * 与 revealInFolder 的区别：那个是「在资源管理器里露出位置」，
   * 这个是「直接把文件打开」。文件面板点一下要的是后者。
   *
   * @param {string} path 文件绝对路径（由服务端从 session.cwd 算出）
   * @returns {Promise<string>} 空串 = 成功；否则是失败原因，前端显示给人看
   */
  openPath(path) {
    if (typeof path !== 'string' || !path) return Promise.resolve('路径为空');
    return ipcRenderer.invoke('opc:open-path', path);
  },

  /**
   * P2：浏览器预览视图。
   *
   * 这一组都是「请求」而不是「操作」—— 视图由主进程创建并挂在 contentView 上，
   * 里面跑的是任意远程内容，因此它**没有** preload，也拿不到这里任何函数。
   *
   * `browserRect` 传的是 CSS 像素、相对窗口内容区（getBoundingClientRect 的
   * 坐标系），主进程原样当成 DIP 用 —— 二者在 zoomFactor=1 时一致。
   */
  browserRect(rect) {
    ipcRenderer.send('opc:browser-rect', rect);
  },

  browserVisible(visible) {
    ipcRenderer.send('opc:browser-visible', visible === true);
  },

  /** @returns {Promise<boolean>} false = 协议不在白名单（只放行 http/https） */
  browserLoad(url) {
    if (typeof url !== 'string') return Promise.resolve(false);
    return ipcRenderer.invoke('opc:browser-load', url);
  },

  browserBack() {
    return ipcRenderer.invoke('opc:browser-back');
  },

  browserForward() {
    return ipcRenderer.invoke('opc:browser-forward');
  },

  browserReload() {
    return ipcRenderer.invoke('opc:browser-reload');
  },

  /** DevTools 开分离窗口：right 模式会和右侧面板抢同一块位置 */
  browserDevtools() {
    return ipcRenderer.invoke('opc:browser-devtools');
  },

  browserState() {
    return ipcRenderer.invoke('opc:browser-state');
  },

  /**
   * 订阅导航状态变化（URL / 标题 / 能否前进后退 / 是否在加载）。
   * 返回取消订阅函数 —— React 的 effect 清理要用它。
   */
  onBrowserState(cb) {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('opc:browser-state', handler);
    return () => ipcRenderer.removeListener('opc:browser-state', handler);
  },

  /**
   * P3：人机同屏状态（远程调试端口开着没有、预览视图的 target 认出来没有）。
   *
   * 只暴露「开着没有 / 端口 / 认没认出来」，**不给 ws 端点**：端点是要交给
   * Agent 的东西（走 data/cdp.json 与 OPC_CDP_TARGET 环境变量），页面上显示
   * 一个ws:// 字符串对用户没有任何可操作性，只会诱发「复制了能干什么」的误解。
   */
  cdpInfo() {
    return ipcRenderer.invoke('opc:cdp-info');
  },

  /**
   * P4：终端（PTY 优先，管道版兜底）。
   *
   * `terminalStart` 只接受绝对路径，且由主进程校验目录真的存在 ——
   * 前端传什么就信什么，等于把「能在哪执行命令」交给被约束方。
   */
  terminalStart(cwd) {
    if (typeof cwd !== 'string') return Promise.resolve({ ok: false, error: 'cwd 参数不合法' });
    return ipcRenderer.invoke('opc:terminal-start', cwd);
  },

  /**
   * 输入。PTY 模式下传**原始键流**（xterm 的 onData 原样转过来，含方向键
   * 转义与 `\r`）；管道版模式下传一整行命令文本。主进程按当前通道分派。
   */
  terminalInput(data) {
    if (typeof data !== 'string') return;
    ipcRenderer.send('opc:terminal-input', data);
  },

  /** 改尺寸（PTY 重排屏幕用）。返回最新状态，省得渲染进程再查一次。 */
  terminalResize(cols, rows) {
    if (typeof cols !== 'number' || typeof rows !== 'number') return Promise.resolve(null);
    return ipcRenderer.invoke('opc:terminal-resize', { cols, rows });
  },

  terminalKill() {
    return ipcRenderer.invoke('opc:terminal-kill');
  },

  terminalState() {
    return ipcRenderer.invoke('opc:terminal-state');
  },

  /** 输出历史：先读回这段，再订阅增量（用户可能先敲了命令才切到这个标签） */
  terminalOutput() {
    return ipcRenderer.invoke('opc:terminal-output');
  },

  /** 订阅输出增量与状态变化，各自返回取消订阅函数 */
  onTerminalData(cb) {
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on('opc:terminal-data', handler);
    return () => ipcRenderer.removeListener('opc:terminal-data', handler);
  },

  onTerminalState(cb) {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('opc:terminal-state', handler);
    return () => ipcRenderer.removeListener('opc:terminal-state', handler);
  },

  windowControl: {
    /** @param {'minimize'|'maximize'|'close'} action */
    send(action) {
      if (action !== 'minimize' && action !== 'maximize' && action !== 'close') return;
      ipcRenderer.send('opc:window-control', action);
    },

    /**
     * 拉一次当前是否最大化。
     *
     * 事件推送只能覆盖「订阅之后」的变化；窗口若以最大化状态被系统恢复
     * （Electron 自己会记住上次的尺寸与状态），首帧就拉不到了，按钮字形
     * 会停在「最大化」而窗口其实已经最大化。
     *
     * @returns {Promise<{maximized: boolean}>}
     */
    query() {
      return ipcRenderer.invoke('opc:window-state');
    },

    /**
     * 订阅最大化状态变化。返回取消订阅函数 —— React 的 effect 清理要用它，
     * 不摘监听的话每次挂载都会多叠一个回调。
     *
     * @param {(state: {maximized: boolean}) => void} cb
     * @returns {() => void}
     */
    onStateChange(cb) {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('opc:window-state', handler);
      return () => ipcRenderer.removeListener('opc:window-state', handler);
    },
  },
});
