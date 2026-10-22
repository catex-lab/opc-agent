/**
 * A28 验证：设置页光斑控制 / 设置页分区 / 群成员邀请与移出。
 *
 * 用户一次提了三件事，这里一件一组断言：
 *
 *   [1] 光斑开关：data-opc-glow 与 .tc-cursor-glow 的 display 联动
 *   [2] 光斑大小：内联 --tc-glow-size 与元素实际宽度
 *   [3] 光斑亮度：内联 --tc-glow-brightness（倍率，不是绝对值）
 *   [4] 恢复默认：内联值被移除，回到 CSS 主题设计值（开关状态不动）
 *   [5] 持久化：刷新后偏好仍在
 *   [6] 设置页分区：三个分区互斥渲染 + 副标题跟着分区走
 *   [7] 成员邀请：面板 → 点人入群 → PATCH 落库
 *   [8] 成员移出：PATCH + 行数变化；只剩一人时按钮被锁
 *   [9] 邀请浮层的底色下限（A27 浮层规格也管这个新浮层）
 *   [10] 控制台无错误
 *
 * ## 为什么大小要同时查「内联值」和「元素宽度」两处
 *
 * `size === null` 表示「跟随主题」：此时 applyGlow **不写**内联值，
 * 深色主题的 380px 才不会在浅色下被一个写死的 440 永久覆盖。
 * 只查宽度分不出「写了 440」和「没写、主题给 440」—— 两家都返回 440px，
 * 但前者会毁掉深色。所以内联属性（`style.getPropertyValue`）才是判据。
 *
 * 运行：node scripts/verify-a28.mjs（需先 npm run build）
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
// 群里放两个，留一个在外（claude），再放一个未就绪的（qoder）——
// 邀请面板要给未就绪的 Agent 标出来，不然邀请进来下次编排整轮失败。
const AGENTS = [
  { id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes', color: '#7C3AED', description: '推理型', capabilities: ['chat'], status: { availability: 'ready', version: '3.1' }, permissionSupport: { enforced: ['default'] } },
  { id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode', color: '#10A37F', description: '多 provider CLI', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.0.25' }, permissionSupport: { enforced: ['default'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '长上下文', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default'] } },
  { id: 'qoder', name: 'Qoder', vendor: 'Qoder', kind: 'cli', icon: 'qoder', color: '#5F5E5A', description: '未就绪的 Agent', capabilities: ['chat'], status: { availability: 'needs-auth' }, permissionSupport: { enforced: ['default'] } },
];
const GID = 'a28-grp-1';
// ⚠️ agent_ids 在真实 API 里是 TEXT 列原样吐出的 **JSON 字符串**
// （parseAgentIds 走 JSON.parse）。写成数组虽然现在也能被宽容解析，
// 但夹具应该对齐线上形状 —— 否则测的是降级路径而不是真实链路。
const SESSIONS = [
  { id: GID, title: '三剑客', agent_id: null, model: '', kind: 'group', agent_ids: JSON.stringify(['hermes', 'opencode']), orchestration: 'dispatch', created_at: new Date().toISOString() },
];
const MESSAGES = [];
/** PATCH 落库记录：{ method, agentIds }[] */
const patches = [];

const WALLPAPER = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#2b5876"/><stop offset="1" stop-color="#4e4376"/>' +
    '</linearGradient></defs><rect width="1440" height="900" fill="url(#g)"/></svg>'
)}")`;

const failures = [];
const checks = { total: 0 };
function ok(cond, label, detail) {
  checks.total++;
  if (cond) console.log(`  \u2713 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  else {
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
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

async function newContext(transparency = 100, dark = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(
    ({ t, d }) => {
      localStorage.setItem('opc.transparency', String(t));
      localStorage.setItem('theme', d ? 'dark' : 'light');
      // ⚠️ 不要在这里 removeItem('opc.glow')「清偏好」：
      // addInitScript 在**每一次导航**（含 reload）都会跑，写在这里等于
      // 每次刷新都把偏好重置掉 —— [5] 持久化那组会全部假失败，
      // 而且失败信息看起来像产品 bug。
      // 每组断言都新开 context，localStorage 天然是干净的，不需要清。
    },
    { t: transparency, d: dark }
  );
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/check-login')) return json({ isLoggedIn: true, method: 'cli', envConfigured: true, cliConfigured: true });
    if (url.includes('/api/permission-response')) return json({ ok: true });
    if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
    if (/\/api\/agents\/[^/]+\/models/.test(url)) return json({ models: [] });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: [], defaultModel: null });
    // 群成员的增删走这里。真实后端据 agentIds 更新群成员表；
    // 这里只记录调用，返回即成功（前端先改本地，失败只丢持久化）。
    if (/\/api\/sessions\/[^/?]+$/.test(url)) {
      if (route.request().method() === 'PATCH') {
        let body = {};
        try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* 坏 body 也要收下 */ }
        patches.push({ method: 'PATCH', agentIds: body.agentIds ?? null });
        return json({ ok: true });
      }
      const id = url.split('/api/sessions/')[1].split('?')[0];
      return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  return ctx;
}

function watch(page) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
}

async function open(page, path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  await page.evaluate(wp => {
    document.documentElement.style.backgroundImage = wp;
    document.documentElement.style.backgroundSize = 'cover';
  }, WALLPAPER);
  await page.waitForTimeout(200);
}

/** 读 <html> 上的内联光斑变量与开关属性（内联才作数，见文件头说明） */
const glowState = () => {
  const root = document.documentElement;
  const el = document.querySelector('.tc-cursor-glow');
  return {
    glowAttr: root.getAttribute('data-opc-glow'),
    inlineSize: root.style.getPropertyValue('--tc-glow-size').trim(),
    inlineBright: root.style.getPropertyValue('--tc-glow-brightness').trim(),
    display: el ? getComputedStyle(el).display : null,
    width: el ? getComputedStyle(el).width : null,
    stored: localStorage.getItem('opc.glow'),
  };
};

/**
 * 显式打开光斑（A66 起默认关闭）。
 *
 * [2]~[5] 测的是**开着**时的参数行为，而两根滑杆只在 `prefs.enabled` 为真时渲染
 * （SettingsPage 里是 `{prefs.enabled && (<>…</>)}`）。默认值一改成 false，这几段
 * 如果不先打开开关，会连滑杆都定位不到 —— 失败信息看起来像产品坏了，
 * 其实是夹具没准备。所以每段开头统一调这里，而不是各自 copy 一遍点击。
 */
async function enableGlow(page) {
  const checked = await page.evaluate(
    () => document.querySelector('.t-switch')?.classList.contains('t-is-checked') ?? false
  );
  if (checked) return;
  await page.locator('.t-switch').first().click();
  await page.waitForTimeout(250);
}

// ============= [1] 光斑开关 =============
console.log('\n[1] 光斑开关：data-opc-glow 与 display 联动');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');

  // 先证明玻璃模式真的开着：不开的话 .tc-cursor-glow 的效果监听根本不挂，
  // 后面所有断言都只是在测一个死元素。
  const glass = await page.evaluate(() => document.documentElement.dataset.opcGlass);
  ok(glass === '1', '玻璃模式已开启（?glass=1）', `data-opc-glass = ${glass}`);

  // A66：默认改成关闭（用户要求「默认关，要的人自己去开」）。
  // 这组断言测的就是「新装 / 从没碰过设置」时的初始状态。
  const s0 = await page.evaluate(glowState);
  ok(s0.glowAttr === '0', '默认关闭：写 data-opc-glow="0"', String(s0.glowAttr));
  ok(s0.display === 'none', '默认整层 display:none（不是 opacity 0）', String(s0.display));
  const sw0 = await page.evaluate(
    () => document.querySelector('.t-switch')?.classList.contains('t-is-checked') ?? null
  );
  ok(sw0 === false, '默认开关控件是关的（控件与偏好一致，不是假控件）', String(sw0));
  // 留一张「默认状态」的图：开关关、两根滑杆不渲染。
  // 这是 A67 的产品形态证据 —— 只看断言颜色看不出「界面上确实少了两个滑杆」。
  await page.screenshot({ path: join(OUT, 'a28-glow-default-off.png') });

  await page.locator('.t-switch').first().click(); // 打开
  await page.waitForTimeout(250);
  const s1 = await page.evaluate(glowState);
  ok(s1.glowAttr === null, '打开后移除 data-opc-glow（不写属性即开着）', String(s1.glowAttr));
  ok(s1.display !== 'none', '打开后整层参与渲染', String(s1.display));

  await page.locator('.t-switch').first().click(); // 再关回去
  await page.waitForTimeout(250);
  const s2 = await page.evaluate(glowState);
  ok(
    s2.glowAttr === '0' && s2.display === 'none',
    '再关回去仍然生效（开关是双向的）',
    `attr=${s2.glowAttr} display=${s2.display}`
  );
  await ctx.close();
}

// ============= [2] 光斑大小 =============
console.log('\n[2] 光斑大小：内联值 + 元素实际宽度');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');
  await enableGlow(page); // A66：默认关闭，滑杆只在开着时渲染

  const before = await page.evaluate(glowState);
  ok(before.inlineSize === '', '未设置过时不写内联 size（否则深色设计值被永久覆盖）', `inline="${before.inlineSize}"`);
  ok(before.width === '440px', '浅色主题设计值 440px 生效', String(before.width));

  await page.locator('input[aria-label="光斑大小"]').fill('600');
  await page.waitForTimeout(250);
  const after = await page.evaluate(glowState);
  ok(after.inlineSize === '600px', '拖动后写入内联 --tc-glow-size', after.inlineSize);
  ok(after.width === '600px', '元素宽度真的跟上（不是只写了个没人读的变量）', String(after.width));
  await ctx.close();
}

// ============= [3] 光斑亮度 =============
console.log('\n[3] 光斑亮度：倍率而非绝对值');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');
  await enableGlow(page); // A66：默认关闭

  const before = await page.evaluate(glowState);
  ok(before.inlineBright === '', '未设置过时不写内联 brightness', `inline="${before.inlineBright}"`);

  await page.locator('input[aria-label="光斑亮度"]').fill('150');
  await page.waitForTimeout(250);
  const after = await page.evaluate(glowState);
  // 150% 必须存成 1.5 而不是 150：CSS 侧是
  // brightness(calc(1.12 * var(--tc-glow-brightness)))，存 150 会亮 150 倍。
  ok(after.inlineBright === '1.5', '150% 落成倍率 1.5（交给 CSS 的 calc 去乘主题基准）', after.inlineBright);

  // 倍率必须真的接到 backdrop-filter 上，否则又是一个没人读的变量。
  // 浅色主题基准是 1.12，1.12 × 1.5 = 1.68 —— 这里断言的正是「CSS 侧
  // 真的做了乘法」，写死 1.5 反而是没读懂的断言。
  const filter = await page.evaluate(() => {
    const el = document.querySelector('.tc-cursor-glow');
    return el ? getComputedStyle(el).backdropFilter : null;
  });
  ok(/brightness\(1\.68\)/.test(filter || ''), 'backdrop-filter 读到了倍率（浅色基准 1.12 × 1.5）', String(filter));
  await ctx.close();
}

// ============= [4] 恢复默认 =============
console.log('\n[4] 恢复默认：回到主题设计值，但不动开关');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');
  await enableGlow(page); // A66：默认关闭，先打开再调参

  // 顺序有讲究：滑杆与「恢复默认」都只在开关开着时渲染（GlowSettings 里
  // {prefs.enabled && ...}）。所以必须先调参、点恢复，再单独验开关。
  await page.locator('input[aria-label="光斑大小"]').fill('700');
  await page.locator('input[aria-label="光斑亮度"]').fill('180');
  await page.waitForTimeout(200);
  const dirty = await page.evaluate(glowState);
  ok(dirty.inlineSize === '700px' && dirty.inlineBright === '1.8', '先弄脏：两个参数都偏离默认', `size="${dirty.inlineSize}" bright="${dirty.inlineBright}"`);

  await page.locator('[data-glow-reset]').click();
  await page.waitForTimeout(250);
  const s = await page.evaluate(glowState);
  ok(s.inlineSize === '' && s.inlineBright === '', '两个内联值都被移除', `size="${s.inlineSize}" bright="${s.inlineBright}"`);
  ok(s.width === '440px', '宽度回到浅色设计值 440px', String(s.width));
  const stillChecked = await page.evaluate(() => document.querySelector('.t-switch')?.classList.contains('t-is-checked') ?? null);
  ok(stillChecked === true, '「恢复默认」只重置两个参数，不动开关', String(stillChecked));

  // 开关来回切一遍，参数不许复活（证明清掉的是持久化值，不是显示值）
  await page.locator('.t-switch').first().click();
  await page.waitForTimeout(150);
  await page.locator('.t-switch').first().click();
  await page.waitForTimeout(250);
  const s2 = await page.evaluate(glowState);
  ok(s2.inlineSize === '' && s2.width === '440px', '开关切回来后参数没有复活', `inline="${s2.inlineSize}" width=${s2.width}`);
  await ctx.close();
}

// ============= [5] 持久化 =============
console.log('\n[5] 持久化：刷新后偏好仍在');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');
  await enableGlow(page); // A66：默认关闭
  // 顺序：先调参（滑杆只在开着时渲染），再关开关
  await page.locator('input[aria-label="光斑大小"]').fill('520');
  await page.waitForTimeout(150);
  await page.locator('.t-switch').first().click();       // 关掉
  await page.waitForTimeout(250);
  const off = await page.evaluate(glowState);
  ok(off.glowAttr === '0' && off.inlineSize === '520px', '关掉后参数仍然保存（下次打开就是它）', `attr=${off.glowAttr} size=${off.inlineSize}`);

  await open(page, '/settings?glass=1');                // 刷新（同上下文，localStorage 保留）
  await page.waitForTimeout(300);
  const s = await page.evaluate(glowState);
  ok(s.glowAttr === '0', '刷新后仍然是关的', String(s.glowAttr));
  ok(s.inlineSize === '520px', '刷新后大小偏好仍在', s.inlineSize);
  const sw = await page.evaluate(() => document.querySelector('.t-switch')?.classList.contains('t-is-checked') ?? null);
  ok(sw === false, '刷新后开关控件的选中态与持久化一致', String(sw));
  await ctx.close();
}

// ============= [6] 设置页分区 =============
console.log('\n[6] 设置页分区：互斥渲染 + 副标题跟着走');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, '/settings?glass=1');

  // A38/A40 之后设置页 5 个分区；A60 加了「模型清单」→ 6 个。
  // 按**显式标签表**断言而不是「有几项」——A37 已经证明按数量断言的探针
  // 每次加分区都会误报一次，而按标签断言只会漏掉「该在的没在」。
  const NAV_LABELS = ['记忆', '权限门禁', '外观', '登录配置', '模型清单', '自定义 Agent'];
  const navTexts = await page.locator('[data-settings-section]').allInnerTexts();
  const navCount = navTexts.length;
  const navOk =
    navCount === NAV_LABELS.length &&
    NAV_LABELS.every((label, i) => navTexts[i]?.trim().startsWith(label));
  ok(navOk, '分区导航为六项且顺序正确（记忆/权限/外观/登录/模型清单/Agent）', navTexts.map(t => t.trim()).join(' | '));
  ok(await page.locator('[data-settings-panel="appearance"]').count() > 0, '默认落在「外观」');
  ok(await page.locator('[data-settings-panel="appearance"] .t-switch').count() > 0, '外观分区含光斑开关');

  // 切到登录配置：光斑那一套必须整个消失（分类的目的就是别挤在一起）
  await page.locator('[data-settings-section="login"]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-settings-panel="login"]').count() > 0, '切到「登录配置」有内容');
  ok(await page.locator('[data-settings-panel="appearance"]').count() === 0, '外观分区已卸载（不是藏着）');
  ok(await page.locator('.t-switch').count() === 0, '光斑开关跟着外观分区一起走');
  const sub1 = await page.evaluate(() => /API Key|登录/.test(document.body.innerText));
  ok(sub1, '登录分区渲染的是登录内容');

  // 切到自定义 Agent
  await page.locator('[data-settings-section="agents"]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-settings-panel="agents"]').count() > 0, '切到「自定义 Agent」有内容');
  ok(await page.locator('[data-settings-panel="login"]').count() === 0, '登录分区已卸载');

  // A37：分区说明从「导航项里的一行小字」改成 `title`（用户要求去掉组件内小字）。
  // 断言随之改读属性 —— 信息仍在，只是不再常驻占一行。
  const hint = await page.evaluate(() => {
    const nav = document.querySelector('[data-settings-section="agents"]');
    return nav?.getAttribute('title') ?? '';
  });
  ok(hint.includes('本地提示词'), '分区说明保留在 title 上（A37：不再占一行）', hint);

  // 窄屏：竖导航让位给横向药丸（1440 下隐藏，375 下显示）
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="设置分区"]');
    const pills = nav?.parentElement?.querySelector('.sm\\:hidden');
    return {
      navVisible: nav ? getComputedStyle(nav).display !== 'none' : false,
      pillVisible: pills ? getComputedStyle(pills).display !== 'none' : false,
    };
  });
  ok(narrow.navVisible === false, '窄屏收起左侧竖导航');
  ok(narrow.pillVisible === true, '窄屏显示横向药丸');
  await ctx.close();
}

// ============= [7] 成员邀请 =============
console.log('\n[7] 成员邀请：面板 → 点人入群 → PATCH');
{
  const ctx = await newContext();
  const page = await ctx.newPage();
  watch(page);
  await open(page, `/chat/${GID}?glass=1`);
  await page.waitForTimeout(400);

  // ⚠️ A72 起群成员栏默认折叠，`[data-member-row]` / `[data-invite-toggle]`
  // 都不在 DOM 里（折叠态只渲染 10px 悬停热区）。先点展开再验 ——
  // 否则第一句就数到 0，后面的点击全部超时，读起来像「邀请功能坏了」。
  const expandBtn28 = page.locator('[aria-label="展开群成员"]');
  if (await expandBtn28.count()) {
    await expandBtn28.click();
    await page.waitForTimeout(450); // 等展开动画结束
  }

  ok(await page.locator('[data-member-row]').count() === 2, '初始两名成员', String(await page.locator('[data-member-row]').count()));

  await page.locator('[data-invite-toggle]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-invite-panel]').count() === 1, '点「邀请成员」弹出面板');
  ok(await page.locator('[data-invite-item="claude"]').count() === 1, '未加入的 Agent 在面板里');
  // 未就绪的必须标出来：邀请一个连不上的进来，下次编排整轮失败
  const qoderText = await page.locator('[data-invite-item="qoder"]').innerText().catch(() => '');
  ok(/未登录/.test(qoderText), '未就绪的 Agent 带可用性标注', qoderText.replace(/\s+/g, ' '));

  await page.locator('[data-invite-item="claude"]').click();
  await page.waitForTimeout(400);
  ok(await page.locator('[data-member-row]').count() === 3, '点完人就在群里了', String(await page.locator('[data-member-row]').count()));
  ok(await page.locator('[data-invite-panel]').count() === 0, '邀请后面板自动收起');
  const last = patches[patches.length - 1];
  ok(!!last && last.method === 'PATCH' && Array.isArray(last.agentIds) && last.agentIds.includes('claude') && last.agentIds.length === 3, 'PATCH 带上了三名成员', JSON.stringify(last));

  // 点面板外面要收得住（pointerdown 关面板，见 GroupMemberPanel 注释）
  await page.locator('[data-invite-toggle]').click();
  await page.waitForTimeout(250);
  ok(await page.locator('[data-invite-panel]').count() === 1, '面板能再打开');
  await page.mouse.click(500, 500);
  await page.waitForTimeout(300);
  ok(await page.locator('[data-invite-panel]').count() === 0, '点外面收起面板');
  await ctx.close();
}

// ============= [8] 成员移出 =============
console.log('\n[8] 成员移出：PATCH + 最后一人被锁');
{
  const ctx = await newContext();
  const page = await ctx.newPage();
  watch(page);
  await open(page, `/chat/${GID}?glass=1`);
  await page.waitForTimeout(400);

  // 与 [7] 同因：A72 起成员栏默认折叠，`[data-invite-toggle]` 不在 DOM 里。
  // 先展开再操作。（[7] 已加过一次，这里换的是新 context，得再来一遍。）
  const expandBtn8 = page.locator('[aria-label="展开群成员"]');
  if (await expandBtn8.count()) {
    await expandBtn8.click();
    await page.waitForTimeout(450); // 等展开动画结束
  }

  // 先邀请 claude 进来，凑够三个人，才好测「减到一人」
  await page.locator('[data-invite-toggle]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-invite-item="claude"]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-member-row]').count() === 3, '凑到三名成员');

  // hover 整行让删除按钮显形（默认 opacity-0，防误触）
  await page.locator('[data-member-row="claude"]').hover();
  await page.locator('[data-remove-member="claude"]').click();
  await page.waitForTimeout(350);
  ok(await page.locator('[data-member-row]').count() === 2, '移出后剩两名', String(await page.locator('[data-member-row]').count()));
  ok(await page.locator('[data-member-row="claude"]').count() === 0, '被移出的那一行消失');
  const last = patches[patches.length - 1];
  ok(!!last && last.agentIds?.length === 2 && !last.agentIds.includes('claude'), 'PATCH 里不再有他', JSON.stringify(last));

  // 再移出一个 → 只剩一人，此时最后一个删除按钮必须被锁
  await page.locator('[data-member-row="opencode"]').hover();
  await page.locator('[data-remove-member="opencode"]').click();
  await page.waitForTimeout(350);
  ok(await page.locator('[data-member-row]').count() === 1, '再移出一个后只剩一人', String(await page.locator('[data-member-row]').count()));
  const disabled = await page.locator('[data-remove-member]').first().isDisabled();
  ok(disabled, '最后一名成员的「移出」被禁用（空群发不了消息）');
  const title = await page.locator('[data-remove-member]').first().getAttribute('title');
  ok(title === '至少保留一位成员', '禁用原因写在 title 上', String(title));
  await ctx.close();
}

// ============= [9] 邀请浮层的底色下限 =============
console.log('\n[9] 邀请浮层：A27 浮层规格也管这个新浮层');
{
  const ctx = await newContext(100, false);
  const page = await ctx.newPage();
  watch(page);
  await open(page, `/chat/${GID}?glass=1`);
  await page.waitForTimeout(400);
  // 同 [7]/[8]：成员栏默认折叠，先展开才点得到「邀请成员」
  const expandBtn9 = page.locator('[aria-label="展开群成员"]');
  if (await expandBtn9.count()) {
    await expandBtn9.click();
    await page.waitForTimeout(450);
  }
  await page.locator('[data-invite-toggle]').click();
  await page.waitForTimeout(350);

  const m = await page.evaluate(() => {
    const el = document.querySelector('[data-invite-panel]');
    if (!el) return { found: false };
    const alphaOf = c => {
      const mm = c.match(/rgba?\(([^)]*)\)/);
      if (!mm) return 0;
      const parts = mm[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    let inv = 1;
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const a = alphaOf(getComputedStyle(n).backgroundColor);
      if (a > 0) { inv *= 1 - a; chain.push(a.toFixed(2)); }
      if (1 - inv > 0.995) break;
    }
    return { found: true, effAlpha: Number((1 - inv).toFixed(3)), chain };
  });
  ok(m.found, '邀请面板出现');
  ok(m.found && m.effAlpha >= 0.88, '有效底色 alpha ≥ 0.88（浮层不能透出正文）', `实测 ${m.effAlpha}（${m.chain.join(' \u00d7 ')}）`);
  await page.screenshot({ path: join(OUT, 'a28-invite-panel-light.png') });
  await ctx.close();
}

// ============= [10] 控制台 =============
console.log('\n[10] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ') || 'clean');

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '\u2713' : '\u2717'} ${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  \u00b7 ${f}`));
  process.exit(1);
}
