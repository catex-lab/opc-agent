/**
 * A30 UI 验证：三条用户反馈。
 *
 *   [1] 点聊天输入框 / 权限按钮 / 模型按钮**不再描边**
 *       —— 断言方式是「聚焦前后计算样式完全相同」，而不是比对某个色值：
 *          色值会随主题变，而「聚焦不改变外观」这个承诺与主题无关。
 *   [2] 群聊设置面板：圆角 + 成员后面有「邀请 / 移出」
 *       —— 圆角读 borderTopLeftRadius；邀请/移出要真的能改成员
 *          （拦 PATCH 请求，看发出去的 agentIds 对不对）。
 *   [3] 设置页「Agent API Key」：能渲染、能展开、保存时把 key 发给后端
 *       —— 这是「豆包 / Gemini 未登录」在应用内的解法，必须验到请求体。
 *
 * 复用 verify-p7-ui 的手法：静态服务器托管 dist/ + Playwright 拦 /api/**。
 * 运行：node scripts/verify-a30.mjs（需先 npm run build）
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
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default'] } },
  { id: 'gemini', name: 'Gemini', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3C3489', description: '长文档分析', capabilities: ['chat', 'search'], status: { availability: 'needs-auth' }, permissionSupport: { enforced: ['default'] } },
];

const MODELS = [{ modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' }];
const NOW = new Date().toISOString();

const SESSIONS = [
  {
    id: 'g1', title: '评审小组', agent_id: null, model: null, kind: 'group',
    agent_ids: JSON.stringify(['workbuddy', 'claude']), orchestration: 'dispatch',
    created_at: NOW,
  },
  // 一对一会话：模型 / 权限两个下拉只在这里出现（群聊不渲染模型下拉）
  {
    id: 'd1', title: '', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct',
    agent_ids: JSON.stringify(['workbuddy']), orchestration: 'dispatch', created_at: NOW,
  },
];
const MESSAGES = [
  { id: 'u1', session_id: 'g1', role: 'user', content: '拉个群', created_at: NOW, tool_calls: null, images: null },
  {
    id: 'a1', session_id: 'g1', role: 'assistant', content: '好的。',
    model: 'claude-sonnet-4-5', author_agent_id: 'claude', created_at: NOW, tool_calls: null, images: null,
  },
];

/** 设置页的凭据夹具：一个未配置、一个已配置（掩码） */
const CREDENTIALS = [
  {
    agentId: 'gemini', name: 'Gemini', keyEnv: 'GEMINI_API_KEY',
    keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
    hint: 'Google AI Studio 申请 API Key', configured: true, masked: 'AIzaSy****9f2c',
    baseUrl: '', fromEnv: false,
  },
  {
    agentId: 'doubao', name: '豆包', keyEnv: 'ARK_API_KEY',
    keyEnvs: ['ARK_API_KEY', 'DOUBAO_API_KEY'], baseUrlEnv: undefined,
    hint: '火山方舟控制台创建 API Key', configured: false, masked: '',
    baseUrl: '', fromEnv: false,
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

/** 记录 PATCH /api/sessions 的请求体，用来证明按钮真的改到了成员 */
const patches = [];
/** 记录 POST /api/agent-credentials 的请求体 */
const credPosts = [];

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const req = route.request();
  const url = req.url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  if (req.method() === 'PATCH' && /\/api\/sessions\//.test(url)) {
    patches.push({ url, body: req.postDataJSON() });
    return json({ success: true });
  }
  if (req.method() === 'POST' && url.includes('/api/agent-credentials')) {
    credPosts.push(req.postDataJSON());
    return json({ credential: { ...CREDENTIALS[1], configured: true, masked: 'ark-1****cdef' }, agent: { id: 'doubao', status: { availability: 'ready' } } });
  }
  if (req.method() === 'DELETE' && url.includes('/api/agent-credentials')) {
    return json({ credential: CREDENTIALS[1], agent: { id: 'doubao', status: { availability: 'needs-auth' } } });
  }
  if (url.includes('/api/agent-credentials')) return json({ credentials: CREDENTIALS });

  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
  }
  if (/\/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
}

// ============= [1] 聚焦不再描边 =============
console.log('\n[1] 点聊天输入框 / 权限 / 模型：不描边');

await go('/chat/g1');

/** 读 ChatSender 输入框本体（shadow DOM 里的 part）的计算样式 */
async function senderStyle() {
  return page.evaluate(() => {
    const host = document.querySelector('t-chat-sender');
    const inner = host?.shadowRoot?.querySelector('[part~="t-chat__input__content"]');
    if (!inner) return null;
    const cs = getComputedStyle(inner);
    return { borderColor: cs.borderColor, boxShadow: cs.boxShadow, outline: cs.outlineStyle };
  });
}

const senderBefore = await senderStyle();
ok(!!senderBefore, '找得到输入框本体（shadow part）');
// 点进输入框：真实点击，不是 focus()（`:focus-within` 对两者都成立，但点击更贴近用户动作）
await page.locator('t-chat-sender').click();
await page.waitForTimeout(250);
const senderAfter = await senderStyle();
ok(!!senderAfter, '聚焦后仍能读到样式');
if (senderBefore && senderAfter) {
  /* A83 修订：A30 当时把聚焦态压成「与常态完全一致」，代价是没有任何
     焦点反馈。用户后来要求「输入框聚焦用阴影替代高亮」，所以这里的判据
     从「投影不变」改成「投影变了，但变出来的必须是柔和的阴影而不是光环」。

     三条一起看才成立：
       ① 投影确实变了 —— 否则等于又回到「没有反馈」；
       ② 边框色不变 —— A30 的核心诉求（不许描边）；
       ③ 阴影里每个颜色都是**中性、低 alpha（≤0.2）、且带模糊半径** ——
          「中性」排除品牌色/语义色光环，「低 alpha」排除实心环，
          「带模糊」排除 `0 0 0 3px` 这种硬描边伪装成阴影。 */
  ok(
    senderAfter.boxShadow !== senderBefore.boxShadow,
    '输入框聚焦后有阴影反馈（A83：阴影替代高亮）',
    senderAfter.boxShadow.slice(0, 80)
  );
  ok(senderAfter.borderColor === senderBefore.borderColor, '输入框聚焦后边框色不变', senderAfter.borderColor);

  const shadowColors = [...senderAfter.boxShadow.matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/g)]
    .map(m => ({ r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }));
  const neutral = shadowColors.every(c => c.r === c.g && c.g === c.b);
  const soft = shadowColors.every(c => c.a <= 0.2);
  ok(neutral, '聚焦阴影是中性色（不是品牌色光环）', JSON.stringify(shadowColors));
  ok(soft, '聚焦阴影足够淡（alpha ≤ 0.2，不是实心环）', JSON.stringify(shadowColors.map(c => c.a)));

  // 至少有一层带模糊半径（`x y blur` 的第三个数 > 0）：否则就是换个写法的描边
  const radii = [...senderAfter.boxShadow.matchAll(/(?:rgba?\([^)]*\)\s*)?(-?[\d.]+px)\s+(-?[\d.]+px)\s+([\d.]+px)/g)]
    .map(m => parseFloat(m[3]));
  ok(radii.some(r => r > 0), '聚焦阴影带模糊半径（是阴影，不是描边）', JSON.stringify(radii));
}

/**
 * A93：输入框的字号与描边。
 *
 * 字号这条必须落到**真实的 textarea** 上。组件把字号写在 shadow 内部的
 * `font: var(--td-font-body-medium)`，外层五条路径全部实测改不动
 * （`::part` 跨不了两层 shadow、CSS 变量被 shadow 内的本地定义压过、
 * 内联 style 被 autosize 每次重写抹掉 —— 详见 src/senderTextarea.ts 文件头）。
 * 现在由注入的样式表改成 15px，这里断言它真的落地，别再退回 16px。
 *
 * 正文基准是 `.chat-markdown ::part(md_p)` 的 15px / 1.72。那也在另一层
 * shadow 里，`document.querySelector` 取不到，所以字号写死 15 并在标签里
 * 标明来源；行高只校验**倍率区间**（1.4–1.8），不锁死像素值 —— 锁死了
 * 以后调整行距就会误报。
 */
{
  const r = await page.evaluate(() => {
    const dig = (root, d = 0) => {
      if (!root || d > 5) return null;
      const ta = root.querySelector('textarea');
      if (ta) return ta;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const f = dig(el.shadowRoot, d + 1);
          if (f) return f;
        }
      }
      return null;
    };
    const alphaOf = c => {
      const m = c && c.match(/rgba?\(([^)]*)\)/);
      if (!m) return 0;
      const p = m[1].split(/[,/]/).map(v => v.trim()).filter(Boolean);
      return p.length >= 4 ? Number(p[3]) : 1;
    };
    const host = document.querySelector('t-chat-sender');
    const ta = host?.shadowRoot ? dig(host.shadowRoot) : null;
    const shell = host?.shadowRoot?.querySelector('[part~="t-chat__input__content"]');
    if (!ta || !shell) return { err: '取不到 textarea / 输入框本体' };
    const t = getComputedStyle(ta);
    const s = getComputedStyle(shell);
    const borders = [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor];
    return {
      fontSize: parseFloat(t.fontSize),
      lineHeight: parseFloat(t.lineHeight),
      borderAlphas: borders.map(alphaOf),
      border: s.borderTopColor,
    };
  });
  ok(!r.err, '取得到输入框里的 textarea', r.err || 'ok');
  ok(!r.err && r.fontSize === 15, '输入框字号 = 15px（与正文 md_p 一致）', r.err ? '-' : `${r.fontSize}px`);
  const ratio = r.err ? 0 : r.lineHeight / r.fontSize;
  ok(
    !r.err && ratio >= 1.4 && ratio <= 1.8,
    '输入框行高在正文区间（1.4–1.8 倍）',
    r.err ? '-' : `${r.lineHeight}px / ${r.fontSize}px = ${ratio.toFixed(2)}`
  );
  ok(
    !r.err && r.borderAlphas.every(a => a === 0),
    'A93：输入框描边整圈透明',
    r.err ? '-' : `${r.border}（alpha ${r.borderAlphas.join('/')}）`
  );
}

/**
 * 下拉触发器「点击不描边」的通用断言。
 *
 * 关键点：**不能把「点击前」当成干净基线**。TDesign 的
 * `.t-select__wrap:hover` 会把边框转成品牌色，而点击时鼠标必然停在上面 ——
 * 那条 hover 规则实际是「每次点击都触发」。
 *
 * 所以这里模拟真实动作：先把鼠标移到空白处取基线 → 点开下拉 → 再取一次
 * （此刻处于 hover + 展开态）→ 断言两者一致、且投影始终为 none。
 * 同时确认下拉真的弹出来了，否则「样式没变」可能只是因为压根没点中。
 */
async function selectNoRing(locator, label) {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const read = () =>
    locator.evaluate(el => {
      const cs = getComputedStyle(el);
      return { borderColor: cs.borderColor, boxShadow: cs.boxShadow };
    });

  const count = await locator.count();
  ok(count === 1, `${label}：找得到唯一的触发器`, `n=${count}`);
  if (count !== 1) return;

  const before = await read();

  await locator.click();
  await page.waitForTimeout(250);
  const after = await read();
  const popupOpen = (await page.locator('.t-popup').count()) > 0;
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);

  ok(popupOpen, `${label}：点击确实展开了下拉（否则下面的断言是空转）`);
  ok(after.boxShadow === 'none', `${label}：聚焦/悬停都没有光环`, after.boxShadow);
  ok(
    after.borderColor === before.borderColor,
    `${label}：点击后边框色不变`,
    `${before.borderColor} → ${after.borderColor}`
  );
}

// 一对一：模型入口 + 权限下拉都在这里
await go('/chat/d1');
await selectNoRing(page.locator('[data-permission-mode-select] .t-select__wrap'), '权限按钮');
{
  /* A75：A74 起模型入口不再是 TDesign Select（换成自绘触发器），
     原来「数 .t-select__wrap 期望 ≥2」的写法会**静默少算一个**：
     夹具里的模型没有档位表，思考强度那颗不渲染，于是只剩权限一颗，
     n=1 直接红。这类「数内部类名」的断言在换控件时必须同步改锚点，
     所以这里换成 data 钩子。 */
  const modelTrigger = page.locator('t-chat-sender [slot="footer-prefix"] [data-model-trigger]');
  const n = await modelTrigger.count();
  ok(n === 1, 'footer-prefix 里有模型入口（自绘触发器）', `n=${n}`);
  ok(
    (await page.locator('[data-permission-mode-select]').count()) === 1,
    'footer-prefix 里有权限下拉',
    ''
  );
  if (n === 1) {
    // 自绘触发器同样要满足 A30 的诉求：点开时不多出一圈描边/光环
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    const read = () =>
      modelTrigger.evaluate(el => {
        const cs = getComputedStyle(el);
        return { borderWidth: cs.borderTopWidth, boxShadow: cs.boxShadow };
      });
    const before = await read();
    await modelTrigger.click();
    await page.waitForTimeout(300);
    const after = await read();
    const opened = (await page.locator('[data-model-popup]').count()) > 0;
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    ok(opened, '模型触发器：点击确实展开了弹层（否则下面的断言是空转）');
    ok(
      after.borderWidth === before.borderWidth,
      '模型触发器：点击后没有多出边框',
      `${before.borderWidth} → ${after.borderWidth}`
    );
    ok(after.boxShadow === before.boxShadow, '模型触发器：点击后没有光环', `${before.boxShadow} → ${after.boxShadow}`);
  }
}

// ============= [2] 群设置面板：直角 + 邀请 / 移出 =============
console.log('\n[2] 群设置面板：直角 + 成员邀请/移出');

await go('/chat/g1');
await page.locator('[data-chat-more]').click();
await page.waitForTimeout(450);

const panel = page.locator('[data-group-settings] aside');
ok((await panel.count()) === 1, '群设置面板已打开');

{
  const radius = await panel.evaluate(el => {
    const cs = getComputedStyle(el);
    return {
      tl: cs.borderTopLeftRadius,
      bl: cs.borderBottomLeftRadius,
      tr: cs.borderTopRightRadius,
      br: cs.borderBottomRightRadius,
      overflow: cs.overflow,
    };
  });
  // A48（用户反馈）：「把红框这块设计成直角」。
  // 原断言是「左上/左下 ≥ 12px 圆角」—— 那是面板还是 portal 浮层的年代，
  // 圆角是为了让它看起来像一张浮起来的卡片。现在它是布局内的右栏
  // （与会话头部、成员栏同起同止），四角必须是直角。
  // ⚠️ 别再改回圆角：圆角要靠 `overflow-hidden` 裁，而那个裁切会顺带
  // 吃掉输入区的焦点环（见 GroupSettingsPanel.tsx 里的注释）。
  ok(parseFloat(radius.tl) === 0, '面板左上角是直角', radius.tl);
  ok(parseFloat(radius.bl) === 0, '面板左下角是直角', radius.bl);
  ok(parseFloat(radius.tr) === 0, '面板右上角是直角（贴窗口右缘）', radius.tr);
  ok(parseFloat(radius.br) === 0, '面板右下角是直角', radius.br);
  // 直角之后 overflow 不再承担「圆角裁切」，但面板内部仍是可滚动的长内容，
  // 保留 hidden 防止子元素滚出栏外。
  ok(radius.overflow === 'hidden', '面板裁切（内部滚动不溢出栏外）', radius.overflow);
}

{
  const removeBtns = page.locator('[data-settings-remove-member]');
  const memberRows = page.locator('[data-settings-member]');
  const n = await memberRows.count();
  ok(n === 2, '成员格子按成员数渲染', `n=${n}`);
  ok((await removeBtns.count()) === n, '每个成员后面都有移出按钮', `n=${await removeBtns.count()}`);
  ok((await page.locator('[data-settings-invite-toggle]').count()) === 1, '成员末尾有邀请入口');
}

{
  // 邀请：候选 = 全部 - 已在群
  await page.locator('[data-settings-invite-toggle]').click();
  await page.waitForTimeout(200);
  const list = page.locator('[data-settings-invite-list]');
  ok((await list.count()) === 1, '点邀请后展开候选名单');
  const items = page.locator('[data-settings-invite-item]');
  const ids = await items.evaluateAll(els => els.map(e => e.getAttribute('data-settings-invite-item')));
  ok(ids.length === 1 && ids[0] === 'gemini', '候选只含未进群的 Agent', ids.join(','));
  await page.locator('[data-settings-invite-item="gemini"] button').click();
  await page.waitForTimeout(400);
  const last = patches.at(-1);
  ok(!!last, '点「邀请」发出了 PATCH');
  ok(
    JSON.stringify(last?.body?.agentIds) === JSON.stringify(['workbuddy', 'claude', 'gemini']),
    'PATCH 带上新成员',
    JSON.stringify(last?.body)
  );
  const after = await page.locator('[data-settings-member]').count();
  ok(after === 3, '成员格子增加到 3', `n=${after}`);
}

{
  // 移出：从 3 人减到 2 人
  await page.locator('[data-settings-remove-member="gemini"]').click();
  await page.waitForTimeout(400);
  const last = patches.at(-1);
  ok(
    JSON.stringify(last?.body?.agentIds) === JSON.stringify(['workbuddy', 'claude']),
    '点「移出」发出了不含该成员的 PATCH',
    JSON.stringify(last?.body)
  );
  ok((await page.locator('[data-settings-member]').count()) === 2, '成员格子回到 2');
}

// ============= [3] 设置页 Agent API Key =============
console.log('\n[3] 设置页：Agent API Key');

await go('/settings');
// 切到「登录配置」分区
await page.getByRole('button', { name: /登录配置/ }).first().click();
await page.waitForTimeout(500);

ok((await page.locator('[data-agent-credentials-section]').count()) === 1, '登录配置里有「Agent API Key」分区');
const rows = page.locator('[data-credential-row]');
ok((await rows.count()) === 2, '按后端返回渲染凭据行', `n=${await rows.count()}`);
ok(
  (await page.locator('[data-credential-row="gemini"]').innerText()).includes('AIzaSy'),
  '已配置的显示掩码'
);

await page.locator('[data-credential-toggle="doubao"]').click();
await page.waitForTimeout(250);
ok((await page.locator('[data-credential-key="doubao"]').count()) === 1, '展开后出现 Key 输入框');

await page.locator('[data-credential-key="doubao"] input').fill('ark-test-abcdef123456');
await page.getByRole('button', { name: '保存' }).last().click();
await page.waitForTimeout(600);

const post = credPosts.at(-1);
ok(!!post, '点保存发出了 POST /api/agent-credentials');
ok(post?.agentId === 'doubao', '请求体带 agentId', JSON.stringify(post));
ok(post?.key === 'ark-test-abcdef123456', '请求体带明文 key（后端负责落盘与掩码）');

ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | '));

await page.screenshot({ path: join(OUT, 'verify-a30-settings.png') });

await browser.close();
server.close();

console.log(`\n结果：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
