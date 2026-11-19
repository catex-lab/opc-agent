/**
 * A233：WorkBuddy 登录「浏览器无限弹」回归闸门。
 *
 * ## 真机故障（2026-11-19）
 *
 * 点「重新探测」或「去登录」后，浏览器授权完成、桌面端也已登录，但 OPC 仍
 * 反复弹浏览器登录，无法使用。根因有两条，同时存在才形成死循环：
 *
 *   1. CLI 的 `UrlUtils.openUrl()` 优先读 `process.env.BROWSER`（Windows 没设
 *      时退回 `rundll32 url,OpenURL`）。每次 `authenticate()` 它都自己开浏览器，
 *      而探测每轮都调一次 —— 用户没点任何东西也会被反复弹；
 *   2. 前端 `useAgentLogin` 在资料页/错误卡挂载时就 `POST /login/start`，
 *      每挂载一次起一条新流；每条流都会生成新 state 并顶掉上一条。
 *
 * 现行契约：
 *   - 登录/探测子进程一律注入 `BROWSER=__opc_no_browser__`（必然解析失败），
 *     CLI 不再自己开浏览器；
 *   - 普通会话的 `runtime.env` 不许带上这个变量（避免污染业务子进程）；
 *   - 前端只有**用户点击**才起流；链接异步到达时补开一次，且只开一次。
 *
 * 本闸门同时做反向探针，证明断言不是恒绿。
 *
 * 运行：npx tsx scripts/verify-a233-workbuddy-login-loop.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSdkRuntime, sdkAuthChildFor } from '../server/agents/sdkRuntime.js';

const root = path.resolve(import.meta.dirname, '..');
const agentLogin = fs.readFileSync(path.join(root, 'src/agentLogin.ts'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(root, 'server/agents/sdkRuntime.ts'), 'utf8');
const chatMessages = fs.readFileSync(path.join(root, 'src/components/ChatMessages.tsx'), 'utf8');

const failures: string[] = [];
let total = 0;

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

/** 纯静态契约；反向探针直接喂改动后的源码字符串 */
function staticContract(src: { agentLogin: string; runtimeSrc: string }): Record<string, boolean> {
  return {
    // 登录子进程必须带 BROWSER 哨兵，普通 runtime 不许带
    browserSentinel:
      src.runtimeSrc.includes("BROWSER: '__opc_no_browser__'") &&
      !/env\.BROWSER\s*=/.test(src.runtimeSrc),
    // 前端不再有「挂载即启动」的 startedRef 形状
    noAutoStart:
      !src.agentLogin.includes('startedRef') &&
      !/if \(!agentId \|\| !fallbackUrl\) return/.test(src.agentLogin),
    // 点击后才起流，并允许异步补开一次
    clickDriven:
      src.agentLogin.includes('pendingOpenRef') &&
      /pendingOpenRef\.current = true;/.test(src.agentLogin) &&
      /const bridge = \(window as unknown as \{/.test(src.agentLogin) &&
      /window\.open\(url, '_blank', 'noopener'\)/.test(src.agentLogin),
  };
}

// ── 1. 运行时：BROWSER 只出现在登录子进程 ──────────────────────────
{
  const base = resolveSdkRuntime();
  ok(Object.keys(base.env).length === 0, '普通 runtime（无定义）env 必须为空，不塞 BROWSER');

  const wb = resolveSdkRuntime({
    environment: 'internal',
    configDir: '~/.workbuddy-ai',
    settingSources: ['user'],
  });
  ok(!('BROWSER' in wb.env), '普通 runtime（WorkBuddy 定义）也不许带 BROWSER，只有 auth 子进程带');

  const auth = sdkAuthChildFor(wb);
  ok(auth.env.BROWSER === '__opc_no_browser__', '登录子进程必须注入 BROWSER 哨兵', String(auth.env.BROWSER));
  ok(auth.env.ELECTRON_RUN_AS_NODE === '1', 'A231 的 shim 开关必须保留');
  ok(auth.env.CODEBUDDY_CONFIG_DIR === wb.env.CODEBUDDY_CONFIG_DIR, '原有 env 项不能被哨兵覆盖丢失');

  // A234：WorkBuddy 必须用独立家目录（凭据与桌面端隔离），其它产品不许改
  ok(
    typeof wb.env.USERPROFILE === 'string' &&
      wb.env.USERPROFILE.endsWith(path.join('.workbuddy-ai', 'opc-profile')),
    'A234：WorkBuddy runtime 必须把 USERPROFILE 指到隔离家目录',
    String(wb.env.USERPROFILE)
  );
  ok(wb.env.HOME === os.homedir(), 'A234：HOME 必须指回真实家目录，保证 git 等工具仍可用');
  const nonWb = resolveSdkRuntime({ environment: 'internal', configDir: '~/.codebuddy' });
  ok(!('USERPROFILE' in nonWb.env), 'A234：非 WorkBuddy 产品不许注入隔离 USERPROFILE');
}

// ── 2. 前端源码契约 ────────────────────────────────────────────────
{
  const c = staticContract({ agentLogin, runtimeSrc });
  ok(c.browserSentinel, 'sdkRuntime 必须注入 BROWSER 哨兵且不改写 process.env');
  ok(c.noAutoStart, 'agentLogin 不得再保留挂载即启动的 startedRef 形状');
  ok(c.clickDriven, 'agentLogin 必须是点击驱动 + pendingOpen 异步补开');
  ok(
    chatMessages.includes('useAgentLogin('),
    '聊天错误卡仍通过同一个 hook 接入登录流'
  );
}

// ── 3. 反向探针：把实现逐个退回坏版本，必须变红 ────────────────────
{
  const probes: Array<[string, { agentLogin: string; runtimeSrc: string }, string]> = [
    [
      '去掉 BROWSER 哨兵',
      { agentLogin, runtimeSrc: runtimeSrc.replace("BROWSER: '__opc_no_browser__',", '') },
      'browserSentinel',
    ],
    [
      '恢复挂载即启动',
      { agentLogin: agentLogin.replace('const pendingOpenRef = useRef(false);', 'const startedRef = useRef(false);\n  const pendingOpenRef = useRef(false);'), runtimeSrc },
      'noAutoStart',
    ],
    [
      '去掉异步补开',
      { agentLogin: agentLogin.replace(/pendingOpenRef\.current = true;/g, 'void 0;'), runtimeSrc },
      'clickDriven',
    ],
  ];
  for (const [label, src, key] of probes) {
    const result = staticContract(src);
    ok(result[key] === false, `★ 反向探针：${label} → 必须让 ${key} 变红`);
  }
}

console.log(`A233 结果：通过 ${total - failures.length}，失败 ${failures.length}`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 登录子进程不再自开浏览器；前端只在点击后起流并补开一次');
