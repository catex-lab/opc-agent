/**
 * P2 验证：浏览器预览视图（WebContentsView）。
 *
 * 分两半，因为这两半的风险完全不同：
 *
 *   **A. 源码契约** —— 「安全默认值有没有被悄悄放宽」。
 *     `nodeIntegration:true`、给了 preload、权限放行、协议白名单被扩，
 *     这四样任何一样发生，编译都通过、界面也看不出来，但等于把一颗完整
 *     浏览器连我们的 IPC 桥一起交给任意远程页面。只能靠读源码断言。
 *
 *   **B. 真实 Electron 冒烟** —— 「视图到底渲染出来了没有」。
 *     `verify:render` 跑在普通 Chrome 里，`window.opc` 根本不存在，
 *     **P2 用那套 harness 一行都验不到**。所以这里起一个只创建视图的
 *     最小 Electron 实例（`OPC_SMOKE=browser`），加载本地 http 探针页，
 *     再把「背景色对不对、页面里有没有 Node、session 分对没有」读回来。
 *
 * 运行：npx tsx scripts/verify-a78-browser.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/* ── A. 源码契约 ─────────────────────────────────────────────────────── */
function checkContracts() {
  const src = read('electron/browser-view.ts');

  ok(src.includes('WebContentsView'), '契约：用 WebContentsView（不是已废弃的 BrowserView）');
  ok(!/new BrowserView\(/.test(src), '契约：没有使用 BrowserView');
  ok(src.includes("BROWSER_PARTITION = 'persist:browser'"), '契约：独立 session 分区');
  ok(src.includes('session.fromPartition(BROWSER_PARTITION)'), '契约：视图用独立分区的 session');
  ok(/nodeIntegration:\s*false/.test(src), '契约：nodeIntegration:false');
  ok(/contextIsolation:\s*true/.test(src), '契约：contextIsolation:true');
  ok(/sandbox:\s*true/.test(src), '契约：sandbox:true');
  // preload 绝不能出现在视图的 webPreferences 里：它一出现，
  // 任意远程页面就拿到了我们整套 IPC 桥
  // 视图 webPreferences 里不能出现 preload 这一项。
  // 只匹配 `preload:` 这种键值写法：注释里提到 preload 是允许的（那正是在
  // 解释为什么不给它），把注释也算进去会得到永假。
  const wpStart = src.indexOf('webPreferences');
  const wpBlock = src.slice(wpStart, wpStart + 400);
  ok(!/preload\s*:/.test(wpBlock), '契约：视图不配 preload（远程页面拿不到 IPC 桥）');

  ok(src.includes("setPermissionRequestHandler((_wc, _perm, callback) => callback(false))"), '契约：权限请求一律拒绝');
  ok(src.includes('setPermissionCheckHandler(() => false)'), '契约：权限检查一律返回 false');
  ok(/setWindowOpenHandler/.test(src) && /action:\s*'deny'/.test(src), '契约：新窗口一律 deny');
  ok(src.includes('shell.openExternal'), '契约：被 deny 的新窗口转交系统浏览器');
  ok(/will-navigate/.test(src) && /event\.preventDefault\(\)/.test(src), '契约：非白名单协议的顶层导航被阻止');

  // 白名单只含 http/https。从 `new Set([` 起取：从名字取会取到文档注释里
  // 那句「不放行 file:」，于是永远断言失败。
  const setStart = src.indexOf('new Set([');
  const proto = src.slice(setStart, setStart + 120);
  ok(proto.includes("'http:'") && proto.includes("'https:'"), '契约：白名单只含 http/https');
  ok(!proto.includes("'file:'"), '契约：不放行 file:');

  // bounds 与可见性的顺序：先 bounds 再显示，否则闪一帧全窗口网页
  ok(/先 bounds 再显示/.test(src), '契约：注释写明了 bounds 先于可见性');
  ok(/wantVisible/.test(src), '契约：setBounds 依据 wantVisible（渲染进程两个 effect 的顺序不保证）');

  // —— 主进程接线 ——
  const main = read('electron/main.ts');
  for (const channel of [
    'opc:browser-rect',
    'opc:browser-visible',
    'opc:browser-load',
    'opc:browser-back',
    'opc:browser-forward',
    'opc:browser-reload',
    'opc:browser-devtools',
    'opc:browser-state',
  ]) {
    ok(main.includes(channel), `契约：main 注册 ${channel}`);
  }
  ok(main.includes('browserPanel.attach(mainWindow)'), '契约：视图绑定到主窗口');
  ok(/win\.on\('closed'/.test(src) || /mainWindow\.on\('closed'/.test(src), '契约：窗口关闭时销毁视图（不留下有网络能力的活对象）');
  ok(main.includes("process.env.OPC_SMOKE === 'browser'"), '契约：冒烟钩子已接入启动链');
  ok(/import \{[^}]*browserPanel[^}]*runBrowserSmoke[^}]*\} from '\.\/browser-view\.js'/.test(main), '契约：main 引入 browserPanel 与冒烟入口');

  // —— preload 桥 ——
  const preload = read('electron/preload.cjs');
  for (const fn of [
    'browserRect(',
    'browserVisible(',
    'browserLoad(',
    'browserBack(',
    'browserForward(',
    'browserReload(',
    'browserDevtools(',
    'browserState(',
    'onBrowserState(',
  ]) {
    ok(preload.includes(fn), `契约：preload 暴露 ${fn.replace('(', '')}`);
  }
  ok(preload.includes("ipcRenderer.send('opc:browser-rect'"), '契约：browserRect 走 opc:browser-rect');
  ok(preload.includes("ipcRenderer.invoke('opc:browser-load'"), '契约：browserLoad 走 opc:browser-load');
  ok(preload.includes("ipcRenderer.on('opc:browser-state'"), '契约：导航状态经 opc:browser-state 推送');

  // —— 渲染进程 ——
  const bridge = read('src/browserPanel.ts');
  ok(bridge.includes('export function hasBrowserView'), '契约：browserPanel 导出 hasBrowserView');
  ok(bridge.includes('export function reportRect'), '契约：browserPanel 导出 reportRect');
  ok(bridge.includes('export function subscribeNavState'), '契约：browserPanel 导出 subscribeNavState');

  const guard = read('src/overlayGuard.ts');
  ok(guard.includes('getClientRects().length > 0'), '契约：浮层判定用 getClientRects（display:none 的 details 子节点仍在 DOM 里）');
  ok(guard.includes('[data-opc-overlay]'), '契约：认我们自己的浮层标记');
  ok(guard.includes('[class*="t-dialog"]'), '契约：认 TDesign 弹层');

  const tab = read('src/components/WorkspaceBrowser.tsx');
  ok(tab.includes('hasBrowserView()'), '契约：没有原生能力时明说（不摆假地址栏）');
  ok(tab.includes('浏览器预览只在桌面端可用'), '契约：不可用时给出可读的说明');
  ok(tab.includes('ResizeObserver'), '契约：用 ResizeObserver 跟尺寸');
  ok(tab.includes("window.addEventListener('resize'"), '契约：窗口缩放也上报（x 与 width 都会变）');
  ok(tab.includes('setBrowserVisible(false)'), '契约：卸载时隐藏视图（否则盖住文件树）');
  ok(tab.includes('subscribeOverlay'), '契约：浮层出现时隐藏视图');
  ok(tab.includes('data-browser-viewport'), '契约：视口容器有标记（便于排查矩形对不上）');

  const panel = read('src/components/WorkspacePanel.tsx');
  ok(panel.includes("role=\"tablist\""), '契约：标签行有无障碍语义');
  ok(panel.includes('<WorkspaceBrowser />'), '契约：浏览器标签挂了组件');
  ok(panel.includes('<WorkspaceTerminal'), '契约：终端标签挂了组件（P4）');
  // 没做的功能不能摆按钮。只数 role="tab"：注释里提到「终端」是在解释
  // 为什么不摆/为什么摆，不能把它当成标签本身。
  // P4 起终端真的做了，所以是三个：文件 / 浏览器 / 终端。
  const tabCount = (panel.match(/role="tab"/g) || []).length;
  ok(tabCount === 3, '契约：恰好三个标签（文件 / 浏览器 / 终端）', `实际 ${tabCount} 个`);
  ok(!panel.includes('>设置<'), '契约：没有设置标签（没有设置页，不摆空壳）');

  const header = read('src/components/ChatHeader.tsx');
  ok(header.includes('data-opc-overlay'), '契约：自绘更多菜单带浮层标记（否则被预览视图盖住）');
}

/* ── B. 真实 Electron 冒烟 ───────────────────────────────────────────── */
async function runSmoke(): Promise<void> {
  const root = process.cwd();
  const outFile = path.join(root, '.tmp', 'browser-smoke.json');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-smoke-browser-'));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* 上次残留 */
  }

  console.log('  启动最小 Electron 实例（OPC_SMOKE=browser）…');

  // `electron .` 跑的是 dist-electron/ 里的**构建产物**，不是 TS 源码。
  // 不先构建的话，冒烟测的是上一版的代码 —— 而上一版很可能正好没有
  // 这次要验的东西（本次就踩到：钩子加在 main.ts 里，产物还是旧的）。
  // shell: true 不能省：Windows 上 npm 是 npm.cmd，不带 shell 的 spawn
  // 直接 ENOENT（实测 exit=null，看不出根因）。
  const build = spawnSync('npm', ['run', '-s', 'build:electron'], {
    cwd: root,
    stdio: 'ignore',
    shell: true,
  });
  if (build.status !== 0) {
    ok(false, '冒烟：build:electron 失败', `exit=${build.status}`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    // 直接跑 electron.exe，不套 npx：Windows 上 npx 是 .cmd，
    // spawn 不带 shell 会 ENOENT。做法与 scripts/capture-window.mjs 一致。
    const env = { ...process.env } as NodeJS.ProcessEnv;
    // 宿主 CLI 自带这几个变量，不删会把 electron 当 node 跑（不开窗口）
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.OPC_GLASS;
    // 本机 GPU 进程会 ACCESS_VIOLATION 直接带走整个应用
    // （表现为「窗口一闪就退」，日志只有 GPU process isn't usable），
    // 与 capture-window.mjs 同样切到软件渲染。
    //
    // 注意 OPC_SAFE_GRAPHICS **不够**：本机 EDR/沙箱会往进程注入未签名 DLL，
    // GPU 子进程照样 0xC0000005，然后 `GPU process isn't usable. Goodbye.`
    // 把主进程一起带走 —— 冒烟连报告都写不出来。还必须关掉 GPU 沙箱，
    // 与 verify-package.mjs 的 DEFAULT_ARGS 保持一致（同机同坑）。
    // 这是环境问题不是产品缺陷：正常桌面双击不需要这些参数。
    env.OPC_SAFE_GRAPHICS = '1';
    const extraArgs =
      process.env.OPC_SMOKE_ARGS === undefined
        ? ['--no-sandbox', '--disable-gpu-sandbox']
        : process.env.OPC_SMOKE_ARGS.trim().split(/\s+/).filter(Boolean);
    env.OPC_SMOKE = 'browser';
    env.OPC_USER_DATA_DIR = userData;
    env.OPC_DATA_DIR = userData;
    env.PORT = '0';

    const child = spawn(
      path.resolve('node_modules/electron/dist/electron.exe'),
      ['.', ...extraArgs],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let log = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('冒烟超时（90s）\n' + log.slice(-2000)));
    }, 90_000);

    child.stdout.on('data', d => {
      log += String(d);
    });
    child.stderr.on('data', d => {
      log += String(d);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
  });

  if (!fs.existsSync(outFile)) {
    ok(false, '冒烟：实例未写出报告', '没有 .tmp/browser-smoke.json');
    return;
  }

  const report = JSON.parse(fs.readFileSync(outFile, 'utf8')) as Record<string, unknown>;
  const probe = report.probe as Record<string, unknown> | undefined;

  ok(report.error === undefined, '冒烟：无异常', String(report.error ?? ''));
  ok(report.urlAccepted === true, '冒烟：http 探针页被接受（协议白名单放行）');
  ok(report.visible === true, '冒烟：视图可见');
  ok(probe?.probeText === 'opc-browser-probe', '冒烟：页面真的渲染出来了', `probeText=${String(probe?.probeText)}`);
  ok(
    probe?.background === 'rgb(15, 110, 86)',
    '冒烟：视图画出了页面内容（背景色匹配）',
    `background=${String(probe?.background)}`
  );
  ok(probe?.nodeInPage === 'undefined', '冒烟：页面里没有 Node（不给 preload + sandbox 的证据）', `typeof require=${String(probe?.nodeInPage)}`);
  ok(probe?.partitionOk === true, '冒烟：视图用的是独立 session 分区');
  ok(report.ok === true, '冒烟：总判定通过');

  console.log(`  探针：${JSON.stringify(probe)}`);

  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* Windows 上进程可能还持着锁，留给系统回收 */
  }
}

async function main() {
  console.log('[A] 源码契约');
  checkContracts();

  console.log('[B] 真实 Electron 冒烟');
  await runSmoke();

  const passed = checks.total - failures.length;
  console.log(`\n浏览器预览视图（P2）断言：${passed}/${checks.total} 通过`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ 安全默认值 / IPC 接线 / 浮层哨兵 / 真实渲染均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
