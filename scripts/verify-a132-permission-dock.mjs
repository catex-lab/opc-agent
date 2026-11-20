/**
 * A132 审批卡（2026-11-18 起为消息流内嵌形态）的浏览器打靶 ——
 * 第一层：卡片真的落到了页面上，且命令整段可读。
 *
 * 为什么这一层必须真开浏览器：只看源码（甚至只看 jsdom）都证明不了「用户能看见」。
 * 而「命令被截成省略号」这类缺陷恰恰只在有宽度约束的真实布局里才出现 ——
 * 一条 260 字符的 PowerShell 命令必然折行，`text-overflow: ellipsis` 在真机上
 * 表现为「看起来完整、实际少了半条命令」，用户点允许时并不知道自己批了什么。
 *
 * 本脚本刻意**不写死像素**：4 行的上限由 `--text-secondary × 1.5 × 4` 算出来，
 * 断言改成「量到的行数恰好 4」+「确实被裁」。改字号令牌时闸门跟着走，不会假红。
 *
 * 运行：npm run build && node scripts/verify-a132-permission-dock.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a132');
import { resolveChromePath } from './lib/chrome.mjs';
const CHROME = resolveChromePath();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

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
const eq = (actual, expected, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

const SDK_OPTIONS = [
  { id: 'reject_once', kind: 'reject_once', label: '拒绝' },
  { id: 'reject_always', kind: 'reject_always', label: '本会话始终拒绝', note: '本会话内不再询问这个工具；应用重启后失效' },
  { id: 'allow_once', kind: 'allow_once', label: '允许' },
  { id: 'allow_always', kind: 'allow_always', label: '本会话始终允许', note: '本会话内这个工具不再询问；高危操作仍会被门禁拦截' },
];

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    eventCapabilities: ['thinking', 'tool', 'permission'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes',
    color: '#7C5CFF', description: '长任务编排', capabilities: ['chat'],
    eventCapabilities: ['thinking', 'tool', 'permission'],
    status: { availability: 'ready', version: '0.9.0' },
    permissionSupport: { enforced: ['default'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'direct', agent_ids: null, orchestration: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
  },
  {
    id: 's2', title: '研发小组', agent_id: null, model: null,
    kind: 'group', agent_ids: '["workbuddy","hermes"]', orchestration: 'relay',
    created_at: new Date(Date.now() - 60000).toISOString(),
  },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '清理构建目录', created_at: new Date(Date.now() - 60000).toISOString() },
  { id: 'm2', session_id: 's2', role: 'user', content: '群里跑一下', created_at: new Date(Date.now() - 60000).toISOString() },
];

const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, p === '/' ? 'index.html' : p);
  let body;
  try { body = await readFile(file); } catch {
    file = join(DIST, 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const consoleErrors = [];

/**
 * @param {object[]} frames  要下发的 SSE 帧（不含收尾的 done，由这里补）——
 *                           队列场景需要两条待授权并存，所以是数组而不是单条
 * @param {{ group?: boolean }} opts  group=true 时让 /api/group-chat 也能发
 */
async function newPage(frames, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const posts = [];
  const streamBody = sse([...frames, { type: 'done' }]);

  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (url.includes('/api/permission-response')) {
      try { posts.push(req.postDataJSON()); } catch { posts.push(null); }
      // 允许夹具改状态码：404 = 服务端已经没有这条了（超时/别处已兑现），
      // 这正是「看到 ≠ 发生」的现场，必须能造出来
      if (opts.ackStatus && opts.ackStatus !== 200) {
        return route.fulfill({
          status: opts.ackStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: opts.ackError ?? '权限请求不存在或已超时' }),
        });
      }
      return json({ success: true, agentId: 'workbuddy' });
    }
    if (url.includes('/api/group-chat')) {
      if (!opts.group) return json({ error: 'unexpected' });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamBody });
    }
    if (url.includes('/api/chat')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamBody });
    }
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({
        session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0],
        messages: MESSAGES.filter(m => m.session_id === id),
      });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });

  return { ctx, page, posts };
}

async function sendMessage(page) {
  const ta = page.locator('textarea').first();
  await ta.fill('执行一下');
  await page.waitForTimeout(120);
  await page
    .locator('t-chat-sender button, [class*="chat-input__actions"] button')
    .last()
    .click({ timeout: 5000 });
  // 等的是「有一个答复按钮出现」而不是「卡片宿主出现」：这一步要证明的是
  // 请求真的被前端收到并渲染成可操作的卡，宿主没接线时它无从出现，
  // 后面的断言才会因为「卡片不在消息流里」而红 —— 这样红的原因才是准的。
  await page.waitForSelector('[data-permission-option]', { timeout: 8000 });
  await page.waitForTimeout(250);
}

// ============= [1] 卡片内嵌在消息流里，命令整段可读 =============
console.log('\n[1] 审批卡内嵌在消息流（输入框完整可见），长命令默认 4 行且不丢字');
{
  // 800 个 x：卡片在消息列里比原 360px 浮层宽得多（720px 列），
  // 200 个 x 只折 3 行 —— 数量按「720px 宽 × 12px 字号」校准，保证必超 4 行
  const LONG = `$root = "C:\\$Recycle.Bin"; Get-ChildItem -Force -Directory | ForEach-Object { ${'x'.repeat(800)} }`;

  const { ctx, page } = await newPage([
    {
      type: 'permission_request', requestId: 'q1', toolUseId: 't1', toolName: 'Bash',
      input: { command: LONG }, risk: 'risky', rule: '递归遍历系统目录', options: SDK_OPTIONS,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  ]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const dockCount = await page.locator('[data-permission-dock]').count();
  ok(dockCount === 1, '审批卡宿主恰有一个（内嵌在消息流里）', `count=${dockCount}`);

  // P-1 的核心：卡片是文档流里的一张卡，不是 fixed 浮层；且长在消息列表容器内。
  // 输入框在 shadow root 里（document.querySelectorAll 穿不透），几何一律走
  // Playwright locator（默认穿透 open shadow root）量。
  const shape = await (async () => {
    const dockBox = await page.locator('[data-permission-dock]').first().boundingBox();
    const taBox = await page.locator('textarea').first().boundingBox();
    const position = await page.evaluate(() => getComputedStyle(document.querySelector('[data-permission-dock]')).position);
    const inMsgList = await page.evaluate(() => !!document.querySelector('[data-permission-dock]')?.closest('[data-msg-list]'));
    return {
      position,
      inMsgList,
      taBox,
      // 「输入框完整可见」的可观测量：卡片不遮输入框 —— 两者在竖直方向不相交
      overlap: !!dockBox && !!taBox && dockBox.top < taBox.bottom && dockBox.bottom > taBox.top,
    };
  })();
  ok(shape.position !== 'fixed', '卡片不是 fixed 浮层（内嵌形态）', `position=${shape.position}`);
  ok(shape.inMsgList, '卡片长在消息列表容器内（data-msg-list 后代）');
  ok(!!shape.taBox && shape.taBox.height > 0, '输入框在文档里且可见', JSON.stringify(shape.taBox));
  ok(!shape.overlap, 'P-1：输入框完整可见（卡片与输入框不相交）');

  const card = page.locator('[data-permission-card="q1"]');
  const cardCount = await card.count();
  const visible = cardCount > 0 && (await card.first().isVisible());
  ok(visible, '消息流里的审批卡可见', `count=${cardCount}`);

  if (!visible) {
    // 不是「优雅跳过」：卡片不在页面上就是没做到，必须记红
    ok(false, '命令整段在 DOM 里，没有被截成省略号', '卡片未渲染，无从测量');
    ok(false, '默认最多 4 行，不是一眼望不到头', '卡片未渲染，无从测量');
    ok(false, '超出 4 行的命令有「展开全部」', '卡片未渲染，无从测量');
  } else {
    const cmd = page.locator('[data-permission-card="q1"] [data-permission-cmd]');
    const shown = await cmd.innerText();
    ok(shown.includes('x'.repeat(800)), '命令整段在 DOM 里，没有被截成省略号', `尾部 ${shown.slice(-12)}`);

    // 4 行上限从令牌算：--text-secondary × line-height 1.5 × 4，加 padding。
    // 不写 78/94 这种魔数 —— 改字号时这里要跟着算出来才对。
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-permission-card="q1"] [data-permission-cmd]');
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return {
        h: el.getBoundingClientRect().height,
        lh,
        pad,
        // scrollHeight > clientHeight 才算真裁住；只判高度可能「恰好没超」
        clipped: el.scrollHeight > el.clientHeight + 1,
      };
    });
    ok(m.clipped, '命令确实超出可视区、被收起来了', `scrollHeight 大于可视高度`);
    const lines = (m.h - m.pad) / m.lh;
    ok(
      Math.abs(lines - 4) < 0.35,
      '默认恰好 4 行，不是一眼望不到头',
      `${lines.toFixed(2)} 行（高 ${Math.round(m.h)}px / 行高 ${m.lh}px / 内边距 ${m.pad}px）`
    );

    // P-4：长命令才渲染「展开全部」；[6] 的短命令卡里这颗按钮必须缺席
    ok(
      (await page.locator('[data-permission-card="q1"] [data-permission-cmd-toggle]').count()) === 1,
      '超出 4 行的命令有「展开全部」'
    );
  }

  await page.screenshot({ path: join(OUT, 'dock-long-command.png'), fullPage: false });

  // 决策按钮在消息列宽度里排得下吗？排不下会换行（flex-wrap），但绝不允许
  // 横向溢出把最右一颗裁掉 —— 那颗还是权限最大的「永久允许」。
  const fit = await page.evaluate(() => {
    const dock = document.querySelector('[data-permission-dock]');
    const btns = [...document.querySelectorAll('[data-permission-option]')];
    const dr = dock.getBoundingClientRect();
    const last = btns[btns.length - 1]?.getBoundingClientRect();
    return {
      dockRight: dr.right,
      lastRight: last ? last.right : dr.right,
      clipped: dock.scrollWidth - dock.clientWidth,
    };
  });
  ok(
    fit.lastRight <= fit.dockRight - 4,
    '最右一颗按钮没有顶到卡片边缘（不被裁掉）',
    `右缘 ${Math.round(fit.lastRight)} / 卡片 ${Math.round(fit.dockRight)}`
  );
  eq(fit.clipped, 0, '卡片内容没有横向溢出（scrollWidth 等于 clientWidth）');

  await ctx.close();
}

// ============= [2] 切走会话：卡不串台，角标 + 预览提醒 =============
console.log('\n[2] 切走会话后：卡留在自己的会话流里，列表用角标 + 「等待授权」预览提醒');
{
  const { ctx, page } = await newPage([
    {
      type: 'permission_request', requestId: 'q1', toolUseId: 't1', toolName: 'Bash',
      input: { command: 'rm -rf build' }, risk: 'dangerous', rule: '删除目录', options: SDK_OPTIONS,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  ]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  // 切到另一个会话。**必须真的切走**，否则「切走之后」这句话根本没被验证 ——
  // 所以下面用 URL 自证，不靠「点了就假定切了」。
  await page.locator('[data-conversation-item="s2"]').click();
  await page.waitForTimeout(400);
  ok(page.url().includes('/chat/s2'), '确实切到了另一个会话', page.url().split('/chat/')[1] ?? page.url());

  // 内嵌形态（2026-11-18）：一张卡只属于它自己的会话流。q1 是 s1 的请求，
  // 不许串台画进 s2 的消息流里 —— 那正是「以为批的是眼前这个会话」的旧缺陷反面。
  const there = await page.locator('[data-permission-card="q1"]').count();
  ok(there === 0, 's1 的审批卡不串台进当前会话（s2）的消息流', `count=${there}`);

  const badge = await page.locator('[data-permission-waiting="s1"]').count();
  ok(badge === 1, '被切走的会话项上有「等授权」角标', `count=${badge}`);

  // P-5：列表预览不再说「还没有消息」，而是「等待授权：{工具} {命令}」——
  // 角标说「要你动手」，预览说「动什么」。
  const preview = await page.locator('[data-conversation-item="s1"]').innerText();
  ok(/等待授权/.test(preview) && /rm -rf build/.test(preview),
    'P-5：s1 的预览是「等待授权：执行命令 rm -rf build」',
    preview.replace(/\s+/g, ' ').slice(0, 60));

  await page.screenshot({ path: join(OUT, 'dock-cross-session.png'), fullPage: false });
  await ctx.close();
}

// ============= [3] 队列：两条并存，一次只画队首 =============
console.log('\n[3] 两条待授权并存，后来的不顶掉前面的');
{
  const mk = (id, cmd) => ({
    type: 'permission_request', requestId: id, toolUseId: 't-' + id, toolName: 'Bash',
    input: { command: cmd }, risk: 'risky', options: SDK_OPTIONS,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  const { ctx, page, posts } = await newPage([mk('q1', 'npm run build'), mk('q2', 'npm test')]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  eq(await page.locator('[data-permission-card]').count(), 1, '[验收 1] 一次只画队首一张');
  const count = await page.locator('[data-permission-queue-count]').innerText();
  ok(/还有 1 条待授权/.test(count.trim()), '[验收 1] 其余折成一行计数说明', count.trim());
  eq(await page.locator('[data-permission-card="q1"]').count(), 1, '队首是先来的那条（组内先来先批）');

  // 答掉队首 → 队列必须往前顶，而不是留个空壳
  await page.locator('[data-permission-card="q1"] [data-permission-option="allow_once"]').click();
  await page.waitForTimeout(300);
  eq(await page.locator('[data-permission-card="q2"]').count(), 1, '答掉队首后第二条顶上来');
  eq(await page.locator('[data-permission-queue-count]').count(), 0, '只剩一条时不再画计数行');
  eq(posts[0]?.requestId, 'q1', '答复发的是队首那条的 requestId');

  await ctx.close();
}

// ============= [4] 键盘：Esc 零请求，Enter 才答复 =============
console.log('\n[4] 快捷键：Esc 不发答复，Enter 才是「仅本次允许」');
{
  const { ctx, page, posts } = await newPage([
    {
      type: 'permission_request', requestId: 'q1', toolUseId: 't1', toolName: 'Bash',
      input: { command: 'rm -rf build' }, risk: 'dangerous', options: SDK_OPTIONS,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  ]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  const before = posts.length;
  // 内嵌卡没有「收起」态：Esc 不再有关掉任何东西的职责，但它**依然不许**变成答复。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  eq(await page.locator('[data-permission-card]').count(), 1, '[验收 4] Esc 后卡仍在（内嵌卡没有收起态）');
  eq(posts.length, before, '[验收 4] Esc 没有发出任何 /api/permission-response');

  // 焦点在输入框里按 Enter：那是「发送消息」，绝不能变成「批准命令」
  await page.locator('textarea').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  eq(posts.length, before, '[验收 4b] 焦点在输入框时 Enter 不答复（打字打一半不会把命令批了）');

  // 焦点在卡上（非按钮）时 Enter = 队首的第一档 allow
  await page.locator('[data-permission-card="q1"]').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  eq(posts.length, before + 1, '[验收 11] Enter 发出了一次答复');
  eq(posts[posts.length - 1]?.optionId, 'allow_once', '[验收 11] ↵ 命中第一个 allow_* 档，不是 allow_always');

  await ctx.close();
}

// ============= [5] 内嵌卡不是浮层：点正文没有任何「关闭」语义 =============
console.log('\n[5] 点消息区不会「关掉」审批卡（没有「点外面」这种答复），也不再是 overlay');
{
  const { ctx, page } = await newPage([
    {
      type: 'permission_request', requestId: 'q1', toolUseId: 't1', toolName: 'Bash',
      input: { command: 'npm test' }, risk: 'risky', options: SDK_OPTIONS,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  ]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  // 用真实鼠标坐标，并用 elementFromPoint 自证「这一下确实点在卡片外面」——
  // 否则「点外面没关闭」可能只是因为压根没点在外面。
  const probe = await page.evaluate(() => {
    const el = document.elementFromPoint(300, 300);
    return { inDock: !!el?.closest('[data-permission-dock]'), tag: el?.tagName ?? '' };
  });
  ok(!probe.inDock, '自证：坐标 (300,300) 落在卡片之外', `命中 ${probe.tag}`);
  await page.mouse.click(300, 300);
  await page.waitForTimeout(200);
  ok(await page.locator('[data-permission-card]').isVisible(), '[验收 5] 点正文后审批卡仍在');
  eq(await page.locator('[data-permission-dock]').count(), 1, '[验收 10] 卡片宿主哨兵仍在');
  // 内嵌卡不是 overlay：不再带 data-opc-overlay 哨兵（2026-11-18 起浮层退役）
  eq(await page.locator('[data-permission-dock][data-opc-overlay]').count(), 0,
    '内嵌卡不再带 data-opc-overlay 哨兵（不是浮层）');

  await ctx.close();
}

// ============= [6] 没有超时写「等待你的决定」；404 不静默丢项 =============
console.log('\n[6] ACP 无 expiresAt → 「等待你的决定」（P-3）；404 → 卡留下并说明原因');
{
  const { ctx, page } = await newPage([
    {
      // ACP 那种只有 always 档、也没有超时兜底的形态
      type: 'permission_request', requestId: 'acp1', toolUseId: 't1', toolName: 'Bash',
      input: { command: 'ls' }, risk: 'safe',
      options: [{ id: 'o1', kind: 'allow_always', label: '允许' }],
    },
  ]);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);
  const text = await page.locator('[data-permission-card="acp1"]').innerText();
  ok(/等待你的决定/.test(text), '[验收 7] 没下发 expiresAt 就写「等待你的决定」，不伪造倒计时也不写「无超时」', text.replace(/\s+/g, ' ').slice(0, 40));
  ok(!/无超时/.test(text), '[验收 7] 「无超时」字样不再出现（P-3）');
  // P-4 的另一面：单行命令装得下，「展开全部」不许出现（有地方可展开的假话不说）
  eq(await page.locator('[data-permission-card="acp1"] [data-permission-cmd-toggle]').count(), 0,
    'P-4：装得下的命令不渲染「展开全部」');
  await ctx.close();
}
{
  const { ctx, page } = await newPage([
    {
      type: 'permission_request', requestId: 'q9', toolUseId: 't1', toolName: 'Bash',
      input: { command: 'npm run build' }, risk: 'risky', options: SDK_OPTIONS,
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
  ], { ackStatus: 404 });
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await sendMessage(page);

  await page.locator('[data-permission-card="q9"] [data-permission-option="allow_once"]').click();
  await page.waitForTimeout(200);
  const text = await page.locator('[data-permission-card="q9"]').innerText();
  ok(/过期/.test(text), '[验收 6] 404 不静默清卡，明说「这条没生效」', text.replace(/\s+/g, ' ').slice(0, 60));
  // 1.5s 后自动摘掉：留着是提示，永远留着就是垃圾
  await page.waitForTimeout(1800);
  eq(await page.locator('[data-permission-card="q9"]').count(), 0, '[验收 6] 提示看完自动消失');

  // 这一段**故意**制造 404（验的就是「404 时卡片不静默消失」），浏览器必然
  // 在控制台留一条 resource 404。只精确摘掉这一条，其余错误照旧上报 ——
  // 整段清空等于把「这段里发生的真错误」一起放过。
  for (let i = consoleErrors.length - 1; i >= 0; i--) {
    if (/Failed to load resource.*404/.test(consoleErrors[i])) consoleErrors.splice(i, 1);
  }

  await ctx.close();
}

// ============= [7] 控制台 =============
console.log('\n[7] 控制台');
{
  const real = consoleErrors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  ok(real.length === 0, '无控制台错误', real.slice(0, 3).join(' | ') || '0');
}

await browser.close();
server.close();

console.log(`\nA132 审批卡内嵌形态（第 1 层）：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
