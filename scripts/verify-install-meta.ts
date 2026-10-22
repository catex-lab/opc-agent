/**
 * 安装来源元数据验证（A71 / PLAN-AGENT-INSTALL.md）。
 *
 * 这个脚本守的是「**往用户机器上装东西的入口，不能有一句假话**」。
 *
 * 背景：新用户装完本应用，15 条里约 12 条是「未安装」—— 因为安装包里只有定义，
 * 没有任何 CLI（打包产物 `resources/` 只有 app.asar 与 elevate.exe，已实查）。
 * 于是「点一下去装」成了新用户的第一个动作，而这个动作有两种失败方式：
 *
 *   1. **给了错的命令** —— 用户复制粘贴，终端报 command not found；
 *   2. **给了假的按钮** —— 点下去是 404，或者干脆没有这一步。
 *
 * 两种都是"界面在骗人"，且用户很难判断是应用错了还是自己错了。所以这里断言
 * 的是**结构与来源**，不是文案：
 *
 *   [1] 15 条全部有 `install`，`method` 合法；
 *   [2] `method` 与 `kind` 相容（http/sdk 不可能需要装 CLI；cli 不可能"不用装"）；
 *   [3] npm 类：包名必填、命令必填、**命令里必须真的出现包名**、必须要求 Node；
 *   [4] script 类：命令必填且必须是"下载并执行"形态、必须要求 PowerShell；
 *   [5] installer 类：**不许有 command**（有命令就不该叫安装器）；
 *   [6] key 类：不许有 command / url（它不是安装问题，给下载按钮就是把用户引错路）；
 *   [7] 所有 url：https + 主机在白名单 + 主机与"这家厂商该有的域名"对得上；
 *   [8] `checkedAt` 必填、是合法日期、不是未来、不超过 180 天；
 *   [9] 每条至少有 command / url / note 之一（否则这一条等于空着）；
 *   [10] `installHint` 与 `method` 不许互相矛盾（hint 说 npm 而 method 说安装器 → 红）；
 *   [11] 分布计数冻结（改一条要有人知道）。
 *
 * 全离线、不联网、不碰数据库。
 * 运行：npx tsx scripts/verify-install-meta.ts
 */
import { AGENT_DEFS, INSTALL_HOSTS } from '../server/agents/definitions.js';
import type { AgentDescriptor, InstallMethod } from '../server/agents/types.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

const defs: AgentDescriptor[] = AGENT_DEFS.map(d => d.descriptor);
const byId = new Map(defs.map(d => [d.id, d]));
const METHODS: InstallMethod[] = ['npm', 'script', 'installer', 'key', 'unknown'];

/**
 * 每家厂商的官方域名白名单（与 INSTALL_HOSTS 交叉校验）。
 *
 * 为什么还要按条目再写一次：`INSTALL_HOSTS` 只保证"在允许清单里"，
 * 不保证"这条属于这家"。把 codex 的链接写成 cursor.com 也能过白名单，
 * 但那是把用户送去别家 —— 这类错误只有逐条对照才拦得住。
 */
const EXPECTED_HOST: Record<string, string> = {
  codex: 'github.com',
  gemini: 'github.com',
  pi: 'github.com',
  claude: 'github.com',
  opencode: 'opencode.ai',
  antigravity: 'antigravity.google',
  kimicli: 'code.kimi.com',
  cursor: 'cursor.com',
  qoder: 'qoder.com',
  trae: 'www.trae.com.cn',
};

// ============= [1] 字段齐全 + method 合法 =============
section('[1] 15 条都有 install，method 合法');
for (const d of defs) {
  ok(Boolean(d.install), `${d.id}: 缺 install 字段`);
  if (!d.install) continue;
  ok(
    METHODS.includes(d.install.method),
    `${d.id}: method 非法`,
    `实际 ${String(d.install.method)}`
  );
  const hasAny = Boolean(d.install.command || d.install.url || d.install.note);
  ok(hasAny, `${d.id}: command / url / note 全空（等于什么都没说）`);
}

// ============= [2] method 与 kind 相容 =============
section('[2] method 与 kind 相容');
for (const d of defs) {
  const m = d.install?.method;
  if (!m) continue;
  if (d.kind === 'http' || d.kind === 'sdk') {
    // 这两种形态由本应用直接发 HTTP / 内置 SDK，机器上不需要任何可执行文件
    eq(m, 'key', `${d.id}(kind=${d.kind}): 只能是「不用装，缺 Key」`);
  }
  if (d.kind === 'cli' || d.kind === 'acp') {
    ok(m !== 'key', `${d.id}(kind=${d.kind}): 本机要起进程，不能标成「不用装」`, `实际 ${m}`);
  }
  if (d.kind === 'acp') {
    // ACP 是"别人已经装好的进程"，我们没有可代跑的标准安装方式
    ok(m !== 'npm', `${d.id}(kind=acp): 不该是 npm 全局包`, `实际 ${m}`);
  }
}

// ============= [3] npm 类 =============
section('[3] npm 类：包名、命令、Node 前置');
for (const d of defs) {
  const i = d.install;
  if (i?.method !== 'npm') continue;
  ok(Boolean(i.pkg), `${d.id}: npm 类缺 pkg`);
  ok(Boolean(i.command), `${d.id}: npm 类缺 command`);
  if (i.pkg && i.command) {
    // 防漂移：改了包名忘了改命令，用户复制出来的是旧包（可能已废弃）
    ok(
      i.command.includes(i.pkg),
      `${d.id}: command 里没有出现 pkg（改包名时漏改命令）`,
      `pkg=${i.pkg} command=${i.command}`
    );
  }
  eq(i.requires, 'node', `${d.id}: npm 类必须声明 requires:'node'`);
  ok(!i.url || i.url.startsWith('https://'), `${d.id}: url 必须 https`, String(i.url));
}

// ============= [4] script 类 =============
section('[4] script 类：命令形态与 PowerShell 前置');
for (const d of defs) {
  const i = d.install;
  if (i?.method !== 'script') continue;
  ok(Boolean(i.command), `${d.id}: script 类缺 command`);
  // 只认这两种形态：PowerShell 的 irm|iex 与 curl|bash。
  // 出现别的形态说明有人手写了一条"看起来像命令"的东西，要人工看一眼。
  const shape = /^irm\s|^curl\s/.test(i.command ?? '');
  ok(shape, `${d.id}: command 不是「下载并执行」形态`, String(i.command));
  eq(i.requires, 'powershell', `${d.id}: script 类必须声明 requires:'powershell'`);
  ok(Boolean(i.url), `${d.id}: script 类必须给官方页（用户要能看到脚本出处）`);
}

// ============= [5] installer 类 =============
section('[5] installer 类：不该有命令');
for (const d of defs) {
  const i = d.install;
  if (i?.method !== 'installer') continue;
  ok(!i.command, `${d.id}: 标成安装器却有 command（那它就不是安装器）`, String(i.command));
  ok(Boolean(i.note), `${d.id}: 安装器没有官方页时必须写清为什么`, undefined);
}

// ============= [6] key 类 =============
section('[6] key 类：不是安装问题');
for (const d of defs) {
  const i = d.install;
  if (i?.method !== 'key') continue;
  ok(!i.command, `${d.id}: 不需要安装却给了命令`, String(i.command));
  ok(!i.url, `${d.id}: 不需要安装却给了下载页（会把用户引到错误的地方）`, String(i.url));
  eq(i.requires, 'none', `${d.id}: key 类不该有前置条件`);
}

// ============= [7] url 白名单 =============
section('[7] url：https + 白名单 + 归属正确');
const hosts = new Set<string>(INSTALL_HOSTS as readonly string[]);
for (const d of defs) {
  const url = d.install?.url;
  if (!url) continue;
  ok(url.startsWith('https://'), `${d.id}: url 不是 https`, url);
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    ok(false, `${d.id}: url 解析失败`, url);
    continue;
  }
  ok(hosts.has(host), `${d.id}: url 主机不在白名单`, host);
  const expected = EXPECTED_HOST[d.id];
  if (expected) eq(host, expected, `${d.id}: url 指向了别家域名`);
}

// ============= [8] checkedAt 时效 =============
section('[8] checkedAt：必填、合法、未过期');
const MAX_AGE_DAYS = 180;
const today = new Date();
for (const d of defs) {
  const at = d.install?.checkedAt;
  ok(Boolean(at), `${d.id}: 缺 checkedAt（链接烂了没人知道）`);
  if (!at) continue;
  const t = Date.parse(at);
  ok(Number.isFinite(t), `${d.id}: checkedAt 不是合法日期`, at);
  if (!Number.isFinite(t)) continue;
  ok(t <= today.getTime() + 86_400_000, `${d.id}: checkedAt 在未来`, at);
  const days = Math.floor((today.getTime() - t) / 86_400_000);
  ok(
    days <= MAX_AGE_DAYS,
    `${d.id}: checkedAt 已超过 ${MAX_AGE_DAYS} 天，请重新核实`,
    `${at}（${days} 天前）`
  );
  ok(Boolean(d.install?.checkedFrom), `${d.id}: 有 checkedAt 却没有 checkedFrom（没说怎么核的）`);
}

// ============= [9] installHint 与 method 不矛盾 =============
section('[9] installHint 与 method 不矛盾');
for (const d of defs) {
  const i = d.install;
  const hint = d.installHint ?? '';
  if (!i || !hint) continue;
  if (/npm\s+i\s+-g/i.test(hint)) {
    eq(i.method, 'npm', `${d.id}: hint 说 npm 安装，method 却不是 npm`);
  }
  if (/irm\s/i.test(hint)) {
    ok(
      i.method === 'script',
      `${d.id}: hint 里有 irm 安装脚本，method 却不是 script`,
      `实际 ${i.method}`
    );
  }
  // 反向：hint 提到登录的，note 里必须也提到 —— 否则拆字段时把登录步骤弄丢了
  if (/login|\/login|登录/i.test(hint)) {
    ok(
      /login|登录/i.test(i.note ?? ''),
      `${d.id}: hint 里有登录步骤，note 里没有（拆字段时弄丢了）`,
      `note=${i.note ?? '(空)'}`
    );
  }
}

// ============= [10] 分布计数冻结 =============
section('[10] 分布计数（改一条要有人知道）');
const count = (m: InstallMethod) => defs.filter(d => d.install?.method === m).length;
eq(count('npm'), 5, 'npm 类条数');
eq(count('script'), 4, 'script 类条数');
eq(count('installer'), 2, 'installer 类条数');
eq(count('key'), 3, 'key 类条数');
eq(count('unknown'), 2, 'unknown 类条数（含 qoder-cn：官方没有独立 CLI 安装入口）');
eq(defs.length, 16, 'Agent 总数（A76 加了 qoder-cn）');

// ============= 结果 =============
console.log('\n— 一览');
for (const d of defs) {
  const i = d.install;
  const btn =
    i?.method === 'npm'
      ? '复制命令 + npm 包页'
      : i?.method === 'script'
        ? '打开安装页 + 复制命令'
        : i?.method === 'installer'
          ? i?.url
            ? '打开下载页'
            : '（无按钮，只写说明）'
          : i?.method === 'key'
            ? '填写 API Key'
            : '（无按钮，只写说明）';
  console.log(`  ${d.id.padEnd(12)} ${String(i?.method ?? '-').padEnd(10)} ${btn}`);
}

console.log('');
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败（共 ${checks.total} 项）：\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ ${checks.total}/${checks.total} 全部通过`);
