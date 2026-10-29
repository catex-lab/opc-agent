/**
 * 应用 Logo（同人卦）落地的验证脚本。
 *
 * 覆盖三层，与项目既有的「验证三层制」对齐：
 *   [1] 资产层（纯 Node，不碰 IO 之外的东西）：SVG 母版、ICO 多尺寸容器、
 *       PNG 尺寸、以及**三处几何契约**（make-icons.mjs ↔ AppLogo.tsx ↔
 *       界面/favicon 引用）。这一层不依赖构建产物，随时可跑。
 *   [2] 界面层（Playwright + dist/）：标题栏徽章在明暗两态下的实际渲染
 *       （计算样式 + 元素截图像素采样）、favicon 可访问、dist 里关于页
 *       图标资产在位、控制台零错误。
 *   [3] 目视层：截图落 .render-check/，16px 小尺寸的清晰度只能人眼看，
 *       脚本如实说明它验不了这个。
 *
 * 运行：node scripts/verify-logo.mjs（界面层需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { pngSize, icoSizes, SRC, SMALL_MAX } from './make-icons.mjs';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check');
const CHROME = process.env.OPC_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

/* ── [1] 资产层 ─────────────────────────────────────────────────── */

console.log('\n[1] 资产层：SVG 母版 / ICO 容器 / PNG 尺寸 / 几何契约');

async function read(p) {
  return readFile(join(ROOT, p));
}

// 1a. 设计源：彩色徽章位图
//
// 2026-10-29：这里原来验的是「几何 SVG 母版」—— 黑底、7 根白爻、白描边、
// 只有黑白两个色值、圆角 28。Logo 换成设计稿位图后这些断言全部失效
// （位图没有 rect 可数、没有色值可枚举），改成验「源在、尺寸够、是真 PNG」。
{
  ok(existsSync(SRC), '设计源 build/logo-source.png 存在');
  const src = await read('build/logo-source.png');
  const s = pngSize(src);
  ok(!!s && s.width === s.height && s.width >= 512, '设计源是 ≥512 的正方形 PNG', `${s?.width}x${s?.height}`);
  // PNG 魔数：扩展名对但内容不是 PNG（比如被存成 WebP）会让后面整条链静默出错
  ok(src.toString('latin1', 1, 4) === 'PNG', '设计源是真正的 PNG（魔数校验）');
}

// 1b. 界面标记与 favicon：同一源图生成，各自尺寸对得上
{
  const logo = pngSize(await read('src/assets/app-logo.png'));
  ok(logo?.width === 256 && logo?.height === 256, 'src/assets/app-logo.png 是 256×256', `${logo?.width}x${logo?.height}`);
  const fav32 = pngSize(await read('public/favicon.png'));
  const fav16 = pngSize(await read('public/favicon-16.png'));
  ok(fav32?.width === 32, 'public/favicon.png 是 32×32', `${fav32?.width}`);
  ok(fav16?.width === 16, 'public/favicon-16.png 是 16×16', `${fav16?.width}`);
  // 旧的几何 SVG 保留未删（资产不主动删），但不该再被任何地方引用 ——
  // 「文件还在」是肯定式，防止把「整个删掉」当成通过。
  ok(existsSync(join(ROOT, 'public/favicon.svg')), '旧 favicon.svg 仍保留（只停止引用，不删资产）');
  ok(existsSync(join(ROOT, 'src/assets/app-logo.svg')), '旧 app-logo.svg 仍保留');
}

// 1c. ICO 容器：主图标 7 尺寸、托盘 4 尺寸，条目全是 PNG
{
  const ico = await read('build/icon.ico');
  const tray = await read('build/tray-icon.ico');
  const wantIco = [16, 24, 32, 48, 64, 128, 256];
  const wantTray = [16, 20, 24, 32];
  ok(JSON.stringify(icoSizes(ico)) === JSON.stringify(wantIco), 'icon.ico 含 7 个标准尺寸', icoSizes(ico).join('/'));
  ok(JSON.stringify(icoSizes(tray)) === JSON.stringify(wantTray), 'tray-icon.ico 含托盘四档', icoSizes(tray).join('/'));
  // 逐条目验 PNG 魔数：容器尺寸对但内容是 BMP/空块，Windows 会显示裂图
  const allPngEntries = buf => {
    const count = buf.readUInt16LE(4);
    for (let i = 0; i < count; i++) {
      const start = buf.readUInt32LE(6 + i * 16 + 12);
      if (buf.toString('latin1', start, start + 4) !== '\x89PNG') return false;
    }
    return true;
  };
  ok(allPngEntries(ico), 'icon.ico 每个条目都是 PNG（Vista+ 格式）');
  ok(allPngEntries(tray), 'tray-icon.ico 每个条目都是 PNG');
  ok(ico.length > 6 + 16 * 7, 'icon.ico 体积合理（不是空壳）', `${ico.length} B`);
}

// 1d. PNG 尺寸：窗口 256 / 关于页与官网 512，且 512 两份同源
{
  const png256 = pngSize(await read('build/icon.png'));
  ok(png256?.width === 256 && png256?.height === 256, 'build/icon.png 是 256×256', `${png256?.width}x${png256?.height}`);
  const png512 = pngSize(await read('build/icon-512.png'));
  ok(png512?.width === 512, 'build/icon-512.png 是 512', `${png512?.width}`);
  const appIcon = await read('src/assets/app-icon.png');
  ok(Buffer.compare(appIcon, await read('build/icon-512.png')) === 0, '关于页图标与 icon-512 逐字节一致（同源，不会两张脸）');
  ok(pngSize(appIcon)?.width === 512, '关于页图标 512×512');
  const siteIcon = pngSize(await read('site/assets/icon.png'));
  ok(siteIcon?.width === 512, '官网 icon.png 512×512');
  for (const f of ['site/assets/icon-52.webp', 'site/assets/icon-104.webp']) {
    const b = await read(f);
    ok(b.length > 500 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP', `${f} 是有效 WebP`, `${b.length} B`);
  }
}

// 1e. AppLogo 必须引用位图（防回退到旧几何实现）
//
// 2026-10-29：旧断言是「三处几何逐字段一致」—— AppLogo.tsx 的 STD/WIDE/LINES
// 必须与 make-icons.mjs 的 GEOM/LINES 完全对上，这是黑白几何方案防漂移的核心。
// 换成位图后几何常量整体消失，那条契约失去对象，改成「实现形态」断言：
// 必须是 <img> + import 那张 png，且不能残留 STD / lineRects 这类旧实现
// （否则说明有人只换了资产、没换组件，界面会继续画旧标记）。
{
  const tsx = await read('src/components/AppLogo.tsx').then(b => b.toString('utf8'));
  ok(/import\s+logoUrl\s+from\s+'\.\.\/assets\/app-logo\.png'/.test(tsx),
    'AppLogo 引用 src/assets/app-logo.png');
  ok(/<img/.test(tsx), 'AppLogo 渲染 <img>（不再是 <svg>）');
  ok(!/const STD\s*=/.test(tsx) && !/lineRects/.test(tsx),
    'AppLogo 里没有残留的几何实现（STD / lineRects）');
}

// 1f. 接线：标题栏、favicon、托盘、打包配置一个都不能少
{
  const titlebar = await read('src/components/TitleBar.tsx').then(b => b.toString('utf8'));
  ok(titlebar.includes("import { AppLogo } from './AppLogo'"), 'TitleBar 引用 AppLogo');
  ok(titlebar.includes('data-app-logo'), '标题栏标记带 data-app-logo 测试钩子');

  /* 2026-10-29：旧方案要求标题栏用 --tc-logo-tile / --tc-logo-mark 铺黑白底色
     并随主题反转（浅色黑底白爻 ↔ 深色白底黑爻）。换成彩色位图后：
       · 底色会把图压住，所以 TitleBar 不再引用这两个令牌；
       · 位图自带深蓝描边，轮廓不依赖背景，也就不需要「反转」。
     两条断言因此反转成「不再引用」。但令牌**定义本身保留**（不删资产），
     并用肯定式确认它还在 —— 否则「把令牌一起删掉」也会判绿。

     ⚠️ 必须先剥注释再判：TitleBar 的注释里就写着「不再铺 --tc-logo-tile」，
     直接对整块源码跑正则会命中这句注释，把「已经改对了」判成红。
     （这条不是假设 —— 第一次跑就是这么红的。） */
  const stripComments = s =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(!/--tc-logo-tile|--tc-logo-mark/.test(stripComments(titlebar)), '标题栏不再铺黑白 logo 底色（位图自带描边）');
  const css = await read('src/index.css').then(b => b.toString('utf8'));
  ok(css.includes('--tc-logo-tile') && css.includes('--tc-logo-mark'), '两个旧令牌定义仍保留（只停用，不删）');
  ok(/:root\.dark \[data-app-logo\] img/.test(css), '暗色主题对 Logo 有单独微调（明暗区分）');

  const html = await read('index.html').then(b => b.toString('utf8'));
  ok(html.includes('href="/favicon.png"'), 'index.html 引用 /favicon.png（32px）');
  ok(html.includes('href="/favicon-16.png"'), 'index.html 另给 16px 一份（标签页不缩大图）');
  ok(!html.includes('href="/favicon.svg"'), 'index.html 不再引用旧 favicon.svg');

  const main = await read('electron/main.ts').then(b => b.toString('utf8'));
  ok(main.includes('new Tray(') && main.includes('tray-icon.ico'), '主进程创建托盘并用 tray-icon.ico');
  ok(/join\(__dirname, 'icon\.png'\)/.test(main), '窗口图标仍指向 dist-electron/icon.png');
  const buildElectron = await read('scripts/build-electron.mjs').then(b => b.toString('utf8'));
  ok(buildElectron.includes("cp('build/tray-icon.ico'"), 'build-electron.mjs 拷贝托盘图标进 dist-electron/');
  const yml = await read('electron-builder.yml').then(b => b.toString('utf8'));
  ok(yml.includes('icon: build/icon.ico'), 'electron-builder 仍用 build/icon.ico（exe/快捷方式/任务栏/Alt+Tab 五处同源）');
}

/* ── [2] 界面层 ─────────────────────────────────────────────────── */

console.log('\n[2] 界面层：标题栏徽章明暗两态（需 dist/）');

if (!existsSync(join(DIST, 'index.html'))) {
  console.log('  ⚠ 找不到 dist/index.html，跳过界面层（先 npm run build）');
} else {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
  };
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

  /** 标题栏徽章的完整断言，明暗两态各跑一遍 */
  async function checkLogo(scheme) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
    /**
     * 拦掉 /api/**，喂最小夹具。
     *
     * 这个静态服务只 serve dist，**不代理 API** —— 不拦的话前端的
     * `/api/models`、`/api/sessions` 会拿到 index.html，`JSON.parse` 撞上
     * `<!DOCTYPE` 然后 `console.error`，把「控制台零错误」染红（实测报错原文：
     * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`）。
     *
     * 这里只需要页面能渲染出标题栏，所以给空集合就够；不需要真实数据。
     */
    await ctx.route('**/api/**', route => {
      const url = route.request().url();
      const json = body =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (/\/api\/models/.test(url)) return json({ models: [] });
      if (/\/api\/sessions/.test(url)) return json({ sessions: [] });
      if (/\/api\/agents/.test(url)) return json({ agents: [] });
      if (/\/api\/runs\/active/.test(url)) return json({ runs: [] });
      return json({});
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-titlebar] [data-app-logo] img', { timeout: 5000 });

    const tile = page.locator('[data-titlebar] [data-app-logo]');

    /**
     * ⚠️ 截图前必须等标记**位置稳定** —— 这个坑与 Logo 内容无关，仍然有效。
     *
     * 应用有入场动画：标记挂载后还会位移一小段时间。boundingBox() 与
     * page.screenshot() 是两次独立读取，元素只要在两次之间动了，clip 区域
     * 与 rect 坐标就来自不同帧，截图整体偏移约 2px（旧实现里表现为
     * 「三行全扫不到纸色，看起来像 logo 没画出来」）。
     * 连读位置直到两次相同（兜底 1s）才是「真的落定了」。
     */
    let box = await tile.boundingBox();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      const b = await tile.boundingBox();
      if (b && box && Math.abs(b.x - box.x) < 0.05 && Math.abs(b.y - box.y) < 0.05) break;
      box = b;
    }

    /**
     * 2026-10-29：Logo 换成位图后，原来那套「量 7 根 rect + 逐行扫像素证明
     * 离卦中爻是断的」整体失去对象 —— 位图没有 rect，也没有「断爻」可验。
     * 改成验**位图这个形态本身**能不能成立，三条判据都是旧实现验不到的：
     *   · `<img>` 真的挂载（不是还在画旧的内联 SVG）；
     *   · **已解码**（naturalWidth > 0）—— 只验元素存在会漏掉「路径错了、
     *     图裂了但元素还在」这种最常见的失败，界面上是一块空白；
     *   · 按 16px 渲染（TitleBar 传的就是 16，改大改小都要有人知道）。
     * 与导航图标同轴那条与 Logo 内容无关，原样保留。
     */
    const styles = await tile.evaluate(el => {
      const r = el.getBoundingClientRect();
      const img = el.querySelector('img');
      const bar = document.querySelector('[data-titlebar]');
      const navBtn = document.querySelector('nav button');
      const navCx = navBtn
        ? (b => { const q = b.getBoundingClientRect(); return q.left + q.width / 2; })(navBtn)
        : null;
      return {
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
        w: r.width,
        h: r.height,
        cx: r.left + r.width / 2,
        navCx,
        hasImg: !!img,
        natural: img ? img.naturalWidth : 0,
        imgW: img ? img.getBoundingClientRect().width : 0,
        src: img ? img.getAttribute('src') : '',
        // 旧内联 SVG 的残留：还在画几何就说明组件没换干净
        hasSvg: !!el.querySelector('svg'),
      };
    });

    ok(styles.hasImg, `[${scheme}] 标题栏标记是 <img>（不再是内联 SVG）`);
    ok(!styles.hasSvg, `[${scheme}] 标记里没有残留的内联 SVG`);
    ok(styles.natural > 0, `[${scheme}] 位图已成功解码（naturalWidth>0）`,
      `natural=${styles.natural} src=${styles.src}`);
    ok(Math.round(styles.w) === 18 && Math.round(styles.h) === 18,
      `[${scheme}] 标记格 18×18`, `${styles.w}x${styles.h}`);
    ok(Math.round(styles.imgW) === 16, `[${scheme}] 图按 16px 渲染`, `${styles.imgW}px`);
    ok(styles.navCx !== null && Math.abs(styles.cx - styles.navCx) <= 1,
      `[${scheme}] 标记中心与导航图标同轴`,
      `cx=${styles.cx.toFixed(1)} nav=${styles.navCx === null ? '未找到' : styles.navCx.toFixed(1)}`);

    await page.waitForTimeout(600); // 等主题/首帧涂料落定再截图，否则证据图可能是中间态
    await page.locator('[data-titlebar]').screenshot({ path: join(OUT, `logo-titlebar-${scheme}.png`) });
    await page.close();
    await ctx.close();
    return { errors, barBg: styles.barBg };
  }

  const light = await checkLogo('light');
  const dark = await checkLogo('dark');
  // 主题真的翻了才算数：否则「深色态断言全过」可能是上下文没进深色，
  // 断言就退化成了把浅色态跑两遍。
  ok(light.barBg !== dark.barBg, '明暗两态的标题条底色确实不同（上下文真的切了主题）',
    `${light.barBg} vs ${dark.barBg}`);

  /* favicon 可访问。
   *
   * 2026-10-29：原来这里验的是「favicon.svg 带 prefers-color-scheme 媒体查询」
   * —— 那套靠 CSS 在 SVG 内部换色。换成位图后 PNG 没有「媒体查询」这回事
   * （位图不随主题变色），所以改验：两张 PNG 都在、Content-Type 正确、
   * 且**体积不是空壳**（0 字节的 200 比 404 更难发现）。
   * 「明暗区分」现在落在 index.css 的 `:root.dark [data-app-logo] img` 上，
   * 已在 1f 断言过。 */
  for (const [file, wantType] of [['/favicon.png', 'png'], ['/favicon-16.png', 'png']]) {
    const ctx = await browser.newContext();
    const r = await ctx.request.get(base + file);
    ok(r.status() === 200, `${file} 可访问（200）`, String(r.status()));
    ok((r.headers()['content-type'] || '').includes(wantType),
      `${file} Content-Type 是 image/${wantType}`, r.headers()['content-type']);
    const body = await r.body();
    ok(body.length > 200, `${file} 不是空壳`, `${body.length} B`);
    // PNG 魔数：扩展名对但内容不是 PNG（被中间件改写/回落到 index.html）会在这里露出来
    ok(body.toString('latin1', 1, 4) === 'PNG', `${file} 是真正的 PNG`, body.toString('latin1', 1, 4));
    await ctx.close();
  }

  // dist 里关于页图标在位（AboutPanel 走 hashed 资源）
  {
    const files = await readdir(join(DIST, 'assets'));
    const hit = files.find(f => /^app-icon-.*\.png$/.test(f));
    ok(!!hit, 'dist/assets 里有关于页图标资产', hit ?? '未找到');
    if (hit) {
      const ctx = await browser.newContext();
      const r = await ctx.request.get(base + '/assets/' + hit);
      const buf = await r.body();
      const size = pngSize(buf);
      ok(r.status() === 200 && size?.width === 512, '关于页图标可访问且为 512', `${r.status()} ${size?.width}x${size?.height}`);
      await ctx.close();
    }
  }

  ok(light.errors.length === 0, '浅色态控制台零错误', light.errors.slice(0, 2).join(' | ').slice(0, 160));
  ok(dark.errors.length === 0, '深色态控制台零错误', dark.errors.slice(0, 2).join(' | ').slice(0, 160));

  await browser.close();
  server.close();
}

/* ── 汇总 ──────────────────────────────────────────────────────── */

console.log('\n[3] 目视层：截图已落 .render-check/logo-titlebar-*.png');
console.log('    （16px 托盘/任务栏的清晰度只能人眼看，脚本不假装能验）');

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败（共 ${checks.total} 项）：`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${checks.total}/${checks.total} 全部通过`);
