/**
 * A98 记忆面板作用域切换的浏览器验证。
 *
 *   [1] 默认是「全局」作用域，标题明确写「（全局）」
 *   [2] 切到某个项目：核心记忆换成该项目那份，标题变「（本项目）」
 *   [3] 保存时请求体带 scope=project + cwd（不是偷偷写全局）
 *   [4] 切到另一个项目：读到空（隔离在界面上也成立）
 *   [5] 切回全局：拿到的是全局那份，不是刚才项目的
 *   [6] 检索请求带 cwd（否则会把别的项目的记忆搜出来）
 *   [7] 技能列表按作用域分开显示，并说明全局技能仍然生效
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a98.mjs（需先 npm run build）
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

const PA = 'E:/proj/ProjA';
const PB = 'E:/proj/ProjB';

const PROJECTS = [
  { id: 'p1', path: PA, name: 'ProjA', sessionCount: 2, created_at: '', last_opened_at: '', memory: null },
  { id: 'p2', path: PB, name: 'ProjB', sessionCount: 1, created_at: '', last_opened_at: '', memory: null },
];

const GLOBAL_STATS = {
  coreTokens: 12, coreBudget: 800, userTokens: 6, userBudget: 500,
  skillCount: 1, skillTokens: 10, indexedDocs: 3,
};

const BASE = {
  core: '# 全局记忆\n统一 2 空格缩进',
  user: '# 画像\n偏好中文',
  skills: [{ name: 'g1', title: '全局技能', tokens: 10 }],
  stats: GLOBAL_STATS,
  project: null,
};

const PAYLOADS = {
  [PA]: {
    ...BASE,
    project: {
      cwd: PA, key: 'proja-11112222', name: 'ProjA',
      core: '# A 项目\n用 pnpm，禁止 npm',
      skills: [{ name: 'pa', title: 'A 项目技能', tokens: 8 }],
      stats: { key: 'proja-11112222', exists: true, coreTokens: 9, coreBudget: 800, skillCount: 1, skillTokens: 8 },
    },
  },
  [PB]: {
    ...BASE,
    project: {
      cwd: PB, key: 'projb-33334444', name: 'ProjB',
      core: '',
      skills: [],
      stats: { key: 'projb-33334444', exists: false, coreTokens: 0, coreBudget: 800, skillCount: 0, skillTokens: 0 },
    },
  },
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

const captured = { put: [], search: [] };

await ctx.route('**/api/**', async route => {
  const req = route.request();
  const url = req.url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const method = req.method();

  if (url.includes('/api/projects') && method === 'GET') return json({ projects: PROJECTS });

  if (url.includes('/api/memory/search')) {
    captured.search.push(JSON.parse(req.postData() || '{}'));
    return json({ hits: [] });
  }

  if (url.includes('/api/memory/skills')) {
    if (method === 'GET') return json({ name: 'x', title: 'x', body: '# x', tokens: 1 });
    return json({ ok: true });
  }

  if (/\/api\/memory(\?|$)/.test(url) && !url.includes('/search') && !url.includes('/skills')) {
    if (method === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      captured.put.push(body);
      return json({
        ok: true,
        core: { ok: true, tokens: 9, budget: 800, overBudget: false },
        stats: GLOBAL_STATS,
        projectStats: body.scope === 'project' ? PAYLOADS[body.cwd]?.project.stats : null,
      });
    }
    const cwd = new URL(url).searchParams.get('cwd') || '';
    return json(PAYLOADS[cwd] ?? BASE);
  }

  if (url.includes('/api/runs/active')) return json({ runs: [] });
  if (/\/api\/agents/.test(url)) return json({ agents: [] });
  if (/\/api\/models/.test(url)) return json({ models: [] });
  if (/\/api\/sessions/.test(url)) return json({ sessions: [] });
  return json({});
});

await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// 进「记忆」分区
await page.getByText('记忆', { exact: true }).first().click();
await page.waitForTimeout(700);

const coreTitle = () => page.locator('h3', { hasText: '核心记忆' }).first().textContent();
const coreValue = async () => (await page.locator('textarea').first().inputValue());

// ── [1] 默认全局 ──────────────────────────────────────────────────
console.log('\n[1] 默认作用域');
ok((await coreTitle())?.includes('（全局）'), '标题写明「核心记忆（全局）」', (await coreTitle())?.trim());
ok((await coreValue()).includes('全局记忆'), '文本域是全局内容', JSON.stringify((await coreValue()).slice(0, 20)));
ok((await page.getByText('用户画像（全局）').count()) > 0, '用户画像标注为全局');

// ── [2] 切到 ProjA ────────────────────────────────────────────────
console.log('\n[2] 切到 ProjA');
await page.locator('.t-select').first().click();
await page.waitForTimeout(300);
await page.getByText('ProjA（2 个会话）').first().click();
await page.waitForTimeout(700);
ok((await coreTitle())?.includes('（本项目）'), '标题变成「核心记忆（本项目）」', (await coreTitle())?.trim());
ok((await coreValue()).includes('pnpm'), '文本域换成 ProjA 的项目记忆', JSON.stringify((await coreValue()).slice(0, 20)));
ok(!(await coreValue()).includes('统一 2 空格'), '不再是全局内容（作用域真的切了）');
ok((await page.getByText('A 项目技能').count()) > 0, '技能列表显示项目技能');
ok((await page.getByText(/另有 1 个全局技能仍会生效/).count()) > 0, '说明全局技能仍然生效');

// ── [3] 保存带 scope=project ──────────────────────────────────────
console.log('\n[3] 保存的项目作用域');
await page.locator('textarea').first().fill('# A 项目\n用 pnpm，禁止 npm，测试改了');
await page.getByRole('button', { name: '保存' }).first().click();
await page.waitForTimeout(600);
const put = captured.put.at(-1) ?? {};
ok(put.scope === 'project', '请求体带 scope=project', put.scope);
ok(put.cwd === PA, '请求体带正确的 cwd', put.cwd);
ok(String(put.core ?? '').includes('测试改了'), '提交的是编辑后的内容');
await page.screenshot({ path: join(OUT, 'a98-memory-project.png') });

// ── [4] 切到 ProjB ────────────────────────────────────────────────
console.log('\n[4] 切到 ProjB（无记忆）');
await page.locator('.t-select').first().click();
await page.waitForTimeout(300);
await page.getByText('ProjB（1 个会话）').first().click();
await page.waitForTimeout(700);
ok((await coreValue()).trim() === '', 'ProjB 的核心记忆为空（不是 A 的内容）');
ok((await page.getByText(/该项目还没有记忆/).count()) > 0, '明确提示「还没有记忆」');
ok((await page.getByText(/这个项目还没有自己的技能/).count()) > 0, '技能区也给出对应说明');

// ── [5] 切回全局 ──────────────────────────────────────────────────
console.log('\n[5] 切回全局');
await page.locator('.t-select').first().click();
await page.waitForTimeout(300);
await page.getByText('全局（所有项目共用）').first().click();
await page.waitForTimeout(700);
ok((await coreTitle())?.includes('（全局）'), '标题回到「（全局）」');
ok((await coreValue()).includes('统一 2 空格'), '文本域回到全局内容');
ok(!(await coreValue()).includes('pnpm'), '不含刚才项目的改动（两层的编辑互不影响）');

// ── [6] 检索带 cwd ────────────────────────────────────────────────
console.log('\n[6] 检索作用域');
await page.locator('.t-select').first().click();
await page.waitForTimeout(300);
await page.getByText('ProjA（2 个会话）').first().click();
await page.waitForTimeout(600);
const searchInput = page.locator('input[placeholder*="关键词"]').first();
await searchInput.fill('pnpm');
await page.getByRole('button', { name: '检索' }).first().click();
await page.waitForTimeout(500);
const lastSearch = captured.search.at(-1) ?? {};
ok(lastSearch.cwd === PA, '选项目时检索请求带 cwd', lastSearch.cwd);
ok(lastSearch.query === 'pnpm', '查询词正确');

// 全局作用域下不该带 cwd
await page.locator('.t-select').first().click();
await page.waitForTimeout(300);
await page.getByText('全局（所有项目共用）').first().click();
await page.waitForTimeout(600);
await searchInput.fill('pnpm');
await page.getByRole('button', { name: '检索' }).first().click();
await page.waitForTimeout(500);
ok((captured.search.at(-1) ?? {}).cwd === undefined, '全局作用域下检索不带 cwd（只搜全局）');

// ── [7] 控制台 ────────────────────────────────────────────────────
console.log('\n[7] 控制台');
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
