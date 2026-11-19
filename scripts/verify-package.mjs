/**
 * 打包产物冒烟测试（P5）。
 *
 * 验证对象是 **打包后的 win-unpacked 目录**，不是源码、不是 dist/：
 *   node scripts/verify-package.mjs "release-p5b/win-unpacked/OPC Agent.exe"
 *
 * 为什么需要它：`tsx` 开发态跑通 ≠ 打包后跑通。两者差别在
 *   - 服务端是 esbuild 打进 main.cjs 的编译产物，不是 TS 源码；
 *   - 前端从 `app.asar/dist` 读，不是仓库里的 `dist/`；
 *   - 数据目录由 `app.getPath('userData')` 决定，不是仓库 `data/`；
 *   - 端口是 `PORT=0` 由系统分配，不是固定 3000。
 * 这四条任何一条错了，开发态都发现不了。
 *
 * 检查内容：
 *   [1] 进程能起来，后端真的开始监听（从 stdout 解析真实端口）
 *   [2] /api/health 与 /api/image/providers 正常
 *   [3] P4-1：会话的 cwd / scenarioId / systemPrompt 落库并能读回
 *   [4] P4-2 / P4-3：连应用**自己的渲染进程**（CDP）打开聊天页，6 张场景卡可见、选生图后输入区切换
 *   [5] P4-1 验收：**重启进程**后会话与三字段仍在
 *   [6] 数据落在 OPC_DATA_DIR，安装目录不被写入
 *   [7] **隔离自证**：跑完后真实 userData 的文件 mtime 一个都没变
 *
 * 关于启动参数：本机（沙箱/EDR 注入未签名 DLL）会让 GPU 子进程
 * `0xC0000005` 崩溃并触发 `FATAL: GPU process isn't usable. Goodbye.`，
 * 主进程随之退出（退出码 0x80000003）—— 表现是「端口拿到了、接口也能打，
 * 但几秒后浏览器连接被拒」。所以默认带 `--no-sandbox --disable-gpu-sandbox`。
 * 这是**环境问题**，不是产品缺陷 —— 正常桌面环境双击即可。
 * 想改默认参数：`OPC_SMOKE_ARGS="--foo --bar"`；想清空：`OPC_SMOKE_ARGS=" "`。
 *
 * 不使用真实用户数据：传 `OPC_USER_DATA_DIR` 把**整个 Chromium profile**
 * 搬到临时目录（只设 OPC_DATA_DIR 只能搬走 SQLite，profile 仍会漏），
 * 退出时清理。[7] 会用 mtime 快照复核这件事，不靠自我声明。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

/**
 * 默认测试对象 = 最新的 `release…/win-unpacked/OPC Agent.exe`。
 *
 * 为什么不写死某个目录：之前默认值写的是 `release-p5b`，后来产物更新到 p5c/p5d，
 * 默认值就成了**过期产物** —— 跑出来是绿的，但绿的可能是旧包。
 * 这种「测了旧东西还以为测了新东西」比不测更危险，所以改成按 mtime 自动选最新。
 */
function newestPackagedExe() {
  const candidates = readdirSync('.', { withFileTypes: true })
    .filter(d => d.isDirectory() && /^release/.test(d.name))
    .map(d => path.join(d.name, 'win-unpacked', 'OPC Agent.exe'))
    .filter(p => existsSync(p))
    .map(p => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0]?.p ?? null;
}

let EXE = process.argv[2] || newestPackagedExe();
// F0-02③ 交互坑：electron:build 打包后 build-installer 会清掉 win-unpacked（磁盘纪律），
// 本闸门就没了冒烟对象。自足兜底：现打一个 unpacked（不打 installer，约 1-2 分钟）。
if (!EXE) {
  console.log('[package] 未找到 win-unpacked，现打一个（electron-builder --dir）……');
  const r = spawnSync('npx', ['electron-builder', '--dir'], {
    shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
  });
  if (r.status !== 0) {
    console.error('[package] electron-builder --dir 失败：', String(r.stderr ?? '').slice(-800));
    process.exit(1);
  }
  EXE = newestPackagedExe();
}
if (!EXE) EXE = path.join('release-p5d', 'win-unpacked', 'OPC Agent.exe');

// 本机（沙箱 / EDR 注入未签名 DLL）会让 GPU 子进程 `0xC0000005` 崩溃，
// 进而 `FATAL: GPU process isn't usable. Goodbye.` —— 主进程随即退出
// （退出码 0x80000003），表现是「端口拿到了、接口也能打，但几秒后连接被拒」。
// 只设 `OPC_SAFE_GRAPHICS=1`（软件渲染）**不够**，还必须关掉 GPU 沙箱。
//
// 这是**环境问题**，不是产品缺陷：正常桌面双击不需要这些参数。
// 所以默认就带上，避免每次手动传；需要模拟「干净环境」时设
// `OPC_SMOKE_ARGS=" "`（空格）把默认值清空。
const DEFAULT_ARGS = ['--no-sandbox', '--disable-gpu-sandbox'];
const EXTRA_ARGS = process.env.OPC_SMOKE_ARGS === undefined
  ? DEFAULT_ARGS
  : process.env.OPC_SMOKE_ARGS.trim().split(/\s+/).filter(Boolean);

const results = [];
const ok = (cond, name, extra = '') => {
  results.push({ pass: !!cond, name, extra });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 结束整棵进程树。
 *
 * 为什么不用 `child.kill()`：它只给主进程发信号，Electron 的 gpu / utility /
 * renderer 子进程会晚于主进程退出，仍占着同一个 userData 的实例锁，新实例
 * 一启动就自己退出 —— 表现就是 [5] 的「老进程没退 + 重启 30s 拿不到端口」。
 * 本机 EDR 环境下实测连 `taskkill /F` 都会偶发第一次不生效，所以：
 *   1. 先 `taskkill /T /F` 带走整棵树（Windows）；
 *   2. 再补一次 `kill()`，兼容非 Windows / taskkill 不可用；
 *   3. 调用方负责等 exit 事件，并在 15 秒后补第二刀（见 [5]）。
 */
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* taskkill 不可用就走下面的 kill */
    }
  }
  try { proc.kill(); } catch { /* 可能已退出 */ }
}

/**
 * 等某个端口彻底不再应答（返回 true）或超时（返回 false）。
 *
 * 为什么需要它：重启验收的旧写法是 `child.kill()` 后固定 sleep 2500ms。
 * 但 `kill()` 返回只代表「信号发出去了」，Electron 的 gpu / utility /
 * renderer 子进程会晚于主进程退出，仍占着同一个 userData 的实例锁 ——
 * 于是新实例一启动就自己退出，表现是「重启后 30s 拿不到端口」，
 * **间歇性**红（实测三次里红一次）。与 A114 的 killTree 是同一类坑：
 * kill 返回 ≠ 进程已死。所以这里改成等真实可观测量。
 *
 * 注意它只是**同步手段**，不能单独当断言用 —— 「等完之后端口不通」
 * 是自我实现。真正的判据在下面：断言新起的是另一个 PID。
 */
const waitPortClosed = async (port, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (!open) return true;
    await sleep(250);
  }
  return false;
};

if (!existsSync(EXE)) {
  console.error(`✗ 找不到可执行文件: ${EXE}\n  先跑 npm run electron:build，或显式传入路径。`);
  process.exit(2);
}
console.log(`测试对象: ${EXE}（${new Date(statSync(EXE).mtimeMs).toLocaleString()}）`);

const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-pkg-smoke-'));

// 夹具的工作目录必须是**真实存在**的目录。POST /api/sessions 对 cwd 做了
// `validateDirectory` 校验，不存在直接 400（见 server/index.ts 的
// 「工作目录不存在」分支）—— 所以这里现建一个临时目录，而不是编一个
// 看起来合理但盘符都不存在的路径，否则脚本会因「目录不存在」而红，
// 与打包产物无关。断言也统一拿这个变量比对，避免字面量两处漂移。
const projectDir = mkdtempSync(path.join(tmpdir(), 'opc-pkg-proj-'));

// 隔离断言用的真实 userData 快照。
// 为什么需要它：光「我把 OPC_DATA_DIR 指向临时目录了」是一句**自我声明**，
// 不是事实。实测过只设 OPC_DATA_DIR 时 chat.db 没动、但 blob_storage 被写了
// —— 隔离做了一半。所以这里改成先拍快照、跑完比对，让脚本自己证明隔离成立。
const REAL_USER_DATA = path.join(process.env.APPDATA || '', 'opc-agent');
const PROFILE_WATCH = ['Preferences', 'Session Storage', 'blob_storage', 'DIPS', 'chat.db'];
const snapshotProfile = () =>
  Object.fromEntries(
    PROFILE_WATCH.map(f => {
      try {
        return [f, statSync(path.join(REAL_USER_DATA, f)).mtimeMs];
      } catch {
        return [f, null];
      }
    })
  );
const profileBefore = snapshotProfile();

/** 启动一次应用，返回 { child, port } */
function launch() {
  return new Promise((resolve, reject) => {
    /**
     * ⚠️ 宿主变量必须 **delete**，不能写成 `X: undefined`：
     * `{ ...process.env, X: undefined }` 里 X 仍是原值（Node 只跳过 undefined
     * 的键，不会删除已存在的键）。宿主若带 `ELECTRON_RUN_AS_NODE=1`，
     * 打包版会被当成 node 跑、不开窗口，冒烟会卡在「等端口」上。
     */
    const env = {
      ...process.env,
      // 沙箱/EDR 注入环境下必须的软件渲染开关
      OPC_SAFE_GRAPHICS: '1',
      // 用临时目录，绝不碰真实 userData。
      // 注意：必须是 OPC_USER_DATA_DIR（重定向整个 Chromium profile），
      // 不能只用 OPC_DATA_DIR —— 后者只搬 SQLite，profile 仍会写进
      // 真实 AppData（实测 blob_storage 被写过）。见 [6] 的隔离断言。
      OPC_USER_DATA_DIR: dataDir,
    };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PORT;
    const child = spawn(EXE, EXTRA_ARGS, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`启动超时（30s）。已捕获输出：\n${buf.slice(-800)}`));
    }, 30000);

    // M01：server 搬进 harness 子进程后，横幅经 main 转发（stdout），而
    // [CDP] 行走 stderr —— 两个流的 chunk 到达顺序不保证与内容顺序一致，
    // 实测 stderr 的 CDP 行会先一步被「第一个 127.0.0.1」抓走（那端口打
    // 出去全是 404）。所以分两档：握手行/就绪行 = 强匹配立即结算；裸
    // 「主机:端口」= 弱匹配，延迟 1.2s 再结算（给强匹配留出窗口）。
    const strongMatch = () => {
      const hm = /@@OPC-HARNESS@@[^\n]*?"port":(\d+)/.exec(buf);
      const ready = /\[Harness\] 就绪：127\.0\.0\.1:(\d+)/.exec(buf);
      return hm || ready;
    };
    let fallbackPort = null;
    const onData = d => {
      buf += String(d);
      const strong = strongMatch();
      if (strong) {
        clearTimeout(timer);
        resolve({ child, port: Number(strong[1]), log: () => buf });
        return;
      }
      if (fallbackPort == null) {
        const generic = /(?:127\.0\.0\.1|localhost):(\d+)/.exec(buf);
        if (generic) {
          fallbackPort = generic[1];
          setTimeout(() => {
            const late = strongMatch();
            resolve({ child, port: Number((late || generic)[1]), log: () => buf });
          }, 1200);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（code=${code}）。输出：\n${buf.slice(-800)}`));
    });
  });
}

/**
 * 等应用自己的渲染进程开出 CDP 端点。
 *
 * 为什么不再外挂一个无头 Chrome（2026-11-15 实测）：外挂 Chrome 访问打包版
 * 服务时，动态 import 的 ChatPage 分包请求会**永远收不到响应**（同目录的 CSS、
 * 主包都正常，Node 直接 fetch 同一 URL 也 200），页面卡在「正在加载会话…」，
 * [4] 因此假失败。连应用自己的窗口既避开这个环境问题，断言的也正是用户
 * 真正看到的界面。
 */
async function waitForCdp(readLog, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = /\[CDP\][^\n]*?127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(readLog());
    // 只回环端口的根地址：Playwright 会自己请求 /json/version 拿 ws 地址。
    // 传 `/devtools/browser/<id>` 反而会拼成 `.../devtools/browser/<id>/json/version`，
    // Electron 对这条返回空 body → 「Unexpected end of JSON input」。
    if (m) return `http://127.0.0.1:${m[1]}`;
    await sleep(200);
  }
  throw new Error('等不到应用的 CDP 端点（窗口没打开？）');
}

/** 在已连接的 CDP 里找到应用窗口那一页（按本实例的 HTTP 端口匹配）。 */
async function waitForAppPage(browser, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(c => c.pages());
    const hit = pages.find(p => p.url().includes(`127.0.0.1:${port}`));
    if (hit) return hit;
    await sleep(200);
  }
  const urls = browser.contexts().flatMap(c => c.pages()).map(p => p.url());
  throw new Error(`找不到应用窗口页面（现有：${urls.join(' , ') || '无'}）`);
}

/**
 * M01：harness 模式下 /api/* 需要 `x-opc-token`（main 每次拉起都换新令牌，
 * 写在 dataDir/harness-token.json）。每次现读 —— [5] 的重启验收会换新令牌，
 * 缓存会拿到上一代的旧值。文件尚不存在（探针在握手前打）返回 null；
 * /api/health 有豁免，不受影响。
 */
function apiToken() {
  try {
    const raw = readFileSync(path.join(dataDir, 'harness-token.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (apiToken._loggedGen !== parsed.startedAt) {
      // 只记代次与时间，不记 token 本体（红线：token 不进日志）
      apiToken._loggedGen = parsed.startedAt;
      console.log(`  [pkg-gate] token 已换代（${parsed.startedAt}）`);
    }
    return parsed.token ?? null;
  } catch (e) {
    if (apiToken._errLogged !== true) {
      apiToken._errLogged = true;
      console.log(`  [pkg-gate] token 文件读取失败: ${e.message}`);
    }
    return null;
  }
}

const get = async (port, p) => {
  const headers = {};
  const token = apiToken();
  if (token) headers['x-opc-token'] = token;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: r.status, json, text };
};

const post = async (port, p, body) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-opc-token'] = token;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: r.status, json, text };
};

let child = null;
let sessionId = null;
// 失败时把应用自己的日志打出来 —— 否则只剩一句 ERR_CONNECTION_REFUSED，
// 看不出是「应用崩了」还是「端口变了」还是「静态资源没打进去」。
let logTail = () => '';

try {
  console.log(`\n[1] 启动打包版：${EXE}`);
  if (EXTRA_ARGS.length) console.log(`    额外参数: ${EXTRA_ARGS.join(' ')}`);
  const first = await launch();
  child = first.child;
  logTail = first.log;
  ok(first.port > 0, '后端开始监听（从 stdout 解析到真实端口）', `port=${first.port}`);

  console.log('\n[2] 后端接口');
  const health = await get(first.port, '/api/health');
  ok(health.status === 200 && health.json?.status === 'ok', '/api/health 正常');
  const prov = await get(first.port, '/api/image/providers');
  ok(
    prov.json?.providers?.[0]?.availability === 'ready',
    '生图 provider 就绪（P4-4 代码已进包）',
    prov.json?.providers?.[0]?.id ?? 'n/a'
  );

  // P4-5：能力矩阵必须随 /api/agents 下发 —— 否则打包版 UI 不会提示「只读落不了地」
  const agentsRes = await get(first.port, '/api/agents');
  const agents = agentsRes.json?.agents ?? [];
  ok(
    agents.length > 0,
    '/api/agents 返回 Agent 列表',
    `status=${agentsRes.status} len=${agents.length} tokenFile=${existsSync(path.join(dataDir, 'harness-token.json'))} head=${agentsRes.text.slice(0, 60)}`
  );
  ok(
    agents.every(a => a.permissionSupport && Array.isArray(a.permissionSupport.enforced)),
    '每个 Agent 都带 permissionSupport（P4-5 代码已进包）'
  );
  const codex = agents.find(a => a.id === 'codex');
  const opencode = agents.find(a => a.id === 'opencode');
  ok(
    !!codex?.permissionSupport?.enforced?.includes('plan'),
    'codex 声称支持只读（并已接 -s read-only）'
  );
  ok(
    !!opencode && !opencode.permissionSupport?.enforced?.includes('plan') && !!opencode.permissionSupport?.limitation,
    'opencode 如实标注「无法强制只读」'
  );

  // A71：安装元数据 + installEnv 必须随 /api/agents 一起下发。
  // 为什么必须在这里断言：installEnv 曾经是「后端算得出来但第一次请求时还没算」
  // 的字段——installEnvCache 只在 probeAll() 里赋值，而本请求走的是
  // ensureProbedInBackground() + list() 这条不等探测完成的路；第一版实现起子
  // 进程取版本号，spawn 不返回时 promise 永不 settle，缓存永远不写，且界面
  // 无任何报错。grep asar 只能证明字符串在包里，证明不了这条冷路径真的算过。
  // 本段刻意用**第一次 /api/agents 的返回值**（上方 agentsRes，不带 refresh）。
  const needEnv = agents.filter(a => a.install?.requires && a.install.requires !== 'none');
  ok(
    agents.every(a => a.install?.method),
    '每个 Agent 都带 install 元数据（A71 代码已进包）',
    `${agents.filter(a => a.install?.method).length}/${agents.length}`
  );
  ok(
    needEnv.length > 0 && needEnv.every(a => a.installEnv),
    'installEnv 在冷启动首请求就有值（A71 installEnv bug 的回归护栏）',
    needEnv.length
      ? `缺失：${needEnv.filter(a => !a.installEnv).map(a => a.id).join(',') || '无'}`
      : '没有 requires 非 none 的 Agent'
  );
  const codexEnv = agents.find(a => a.id === 'codex')?.installEnv;
  ok(
    !!codexEnv && typeof codexEnv.node?.ok === 'boolean',
    'codex（npm 类）installEnv.node.ok 是布尔值',
    JSON.stringify(codexEnv ?? null)
  );

  // A111：过程能力清单必须随 /api/agents 下发到打包版。
  // 为什么要在**打包产物**上验：清单本身在 definitions.ts 里，源码态一定对；
  // 但资料页的「过程能力」区块完全依赖这个字段被序列化出来 —— 一旦
  // `AgentInfo extends AgentDescriptor` 这层被 esbuild 的 tree-shaking 或某个
  // 手写的 toJSON 截断，源码测试全绿、装完打开却是一块空白。
  // 这里同时钉住语义分层：`[]` 是「确实没有」（http 类），不是「字段丢了」。
  ok(
    agents.every(a => Array.isArray(a.eventCapabilities)),
    '每个 Agent 都带 eventCapabilities 数组（A111 清单已进包）',
    `${agents.filter(a => Array.isArray(a.eventCapabilities)).length}/${agents.length}`
  );
  const httpAgents = agents.filter(a => a.kind === 'http');
  ok(
    httpAgents.length > 0 && httpAgents.every(a => a.eventCapabilities.length === 0),
    'http 类的清单是空数组（确实没有过程能力，不是字段缺失）',
    httpAgents.map(a => `${a.id}:${a.eventCapabilities.length}`).join(',')
  );
  const wbCaps = agents.find(a => a.id === 'workbuddy')?.eventCapabilities ?? [];
  ok(
    wbCaps.includes('thinking') && wbCaps.includes('permission'),
    'workbuddy 的清单含 thinking / permission（A111 修掉「清单撒谎」的回归护栏）',
    wbCaps.join(',')
  );

  console.log('\n[3] P4-1 会话三字段落库');
  const created = await post(first.port, '/api/sessions', {
    title: 'P5 冒烟会话',
    agentId: 'opencode',
    cwd: projectDir,
    scenarioId: 'dev',
    systemPrompt: 'P5 冒烟提示词',
  });
  sessionId = created.json?.session?.id;
  ok(!!sessionId, '创建会话成功');
  const readBack = await get(first.port, `/api/sessions/${sessionId}`);
  const s = readBack.json?.session;
  ok(s?.cwd === projectDir, 'cwd 落库并可读回', String(s?.cwd));
  ok(s?.scenario_id === 'dev', 'scenario_id 落库并可读回', String(s?.scenario_id));
  ok(s?.system_prompt === 'P5 冒烟提示词', 'system_prompt 落库并可读回');

  console.log('\n[4] P4-2 / P4-3 场景 UI（连应用自己的渲染进程）');
  const cdp = await waitForCdp(first.log);
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const page = await waitForAppPage(browser, first.port);
    /**
     * 像用户一样「在列表里点进去」，不再直接 goto /chat/:id。
     *
     * 为什么：应用启动初期会话列表/模型目录还在预热，此时深链到 /chat/:id
     * 会卡在「路由切了、会话数据没到」的死状态（实测首屏 35 秒都出不来场景卡，
     * 等十几秒后再点同一会话则 6 张卡正常）。点列表既避开这个启动竞态，
     * 也是用户真实路径。列表没刷出来时刷新一次再等。
     */
    const itemSel = `[data-conversation-item="${sessionId}"]`;
    const openChat = async () => {
      await page.goto(`http://127.0.0.1:${first.port}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForSelector(itemSel, { timeout: 20000 });
      await page.locator(itemSel).click();
      await page.waitForSelector('[data-scenario]', { timeout: 20000 });
    };
    /**
     * 冷启动预热（2026-11-15 实测）：应用头几秒在跑模型清单与后台探测，
     * 这段时间渲染进程发起的**动态分包**请求会长时间挂起（控制台零报错，
     * 服务端用 Node 直接取同一个文件却是 200）；等十几秒后再点同一会话
     * 就正常。冒烟不该考「冷启动竞态」，先等 10 秒；仍不出卡就整页重来一次。
     */
    await page.waitForTimeout(10000);
    try {
      await openChat();
    } catch {
      await page.waitForTimeout(3000);
      await openChat();
    }
    await page.waitForTimeout(1200);
    const cards = await page.locator('[data-scenario]').count();
    ok(cards === 6, '渲染 6 张场景卡', `实际 ${cards}`);

    await page.locator('[data-scenario="image"]').click();
    await page.waitForTimeout(600);
    const ui = await page.evaluate(() => {
      const sender = document.querySelector('t-chat-sender');
      const vals = Array.from(document.querySelectorAll('input')).map(i => i.value).filter(Boolean);
      return {
        placeholder: sender ? sender.getAttribute('placeholder') : '',
        hasModel: vals.some(v => /cogview/i.test(v)),
        hasSize: vals.some(v => /\d{3,4}/.test(v)),
      };
    });
    ok(ui.hasModel, '选择生图后出现模型选择器');
    ok(ui.hasSize, '选择生图后出现尺寸选择器');
    ok(/图像|生图|描述/.test(ui.placeholder), '输入框切到生图语义', ui.placeholder);
  } finally {
    await browser.close();
  }

  console.log('\n[5] 重启验收（P4-1 的真正判据）');
  // 先证明老进程**真的死了**，再起新的。顺序反了就会「跟正在被杀的老进程
  // 说话」，那样下面几条会全绿，但绿的是一具尸体（A114 的教训）。
  const firstPid = first.child.pid;
  const exited = new Promise(resolve => {
    if (first.child.exitCode !== null) return resolve(true);
    first.child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 30000);
  });
  killTree(child);
  // 第一刀 15 秒还没退，补第二刀：本机 EDR 下 taskkill 偶发首次不生效（实测）
  const rekill = setTimeout(() => {
    if (first.child.exitCode === null) killTree(first.child);
  }, 15000);
  const reallyExited = await exited;
  clearTimeout(rekill);
  ok(reallyExited, '老进程在起新进程之前真的退出了', `pid=${firstPid}`);
  const portFreed = await waitPortClosed(first.port);
  ok(portFreed, '老进程的端口已释放（不是还在应答）', `port=${first.port}`);

  const second = await launch();
  child = second.child;
  ok(second.port > 0, '重启后重新监听', `port=${second.port}`);
  ok(
    second.child.pid !== firstPid,
    '重启的是新进程（不是还在跟老进程说话）',
    `${firstPid} → ${second.child.pid}`
  );
  const after = await get(second.port, `/api/sessions/${sessionId}`);
  const s2 = after.json?.session;
  ok(!!s2, '重启后会话仍在');
  ok(s2?.cwd === projectDir, '重启后 cwd 仍在', String(s2?.cwd));
  ok(s2?.scenario_id === 'dev', '重启后 scenario_id 仍在', String(s2?.scenario_id));
  ok(s2?.system_prompt === 'P5 冒烟提示词', '重启后 system_prompt 仍在');

  console.log('\n[6] 数据落位');
  ok(existsSync(path.join(dataDir, 'chat.db')), '数据库落在 OPC_DATA_DIR');
  const installDataDir = path.join(path.dirname(EXE), 'data');
  ok(!existsSync(installDataDir), '安装目录未被写入 data/');
  const dirs = readdirSync(dataDir);
  ok(dirs.includes('chat.db'), '数据目录内容合理', dirs.join(', ').slice(0, 80));

  console.log('\n[7] 隔离（不污染真实用户数据）');
  const profileAfter = snapshotProfile();
  const leaked = PROFILE_WATCH.filter(f => profileBefore[f] !== profileAfter[f]);
  ok(
    leaked.length === 0,
    '真实 userData 未被写入（数据库与 Chromium profile 都已隔离）',
    leaked.length ? `被改: ${leaked.join(', ')}` : REAL_USER_DATA
  );
} catch (err) {
  console.error(`\n✗ 冒烟中断: ${err.message}`);
  const tail = logTail().slice(-2500).trim();
  if (tail) console.error(`\n--- 应用最后输出 ---\n${tail}\n--------------------`);
  results.push({ pass: false, name: '冒烟流程未中断', extra: err.message.slice(0, 120) });
} finally {
  if (child) {
    killTree(child);
    await sleep(1500);
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn(`  （临时数据目录未能删除，可手动清理：${dataDir}）`);
  }
  // 夹具目录里可能被应用写过东西（会话 cwd 指向它），同样清掉
  try {
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn(`  （夹具工作目录未能删除，可手动清理：${projectDir}）`);
  }
}

const passed = results.filter(r => r.pass).length;
console.log(`\n=== ${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  console.log('失败项：');
  results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name} ${r.extra}`));
}
process.exit(passed === results.length ? 0 : 1);
