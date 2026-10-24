/**
 * A97 验证闭环的浏览器验证。
 *
 *   [1] 未验证是**显式状态**：改过文件就挂条，不能因为没数据就整块消失
 *   [2] 命令列表来自探测；build（slow 档）默认不勾
 *   [3] 点运行 → SSE 流式 → 全通过时状态翻成「已验证」
 *   [4] 请求体只带 commandId，**不带命令字符串**（后端不接受任意 shell）
 *   [5] 结果落库后刷新仍在：刷新后直接显示「验证失败」，不需要重跑
 *   [6] 失败时保留退出码与输出尾部
 *   [7] 会话没绑工作目录 → 明确说明，不假装能验证
 *   [8] 探测不到命令 → 说明原因，不给一个必然失败的空跑
 *   [9] 没改过文件的回答不挂验证条（纯问答不该出现「跑测试」）
 *   [10] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a97.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];

const CWD = 'E:/proj/node-app';
const SESSIONS = [
  { id: 's1', title: '有工作目录', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, cwd: CWD, created_at: new Date().toISOString() },
  { id: 's2', title: '无工作目录', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 's3', title: '空项目', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, cwd: 'E:/proj/empty', created_at: new Date().toISOString() },
  { id: 's4', title: '纯问答', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, cwd: CWD, created_at: new Date().toISOString() },
  { id: 's5', title: '只有构建', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, cwd: 'E:/proj/build-only', created_at: new Date().toISOString() },
];

const now = Date.now();
const EDIT_BLOCK = {
  id: 'b1', type: 'tool', toolId: 't1', name: 'Edit', status: 'completed',
  input: {
    file_path: 'E:/proj/node-app/src/sum.ts',
    old_string: 'export const sum = (a, b) => a - b;',
    new_string: 'export const sum = (a: number, b: number) => a + b;',
  },
  output: 'The file has been updated.', startedAt: now - 4000, endedAt: now - 3200,
};

/** 每条会话一条回答；s4 那条**没有**写类工具 */
const MESSAGES = SESSIONS.map(s => ({
  id: `m-${s.id}`,
  session_id: s.id,
  role: 'assistant',
  content: s.id === 's4' ? '这个问题不需要改代码。' : '改好了。',
  model: 'claude-sonnet-4-5',
  author_agent_id: 'workbuddy',
  created_at: new Date(now).toISOString(),
  blocks: s.id === 's4'
    ? [
        { id: 'r1', type: 'tool', toolId: 'tr1', name: 'Read', status: 'completed', input: { file_path: 'E:/proj/node-app/src/sum.ts' }, output: 'ok', startedAt: now - 3000, endedAt: now - 2800 },
        { id: 't1', type: 'text', text: '这个问题不需要改代码。', state: 'done' },
      ]
    : [EDIT_BLOCK, { id: 't2', type: 'text', text: '改好了。', state: 'done' }],
}));

/** 探测结果：node 项目 4 条，build 为 slow */
const DETECT_FULL = {
  cwd: CWD,
  projectTypes: ['node'],
  commands: [
    { id: 'node:test:test', kind: 'test', label: '单元测试（test）', command: 'npm run test', source: 'package.json', weight: 'medium' },
    { id: 'node:typecheck:typecheck', kind: 'typecheck', label: '类型检查（typecheck）', command: 'npm run typecheck', source: 'package.json', weight: 'medium' },
    { id: 'node:lint:lint', kind: 'lint', label: '代码检查（lint）', command: 'npm run lint', source: 'package.json', weight: 'medium' },
    { id: 'node:build:build', kind: 'build', label: '构建（build）', command: 'npm run build', source: 'package.json', weight: 'slow' },
  ],
  notes: [],
};
const DETECT_EMPTY = {
  cwd: 'E:/proj/empty',
  projectTypes: [],
  commands: [],
  notes: ['没有识别到可自动执行的检查命令'],
};
/** 只有一条 slow 档命令（本仓库真实形态：只有 build） */
const DETECT_BUILD_ONLY = {
  cwd: 'E:/proj/build-only',
  projectTypes: ['node'],
  commands: [
    { id: 'node:build:build', kind: 'build', label: '构建（build）', command: 'npm run build', source: 'package.json', weight: 'slow' },
  ],
  notes: [],
};

const LABEL = Object.fromEntries(DETECT_FULL.commands.map(c => [c.id, c.label]));

/** 状态：测试过程中会被改写，用来模拟不同轮次 */
const state = {
  results: [],           // /api/verify/results 返回什么
  runMode: 'pass',       // 'pass' | 'fail'
  lastRunBody: null,     // 捕获 POST /api/verify/run 的请求体
};

/** 按 runMode 生成一段 SSE 报文 */
function sseFor(commandIds) {
  const lines = [];
  const push = o => lines.push(`data: ${JSON.stringify(o)}\n\n`);
  push({ type: 'start', total: commandIds.length, commands: commandIds.map(id => ({ id, label: LABEL[id], command: `npm run ${id.split(':').pop()}` })) });
  let failedOnce = false;
  for (const id of commandIds) {
    push({ type: 'command_start', commandId: id, command: `npm run ${id.split(':').pop()}` });
    push({ type: 'chunk', commandId: id, text: `> ${id}\n` });
    const fail = state.runMode === 'fail' && !failedOnce;
    if (fail) failedOnce = true;
    const result = {
      commandId: id,
      command: `npm run ${id.split(':').pop()}`,
      status: fail ? 'fail' : 'pass',
      exitCode: fail ? 1 : 0,
      durationMs: fail ? 2311 : 1234,
      output: fail
        ? '> vitest run\n\n FAIL  src/sum.test.ts > sum > 负数\n AssertionError: expected -1 to be 1\n\n Tests  1 failed | 11 passed (12)\n'
        : '> vitest run\n\n Test Files  3 passed (3)\n      Tests  12 passed (12)\n',
      truncated: false,
      hint: fail ? '退出码 1' : undefined,
    };
    push({ type: 'result', commandId: id, id: `v-${id}`, result });
  }
  push({ type: 'done' });
  return lines.join('');
}

let total = 0;
const failures = [];
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = join(DIST, p);
    let body;
    try {
      body = await readFile(file);
    } catch {
      file = join(DIST, 'index.html');
      body = await readFile(file);
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await ctx.route('**/api/**', async route => {
  const req = route.request();
  const url = req.url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });

  // ── A97 三个接口 ──────────────────────────────────────────────
  if (url.includes('/api/verify/commands')) {
    const cwd = new URL(url).searchParams.get('cwd') ?? '';
    if (cwd.includes('build-only')) return json(DETECT_BUILD_ONLY);
    return json(cwd.includes('empty') ? DETECT_EMPTY : { ...DETECT_FULL, cwd });
  }
  if (url.includes('/api/verify/results')) {
    return json({ verifications: state.results });
  }
  if (url.includes('/api/verify/run')) {
    const body = JSON.parse(req.postData() || '{}');
    state.lastRunBody = body;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseFor(body.commandIds ?? []),
    });
  }

  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

async function open(sessionId) {
  await page.goto(`${base}/chat/${sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
}

const panel = () => page.locator('[data-verify-status]').first();

// ── [1] 未验证是显式状态 ──────────────────────────────────────────
console.log('\n[1] 未验证是显式状态');
state.results = [];
await open('s1');
ok((await page.locator('[data-verify-status]').count()) === 1, '改过文件的回答挂了验证条');
ok((await panel().getAttribute('data-verify-status')) === 'unverified', '状态为 unverified（不是不渲染）');
ok((await panel().locator('.tc-verify-title').textContent())?.trim() === '未验证', '文案是「未验证」而不是留白');
ok((await panel().locator('.tc-verify-meta').first().textContent())?.includes('可跑 4 项检查'), '未跑时也告知「有 4 项可跑」', (await panel().locator('.tc-verify-meta').first().textContent())?.trim());

// ── [2] 命令列表与默认勾选 ────────────────────────────────────────
console.log('\n[2] 命令列表与默认勾选');
await panel().locator('.tc-verify-bar').click();
await page.waitForTimeout(300);
const cmds = page.locator('.tc-verify-cmd');
ok((await cmds.count()) === 4, '列出 4 条探测到的检查', String(await cmds.count()));
const checkedIds = await page.evaluate(() =>
  [...document.querySelectorAll('.tc-verify-cmd')]
    .filter(el => el.querySelector('input')?.checked)
    .map(el => el.getAttribute('data-verify-cmd'))
);
ok(checkedIds.length === 3, '默认勾选 3 条（跳过 slow）', checkedIds.join(','));
ok(!checkedIds.includes('node:build:build'), 'build 默认不勾（动辄一两分钟）');
const tagText = (await page.locator('.tc-verify-cmd-tag').first().textContent())?.trim();
ok(tagText === '较慢', 'slow 档有「较慢」提示', tagText);
ok((await page.locator('.tc-verify-btn.is-primary').count()) === 1, '有运行按钮');

// ── [3][4] 运行 → 已验证；请求体只带 id ───────────────────────────
console.log('\n[3] 运行验证（全通过）');
state.runMode = 'pass';
await page.locator('.tc-verify-btn.is-primary').click();
await page.waitForSelector('[data-verify-status="passed"]', { timeout: 15000 });
ok((await panel().getAttribute('data-verify-status')) === 'passed', '全通过 → passed');
ok((await panel().locator('.tc-verify-title').textContent())?.trim() === '已验证', '文案「已验证」');
const resultRows = page.locator('.tc-verify-result');
ok((await resultRows.count()) === 3, '3 条结果（与勾选数一致）', String(await resultRows.count()));
const rowStatuses = await page.evaluate(() => [...document.querySelectorAll('.tc-verify-result')].map(el => el.getAttribute('data-verify-result')));
ok(rowStatuses.every(s => s === 'pass'), '每条都是 pass', rowStatuses.join(','));

console.log('\n[4] 请求体只带 commandId');
const body = state.lastRunBody ?? {};
ok(Array.isArray(body.commandIds) && body.commandIds.length === 3, 'commandIds 是 3 个 id', JSON.stringify(body.commandIds));
ok(body.command === undefined, '不带 command 字段（后端不接受任意 shell）');
ok(body.cwd === CWD, '带上 cwd 供后端重新探测');
ok(body.messageId === 'm-s1', '带上 messageId 供落库归属', body.messageId);
ok(!body.commandIds.includes('node:build:build'), '未勾选的 build 没有被偷偷执行');

await page.screenshot({ path: join(OUT, 'a97-verify-pass.png') });

// ── [5] 落库结果刷新后仍在 ───────────────────────────────────────
console.log('\n[5] 刷新后保留上次结论');
state.results = [
  {
    id: 'v1', session_id: 's1', message_id: 'm-s1', command_id: 'node:test:test', command: 'npm run test',
    kind: 'test', label: '单元测试（test）', status: 'fail', exit_code: 1, duration_ms: 2311,
    output: 'FAIL src/sum.test.ts\n AssertionError: expected -1 to be 1', output_truncated: 0,
    created_at: new Date().toISOString(),
  },
];
await open('s1');
ok((await panel().getAttribute('data-verify-status')) === 'failed', '刷新后直接是 failed（不需要重跑）');
ok((await panel().locator('.tc-verify-title').textContent())?.trim() === '验证失败', '文案「验证失败」');
const meta = (await panel().locator('.tc-verify-meta').first().textContent()) ?? '';
ok(meta.includes('失败'), '摘要里点名哪条没过', meta.trim());
ok(meta.includes('2.3s'), '摘要带耗时', meta.trim());

// ── [6] 失败时保留退出码与输出 ───────────────────────────────────
console.log('\n[6] 失败详情');
state.results = [];
state.runMode = 'fail';
await open('s1');
await panel().locator('.tc-verify-bar').click();
await page.waitForTimeout(250);
await page.locator('.tc-verify-btn.is-primary').click();
await page.waitForSelector('[data-verify-status="failed"]', { timeout: 15000 });
ok((await panel().getAttribute('data-verify-status')) === 'failed', '有一条失败 → failed（不因多数通过就算过）');
const failRow = page.locator('.tc-verify-result[data-verify-result="fail"]').first();
ok((await failRow.count()) === 1, '失败行被单独标出');
ok((await failRow.locator('.tc-verify-result-code').textContent())?.includes('1'), '显示退出码', (await failRow.locator('.tc-verify-result-code').textContent())?.trim());
const out = (await failRow.locator('.tc-verify-output').textContent()) ?? '';
ok(out.includes('AssertionError'), '保留失败输出（结论在尾部也没被截掉）');
ok((await page.locator('.tc-verify-result[data-verify-result="pass"]').count()) === 2, '通过的条目也如实列出');
await page.screenshot({ path: join(OUT, 'a97-verify-fail.png') });

// ── [7] 会话没绑工作目录 ────────────────────────────────────────
console.log('\n[7] 没绑工作目录');
state.results = [];
await open('s2');
ok((await panel().getAttribute('data-verify-status')) === 'unverified', '仍然显示「未验证」');
ok(((await panel().locator('.tc-verify-meta').first().textContent()) ?? '').includes('未绑定工作目录'), '明确说明未绑定');
await panel().locator('.tc-verify-bar').click();
await page.waitForTimeout(250);
ok((await page.locator('.tc-verify-cmd').count()) === 0, '不列命令');
ok((await page.locator('.tc-verify-btn').count()) === 0, '不给一个点了必然失败的按钮');

// ── [8] 探测不到命令 ───────────────────────────────────────────
console.log('\n[8] 探测不到命令');
await open('s3');
ok((await panel().getAttribute('data-verify-status')) === 'unverified', '空项目也是「未验证」');
ok(((await panel().locator('.tc-verify-meta').first().textContent()) ?? '').includes('没有识别到'), '摘要里说明没识别到', (await panel().locator('.tc-verify-meta').first().textContent())?.trim());
await panel().locator('.tc-verify-bar').click();
await page.waitForTimeout(250);
const noteText = (await page.locator('.tc-verify-note').first().textContent()) ?? '';
ok(noteText.includes('没有识别到可自动执行的检查命令'), '展开后有完整解释', noteText.trim().slice(0, 40));
// 探测器 notes 里已经有一模一样的一句，组件再硬编码一遍就会重复渲染
const dupCount = noteText.split('没有识别到可自动执行的检查命令').length - 1;
ok(dupCount === 1, '同一句提示只出现一次（不与探测器 notes 重复）', `出现 ${dupCount} 次`);
ok((await page.locator('.tc-verify-btn').count()) === 0, '没有可跑命令时不给运行按钮');

// ── [9] 纯问答不挂验证条 ────────────────────────────────────────
console.log('\n[9] 没改过文件就不挂');
await open('s4');
ok((await page.locator('[data-verify-status]').count()) === 0, '只有 Read 的回答不出现验证条（不制造噪音）');

// ── [10] 只有一条 slow 档命令时也要能点 ─────────────────────────
console.log('\n[10] 只有 build 一条（slow）');
await open('s5');
await panel().locator('.tc-verify-bar').click();
await page.waitForTimeout(250);
ok((await page.locator('.tc-verify-cmd').count()) === 1, '只列出 1 条', String(await page.locator('.tc-verify-cmd').count()));
const onlyChecked = await page.evaluate(() => !!document.querySelector('.tc-verify-cmd input')?.checked);
ok(onlyChecked, '唯一一条即使属于 slow 档也默认勾上');
const runBtn = page.locator('.tc-verify-btn.is-primary');
ok((await runBtn.count()) === 1, '有运行按钮');
ok((await runBtn.isDisabled()) === false, '按钮可用（不是一打开就是灰的）');

// ── [11] 控制台 ────────────────────────────────────────────────
console.log('\n[11] 控制台');
const realErrors = errors.filter(e => !/favicon|Download the React DevTools/i.test(e));
ok(realErrors.length === 0, '无控制台错误', realErrors.slice(0, 2).join(' | '));

await ctx.close();
await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${total - failures.length}/${total}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
