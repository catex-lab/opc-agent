/**
 * A36 执行轨迹的浏览器验证（2026-11-22 改版：单聊过程回合 = 一条 ProcessFlow）。
 *
 *   [1] 头部不再有总耗时
 *   [2] 完成态默认收成一条摘要；点摘要线展开步骤流
 *   [3] 整轮时钟（服务端盖章 durationMs 优先）+ 摘要线结果语义 + 胶囊
 *   [4] 步骤行：动词 / 等宽内容 / diff / 耗时 / 行状态
 *   [5] 思考行：流内兄弟行，点开看原文（不再有「思考全文」面板）
 *   [6] 长步骤流：无分组、无限高容器（参考页形态）
 *   [7]/[7b] 后台任务胶囊（不变）
 *   [8]/[8b] 群聊各自一条流程；未回传 / 已隐去
 *   [9] 改版接线（源码级）
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a36.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();

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
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes',
    color: '#7C5CFF', description: '长任务编排', capabilities: ['chat'],
    status: { availability: 'ready', version: '0.9.0' },
    permissionSupport: { enforced: ['default'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 's2', title: '研发小组', agent_id: null, model: null, kind: 'group', agent_ids: '["workbuddy","hermes"]', orchestration: 'relay', created_at: new Date().toISOString() },
  { id: 's3', title: '长任务', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
];

const lines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
const now = Date.now();
const ANSWER = '改好了，主要动了设置页的外观滑杆。';

// 16 行 → 109 行：diff 应当正好是 +109 -16
const OLD = lines(16, 'old');
const NEW = lines(109, 'new');

const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '把设置页外观调整一下', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: ANSWER, model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    // 47 分 42 秒：验证头部的分钟进位
    duration_ms: 47 * 60 * 1000 + 42 * 1000,
    blocks: [
      // 开头的思考：流程内的第一行（参考页形态）
      { id: 'b1', type: 'thinking', text: '先看一下现在的实现，再决定改哪几个滑杆。', state: 'done', format: 'raw', startedAt: now - 9000, endedAt: now - 6000 },
      {
        id: 'b2', type: 'tool', toolId: 't1', name: 'Edit', status: 'completed',
        input: { file_path: 'D:/work/demo/app/src/components/SettingsPage.tsx', old_string: OLD, new_string: NEW },
        output: 'The file has been updated.', startedAt: now - 5800, endedAt: now - 5200,
      },
      {
        id: 'b3', type: 'tool', toolId: 't2', name: 'Read', status: 'completed',
        input: { file_path: 'D:/work/demo/app/src/components/SettingsPage.tsx' },
        output: 'export function SettingsPage() {}', startedAt: now - 5000, endedAt: now - 4900,
      },
      {
        id: 'b4', type: 'tool', toolId: 't3', name: 'Bash', status: 'completed',
        input: { command: 'npm run build', description: '构建前端' },
        output: 'built in 2m 12s', startedAt: now - 4800, endedAt: now - 1800,
      },
      // 紧跟工具之后的思考 → 流内兄弟行
      { id: 'b5', type: 'thinking', text: '构建过了，接下来补一个新建文件确认写入路径。', state: 'done', format: 'raw', startedAt: now - 1700, endedAt: now - 1200 },
      {
        id: 'b6', type: 'tool', toolId: 't4', name: 'Write', status: 'completed',
        input: { file_path: 'D:/work/demo/app/src/new.ts', content: lines(30, 'x') },
        output: 'created', startedAt: now - 1100, endedAt: now - 800,
      },
      // 本轮结束仍停在 running → 后台任务
      {
        id: 'b7', type: 'tool', toolId: 't5', name: 'Bash', status: 'running',
        input: { command: 'ls -la' }, output: '', startedAt: now - 700,
      },
      { id: 'b8', type: 'text', text: ANSWER, state: 'done' },
    ],
  },
  { id: 'm3', session_id: 's2', role: 'user', content: '各自看一下', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm4', session_id: 's2', role: 'assistant', content: '我看完了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [
      { id: 'g1', type: 'tool', toolId: 'gt1', name: 'Read', status: 'completed', input: { file_path: '/p/a.ts' }, output: 'x', startedAt: now - 3000, endedAt: now - 2900 },
      { id: 'g2', type: 'text', text: '我看完了。', state: 'done' },
    ],
  },
  {
    id: 'm5', session_id: 's2', role: 'assistant', content: '我也看完了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'hermes', created_at: new Date(now + 1000).toISOString(),
    blocks: [
      { id: 'g3', type: 'tool', toolId: 'gt2', name: 'Bash', status: 'completed', input: { command: 'npm test', description: '跑测试' }, output: 'ok', startedAt: now - 2000, endedAt: now - 1000 },
      // A125：本轮结束了，但这个工具从未报回结果 → 结果未回传（不是 completed / failed）
      {
        id: 'g3b', type: 'tool', toolId: 'gt3', name: 'Bash', status: 'interrupted',
        input: { command: 'npm run dev', description: '起开发服务' },
        startedAt: now - 900, endedAt: now - 400,
      },
      // A125：厂商隐去正文的思考 → 「已隐去」，不伪造内容
      {
        id: 'g3c', type: 'thinking', text: '', state: 'done', format: 'raw', redacted: true,
        startedAt: now - 300, endedAt: now - 200,
      },
      { id: 'g4', type: 'text', text: '我也看完了。', state: 'done' },
    ],
  },
  { id: 'm6', session_id: 's3', role: 'user', content: '扫一遍', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm7', session_id: 's3', role: 'assistant', content: '扫完了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [
      ...Array.from({ length: 16 }, (_, i) => ({
        id: `L${i}`, type: 'tool', toolId: `lt${i}`, name: 'Read', status: 'completed',
        input: { file_path: `/p/src/f${i}.ts` }, output: 'x',
        startedAt: now - 5000 + i * 100, endedAt: now - 4900 + i * 100,
      })),
      { id: 'Ltext', type: 'text', text: '扫完了。', state: 'done' },
    ],
  },
];

const failures = [];
const checks = { total: 0 };
function ok(cond, label, detail) {
  checks.total++;
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

/**
 * 夹具开关：`/api/runs/active` 返回「有后台 run」还是空。
 *
 * [7b] 要用它模拟「用户点了停止，服务端那边这条 run 已经没了」。
 * 放在模块级是因为 route handler 在 Node 侧执行、能闭包到这个变量；
 * a36 各段是串行的（每段 newPage → close），不存在并发串味。
 */
let bgRunsEmpty = false;

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) {
      // 另一个会话（s3）还在跑 → 后台任务 1 个；[7b] 会把它切成空
      if (bgRunsEmpty) return json({ runs: [] });
      return json({ runs: [{ runId: 'r-bg', sessionId: 's3', agentId: 'workbuddy', startedAt: Date.now() - 60000 }] });
    }
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  return { ctx, page };
}

// ============= [1] 头部总耗时 =============
console.log('\n[1] 头部右上角不再有总耗时（2026-11-20 用户拍板移除）');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  ok(
    (await page.locator('[data-msg-duration]').count()) === 0,
    '头部不再渲染总耗时（data-msg-duration 退役）'
  );
  const header = await page.locator('[data-msg-header]').first().innerText();
  ok(!header.includes('已处理'), '头部无「已处理」字样', header.replace(/\n/g, ' '));
  await ctx.close();
}

// ============= [2][3][4][5] 过程流本体（2026-11-22 改版：一轮 = 一条流） =============
console.log('\n[2] 完成态默认收成一条摘要，点摘要线展开步骤流');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  /* 2026-11-22 改版：单聊过程回合整轮交给 ProcessFlow（参考页：一轮 = 一条流）。
     答案在场 → 摘要线默认折叠；旧「答案锚点拆段」路径退役。 */
  ok(
    (await page.locator('[data-flow]').count()) === 1,
    '单聊过程回合渲染成一条流程（不是多段碎片）',
    String(await page.locator('[data-flow]').count())
  );
  ok(
    (await page.locator('[data-steps-bar]').count()) === 0 &&
      (await page.locator('[data-trace-scroll]').count()) === 0,
    '旧 v2 轨迹 DOM 退役（data-steps-bar / data-trace-scroll 不再出现）'
  );

  const summary = page.locator('[data-flow-summary]').first();
  ok(await summary.count() > 0, '摘要线存在（步骤区的折叠开关）');
  ok((await summary.getAttribute('aria-expanded')) === 'false', '完成态默认折叠（aria-expanded=false）');
  ok((await page.locator('[data-flow-steps]').count()) === 0, '折叠态下步骤流不挂载');

  // 收起态才是日常视图（长会话里绝大多数消息都是收起状态），单独留一张图
  await page.screenshot({ path: join(OUT, 'a36-collapsed.png'), fullPage: false });

  await summary.click();
  await page.waitForTimeout(300);
  ok((await summary.getAttribute('aria-expanded')) === 'true', '点摘要线 = 展开步骤流');
  ok((await page.locator('[data-flow-steps]').count()) === 1, '展开后出现步骤流');

  // ---- [3] 整轮时钟：唯一计时口径（服务端盖章 durationMs 优先）----
  const clockMs = Number((await page.locator('[data-flow-clock]').first().getAttribute('data-flow-clock')) ?? 0);
  ok(clockMs === 47 * 60 * 1000 + 42 * 1000, '时钟用服务端盖章的整轮时长（47m42s）', String(clockMs));
  const clockText = (await page.locator('[data-flow-clock]').first().innerText()) ?? '';
  ok(clockText.includes('已处理') && clockText.includes('47 分 42 秒'), '时钟文案「已处理 47 分 42 秒」', clockText);

  const summaryText = ((await summary.innerText()) ?? '').replace(/\n/g, ' ');
  ok(summaryText.includes('改了 2 个文件'), '摘要线：改了 N 个文件（结果语义）', summaryText);
  ok(summaryText.includes('结果未回传'), '摘要线结果档如实（b7 未回传 → 不谎称成功）', summaryText);
  ok(summaryText.includes('6 步'), '步数 = 工具 5 + 思考 1（参考页口径）', summaryText);
  ok(!summaryText.includes('已工作'), '旧「已工作」收纳线文案退役', summaryText);

  const flowPill = page.locator('[data-flow-pill]').first();
  ok((await flowPill.getAttribute('data-flow-pill')) === 'unreturned', '状态胶囊落在「未回传」档（不是已完成）');
  const pillText = ((await flowPill.innerText()) ?? '').trim();
  ok(pillText.includes('结果未回传'), '胶囊文案「结果未回传」', pillText);

  const totalDiff = await page.locator('[data-flow-diff-total]').first().getAttribute('data-flow-diff-total');
  ok(totalDiff === '+139 -16', '摘要线上的汇总 diff 是各步骤之和（+109+30）', String(totalDiff));

  // ---- [4] 步骤行（参考页形态：圆点 + 动词 + 单行内容 + 耗时）----
  const steps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-flow-row][data-flow-row-kind="tool"]')];
    return rows.map(r => ({
      id: r.getAttribute('data-flow-row'),
      verb: r.getAttribute('data-flow-verb'),
      line: r.querySelector('.pf-target')?.textContent ?? '',
      diff: r.querySelector('.pf-diff')?.getAttribute('data-flow-diff') ?? null,
      mono: (() => {
        const el = r.querySelector('.pf-target');
        return el ? getComputedStyle(el).fontFamily.toLowerCase() : '';
      })(),
    }));
  });
  ok(steps.length === 5, '5 个工具步骤各自一行（思考行不算工具步）', String(steps.length));
  const verbs = steps.map(s => s.verb);
  ok(verbs.join(',') === '编辑,已读取,检查,写入,执行', '动作词按工具语义归一', verbs.join(','));
  ok(steps[0].line === 'SettingsPage.tsx', '文件步骤单行显示文件名', steps[0].line);
  ok(steps[2].line === 'npm run build', '命令步骤单行显示命令本身', steps[2].line);
  ok(/mono|consolas|courier/.test(steps[2].mono), '命令用等宽字体', steps[2].mono.split(',')[0]);
  // 参考页口径：target 全等宽（文件名与命令同用 mono，不区分文件族）
  ok(/mono|consolas|courier/.test(steps[0].mono), '所有步骤内容等宽（参考页 target 全等宽）', steps[0].mono.split(',')[0]);
  ok(steps[0].diff === '+109 -16', '编辑行显示真实 diff', String(steps[0].diff));
  ok(steps[1].diff === '±0', '无 diff 数据的文件步骤显示 ±0（不是留空）', String(steps[1].diff));
  ok(steps[3].diff === '+30', '写入行只报新增（不编造删除）', String(steps[3].diff));
  ok(steps[2].diff === null, '非文件步骤不带 diff 位', String(steps[2].diff));

  // ---- 单步耗时：完成步挂真实耗时；未回传给状态词 ----
  const metas = await page.evaluate(() => {
    const out = [];
    for (const step of document.querySelectorAll('[data-flow-row][data-flow-row-kind="tool"]')) {
      out.push({
        id: step.getAttribute('data-flow-row'),
        text: step.querySelector('.pf-meta')?.textContent?.trim() ?? '',
      });
    }
    return out;
  });
  const metaOf = id => metas.find(m => m.id === id) ?? { text: '(missing)' };
  ok(metaOf('t3').text === '3.0s', '3000ms → 3.0s', metaOf('t3').text);
  ok(metaOf('t1').text === '600ms', '<1s 用毫秒口径（600ms）', JSON.stringify(metaOf('t1').text));
  ok(metaOf('t2').text === '100ms', '100ms 同口径', JSON.stringify(metaOf('t2').text));
  ok(metaOf('t5').text === '结果未回传', '未回传行给状态词不给耗时', metaOf('t5').text);

  // ---- 行状态（参考页：圆点颜色 + 行类；v2 的 pin/关键标记退役）----
  const rowStates = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-flow-row][data-flow-row-kind="tool"]')) {
      out.push({ id: el.getAttribute('data-flow-row'), state: el.getAttribute('data-flow-row-state') });
    }
    return out;
  });
  ok(rowStates.find(r => r.id === 't1')?.state === 'done', '完成步 is-done（参考页绿点）');
  ok(rowStates.find(r => r.id === 't5')?.state === 'interrupted', '未回传步 is-interrupted（空心圆，不冒充完成/失败）');
  ok((await page.locator('[data-trace-pin]').count()) === 0, 'v2 关键标记（pin）随旧方案退役');

  // ---- [5] 思考行（参考页：流内兄弟行，点开看思考原文）----
  const thinkRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-flow-row][data-flow-row-kind="thinking"]')].map(n => ({
      id: n.getAttribute('data-flow-row'),
      verb: (n.querySelector('.pf-verb')?.textContent ?? '').trim(),
      inFlow: !!n.closest('[data-flow]'),
      expandable: n.getAttribute('aria-expanded') != null,
    }))
  );
  ok(thinkRows.length === 2, '两条思考都在同一条流程里（开头一条 + 构建后一条）', String(thinkRows.length));
  ok(thinkRows.every(r => r.inFlow), '思考行都在流程内（不回退旧 ThinkingView）');
  ok(thinkRows.every(r => r.verb.includes('深度思考')), '思考行动词是「深度思考」', thinkRows.map(r => r.verb).join(','));
  ok(thinkRows.every(r => !r.verb.includes('字')), '行上不再有字数 chip', thinkRows.map(r => r.verb).join(','));

  // 点开构建后的那条思考：参考页形态 = 左竖线思考原文，不再有「思考全文」面板
  const thinkRow5 = page.locator('[data-flow-row="b5"]');
  await thinkRow5.locator('.pf-step-head').first().click();
  await page.waitForTimeout(300);
  const note = thinkRow5.locator('[data-flow-think-note]').first();
  ok((await note.count()) === 1, '点开后出现思考原文（参考页左竖线形态）');
  ok(((await note.innerText()) ?? '').includes('构建过了'), '思考原文如实展示', ((await note.innerText()) ?? '').slice(0, 40));

  // 整轮归并后，流程之外不应再有游离的思考块
  const outsideThinking = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-flow-row][data-flow-row-kind="thinking"]')].filter(
        el => !el.closest('[data-flow]')
      ).length
  );
  ok(outsideThinking === 0, '流程之外不再有游离的思考块', String(outsideThinking));

  await page.screenshot({ path: join(OUT, 'a36-trace.png'), fullPage: false });
  await ctx.close();
}

// ============= [6] 长步骤流：无分组、无限高容器（参考页形态） =============
console.log('\n[6] 长步骤流：16 行全渲染，分组/限高容器随旧方案退役');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s3', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  ok((await page.locator('[data-trace-group]').count()) === 0, 'v2 同类合并分组随旧方案退役');
  // 夹具有答案文本 → 默认折叠；先展开再数行
  await page.locator('[data-flow-summary]').first().click();
  await page.waitForTimeout(400);
  const rows = await page.locator('[data-flow-row][data-flow-row-kind="tool"]').count();
  ok(rows === 16, '16 个步骤全部渲染（扁平单行）', String(rows));
  ok((await page.locator('[data-trace-scroll]').count()) === 0, 'v2 320px 限高滚动容器退役（参考页步骤流不限高）');

  await page.screenshot({ path: join(OUT, 'a36-fade.png'), fullPage: false });
  await ctx.close();
}

// ============= [7] 后台任务胶囊 =============
console.log('\n[7] 后台任务胶囊');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const pill = page.locator('[data-bg-tasks]').first();
  ok(await pill.count() > 0, '出现后台任务胶囊');
  const text = (await pill.textContent().catch(() => '')) ?? '';
  ok(text.includes('任务未结束'), '文案按来源分档（真 run + 未回结果混在一起时说「未结束」，不谎称「运行中」）', text.trim());
  ok((await pill.getAttribute('data-bg-tasks-runs')) === '1', '来源一：别的会话还在跑的 run = 1');
  ok((await pill.getAttribute('data-bg-tasks-lingering')) === '1', '来源二：本轮未收到完成事件的工具 = 1');
  ok((await pill.getAttribute('data-bg-tasks')) === '2', '两者合并成 2', await pill.getAttribute('data-bg-tasks'));

  await pill.click();
  await page.waitForTimeout(600);
  ok(page.url().includes('/chat/s3'), '点「查看」跳到那个还在跑的会话', page.url().replace(base, ''));

  await ctx.close();
}

// ============= [7b] 停止后 pill 立刻重拉 =============
console.log('\n[7b] 停止后 pill 立即重拉（不等 5 秒轮询）');
{
  bgRunsEmpty = false;
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const pill = page.locator('[data-bg-tasks]').first();
  const runsAttr = async () => ((await pill.count()) ? await pill.getAttribute('data-bg-tasks-runs') : null);
  const r0 = await runsAttr();
  ok(r0 === '1', '初始：后台 run = 1（先证明有东西可减）', String(r0));

  /**
   * 先让轮询跑过一次，把下一次轮询推到约 4.5 秒之后。
   *
   * 不这么做的话，「1.5 秒内数字变了」也可能只是恰好撞上轮询 ——
   * 那就证明不了是 `notifyRunsChanged` 起的作用（假绿）。
   */
  await page.waitForTimeout(5200);

  bgRunsEmpty = true; // 服务端那边这条 run 已经结束（用户点了停止）

  /* 反证：**不派发事件**的 2 秒内，数字必须还是 1。
     没有这一条，「2 秒内变 0」也可能只是轮询恰好撞上（5s 周期里 2s 的窗口
     并非不可能）。先证明「不通知就不会变」，后面那句「通知后 68ms 就变」
     才真的说明是事件起的作用 —— 等价于把监听删掉再跑一次的反向探针，
     但不用重新 build。 */
  await page.waitForTimeout(2000);
  const r1 = await runsAttr();
  ok(r1 === '1', '不派发事件时 2 秒内不会自己更新（轮询还没到）', String(r1));

  const t0 = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event('opc:runs-changed')));
  let changed = true;
  await page
    .waitForFunction(
      () => document.querySelector('[data-bg-tasks]')?.getAttribute('data-bg-tasks-runs') === '0',
      { timeout: 2000 }
    )
    .catch(() => { changed = false; });
  const dt = Date.now() - t0;

  ok(changed, '事件触发后立刻重拉到空列表', `${dt}ms`);
  ok(dt < 2000, '远早于 5s 轮询间隔（证明靠的是事件，不是轮询）', `${dt}ms`);
  // 肯定式：胶囊本身还在（s1 还有 1 个未回结果的工具块），不是整块消失造成的假绿
  ok((await pill.count()) > 0, '胶囊仍在（只有 run 那一项被减掉）');

  /* 文案必须跟着来源变：此时 run 已经没了，只剩 interrupted 块。
     还写「后台任务运行中」就是在说「有个任务还在跑」—— 而它早就结束了，
     而且这个提示永久消不掉（块已落库）。 */
  const onlyLingering = ((await pill.textContent()) ?? '').trim();
  ok(onlyLingering.includes('未回结果'), '只剩工具块时改说「未回结果」，不谎称运行中', onlyLingering);

  bgRunsEmpty = false;
  await ctx.close();
}

// ============= [8] 群聊：每个 Agent 各自一条流程 =============
console.log('\n[8] 群聊：每个 Agent 各自一条流程');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const flows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-flow]')].map(f => {
      const agent = f.closest('div[class*="tc-msg-enter"]')?.querySelector('[data-msg-agent]');
      return { agent: agent?.getAttribute('data-msg-agent') ?? null };
    })
  );
  ok(flows.length === 2, '两条回复各有一条流程', String(flows.length));
  ok(flows[0]?.agent !== flows[1]?.agent, '两条分属不同 Agent（不合并）', `${flows[0]?.agent} / ${flows[1]?.agent}`);
  await ctx.close();
}

// ============= [8b] 结果未回传 / 已隐去（A125） =============
console.log('\n[8b] 结果未回传与已隐去的思考');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 有答案 → 默认折叠：展开两条流程，否则步骤行根本不渲染
  const summaries = page.locator('[data-flow-summary]');
  const n = await summaries.count();
  for (let i = 0; i < n; i++) {
    if ((await summaries.nth(i).getAttribute('aria-expanded')) !== 'true') await summaries.nth(i).click();
  }
  await page.waitForTimeout(400);

  const gt3Row = await page
    .locator('[data-flow-row="gt3"]')
    .first()
    .evaluate(el => ({
      state: el.getAttribute('data-flow-row-state'),
      meta: el.querySelector('.pf-meta')?.textContent?.trim() ?? '',
    }));
  ok(gt3Row.state === 'interrupted', '未回传步挂 is-interrupted（不冒充运行中/完成）', JSON.stringify(gt3Row));
  ok(gt3Row.meta === '结果未回传', '未回传步的行内状态词', gt3Row.meta);

  const flowPill = page.locator('[data-flow-pill="unreturned"]').first();
  ok((await flowPill.count()) > 0, '整轮胶囊落在「结果未回传」档');

  // A125：厂商隐去正文的思考 → 「已隐去」，不可展开（没有点了没反应的空折叠条）
  const red = page.locator('[data-flow-row="g3c"]').first();
  ok((await red.count()) > 0, '被隐去的思考有独立行');
  const redText = ((await red.innerText()) ?? '').trim();
  ok(redText.includes('已隐去'), '标题是「已隐去」', redText);
  ok(!redText.includes('字'), '不显示字数（没有正文可数）', redText);
  ok((await red.locator('[data-flow-think-note]').count()) === 0, '没有点了没反应的空折叠条');
  ok((await red.getAttribute('aria-expanded')) == null, '已隐去行不可展开（无 aria-expanded）');

  await page.screenshot({ path: join(OUT, 'a36-unknown.png'), fullPage: false });
  await ctx.close();
}

// ============= [9] 改版接线（源码级） =============
console.log('\n[9] 改版接线：单聊过程回合走 ProcessFlow（源码级）');
{
  const chat = await readFile(join(ROOT, 'src/components/ChatMessages.tsx'), 'utf8');
  ok(chat.includes('<ProcessFlow'), 'ChatMessages 挂载 ProcessFlow（一轮 = 一条流）');
  ok(chat.includes('durationMs={message.durationMs}'), '流程时钟接服务端盖章的整轮时长');
  ok(chat.includes('procFlowTurn'), '答案锚点拆段路径已被流程回合判定短路');
  const flow = await readFile(join(ROOT, 'src/components/ProcessFlow.tsx'), 'utf8');
  // 剥掉注释再判：封存说明的注释里会**提到**旧方案的名字，那不算借鉴。
  // 用 indexOf 手工剥，不在验证脚本里写正则字面量（转义层次太容易错）。
  const stripComments = src => {
    let out = '';
    let i = 0;
    while (i < src.length) {
      if (src.startsWith('/*', i)) {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? src.length : e + 2;
        continue;
      }
      if (src.startsWith('//', i)) {
        const e = src.indexOf('\n', i);
        i = e < 0 ? src.length : e;
        continue;
      }
      out += src[i];
      i += 1;
    }
    return out;
  };
  const flowCode = stripComments(flow);
  ok(!flowCode.includes('AgentTrace'), 'ProcessFlow 不引用旧 AgentTrace（不借鉴旧版）');
  ok(!flowCode.includes('已工作'), '旧「已工作」口径不回流');
}

// ============= [10] 控制台 =============
console.log('\n[10] 控制台');
{
  const real = errors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  ok(real.length === 0, '无控制台错误', real.slice(0, 3).join(' | ') || '0');
}

await browser.close();
server.close();

console.log(`\n${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
