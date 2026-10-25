/**
 * A37 设置页 / 聊天页 / 通讯录页细节打磨的浏览器验证。
 *
 *   [1] 设置是**弹窗**：主界面仍在下面，× 关闭、遮罩关闭、Esc 关闭，关掉回到来路
 *   [2] 分区导航去掉了那行小字（信息保留在 title 上；A38/A40 后为 5 个分区）
 *   [3] 外观：去「选择浅色或深色…」，主题按钮只留标签，选中描边 1px
 *   [4] 四个滑杆/开关的说明收进提示图标（悬停出文案）
 *   [5] 自定义 Agent：去标题下说明、去 agent 描述行
 *   [6] 「创建 Agent」：文案、尺寸、不是虚线
 *   [7] 内置四助手不再彩色填充
 *   [8] 聊天空态只剩标题 + 打开通讯录（无图标 / 无说明 / 无箭头）
 *   [9] 通讯录右侧栏无「本机共有…」小字
 *   [10] 通讯录 Tab 两等分居中
 *   [11] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a37.mjs（需先 npm run build）
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
];
const now = Date.now();
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '你好', created_at: new Date(now - 1000).toISOString() },
  {
    id: 'm2', session_id: 's1', role: 'assistant', content: '你好，有什么可以帮你？', model: 'claude-sonnet-4-5',
    author_agent_id: 'workbuddy', created_at: new Date(now).toISOString(),
    blocks: [{ id: 'b1', type: 'text', text: '你好，有什么可以帮你？', state: 'done' }],
  },
];

/** 种一个自定义 Agent，用来验证「agent 下方的小字」被去掉 */
const SEED_AGENTS = [
  {
    id: 'a-seed', name: '我的代码助手', description: '专门处理重构与代码审查',
    systemPrompt: '你是一个代码助手', icon: 'Code', color: '#0e7a8c',
    permissionMode: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
  // 自定义 Agent 存在 localStorage，必须在首帧前种进去
  await ctx.addInitScript(seed => {
    localStorage.setItem('customAgents', JSON.stringify(seed));
  }, SEED_AGENTS);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/check-login')) return json({ isLoggedIn: false, method: 'none' });
    if (url.includes('/api/agent-credentials')) return json({ credentials: [] });
    if (url.includes('/api/image/providers')) return json({ providers: [] });
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

const openSettings = async (page, from = '/chat/s1') => {
  await page.goto(base + from, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.waitForTimeout(400);
};

// ============= [1] 设置是弹窗 =============
console.log('\n[1] 设置是弹窗：主界面在下面，关闭回到来路');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const before = await page.locator('.tc-list-item').count();
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.waitForTimeout(400);

  ok(page.url().includes('/settings'), '仍然走 /settings 路由（深链可用）', page.url().replace(base, ''));

  const shape = await page.evaluate(() => {
    const modal = document.querySelector('[data-settings-modal]');
    const panel = document.querySelector('[data-settings-panel]');
    const list = document.querySelector('.tc-list-item');
    if (!modal || !panel) return { missing: true };
    const cs = getComputedStyle(panel);
    const r = panel.getBoundingClientRect();
    return {
      missing: false,
      hasBackdrop: !!document.querySelector('[data-settings-backdrop]'),
      radius: parseFloat(cs.borderTopLeftRadius),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // 弹窗必须比窗口小：整页替换才是「宽=窗口」
      winW: window.innerWidth,
      winH: window.innerHeight,
      listStillThere: !!list,
      hasClose: !!document.querySelector('[data-settings-close]'),
    };
  });
  ok(!shape.missing, '弹窗与面板都在');
  if (!shape.missing) {
    ok(shape.hasBackdrop, '有遮罩层');
    ok(shape.radius >= 12, '面板是圆角卡片（不是整页铺满）', `${shape.radius}px`);
    ok(shape.width < shape.winW - 40 && shape.height < shape.winH - 40, '面板小于窗口（浮层而非页面）', `${shape.width}×${shape.height} / ${shape.winW}×${shape.winH}`);
    ok(shape.listStillThere, '底下的会话列表仍在（主界面没被替换）', `列表项 ${before} 个`);
    ok(shape.hasClose, '右上角有关闭键');
  }

  await page.screenshot({ path: join(OUT, 'a37-settings-modal.png'), fullPage: false });

  // × 关闭 → 回到打开前的会话
  await page.locator('[data-settings-close]').click();
  await page.waitForTimeout(500);
  ok((await page.locator('[data-settings-modal]').count()) === 0, '点 × 后弹窗消失');
  ok(page.url().includes('/chat/s1'), '回到打开设置前的会话（不是跳首页）', page.url().replace(base, ''));

  // 遮罩关闭
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.mouse.click(30, 500); // 左侧遮罩区域
  await page.waitForTimeout(500);
  ok((await page.locator('[data-settings-modal]').count()) === 0, '点遮罩也能关');

  // Esc 关闭
  await page.locator('button[title="设置"]').first().click();
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  ok((await page.locator('[data-settings-modal]').count()) === 0, 'Esc 也能关');

  await ctx.close();
}

// ============= [2] 导航去小字 =============
console.log('\n[2] 分区导航：只剩图标 + 标签');
{
  const { ctx, page } = await newPage();
  await openSettings(page);

  const nav = await page.evaluate(() =>
    [...document.querySelectorAll('[data-settings-section]')].map(el => ({
      key: el.getAttribute('data-settings-section'),
      text: (el.textContent || '').trim(),
      title: el.getAttribute('title') || '',
      height: Math.round(el.getBoundingClientRect().height),
    }))
  );
  // A38/A40 之后是 5 个分区；A60 加了「模型清单」→ 6 个；A95 加了
  // 「关于与隐私」→ 7 个；A115 加了「我的资料」→ 8 个。改成显式标签表：
  // 漏一个/多一个/顺序错了都会抓到。
  // ⚠️ 这张表与 verify-a28 的 NAV_LABELS 是同一份事实的两处拷贝 ——
  // 加分区时两处都要改，只改一处另一边必红（a28 那边已经这么错过一次）。
  const LABELS = {
    profile: '我的资料',
    memory: '记忆',
    permission: '权限门禁',
    appearance: '外观',
    login: '登录配置',
    models: '模型清单',
    agents: '自定义 Agent',
    about: '关于与隐私',
  };
  ok(nav.length === Object.keys(LABELS).length, `${Object.keys(LABELS).length} 个分区都在`, String(nav.length));
  ok(nav.every(n => n.text === LABELS[n.key]), '导航项文本只剩标签（没有第二行小字）', nav.map(n => n.text).join(' / '));
  ok(nav.every(n => n.title.length > 0), '说明没有丢，挂在 title 上', nav.map(n => n.title).join(' | '));
  ok(nav.every(n => n.height <= 44), '导航项高度收成一行', nav.map(n => `${n.height}px`).join(' '));

  // 标题栏也不再挂分区副标题
  const subtitle = await page.evaluate(() => {
    const h = document.querySelector('[data-settings-panel]');
    const header = h?.closest('div[class*="flex-col"]')?.parentElement?.querySelector('header');
    return header?.textContent ?? '';
  });
  ok(!/主题、界面透明度/.test(subtitle), '标题栏不再有分区副标题', subtitle.replace(/\s+/g, ' ').slice(0, 40));
  await ctx.close();
}

// ============= [3] 外观页 =============
console.log('\n[3] 外观：去说明文字 / 主题按钮只留标签 / 描边 1px');
{
  const { ctx, page } = await newPage();
  await openSettings(page);

  const text = await page.evaluate(() => document.querySelector('[data-settings-panel="appearance"]')?.innerText ?? '');
  ok(!text.includes('选择浅色或深色'), '「选择浅色或深色，或跟随系统设置」已删');

  const opts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-theme-option]')].map(el => {
      const cs = getComputedStyle(el);
      return {
        key: el.getAttribute('data-theme-option'),
        text: (el.innerText || '').trim(),
        borderWidth: cs.borderTopWidth,
        borderStyle: cs.borderTopStyle,
        pressed: el.getAttribute('aria-pressed'),
      };
    })
  );
  ok(opts.length === 3, '三个主题按钮', String(opts.length));
  ok(opts.every(o => !/\n/.test(o.text)), '按钮里没有第二行小字', opts.map(o => o.text.replace(/\n/g, '⏎')).join(' / '));
  ok(opts.every(o => o.text === { system: '跟随系统', light: '浅色', dark: '深色' }[o.key]), '只剩标签文字', opts.map(o => `${o.key}=${o.text}`).join(' '));

  const selected = opts.find(o => o.pressed === 'true');
  ok(!!selected, '有一个被选中');
  ok(selected && parseFloat(selected.borderWidth) <= 1.01, '选中描边 1px（原来是 1.5px）', selected?.borderWidth);
  const unselected = opts.find(o => o.pressed !== 'true');
  ok(unselected && unselected.borderStyle === 'solid', '未选中项仍占住描边位置（不跳）', unselected?.borderStyle);

  await page.screenshot({ path: join(OUT, 'a37-settings-appearance.png'), fullPage: false });
  await ctx.close();
}

// ============= [4] 说明收进提示图标 =============
console.log('\n[4] 四个说明收进提示图标');
{
  const { ctx, page } = await newPage();
  // A66 起光斑默认关闭，「光斑大小 / 光斑亮度」两条滑杆与它们的提示图标都只在
  // 开关打开时渲染。这里要数的是**四个**提示图标，所以先把它打开
  // （等价于用户去过设置页打开光斑），否则只会看到透明度那一个。
  await ctx.addInitScript(() => {
    localStorage.setItem('opc.glow', JSON.stringify({ enabled: true, size: null, brightness: null }));
  });
  await openSettings(page);

  const panelText = await page.evaluate(() => document.querySelector('[data-settings-panel="appearance"]')?.innerText ?? '');
  ok(!panelText.includes('数值越大，桌面透出来越明显'), '透明度的长说明不在正文里');
  ok(!panelText.includes('跟随光标移动的玻璃反光'), '光斑说明不在正文里');
  ok(!panelText.includes('刻度处是当前主题的设计值'), '光斑大小说明不在正文里');
  ok(!panelText.includes('100% 为设计值'), '光斑亮度说明不在正文里');

  const tips = await page.evaluate(() =>
    [...document.querySelectorAll('.tc-hint-tip')].map(el => el.getAttribute('data-hint-tip'))
  );
  ok(tips.length >= 4, '至少有 4 个提示图标', String(tips.length));
  ok(tips.some(t => t && t.includes('界面透明度')), '界面透明度有提示图标', tips.join(' / '));
  ok(tips.some(t => t && t.includes('鼠标光斑')), '鼠标光斑有提示图标');
  ok(tips.some(t => t && t.includes('光斑大小')), '光斑大小有提示图标');
  ok(tips.some(t => t && t.includes('光斑亮度')), '光斑亮度有提示图标');

  // 悬停出文案
  const sizeTip = page.locator('[data-hint-tip="光斑大小说明"]');
  if (await sizeTip.count()) {
    await sizeTip.first().hover();
    await page.waitForTimeout(600);
    const tipText = await page.evaluate(() => {
      const pops = [...document.querySelectorAll('.t-tooltip, [class*="tooltip"]')];
      return pops.map(p => p.textContent || '').join(' | ');
    });
    ok(/设计值/.test(tipText), '悬停提示图标能看到原文', tipText.slice(0, 40));
  } else {
    ok(false, '找不到「光斑大小说明」图标');
  }

  await page.screenshot({ path: join(OUT, 'a37-settings-hints.png'), fullPage: false });
  await ctx.close();
}

// ============= [5][6][7] 自定义 Agent 分区 =============
console.log('\n[5] 自定义 Agent：去小字');
{
  const { ctx, page } = await newPage();
  await openSettings(page);
  await page.locator('[data-settings-section="agents"]').click();
  await page.waitForTimeout(400);

  const text = await page.evaluate(() => document.querySelector('[data-settings-panel="agents"]')?.innerText ?? '');
  ok(!text.includes('创建和管理自定义 Agent'), '标题下的说明已删');
  ok(!text.includes('专门处理重构与代码审查'), 'agent 卡片里没有描述小字');
  ok(text.includes('我的代码助手'), 'agent 名称还在');
  ok(!text.includes('专注于编程和代码相关任务'), '内置助手的描述小字也去掉了');

  // ── [6] 创建按钮 ──
  const btn = await page.evaluate(() => {
    const el = document.querySelector('[data-create-agent]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const parent = el.parentElement?.getBoundingClientRect();
    return {
      text: (el.innerText || '').trim(),
      borderStyle: cs.borderTopStyle,
      width: Math.round(r.width),
      parentWidth: parent ? Math.round(parent.width) : 0,
      height: Math.round(r.height),
    };
  });
  ok(!!btn, '存在创建按钮');
  if (btn) {
    ok(btn.text === '创建 Agent', '文案是「创建 Agent」', btn.text);
    ok(btn.borderStyle !== 'dashed', '不再是虚线描边', btn.borderStyle);
    ok(btn.width < btn.parentWidth * 0.6, '不再撑满整栏（组件收小）', `${btn.width} / ${btn.parentWidth}`);
    ok(btn.height <= 36, '高度是小按钮规格', `${btn.height}px`);
  }

  // ── [7] 内置四助手不彩色 ──
  const tiles = await page.evaluate(() => {
    const names = ['代码助手', '写作助手', '翻译助手', '创意助手'];
    const out = [];
    for (const el of document.querySelectorAll('[data-settings-panel="agents"] div')) {
      const t = (el.innerText || '').trim();
      if (names.includes(t)) {
        const iconBox = el.querySelector('div');
        if (!iconBox) continue;
        const cs = getComputedStyle(iconBox);
        out.push({ name: t, bg: cs.backgroundColor, color: cs.color });
      }
    }
    return out;
  });
  ok(tiles.length === 4, '四个内置助手都在', String(tiles.length));
  const colorful = tiles.filter(t => {
    const m = t.bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max - min > 12; // 有彩度 = 还是彩色填充
  });
  ok(colorful.length === 0, '四个助手的图标底不再是彩色', colorful.map(c => `${c.name}:${c.bg}`).join(' ') || '全为中性色');

  await page.screenshot({ path: join(OUT, 'a37-settings-agents.png'), fullPage: false });
  await ctx.close();
}

// ============= [8][9] 空态 =============
console.log('\n[8] 聊天空态：只留标题 + 打开通讯录');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const box = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find(e => e.textContent?.includes('选择一个会话'));
    if (!h) return { missing: true };
    const wrap = h.parentElement;
    return {
      missing: false,
      text: (wrap?.innerText || '').trim(),
      imgs: wrap?.querySelectorAll('svg, img').length ?? 0,
      btnArrows: [...(wrap?.querySelectorAll('button') || [])].map(b => b.querySelectorAll('svg').length),
      paragraphs: wrap?.querySelectorAll('p').length ?? 0,
    };
  });
  ok(!box.missing, '空态标题在');
  if (!box.missing) {
    ok(box.text.includes('选择一个会话，或发起新会话'), '标题文案已按用户口径改为「发起新会话」', box.text.replace(/\n/g, ' | '));
    ok(box.text.includes('打开通讯录'), '有「打开通讯录」按钮');
    ok(!box.text.includes('本机共有'), '没有「本机共有 N 个 Agent…」那段小字');
    ok(box.paragraphs === 0, '整块没有段落文字', `p=${box.paragraphs}`);
    ok(box.imgs === 0, '没有图标/装饰图（只剩两个组件）', `svg=${box.imgs}`);
    ok(box.btnArrows.every(n => n === 0), '按钮里没有箭头', JSON.stringify(box.btnArrows));
  }

  await page.screenshot({ path: join(OUT, 'a37-empty-chat.png'), fullPage: false });
  await ctx.close();
}

console.log('\n[9] 通讯录右侧栏：无小字');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  // 点导航进通讯录
  await page.locator('button[title="通讯录"]').first().click();
  await page.waitForTimeout(900);

  const t = await page.evaluate(() => document.body.innerText);
  ok(t.includes('从左侧选一个 Agent 开始对话'), '标题还在');
  ok(!t.includes('本机共有'), '标题下方的小字已删');

  // ── [10] Tab 两等分居中 ──
  const tabs = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[role="tab"]')];
    if (els.length < 2) return null;
    const rs = els.map(e => e.getBoundingClientRect());
    const container = els[0].parentElement?.getBoundingClientRect();
    return {
      count: els.length,
      widths: rs.map(r => Math.round(r.width)),
      lefts: rs.map(r => Math.round(r.left)),
      centerDelta: Math.abs((rs[0].left + rs[0].width / 2) - (container ? container.left + container.width / 2 : 0)),
      texts: els.map(e => (e.textContent || '').trim()),
    };
  });
  ok(!!tabs, '找到两个 Tab');
  if (tabs) {
    ok(tabs.texts.join('/') === 'AGENT/群聊', 'Tab 文案正确（A72：联系人 → AGENT）', tabs.texts.join(' / '));
    ok(Math.abs(tabs.widths[0] - tabs.widths[1]) <= 1, '两个 Tab 等宽（平均分布）', tabs.widths.join(' vs '));
    ok(tabs.lefts[0] < tabs.lefts[1], '顺序是 AGENT 在左');
    // 两栏的分界应落在容器中点附近（±2px）
    ok(Math.abs((tabs.lefts[1] - tabs.lefts[0]) - tabs.widths[0]) <= 2, '两栏紧邻、各占一半', `间距 ${tabs.lefts[1] - tabs.lefts[0]} vs 宽 ${tabs.widths[0]}`);
  }

  await page.screenshot({ path: join(OUT, 'a37-contacts.png'), fullPage: false });
  await ctx.close();
}

// ============= [11] 控制台 =============
console.log('\n[11] 控制台');
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
