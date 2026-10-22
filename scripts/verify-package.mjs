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
 *   [4] P4-2 / P4-3：真浏览器打开打包版自己的服务，6 张场景卡可见、选生图后输入区切换
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

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
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

const EXE = process.argv[2] || newestPackagedExe() || path.join('release-p5d', 'win-unpacked', 'OPC Agent.exe');

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
const CHROME = process.env.OPC_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const results = [];
const ok = (cond, name, extra = '') => {
  results.push({ pass: !!cond, name, extra });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(EXE)) {
  console.error(`✗ 找不到可执行文件: ${EXE}\n  先跑 npm run electron:build，或显式传入路径。`);
  process.exit(2);
}
console.log(`测试对象: ${EXE}（${new Date(statSync(EXE).mtimeMs).toLocaleString()}）`);

const dataDir = mkdtempSync(path.join(tmpdir(), 'opc-pkg-smoke-'));

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

    const onData = d => {
      buf += String(d);
      // 端口从启动横幅里取。横幅地址随 HOST 变（现在绑 127.0.0.1，
      // 早先是 0.0.0.0），所以匹配「主机:端口」而不是写死 localhost。
      const m = /(?:127\.0\.0\.1|localhost):(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), log: () => buf });
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

const get = async (port, p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
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
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  ok(agents.length > 0, '/api/agents 返回 Agent 列表', `${agents.length} 个`);
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

  console.log('\n[3] P4-1 会话三字段落库');
  const created = await post(first.port, '/api/sessions', {
    title: 'P5 冒烟会话',
    agentId: 'opencode',
    cwd: 'D:/work/demo',
    scenarioId: 'dev',
    systemPrompt: 'P5 冒烟提示词',
  });
  sessionId = created.json?.session?.id;
  ok(!!sessionId, '创建会话成功');
  const readBack = await get(first.port, `/api/sessions/${sessionId}`);
  const s = readBack.json?.session;
  ok(s?.cwd === 'D:/work/demo', 'cwd 落库并可读回', String(s?.cwd));
  ok(s?.scenario_id === 'dev', 'scenario_id 落库并可读回', String(s?.scenario_id));
  ok(s?.system_prompt === 'P5 冒烟提示词', 'system_prompt 落库并可读回');

  console.log('\n[4] P4-2 / P4-3 场景 UI（真浏览器打打包版自己的服务）');
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-proxy-server', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // 不用 networkidle：这个应用一开会话就挂着 SSE，A36 起还有 5s 一次的后台任务轮询，
    // 「500ms 内没有任何网络连接」这条判据在机器忙时会一直等不到 —— 实测偶发 30s 超时，
    // 单独重跑又 24/24 全过（假失败）。改成等真正要断言的东西出现，强度一样。
    await page.goto(`http://127.0.0.1:${first.port}/chat/${sessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForSelector('[data-scenario]', { timeout: 30000 });
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
  child.kill();
  await sleep(2500);
  const second = await launch();
  child = second.child;
  ok(second.port > 0, '重启后重新监听', `port=${second.port}`);
  const after = await get(second.port, `/api/sessions/${sessionId}`);
  const s2 = after.json?.session;
  ok(!!s2, '重启后会话仍在');
  ok(s2?.cwd === 'D:/work/demo', '重启后 cwd 仍在', String(s2?.cwd));
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
  const tail = logTail().slice(-700).trim();
  if (tail) console.error(`\n--- 应用最后输出 ---\n${tail}\n--------------------`);
  results.push({ pass: false, name: '冒烟流程未中断', extra: err.message.slice(0, 120) });
} finally {
  if (child && !child.killed) {
    child.kill();
    await sleep(1500);
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn(`  （临时数据目录未能删除，可手动清理：${dataDir}）`);
  }
}

const passed = results.filter(r => r.pass).length;
console.log(`\n=== ${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  console.log('失败项：');
  results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name} ${r.extra}`));
}
process.exit(passed === results.length ? 0 : 1);
