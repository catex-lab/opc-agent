/**
 * A115 验证：九项 UI 反馈里的浏览器可测部分。
 *
 * 用户本轮提了九条，其中六条落在这个脚本里（其余靠 verify-a115-identity.ts
 * 测服务端注入、verify-a84.mjs 测权限配置表）：
 *
 *   [1] 切换会话不振荡    —— 用户反馈第 4 条「选中的列表上下回跳、内容屏闪」。
 *       这条是**根因级修复的回归守卫**：React Router v7 默认把路由 state 包进
 *       startTransition，导致 navigate() 与同事件里的 setCurrentSessionId()
 *       不在同一帧落地（详见 src/main.tsx 里 useTransitions={false} 的注释）。
 *       表现是选中行「新→旧→新」抖三下、消息区骨架出现两轮。
 *       没有这个断言，将来谁把那个参数当无关紧要删掉，bug 会静默回来。
 *   [2] 权限图标黑白化    —— 第 1/6 条「深色模式下锁图标仍是黑色看不清」。
 *       断言计算样式：四档图标必须全是中性色，且深色下明度必须高。
 *   [3] 设置页导航对比度  —— 第 8 条「菜单文字高亮，提高对比度」。
 *       未选中项与面板底的对比度 ≥ 4.5:1（WCAG AA 小字号）；选中项**不加粗**
 *       （A116 反转：用户要求「选中回显态不要加粗，使用原字体」）。
 *   [4] 弹窗立体影        —— 第 7 条「弹窗设计立体透明阴影效果」。
 *       四层外影（逐层放宽、Y 偏移同向、全半透明）+ 两条 inset 厚度边。
 *   [5] 群头像三处联动    —— 第 2 条「为群聊增加更换头像的功能」。
 *       会话列表 / 群聊头部 / 通讯录三处读同一个 sessionFlags.avatar。
 *   [6] 用户资料保存      —— 第 3 条「更换自己头像和昵称」。
 *       失焦即存（PUT）、失败回滚、字段只认 nickname/avatar。
 *
 * 运行：node scripts/verify-a115-ui.mjs（需先 npm run build）
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

// ── [1] 夹具：八个 Agent 各一个唯一名字 ──────────────────────────────────
// 会话行显示的是 **Agent 名**（remarks[agentId] || agent.name），不是会话
// 标题。名字唯一，行文本才能当会话身份用 —— 这是「选中项回跳」能被观测到
// 的前提：重名时两行文本相同，按文本反查永远分不清选的是哪一行。
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const AGENTS = NAMES.map((n, i) => ({
  id: `a${i + 1}`, name: `Agent${n}`, vendor: 'v', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability: 'ready', version: '1' },
}));
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const now = Date.now();
const SESSIONS = NAMES.map((n, i) => ({
  id: `s${i + 1}`, title: `会话${n}`, agent_id: `a${i + 1}`, model: 'm',
  created_at: new Date(now - (8 - i) * 60000).toISOString(),
}));
// ⚠️ id 只认 `s<N>` 形状：群会话的 id（a115-grp-1）切不出数字，
// 硬算会得到 NaN 时间戳，`toISOString()` 直接抛 RangeError ——
// 而且抛在 route handler 里，看起来像「页面白了」，其实是夹具炸了。
const msg = (sid, i, role) => {
  const idx = Number(sid.replace(/^s/, ''));
  const at = Number.isFinite(idx) ? now - (9 - idx) * 60000 + i * 1000 : now + i * 1000;
  return {
    id: `${sid}-m${i}`, role, session_id: sid,
    author_agent_id: role === 'assistant' && Number.isFinite(idx) ? `a${idx}` : undefined,
    created_at: new Date(at).toISOString(),
    content: role === 'assistant' ? `这是 ${sid} 的第 ${i} 条回复。`.repeat(6) : `问题 ${i}`,
    model: 'm',
  };
};

// ── [5]/[6] 夹具：群会话 + 用户资料 ───────────────────────────────────────
const GID = 'a115-grp-1';
// agent_ids 必须是 JSON 字符串（真实 API 的形状，parseAgentIds 走 JSON.parse）
const GROUP = {
  id: GID, title: '三剑客', agent_id: null, model: '', kind: 'group',
  agent_ids: JSON.stringify(['a1', 'a2']), orchestration: 'dispatch',
  created_at: new Date(now - 60000).toISOString(),
};

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  \u2713 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  else {
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
    failures.push(label);
  }
}

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = join(DIST, p);
  let body;
  try { body = await readFile(file); } catch { file = join(DIST, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/**
 * 通用夹具路由。`delay` 用在 /api/sessions/:id 上 —— 把「点了 → 骨架 →
 * 消息到」拉开到 300ms，振荡才有机会在逐帧采样里现形（不延迟时整个切换
 * 在一帧内完成，采样看到的所有情况都是「正常」）。
 */
async function newPage({ dark = false, delay = 0, groupFlags = null, profilePut = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ d, flags }) => {
    try {
      localStorage.setItem('theme', d ? 'dark' : 'light');
      if (flags) localStorage.setItem('opc:sessionFlags', JSON.stringify(flags));
    } catch { /* localStorage 被禁：当默认值 */ }
  }, { d: dark, flags: groupFlags });
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (url.includes('/api/user-profile')) {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        // profilePut 返回「fulfill 参数对象」；返回 null 表示用默认成功响应。
        // ⚠️ 两个坑都踩过：
        //   1) 不能 `return profilePut(body)` —— 返回普通对象不等于应答，
        //      route 永远不 fulfill，fetch 挂在空中，回滚/toast 全不触发，
        //      失败信息看起来像应用 bug，其实是夹具没应答；
        //   2) 自定义对象必须过一遍 route.fulfill() 才能真的变成响应。
        if (profilePut) {
          const custom = profilePut(body);
          if (custom) return route.fulfill(custom);
        }
        return json({ ok: true, profile: { nickname: body.nickname ?? '', avatar: body.avatar ?? '' } });
      }
      return json({ nickname: '', avatar: '' });
    }
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/').pop().split('?')[0];
      const s = [...SESSIONS, GROUP].find(x => x.id === id);
      const payload = { session: s, messages: s ? [msg(id, 1, 'user'), msg(id, 2, 'assistant')] : [] };
      if (delay) {
        await new Promise(r => setTimeout(r, delay));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      }
      return json(payload);
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: [...SESSIONS, GROUP] });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/** WCAG 相对亮度与对比度。颜色一律先过 getComputedStyle，拿到的是 rgb() */
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

// ============= [1] 切换会话不振荡 =============
console.log('\n[1] 切换会话：选中项不回跳、行序不重排、骨架不两轮');
{
  const { ctx, page, errors } = await newPage({ delay: 300 });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // 逐帧采样。⚠️ 两个坑（探针阶段各踩过一次）：
  //   1) console.log 写在 page.evaluate 里不会回 Node —— 只 return，打印在 Node 侧做；
  //   2) 不能等页面加载完再装 MutationObserver：本组要观测的元素（消息区）
  //      打开会话后才存在，装在 '/' 上等于没装。用 setInterval 每次重新查。
  await page.evaluate(() => {
    window.__frames = [];
    let last = '';
    const tick = () => {
      const rows = [...document.querySelectorAll('.tc-list-item')];
      const order = rows.map(r => (r.querySelector('.truncate')?.textContent || '?').replace('Agent', ''));
      let active = '';
      rows.forEach(r => { if (r.classList.contains('is-active')) active = (r.querySelector('.truncate')?.textContent || '').replace('Agent', ''); });
      const sc = document.querySelector('[data-chat-scroll]');
      const first = sc ? sc.firstElementChild : null;
      const kind = !first ? 'none' : first.hasAttribute('data-messages-loading') ? 'SKELETON'
        : first.hasAttribute('data-msg-list') ? 'MESSAGES' : 'OTHER';
      const key = `${location.pathname}|${active}|${order.join('')}|${kind}`;
      if (key !== last) {
        last = key;
        window.__frames.push({ path: location.pathname, active, order: order.join(''), kind });
      }
    };
    setInterval(tick, 30);
  });

  const byName = name => page.locator('.tc-list-item').filter({ hasText: `Agent${name}` });
  const flush = async () => {
    const f = await page.evaluate(() => { const r = window.__frames; window.__frames = []; return r; });
    return f;
  };

  /**
   * 分析一次切换的帧序列。
   * 回跳的判定：选中项第一次变成新会话之后，**再出现旧会话**就是回跳。
   * 修复前的实测序列是 丁→甲→丁（点「丁」之后先对一下，又弹回「甲」，再回「丁」）。
   */
  const analyze = (frames, from, to) => {
    const actives = frames.map(f => f.active).filter(Boolean);
    const firstTo = actives.indexOf(to);
    const orders = new Set(frames.map(f => f.order));
    const kinds = frames.map(f => f.kind);
    return {
      settled: firstTo !== -1,
      bounced: firstTo !== -1 && actives.slice(firstTo).includes(from),
      seq: actives.join('\u2192'),
      orderStable: orders.size <= 1,
      skeletonCount: kinds.filter(k => k === 'SKELETON').length,
      flipBackToSkeleton: kinds.lastIndexOf('MESSAGES') > kinds.indexOf('SKELETON') && kinds.slice(kinds.indexOf('SKELETON') + 1).includes('SKELETON'),
    };
  };

  const transitions = [
    { from: '', to: '甲', cached: false, label: '首次打开 Agent甲（s1）' },
    { from: '甲', to: '丁', cached: false, label: '切到 Agent丁（s4，未缓存）' },
    { from: '丁', to: '甲', cached: true, label: '切回 Agent甲（s1，已缓存）' },
    { from: '甲', to: '丁', cached: true, label: '再到 Agent丁（s4，已缓存）' },
    { from: '丁', to: '辛', cached: false, label: '切到 Agent辛（s8，未缓存）' },
  ];

  for (const t of transitions) {
    await byName(t.to).click();
    await page.waitForTimeout(900);
    const f = await flush();
    const r = analyze(f, t.from, t.to);
    ok(r.settled, `${t.label}：选中项落到新会话`, r.seq || '（无帧）');
    ok(!r.bounced, `${t.label}：选中项没有回跳成旧会话`, r.seq);
    ok(r.orderStable, `${t.label}：列表行序没有重排`, r.orderStable ? '' : [...new Set(f.map(x => x.order))].join(' | '));
    if (t.cached) {
      ok(r.skeletonCount === 0, `${t.label}：已缓存会话不出现骨架（零闪烁）`, `骨架帧 ${r.skeletonCount}`);
    } else {
      ok(r.skeletonCount <= 1, `${t.label}：骨架最多出现一轮`, `骨架帧 ${r.skeletonCount}`);
    }
  }

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [2] 权限图标黑白化（深色）=============
console.log('\n[2] 权限模式图标：四档中性色，深色下不消失');
{
  const { ctx, page } = await newPage({ dark: true });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('.tc-list-item').first().click();
  await page.waitForTimeout(700);

  // 点开权限模式下拉。TDesign Select 的 popup 挂在 body 下，
  // 选项里的图标 span 带内联 color（var(--tc-perm-*)），计算样式即真值。
  await page.locator('[data-permission-mode-select]').click();
  await page.waitForTimeout(400);

  const icons = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('.permission-select-popup .t-select-option, .permission-select-popup [class*="option"]')];
    return opts.map(o => {
      const span = o.querySelector('span[style*="color"]');
      return span ? getComputedStyle(span).color : null;
    }).filter(Boolean);
  });
  ok(icons.length === 4, '四档权限模式都在下拉里', `实测 ${icons.length} 项`);

  const neutral = icons.filter(c => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number);
    return r === g && g === b;
  });
  ok(neutral.length === icons.length, '四档图标全是中性色（r=g=b，黑白化）',
    icons.map(c => c.replace(/\s/g, '')).join(' '));

  // 深色模式专项：用户原话「红框位置的锁图标仍是黑色导致看不清」。
  // 中性色只是必要条件 —— 全黑也是中性色。还要明度够高，压在深色底上才看得见。
  if (icons.length) {
    const lum = c => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = await page.evaluate(() => {
      const el = document.querySelector('[data-permission-mode-select]');
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        n = n.parentElement;
      }
      return 'rgb(0,0,0)';
    });
    const minRatio = Math.min(...icons.map(c => contrast(c, bg)));
    ok(minRatio >= 3, '深色底上每档图标对比度 ≥ 3:1（锁不消失）', `最低 ${minRatio.toFixed(2)}:1，底 ${bg}`);
  }
  await ctx.close();
}

// ============= [3] 设置页导航对比度 =============
console.log('\n[3] 设置页导航：未选中项对比度达标，选中项不加粗');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const nav = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-settings-section]')];
    const panel = document.querySelector('[data-settings-panel]');
    // 面板底：往上找第一个不透明的背景
    let bg = 'rgb(255, 255, 255)';
    for (let n = panel; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
    }
    return items.map(el => {
      const span = el.querySelector('span');
      const cs = getComputedStyle(span || el);
      return {
        label: span?.textContent || '',
        color: cs.color,
        weight: Number(cs.fontWeight) || 400,
        active: el.getAttribute('aria-current') === 'page',
      };
    }).concat([{ bg }]);
  });
  const bg = nav.pop().bg;
  const inactive = nav.filter(n => !n.active);
  const ratios = inactive.map(n => contrast(n.color, bg));
  const minRatio = Math.min(...ratios);
  ok(minRatio >= 4.5, '未选中项文字对比度 ≥ 4.5:1（WCAG AA 小字号）',
    `最低 ${minRatio.toFixed(2)}:1（${inactive.map(n => n.label).join('/')}）`);

  const activeItem = nav.find(n => n.active);
  // A116（用户要求）：「选中回显态不要加粗，使用原字体」—— 这条断言随之反转。
  // 原来是 `weight >= 600`，现在要求「与未选中项完全相同」：任何字重差都会
  // 让那一行在选中/取消时横向跳动，比 600 这一个具体值更该守。
  const inactiveWeight = inactive[0]?.weight;
  ok(!!activeItem && activeItem.weight === inactiveWeight,
    '选中项不加粗（与未选中项同字重）',
    `选中 ${activeItem?.weight} vs 未选中 ${inactiveWeight}`);
  // 「在哪一区」不能只靠 12% 的浅底色说活 —— 选中项还要与未选中项分得开
  const activeRatio = activeItem ? contrast(activeItem.color, bg) : 0;
  ok(activeRatio >= 3, '选中项与底的对比度也达标（品牌色不是浅灰）', `${activeRatio.toFixed(2)}:1`);
  await ctx.close();
}

// ============= [4] 弹窗立体影 =============
console.log('\n[4] 弹窗：四层外影 + 两条厚度边');
{
  // 按逗号切 box-shadow 层，但 rgba(0, 0, 0, 0.1) 里自带逗号 ——
  // 数括号深度切，直接 split(',') 会把一层劈成三層。
  const splitLayers = s => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  for (const dark of [false, true]) {
    const { ctx, page } = await newPage({ dark });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    // 通讯录是左侧导航的一项（不是路由），「+」→「自定义 Agent」弹窗
    await page.locator('button[aria-label="通讯录"]').click();
    await page.waitForTimeout(800);
    await page.locator('button[aria-label="添加"]').click();
    await page.waitForTimeout(250);
    await page.locator('[data-contacts-custom-agent]').click();
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const el = document.querySelector('.tc-dialog');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        shadow: cs.boxShadow,
        hasBlur: /blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || ''),
        border: cs.borderTopWidth,
      };
    });
    ok(!!m, `${dark ? '深色' : '浅色'}：自定义 Agent 弹窗挂上了 .tc-dialog`);
    if (m) {
      const layers = splitLayers(m.shadow);
      const inset = layers.filter(l => /inset/.test(l));
      const outer = layers.filter(l => !/inset/.test(l));
      ok(outer.length === 4, `${dark ? '深色' : '浅色'}：四层外影（接触/本影/环境/远景）`, `${outer.length} 层`);
      ok(inset.length === 2, `${dark ? '深色' : '浅色'}：两条 inset 厚度边（顶亮底暗）`, `${inset.length} 条`);
      // 立体感三要素的兜底：每层都必须半透明，且 Y 偏移同向（光源在上）
      const yOffsets = outer.map(l => {
        const mm = l.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
        return mm ? Number(mm[2]) : null;
      });
      ok(yOffsets.every(y => y !== null && y >= 0), `${dark ? '深色' : '浅色'}：四层 Y 偏移同向（光源在上）`, yOffsets.join('/'));
      const allTransparent = outer.every(l => /rgba\([^)]*,\s*0?\.\d+\)/.test(l));
      ok(allTransparent, `${dark ? '深色' : '浅色'}：四层全部半透明（重叠处自然加深）`);
      ok(!!m.hasBlur, `${dark ? '深色' : '浅色'}：玻璃模糊生效`, String(m.hasBlur));
      await page.screenshot({ path: join(OUT, `a115-dialog-${dark ? 'dark' : 'light'}.png`) });
    }
    await ctx.close();
  }

  // 源码兜底：六个弹窗必须都走 .tc-dialog。漏一个不会报错，
  // 只会「那个弹窗的影跟别的不一样」—— 而这种不一致没有任何运行时信号。
  const { readFileSync } = await import('node:fs');
  const dialogFiles = ['ConfirmDialog.tsx', 'RemarkDialog.tsx', 'GetAgentsDialog.tsx', 'AgentDetailModal.tsx', 'NewGroupDialog.tsx', 'CustomAgentDialog.tsx'];
  const missing = dialogFiles.filter(f => {
    const src = readFileSync(join(ROOT, 'src', 'components', f), 'utf-8');
    return !/tc-dialog/.test(src);
  });
  ok(missing.length === 0, '六个模态弹窗全部挂 .tc-dialog', missing.join(', ') || 'all covered');
  // WorkflowDialog 走 TDesign Dialog，不套类名 —— 靠 index.css 的
  // .workflow-dialog .t-dialog 覆盖，同样要有
  const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf-8');
  ok(/\.workflow-dialog \.t-dialog[\s\S]*?--tc-dialog-shadow/.test(css), 'WorkflowDialog 也有四层影覆盖（TDesign 内部结构）');
}

// ============= [5] 群头像三处联动 =============
console.log('\n[5] 群头像：会话列表 / 群聊头部 / 通讯录读同一个值');
{
  const flags = { [GID]: { avatar: 'panda' } };
  const { ctx, page } = await newPage({ groupFlags: flags });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 会话列表：群聊行渲染 GroupAvatar（预设命中时 data-group-avatar = 预设 id）
  const listAvatar = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tc-list-item')];
    const row = rows.find(r => /三剑客/.test(r.textContent || ''));
    const av = row?.querySelector('[data-group-avatar]');
    return av?.getAttribute('data-group-avatar') ?? null;
  });
  ok(listAvatar === 'panda', '会话列表群行显示预设头像', String(listAvatar));

  // 群聊头部：打开群会话，leading 整颗换成 GroupAvatar。
  // ⚠️ 两个坑：
  //   1) GroupChatHeader 渲染在 [data-chat-page] **外面**（ChatPage 的
  //      return 里它在 527 行，data-chat-page 那个 div 572 行才开始），
  //      按 [data-chat-page] 收范围会一颗都找不到；
  //   2) 会话列表的群行也是 GroupAvatar，不区分的话命中哪一颗全看 DOM 顺序。
  //      区分办法：只有头部传了 title（= 群名），列表行不传。
  await page.locator('.tc-list-item').filter({ hasText: '三剑客' }).click();
  await page.waitForTimeout(900);
  const headerAvatar = await page.evaluate(() => {
    const av = document.querySelector('[data-group-avatar][aria-label="三剑客"]');
    return av?.getAttribute('data-group-avatar') ?? null;
  });
  ok(headerAvatar === 'panda', '群聊头部显示同一颗头像', String(headerAvatar));

  // 通讯录：群行同源。⚠️ 三件事：
  //   1) 通讯录默认停在 AGENT tab，群聊在第二个 tab，要先点「群聊」；
  //   2) 群聊 tab 的列表不在 [data-contacts-list] 里（那只是 AGENT tab
  //      的容器），群行在一个裸 <section> 下；
  //   3) 会话栏的群行可能同时在 DOM 里。所以不限定容器，改成「把所有
  //      含三剑客的行都找出来，逐颗断言」—— 多匹配一行也不会假失败。
  await page.locator('button[aria-label="通讯录"]').click();
  await page.waitForTimeout(800);
  await page.locator('[role="tab"]').filter({ hasText: '群聊' }).click();
  await page.waitForTimeout(600);
  const contactsAvatar = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tc-list-item')].filter(r => /三剑客/.test(r.textContent || ''));
    const avatars = rows.map(r => r.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null);
    return { count: rows.length, avatars };
  });
  ok(contactsAvatar.count >= 1 && contactsAvatar.avatars.every(a => a === 'panda'),
    '通讯录群行显示同一颗头像', `${contactsAvatar.count} 行：${contactsAvatar.avatars.join(',')}`);

  // 换头像：群设置里点预设 → 写 sessionFlags → 三处一起变。
  // ⚠️ 12 个预设的格子默认收起（236px 的面板里平铺会占掉半屏），
  // 要先点「更换头像」展开，否则 [data-avatar-option] 不在 DOM 里。
  await page.locator('.tc-list-item').filter({ hasText: '三剑客' }).last().click();
  await page.waitForTimeout(900);
  await page.locator('button[aria-label="群聊设置"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-group-avatar-toggle]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-avatar-option="rocket"]').click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const flags = JSON.parse(localStorage.getItem('opc:sessionFlags') || '{}');
    // 与上面同一处：头部那颗（带 aria-label），不在 data-chat-page 里
    const av = document.querySelector('[data-group-avatar][aria-label="三剑客"]');
    return { stored: flags['a115-grp-1']?.avatar ?? null, rendered: av?.getAttribute('data-group-avatar') ?? null };
  });
  ok(after.stored === 'rocket', '点预设写进了 sessionFlags', String(after.stored));
  ok(after.rendered === 'rocket', '界面立刻跟着变（订阅生效，不用刷新）', String(after.rendered));
  await ctx.close();
}

// ============= [6] 用户资料：失焦即存 + 失败回滚 =============
console.log('\n[6] 我的资料：PUT 落库、字段收敛、失败回滚');
{
  const puts = [];
  const { ctx, page } = await newPage({ profilePut: body => { puts.push(body); return null; } });
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('[data-settings-section="profile"]').click();
  await page.waitForTimeout(500);

  // ⚠️ 这里命中**两个**元素是对的：外层包装 div 带 data-settings-panel={section}
  // （它标记「当前在哪个分区」），ProfilePanel 根 div 自己也带一个。
  // 写死 === 1 会一直红 —— 但红的原因不是界面坏了，是没数清楚有几个源。
  ok(await page.locator('[data-settings-panel="profile"]').count() >= 1, '「我的资料」分区有内容');
  ok(await page.locator('[data-user-nickname-input]').count() === 1, '昵称输入框在');
  ok(await page.locator('[data-avatar-picker]').count() === 1, '头像选择器在');

  // 失焦即存：没有「保存」按钮，改完 blur 就该发 PUT
  await page.locator('[data-user-nickname-input]').fill('测试昵称');
  await page.locator('[data-user-nickname-input]').blur();
  await page.waitForTimeout(500);
  const nickPut = puts.find(p => 'nickname' in p);
  ok(!!nickPut && nickPut.nickname === '测试昵称', '失焦即发出 PUT（无保存按钮）', JSON.stringify(nickPut));

  // 点头像也要存
  await page.locator('[data-avatar-option="cat"]').click();
  await page.waitForTimeout(500);
  const avPut = puts.find(p => 'avatar' in p);
  ok(!!avPut && avPut.avatar === 'cat', '点预设发出 PUT', JSON.stringify(avPut));

  // 字段只认 nickname / avatar：多带的字段是接口漏洞
  const stray = puts.find(p => Object.keys(p).some(k => k !== 'nickname' && k !== 'avatar'));
  ok(!stray, 'PUT 只带 nickname / avatar 两个字段', stray ? JSON.stringify(stray) : 'clean');

  // 失败回滚：PUT 500 → 输入框回到原值 + 错误提示（不能静默丢字段）
  const { ctx: ctx2, page: page2 } = await newPage({
    profilePut: () => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }),
  });
  await page2.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page2.waitForTimeout(1000);
  await page2.locator('[data-settings-section="profile"]').click();
  await page2.waitForTimeout(500);
  await page2.locator('[data-user-nickname-input]').fill('不会保存的名字');
  await page2.locator('[data-user-nickname-input]').blur();
  await page2.waitForTimeout(600);
  const rolled = await page2.locator('[data-user-nickname-input]').inputValue();
  ok(rolled === '', 'PUT 失败后输入框回滚（不是把脏值留在框里）', `value="${rolled}"`);
  // 错误提示：TDesign 的 toast 类是 t-message t-is-error（不是 t-message--error）
  const errToast = await page2.locator('.t-message.t-is-error').count();
  ok(errToast > 0, '失败有错误提示（不静默）');
  await ctx.close();
  await ctx2.close();
}

// ============= 汇总 =============
await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '\u2713' : '\u2717'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  \u00b7 ${f}`));
  process.exit(1);
}


