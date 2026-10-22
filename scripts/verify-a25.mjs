/**
 * A25 四条反馈的验证。
 *
 *   [1] 状态圆点**不描边**（在线点不再带一圈容器色描边）
 *   [2] 板块分割线取消（`--tc-divider` = transparent），控件描边仍在
 *   [3] 透明度全局化：抬升面（气泡/卡片/弹窗）与 TDesign 容器族一起变，
 *       拉到 100% 时 alpha 归零 —— 但**文字仍是不透明的实色**
 *   [4] 鼠标光斑：跟随移动、离开淡出、非玻璃模式不亮
 *   [5] 控制台无错误
 *
 * 全离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-a25.mjs（需先 npm run build）
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

// ── 夹具 ──────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构', capabilities: ['chat', 'code'], status: { availability: 'needs-auth', version: '1.0.44' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
];
const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我看下品牌色', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '已经统一成石墨黑，消息气泡也跟着透明度一起变。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() , blocks: [
      { id: 'b1', type: 'thinking', text: '先确认控件描边走的是 --td-component-stroke。', state: 'done', format: 'raw', startedAt: Date.now() - 3000, endedAt: Date.now() - 1000 },
      { id: 'b2', type: 'text', text: '已经统一成石墨黑，消息气泡也跟着透明度一起变。', state: 'done' },
    ] },
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

/**
 * 新建一个上下文，并把「界面透明度」预设好。
 *
 * 必须在**页面脚本之前**写 localStorage：`main.tsx` 在 createRoot 之前就
 * 调用 `applyUiPrefs()`，晚一步就只能看到默认值 28。
 */
async function newContext(transparency) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(t => {
    localStorage.setItem('opc.transparency', String(t));
  }, transparency);
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
  return ctx;
}

const errors = [];
function watch(page) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

// ============= [1] 状态圆点无描边 =============
console.log('\n[1] 状态圆点：不描边');
{
  const ctx = await newContext(28);
  const page = await ctx.newPage();
  watch(page);
  // 通讯录没有独立路由（只有 / 、/chat/:id 、/settings 三条），必须点导航进去。
  // 先落在会话页（列表里的头像就带状态点），再切到通讯录各取一遍。
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const collect = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-status-dot]')).map(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // 头像外框 = 状态点的父节点（AgentAvatar 的 relative 容器）
        const p = el.parentElement.getBoundingClientRect();
        const cx = p.left + p.width / 2;
        const cy = p.top + p.height / 2;
        const dx = r.left + r.width / 2 - cx;
        const dy = r.top + r.height / 2 - cy;
        return {
          status: el.dataset.status,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
          width: Math.round(r.width),
          height: Math.round(r.height),
          bg: cs.backgroundColor,
          // 点心到头像圆心的距离，与头像半径比较：>= 半径 才算落在圆外
          centerDist: Math.round(Math.hypot(dx, dy) * 10) / 10,
          radius: Math.round((p.width / 2) * 10) / 10,
        };
      })
    );

  const inList = await collect();
  ok(inList.length > 0, '会话列表的头像带状态圆点', `${inList.length} 个`);

  await page.click('nav button[title="通讯录"]');
  await page.waitForTimeout(1000);
  const inContacts = await collect();
  ok(inContacts.length > 0, '通讯录的头像也带状态圆点', `${inContacts.length} 个`);

  const dots = [...inList, ...inContacts];
  ok(dots.every(d => d.border.split(' ')[0] === '0px'), '所有圆点都没有描边', [...new Set(dots.map(d => d.border))].join(' | '));
  ok(dots.every(d => d.width === d.height), '圆点仍是正圆（去掉描边没改几何）', [...new Set(dots.map(d => `${d.width}×${d.height}`))].join(' '));
  ok(dots.every(d => /^rgb\(/.test(d.bg)), '圆点底色仍是不透明语义色（rgb 无 alpha 分量）', [...new Set(dots.map(d => d.bg))].join(' | '));
  // 去掉描边之后，唯一保证「绿点不压在绿 logo 上」的机制就是外切定位
  ok(
    dots.every(d => d.centerDist >= d.radius),
    '圆点整体落在头像圆之外（不压 logo，所以不需要描边也看得清）',
    dots.map(d => `${d.centerDist}≥${d.radius}`).join(' ')
  );
  await shot(page, 'a25-status-dots');
  // 局部放大图：整页截图里 11px 的圆点太小，肉眼判断不了「绿点是否压住绿 logo」
  {
    const box = await page.locator('[data-status-dot]').first().boundingBox();
    if (box) {
      await page.screenshot({
        path: join(OUT, 'a25-status-dots-zoom.png'),
        clip: { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 60), width: 160, height: 160 },
      });
    }
  }
  await ctx.close();
}

// ============= [2] 分割线取消 =============
console.log('\n[2] 板块分割线：取消');
{
  const ctx = await newContext(28);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const r = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const nav = document.querySelector('nav');
    const header = document.querySelector('header');
    // 输入框在 ChatSender 的 shadow DOM 里，取不到。A33 用思考块的描边当探针，
    // A35 思考块也去卡片化（无边框、透明底），改成一个临时元素直接读
    // `--td-component-stroke` —— 断言的是「这个令牌本身还有值」。
    const probe = document.createElement('div');
    probe.style.border = '1px solid var(--td-component-stroke)';
    document.body.appendChild(probe);
    const strokeColor = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return {
      divider: cs.getPropertyValue('--tc-divider').trim(),
      stroke: cs.getPropertyValue('--td-component-stroke').trim(),
      nav: nav && getComputedStyle(nav).borderRightColor,
      header: header && getComputedStyle(header).borderBottomColor,
      bubble: strokeColor,
    };
  });
  const invisible = v => v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
  ok(r.divider === 'transparent', '--tc-divider = transparent', r.divider);
  ok(invisible(r.nav), '导航条右边线不可见', r.nav);
  ok(invisible(r.header), '栏头底边线不可见', r.header);
  ok(r.stroke !== 'transparent', '控件描边未被一起取消', r.stroke);
  ok(r.bubble === 'rgb(229, 229, 229)', '卡片描边仍在（功能轮廓）', r.bubble);
  await shot(page, 'a25-no-dividers');
  await ctx.close();
}

// ============= [3] 透明度全局化 =============
console.log('\n[3] 透明度：全局表面 + 拉到底彻底透明，文字仍实色');
{
  const readSurfaces = page =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      /**
       * 从计算色里取 alpha。
       *   `rgb(255, 255, 255)`        → 1（没有 alpha 分量就是完全不透明）
       *   `rgba(255, 255, 255, 0.878)` → 0.878
       *   `rgba(0, 0, 0, 0)`          → 0（Chrome 把全透明统一序列化成这个）
       */
      const alphaOf = v => {
        if (!v) return null;
        const m = v.match(/rgba?\(([^)]*)\)/);
        if (!m) return null;
        const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
        return parts.length >= 4 ? Number(parts[3]) : 1;
      };
      /**
       * 自定义属性是**惰性替换**的：`getPropertyValue('--tc-surface-raised')`
       * 拿到的是原始文本 `rgb(255 255 255 / var(--opc-raised-alpha, 0.878))`，
       * 里面还嵌着一个 var()。要拿到最终色，必须让浏览器真正解析一次 ——
       * 挂到一个临时元素上读 computed backgroundColor。
       */
      const resolve = name => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = `var(${name})`;
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return v;
      };
      // A35：思考块也去卡片化，聊天区里已经没有「助手侧的表面」实体了。
      // 改为临时元素读同一个令牌（--td-bg-color-component）—— 这几条断言
      // 要证的本来就是「这个令牌带着透明度」，而不是某个具体元素的样式。
      const probeEl = document.createElement('div');
      probeEl.style.backgroundColor = 'var(--td-bg-color-component)';
      probeEl.style.color = 'var(--td-text-color-secondary)';
      document.body.appendChild(probeEl);
      const bcs = getComputedStyle(probeEl);
      const bubbleBg = bcs.backgroundColor;
      const bubbleColor = bcs.color;
      probeEl.remove();
      const userBubble = document.querySelector('.tc-bubble-user');
      const ucs = userBubble ? getComputedStyle(userBubble) : null;
      return {
        chrome: cs.getPropertyValue('--opc-chrome-alpha').trim(),
        content: cs.getPropertyValue('--opc-content-alpha').trim(),
        raised: cs.getPropertyValue('--opc-raised-alpha').trim(),
        surfaceRaised: resolve('--tc-surface-raised'),
        tdContainer: resolve('--td-bg-color-container'),
        surfaceRaisedAlpha: alphaOf(resolve('--tc-surface-raised')),
        tdContainerAlpha: alphaOf(resolve('--td-bg-color-container')),
        bubbleBg,
        bubbleAlpha: alphaOf(bubbleBg),
        bubbleColor,
        bubbleColorAlpha: alphaOf(bubbleColor),
        userBubbleAlpha: ucs ? alphaOf(ucs.backgroundColor) : null,
        userBubbleColor: ucs ? ucs.color : null,
      };
    });

  // 3a：默认档 —— 抬升面比内容面实，比框架面更实
  const ctxA = await newContext(28);
  const pageA = await ctxA.newPage();
  watch(pageA);
  await pageA.goto(base + '/chat/s1?glass=1', { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1400);
  const a = await readSurfaces(pageA);
  ok(Math.abs(Number(a.raised) - 0.878) < 0.01, '默认 28%：--opc-raised-alpha ≈ 0.878', a.raised);
  ok(Number(a.raised) > Number(a.content) && Number(a.content) > Number(a.chrome), '四档顺序 chrome < content < raised 不变', `${a.chrome} < ${a.content} < ${a.raised}`);
  ok(Math.abs(a.surfaceRaisedAlpha - 0.878) < 0.01, '--tc-surface-raised 解析出 0.878 的 alpha', `${a.surfaceRaised} → ${a.surfaceRaisedAlpha}`);
  ok(Math.abs(a.tdContainerAlpha - 0.878) < 0.01, 'TDesign 容器色同步（弹窗/下拉一起变）', `${a.tdContainer} → ${a.tdContainerAlpha}`);
  ok(a.bubbleAlpha !== null && a.bubbleAlpha > 0.8 && a.bubbleAlpha < 1, '助手侧表面（思考块）不再是实色', `alpha ${a.bubbleAlpha}`);
  await shot(pageA, 'a25-glass-28');

  // 3b：推到 100% —— 表面全部归零
  const ctxB = await newContext(100);
  const pageB = await ctxB.newPage();
  watch(pageB);
  await pageB.goto(base + '/chat/s1?glass=1', { waitUntil: 'networkidle' });
  await pageB.waitForTimeout(1400);
  const b = await readSurfaces(pageB);
  ok(Number(b.chrome) === 0 && Number(b.content) === 0 && Number(b.raised) === 0, '100%：三个 alpha 全部为 0', `${b.chrome}/${b.content}/${b.raised}`);
  ok(b.surfaceRaisedAlpha === 0, '100%：抬升面（卡片/输入框）彻底透明', `${b.surfaceRaised} → ${b.surfaceRaisedAlpha}`);
  ok(b.bubbleAlpha === 0, '100%：消息气泡彻底透明', String(b.bubbleAlpha));
  ok(b.bubbleColorAlpha === 1, '100%：气泡里的文字仍是不透明实色（读得清的前提）', b.bubbleColor);
  ok(b.tdContainerAlpha === 0, '100%：TDesign 容器（弹窗）也归零', `${b.tdContainer} → ${b.tdContainerAlpha}`);
  // 用户气泡是唯一有下限的表面：品牌色实心 + 白字，归零就没法读了
  ok(b.userBubbleAlpha === 0.65, '100%：用户气泡停在下限 0.65（白字必须读得清）', String(b.userBubbleAlpha));
  ok(a.userBubbleAlpha !== null && a.userBubbleAlpha > 0.8, '默认 28%：用户气泡仍是较实的 0.878', String(a.userBubbleAlpha));
  await shot(pageB, 'a25-glass-100');

  // 3c：不透明态（t=0）必须完全回到实色，不能留一点玻璃
  const ctxC = await newContext(0);
  const pageC = await ctxC.newPage();
  watch(pageC);
  await pageC.goto(base + '/chat/s1?glass=1', { waitUntil: 'networkidle' });
  await pageC.waitForTimeout(1200);
  const c = await readSurfaces(pageC);
  ok(Number(c.chrome) === 1 && Number(c.content) === 1 && Number(c.raised) === 1, '0%：三档都是 1.0（全不透明）', `${c.chrome}/${c.content}/${c.raised}`);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
}

// ============= [4] 鼠标光斑 =============
console.log('\n[4] 鼠标光斑：跟随 / 离开淡出 / 非玻璃模式不亮');
{
  const ctx = await newContext(28);
  // A66 起光斑**默认关闭**。这组测的是「开着时」的跟随 / 淡出 / 提亮，必须显式打开：
  // 关着时 `.tc-cursor-glow` 是 display:none，位置照样会被 JS 写进内联 transform，
  // 于是「跟随」几条断言仍会绿，但截图里什么都没有 —— 那种「绿的假证据」比红更危险。
  // 用 addInitScript 在首帧前种偏好，等价于「用户已经去设置页把它打开了」。
  await ctx.addInitScript(() => {
    localStorage.setItem('opc.glow', JSON.stringify({ enabled: true, size: null, brightness: null }));
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base + '/chat/s1?glass=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const cdp = await ctx.newCDPSession(page);
  // 用 CDP 派发真实鼠标事件：Playwright 的 page.mouse 有节流，紧接着读
  // 计算样式可能读到上一帧（见 AGENTS.md 的 hover 态教训）
  const move = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    // 淡入过渡是 220ms，取样必须等它走完 —— 否则读到的是中间帧（0.88）
    await page.waitForTimeout(420);
  };

  const glow = () => page.evaluate(() => {
    const el = document.querySelector('[data-cursor-glow]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      visible: el.dataset.visible,
      opacity: Number(cs.opacity),
      // 读**内联** transform：computed 值在 translate3d 下会序列化成 matrix3d，
      // 断言里再拼一串 16 个数字既脆又难读。内联值就是组件写进去的那句话。
      transform: el.style.transform,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
    };
  });

  const before = await glow();
  ok(before !== null, '光斑层存在');
  ok(before.visible === '0' && before.opacity === 0, '未移动时不显示（不会从左上角闪一下）', `opacity ${before.opacity}`);
  ok(before.pointerEvents === 'none', '光斑不吃事件（否则会挡住按钮）', before.pointerEvents);

  await move(700, 420);
  const m1 = await glow();
  ok(m1.visible === '1' && m1.opacity === 1, '移动后淡入', `opacity ${m1.opacity}`);
  ok(/700px,\s*420px/.test(m1.transform), '位置跟随到 (700, 420)', m1.transform);

  await move(980, 300);
  const m2 = await glow();
  ok(/980px,\s*300px/.test(m2.transform), '继续跟随到 (980, 300)', m2.transform);
  ok(m2.zIndex === '45', '层级在板块之上、弹窗蒙层之下', `z-index ${m2.zIndex}`);
  await shot(page, 'a25-cursor-glow');

  // 关键：光斑压在正文上时不能把字冲淡。
  // 判据不是「颜色有没有变」（CSS 里根本不会变），而是**它靠什么提亮**：
  // 必须走 backdrop-filter（镜头，只提亮背后的背景），而不是一层白色渐变
  // 盖在字上面（那会把字冲成灰的）。
  {
    const style = await page.evaluate(() => {
      const el = document.querySelector('[data-cursor-glow]');
      const cs = getComputedStyle(el);
      return {
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
        bg: cs.backgroundImage,
        mask: cs.maskImage || cs.webkitMaskImage || '',
      };
    });
    ok(/brightness\(/.test(style.backdrop), '光斑用 backdrop-filter 提亮（镜头），不是白色覆盖层', style.backdrop);
    ok(!/blur\(/.test(style.backdrop), '光斑不带 blur（否则会把光斑底下的文字糊掉）', style.backdrop);
    ok(/radial-gradient/.test(style.bg), '只留极淡的白色底（不是主体提亮手段）', style.bg.slice(0, 60));
    ok(/radial-gradient/.test(style.mask), '圆形边缘用 mask 渐隐（不会出现硬圆）', style.mask.slice(0, 60));

    const bubble = await page.locator('.tc-bubble-assistant').first().boundingBox();
    if (bubble) {
      const bx = Math.round(bubble.x + bubble.width / 2);
      const by = Math.round(bubble.y + bubble.height / 2);
      await move(bx, by);
      await page.screenshot({
        path: join(OUT, 'a25-glow-over-text.png'),
        clip: { x: Math.max(0, bx - 160), y: Math.max(0, by - 80), width: 320, height: 160 },
      });
    }
  }

  // 离开窗口：pointerout 且 relatedTarget 为 null 才是真的离开
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null, bubbles: true }));
  });
  await page.waitForTimeout(300);
  const gone = await glow();
  ok(gone.visible === '0' && gone.opacity === 0, '离开后淡出消失', `opacity ${gone.opacity}`);

  // 在元素之间移动（relatedTarget 非空）不应触发淡出
  await move(600, 500);
  await page.evaluate(() => {
    const btn = document.querySelector('nav button');
    btn?.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: document.body, bubbles: true }));
  });
  await page.waitForTimeout(200);
  const still = await glow();
  ok(still.visible === '1', '在子元素之间移动不会误判为「离开」', still.visible);
  await ctx.close();
}

// 4b：没有 ?glass=1 时完全不亮（浏览器打靶基线不能被它污染）
{
  const ctx = await newContext(28);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400, button: 'none' });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-cursor-glow]');
    return el ? { visible: el.dataset.visible, opacity: Number(getComputedStyle(el).opacity) } : null;
  });
  ok(r && r.visible === '0' && r.opacity === 0, '非玻璃模式（无 ?glass=1）不亮', r ? `opacity ${r.opacity}` : 'null');
  await ctx.close();
}

// ============= [5] 控制台 =============
console.log('\n[5] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ') || 'clean');

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
