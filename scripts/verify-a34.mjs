/**
 * A34 三条反馈 + 代码块增强的浏览器验证。
 *
 *   [1] 响应式收口：长代码行不再把整列撑宽，右侧不被裁切
 *   [2] 代码块操作：A55 删按钮后的状态（赞踩 / 复制代码 / 自动换行不在，
 *       助手操作行只剩 复制 / 重新生成 / 分享 / 分支）
 *   [3] 选区工具条：选中文字浮出「复制 / 引用」，引用写进输入框
 *   [4] 打包产物里不再出现「深度求索」
 *   [5] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a34.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
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

const LONG_LINE =
  'OpenMemory — Setup Required | user=default | project=OPC Agent | branch=unknown | auth=expired | token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP';

const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
];

const now = Date.now();
const ANSWER = `这是一段说明文字，用来验证正文能正常折行。\n\n\`\`\`bash\n${LONG_LINE}\n\`\`\`\n\n代码之后还有一段解释，确认代码块不会把后面的内容一起撑出屏幕。`;

const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '给我一段命令', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2',
    session_id: 's1',
    role: 'assistant',
    content: ANSWER,
    model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy',
    created_at: new Date(now).toISOString(),
    blocks: [
      { id: 'b1', type: 'thinking', text: '先看看环境。', state: 'done', format: 'raw', startedAt: now - 5000, endedAt: now - 3000 },
      { id: 'b2', type: 'tool', toolId: 't1', name: 'Bash', status: 'completed', input: { command: 'ls' }, output: 'a\nb', startedAt: now - 2500, endedAt: now - 1300 },
      { id: 'b3', type: 'text', text: ANSWER, state: 'done' },
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

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
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

// ============= [1] 响应式收口 =============
console.log('\n[1] 响应式收口：长代码行不再撑宽整列');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const overflow = await page.evaluate(() => {
    const scroll = document.querySelector('[data-chat-scroll]');
    const list = document.querySelector('.max-w-3xl.mx-auto');
    const answer = document.querySelector('.tc-answer');
    if (!scroll || !list || !answer) return { missing: true };
    const sr = scroll.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    const ar = answer.getBoundingClientRect();
    return {
      missing: false,
      scrollW: scroll.scrollWidth,
      clientW: scroll.clientWidth,
      answerRight: ar.right,
      listRight: lr.right,
      scrollRight: sr.right,
    };
  });
  ok(!overflow.missing, '消息区 / 列表 / 答案块都存在');
  if (!overflow.missing) {
    ok(overflow.scrollW <= overflow.clientW + 1, '消息区没有横向溢出', `scrollWidth ${overflow.scrollW} / clientWidth ${overflow.clientW}`);
    ok(overflow.answerRight <= overflow.listRight + 1, '答案块右缘在列表内', `${Math.round(overflow.answerRight)} ≤ ${Math.round(overflow.listRight)}`);
    ok(overflow.answerRight <= overflow.scrollRight + 1, '答案块右缘在可视区内', `${Math.round(overflow.answerRight)} ≤ ${Math.round(overflow.scrollRight)}`);
  }
  await page.screenshot({ path: join(OUT, 'a34-overflow.png') });
  await ctx.close();
}

// ============= [2] 代码块操作 =============
// A55（用户要求删按钮）：好评 / 差评 / 复制所有代码块 / 代码自动换行四个按钮
// 连同 wrapIds 状态机一起移除。这里断言新状态：按钮不在、.data-wrap 不再出现、
// 助手操作行只剩复制 / 重新生成 / 分享 / 分支。
console.log('\n[2] 代码块：A55 后按钮精简');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  ok(await page.locator('[aria-label="好评"]').count() === 0, '「好评」按钮已移除');
  ok(await page.locator('[aria-label="差评"]').count() === 0, '「差评」按钮已移除');
  ok(await page.locator('[aria-label="复制代码"]').count() === 0, '「复制所有代码块」按钮已移除');
  ok(await page.locator('[aria-label="自动换行"]').count() === 0, '「代码自动换行」按钮已移除');
  ok(await page.locator('[data-code-langs]').count() === 0, '代码语言小字（已随按钮组移除）');
  ok(await page.locator('.chat-markdown[data-wrap]').count() === 0, '不再有 data-wrap 属性');

  // 助手操作行剩下的按钮：复制 / 重新生成 / 分享 / 分支（本夹具四个都接线了）
  const kept = await page.evaluate(() => {
    const row = document.querySelector('.tc-actions:not([data-user-actions])');
    return row ? Array.from(row.querySelectorAll('[aria-label]')).map(b => b.getAttribute('aria-label')) : [];
  });
  ok(
    kept.join(',') === '复制回答,重新生成,分享,分支',
    '助手操作行只剩 复制/重新生成/分享/分支',
    kept.join(',')
  );

  // B3：工具卡耗时（夹具里 Bash 跑了 1200ms）
  const dur = await page.locator('text=1.2s').count();
  ok(dur > 0, '工具卡显示耗时 1.2s', String(dur));

  await ctx.close();
}

// ============= [3] 选区工具条 + 引用 =============
console.log('\n[3] 选区工具条：复制 / 引用');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const picked = await page.evaluate(() => {
    const host = document.querySelector('.chat-markdown t-chat-md-content');
    const sr = host && host.shadowRoot;
    if (!sr) return { ok: false, reason: 'no shadowRoot' };
    const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
    let node = null;
    while ((node = walker.nextNode())) {
      if ((node.textContent || '').trim().length > 10) break;
    }
    if (!node) return { ok: false, reason: 'no text node' };
    const raw = node.textContent;
    const lead = raw.length - raw.trimStart().length;
    const len = Math.min(10, raw.trim().length);
    const range = document.createRange();
    range.setStart(node, lead);
    range.setEnd(node, lead + len);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rect = range.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + 4, clientY: rect.top + 4 }));
    return { ok: true, text: sel.toString(), rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
  });
  ok(picked.ok, '能在 markdown shadow DOM 里建立选区', picked.reason || `「${picked.text}」`);

  await page.waitForTimeout(200);
  const bar = page.locator('[data-selection-toolbar]');
  ok(await bar.count() === 1, '选区工具条出现');

  if (await bar.count() === 1) {
    const labels = await bar.locator('button').allTextContents();
    ok(labels.some(t => t.includes('复制')), '工具条有「复制」', labels.join(' | '));
    ok(labels.some(t => t.includes('引用')), '工具条有「引用」', labels.join(' | '));

    await bar.locator('button', { hasText: '引用' }).click();
    await page.waitForTimeout(250);
    ok(await page.locator('[data-selection-toolbar]').count() === 0, '点「引用」后工具条收起');

    const inputValue = await page.evaluate(() => {
      const deep = (root, sel) => {
        if (root.querySelector) {
          const found = root.querySelector(sel);
          if (found) return found;
        }
        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of all) {
          if (el.shadowRoot) {
            const r = deep(el.shadowRoot, sel);
            if (r) return r;
          }
        }
        return null;
      };
      const ta = deep(document, 'textarea');
      return ta ? ta.value : null;
    });
    ok(typeof inputValue === 'string' && inputValue.includes('>'), '引用写进了输入框（含 > 引用符）', JSON.stringify(inputValue));
    ok(typeof inputValue === 'string' && inputValue.includes(picked.text.slice(0, 4)), '引用内容与选中的文字一致');
  }

  await page.screenshot({ path: join(OUT, 'a34-selection.png') });
  await ctx.close();
}

// ============= [4] 产物里不再有「深度求索」 =============
console.log('\n[4] 打包产物不再含「深度求索」');
{
  const assets = await readdir(join(DIST, 'assets'));
  let hit = null;
  for (const f of assets.filter(f => f.endsWith('.js'))) {
    const s = await readFile(join(DIST, 'assets', f), 'utf8');
    if (s.includes('深度求索')) { hit = f; break; }
  }
  ok(!hit, 'dist/assets 里没有「深度求索」', hit || 'clean');
}

// ============= [5] 控制台 =============
console.log('\n[5] 控制台');
ok(errors.length === 0, '没有 console.error / pageerror', errors.slice(0, 3).join(' | ') || '0');

await browser.close();
server.close();

console.log(`\n=== ${checks.total - failures.length}/${checks.total} 通过 ===`);
if (failures.length) {
  console.log('失败：' + failures.join(' / '));
  process.exit(1);
}
