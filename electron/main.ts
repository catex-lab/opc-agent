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

import { app, BrowserWindow, screen, shell, nativeTheme, ipcMain, dialog } from 'electron';
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

/**
 * 主题同步 —— 把**原生 UI**（原生滚动条、原生对话框、窗口底色）的颜色
 * 与前端界面拉到同一档。
 *
 * ## 为什么现在连三个窗口按钮也自己画了（A24）
 *
 * 早先的形态是「自绘标题条 + 把最小化/最大化/关闭交还给系统」
 * （`titleBarStyle: 'hidden'` + `titleBarOverlay`）。理由是系统按钮能白拿
 * Win11 的贴靠布局、高对比度模式和读屏支持。
 *
 * 代价在 A23 才量清楚：**控件区那块底色永远是实色**。屏幕实拍反解出
 * 页面侧背板 ≈ 226、系统侧 ≈ 240，两边基数不同，除 alpha = 1 之外无解
 * （试过 `#AARRGGBB` 被截断成 `#RRGGBB`、`transparent` 回退系统默认色）。
 * 于是「标题条必须不透明」—— 透明度的滑动条拉到 100 也只会停在标题条下面，
 * 用户要的「0 到 100 的真调整」在数学上做不到。
 *
 * 现在改成 `frame: false`：三个按钮由 `TitleBar.tsx` 自己画，标题条与
 * 按钮同属一个 DOM、同一套令牌、同一个 alpha，整窗（含标题条）才可能
 * 一起透。丢掉的只有「悬停最大化按钮弹出的贴靠布局面板」——
 * 贴靠本身（拖到屏幕边缘、Win+方向键、双击标题栏最大化）仍在，因为
 * 那些是 `-webkit-app-region: drag` 走 HTCAPTION 的系统行为，不由按钮提供。
 *
 * ## 标题条尺寸的唯一来源是 CSS
 *
 * 自绘之后，标题条高度（`--tc-titlebar-height`）与按钮宽度
 * （`--tc-caption-width`）只存在于 `src/index.css` —— 主进程不再需要知道
 * 它们（从前 `TITLE_BAR_HEIGHT` 要同时喂给 `titleBarOverlay`，两处不同值
 * 按钮就会压到标题条边缘上）。**不要**再把这两个值加回主进程。
 *
 * ## 与系统跟随的关系
 *
 * 前端默认是「跟随系统」，此时 `preference === 'system'`，这里回设
 * `themeSource = 'system'`，两边天然一致。
 * 只有用户**手动固定**了浅色/深色时才需要干预 —— 那正是割裂出现的场合。
 *
 * 设了 `themeSource` 之后，渲染进程的 `prefers-color-scheme` 会跟着变；
 * 但前端此时读的是自己选的 `preference`，不读系统，所以不会来回抖动。
 */
type ThemeMode = 'system' | 'light' | 'dark';

/** 与 `--tc-surface-content` 保持一致：内容区的底色 */
const SURFACE_CONTENT = { light: '#ffffff', dark: '#121212' } as const;

/**
 * 窗口级玻璃（应用本体透出桌面）。
 *
 * ## 为什么用 acrylic 而不是 `transparent: true`
 *
 * `transparent: true` 只是「让窗口透明」，背后是**未经处理的桌面**：
 * 文字压上去会和桌面图标、壁纸细节打架，Windows 上还会丢掉窗口阴影、
 * 圆角边缘发毛。而且它和 `titleBarOverlay` 一起用时，三个系统按钮的底
 * 会变成一块透明缺口。
 *
 * `backgroundMaterial: 'acrylic'` 是系统**自己**画的一层毛玻璃：
 * 桌面被模糊 + 提亮之后才透上来（正是用户说的「隐约看到桌面」），
 * 窗口阴影、圆角、贴靠、高对比度模式全都保留。
 *
 * 代价是它只在 **Windows 11 22H2（build 22621）及以上**可用。更低版本
 * 直接不开 —— 宁可没有玻璃，也不要一个黑窗或者一扇透明的窗。
 *
 * ## 与渲染进程的约定
 *
 * 开启时在加载地址上带 `?glass=1`，渲染进程据此给 <html> 打
 * `data-opc-glass="1"`，CSS 才把表面色换成半透明。**不通过 preload 传**：
 * 这个标记必须在首帧之前就位，走 IPC 会晚一帧、先闪一下实色界面。
 *
 * `OPC_GLASS=0` 可强制关闭（排查「窗口发黑」这类问题时先关它）。
 */
function supportsWindowGlass(): boolean {
  if (process.env.OPC_GLASS === '0') return false;
  if (process.platform !== 'win32') return false;
  // getSystemVersion() 形如 "10.0.26200"：第三个数字是 build
  const build = Number(process.getSystemVersion().split('.')[2] ?? 0);
  return build >= 22621;
}

const WINDOW_GLASS = supportsWindowGlass();
/** 玻璃开启时窗口底色必须是全透明，否则会把系统画的材质整块盖住 */
const TRANSPARENT_BG = '#00000000';

/** 加载地址：玻璃开启时带上标记（见 supportsWindowGlass 的注释） */
function withGlassFlag(url: string): string {
  if (!WINDOW_GLASS) return url;
  return `${url}${url.includes('?') ? '&' : '?'}glass=1`;
}

function resolvedMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * 把主题应用到原生层：themeSource + 窗口背景色。
 *
 * 三个窗口按钮已经不由系统画了（见上面的 A24 说明），所以这里没有
 * `setTitleBarOverlay` 这一步 —— 按钮的配色是纯 CSS 的事。
 */
function applyNativeTheme(mode: ThemeMode) {
  const resolved = resolvedMode(mode);
  nativeTheme.themeSource = mode;
  const bg = SURFACE_CONTENT[resolved];
  // 窗口还没建时 setBackgroundColor 无从谈起，先把值留着，建窗口时用
  if (mainWindow && !mainWindow.isDestroyed()) {
    // ⚠️ 玻璃开启时必须保持全透明：这行写回实色的话，系统画的 acrylic
    //    会被整块盖住 —— 用户看到的还是不透的窗口，且很难查出是哪一行干的
    mainWindow.setBackgroundColor(WINDOW_GLASS ? TRANSPARENT_BG : bg);
  }
  return bg;
}

/**
 * 系统主题变化时的兜底。
 *
 * 用户选了「跟随系统」时，Windows 一切深浅色，原生标题栏要跟着走。
 * 注意这里**不主动推给前端**：前端自己监听着 `prefers-color-scheme`，
 * 两边都从同一个源头拿值，不会分叉。
 */
function watchSystemTheme() {
  nativeTheme.on('updated', () => {
    const mode: ThemeMode = currentThemeMode;
    if (mode === 'system') applyNativeTheme('system');
  });
}

/** 当前生效的主题模式。初始为 system，等前端首帧 IPC 到达后更新 */
let currentThemeMode: ThemeMode = 'system';

/**
 * 把「是否最大化」推给渲染进程。
 *
 * 只在窗口真的存在时发；`webContents` 还没加载完时 `send` 不会抛错，
 * 只是丢包 —— 所以渲染进程侧另有一次 `invoke` 拉初始值（见 registerIpc）。
 */
function pushWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('opc:window-state', { maximized: mainWindow.isMaximized() });
}

/**
 * 窗口控制与主题的 IPC。**只在启动时注册一次**。
 *
 * 早先这些 handler 写在 `createWindow()` 里：macOS 上窗口关掉再从 Dock 点开
 * 会重新建窗，于是同一个通道被注册第二遍，一次 IPC 触发两次处理
 * （主题重复设置看不出来，但窗口按钮会「最大化 → 又还原」）。
 */
function registerIpc() {
  // 前端首帧会把主题偏好发过来；此后每次用户在设置里改主题都会再发一次。
  ipcMain.on('opc:set-theme', (_e, mode: ThemeMode) => {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
    currentThemeMode = mode;
    const bg = applyNativeTheme(mode);
    // 打一行日志：这条链路（前端 → IPC → 原生主题）中间任何一环断了，
    // 界面都照样正常，只有窗口底色与原生滚动条会停在旧值 —— 那些不出现在
    // 任何 page.screenshot 里（一个是窗口背景，一个是系统绘制的控件），
    // 所以让主进程把实际生效的值说出来，打靶脚本才能断言它。
    console.log(
      `[Theme] 原生主题 themeSource=${nativeTheme.themeSource} bg=${WINDOW_GLASS ? TRANSPARENT_BG : bg}` +
        ` caption=self`
    );
  });

  // 三个窗口按钮（TitleBar.tsx）的动作。无边框窗口里没有系统按钮，
  // 最小化/最大化/关闭必须由页面发指令、主进程执行。
  ipcMain.on('opc:window-control', (_e, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      // 一个通道承担「最大化 / 还原」两件事：按钮只有一个，状态由主进程判定，
      // 免得页面记的 isMaximized 与真实状态分叉。
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') mainWindow.close();
  });

  // 初始状态：页面挂载时拉一次。事件推送只能覆盖「之后的」变化，
  // 窗口若以最大化状态恢复（Electron 会记住上次尺寸/状态），首帧就拉不到了。
  ipcMain.handle('opc:window-state', () => ({
    maximized: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized(),
  }));

  // A63：工作区 —— 选目录对话框。
  //
  // `properties: ['openDirectory']` 让对话框只能选文件夹（不能选文件），
  // 这与「工作目录」的语义一致；不传的话用户选到一个 .txt 也能确定，
  // 之后 Agent 在该路径上 spawn 才失败。
  //
  // 用户取消 → filePaths 是空数组 → 返回 null。前端把 null 当「没选」，
  // 保持原值不动 —— 取消是一次正常的用户决定，不该弹任何提示。
  ipcMain.handle('opc:pick-directory', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作目录',
      properties: ['openDirectory'],
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  });

  // A63：工作区 —— 在资源管理器里打开。路径不存在时 Electron 返回 false，
  // 这里同样不抛：调用方（前端）紧接着就会看到界面没有反应，
  // 而路径在上一动已经校验过，走到这里基本不可能不存在。
  ipcMain.handle('opc:reveal-in-folder', (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return false;
    return shell.showItemInFolder(p);
  });
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

  const initialMode = resolvedMode(currentThemeMode);

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
    // 无边框：标题条与三个窗口按钮全部由页面画（见文件头「为什么现在连三个
    // 窗口按钮也自己画了」）。macOS 仍走 hiddenInset —— 红黄绿三灯由系统画、
    // 位置固定在左上，自绘没有收益（也拿不到那套系统行为）。
    //
    // `thickFrame` 保持默认 true：它给的是「可拖边缘缩放 + 窗口阴影 + 动画 +
    // 贴靠」，这些都不依赖系统标题栏。设 false 会一起丢掉，窗口变成一块
    // 没有阴影的硬纸板。
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // 窗口底色跟随主题，而不是写死白色。
    // 写死 #ffffff 的后果：深色主题下首帧渲染前会白闪一下，
    // 拖动/缩放时窗口边缘也会露出白边。
    // 玻璃态下必须是全透明 —— 见 TRANSPARENT_BG 的注释。
    backgroundColor: WINDOW_GLASS ? TRANSPARENT_BG : SURFACE_CONTENT[initialMode],
    // 系统画的毛玻璃底（桌面被模糊后透上来）。Windows 10 / Win11 21H2 不支持，
    // 所以由 supportsWindowGlass() 决定给不给这个字段 —— 传了不支持的平台会抛错。
    ...(WINDOW_GLASS ? { backgroundMaterial: 'acrylic' as const } : {}),
    webPreferences: {
      // 前端不依赖任何 Electron API，所以关掉 Node 集成：
      // 既让渲染进程与浏览器环境保持完全一致（同一套代码、同一套调试），
      // 也收紧了安全面。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 主题桥（见 preload.cjs）：前端把主题偏好同步过来，主进程据此调
      // nativeTheme.themeSource + setBackgroundColor。
      // 不配它前端就拿不到这个通道，原生标题栏会永远是系统色，
      // 于是「应用深色 + 标题栏浅色」的割裂修不掉。
      //
      // ⚠️ 在 Electron 44 里 preload 必须写在 webPreferences 内 ——
      // 它已从顶层 BrowserWindowConstructorOptions 移到 WebPreferences，
      // 写在顶层 TS 会报 TS2353（不在已知属性里）。
      preload: join(__dirname, 'preload.cjs'),
    },
  });

  // 最大化状态推给渲染进程：按钮的字形要在「最大化」与「还原」之间切换，
  // 而这件事**只有主进程知道** —— 用户也可能通过双击标题栏、Win+↑、
  // 拖到屏幕顶部来最大化，那些路径都不经过页面里的按钮。
  // 漏了这条推送，按钮图标会与实际状态分叉：窗口已经最大化，图标还画着「最大化」。
  mainWindow.on('maximize', pushWindowState);
  mainWindow.on('unmaximize', pushWindowState);
  // 全屏/退出全屏不改变 isMaximized，但布局会变（页面铺满整屏），
  // 一并推一次，按钮不会因此停在错的字形上。
  mainWindow.on('enter-full-screen', pushWindowState);
  mainWindow.on('leave-full-screen', pushWindowState);
  watchSystemTheme();

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  console.log(
    `[Main] 窗口加载: ${withGlassFlag(url)}（窗口玻璃 ${WINDOW_GLASS ? 'acrylic 开启' : '关闭'}）`
  );
  await loadWithRetry(mainWindow, withGlassFlag(url));
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

  app.whenReady().then(() => {
    registerIpc();
    return createWindow();
  }).catch(err => {
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
