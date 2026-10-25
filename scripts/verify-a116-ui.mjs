/**
 * A116 验证：用户三条 UI 反馈。
 *
 * 用户原话（三张截图）：
 *   1. 「设置页的红框位置上下占了太多空间，请缩小」
 *   2. 「选中回显态不要加粗，使用原字体」
 *   3. 「暗色模式下，图标、文字使用亮白色，不要灰色，例如刷新按钮图标及文案、
 *       agent 回复的正文、权限选框内的图标，亮色模式下同理，都要保证文字、
 *       图标清晰度」
 *
 * 三组断言，每组都守一个**具体的失效方式**：
 *
 *   [1] 标题栏高度 —— 守的是「又被加回去」。88px 那个值是为了让并排两栏的
 *       标题落在同一条水平线上（见 PanelHeader 文件头），设置是浮层、没有
 *       对齐对象，所以单独压到 60px。断言同时钉住「栏级仍是 88px」——
 *       否则将来有人图省事直接改 --panel-header-height，消息列表和资料页
 *       会跟着矮下去，而那种退化在截图里几乎看不出来。
 *
 *   [2] 选中项字重 —— 守的是「加粗悄悄回来」。A115 曾给选中项加一档
 *       font-semibold，A116 用户明确要求撤掉。断言「选中项与未选中项字重
 *       完全相同」，比断言「不等于 600」更严：将来换成 500 也算违规，
 *       因为任何字重差都会让那一行在切换时横向跳动。
 *
 *   [3] 提亮 —— 守的是「用 secondary 冒充清晰」。A115 把权限图标排成
 *       primary→secondary→placeholder 三档递减，深色下后两档明显发灰。
 *       这里的断言不看「对比度够不够」（3:1 是图标的下限，太松），而是
 *       **直接比对 --td-text-color-primary 的解析值**：用户要的是「亮白」，
 *       那就必须是那一档，差一档都算没改到位。浅色主题同理（那边 primary
 *       是近黑，同样要一模一样）。
 *
 * 运行：node scripts/verify-a116-ui.mjs（需先 npm run build）
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

// ── 夹具 ────────────────────────────────────────────────────────────────
const AGENTS = [{
  id: 'a1', name: 'WorkBuddy', vendor: 'v', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const now = Date.now();
const SESSIONS = [{
  id: 's1', title: '会话甲', agent_id: 'a1', model: 'm',
  created_at: new Date(now - 60000).toISOString(),
}];
const MSGS = [
  {
    id: 's1-m1', role: 'user', session_id: 's1', author_agent_id: undefined,
    created_at: new Date(now - 50000).toISOString(), content: '问题一', model: 'm',
  },
  {
    id: 's1-m2', role: 'assistant', session_id: 's1', author_agent_id: 'a1',
    created_at: new Date(now - 40000).toISOString(),
    // 正文要够长，才有一整个段落可以量颜色
    content: '我无法确定自己的具体模型版本。\n\n原因很简单：\n\n1. 我没有自省能力\n2. 平台动态路由\n',
    model: 'm',
  },
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

async function newPage({ dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(d => {
    try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* 存储被禁：用默认 */ }
  }, dark);
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/check-login/.test(url)) {
      // 「已登录」态：刷新按钮与那颗绿勾都在这条分支下
      return json({
        isLoggedIn: true, method: 'env', envConfigured: true, cliConfigured: false,
        apiKey: 'sk-****1234',
      });
    }
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/').pop().split('?')[0];
      const s = SESSIONS.find(x => x.id === id);
      return json({ session: s, messages: s ? MSGS : [] });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

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

/**
 * 页面里量 `--td-text-color-primary` 的**解析值**。
 *
 * 为什么要一个探针元素而不是读 `:root` 的自定义属性：`getPropertyValue('--x')`
 * 拿到的是原始 token 文本（`#fafafa`），而 `getComputedStyle(el).color` 拿到的是
 * 浏览器算完的 `rgb(...)`。两边格式不同没法比，所以在 body 上挂一个临时元素
 * 让浏览器自己解析一遍，取同一口径。
 */
const PRIMARY_PROBE = `(() => {
  const d = document.createElement('div');
  d.style.color = 'var(--td-text-color-primary)';
  d.style.position = 'absolute';
  d.style.opacity = '0';
  document.body.appendChild(d);
  const c = getComputedStyle(d).color;
  d.remove();
  return c;
})()`;

// ============= [1] 设置页标题栏高度 =============
console.log('\n[1] 设置页标题栏：压到 60px，关闭键不骑圆角');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const panel = document.querySelector('[data-settings-panel]');
    const header = panel?.querySelector('header');
    const close = document.querySelector('[data-settings-close]');
    const r = el => el ? el.getBoundingClientRect() : null;
    const hb = r(header), pb = r(panel), cb = r(close);
    return {
      headerH: hb ? Math.round(hb.height) : null,
      // 关闭键相对弹窗的「距顶 / 距右」——A114 实测过的落点是 (11, 16)
      closeTop: cb && pb ? Math.round(cb.top - pb.top) : null,
      closeRight: cb && pb ? Math.round(pb.right - cb.right) : null,
      closeSize: cb ? Math.round(cb.width) : null,
      radius: panel ? parseFloat(getComputedStyle(panel).borderRadius) || 0 : 0,
    };
  });

  // 60px 是新令牌的值；留 2px 容差（边框/取整）
  ok(m.headerH !== null && m.headerH <= 62, '设置标题栏高度 ≤ 62px（原 88px）', `实测 ${m.headerH}px`);
  ok(m.headerH !== null && m.headerH >= 56, '设置标题栏不至于压扁（≥ 56px）', `实测 ${m.headerH}px`);

  // 关闭键不能压到弹窗圆角上：距顶/距右都必须大于圆角半径的一半
  ok(m.closeTop !== null && m.closeTop >= 8, '关闭键距弹窗顶 ≥ 8px（不骑 16px 圆角）', `实测 ${m.closeTop}px`);
  ok(m.closeRight !== null && m.closeRight >= 8, '关闭键距弹窗右 ≥ 8px', `实测 ${m.closeRight}px`);

  // 反向守卫：`--panel-header-height` 必须仍是 88px。有人图省事直接改这个
  // 令牌来「省空间」时，这条会立刻红 —— 那种退化在截图里几乎看不出来
  // （资料页的标题会悄悄矮 28px，而没人会拿两张截图去对）。
  //
  // ⚠️ 这里不量某个具体 header：A103 之后会话列表栏头已经换成 52px 的搜索行，
  // 全应用还在吃 88px 的只剩资料页 —— 拿「页面上第一个 header」当参照，
  // 量到的是聊天头部（compact 52px），断言必红。第一版就踩了这个坑。
  // 直接读令牌值，守的是「别动这个数」这个意图本身，与页面结构解耦。
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      base: cs.getPropertyValue('--panel-header-height').trim(),
      dense: cs.getPropertyValue('--panel-header-height-dense').trim(),
    };
  });
  ok(tokens.base === '88px', '--panel-header-height 仍是 88px（栏级未被连带压矮）', tokens.base || '未定义');
  ok(tokens.dense === '60px', '--panel-header-height-dense 是 60px', tokens.dense || '未定义');

  await page.screenshot({ path: join(OUT, 'a116-settings-light.png') });
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [2] 导航选中态不加粗 =============
console.log('\n[2] 设置页导航：选中项与未选中项字重完全相同');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const nav = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-settings-section]')].map(el => {
      const span = el.querySelector('span');
      const cs = getComputedStyle(span || el);
      return {
        label: span?.textContent || '',
        weight: Number(cs.fontWeight) || 400,
        family: cs.fontFamily,
        active: el.getAttribute('aria-current') === 'page',
      };
    });
  });

  const active = nav.find(n => n.active);
  const inactive = nav.filter(n => !n.active);
  ok(!!active, '有一个分区处于选中态', active?.label);
  ok(inactive.length === nav.length - 1, '其余分区都是未选中态', `${inactive.length}/${nav.length}`);

  const weights = [...new Set(nav.map(n => n.weight))];
  ok(weights.length === 1, '全部导航项同一字重（选中不加粗）', `实测 ${weights.join('/')}`);
  ok(active && active.weight === inactive[0]?.weight, '选中项字重 === 未选中项字重',
    `选中 ${active?.weight} vs 未选中 ${inactive[0]?.weight}`);

  // 字体族也要一致：加粗若通过换字体实现，字宽同样会跳
  const families = [...new Set(nav.map(n => n.family))];
  ok(families.length === 1, '选中项与未选中项同一字体族', families.length === 1 ? families[0].slice(0, 40) : `${families.length} 种`);

  // 撤掉加粗后，「在哪一区」只能靠颜色 + 底色 —— 所以这两层必须真的分得开
  const colors = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-settings-section]')];
    const a = items.find(el => el.getAttribute('aria-current') === 'page');
    const i = items.find(el => el.getAttribute('aria-current') !== 'page');
    const bgOf = el => {
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        n = n.parentElement;
      }
      return 'rgb(255,255,255)';
    };
    return {
      activeColor: getComputedStyle(a).color,
      inactiveColor: getComputedStyle(i).color,
      activeBg: getComputedStyle(a).backgroundColor,
      inactiveBg: getComputedStyle(i).backgroundColor,
    };
  });
  ok(colors.activeColor !== colors.inactiveColor, '选中项颜色与未选中项不同（品牌色）',
    `${colors.activeColor} vs ${colors.inactiveColor}`);
  ok(colors.activeBg !== colors.inactiveBg, '选中项有独立底色（12% 品牌色）',
    `${colors.activeBg} vs ${colors.inactiveBg}`);

  await ctx.close();
}

// ============= [3] 刷新按钮 + 权限图标 + 正文：两主题都要「亮」 =============
for (const dark of [true, false]) {
  const tag = dark ? '深色' : '浅色';
  console.log(`\n[3] ${tag}主题：刷新按钮 / 权限图标 / Agent 正文 必须是 primary 档`);
  const { ctx, page, errors } = await newPage({ dark });

  // ── 刷新按钮（设置 → 登录配置）────────────────────────────────────
  await page.goto(base + '/settings?section=login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const refresh = await page.evaluate(PRIMARY_PROBE).then(primary => page.evaluate(p => {
    const btn = [...document.querySelectorAll('button')].find(b => /刷新/.test(b.textContent || ''));
    if (!btn) return { missing: true };
    const cs = getComputedStyle(btn);
    const svg = btn.querySelector('svg');
    return {
      primary: p,
      color: cs.color,
      weight: cs.fontWeight,
      svgColor: svg ? getComputedStyle(svg).color : null,
      bg: (() => {
        let n = btn;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
          n = n.parentElement;
        }
        return 'rgb(255,255,255)';
      })(),
    };
  }, primary));

  ok(!refresh.missing, `${tag}：找到「刷新」按钮`);
  if (!refresh.missing) {
    ok(refresh.color === refresh.primary, `${tag}：刷新文案走 primary（亮白/近黑）`,
      `${refresh.color} vs primary ${refresh.primary}`);
    ok(refresh.svgColor === null || refresh.svgColor === refresh.primary,
      `${tag}：刷新图标与文案同色`, `${refresh.svgColor}`);
    ok(contrast(refresh.color, refresh.bg) >= 4.5, `${tag}：刷新按钮对比度 ≥ 4.5:1`,
      `${contrast(refresh.color, refresh.bg).toFixed(2)}:1（底 ${refresh.bg}）`);
  }
  // 深色那张正是用户截图 1 的场景（登录配置 + 右上角刷新），留档便于肉眼比对
  await page.screenshot({ path: join(OUT, `a116-settings-login-${dark ? 'dark' : 'light'}.png`) });

  // ── 权限四档图标 ─────────────────────────────────────────────────
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('.tc-list-item').first().click();
  await page.waitForTimeout(900);
  await page.locator('[data-permission-mode-select]').click();
  await page.waitForTimeout(500);

  const perm = await page.evaluate(PRIMARY_PROBE).then(primary => page.evaluate(p => {
    const opts = [...document.querySelectorAll(
      '.permission-select-popup .t-select-option, .permission-select-popup [class*="option"]',
    )];
    const rows = opts.map(o => {
      const span = o.querySelector('span[style*="color"]');
      return {
        label: (o.textContent || '').trim(),
        color: span ? getComputedStyle(span).color : null,
      };
    }).filter(r => r.color);
    // 下拉面板底：往上找第一个不透明背景
    let bg = 'rgb(255,255,255)';
    const popup = document.querySelector('.permission-select-popup');
    for (let n = popup; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
    }
    return { primary: p, rows, bg };
  }, primary));

  ok(perm.rows.length === 4, `${tag}：四档权限模式都在下拉里`, `实测 ${perm.rows.length} 项`);
  const notPrimary = perm.rows.filter(r => r.color !== perm.primary);
  ok(notPrimary.length === 0, `${tag}：四档图标全部走 primary（不留灰档）`,
    notPrimary.length ? notPrimary.map(r => `${r.label}=${r.color}`).join(' ') : perm.rows.map(r => r.label).join('/'));
  if (perm.rows.length) {
    const minRatio = Math.min(...perm.rows.map(r => contrast(r.color, perm.bg)));
    ok(minRatio >= 4.5, `${tag}：每档图标对比度 ≥ 4.5:1`, `最低 ${minRatio.toFixed(2)}:1（底 ${perm.bg}）`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ── Agent 回复正文 ───────────────────────────────────────────────
  // 正文由 TDesign 的 ChatMarkdown 渲染在 **Shadow DOM** 里（t-chat-md-content），
  // 所以选择器要逐层钻进去。钻不到时返回 null 并单独报一条 —— 别让它静默算成
  // 「0 个元素 = 全部通过」。
  const body = await page.evaluate(PRIMARY_PROBE).then(primary => page.evaluate(p => {
    const hosts = [...document.querySelectorAll('.chat-markdown t-chat-md-content, t-chat-md-content')];
    const found = [];
    for (const h of hosts) {
      let root = h.shadowRoot;
      // 有的版本正文在再下一层 shadow 里，最多钻三层
      for (let d = 0; root && d < 3; d++) {
        const p = root.querySelector('p');
        if (p) {
          found.push({ depth: d, color: getComputedStyle(p).color, tag: p.tagName });
          break;
        }
        const next = root.querySelector('*');
        root = next && next.shadowRoot;
      }
    }
    // 背景取消息区容器
    let bg = 'rgb(255,255,255)';
    const area = document.querySelector('[data-chat-scroll]') || document.body;
    for (let n = area; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
    }
    return { primary: p, found, bg };
  }, primary));

  ok(body.found.length > 0, `${tag}：钻到 Agent 正文（Shadow DOM）`, body.found.map(f => `depth${f.depth}/${f.tag}`).join(' '));
  if (body.found.length) {
    const colors = [...new Set(body.found.map(f => f.color))];
    ok(colors.length === 1 && colors[0] === body.primary, `${tag}：正文颜色 === primary（亮白/近黑）`,
      `${colors.join('/')} vs primary ${body.primary}`);
    const minRatio = Math.min(...body.found.map(f => contrast(f.color, body.bg)));
    ok(minRatio >= 7, `${tag}：正文对比度 ≥ 7:1（AAA 正文档）`, `最低 ${minRatio.toFixed(2)}:1（底 ${body.bg}）`);
  }

  await page.screenshot({ path: join(OUT, `a116-chat-${dark ? 'dark' : 'light'}.png`) });
  ok(errors.length === 0, `${tag}：无控制台错误`, errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
