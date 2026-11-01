/**
 * A166 验证：扩展的归一化（P1）与 MCP 分发（P2）。
 *
 * ## 这一层守的是什么
 *
 * P1 —— **归一化绝不自动应用**，且**不许误伤普通英语**：
 *   本机 57~65 个 SKILL.md 里 `Read` 只出现 6 次、全是 `Read-only state` /
 *   `Read the Room` 这类普通英语，反引号包裹与「X 工具」形态 **各 0 次**。
 *   所以规则必须**只认明确形态**，把 `Read-only` 改成 `读取-only` 就是破坏正文。
 *   真问题是**185 处写死的家目录路径**（`~/.claude/skills/...` 121 + 其它 64），
 *   那才是「为什么必须存 15 份副本」的根因。
 *
 * P2 —— 分发给 qoder 的 MCP 配置必须**是原值**（库里的 `config_json` 是脱敏的，
 *   拿 `***` 当 API Key 服务起不来），且**零写入用户目录**。
 *
 * ## 断言分三层
 *   [1] 源码接线
 *   [2] 接口层（预览 / 逐条接受 / 回滚 / 边界 / 分发产物）
 *   [3] UI 层（勾选 → 接受 → 正文真变了 → 回滚）
 *
 * 运行：node scripts/verify-a166-normalize.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a166-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// ══════════════ [1] 源码接线 ══════════════
console.log('\n[1] 源码接线');
{
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8');
  const norm = fs.readFileSync(path.join(ROOT, 'server', 'extensions', 'normalize.ts'), 'utf8');
  const dist = fs.readFileSync(path.join(ROOT, 'server', 'extensions', 'distribute.ts'), 'utf8');
  const defs = fs.readFileSync(path.join(ROOT, 'server', 'agents', 'definitions.ts'), 'utf8');

  ok(/normalizeSkillBody/.test(norm), '归一化模块存在');
  ok(/\/api\/extensions\/:kind\/:name\/normalize/.test(idx), '预览/应用路由注册');
  ok(/revert-normalize/.test(idx), '回滚路由注册');
  ok(/body_original/.test(fs.readFileSync(path.join(ROOT, 'server', 'db.ts'), 'utf8')), 'body_original 列已迁移');

  /* 保守规则的**源码级**判据：工具名正则必须是「反引号包裹」或「后跟工具」，
     不许出现「单独一个单词就替换」的写法。 */
  ok(/TOOL_QUOTED_RE/.test(norm) && /TOOL_WORD_RE/.test(norm), '工具名只认两种明确形态');
  ok(!/\\b\(Read\|Write/.test(norm.replace(/TOOL_QUOTED_RE[\s\S]{0,200}/g, '')), '没有裸单词替换的兜底分支');

  /* P2：qoder 与 qoder-cn 分开生成，且**不加** --strict-mcp-config */
  ok(/makeQoderCliArgs\('qoder'\)/.test(defs), 'qoder 用按 agentId 生成参数');
  ok(/makeQoderCliArgs\('qoder-cn'\)/.test(defs), 'qoder-cn 用同一工厂但各自 id');
  ok(/mcpArgsFor\(agentId\)/.test(defs), 'buildArgs 里真的拼了 MCP 参数');
  ok(/'--mcp-config'/.test(dist), '参数是 --mcp-config');
  ok(!/--strict-mcp-config/.test(dist.split('export function mcpArgsFor')[1] ?? ''), '没加 --strict-mcp-config（不剥夺用户未导入的配置）');
  ok(/scanAllMcp/.test(dist), '分发回读源文件拿原值（不用库里脱敏后的 config_json）');
}

// ══════════════ 假环境 ══════════════
/* 正文里三种形态各一条，用来同时钉「该改的改了」和「不该改的没动」：
   ① 家目录绝对路径（该改成占位符）
   ② 反引号 + 「工具」（该改成通用称谓 `读取工具`）
   ③ `Read-only` 与表格列名 `Task`（**普通英语，必须原样保留**） */
const ALPHA_BODY = [
  '# alpha',
  '',
  'Run `python3 ~/.claude/skills/alpha/scripts/run.py` to start.',
  '',
  '用 `Read` 工具读取文件。',
  '',
  'Read-only state should stay unchanged.',
  '',
  '| Task | Sub-skill |',
  '',
].join('\n');

function writeSkill(rel, name, body) {
  const dir = path.join(FAKE_HOME, rel, name);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: ${name} 的测试技能\n---\n\n${body}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return text;
}

writeSkill('.claude/skills', 'alpha', ALPHA_BODY);

/* MCP 夹具：
   - qoder 自己已有 `own_server`（分发时必须排除，避免重复加载）
   - codex 的 config.toml 提供两条：`shared_ok`（该共享）+ `disabled_one`（enabled=false，该跳过）
   数组形态（`args = [...]`）是**必须能解析**的：实测本机 node_repl 的 args 被当成字符串
   就起不来（P2 修的就是这个）。 */
const qoderDir = path.join(FAKE_HOME, '.qoder');
fs.mkdirSync(qoderDir, { recursive: true });
const QODER_MCP_FILE = path.join(qoderDir, 'mcp.json');
fs.writeFileSync(
  QODER_MCP_FILE,
  JSON.stringify(
    { mcpServers: { own_server: { command: 'node', args: ['own.js'] } } },
    null,
    2
  )
);
const qoderMtimeBefore = fs.statSync(QODER_MCP_FILE).mtimeMs;

/* 夹具用的假密钥：形态必须命中 `safety.ts` 的 `sk-` 规则（≥16 位），
   但值是编的，不会误伤任何真实凭证扫描。 */
const FIXTURE_API_KEY = 'sk-fakefixture0000000000000000'; // secret-scan:ignore —— 编的假密钥，只为触发脱敏规则

const codexDir = path.join(FAKE_HOME, '.codex');
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(
  path.join(codexDir, 'config.toml'),
  [
    '[mcp_servers.shared_ok]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-filesystem", "."]',
    'startup_timeout_sec = 30',
    '',
    '[mcp_servers.shared_ok.env]',
    'FS_ROOT = "/tmp"',
    /* 这个值**必须**能被 `scanSensitive` 命中（`sk-` + 16 位以上），否则
       `[5] 值不是脱敏的` 会变成假绿 —— 2026-11-01 反向探针实测：把分发改成
       读库里脱敏后的 config_json，`FS_ROOT = "/tmp"` 本就不敏感、库里存的就是
       原值，于是「没有 ***」恒真。只有放一个真会变 `***` 的值，这条才有判别力。 */
    `API_KEY = "${FIXTURE_API_KEY}"`,
    '',
    '[mcp_servers.disabled_one]',
    'command = "node"',
    'enabled = false',
    '',
  ].join('\n')
);

// ══════════════ 起服务 ══════════════
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT,
  shell: true,
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(port),
    OPC_DATA_DIR: DATA,
    OPC_EXT_HOME: FAKE_HOME,
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', d => (serverLog += String(d)));
child.stderr.on('data', d => (serverLog += String(d)));
{
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  ok(ready, '[1] 服务端起来了');
  if (!ready) {
    console.log(serverLog.slice(-1500));
    killTree(child);
    console.log(`\nA166 结果：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
}

let browser;
try {
  // ══════════════ [2] 接口层：归一化 ══════════════
  console.log('\n[2] 接口层：归一化');
  await fetch(`${base}/api/extensions/import`, { method: 'POST' });

  const detail = async () =>
    (await json(await fetch(`${base}/api/extensions/skill/alpha`))).item;

  const before = await detail();
  ok(typeof before.body === 'string' && before.body.includes('~/.claude/skills/alpha/'),
    '[2] 夹具正文里确实有家目录绝对路径');

  const prev = await json(await fetch(`${base}/api/extensions/skill/alpha/normalize`));
  ok(prev.changed === true, '[2] 预览说「有可归一化的内容」');
  ok(prev.summary?.['home-path'] === 1, '[2] 家目录路径命中 1 处', String(prev.summary?.['home-path']));
  ok(prev.summary?.['tool-name'] === 1, '[2] 工具名命中 1 处（只认 `Read` 工具）', String(prev.summary?.['tool-name']));
  ok((prev.hits ?? []).length === 2, '[2] 总共 2 条', String((prev.hits ?? []).length));

  /* **最重要的一条**：普通英语不许被改。
     这条同时是否定式与肯定式 —— 「Read-only 还在」+「读取-only 不存在」。 */
  ok(String(prev.preview).includes('Read-only state'), '[2] 普通英语 Read-only 原样保留');
  /* 反向探针（2026-11-01）发现的**过窄**：原来只钉 `读取-only`，把坏版本改成
     `读取工具-only` 就绕过去了。改成钉「`-only` 前面不许出现任何替换产物」。 */
  ok(!/读取[^\n]{0,6}-only/.test(String(prev.preview)), '[2] 没有把 Read-only 改成「读取…-only」');
  ok(String(prev.preview).includes('| Task | Sub-skill |'), '[2] 表格列名 Task 原样保留');
  ok(String(prev.preview).includes('{{SKILL_DIR}}/scripts/run.py'), '[2] 自己的目录 → {{SKILL_DIR}}');

  const stillOld = await detail();
  ok(stillOld.body === before.body, '[2] 预览**不落库**（正文一个字没变）');
  ok(stillOld.bodyOriginal === null, '[2] 预览不写 body_original');

  // ── 逐条接受：只接受第 0 条（路径那条）──
  console.log('\n[3] 逐条接受与回滚');
  const one = await json(
    await fetch(`${base}/api/extensions/skill/alpha/normalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: [0] }),
    })
  );
  ok(one.ok === true && one.applied === 1, '[3] 只接受 1 条', String(one.applied));
  const afterOne = await detail();
  ok(afterOne.body.includes('{{SKILL_DIR}}'), '[3] 正文里出现占位符');
  ok(afterOne.body.includes('`Read` 工具'), '[3] 未勾选的那条**没被动**（仍是 `Read` 工具）');
  ok(afterOne.bodyOriginal === before.body, '[3] body_original 存的是原文');
  ok(afterOne.locallyModified === true, '[3] 标记为本地改过（重新导入不覆盖）');

  // ── 再全部接受：原文不许被覆盖（COALESCE）──
  const all = await json(
    await fetch(`${base}/api/extensions/skill/alpha/normalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  );
  ok(all.ok === true, '[3] 全部接受成功');
  const afterAll = await detail();
  ok(afterAll.bodyOriginal === before.body, '[3] 第二次接受**没有**覆盖 body_original（COALESCE）');
  /* 断言不绑死空格/措辞：只钉「这一行里工具名没了、通用称谓在了」。
     绑死 `用 读取 读取文件` 这种字面写法会在调整文案时变成假红。 */
  const toolLineOf = s => (String(s).split('\n').find(l => l.includes('读取文件')) ?? '');
  ok(
    toolLineOf(afterAll.body).includes('读取工具') && !toolLineOf(afterAll.body).includes('Read'),
    '[3] 工具名已换成通用称谓（`Read` 不在这一行）',
    toolLineOf(afterAll.body)
  );

  // ── 回滚 ──
  const rev = await json(
    await fetch(`${base}/api/extensions/skill/alpha/revert-normalize`, { method: 'POST' })
  );
  ok(rev.ok === true, '[3] 回滚成功');
  const afterRev = await detail();
  ok(afterRev.body === before.body, '[3] 正文**完全**恢复（逐字相同）');
  ok(afterRev.bodyOriginal === null, '[3] body_original 已清空');
  const rev2 = await fetch(`${base}/api/extensions/skill/alpha/revert-normalize`, { method: 'POST' });
  ok(rev2.status === 409, '[3] 重复回滚 → 409（不是静默成功）', String(rev2.status));

  // ── 边界 ──
  console.log('\n[4] 边界');
  const emptyRes = await fetch(`${base}/api/extensions/skill/alpha/normalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: [] }),
  });
  ok(emptyRes.status === 400, '[4] accepted 空数组 → 400（不静默写回原文）', String(emptyRes.status));
  const oobRes = await fetch(`${base}/api/extensions/skill/alpha/normalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: [999] }),
  });
  ok(oobRes.status === 400, '[4] accepted 越界 → 400', String(oobRes.status));
  const mcpNorm = await fetch(`${base}/api/extensions/mcp/shared_ok/normalize`);
  ok(mcpNorm.status === 400, '[4] MCP 不能归一化 → 400（不假装 0 命中）', String(mcpNorm.status));

  /* 重复下标：`accepted: [0,0]` 只改 1 条，`applied` 也必须报 1 ——
     「报的数字比实际做的多」是撒谎，用户会以为漏改了。
     这一段会把正文改掉，测完立刻回滚，否则 [6] 段看到的就不是原文了。 */
  const dupRes = await json(
    await fetch(`${base}/api/extensions/skill/alpha/normalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: [0, 0, 0] }),
    })
  );
  ok(dupRes.ok === true && dupRes.applied === 1, '[4] 重复下标只算 1 条', String(dupRes.applied));
  const afterDup = await detail();
  ok(afterDup.body.includes('{{SKILL_DIR}}') && afterDup.body.includes('`Read` 工具'),
    '[4] 只改了第 0 条（路径），工具名那条没动');
  await fetch(`${base}/api/extensions/skill/alpha/revert-normalize`, { method: 'POST' });
  const afterDupRev = await detail();
  ok(afterDupRev.body === before.body, '[4] 测完回滚，正文回到原文（给 [6] 段留干净状态）');

  // ══════════════ [5] 接口层：P2 分发 ══════════════
  console.log('\n[5] 接口层：MCP 分发');
  const dq = await json(await fetch(`${base}/api/extensions/distribute/preview?agentId=qoder`));
  ok(typeof dq.filePath === 'string' && fs.existsSync(dq.filePath), '[5] 为 qoder 生成了配置文件');
  const genText = dq.filePath ? fs.readFileSync(dq.filePath, 'utf8') : '';
  const gen = genText ? JSON.parse(genText) : { mcpServers: {} };
  ok(Object.keys(gen.mcpServers ?? {}).includes('shared_ok'), '[5] 共享过来的 shared_ok 在里面');
  ok(!Object.keys(gen.mcpServers ?? {}).includes('own_server'),
    '[5] qoder 自己已有的 own_server **不重复写**');
  ok(!Object.keys(gen.mcpServers ?? {}).includes('disabled_one'),
    '[5] 源里 enabled=false 的不推给别人', JSON.stringify(dq.skipped));
  /* **这一条是 P2 的核心**：分发出去的值必须是源文件原值。
     库里那份是脱敏的（`API_KEY` 存成 `***`），拿它分发服务起不来。
     双向钉：① 原值在 ② `***` 不在 —— 只钉 ② 会漏（夹具若不敏感就恒真）。 */
  ok(
    gen.mcpServers?.shared_ok?.env?.API_KEY === FIXTURE_API_KEY,
    '[5] 敏感值按**原值**分发（不是库里的 ***）',
    String(gen.mcpServers?.shared_ok?.env?.API_KEY)
  );
  ok(!genText.includes('***'), '[5] 生成的文件里没有脱敏占位符');
  ok(Array.isArray(gen.mcpServers?.shared_ok?.args),
    '[5] TOML 数组解析成数组（不是字符串 "[\\"-y\\", …]"）',
    JSON.stringify(gen.mcpServers?.shared_ok?.args));
  ok(gen.mcpServers?.shared_ok?.startup_timeout_sec === 30, '[5] TOML 数字解析成 number');
  ok(gen.mcpServers?.shared_ok?.env?.FS_ROOT === '/tmp', '[5] [mcp_servers.x.env] 子表解析正确');

  /* 零写入：用户自己的 mcp.json 一个字节都没动 */
  ok(fs.statSync(QODER_MCP_FILE).mtimeMs === qoderMtimeBefore,
    '[5] 用户自己的 ~/.qoder/mcp.json **没被写过**（mtime 未变）');

  // ══════════════ [6] UI ══════════════
  console.log('\n[6] UI：详情页的归一化分区');
  const chromePath = resolveChrome();
  ok(!!chromePath, '[6] 找到 Chrome');
  if (chromePath) {
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(`${base}/extensions/skill/alpha`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const section = page.locator('[data-ext-normalize]');
    ok((await section.count()) === 1, '[6] 归一化分区存在');

    const hits = page.locator('[data-ext-normalize-hit]');
    const hitCount = await hits.count();
    ok(hitCount === 2, '[6] 逐条列出 2 处', String(hitCount));

    const picks = page.locator('[data-ext-normalize-pick]');
    ok((await picks.count()) === hitCount, '[6] 每条都有勾选框');
    ok((await picks.first().isChecked()) === true, '[6] 默认全选');

    /* 取消第一勾选 → 按钮文案跟着变（「接受选中的 N 条」必须是真的 N） */
    await picks.first().uncheck();
    await page.waitForTimeout(150);
    const applyBtn = page.locator('[data-ext-apply-normalize]');
    ok((await applyBtn.innerText()).includes('1'), '[6] 取消一条后按钮显示 1',
      (await applyBtn.innerText()).trim());

    await applyBtn.click();
    await page.waitForTimeout(1200);

    /* 正文真变了 —— 读 textarea 的 value（它是受控组件，读 innerText 拿不到） */
    const bodyText = await page.locator('[data-ext-editor-input]').inputValue();
    const bodyToolLine = bodyText.split('\n').find(l => l.includes('读取文件')) ?? '';
    ok(
      bodyToolLine.includes('读取工具') && !bodyToolLine.includes('Read'),
      '[6] 接受后正文里工具名换成通用称谓',
      bodyToolLine
    );
    ok(!bodyText.includes('{{SKILL_DIR}}'), '[6] 未勾选的路径那条**没被替换**（只改了 1 条）');

    const revertBtn = page.locator('[data-ext-revert-normalize]');
    ok((await revertBtn.count()) === 1, '[6] 出现「回滚到原文」');

    await revertBtn.click();
    await page.waitForTimeout(1200);
    const bodyBack = await page.locator('[data-ext-editor-input]').inputValue();
    ok(bodyBack.includes('~/.claude/skills/alpha/'), '[6] 回滚后正文回到原文');
    ok(bodyBack.includes('`Read` 工具'), '[6] 回滚后工具名也恢复');

    ok(pageErrors.length === 0, '[6] 没有未捕获异常', pageErrors.slice(0, 2).join(' | '));
  }
} catch (e) {
  fail++;
  failures.push('脚本异常');
  console.log(`  ✗ 脚本异常：${e?.message ?? e}`);
  console.log(String(e?.stack ?? '').slice(0, 800));
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(child);
}

console.log(`\nA166 结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
