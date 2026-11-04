/**
 * A138：设置弹窗尺寸恒定。
 *
 * ## 问题
 *
 * 用户原话：「设置页的每一个具体页面的内容多少不一样，导致现在的设置页的大小
 * 不统一，每打开一个设置页的选项，设置页的窗口大小都会重新变化大小」。
 *
 * 根因很具体：`App.tsx` 里弹窗写的是 `h-auto max-h-[min(700px,100%)]`，
 * 高度跟着内容走。实测 8 个分区里 5 个是 419px、2 个顶到 700px，**极差 281px**；
 * 加上外层是 `items-center`，高度一变 top 也跟着变 —— 整块弹窗在切换分区时
 * 上下同时跳，读起来像「每次都重新开了一个窗口」。
 *
 * 修法：`h-[min(700px,100%)]`，高度恒定，内容多的分区自己滚。
 *
 * ## 为什么单独一个闸门
 *
 * `a37`（设置页结构）、`a115`/`a116`（导航与标题栏）量的都是**某一帧**的样式，
 * 它们看不见「切换分区时尺寸变了」—— 那需要**跨分区比较**。
 * 这类「每个状态单看都正常、连起来才不对」的缺陷，必须专门量一次序列。
 *
 * ## 反向探针
 *
 * `--probe-h-auto` 会在运行时把弹窗退回坏版本（`height:auto` + `max-height`），
 * 不重建 dist 就能验证本脚本的断言真的会红。
 *
 * 运行：node scripts/verify-a138-settings-size.mjs [--probe-h-auto]
 * 需先 npm run build。
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a138');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = process.argv.includes('--probe-h-auto');

/** 修完之后的规格：高度上限 700，与改动前 `max-h` 同一个数（不引入新数字） */
const MAX_H = 700;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const failures = [];
let total = 0;
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

/**
 * 记忆面板塞 6 条技能。
 *
 * 这不是为了好看：本脚本有一条「切分区后内容区回到顶部」，它需要**至少两个
 * 分区的内容真的比容器高**。只给 1 条技能时记忆面板不满一屏，那条断言会
 * 永远绿 —— 典型的空断言。
 */
const SKILLS = Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i + 1}`, tokens: 120 + i * 10 }));

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

/**
 * 2026-11-04 追加：关于页三段式布局的 DOM 断言。
 *
 * 只测结构会漏掉「一页三段」真正的失败态 —— 版本条又变成三行、说明正文
 * 又把更新区撑开、隐私卡被折叠。所以在同一份 700px 弹窗里量高度、量实际
 * 占用、量弹层开合，并跑浅/深两套主题确认配色跟着令牌走。
 *
 * 更新区需要「有可用版本」态：浏览器开发态没有 preload，这里注入一个
 * 最小的 `window.opc` 桥（只在本次 section 的 context 里），把状态固定成
 * available，说明正文里刻意混入 `##`、`**` 与转义反斜杠。
 */
const NOTES_FIXTURE = [
  '## 修复',
  '',
  '- **升级失败的红字不再常驻**',
  '  卡片新增「忽略」入口，失败后自动清理残留',
  '- 下载失败**不再**把上一次的错误盖掉',
  '',
  '### 说明',
  '',
  '转义写法 \\*\\*也应还原\\*\\*，行内 `code` 可读。',
].join('\n');

const ABOUT_FIXTURE = {
  appInfo: {
    name: 'OPC Agent',
    version: '1.0.9',
    electron: '44.7.2',
    node: '22.20.0',
    chrome: '144.0.0.0',
    platform: 'win32',
    arch: 'x64',
  },
  updateState: {
    phase: 'available',
    currentVersion: '1.0.8',
    supported: true,
    checkedAt: '2026-11-04T02:00:00.000Z',
    release: { version: '1.0.9', notes: NOTES_FIXTURE, size: 2_100_000, requiresFull: false },
  },
};

/**
 * 更新区需要「有可用版本」态，但浏览器开发态没有 preload。
 *
 * 注意：**不能**用 addInitScript 在应用启动前塞 `window.opc` —— 主程序会据此
 * 走桌面分支，`/settings` 反而不渲染。这里等设置弹窗起来之后再补桥，
 * 「关于」分区是点击时才挂载，届时读到的就是这份固定状态。
 */
async function installUpdateBridge(page, fixture) {
  await page.evaluate(f => {
    const state = f.updateState;
    window.opc = {
      appInfo: async () => f.appInfo,
      update: {
        getState: async () => state,
        check: async () => state,
        download: async () => state,
        quitAndInstall: async () => ({ ok: true }),
        dismiss: async () => state,
        onStateChange: () => () => {},
      },
    };
  }, fixture);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];

async function newPage(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport });
  if (opts.theme) {
    await ctx.addInitScript(t => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* 隐私模式下不可写，不因此放弃整轮 */
      }
    }, opts.theme);
  }
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/api/runs/active')) return json({ runs: [] });
    if (/\/api\/agents\/custom/.test(url)) return json({ agents: [] });
    if (/\/api\/agent-credentials/.test(url)) return json({ credentials: [] });
    if (/\/api\/agents(\/|$)/.test(url) && !/probe/.test(url)) {
      return json({
        agents: [
          { id: 'workbuddy', name: 'WorkBuddy', status: { availability: 'ready' }, capabilities: ['chat'], kind: 'sdk' },
        ],
      });
    }
    if (/\/api\/memory/.test(url)) {
      return json({
        core: '# 核心记忆\n\n- 用户偏好简体中文\n- 项目在 E 盘\n- 用 pnpm 而非 npm',
        user: '# 用户画像\n\n- 在做 OPC Agent\n- 关注设计系统一致性\n- 喜欢先看数据再动手',
        skills: SKILLS,
        budget: { used: 720, limit: 800 },
      });
    }
    if (/\/api\/permission-rules/.test(url)) return json({ rules: [] });
    if (/\/api\/sessions/.test(url)) return json({ sessions: [] });
    if (/\/api\/models/.test(url)) return json({ models: [] });
    if (/\/api\/check-login/.test(url)) {
      return json({ isLoggedIn: false, envConfigured: false, cliConfigured: false, envVars: {} });
    }
    return json({});
  });
  return { ctx, page };
}

/** 弹窗本体（不是内容区里那个同名的 `data-settings-panel`） */
const DIALOG = '[data-settings-modal] > [data-settings-panel]';

/** 量弹窗矩形 + 内容区的溢出量 */
async function snapshot(page) {
  return page.evaluate(sel => {
    const dlg = document.querySelector(sel);
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    const inner = dlg.querySelector('[data-settings-panel]');
    const scroller = inner && inner.parentElement;
    return {
      top: Math.round(r.top),
      height: Math.round(r.height),
      width: Math.round(r.width),
      bottom: Math.round(r.bottom),
      // 溢出量：内容比容器高多少（<=0 表示没有可滚内容）
      overflow: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      fade: scroller ? scroller.getAttribute('data-fade') : null,
    };
  }, DIALOG);
}

/** 打开设置并收集分区 key。`/settings` 本身就是设置路由（渲染成弹窗），
 *  不需要先落到某个会话再点齿轮 —— 少一步就少一个失败点。 */
async function openSettings(page) {
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-settings-modal]', { timeout: 8000 });
  await page.waitForTimeout(600);
  return page.$$eval('[data-settings-section]', els =>
    els.map(e => e.getAttribute('data-settings-section')).filter(Boolean)
  );
}

/** 反向探针：把弹窗退回坏版本 */
async function applyProbe(page) {
  await page.evaluate(sel => {
    const dlg = document.querySelector(sel);
    if (dlg) {
      dlg.style.height = 'auto';
      dlg.style.maxHeight = 'min(700px, 100%)';
    }
  }, DIALOG);
}

// ============= [1] 切换 8 个分区，弹窗矩形恒定 =============
console.log('\n[1] 切换每个分区，弹窗的位置与尺寸都不许变');
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  const keys = await openSettings(page);
  ok(keys.length >= 7, `分区导航拿到了 ${keys.length} 项`, keys.join(' / '));
  if (PROBE) await applyProbe(page);

  const rows = [];
  for (const key of keys) {
    await page.locator(`[data-settings-section="${key}"]`).first().click();
    await page.waitForTimeout(400);
    const s = await snapshot(page);
    if (!s) {
      ok(false, `分区 ${key} 量不到弹窗`);
      continue;
    }
    rows.push({ key, ...s });
    console.log(
      `      ${key.padEnd(11)} top ${String(s.top).padStart(3)}  h ${String(s.height).padStart(3)}  ` +
      `w ${String(s.width).padStart(3)}  溢出 ${String(s.overflow).padStart(4)}  fade=${s.fade}`
    );
  }

  ok(rows.length === keys.length, '每个分区都量到了', `${rows.length}/${keys.length}`);

  /**
   * 钉**三个**维度，不只高度。
   *
   * 只钉高度会漏掉 top：外层是 `items-center`，高度一变 top 就跟着变，
   * 用户看到的是「整块上下跳」，而不是「底边伸缩」。宽度顺手一起钉 ——
   * 万一将来某个分区的内容撑破了宽度，这里也会红。
   */
  const hs = rows.map(r => r.height);
  const ts = rows.map(r => r.top);
  const ws = rows.map(r => r.width);
  const span = a => Math.max(...a) - Math.min(...a);

  ok(span(hs) === 0, '切换分区时弹窗高度不变', `区间 ${Math.min(...hs)}~${Math.max(...hs)}px，极差 ${span(hs)}px`);
  ok(span(ts) === 0, '切换分区时弹窗顶边不动（否则整块上下跳）', `极差 ${span(ts)}px`);
  ok(span(ws) === 0, '切换分区时弹窗宽度不变', `极差 ${span(ws)}px`);

  // 绝对高度：1440×900 下可用高度 900-48=852，所以取 700
  ok(hs.every(h => h === MAX_H), `弹窗高度锁在 ${MAX_H}px`, `实测 ${[...new Set(hs)].join(' / ')}`);

  // 不许顶出视口
  ok(rows.every(r => r.top >= 0 && r.bottom <= 900), '弹窗完整落在视口内',
    rows.filter(r => r.top < 0 || r.bottom > 900).map(r => r.key).join(' ') || '全部在内');

  await page.screenshot({ path: join(OUT, PROBE ? 'probe-settings.png' : 'settings-fixed.png') });
  await ctx.close();
}

// ============= [2] 固定高度后，渐隐信号必须还准 =============
console.log('\n[2] 固定高度后「还有更多」的信号仍按真实溢出量决定');
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  const keys = await openSettings(page);

  const pick = async key => {
    await page.locator(`[data-settings-section="${key}"]`).first().click();
    await page.waitForTimeout(450);
    return snapshot(page);
  };

  // 记忆：6 条技能 + 两段记忆正文，700 容器下必然溢出
  const memory = await pick('memory');
  ok(memory && memory.overflow > 50, '「记忆」分区在固定高度下真的溢出了（否则下一条是空断言）',
    memory ? `溢出 ${memory.overflow}px` : '量不到');
  ok(memory && memory.fade === '1', '溢出时挂了 data-fade=1（A134 硬规矩）', `fade=${memory?.fade}`);

  /**
   * 外观：A154 之前这里内容短，被当成「不溢出 → 不画渐隐」的对照组。
   * A154 加了「关闭窗口时」三选之后它不再必然短于 700px —— 所以不再写死
   * 「外观必须不溢出」，改成**规则断言**：渐隐只由真实溢出量决定。
   * （硬要留一个短分区做对照，会在下一次往那个分区加设置时再次变红。）
   */
  const appearance = await pick('appearance');
  ok(appearance && (appearance.overflow > 2 ? appearance.fade === '1' : appearance.fade === null),
    '「外观」的渐隐与真实溢出量一致',
    appearance ? `溢出 ${appearance.overflow}px, fade=${appearance.fade}` : '量不到');

  /**
   * 切分区要回到顶部。
   *
   * 固定高度之前，短内容分区没有可滚空间，scrollTop 自然是 0；
   * 固定之后每个分区都是同一个 700px 容器，从「记忆」滚到一半切到
   * 「关于与隐私」，浏览器**不会**帮你夹回去 —— 用户会落在半截。
   */
  // 回到长内容分区再滚 —— 无论上一页有没有可滚空间，都要重新量
  await pick('memory');
  const scrolled = await page.evaluate(sel => {
    const inner = document.querySelector(sel)?.querySelector('[data-settings-panel]');
    const scroller = inner && inner.parentElement;
    if (!scroller) return null;
    scroller.scrollTop = scroller.scrollHeight;
    return { top: Math.round(scroller.scrollTop), sh: scroller.scrollHeight, ch: scroller.clientHeight };
  }, DIALOG);
  await page.waitForTimeout(200);
  const scrolledNow = await snapshot(page);
  ok(scrolledNow && scrolledNow.scrollTop > 50, '先把「记忆」滚到底（否则下一条是空断言）',
    `scrollTop=${scrolledNow?.scrollTop}（可滚 ${scrolled ? scrolled.sh - scrolled.ch : '?'}px）`);

  const about = await pick('about');
  ok(about && about.scrollTop === 0, '切到另一个分区后内容区回到顶部', `scrollTop=${about?.scrollTop}`);

  await ctx.close();
}

// ============= [3] 矮窗口：退成「铺满可用高度」，仍不许跳 =============
console.log('\n[3] 窗口比 700 矮时，退成铺满可用高度');
{
  const { ctx, page } = await newPage({ width: 1280, height: 600 });
  const keys = await openSettings(page);

  const rows = [];
  for (const key of keys) {
    await page.locator(`[data-settings-section="${key}"]`).first().click();
    await page.waitForTimeout(320);
    const s = await snapshot(page);
    if (s) rows.push({ key, ...s });
  }
  const hs = rows.map(r => r.height);
  const span = Math.max(...hs) - Math.min(...hs);

  ok(span === 0, '矮窗口下切换分区，高度依然不变', `极差 ${span}px`);
  // 600 - 24（p-3 上下各 12）= 576
  ok(hs.every(h => h <= 600), '矮窗口下没顶出视口', `高度 ${[...new Set(hs)].join(' / ')}px`);
  ok(rows.every(r => r.top >= 0 && r.bottom <= 600), '矮窗口下弹窗完整可见',
    `top ${[...new Set(rows.map(r => r.top))].join('/')} bottom ${[...new Set(rows.map(r => r.bottom))].join('/')}`);

  await page.screenshot({ path: join(OUT, 'settings-short-window.png') });
  await ctx.close();
}

// ============= [4] 关于页三段式：版本条单行 / 说明进弹层 / 隐私三卡 =============
console.log('\n[4] 关于页三段式：版本条单行、说明进弹层、隐私三卡常驻');
{
  const viewport = { width: 1440, height: 900 };
  const { ctx, page } = await newPage(viewport, { theme: 'light' });
  await openSettings(page);
  await installUpdateBridge(page, ABOUT_FIXTURE);
  await page.locator('[data-settings-section="about"]').first().click();
  await page.waitForTimeout(500);

  /* ── 版本条：一行 + 运行时信息 ── */
  const version = await page.evaluate(() => {
    const el = document.querySelector('[data-about-version-line]');
    if (!el) return null;
    const build = el.querySelector('[data-about-runtime]');
    const name = el.querySelector('.tc-about-name');
    const size = n => (n ? parseFloat(getComputedStyle(n).fontSize) : null);
    return {
      height: Math.round(el.getBoundingClientRect().height),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      nameSize: size(name),
      buildSize: size(build),
      buildColor: build ? getComputedStyle(build).color : null,
      nameColor: name ? getComputedStyle(name).color : null,
    };
  });
  ok(version !== null, '版本块有 data-about-version-line 锚点');
  ok(version && version.height <= 40, '版本块压成一行（高度 ≤ 40px）', `实测 ${version?.height}px`);
  ok(
    version && /Electron 44\.7\.2/.test(version.text) && /Node 22\.20\.0/.test(version.text) && /win32 x64/.test(version.text),
    '单行里包含 Electron / Node / 平台架构',
    version?.text
  );
  ok(
    version && version.buildSize !== null && version.nameSize !== null && version.buildSize < version.nameSize,
    '运行时信息是次级字号（不抢名称与版本）',
    `运行时 ${version?.buildSize}px / 名称 ${version?.nameSize}px`
  );
  ok(
    version && version.buildColor !== version.nameColor,
    '运行时信息用次级字色（与名称不同色）',
    `${version?.buildColor} vs ${version?.nameColor}`
  );

  /* ── 隐私三卡：常驻、文案命中、一行标题 ── */
  const privacy = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-about-privacy-card]')];
    return {
      count: cards.length,
      titles: cards.map(c => (c.querySelector('.tc-about-privacy-card-title')?.innerText ?? '').trim()),
      bodies: cards.map(c => (c.querySelector('.tc-about-privacy-card-body')?.innerText ?? '').trim()),
      titleHeights: cards.map(c => Math.round((c.querySelector('.tc-about-privacy-card-title')?.getBoundingClientRect().height ?? 0))),
      backgrounds: cards.map(c => getComputedStyle(c).backgroundColor),
      bodyColors: cards.map(c => {
        const body = c.querySelector('.tc-about-privacy-card-body');
        return body ? getComputedStyle(body).color : null;
      }),
      visible: cards.every(c => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().height > 0),
    };
  });
  ok(privacy.count === 3, '隐私区正好三张条目卡', `实测 ${privacy.count}`);
  ok(privacy.visible, '三张卡默认可见（不折叠、不藏进 ⓘ）');
  ok(
    ['不收集任何信息', '只会发给你自己配置的模型服务商', '永久免费且无广告'].every(t => privacy.titles.includes(t)),
    '三张卡标题命中合规文案',
    privacy.titles.join(' / ')
  );
  ok(privacy.titleHeights.every(h => h > 0 && h <= 24), '每张卡标题都是一行', privacy.titleHeights.join(' / '));
  ok(privacy.bodies.every(t => t.length > 0), '每张卡都有一句说明', privacy.bodies.map(t => t.length).join(' / '));

  /* ── 更新区：available 态不铺开正文 ── */
  const update = await page.evaluate(() => {
    const section = document.querySelector('[data-update-section]');
    const inline = document.querySelectorAll('[data-update-section] [data-update-notes]').length;
    const toggle = document.querySelector('[data-update-notes-toggle]');
    const brand = section?.querySelector('.tc-btn-brand');
    return {
      inline,
      hasToggle: !!toggle,
      toggleText: toggle ? toggle.innerText.trim() : '',
      height: section ? Math.round(section.getBoundingClientRect().height) : null,
      buttonHeight: brand ? Math.round(brand.getBoundingClientRect().height) : null,
      buttonText: brand ? brand.innerText.trim() : '',
    };
  });
  ok(update.inline === 0, 'available 态不把说明正文铺在更新区', `内联正文 ${update.inline} 块`);
  ok(update.hasToggle && /查看更新内容/.test(update.toggleText), '「查看更新内容」入口存在', update.toggleText);
  ok(update.height !== null && update.height <= 260, '更新区只留状态与动作（高度 ≤ 260px）', `实测 ${update.height}px`);
  ok(
    update.buttonHeight !== null && Math.abs(update.buttonHeight - 32) <= 1 && /下载更新/.test(update.buttonText),
    '更新主按钮规格不变（高 32px）',
    `高 ${update.buttonHeight}px / ${update.buttonText}`
  );

  /* ── 弹层：480px、portal、Markdown 渲染、Esc/点外关闭、焦点 ── */
  await page.locator('[data-update-notes-toggle]').click();
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => {
    const dlg = document.querySelector('[data-update-notes-dialog]');
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    const notes = dlg.querySelector('[data-update-notes]');
    const text = dlg.innerText;
    const active = document.activeElement;
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      inBody: dlg.parentElement?.parentElement === document.body,
      insideSettings: !!document.querySelector('[data-settings-modal] [data-update-notes-dialog]'),
      text,
      notesText: notes ? notes.innerText : '',
      notesWidth: notes ? { sw: notes.scrollWidth, cw: notes.clientWidth } : null,
      focusInside: !!active && dlg.contains(active),
    };
  });
  ok(opened !== null, '点「查看更新内容」打开弹层');
  ok(opened && Math.abs(opened.width - 480) <= 2, '弹层宽约 480px', `实测 ${opened?.width}px`);
  ok(opened && opened.height <= 560, '弹层高度封顶（可在内部滚动）', `实测 ${opened?.height}px`);
  ok(opened && opened.inBody && !opened.insideSettings, '弹层 portal 到 body（不参与设置页排版）');
  ok(opened && opened.focusInside, '打开后焦点进入弹层');
  ok(
    opened && opened.notesText.includes('升级失败的红字不再常驻'),
    '说明正文确实渲染出来',
    opened?.notesText.slice(0, 40)
  );
  ok(
    opened && !opened.text.includes('**') && !opened.text.includes('##') && !opened.text.includes('\\'),
    '弹层里不再字面出现 `**` / `##` / 转义反斜杠',
    opened?.text.slice(0, 60)
  );
  ok(
    opened && opened.notesWidth && opened.notesWidth.sw <= opened.notesWidth.cw + 1,
    '弹层正文无横向溢出',
    JSON.stringify(opened?.notesWidth)
  );

  await page.screenshot({ path: join(OUT, 'about-notes-dialog.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok(await page.locator('[data-update-notes-dialog]').count() === 0, 'Esc 关闭弹层');
  ok(
    await page.locator('[data-settings-modal]').count() > 0,
    'Esc 只关弹层，不连带关掉设置弹窗',
  );
  const restored = await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && a.getAttribute('data-update-notes-toggle') !== null;
  });
  ok(restored, '关闭后焦点回到「查看更新内容」入口');

  // 点外关闭：重新打开后点左上角（弹层之外）
  await page.locator('[data-update-notes-toggle]').click();
  await page.waitForTimeout(200);
  await page.mouse.click(20, 20);
  await page.waitForTimeout(200);
  ok(await page.locator('[data-update-notes-dialog]').count() === 0, '点弹层以外关闭');

  /* ── 700px 容器：无横向溢出 ── */
  const overflow = await page.evaluate(() => {
    const inner = document.querySelector('[data-settings-modal] [data-settings-panel]');
    const scroller = inner && inner.parentElement;
    const line = document.querySelector('[data-about-version-line]');
    const cards = document.querySelector('.tc-about-privacy-cards');
    return {
      scroller: scroller ? { sw: scroller.scrollWidth, cw: scroller.clientWidth, w: Math.round(scroller.getBoundingClientRect().width) } : null,
      line: line ? { sw: line.scrollWidth, cw: line.clientWidth } : null,
      cards: cards ? { sw: cards.scrollWidth, cw: cards.clientWidth } : null,
      doc: { sw: document.documentElement.scrollWidth, iw: window.innerWidth },
    };
  });
  ok(overflow.scroller !== null, '量到设置内容区');
  ok(overflow.scroller && overflow.scroller.sw <= overflow.scroller.cw + 1, '内容区无横向溢出',
    `${overflow.scroller?.sw}/${overflow.scroller?.cw}`);
  ok(overflow.line && overflow.line.sw <= overflow.line.cw + 1, '版本条没有横向溢出',
    `${overflow.line?.sw}/${overflow.line?.cw}`);
  ok(overflow.cards && overflow.cards.sw <= overflow.cards.cw + 1, '三张隐私卡没有横向溢出',
    `${overflow.cards?.sw}/${overflow.cards?.cw}`);
  ok(overflow.doc.sw <= overflow.doc.iw, '页面整体没有横向滚动条', `${overflow.doc.sw}/${overflow.doc.iw}`);

  await page.screenshot({ path: join(OUT, 'about-three-zones.png') });

  /* ── 浅/深主题：配色必须跟着令牌变化 ── */
  const dark = await newPage(viewport, { theme: 'dark' });
  await openSettings(dark.page);
  await installUpdateBridge(dark.page, ABOUT_FIXTURE);
  await dark.page.locator('[data-settings-section="about"]').first().click();
  await dark.page.waitForTimeout(500);
  const darkCard = await dark.page.evaluate(() => {
    const card = document.querySelector('[data-about-privacy-card]');
    const body = card?.querySelector('.tc-about-privacy-card-body');
    const line = document.querySelector('[data-about-version-line]');
    return {
      bg: card ? getComputedStyle(card).backgroundColor : null,
      bodyColor: body ? getComputedStyle(body).color : null,
      theme: line ? getComputedStyle(document.body).color : null,
    };
  });
  ok(
    darkCard.bg !== null && darkCard.bg !== privacy.backgrounds[0],
    '隐私卡背景随浅/深主题变化',
    `浅 ${privacy.backgrounds[0]} / 深 ${darkCard.bg}`
  );
  ok(
    darkCard.bodyColor !== null && darkCard.bodyColor !== privacy.bodyColors[0],
    '隐私卡正文颜色随主题变化',
    `浅 ${privacy.bodyColors[0]} / 深 ${darkCard.bodyColor}`
  );
  await dark.ctx.close();
  await ctx.close();
}

// ============= [5] 控制台 =============
console.log('\n[5] 控制台');
ok(errors.length === 0, '全程零控制台错误', errors.slice(0, 2).join(' | ') || '干净');

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过${PROBE ? '（反向探针模式）' : ''}`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
