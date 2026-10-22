/**
 * A27 验证：浮层在 100% 透明度下的可读性。
 *
 * ## 这个脚本在防什么
 *
 * 用户报的现象是「透明度拉到 100，涉及弹窗或悬浮的页面都会把下层内容
 * 展示出来，导致弹窗页面杂乱」。根因不是某一个弹窗写错了色，而是**一整类
 * 元素共用了同一个错误规则**：浮层的底色取自「抬升面 / 内容面」，
 * 而那两个 alpha 在 t=100 时归零。
 *
 * 所以这里不逐个截图看，而是量一个可判定的数字：**有效底色 alpha**。
 *
 *   有效 alpha = 1 − Π(1 − 各层 background-color 的 alpha)
 *
 * 沿祖先链累乘，得到的是「这个位置把背后的内容挡住了多少」。
 * 0.9 表示只透出 10%，字变成极淡的影；0 表示完全没挡，两层字叠在一起。
 *
 * ## 为什么不能只看 blur
 *
 * A26 的注释里写过「alpha 掉到 0 时它仍然是一块磨砂玻璃」，这句是错的：
 * blur 只降低**细节**，不降低**对比度**。而且 `backdrop-filter` 在透明窗口
 * （本应用的常态）里并不可靠，实测可能整块空转。所以判据只能是底色。
 *
 * ## 覆盖范围
 *
 * 七类浮层，深浅两套主题各跑一遍：
 *   1. 通讯录 · 悬浮名片（hover）
 *   2. 通讯录 · 「添加」下拉
 *   3. 通讯录 · Agent 资料弹窗
 *   4. 消息页 · 会话右键菜单
 *   5. 消息页 · 聊天头部「更多」下拉
 *   6. 群聊 · 群设置滑出面板 + 群消息设置下拉
 *   7. 设置页 · 修改备注 / 删除确认
 * 外加 TDesign 的 `.t-popup__content`（模型选择下拉）。
 *
 * 运行：node scripts/verify-overlay.mjs（需先 npm run build）
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
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手，可读写文件、执行命令', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', kind: 'cli', icon: 'openai', color: '#0A0A0A', description: 'OpenAI 官方编码 Agent', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '0.16.0' }, permissionSupport: { enforced: ['default'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构', capabilities: ['chat', 'code'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default'] } },
  { id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'cli', icon: 'hermes', color: '#7C3AED', description: '推理型 Agent', capabilities: ['chat'], status: { availability: 'ready', version: '3.1' }, permissionSupport: { enforced: ['default'] } },
];
const MODELS = [
  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡' },
  { modelId: 'gpt-5', name: 'GPT-5', description: '通用' },
];
// ⚠️ 时间戳必须刻意拉开：会话列表按 lastAt 倒序排，而 lastAt 会退到
// created_at。两个会话都用 new Date() 时可能拿到**同一毫秒**，排序结果
// 取决于 V8 稳定排序的输入顺序，偶发让群聊排在单聊前面 ——「点第一个
// 列表项」就可能落到群聊，而群聊头部没有单聊的 [data-chat-more]，
// 第 3/5 组会间歇性报「找不到入口」。这里给 s2 一个显式更早的创建时间。
const T0 = Date.now();
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date(T0).toISOString() },
  { id: 's2', title: '三剑客', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'group', agent_ids: ['workbuddy', 'codex', 'hermes'], orchestration: 'dispatch', created_at: new Date(T0 - 3600e3).toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我看下品牌色，还有边线的处理', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '已经统一成石墨黑，边线和实色块也跟着透明度走了。这句话足够长，用来充当「浮层背后有正文」的背景。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() },
];

/** 模拟壁纸：偏暗的斜向渐变（浅色主题 + 深壁纸是最坏的一档） */
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

async function newContext(transparency, dark) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(
    ({ t, d }) => {
      localStorage.setItem('opc.transparency', String(t));
      localStorage.setItem('theme', d ? 'dark' : 'light');
    },
    { t: transparency, d: dark }
  );
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
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

function watch(page) {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
}

/** 打开页面并铺好壁纸（必须在 goto 之后：initScript 里 documentElement 还是 null） */
async function open(page, path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  await page.evaluate(wp => {
    document.documentElement.style.backgroundImage = wp;
    document.documentElement.style.backgroundSize = 'cover';
  }, WALLPAPER);
  await page.waitForTimeout(200);
}

/**
 * 量一个浮层根节点的**有效底色 alpha**。
 *
 * 做法：沿祖先链把 background-color 的 alpha 按「上层压下层」合成。
 *   总不透明度 = 1 − Π(1 − αᵢ)
 *
 * 只算 background-color，不算 background-image —— 本项目所有浮层底色都是
 * 纯色，渐变只用在分栏线和壁纸上。碰到渐变会返回 0 并在报告里标出来，
 * 不会被静默当成「不透明」。
 */
const MEASURE = sel => {
  const alphaOf = c => {
    if (!c) return 0;
    const m = c.match(/rgba?\(([^)]*)\)/);
    if (!m) return 0;
    const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };
  const el = document.querySelector(sel);
  if (!el) return { sel, found: false };
  const chain = [];
  let inv = 1;
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const a = alphaOf(cs.backgroundColor);
    if (a > 0) {
      inv *= 1 - a;
      chain.push(`${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''}=${a.toFixed(2)}`);
    }
    if (1 - inv > 0.995) break;
  }
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    sel,
    found: true,
    effAlpha: Number((1 - inv).toFixed(3)),
    chain,
    bg: cs.backgroundColor,
    backdrop: cs.backdropFilter,
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
  };
};

/**
 * 下限。
 *
 * 设计值 0.9（见 uiPrefs.ts 的 OVERLAY_ALPHA_FLOOR），这里放到 0.88 是给
 * 合成误差留余量 —— 不是为了放水：0.88 已经能把穿透压到 1.3:1 以内。
 * 一旦有人把浮层改回 `--opc-raised-alpha` 这类会归零的变量，数值会直接
 * 掉到 0.0，这一条立刻失败。
 */
const FLOOR = 0.88;

/** 量一个浮层并断言。返回测量结果，方便失败时贴细节 */
async function expectOverlay(page, label, sel) {
  const m = await page.evaluate(MEASURE, sel);
  if (!m.found) {
    ok(false, `${label}：浮层没出现`, sel);
    return m;
  }
  ok(m.effAlpha >= FLOOR, `${label}：底色 alpha ≥ ${FLOOR}`, `实测 ${m.effAlpha}（${m.chain.join(' × ')}）`);
  return m;
}

for (const dark of [false, true]) {
  const tag = dark ? '深色' : '浅色';
  console.log(`\n================ ${tag} · 透明度 100% ================`);
  const ctx = await newContext(100, dark);
  const page = await ctx.newPage();
  watch(page);

  // ── 1. 通讯录 · 悬浮名片 ──
  await open(page, '/?glass=1');
  await page.locator('nav button').nth(1).click();
  await page.waitForTimeout(600);
  {
    const avatars = page.locator('[data-agent-avatar]');
    const card = page.locator('.tc-glass.fixed.z-50');
    for (let i = 0; i < Math.min(4, await avatars.count()); i++) {
      await avatars.nth(i).hover().catch(() => {});
      await page.waitForTimeout(500);
      if (await card.count()) break;
    }
    await expectOverlay(page, `${tag} · 悬浮名片`, '.tc-glass.fixed.z-50');
    await page.screenshot({ path: join(OUT, `overlay-card-${dark ? 'dark' : 'light'}.png`) });
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);
  }

  // ── 2. 通讯录 ·「添加」下拉 ──
  {
    await page.getByRole('button', { name: '添加' }).click();
    await page.waitForTimeout(450);
    // 这个下拉以前没挂 .tc-glass，底是 --td-bg-color-container（会归零）
    await expectOverlay(page, `${tag} · 「添加」下拉`, '.tc-glass.absolute.z-30');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 700);
    await page.waitForTimeout(300);
  }

  // ── 3. 消息页 · Agent 资料弹窗 ──
  //     入口在聊天头部：头像 / 「更多 → 查看资料」。
  //     ⚠️ 通讯录里的「查看资料」是**跳页**，不是弹窗 —— 别在那儿找。
  //     ⚠️ 直达 /chat/s1?glass=1 而不是「点第一个列表项」：群聊头部没有
  //     [data-chat-more]，列表顺序一旦变化就会点到群聊上，报一个跟真实
  //    缺陷无关的「找不到入口」。?glass=1 也**不能省** —— 它是
  //    data-opc-glass=1 的来源，缺了它浏览器跑的是不透明界面，alpha 断言
  //    会全部退化成 1（看着过，其实什么都没测）。
  await open(page, '/chat/s1?glass=1');
  {
    const more = page.locator('[data-chat-more] summary').first();
    if (await more.count()) {
      await more.click();
      await page.waitForTimeout(400);
      const item = page.locator('[data-chat-more] .tc-glass button').first();
      if (await item.count()) {
        await item.click();
        await page.waitForTimeout(650);
        await expectOverlay(page, `${tag} · Agent 资料弹窗`, '[data-agent-detail-overlay] [role="dialog"]');
        await page.screenshot({ path: join(OUT, `overlay-detail-${dark ? 'dark' : 'light'}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      } else {
        ok(false, `${tag} · Agent 资料弹窗：菜单里没有入口`);
      }
    } else {
      ok(false, `${tag} · Agent 资料弹窗：找不到头部入口`);
    }
  }

  // ── 4/5. 消息页 · 右键菜单 + 头部「更多」 ──
  await open(page, '/?glass=1');
  {
    // 按名字定位单聊那一行，不依赖列表顺序（顺序已由 fixtures 钉死，
    // 这里再显式一层是为了让失败信息直接指向「这一行没了」）
    const row = page.locator('.tc-list-item', { hasText: 'WorkBuddy' }).first();
    await row.click({ button: 'right', position: { x: 20, y: 20 } }).catch(() => {});
    await page.waitForTimeout(450);
    await expectOverlay(page, `${tag} · 会话右键菜单`, '[role="menu"]');
    await page.screenshot({ path: join(OUT, `overlay-menu-${dark ? 'dark' : 'light'}.png`) });
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 700);
    await page.waitForTimeout(350);
  }
  {
    // 同第 3 组：直达单聊（含 glass=1），不依赖「第一个列表项」是单聊还是群聊
    await open(page, '/chat/s1?glass=1');
    const more = page.locator('[data-chat-more] summary').first();
    if (await more.count()) {
      await more.click();
      await page.waitForTimeout(450);
      await expectOverlay(page, `${tag} · 头部「更多」下拉`, '[data-chat-more] .tc-glass');
      await page.mouse.click(700, 700);
      await page.waitForTimeout(350);
    } else {
      ok(false, `${tag} · 头部「更多」：找不到入口`);
    }
  }

  // ── 6. 群聊 · 群设置滑出面板 + 群消息设置下拉 ──
  {
    await page.getByText('三剑客', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    const gear = page.locator('button[aria-label="群聊设置"]').first();
    if (await gear.count()) {
      await gear.click();
      await page.waitForTimeout(700);
      await expectOverlay(page, `${tag} · 群设置面板`, '[data-group-settings] [role="dialog"]');
      await page.screenshot({ path: join(OUT, `overlay-panel-${dark ? 'dark' : 'light'}.png`) });
      const trig = page.locator('[data-notify-trigger]').first();
      if (await trig.count()) {
        await trig.click();
        await page.waitForTimeout(450);
        await expectOverlay(page, `${tag} · 群消息设置下拉`, '[role="listbox"]');
        // 下拉是自定义的，Esc 不归它管 —— 再点一次触发器才收得掉。
        // 不收掉的话它会盖住面板底部的「退出群聊」，下一段点击会被它拦住。
        await trig.click();
        await page.waitForTimeout(350);
      } else {
        ok(false, `${tag} · 群消息设置：找不到入口`);
      }
    } else {
      ok(false, `${tag} · 群设置面板：找不到入口`);
    }
  }

  // ── 7. 修改备注弹窗 / 退出群聊确认框 ──
  //     ⚠️ 群设置面板里的「填写备注」是**就地编辑**（换成 input），不是弹窗；
  //     RemarkDialog 的真实入口是会话右键菜单。
  {
    // 同样按名字定位单聊那一行（右键菜单对单聊和群聊都长一样，
    // 但「修改备注」的语义是改这个会话的备注，行选错会让截图失真）
    const row = page.locator('.tc-list-item', { hasText: 'WorkBuddy' }).first();
    await row.click({ button: 'right', position: { x: 20, y: 20 } }).catch(() => {});
    await page.waitForTimeout(450);
    const remarkItem = page.locator('[role="menu"] button', { hasText: '修改备注' }).first();
    if (await remarkItem.count()) {
      await remarkItem.click();
      await page.waitForTimeout(550);
      await expectOverlay(page, `${tag} · 修改备注弹窗`, '[data-remark-dialog]');
      await page.screenshot({ path: join(OUT, `overlay-remark-${dark ? 'dark' : 'light'}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
    } else {
      ok(false, `${tag} · 修改备注：菜单里没有入口`);
    }
  }
  {
    await open(page, '/?glass=1');
    await page.getByText('三剑客', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const gear = page.locator('button[aria-label="群聊设置"]').first();
    if (await gear.count()) {
      await gear.click();
      await page.waitForTimeout(600);
      const exit = page.locator('[data-exit-group]').first();
      if (await exit.count()) {
        await exit.click();
        await page.waitForTimeout(500);
        await expectOverlay(page, `${tag} · 退出群聊确认框`, '[data-confirm-dialog]');
        await page.screenshot({ path: join(OUT, `overlay-confirm-${dark ? 'dark' : 'light'}.png`) });
        await page.getByRole('button', { name: '取消' }).click().catch(() => {});
      } else {
        ok(false, `${tag} · 退出群聊：找不到入口`);
      }
    }
  }

  // ── 8. 令牌自证：--opc-overlay-alpha 必须钉在下限 ──
  {
    const tok = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const resolve = v => {
        probe.style.backgroundColor = `var(${v})`;
        return getComputedStyle(probe).backgroundColor;
      };
      const out = {
        t: cs.getPropertyValue('--opc-t').trim(),
        overlay: cs.getPropertyValue('--opc-overlay-alpha').trim(),
        chrome: cs.getPropertyValue('--opc-chrome-alpha').trim(),
        glassBg: resolve('--tc-glass-bg'),
        popupBg: resolve('--tc-overlay-surface'),
      };
      probe.remove();
      return out;
    });
    const a = Number((tok.glassBg.match(/[\d.]+\)$/) ?? ['0)'])[0].replace(')', '')) || 0;
    const b = Number((tok.popupBg.match(/[\d.]+\)$/) ?? ['0)'])[0].replace(')', '')) || 0;
    ok(a >= FLOOR, `${tag} · --tc-glass-bg 不随内容面归零`, tok.glassBg);
    ok(b >= FLOOR, `${tag} · --tc-overlay-surface 不随抬升面归零`, tok.popupBg);
    ok(tok.chrome === '0.000', `${tag} · 框架面确实归零（前提成立）`, tok.chrome);
  }

  await ctx.close();
}

console.log('\n================ 汇总 ================');
ok(errors.length === 0, '控制台无错误', errors.slice(0, 3).join(' | ') || '0 条');
console.log(`\n共 ${checks.total} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
