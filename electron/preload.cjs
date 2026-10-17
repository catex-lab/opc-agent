/**
 * 渲染进程与主进程之间的**最小** IPC 桥。
 *
 * ## 为什么需要它
 *
 * 应用的深浅色由前端 CSS 变量驱动（`--tc-surface-chrome` 等），但
 * **Windows 的原生标题栏不由 CSS 画** —— 它由 Electron / 操作系统绘制，
 * 颜色取自 `nativeTheme.themeSource`。
 *
 * 于是会出现这种割裂：用户在设置里固定「深色」，而 Windows 是浅色
 *   → 窗口最顶上那条原生标题栏是浅色
 *   → 下面整块界面是深色
 * 一条白带压在黑界面上，非常显眼。
 *
 * 反方向同理：固定「浅色」+ Windows 深色 → 黑带压在白界面上。
 *
 * ## 为什么是「最小」
 *
 * 本项目刻意保持「前端不依赖任何 Electron API」：`nodeIntegration: false`、
 * `contextIsolation: true`、`sandbox: true`。同一份代码在浏览器开发态和
 * 打包态跑的是同一个渲染进程，一旦这里多暴露一个 API，前端就多一条
 * 「只在 Electron 里才有的代码路径」。
 *
 * 所以这里只暴露一个方法，且前端一律用**可选调用**（`window.opc?.setTheme(...)`）——
 * 浏览器开发时 `window.opc` 是 undefined，调用被跳过，行为不变。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opc', {
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
});
