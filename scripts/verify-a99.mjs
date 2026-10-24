/**
 * A99 文件核对的浏览器验证。
 *
 *   [1] 改过文件的消息下面出现「文件核对」条，默认是**未核对**
 *   [2] 默认不读盘（没展开就不发请求）—— 一个会话几十条消息时这很关键
 *   [3] 展开后自动核对一次，列出每个文件的结论
 *   [4] 三种结论的文案分得开（已核对 / 对不上 / 无法判定）
 *   [5] 有文件对不上时，头部换成告警态（不能显示成「已核对」）
 *   [6] 与 A97 的验证条并存，两条各说各的事
 *   [7] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a99.mjs（需先 npm run build）
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

const CWD = 'D:/work/demo/app';

const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'],
    status: { availability: 'ready', version: '2.4.1' },
    permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  {
    id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5',
    kind: 'direct', agent_ids: null, orchestration: null, cwd: CWD,
    created_at: new Date().toISOString(),
  },
];

const now = Date.now();
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '改一下这三个文件', created_at: new Date(now - 6e4).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: '改好了。', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [
      {
        id: 'b1', type: 'tool', toolId: 't1', name: 'Edit', status: 'completed',
        input: { file_path: `${CWD}/src/components/SettingsPage.tsx`, old_string: 'const a = 1;', new_string: 'const a = 2;' },
        output: 'ok', startedAt: now - 5800, endedAt: now - 5200,
      },
      {
        id: 'b2', type: 'tool', toolId: 't2', name: 'Write', status: 'completed',
        input: { file_path: `${CWD}/src/new.ts`, content: 'export const x = 1;\nexport const y = 2;' },
        output: 'created', startedAt: now - 5000, endedAt: now - 4800,
      },
      {
        id: 'b3', type: 'tool', toolId: 't3', name: 'Write', status: 'completed',
        input: { file_path: `${CWD}/src/gone.ts`, content: 'export const z = 1;' },
        output: 'written', startedAt: now - 4600, endedAt: now - 4400,
      },
      { id: 'b4', type: 'text', text: '改好了。', state: 'done' },
    ],
  },
];

/** 夹具里的核对结论：一个落地、一个无法判定、一个对不上 */
const EVIDENCE = {
  cwd: CWD,
  items: [
    {
      blockId: 'b1', toolName: 'edit', file: `${CWD}/src/components/SettingsPage.tsx`,
      display: 'src/components/SettingsPage.tsx', verdict: 'landed', laterModified: false, lines: 412,
    },
    {
      blockId: 'b2', toolName: 'write', file: `${CWD}/src/new.ts`,
      display: 'src/new.ts', verdict: 'ambiguous', laterModified: true, lines: 2,
    },
    {
      blockId: 'b3', toolName: 'write', file: `${CWD}/src/gone.ts`,
      display: 'src/gone.ts', verdict: 'missing', laterModified: false,
    },
  ],
  summary: { total: 3, landed: 1, notLanded: 1, other: 1, alarm: '1 个文件声明已写入，但磁盘上找不到对应内容' },
};

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', e => errors.push(String(e)));

/** 核对请求计数：用来断言「没展开就不读盘」 */
let evidenceCalls = 0;

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  if (url.includes('/api/files/evidence')) {
    evidenceCalls++;
    return json(EVIDENCE);
  }
  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  // A97 的验证条也在这一页，得给它喂一份最小可用的探测结果
  if (url.includes('/api/verify/commands')) return json({ cwd: CWD, projectTypes: ['node'], commands: [], notes: [] });
  if (url.includes('/api/verify/results')) return json({ verifications: [] });
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

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('\n[1] 面板存在且默认未核对');
const panel = page.locator('[data-file-evidence]').first();
ok((await panel.count()) === 1, '改过文件的消息下面出现文件核对条');
ok((await panel.getAttribute('data-file-evidence')) === 'idle', '初始状态是 idle', await panel.getAttribute('data-file-evidence'));
const title = await panel.locator('.tc-verify-title').first().textContent();
ok((title ?? '').includes('未核对'), '标题明确写着「未核对」', (title ?? '').trim());

console.log('\n[2] 没展开就不读盘');
ok(evidenceCalls === 0, '默认不请求 /api/files/evidence', `${evidenceCalls} 次`);

console.log('\n[3] 展开后自动核对');
await panel.locator('.tc-verify-bar').click();
await page.waitForTimeout(600);
ok(evidenceCalls === 1, '展开后只核对一次', `${evidenceCalls} 次`);
ok((await panel.getAttribute('data-file-evidence')) === 'done', '状态变成 done', await panel.getAttribute('data-file-evidence'));

const rows = page.locator('[data-file-verdict]');
ok((await rows.count()) === 3, '列出 3 个文件', String(await rows.count()));

console.log('\n[4] 三种结论文案分得开');
const verdicts = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-file-verdict')));
ok(verdicts.join(',') === 'landed,ambiguous,missing', '判定顺序与夹具一致', verdicts.join(','));

const texts = await rows.evaluateAll(els =>
  els.map(e => ({
    path: e.querySelector('.tc-verify-result-label')?.textContent?.trim() ?? '',
    status: e.querySelector('.tc-verify-result-status')?.textContent?.trim() ?? '',
  }))
);
ok(texts[0].status.includes('已核对'), 'landed 写「已核对」', texts[0].status);
ok(texts[1].status.includes('无法判定'), 'ambiguous 写「无法判定」（不冒充已落地）', texts[1].status);
ok(texts[2].status.includes('不存在') || texts[2].status.includes('找不到'), 'missing 写「文件不存在」', texts[2].status);
ok(texts[0].path === 'src/components/SettingsPage.tsx', '展示相对路径', texts[0].path);

console.log('\n[5] 有对不上时头部是告警态');
const headText = await panel.locator('.tc-verify-title').first().textContent();
ok((headText ?? '').includes('有文件对不上'), '标题变成「有文件对不上」', (headText ?? '').trim());
const headColor = await panel
  .locator('.tc-verify-title')
  .first()
  .evaluate(el => getComputedStyle(el).color);
ok(headColor !== 'rgb(0, 0, 0)', '告警文字有独立颜色（不是默认黑）', headColor);
const alarm = await panel.locator('.tc-verify-note.is-error').count();
ok(alarm >= 1, '正文里有告警句', String(alarm));

console.log('\n[6] 与验证条并存');
const verifyBars = await page.locator('[data-verify-status]').count();
ok(verifyBars >= 1, 'A97 的验证条仍在（两条各说各的事）', String(verifyBars));
const recheck = panel.locator('.tc-verify-btn');
ok((await recheck.count()) === 1, '有「重新核对」按钮');
await recheck.click();
await page.waitForTimeout(500);
ok(evidenceCalls === 2, '手动重新核对会再读一次盘', `${evidenceCalls} 次`);

await page.screenshot({ path: join(OUT, 'a99-file-evidence.png'), fullPage: false });

console.log('\n[7] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log(`失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
