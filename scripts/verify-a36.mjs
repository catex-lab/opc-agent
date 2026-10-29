/**
 * A36 执行轨迹的浏览器验证。
 *
 *   [1] 头部「已处理 47m42s」
 *   [2] 完成态默认收起；点开才出现步骤
 *   [3] 活动摘要：动词 + 冒号 + 文件名
 *   [4] 步骤行：动词 / 等宽文件名 / diff（+109 -16、+30、±0）
 *   [5] 思考节点缩进挂在上一个步骤下，保留字数与秒数
 *   [6] 长轨迹：限高 + 底部渐隐
 *   [7] 后台任务胶囊：数量合并两个来源，点「查看」跳会话
 *   [8] 群聊：每个 Agent 各自一段轨迹
 *   [9] 控制台无错误
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
      // 开头的思考：没有可挂的父级 → 不进轨迹，仍走 ThinkingView
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
      // 紧跟工具之后的思考 → 嵌套到 t3 下面
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
console.log('\n[1] 头部「已处理 47m42s」');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const dur = await page.locator('[data-msg-duration]').first().textContent().catch(() => null);
  ok(!!dur, '头部有总耗时', dur ?? '缺失');
  ok((dur ?? '').includes('已处理 47m42s'), '分钟进位正确（47m42s，不是 2862.4s）', dur ?? '');
  const header = await page.locator('[data-msg-header]').first().innerText();
  ok(header.includes('已处理'), '耗时在消息头部那一行里', header.replace(/\n/g, ' '));
  await ctx.close();
}

// ============= [2][3][4][5] 轨迹本体 =============
console.log('\n[2] 完成态默认收起，点开才出现步骤');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const bar = page.locator('[data-steps-bar]').first();
  ok(await bar.count() > 0, '存在轨迹汇总行');
  ok((await bar.getAttribute('aria-expanded')) === 'false', '完成态默认收起（aria-expanded=false）');
  ok((await page.locator('[data-trace-scroll]').count()) === 0, '收起时步骤不渲染');

  // 收起态才是日常视图（长会话里绝大多数消息都是收起状态），单独留一张图
  await page.screenshot({ path: join(OUT, 'a36-collapsed.png'), fullPage: false });

  await bar.click();
  await page.waitForTimeout(300);
  ok((await bar.getAttribute('aria-expanded')) === 'true', '点击后展开');
  ok((await page.locator('[data-trace-scroll]').count()) === 1, '展开后出现步骤容器');

  // ---- [3] 活动摘要 ----
  const summary = await page.locator('[data-trace-summary]').first().innerText();
  ok(summary.includes('编辑') && summary.includes('已读取') && summary.includes('检查'), '摘要含多个动作词', summary);
  ok(summary.includes('SettingsPage.tsx'), '摘要按文件聚合（列出文件名）', summary);
  ok(summary.includes('、') && summary.includes('：'), '摘要结构 = 动词、动词：文件', summary);

  // ---- [4] 步骤行 ----
  const steps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-tool-step]')];
    return rows.map(r => ({
      verb: r.getAttribute('data-trace-verb'),
      target: r.querySelector('.tc-trace-target')?.textContent ?? '',
      diff: r.querySelector('.tc-diff')?.getAttribute('data-diff') ?? null,
      dot: !!r.querySelector('.tc-step-dot'),
      mono: (() => {
        const el = r.querySelector('.tc-trace-target');
        return el ? getComputedStyle(el).fontFamily.toLowerCase() : '';
      })(),
    }));
  });
  ok(steps.length === 5, '5 个步骤各自一行', String(steps.length));
  const verbs = steps.map(s => s.verb);
  ok(verbs.join(',') === '编辑,已读取,检查,写入,执行', '动作词按工具语义归一', verbs.join(','));
  ok(steps.every(s => s.dot), '每行都有状态圆点');
  ok(steps[0].target === 'SettingsPage.tsx', '目标显示文件名', steps[0].target);
  ok(/mono|consolas|courier/.test(steps[0].mono), '文件名用等宽字体', steps[0].mono.split(',')[0]);
  ok(steps[0].diff === '+109 -16', '编辑行显示真实 diff', String(steps[0].diff));
  ok(steps[1].diff === '±0', '无 diff 数据的文件步骤显示 ±0（不是留空）', String(steps[1].diff));
  ok(steps[3].diff === '+30', '写入行只报新增（不编造删除）', String(steps[3].diff));
  ok(steps[2].diff === null, '非文件步骤不带 diff 位', String(steps[2].diff));

  const totalDiff = await page.locator('[data-diff-total]').first().getAttribute('data-diff-total');
  ok(totalDiff === '+139 -16', '汇总行是各步骤之和（+109+30）', String(totalDiff));

  // ---- [5] 嵌套思考 ----
  const nest = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-trace-thinking]')];
    if (nodes.length !== 1) return { count: nodes.length };
    const n = nodes[0];
    const step = n.closest('[data-tool-step]');
    const summaryEl = n.querySelector('.tc-thinking > summary');
    const nestedBox = n.getBoundingClientRect();
    const headBox = step?.querySelector('.tc-step-head')?.getBoundingClientRect();
    return {
      count: 1,
      parentVerb: step?.getAttribute('data-trace-verb') ?? null,
      text: summaryEl?.textContent ?? '',
      indent: headBox ? nestedBox.left - headBox.left : null,
      border: n ? getComputedStyle(n).borderLeftStyle : '',
    };
  });
  ok(nest.count === 1, '开头的思考不进轨迹，只有紧跟工具的那条嵌套', String(nest.count));
  ok(nest.parentVerb === '检查', '思考挂在对应步骤（构建）下面', String(nest.parentVerb));
  ok((nest.text ?? '').includes('深度思考'), '嵌套节点标题是「深度思考」', nest.text ?? '');
  ok((nest.text ?? '').includes('字'), '保留字数（用户口径：保留）', nest.text ?? '');
  ok((nest.text ?? '').includes('s'), '保留秒数', nest.text ?? '');
  ok((nest.indent ?? 0) > 8, '嵌套节点有缩进', `${Math.round(nest.indent ?? 0)}px`);
  ok(nest.border === 'solid', '嵌套节点带连接线', nest.border);

  // 开头的思考仍在轨迹之外（老观感不变）
  const outsideThinking = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.tc-thinking')];
    return all.filter(el => !el.closest('[data-trace]')).length;
  });
  ok(outsideThinking === 1, '开头的思考仍在轨迹之外单独渲染', String(outsideThinking));

  await page.screenshot({ path: join(OUT, 'a36-trace.png'), fullPage: false });
  await ctx.close();
}

// ============= [6] 长轨迹：限高 + 渐隐 =============
console.log('\n[6] 长轨迹：限高 320px + 底部渐隐');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s3', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('[data-steps-bar]').first().click();
  await page.waitForTimeout(400);

  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-trace-scroll]');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      missing: false,
      maxHeight: cs.maxHeight,
      fade: el.getAttribute('data-fade'),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      mask: cs.maskImage || cs.webkitMaskImage || '',
    };
  });
  ok(!box.missing, '长轨迹有滚动容器');
  if (!box.missing) {
    ok(box.maxHeight === '320px', '限高 320px', box.maxHeight);
    ok(box.scrollHeight > box.clientHeight, '内容确实溢出（可滚动）', `${box.scrollHeight} > ${box.clientHeight}`);
    ok(box.fade === '1', '溢出时挂上渐隐标记', String(box.fade));
    ok(/gradient/.test(box.mask), '底部是渐变遮罩（不是硬切）', box.mask.slice(0, 40));
  }
  const count = await page.locator('[data-tool-step]').count();
  ok(count === 16, '16 个步骤全部渲染', String(count));

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

// ============= [8] 群聊：每个 Agent 各自一段 =============
console.log('\n[8] 群聊：每个 Agent 各自一段轨迹');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const traces = await page.evaluate(() =>
    [...document.querySelectorAll('[data-trace]')].map(t => {
      const msg = t.closest('[data-msg-header]') ? t.parentElement?.closest('div') : null;
      const agent = t.closest('div[class*="tc-msg-enter"]')?.querySelector('[data-msg-agent]');
      return { agent: agent?.getAttribute('data-msg-agent') ?? null, msg: !!msg };
    })
  );
  ok(traces.length === 2, '两条回复各有一段轨迹', String(traces.length));
  ok(traces[0]?.agent !== traces[1]?.agent, '两段分属不同 Agent（不合并）', `${traces[0]?.agent} / ${traces[1]?.agent}`);
  await ctx.close();
}

// ============= [8b] 结果未回传 / 已隐去（A125） =============
console.log('\n[8b] 结果未回传与已隐去的思考');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 完成态默认收起：先展开两条轨迹，否则步骤行根本不渲染
  const bars = page.locator('[data-steps-bar]');
  const barCount = await bars.count();
  for (let i = 0; i < barCount; i++) {
    if ((await bars.nth(i).getAttribute('aria-expanded')) !== 'true') await bars.nth(i).click();
  }
  await page.waitForTimeout(400);

  const chip = page.locator('[data-trace-status="interrupted"]').first();
  ok((await chip.count()) > 0, '出现「结果未回传」标记');
  ok(((await chip.textContent()) ?? '').trim() === '结果未回传', '文案是「结果未回传」', ((await chip.textContent()) ?? '').trim());

  // 设计稿数值：18px 高 / 10.8px 字 / 4px 圆角。字号被现有样式带跑会立刻红。
  const chipStyle = await chip.evaluate(el => {
    const s = getComputedStyle(el);
    return { h: s.height, fs: s.fontSize, br: s.borderTopLeftRadius };
  });
  ok(chipStyle.h === '18px', '胶囊高 18px（设计稿）', chipStyle.h);
  ok(chipStyle.fs === '10.8px', '胶囊字号 10.8px（设计稿）', chipStyle.fs);
  ok(chipStyle.br === '4px', '胶囊圆角 4px（设计稿）', chipStyle.br);

  const dotStyle = await page
    .locator('[data-tool-step="gt3"] .tc-step-dot')
    .first()
    .evaluate(el => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow };
    });
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(dotStyle.bg), '未回传的圆点不填状态色', dotStyle.bg);
  ok(dotStyle.shadow.includes('inset'), '空心圈用 inset 描边表达', dotStyle.shadow);

  // 汇总行也不许画绿勾：这一轮结束 ≠ 全部成功
  ok(
    (await page.locator('.tc-unknown-dot').count()) === 1,
    '汇总行用空心圈而不是绿勾（只有 hermes 这条有未回传）',
    String(await page.locator('.tc-unknown-dot').count())
  );

  const red = page.locator('[data-trace-thinking] [data-redacted="1"]').first();
  ok((await red.count()) > 0, '被隐去的思考有独立标记');
  const redText = ((await red.textContent()) ?? '').trim();
  ok(redText.includes('已隐去'), '标题是「已隐去」', redText);
  ok(!redText.includes('字'), '不显示字数（没有正文可数）', redText);
  ok((await red.locator('details').count()) === 0, '没有点了没反应的空折叠条');

  await page.screenshot({ path: join(OUT, 'a36-unknown.png'), fullPage: false });
  await ctx.close();
}

// ============= [9] 控制台 =============
console.log('\n[9] 控制台');
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
