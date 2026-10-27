/**
 * 能力档（P2）的界面验证：资料页必须把「声明」和「观测」分开显示。
 *
 * 为什么必须用浏览器实测：这一行字的意义全在「用户能不能看见」。
 * 后端把 observed 算对了、接口把它带回来了，只要资料页不渲染或者
 * 字号掉回浏览器默认值，「清单说它有思考、实际一次没给过」这件事
 * 对用户仍然是不存在的。
 *
 * 三份夹具刻意覆盖三种状态：
 *   [1] 声明 3 项、观测到 2 项      → 每个 chip 带 data-observed，正文列出实际给出的
 *   [2] 声明了、最近一次一项都没出现 → 明说「一项都没出现」，不是留空
 *   [3] 还没跑过（没有观测记录）     → **不写** data-observed、不显示那一行
 *                                      （「不知道」不能画成「观察到 0 项」）
 *
 * 运行：node scripts/verify-a126-capability-ui.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a126');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
};

const KEY = { engine: 'codex', model: 'gpt-5', gateway: 'official:chatgpt.com' };
const AGENTS = [
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', kind: 'cli', icon: 'codex',
    color: '#0EC8A9', description: 'x', capabilities: ['code', 'tools'],
    // 声明了 thinking_summary / tool / usage；usage 这一轮没出现
    eventCapabilities: ['thinking', 'thinking_summary', 'tool', 'usage', 'cost', 'permission'],
    observedCapabilities: { key: KEY, declared: ['thinking', 'thinking_summary', 'tool', 'usage', 'cost', 'permission'], observed: ['thinking_summary', 'tool'], updatedAt: Date.now() },
    status: { availability: 'ready', version: '1' },
  },
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude',
    color: '#D97757', description: 'x', capabilities: ['code'],
    eventCapabilities: ['thinking', 'tool'],
    // 声明了两项，最近一次只回了纯文本
    observedCapabilities: { key: { engine: 'claude', model: 'opus', gateway: 'local:cli' }, observed: [], updatedAt: Date.now() },
    status: { availability: 'ready', version: '1' },
  },
  {
    id: 'newbie', name: '新接的 Agent', vendor: 'v', kind: 'cli', icon: 'workbuddy',
    color: '#7C5CFF', description: 'x', capabilities: ['chat'],
    eventCapabilities: ['tool'],
    // 从没跑过：没有 observedCapabilities
    status: { availability: 'ready', version: '1' },
  },
];
const SESSIONS = [{
  id: 's1', title: '会话', agent_id: 'codex', model: 'gpt-5',
  created_at: new Date(Date.now() - 60000).toISOString(),
}];

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(DIST, url === '/' ? 'index.html' : url);
  let body;
  try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'gpt-5', name: 'GPT-5' }] });
  if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS, messages: [] });
  return json({});
});
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

async function openDetail(id) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('button[aria-label="通讯录"]').click();
  await page.waitForTimeout(700);
  const row = page.locator(`[data-agent-row="${id}"]`);
  const found = (await row.count()) === 1;
  if (!found) throw new Error(`找不到 ${id} 的资料入口`);
  await row.click();
  await page.waitForTimeout(600);
}

const readChips = () => page.evaluate(() => {
  const sec = document.querySelector('[data-agent-event-capabilities]');
  if (!sec) return null;
  const chips = [...sec.querySelectorAll('[data-event-capability]')].map(el => ({
    key: el.getAttribute('data-event-capability'),
    supported: el.getAttribute('data-supported'),
    observed: el.getAttribute('data-observed'),
  }));
  const p = sec.querySelector('[data-observed-capabilities]');
  return {
    chips,
    note: p?.textContent ?? null,
    noteSize: p ? getComputedStyle(p).fontSize : null,
    noteColor: p ? getComputedStyle(p).color : null,
  };
});

// ============= [1] 声明 3 项 / 观测到 2 项 =============
console.log('\n[1] Codex：声明与观测并排');
try {
  await openDetail('codex');
  const got = await readChips();
  ok(!!got, '资料页有「过程能力」区块');
  if (got) {
    ok(got.chips.length === 7, '七项能力全都列出来', `实际 ${got.chips.length}`);
    const by = Object.fromEntries(got.chips.map(c => [c.key, c]));
    ok(by.thinking_summary?.supported === '1', '声明：思考摘要 = 支持');
    ok(by.thinking_summary?.observed === '1', '观测：思考摘要确实出现过');
    ok(by.tool?.observed === '1', '观测：工具调用确实出现过');
    ok(by.usage?.supported === '1' && by.usage?.observed === '0', '声明有、观测无：用量统计 data-observed=0');
    ok(by.thinking?.observed === '0', '未出现的能力一律 data-observed=0');
    ok(!!got.note, '有「最近一次运行」这一行');
    ok(/gpt-5/.test(got.note ?? '') && /official:chatgpt\.com/.test(got.note ?? ''),
      '这一行写明模型与网关（三元组里的两段）', (got.note ?? '').slice(0, 80));
    ok(/思考摘要/.test(got.note ?? '') && /工具调用/.test(got.note ?? ''), '按中文名列出实际给出的能力');
    ok(!/用量统计/.test((got.note ?? '').replace(/.*实际给出：/, '')), '没出现的能力不列进「实际给出」');
    // 字号必须落在设计刻度上（辅助信息 12px），不能掉回浏览器默认
    ok(got.noteSize === '12px', '说明行字号 = 12px（辅助信息档）', got.noteSize ?? '');
    await page.screenshot({ path: join(OUT, 'codex-observed.png') });
  }
} catch (e) {
  ok(false, '[1] 用例异常', String(e).slice(0, 160));
}

// ============= [2] 声明了、最近一次一项都没出现 =============
console.log('\n[2] Claude：声明与观测不一致时要说出来');
try {
  await openDetail('claude');
  const got = await readChips();
  ok(!!got?.note, '有观测记录 → 显示说明行');
  ok(/一项都没出现/.test(got?.note ?? ''), '空观测写成「一项都没出现」，而不是留空', (got?.note ?? '').slice(0, 60));
  ok(got?.chips.every(c => c.observed === '0'), '所有 chip 的 data-observed 都是 0');
  ok(got?.chips.find(c => c.key === 'tool')?.supported === '1', '声明仍然是「支持」（声明不被观测结果改写）');
  await page.screenshot({ path: join(OUT, 'claude-none-observed.png') });
} catch (e) {
  ok(false, '[2] 用例异常', String(e).slice(0, 160));
}

// ============= [3] 从没跑过 =============
console.log('\n[3] 新 Agent：没有记录就不许假装有');
try {
  await openDetail('newbie');
  const got = await readChips();
  ok(!!got, '没有观测记录时，声明区块照常渲染');
  ok(got?.note === null, '不显示「最近一次运行」那一行');
  ok(got?.chips.every(c => c.observed === null), '不写 data-observed（不知道 ≠ 观察到 0 项）');
} catch (e) {
  ok(false, '[3] 用例异常', String(e).slice(0, 160));
}

ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');

await browser.close();
server.close();
console.log(`\n能力档界面：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
