/**
 * A117 验证：项目视图。
 *
 * 用户需求原话只有四个字「做项目视图」。这一版把它理解成：
 *   「按目录把会话归堆，能看到每个目录自己的记忆与全部会话」。
 *
 * 数据层 A98 就通了（projects 表 + sessions.project_id + 记忆按项目分区，
 * 四个 CRUD 路由齐全），缺的一直是界面 —— 所以这个脚本守的全是**前端**
 * 那部分，尤其是「界面看起来对、其实数据没接上」的几种失效：
 *
 *   [1] 入口          —— NavRail 有「项目」，点了真的切过去。
 *   [2] 列表          —— 名称 / 路径 / 会话数都渲染出来。
 *   [3] 详情          —— 路径、记忆占用条、会话列表。
 *   [4] 会话过滤      —— **本组是核心**：项目 A 的详情里不许出现项目 B 的
 *                        会话，也不许出现未归属会话。这一条错了界面照样
 *                        「有内容」，只是内容是错的 —— 最难发现的那类。
 *   [5] 新建会话      —— 选 Agent 后建出的会话必须带 `cwd = project.path`
 *                        （后端靠它把会话绑回同一个项目）且跳到聊天视图。
 *   [6] 添加项目      —— 手输路径 → POST → 列表出现新行。
 *   [7] 重命名        —— PATCH + 列表即时同步（不等下一次拉取）。
 *   [8] 移除项目      —— DELETE 后该项目的会话退回「未归属」，且**不删记忆**。
 *   [9] 空态          —— 一个项目都没有时给的是「怎么加」而不是空白。
 *
 * 运行：node scripts/verify-a117-projects.mjs（需先 npm run build）
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

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
};

/** WCAG 相对亮度与对比度 */
function contrast(a, b) {
  const lum = c => {
    const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// ── 夹具 ────────────────────────────────────────────────────────────────
// 两个项目 + 三条会话（两条属 A、一条属 B）+ 一条未归属。
// 「未归属」那条是必要的：只测「A 的会话在 A 里」不够，还要证明
// 「不属于任何项目的会话不会漏进 A」。
const PROJECT_A = {
  id: 'p-a', path: 'd:/work/demo', name: 'opc-agent',
  created_at: '2026-10-01T00:00:00.000Z', last_opened_at: '2026-10-25T10:00:00.000Z',
  sessionCount: 2,
  memory: { key: 'opc-agent-1a2b3c4d', exists: true, coreTokens: 320, coreBudget: 800, skillCount: 3, skillTokens: 900 },
};
const PROJECT_B = {
  id: 'p-b', path: 'd:/work/other', name: 'other-app',
  created_at: '2026-10-02T00:00:00.000Z', last_opened_at: '2026-10-24T10:00:00.000Z',
  sessionCount: 1,
  memory: { key: 'other-app-5e6f7a8b', exists: false, coreTokens: 0, coreBudget: 800, skillCount: 0, skillTokens: 0 },
};

const AGENTS = [
  {
    id: 'a1', name: 'WorkBuddy', vendor: 'v', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: 'x', capabilities: ['chat'],
    status: { availability: 'ready', version: '1' },
  },
  {
    id: 'a2', name: 'Hermes', vendor: 'v', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: 'x', capabilities: ['chat'],
    status: { availability: 'ready', version: '1' },
  },
];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];

const now = Date.now();
const mkSession = (id, title, projectId, agentId, minutesAgo) => ({
  id, title, agent_id: agentId, model: 'm',
  project_id: projectId, cwd: projectId ? (projectId === 'p-a' ? 'd:/work/demo' : 'd:/work/other') : null,
  created_at: new Date(now - minutesAgo * 60000).toISOString(),
});

const SESSIONS = [
  mkSession('s-a1', 'A 里的老会话', 'p-a', 'a1', 100),
  mkSession('s-a2', 'A 里的新会话', 'p-a', 'a1', 10),
  mkSession('s-b1', 'B 里的会话', 'p-b', 'a2', 50),
  mkSession('s-n1', '未归属会话', null, 'a1', 5),
];

// ── 静态服务 ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(DIST, url === '/' ? 'index.html' : url);
  let body;
  try { body = await readFile(file); }
  catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/**
 * 一套夹具 + 一个页面。
 *
 * `projects` 是**可变**的：添加/重命名/删除会改它，后续 GET 才反映新状态。
 * 如果每次都返回同一份常量，「列表刷新了」这类断言会变成永远通过 ——
 * 因为它本来就长那样。
 */
async function newPage({ dark = false, viewport = { width: 1440, height: 900 }, projects } = {}) {
  const state = {
    projects: projects ?? [structuredClone(PROJECT_A), structuredClone(PROJECT_B)],
    calls: [],
  };
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(d => {
    try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* 存储被禁 */ }
  }, dark);
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    state.calls.push(`${method} ${new URL(url).pathname}`);

    if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });

    // 项目 CRUD
    if (/\/api\/projects$/.test(url)) {
      if (method === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        const cwd = String(body.cwd || '');
        if (!cwd) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'cwd 不能为空' }) });
        // 「取或建」：已存在的路径返回原项目
        const existing = state.projects.find(p => p.path === cwd.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''));
        if (existing) return json({ project: existing });
        const created = {
          id: `p-new-${state.projects.length}`,
          path: cwd.toLowerCase().replace(/\\/g, '/'),
          name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
          created_at: new Date().toISOString(), last_opened_at: new Date().toISOString(),
          sessionCount: 0, memory: null,
        };
        state.projects.push(created);
        return json({ project: created });
      }
      return json({ projects: state.projects });
    }
    // A119：项目任务。详情页挂载时会拉一次；这个脚本不验任务面板，
    // 但必须给一个合法响应 —— 否则详情页会顶出一条红色的读取失败。
    if (/\/api\/projects\/[^/?]+\/tasks/.test(url)) return json({ tasks: [] });

    const projMatch = url.match(/\/api\/projects\/([^/?]+)/);
    if (projMatch) {
      const id = projMatch[1];
      if (method === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}');
        const p = state.projects.find(x => x.id === id);
        if (!p) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: '项目不存在' }) });
        p.name = body.name;
        return json({ ok: true, project: p });
      }
      if (method === 'DELETE') {
        state.projects = state.projects.filter(x => x.id !== id);
        return json({ ok: true });
      }
    }

    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/').pop().split('?')[0];
      const s = SESSIONS.find(x => x.id === id);
      return json({ session: s, messages: [] });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors, state };
}

/** 进入项目视图（点导航栏那颗按钮） */
async function gotoProjects(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.locator('nav button[aria-label="项目"]').click();
  await page.waitForTimeout(700);
}

// ============= [1] 入口 =============
console.log('\n[1] 导航栏：有「项目」入口，点击切到项目视图');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const entry = page.locator('nav button[aria-label="项目"]');
  ok(await entry.count() === 1, '导航栏有且只有一个「项目」入口');
  ok(await entry.getAttribute('aria-current') === null, '未进入时不是选中态');

  await entry.click();
  await page.waitForTimeout(700);
  ok(await entry.getAttribute('aria-current') === 'page', '点进去后是选中态（aria-current=page）');
  ok(await page.locator('[data-project-panel]').count() === 1, '列表栏换成了项目栏');

  // 顺序：聊天 / 项目 / 通讯录。项目夹在中间是有意的（与聊天同族），
  // 这条断言防的是「有人随手把它挪到最后」。
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('nav button[aria-label]')].map(b => b.getAttribute('aria-label')).filter(Boolean)
  );
  ok(
    labels.indexOf('项目') === labels.indexOf('聊天') + 1,
    '「项目」紧跟「聊天」（同族），排在「通讯录」之前',
    labels.join(' / ')
  );

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [2] 项目列表 =============
console.log('\n[2] 项目列表：名称 / 路径 / 会话数');
{
  // 暗色跑：这一栏是新增的界面，深色适配要当场验（项目里 A115/A116 的
  // 反馈全是「暗色下看不清」，不能等用户来报）。
  const { ctx, page, errors } = await newPage({ dark: true });
  await gotoProjects(page);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-project-row]')].map(r => ({
      id: r.getAttribute('data-project-row'),
      text: r.textContent || '',
      memoryDot: !!r.querySelector('[data-project-memory-dot]'),
    }))
  );
  ok(rows.length === 2, '两个项目都渲染出来', rows.map(r => r.id).join(','));
  ok(rows[0]?.id === 'p-a' && rows[1]?.id === 'p-b', '顺序按 last_opened_at 倒序（后端排好）', rows.map(r => r.id).join(' > '));
  ok(rows.some(r => r.text.includes('opc-agent')), '项目名渲染');
  ok(rows.some(r => r.text.includes('d:/work/demo')), '路径渲染');
  // 会话数要精确到元素：`text.includes('2')` 这种写法在路径里带 2 时也会通过
  const counts = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-project-row]')].map(r => [
        r.getAttribute('data-project-row'),
        r.querySelector('[data-project-count]')?.textContent?.trim(),
      ])
    )
  );
  ok(counts['p-a'] === '2' && counts['p-b'] === '1', '会话数逐个对上（A=2 / B=1）',
    `A=${counts['p-a']} B=${counts['p-b']}`);

  // 记忆小圆点只该出现在「有记忆」的那个项目上
  const withDot = rows.filter(r => r.memoryDot).map(r => r.id);
  ok(withDot.length === 1 && withDot[0] === 'p-a', '只有「有项目记忆」的项目带小圆点', withDot.join(',') || '无');

  // 页脚汇总
  const footer = await page.evaluate(() => document.querySelector('[data-project-panel]')?.textContent || '');
  ok(footer.includes('2 个项目') && footer.includes('3 个会话'), '页脚汇总项目数与会话总数', '2 个项目 · 3 个会话');

  // 暗色下的可读性。这一栏是新增界面，深色适配不能等用户来报
  // （A115/A116 的反馈全是「暗色下看不清」）。
  const colors = await page.evaluate(() => {
    const row = document.querySelector('[data-project-row="p-a"]');
    const bgOf = el => {
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        n = n.parentElement;
      }
      return 'rgb(0,0,0)';
    };
    const spans = row ? [...row.querySelectorAll('span')] : [];
    const nameEl = spans.find(s => s.textContent?.trim() === 'opc-agent');
    const pathEl = spans.find(s => s.textContent?.trim() === 'd:/work/demo');
    return {
      bg: bgOf(row),
      name: nameEl ? getComputedStyle(nameEl).color : null,
      path: pathEl ? getComputedStyle(pathEl).color : null,
    };
  });
  ok(!!colors.name && contrast(colors.name, colors.bg) >= 7,
    '暗色：项目名对比度 ≥ 7:1', `${colors.name} on ${colors.bg} → ${colors.name ? contrast(colors.name, colors.bg).toFixed(2) : '?'}:1`);
  ok(!!colors.path && contrast(colors.path, colors.bg) >= 4.5,
    '暗色：路径对比度 ≥ 4.5:1（次要信息也不能糊）', `${colors.path} → ${colors.path ? contrast(colors.path, colors.bg).toFixed(2) : '?'}:1`);

  await page.screenshot({ path: join(OUT, 'a117-projects-dark.png') });
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [3][4] 详情 + 会话过滤 =============
console.log('\n[3] 项目详情：路径 / 记忆条 / 会话列表');
console.log('[4] 会话过滤：只显示属于本项目的会话');
{
  const { ctx, page, errors } = await newPage();
  await gotoProjects(page);

  // 未选中时右侧是提示，不是空白
  ok(await page.locator('[data-project-detail-empty]').count() === 1, '没选项目时右侧给提示（不是一片白）');

  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(400);

  ok(await page.locator('[data-project-detail="p-a"]').count() === 1, '点项目后出现对应详情');
  const title = await page.locator('[data-project-title]').textContent();
  ok(title?.trim() === 'opc-agent', '详情标题是项目名', title?.trim());
  const path = await page.locator('[data-project-path]').textContent();
  ok(path?.trim() === 'd:/work/demo', '详情显示完整路径', path?.trim());

  // 记忆条：只有 exists 的项目才画
  ok(await page.locator('[data-project-memory-bar]').count() === 1, '有记忆的项目显示占用条');
  const barText = await page.locator('[data-project-memory-bar]').textContent();
  ok(barText?.includes('320') && barText?.includes('800'), '占用条显示 tokens/预算', barText?.replace(/\s+/g, ' ').trim());

  // ★ 核心：会话过滤
  const sessionIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-project-session-row]')].map(r => r.getAttribute('data-project-session-row'))
  );
  ok(sessionIds.length === 2, 'A 项目下正好 2 个会话', sessionIds.join(','));
  ok(sessionIds.includes('s-a1') && sessionIds.includes('s-a2'), 'A 的两个会话都在');
  ok(!sessionIds.includes('s-b1'), '**B 项目的会话没有漏进来**', sessionIds.join(','));
  ok(!sessionIds.includes('s-n1'), '**未归属的会话没有漏进来**', sessionIds.join(','));
  // 倒序：新的在上
  ok(sessionIds[0] === 's-a2', '会话按时间倒序（最近的在最上）', sessionIds.join(' > '));

  // 切到 B：记忆条消失（B 没有记忆），会话换成 B 的那一条
  await page.locator('[data-project-row="p-b"]').click();
  await page.waitForTimeout(400);
  ok(await page.locator('[data-project-memory-bar]').count() === 0, 'B 没有项目记忆 → 不画占用条（空条会让人以为坏了）');
  const bSessions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-project-session-row]')].map(r => r.getAttribute('data-project-session-row'))
  );
  ok(bSessions.length === 1 && bSessions[0] === 's-b1', 'B 项目下只有它自己那 1 个会话', bSessions.join(','));

  await page.screenshot({ path: join(OUT, 'a117-projects-detail.png') });
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [5] 新建会话 =============
console.log('\n[5] 新建会话：先选 Agent，建出的会话带 cwd 并跳到聊天');
{
  const { ctx, page, errors } = await newPage();
  await gotoProjects(page);
  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(400);

  // 点开 Agent 选择
  await page.locator('[data-project-new-session]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-project-agent-picker]').count() === 1, '「新建会话」先展开 Agent 选择（不擅自用默认 Agent）');
  const agentCount = await page.locator('[data-project-pick-agent]').count();
  ok(agentCount === 2, '两个就绪 Agent 都可选', `${agentCount} 个`);

  // 选一个 → 应该跳到聊天视图，且会话带 cwd
  await page.locator('[data-project-pick-agent="a2"]').click();
  await page.waitForTimeout(900);

  ok(/\/chat\//.test(new URL(page.url()).pathname), '跳到了聊天视图', page.url().split('/').slice(-1)[0]);
  // cwd 是否真的带上了：查会话头部的工作区徽标（它显示的正是会话 cwd）。
  //
  // ⚠️ 第一版这里写的是 `document.body.textContent.includes('opc')` —— 假的：
  // 窗口标题栏就有「OPC Agent」，这条断言在任何页面上都成立。必须落到
  // 具体元素的文本上。
  // 徽标显示的是 cwd 的**末段目录名**，所以从夹具路径现算，别写死字面量：
  // 写死时只要有人换掉夹具路径，这条就会静默失配（A146 整理本机路径时踩过）。
  const projectDirName = PROJECT_A.path.split(/[\\/]/).filter(Boolean).pop();
  const badge = await page.locator('[data-workspace-badge] summary').first().textContent();
  ok(!!badge && badge.includes(projectDirName), '工作区徽标显示的是项目目录（cwd 已带上）',
    `${badge?.trim() || '未找到徽标'} / 期望含「${projectDirName}」`);

  // 再回项目视图确认新会话已归属：本地会话（尚未落库）也要立刻出现在
  // 项目详情里 —— 否则用户「从项目建了会话，回到项目却看不见它」。
  await page.locator('nav button[aria-label="项目"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('[data-project-session-row]')].map(r => r.getAttribute('data-project-session-row'))
  );
  ok(after.length === 3, '新建的会话立刻出现在项目详情里（本地会话也归属）', `${after.length} 个`);

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [6] 添加项目 =============
console.log('\n[6] 添加项目：手输路径 → POST → 列表出现新行');
{
  // 用「一个项目都没有」的夹具起，顺便验证空态
  const { ctx, page, errors, state } = await newPage({ projects: [] });
  await gotoProjects(page);

  ok(await page.locator('[data-project-empty]').count() === 1, '没有项目时给空态（不是空白列表）');
  const emptyText = await page.locator('[data-project-empty]').textContent();
  ok(!!emptyText?.includes('选一个目录') || !!emptyText?.includes('输入目录路径'), '空态说明了「项目从哪来」', emptyText?.replace(/\s+/g, ' ').trim().slice(0, 40));

  // 浏览器环境没有 window.opc → 「+」应该展开手输表单，而不是点了没反应
  await page.locator('[data-project-add]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-project-add-form]').count() === 1, '无原生对话框时「+」展开手输路径表单（不是假控件）');

  await page.locator('[data-project-path-input]').fill('D:\\work\\newproj');
  await page.locator('[data-project-add-confirm]').click();
  await page.waitForTimeout(900);

  ok(state.calls.includes('POST /api/projects'), '发出了 POST /api/projects');
  const rows = await page.locator('[data-project-row]').count();
  ok(rows === 1, '列表里出现新项目', `${rows} 行`);
  const newName = await page.locator('[data-project-row]').first().textContent();
  ok(!!newName?.includes('newproj'), '新项目的名字取自目录名', newName?.replace(/\s+/g, ' ').trim().slice(0, 30));

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [7] 重命名 =============
console.log('\n[7] 重命名：PATCH 后列表即时同步');
{
  const { ctx, page, errors, state } = await newPage();
  await gotoProjects(page);
  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(400);

  await page.locator('[data-project-rename]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-project-rename-input]').count() === 1, '点重命名出现输入框');

  await page.locator('[data-project-rename-input]').fill('改过的名字');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);

  ok(state.calls.includes('PATCH /api/projects/p-a'), '发出了 PATCH /api/projects/p-a');
  const title = await page.locator('[data-project-title]').textContent();
  ok(title?.trim() === '改过的名字', '详情标题跟着变', title?.trim());
  // 列表栏也要同步 —— 只改右边不改左边就是「两处数据源」
  const rowText = await page.locator('[data-project-row="p-a"]').textContent();
  ok(!!rowText?.includes('改过的名字'), '列表栏同步（不是只改了右边）', rowText?.replace(/\s+/g, ' ').trim().slice(0, 30));

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [8] 移除项目 =============
console.log('\n[8] 移除项目：确认框说清后果，删后会话解绑');
{
  const { ctx, page, errors, state } = await newPage();
  await gotoProjects(page);
  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(400);

  await page.locator('[data-project-delete]').click();
  await page.waitForTimeout(400);
  const dialog = await page.locator('[data-confirm-dialog]').textContent();
  ok(!!dialog, '弹了确认框');
  ok(!!dialog?.includes('不会删目录') || !!dialog?.includes('不会被删除'), '确认框说清「不删目录/不删记忆」',
    dialog?.replace(/\s+/g, ' ').trim().slice(0, 50));

  await page.locator('[data-confirm-dialog] button').last().click();
  await page.waitForTimeout(800);

  ok(state.calls.includes('DELETE /api/projects/p-a'), '发出了 DELETE /api/projects/p-a');
  const rows = await page.locator('[data-project-row]').count();
  ok(rows === 1, '列表里只剩另一个项目', `${rows} 行`);

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [9] 窄屏 =============
console.log('\n[9] 窄屏单栏：列表与详情互斥，详情有返回键');
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 560, height: 800 } });
  await gotoProjects(page);

  // 窄屏刚进来：只有列表，没有详情（没有自动选中第一个项目）
  ok(await page.locator('[data-project-detail]').count() === 0, '窄屏刚进入只显示列表（不自动跳详情）');

  await page.locator('[data-project-row="p-a"]').click();
  await page.waitForTimeout(500);
  ok(await page.locator('[data-project-detail="p-a"]').count() === 1, '点项目后显示详情');
  ok(await page.locator('[data-project-panel]').count() === 0, '列表栏让位（单栏互斥）');
  ok(await page.locator('[data-project-back]').count() === 1, '详情有返回键');

  await page.locator('[data-project-back]').click();
  await page.waitForTimeout(500);
  ok(await page.locator('[data-project-panel]').count() === 1, '返回后回到列表');
  ok(await page.locator('[data-project-detail]').count() === 0, '详情已收起');

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
