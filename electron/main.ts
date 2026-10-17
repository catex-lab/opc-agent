/**
 * Electron 主进程。
 *
 * 架构（对应 PLAN §3.5）：**Express 直接跑在主进程里**，窗口加载
 * `http://127.0.0.1:<port>`，前端与后端之间就是一条普通的 HTTP 通路 ——
 * 和浏览器开发时完全一致。因此：
 *   - 不需要 Node sidecar，也不需要打包 Node 运行时；
 *   - 前端代码里没有一处 `if (isElectron)`；
 *   - 浏览器开发链路（`npm run dev`）依然完整可用。
 *
 * ⚠️ 模块求值顺序是本文件最容易踩的坑：
 *   `server/db.ts` 在**模块顶层**就打开 SQLite 并读取 `OPC_DATA_DIR`，
 *   而 esbuild 会把 `server/**` 静态打进本文件，导入语句在打包后是
 *   排在本文件代码之前的 `require`。也就是说，等本文件第一行执行时，
 *   数据库**已经打开了**。
 *   所以环境变量必须在 `bootstrap.cjs` 里设好 —— 它是 `require` 本文件的
 *   那一层，天然早于所有模块初始化。
 */

import { app, BrowserWindow, screen, shell } from 'electron';
import { once } from 'node:events';
import { join } from 'node:path';
import { server } from '../server/index.js';
import { registry } from '../server/agents/registry.js';

/**
 * 软件渲染逃生开关。
 *
 * 部分环境（企业 EDR、应用沙箱）会向进程注入未签名的 hook DLL，导致
 * Chromium 的 GPU 子进程在初始化阶段直接崩掉（实测退出码 `0xC0000005`
 * ACCESS_VIOLATION），表现为**窗口一闪就退**，日志里只有
 * `GPU process isn't usable. Goodbye.`，完全看不出跟注入有关。
 *
 * 用 `OPC_SAFE_GRAPHICS=1` 切到软件渲染可绕开。
 * 之所以做成开关而**不是默认行为**：关掉 GPU 会明显拖慢滚动与动画，
 * 不该让绝大多数正常环境一起承担这个代价。
 */
if (process.env.OPC_SAFE_GRAPHICS === '1') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 注入的未签名 DLL 会让渲染进程的代码完整性校验主动自杀，一并关掉
  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
  console.log('[Main] OPC_SAFE_GRAPHICS=1 —— 已切换到软件渲染');
}

/** 开发态由 Vite 提供前端；打包态为空字符串，走进程内托管的 dist */
const DEV_URL = process.env.OPC_DEV_SERVER_URL || '';

/**
 * Windows 任务栏图标的分组与通知归属靠 AppUserModelID 识别。
 *
 * 打包态 electron-builder 会按 appId 把它写进 exe，但开发态（npx electron .）
 * 没有这层信息 —— 结果是任务栏上显示 Electron 默认的原子图标，
 * 而且系统通知会归到「Electron」名下而不是本应用。
 * 显式设置一次，两种形态就一致了。appId 必须与 electron-builder.yml 保持一致。
 */
if (process.platform === 'win32') {
  app.setAppUserModelId('com.opc.agent');
}

let mainWindow: BrowserWindow | null = null;

/**
 * 等到 HTTP 服务真正开始监听，再返回窗口该加载的地址。
 *
 * 不能直接用 `PORT` 算地址：打包态传的是 `PORT=0`（由系统分配空闲端口），
 * 真实端口只有 `listening` 之后才能从 `server.address()` 读到。
 */
async function resolveAppUrl(): Promise<string> {
  if (DEV_URL) return DEV_URL;

  // `listen` 是异步的，但可能在我们挂监听之前就已完成，所以先查状态
  if (!server.listening) await once(server, 'listening');

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 3000;
  return `http://127.0.0.1:${port}`;
}

/**
 * 加载页面，失败就重试。
 * 开发态 Vite 可能还没起来，直接 loadURL 会停在错误页且不会自动恢复。
 */
async function loadWithRetry(win: BrowserWindow, url: string, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL(url);
      return;
    } catch (err) {
      if (i === attempts - 1) {
        console.error('[Main] 页面加载失败:', (err as Error).message);
        return;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

async function createWindow() {
  const url = await resolveAppUrl();

  /**
   * 默认窗口尺寸：按屏幕工作区取比例，再夹到合理区间。
   *
   * 原先写死 1360×900。在 1920×1080 上占 71% 看着还行，但在 1440×900、
   * 1366×768 这类笔记本屏上几乎铺满整个桌面 —— 最大化按钮按下去几乎没变化，
   * 等于失去了意义。
   *
   * 现在按工作区（已扣除任务栏）的 75% 算，再夹到 [960,1280] × [600,820]：
   *   1920×1080 → 1280×820（约 67% × 76%，四周留出明显桌面）
   *   1440×900  → 1080×675
   *   1366×768  → 1024×600（触到下限，但仍不顶屏幕边缘）
   * 用户上一次手动调整的尺寸仍由 Electron 自己记忆，这里只管首次启动。
   */
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.max(960, Math.min(1280, Math.round(workAreaSize.width * 0.75)));
  const height = Math.max(600, Math.min(820, Math.round(workAreaSize.height * 0.75)));

  console.log(
    `[Main] 窗口 ${width}x${height}（工作区 ${workAreaSize.width}x${workAreaSize.height}，` +
      `占 ${Math.round((width / workAreaSize.width) * 100)}% x ${Math.round((height / workAreaSize.height) * 100)}%）`
  );

  mainWindow = new BrowserWindow({
    width,
    height,
    // 最小尺寸给到 720 —— 前端在 900px 以下会切成单栏模式，
    // 导航条 56 + 单栏内容，720 宽仍然够用。
    // 原先 960 是「够放下三栏」的下限，但那把单栏模式也一并挡掉了。
    minWidth: 720,
    minHeight: 520,
    center: true,
    // 窗口左上角与任务栏都用它。图标由 scripts/build-electron.mjs 拷到
    // dist-electron/ —— 不能指向 build/icon.png，那个目录是构建资源、
    // 不进 app.asar，打包态会静默失效。
    icon: join(__dirname, 'icon.png'),
    show: false, // 等首帧渲染完再显示，避免白屏闪一下
    autoHideMenuBar: true,
    title: 'OPC Agent',
    backgroundColor: '#ffffff',
    webPreferences: {
      // 前端不依赖任何 Electron API，所以关掉 Node 集成：
      // 既让渲染进程与浏览器环境保持完全一致（同一套代码、同一套调试），
      // 也收紧了安全面。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  console.log(`[Main] 窗口加载: ${url}`);
  await loadWithRetry(mainWindow, url);
}

// 单实例：第二次启动时聚焦已有窗口，而不是再开一个抢同一个数据目录
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow).catch(err => {
    console.error('[Main] 启动失败:', err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前回收 ACP 等长驻子进程（Hermes 是一个常驻的 Python 进程，
// 不主动杀会变成孤儿进程留在系统里）
app.on('before-quit', () => {
  try {
    registry.disposeAll();
  } catch (err) {
    console.error('[Main] 清理子进程失败:', (err as Error).message);
  }
});
