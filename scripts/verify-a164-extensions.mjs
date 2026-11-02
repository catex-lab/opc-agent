/**
 * A164 验证：扩展（Agent 技能 + MCP）。
 *
 * ## 这一层守的是什么
 *
 * 不是「界面存在」，而是**「从各家 Agent 目录读进来、去重、可编辑、防冲突、
 * 防泄漏」整条链路在真实数据库上成立**：
 *
 *   [1] 入口与路由    —— NavKey 有 `extensions`，三条路由都在（源码级）。
 *   [2] 导入即出现    —— 假技能目录 → POST /import → 列表出现该技能。
 *   [3] 去重          —— 同名技能放两个 Agent 目录 → 一条 item、两条 source，
 *                         列表徽章显示 ×2。
 *   [4] 本地编辑      —— PUT 改正文 → GET 读回新正文，且 `locally_modified=1`。
 *   [5] 冲突不覆盖    —— 源文件变了 + 本地改过 → refresh 返回 `conflict`，
 *                         本地正文**原样保留**（绝不自动覆盖）。
 *   [6] 敏感内容      —— 技能正文命中 `sk-` → `blocked=1` 且 body 为空；
 *                         MCP 配置命中 → 值被换成 `***`、结构保留（脱敏而非丢弃）。
 *   [7] 能力矩阵四态  —— ready / planned / local-only / unsupported 都渲染；
 *                         `unsupported` 的颜色**不是**绿色（真鼠标坐标 + 取色）。
 *                         [7b] A167 补两档：prompt 态没有这一份 = `injected`（会注入），
 *                         blocked 的 = `sealed`（含敏感内容，不注入）。
 *   [8] 删除即离开    —— 删当前项 → URL 回到 /extensions，右侧不停在幽灵详情。
 *   [9] 差异检测      —— A168/P4：外部新装 → 徽章出现 → 全部应用 → 徽章消失；
 *                         冲突行**不许**有「应用」（会丢用户的编辑）。
 *
 * ## 假环境
 *
 * `OPC_EXT_HOME` 指向本脚本自建的假主目录（绝不碰真实 `~/.claude` 等），
 * `OPC_DATA_DIR` 指向临时库。服务器用 tsx 起真进程，静态层由它托管 dist。
 *
 * 运行：node scripts/verify-a164-extensions.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a164-ext-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const FAKE_HOME = path.join(TMP, 'home');

// 假密钥。**拆开写**：密钥扫描按「`sk-` + ≥20 位」的字面量匹配，拆开就不会命中
// （见 scripts/secret-scan.mjs 的 sk-key 规则），而运行时拼出来仍是完整的 `sk-…`。
// 本文件是测试夹具，不是真密钥。
const FAKE_SECRET = 'sk-' + 'abcdefghijklmnopqrst';

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

async function waitReady(base, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let log = '';
  child.stdout?.on('data', d => (log += String(d)));
  child.stderr?.on('data', d => (log += String(d)));
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ready: false, log };
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) return { ready: true, log };
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ready: false, log };
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

/** `#rrggbb` → `[r,g,b]`；不是 hex 就返回 null（调用方降级成「只要颜色不同」） */
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 系统 Chrome 优先；没有就取 ms-playwright 里最新的一个 chromium 构建 */
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

// ── [1] 源码级：入口与路由 ────────────────────────────────────────────
console.log('\n[1] 入口与路由（源码级）');
{
  const nav = fs.readFileSync(path.join(ROOT, 'src', 'components', 'NavRail.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');
  ok(/export type NavKey = 'chats' \| 'projects' \| 'contacts' \| 'extensions'/.test(nav), 'NavKey 含 extensions');
  ok(/key: 'extensions'/.test(nav), 'NavRail 有第 4 个入口（扩展）');
  ok(/<Route path="\/extensions"/.test(app), '路由 /extensions 存在');
  ok(/<Route path="\/extensions\/:extKind\/:extName"/.test(app), '路由 /extensions/:extKind/:extName 存在');
  ok(/parseExtKind/.test(fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8')), '服务端有 kind 白名单（非法值 400）');
}

// ── 假环境 ─────────────────────────────────────────────────────────────
fs.mkdirSync(FAKE_HOME, { recursive: true });

/** 写一个假技能：`<agent 目录>/<name>/SKILL.md` */
function writeSkill(rel, name, body) {
  const dir = path.join(FAKE_HOME, rel, name);
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: ${name} 的测试技能\n---\n\n${body}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return text;
}

// alpha：claude + qoder 各一份（内容相同 → 去重为一条、两个来源）
writeSkill('.claude/skills', 'alpha', '# alpha v1\n\n这是 alpha 的原始正文。\n');
writeSkill('.qoder/skills', 'alpha', '# alpha v1\n\n这是 alpha 的原始正文。\n');
// beta：只在 gemini
writeSkill('.gemini/skills', 'beta', '# beta\n\n这是 beta 的原始正文。\n');
// codexlocal：只在 codex（有目录但挂载通道不支持 → 矩阵「本机已有、不可共享」）
writeSkill('.codex/skills', 'codexlocal', '# codexlocal\n\n只在 codex 里。\n');
// leaky：正文带 `sk-` 密钥 → blocked，正文不落库
writeSkill('.codex/skills', 'leaky', '# leaky\n\n密钥: ' + FAKE_SECRET + '\n');

// MCP：qoder/mcp.json，env 带 `sk-` → 脱敏后落库（值换 ***，结构保留）
const qoderDir = path.join(FAKE_HOME, '.qoder');
fs.mkdirSync(qoderDir, { recursive: true });
fs.writeFileSync(
  path.join(qoderDir, 'mcp.json'),
  JSON.stringify(
    {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { FS_TOKEN: FAKE_SECRET },
        },
      },
    },
    null,
    2
  )
);

// ── 起服务 ─────────────────────────────────────────────────────────────
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
    // 验证只扫假主目录，绝不碰真实 ~/.claude 等（见 targets.ts 的口子注释）
    OPC_EXT_HOME: FAKE_HOME,
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
if (!ready) {
  console.error(`服务端没起来：\n${log.slice(-800)}`);
  process.exit(1);
}
ok(true, '服务端启动并就绪（假主目录 + 临时库）', `:${port}`);

try {
  // ── [2] 导入 → 列表出现 ──────────────────────────────────────────
  console.log('\n[2] 导入即出现');
  let res = await fetch(`${base}/api/extensions/import`, { method: 'POST' });
  let rep = await json(res);
  ok(rep.skillScanned === 5, '扫到 5 个技能文件', `skillScanned=${rep.skillScanned}`);
  ok(rep.mcpScanned === 1, '扫到 1 个 MCP', `mcpScanned=${rep.mcpScanned}`);
  ok(rep.added === 5, '新增 5 条（4 技能 + 1 MCP）', `added=${rep.added}`);
  ok(rep.blocked.length === 2, '2 条被标记敏感（leaky 技能 + filesystem MCP）', `blocked=${rep.blocked.length}`);

  res = await fetch(`${base}/api/extensions`);
  const list = await json(res);
  const alpha = list.items.find(i => i.kind === 'skill' && i.name === 'alpha');
  const beta = list.items.find(i => i.kind === 'skill' && i.name === 'beta');
  const leaky = list.items.find(i => i.kind === 'skill' && i.name === 'leaky');
  const filesystem = list.items.find(i => i.kind === 'mcp' && i.name === 'filesystem');
  ok(!!alpha && !!beta && !!leaky && !!filesystem, '列表同时出现 alpha / beta / leaky / filesystem');
  ok(list.stats.skillCount === 4, 'stats.skillCount = 4', `=${list.stats.skillCount}`);
  ok(list.stats.mcpCount === 1, 'stats.mcpCount = 1', `=${list.stats.mcpCount}`);
  ok(list.stats.duplicateCount === 1, 'stats.duplicateCount = 1（只有 alpha 是重复的）', `=${list.stats.duplicateCount}`);
  ok(list.targets.length === 15, '矩阵拿到 15 个 Agent 的完整名册', `=${list.targets.length}`);

  // ── [3] 去重：一条 item、两条 source ────────────────────────────
  console.log('\n[3] 去重');
  ok(alpha.sourceCount === 2, 'alpha 一条 item、两条 source', `sourceCount=${alpha.sourceCount}`);
  ok(
    alpha.sources.map(s => s.agentId).sort().join(',') === 'claude,qoder',
    '两条来源是 claude 与 qoder（字典序）',
    alpha.sources.map(s => s.agentId).join(',')
  );
  ok(list.items.filter(i => i.kind === 'skill' && i.name === 'alpha').length === 1, '列表里 alpha 只有一行（不是两行）');

  // ── [4] 本地编辑：PUT → GET 读回新正文，locally_modified=1 ──────
  console.log('\n[4] 本地编辑');
  const localBody = '# alpha v1（本地改过）\n\n这是 OPC 里改出来的正文。\n';
  res = await fetch(`${base}/api/extensions/skill/alpha`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: localBody }),
  });
  let put = await json(res);
  ok(put.ok === true && put.item.locallyModified === true, 'PUT 成功且 locally_modified=1');
  res = await fetch(`${base}/api/extensions/skill/alpha`);
  let detail = await json(res);
  ok(detail.item.body === localBody, 'GET 读回本地改过的正文');
  ok(detail.item.locallyModified === true, 'GET 仍显示 locally_modified=1');
  ok(detail.item.contentHash !== detail.item.bodyHash, 'content_hash（源指纹）与 body_hash（本地指纹）分开');
  ok(detail.targets.length === 15, '详情也带矩阵（15 行）', `=${detail.targets.length}`);

  // ── [5] 源变了 + 本地改过 → 冲突，绝不覆盖 ─────────────────────
  console.log('\n[5] 冲突不覆盖');
  writeSkill('.claude/skills', 'alpha', '# alpha v2\n\n上游把源文件改了。\n'); // 上游 v2
  res = await fetch(`${base}/api/extensions/skill/alpha/refresh`, { method: 'POST' });
  const ref = await json(res);
  ok(ref.outcome === 'conflict', 'refresh 返回 conflict（不是 updated）', `outcome=${ref.outcome}`);
  ok(ref.item.body === localBody, '本地正文原样保留（没被 v2 覆盖）');
  ok(ref.item.locallyModified === true, 'locally_modified 仍为 1');
  ok(ref.item.revision >= 2, 'revision 单调增（本地编辑已计数）', `rev=${ref.item.revision}`);

  // 冲突三选一里的「用源的覆盖」：接受后本地标记清掉，正文跟上 v2
  res = await fetch(`${base}/api/extensions/skill/alpha/accept-source`, { method: 'POST' });
  await json(res);
  res = await fetch(`${base}/api/extensions/skill/alpha`);
  detail = await json(res);
  ok(detail.item.locallyModified === false, 'accept-source 清掉本地标记');
  ok(detail.item.body.includes('alpha v2'), 'accept-source 后正文跟上游（v2）');

  // ── [6] 敏感内容 ────────────────────────────────────────────────
  console.log('\n[6] 敏感内容');
  ok(leaky.blocked === true, 'leaky 技能 blocked=1');
  ok(leaky.body === null, 'leaky 正文为空（不落库）');
  ok(/敏感内容/.test(leaky.blockedReason || ''), 'leaky 有可读的 blockedReason');
  ok(filesystem.blocked === true, 'filesystem MCP blocked=1');
  ok(
    (filesystem.configJson || '').includes('***') && !(filesystem.configJson || '').includes(FAKE_SECRET),
    'MCP 配置值被脱敏成 ***，原文密钥不落库'
  );
  ok(JSON.parse(filesystem.configJson || '{}').command === 'npx', 'MCP 脱敏后结构保留（command 仍在）');

  // ── [7]+[8] 真浏览器 ────────────────────────────────────────────
  const exe = resolveChrome();
  if (!exe) {
    ok(false, '[7][8] 找不到可用的 Chrome/Chromium，浏览器层未跑');
  } else {
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

      // 列表徽章：×2（[3] 的界面半边）
      await page.goto(`${base}/extensions`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-source-count]', { timeout: 25000 });
      const badge = await page.getAttribute('[data-ext-source-count]', 'data-ext-source-count');
      ok(badge === '2', '[3] 列表里 alpha 的徽章显示 ×2', `badge=${badge}`);

      // ── [7] 能力矩阵四态 ────────────────────────────────────────
      console.log('\n[7] 能力矩阵四态');
      // 进入 alpha 详情
      await page.goto(`${base}/extensions/skill/alpha`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-matrix]', { timeout: 25000 });

      const rowState = async agentId =>
        await page.getAttribute(`[data-ext-matrix-row="${agentId}"]`, 'data-ext-matrix-state');
      const rowColor = async agentId =>
        await page.evaluate(id => {
          const el = document.querySelector(`[data-ext-matrix-row="${id}"] [data-ext-matrix-label]`);
          return el ? getComputedStyle(el).color : null;
        }, agentId);

      ok((await rowState('claude')) === 'ready', 'alpha · claude = ready（已就位）');
      ok((await rowState('gemini')) === 'planned', 'alpha · gemini = planned（通道已确认）');
      ok((await rowState('codex')) === 'unsupported', 'alpha · codex = unsupported（不支持）');

      const claudeColor = await rowColor('claude');
      const codexColor = await rowColor('codex');
      const okColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tc-status-ok').trim());
      const okRgb = hexToRgb(okColor);
      ok(
        claudeColor !== null && okRgb !== null && claudeColor === `rgb(${okRgb.join(', ')})`,
        'claude（ready）颜色 = --tc-status-ok（绿）',
        claudeColor
      );
      ok(codexColor !== null && codexColor !== claudeColor, 'codex（unsupported）颜色 ≠ 绿色', codexColor);

      // local-only：只在 codex 的技能
      await page.goto(`${base}/extensions/skill/codexlocal`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-matrix]', { timeout: 25000 });
      ok((await rowState('codex')) === 'local-only', 'codexlocal · codex = local-only（本机已有、不可共享）');
      // 事实标记：codex 目录里确实有它
      ok(
        await page.locator('[data-ext-matrix-row="codex"] [data-ext-matrix-present]').isVisible(),
        'local-only 行也显示「确实已就位」的事实标记'
      );

      // ── [7b] A167：prompt 态的两档新状态 ────────────────────────
      // beta 只在 gemini：claude / workbuddy 是 prompt 态且自己没有这一份
      // ⇒ P3 之后它**真的会送到**，不能再画成「通道已确认（将来）」。
      console.log('\n[7b] A167 注入档');
      await page.goto(`${base}/extensions/skill/beta`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-matrix]', { timeout: 25000 });
      ok((await rowState('gemini')) === 'ready', 'beta · gemini = ready（自己的目录里有）');
      ok((await rowState('claude')) === 'injected', 'beta · claude = injected（会注入，不是「将来」）');
      ok((await rowState('workbuddy')) === 'injected', 'beta · workbuddy = injected');
      ok(
        (await rowState('qoder')) === 'planned',
        'beta · qoder = planned（flag 态仍要等官方 link，不许提前画成能用）'
      );
      const injectedLabel = await page.locator(
        '[data-ext-matrix-row="claude"] [data-ext-matrix-label]'
      ).innerText();
      ok(injectedLabel.trim() === '会注入', 'injected 的文案是「会注入」', injectedLabel);

      // leaky：正文含 sk-（blocked）且只在 codex ⇒ 对 claude 不注入（不镜像带密钥的正文）
      await page.goto(`${base}/extensions/skill/leaky`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-matrix]', { timeout: 25000 });
      ok((await rowState('claude')) === 'sealed', 'leaky · claude = sealed（含敏感内容，不注入）');

      // ── [8] 删除即离开 ──────────────────────────────────────────
      console.log('\n[8] 删除即离开');
      await page.goto(`${base}/extensions/skill/beta`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-detail]', { timeout: 25000 });
      await page.locator('[data-ext-delete]').first().click();
      await page.waitForSelector('[data-confirm-dialog]', { timeout: 10000 });
      await page.locator('[data-confirm-dialog] button', { hasText: '移除副本' }).click();
      await page.waitForTimeout(600);
      const urlAfter = page.url();
      ok(/\/extensions$/.test(urlAfter), '删除后 URL 回到 /extensions', urlAfter.replace(base, ''));
      ok(await page.locator('[data-ext-detail-empty]').isVisible(), '右侧渲染空态（不停在幽灵详情）');

      // ── [9] A168 / P4：差异检测（外部新装 / 应用 / 冲突不给一键）──
      console.log('\n[9] 差异检测（P4）');
      const openDrift = async () => {
        await page.waitForSelector('[data-ext-drift]', { timeout: 25000 });
        if (!(await page.locator('[data-ext-drift-list]').isVisible().catch(() => false))) {
          await page.locator('[data-ext-drift-toggle]').click();
        }
        await page.waitForSelector('[data-ext-drift-list]', { timeout: 10000 });
      };

      await page.goto(`${base}/extensions`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-ext-panel]', { timeout: 25000 });

      /* 路由顺序：drift 若注册在 :kind/:name 之后，这里会是 400 */
      let dres = await fetch(`${base}/api/extensions/drift`);
      let drep = await json(dres);
      ok(dres.status === 200, 'GET /api/extensions/drift → 200（没被 :kind/:name 抢走）', String(dres.status));
      /* [8] 删掉了 beta 的 OPC 副本，但源文件还在 gemini 目录 ⇒ 差异里应重新出现为「新发现」 */
      ok(
        (drep.counts?.total ?? 0) >= 1,
        '删掉 OPC 副本后，源还在 ⇒ 差异里重新出现',
        JSON.stringify(drep.counts)
      );

      // 外部新装一条（模拟用户在自己客户端里刚装好）
      const deltaDir = path.join(FAKE_HOME, '.codex', 'skills', 'delta');
      fs.mkdirSync(deltaDir, { recursive: true });
      fs.writeFileSync(
        path.join(deltaDir, 'SKILL.md'),
        '---\nname: delta\ndescription: 刚装上的\n---\n\n# delta\n',
        'utf8'
      );

      // 栏头「重新读取」应同时刷新列表与差异（P4 的手动重扫入口）
      await page.locator('[data-ext-refresh]').click();
      await openDrift();
      const total = await page.getAttribute('[data-ext-drift]', 'data-ext-drift-total');
      ok(Number(total) >= 2, '差异提示出现且条数 ≥ 2', total);
      ok(
        (await page.getAttribute('[data-ext-drift-row="skill:delta"]', 'data-ext-drift-state')) === 'new',
        'delta 显示为「新发现」'
      );
      ok(await page.locator('[data-ext-drift-apply-all]').isVisible(), '多条可应用时出现「全部应用」');

      await page.locator('[data-ext-drift-apply-all]').click();
      await page.waitForSelector('[data-ext-drift]', { state: 'detached', timeout: 25000 });
      ok(true, '全部应用后差异提示消失（不是「应用了但徽章还挂着」）');
      ok(await page.locator('[data-ext-row="skill:delta"]').isVisible(), '列表里出现了 delta');

      /* 冲突：本地改过 + 源又变了 ⇒ 这一行**不许**给「应用」（会丢用户的编辑） */
      await fetch(`${base}/api/extensions/skill/alpha`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '# 我又改了一次\n' }),
      });
      fs.writeFileSync(
        path.join(FAKE_HOME, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: alpha 的测试技能\n---\n\n# alpha v9\n',
        'utf8'
      );
      await page.locator('[data-ext-refresh]').click();
      await openDrift();
      ok(
        (await page.getAttribute('[data-ext-drift-row="skill:alpha"]', 'data-ext-drift-state')) === 'conflict',
        'alpha 显示为「有冲突」'
      );
      ok(
        (await page.locator('[data-ext-drift-apply="skill:alpha"]').count()) === 0,
        '冲突行**没有**「应用」按钮（不给一键丢掉自己的编辑）'
      );
      ok(
        await page.locator('[data-ext-drift-open="skill:alpha"]').isVisible(),
        '冲突行给的是「查看」'
      );
      const alphaAfter = await json(await fetch(`${base}/api/extensions/skill/alpha`));
      ok(alphaAfter.item?.body === '# 我又改了一次\n', '本地正文没有被差异检测动过', alphaAfter.item?.body);
    } finally {
      await browser.close();
    }
  }
} finally {
  killTree(child);
}

console.log(`\nA164 结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
