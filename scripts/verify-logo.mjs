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
import { GEOM, COLORS, LINES, pngSize, icoSizes } from './make-icons.mjs';

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

// 1a. 徽章母版：黑底 + 7 根白爻（6 爻，其中阴爻一断为二）+ 一圈白描边
{
  const svg = await read('build/icon.svg').then(b => b.toString('utf8'));
  ok(svg.includes(`fill="${COLORS.tileBg}"`), '徽章母版用纯黑底', COLORS.tileBg);
  ok(svg.includes(`fill="${COLORS.tileMark}"`), '爻线用纯白', COLORS.tileMark);
  // 白描边是纯黑白方案的关键：任务栏深色时纯黑方块会糊进背景，只剩爻线在飘
  ok(svg.includes(`stroke="${COLORS.tileRing}"`) && svg.includes(`stroke-width="${COLORS.tileRingWidth}"`),
    '徽章带一圈白描边（深色桌面上黑底不消失）', `${COLORS.tileRing} / ${COLORS.tileRingWidth}`);
  const rects = svg.match(/<rect /g) || [];
  ok(rects.length === 8, '徽章 = 1 底色 + 7 根爻线（阴爻断成两根）', `rect=${rects.length}`);
  ok(/rx="28"/.test(svg), '圆角与 GEOM.tile.rx 一致');
  // 全文件只允许出现黑与白：任何第三个色值都说明配色漂了
  const inks = [...new Set([...svg.matchAll(/#([0-9a-fA-F]{3,8})\b/g)].map(m => m[1].toLowerCase()))];
  ok(inks.every(c => c === '000000' || c === 'ffffff'), '徽章只有黑与白两个色值', inks.join(' / '));
}

// 1b. 裸标记母版：明暗自适应，且 favicon 与 src/assets 是同一份
{
  const mark = await read('src/assets/app-logo.svg').then(b => b.toString('utf8'));
  const fav = existsSync(join(ROOT, 'public/favicon.svg'))
    ? await read('public/favicon.svg').then(b => b.toString('utf8'))
    : '';
  ok(fav.length > 0 && fav === mark, 'public/favicon.svg 与 src/assets/app-logo.svg 逐字节一致');
  ok(mark.includes('prefers-color-scheme: dark'), '裸标记带 dark 媒体查询（明暗自适应）');
  ok(mark.includes(COLORS.markLight) && mark.includes(COLORS.markDark), '两态颜色都在（黑 / 白）',
    `${COLORS.markLight} / ${COLORS.markDark}`);
  const rects = mark.match(/<rect /g) || [];
  ok(rects.length === 7, '裸标记 = 7 根爻线', `rect=${rects.length}`);
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

// 1e. 几何契约：三处实现必须逐字段一致（这是防漂移的核心断言）
{
  const tsx = await read('src/components/AppLogo.tsx').then(b => b.toString('utf8'));
  const grab = (name) => {
    const m = tsx.match(new RegExp(`const ${name} = \\{([^}]+)\\}`));
    if (!m) return null;
    const out = {};
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split(':').map(s => s.trim());
      if (k) out[k] = Number(v);
    }
    return out;
  };
  const std = grab('STD');
  const wide = grab('WIDE');
  ok(!!std, 'AppLogo.tsx 里有 STD 几何常量');
  ok(!!wide, 'AppLogo.tsx 里有 WIDE 小尺寸几何常量');
  if (std && wide) {
    const sameStd =
      std.x0 === GEOM.mark.x0 && std.w === GEOM.mark.w &&
      std.stroke === GEOM.stroke && std.gap === GEOM.gap && std.brokenGap === GEOM.brokenGap;
    ok(sameStd, 'STD 与 make-icons.mjs 的 GEOM（mark）逐字段一致',
      `tsx=${JSON.stringify(std)} mjs=${JSON.stringify({ ...GEOM.mark, stroke: GEOM.stroke, gap: GEOM.gap, brokenGap: GEOM.brokenGap })}`);
    const sameWide =
      wide.stroke === GEOM.wide.stroke && wide.gap === GEOM.wide.gap && wide.brokenGap === GEOM.wide.brokenGap;
    ok(sameWide, 'WIDE 与 GEOM.wide 逐字段一致', `tsx=${JSON.stringify(wide)} mjs=${JSON.stringify(GEOM.wide)}`);
  }
  const linesM = tsx.match(/const LINES = \[([^\]]+)\]/);
  const tsxLines = linesM ? linesM[1].split(',').map(s => s.trim() === 'true') : null;
  ok(!!tsxLines && JSON.stringify(tsxLines) === JSON.stringify(LINES),
    'LINES（六爻虚实）与 make-icons.mjs 一致', tsxLines ? tsxLines.map(v => (v ? '—' : '- -')).join(' ') : '未解析到');
  ok(/CANVAS = 128/.test(tsx) && GEOM.canvas === 128, '画布 128 一致');
}

// 1f. 接线：标题栏、令牌、favicon、托盘一个都不能少
{
  const titlebar = await read('src/components/TitleBar.tsx').then(b => b.toString('utf8'));
  ok(titlebar.includes("import { AppLogo } from './AppLogo'"), 'TitleBar 引用 AppLogo');
  ok(titlebar.includes('--tc-logo-tile') && titlebar.includes('--tc-logo-mark'), '标题栏徽章用两个 logo 令牌');
  ok(titlebar.includes('data-app-logo'), '标题栏徽章带 data-app-logo 测试钩子');
  const css = await read('src/index.css').then(b => b.toString('utf8'));
  // 大小写不敏感：CSS 里写小写十六进制，COLORS 里写的是大写。
  // 界面徽章**随主题反转**（浅色黑底白爻 / 深色白底黑爻），所以两个主题
  // 各有一套值。判定某处定义落在哪个块里，要往前找**最近的** `:root {` /
  // `:root.dark {` 开括号 —— 不能按「第一个 :root.dark」切片：本文件第 23 行
  // 就有一个 :root.dark，而令牌定义在第 174 行，按首次出现切片会把浅色区
  // 整段切掉，得到「浅色令牌没定义」的假失败（实测踩过）。
  function defs(prop) {
    const re = new RegExp(`${prop}\\s*:\\s*(#[0-9a-fA-F]+)`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(css))) {
      const open = /:root(\.dark)?\s*\{/g;
      let o;
      let theme = 'light';
      while ((o = open.exec(css))) {
        if (o.index >= m.index) break;
        theme = o[1] ? 'dark' : 'light';
      }
      out.push({ value: m[1].toLowerCase(), theme });
    }
    return out;
  }
  const tileDefs = defs('--tc-logo-tile');
  const markDefs = defs('--tc-logo-mark');
  ok(tileDefs.length === 2 && markDefs.length === 2, '两个令牌都定义两次（浅色 + 深色各一份）',
    `tile=[${tileDefs.map(d => d.theme + ':' + d.value)}] mark=[${markDefs.map(d => d.theme + ':' + d.value)}]`);
  const lt = tileDefs.find(d => d.theme === 'light');
  const lm = markDefs.find(d => d.theme === 'light');
  const dt = tileDefs.find(d => d.theme === 'dark');
  const dm = markDefs.find(d => d.theme === 'dark');
  ok(!!lt && !!lm && lt.value === COLORS.tileBg.toLowerCase() && lm.value === COLORS.tileMark.toLowerCase(),
    '浅色主题：黑底白爻', lt && lm ? `${lt.value} / ${lm.value}` : '缺失');
  ok(!!dt && !!dm && dt.value === COLORS.tileMark.toLowerCase() && dm.value === COLORS.tileBg.toLowerCase(),
    '深色主题：白底黑爻（随主题反转）', dt && dm ? `${dt.value} / ${dm.value}` : '缺失');
  const html = await read('index.html').then(b => b.toString('utf8'));
  ok(html.includes('href="/favicon.svg"'), 'index.html 引用 /favicon.svg（不再是 data-URI 占位）');
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
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    await ctx.route('**/api/**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[]}' })
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-titlebar] [data-app-logo] svg', { timeout: 5000 });

    const tile = page.locator('[data-titlebar] [data-app-logo]');

    /**
     * ⚠️ 截图前必须等徽章**位置稳定**——这是本脚本最大的坑，值得写清楚。
     *
     * 应用有入场动画：徽章挂载后还会位移一小段时间。而 boundingBox() 与
     * page.screenshot() 是两次独立读取，元素只要在两次之间动了，clip 区域
     * 与 rect 坐标就来自不同帧。实测症状极具误导性：截图整体偏移约 2px，
     * 「阳爻行」采样落到爻间缝隙里，三行全扫不到纸色 —— 看起来像 logo
     * 没画出来，实际是采样坐标系错了。
     *
     * waitForSelector 只保证 SVG 挂载，waitForTimeout 是拍脑袋的固定值；
     * 这里连读位置直到两次相同（兜底 1s），才是「真的落定了」。
     */
    let box = await tile.boundingBox();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      const b = await tile.boundingBox();
      if (b && box && Math.abs(b.x - box.x) < 0.05 && Math.abs(b.y - box.y) < 0.05) break;
      box = b;
    }

    // 位置落定之后才读 rect 与截图，两边才是同一帧
    const styles = await tile.evaluate(el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const svg = el.querySelector('svg');
      const rects = [...svg.querySelectorAll('rect')].map(x => {
        const b = x.getBoundingClientRect();
        return {
          x: Number(x.getAttribute('x')),
          y: Number(x.getAttribute('y')),
          w: Number(x.getAttribute('width')),
          fill: getComputedStyle(x).fill,
          // 相对徽章的归一化位置（0~1）—— 像素采样要用真实落点，
          // 不能拿 viewBox 坐标除 128：标记在徽章里有内边距，两者不同源
          left: (b.left - r.left) / r.width,
          right: (b.right - r.left) / r.width,
          top: (b.top - r.top) / r.height,
          bottom: (b.bottom - r.top) / r.height,
        };
      });
      const bar = document.querySelector('[data-titlebar]');
      /**
       * 导航条第一个按钮的中心。
       *
       * ⚠️ 徽章要验的是「与导航图标**同轴**」，不是「中心在 28px」。
       * 原来写死 28（= 56px 导航条的半宽），A103 给框架加了 6px 内缩之后
       * 中轴整体平移到 34，写死的常量就变成了假失败 —— 而徽章其实一直
       * 是对齐的。真正该对齐的参照物是导航按钮本身。
       */
      const navBtn = document.querySelector('nav button');
      const navCx = navBtn
        ? (b => { const r = b.getBoundingClientRect(); return r.left + r.width / 2; })(navBtn)
        : null;
      return {
        bg: s.backgroundColor,
        fg: s.color,
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
        w: r.width,
        h: r.height,
        cx: r.left + r.width / 2,
        navCx,
        rects,
      };
    });

    // 界面徽章随主题反转：浅色黑底白爻、深色白底黑爻。
    // 纯黑白没有中间色可依，翻转错了会直接变成「深色态下黑底贴黑 rail」。
    const want = scheme === 'light'
      ? { bg: 'rgb(0, 0, 0)', fg: 'rgb(255, 255, 255)' }
      : { bg: 'rgb(255, 255, 255)', fg: 'rgb(0, 0, 0)' };
    ok(styles.bg === want.bg, `[${scheme}] 徽章底色是${scheme === 'light' ? '黑' : '白'}（随主题反转）`, styles.bg);
    ok(styles.fg === want.fg, `[${scheme}] 爻线是${scheme === 'light' ? '白' : '黑'}`, styles.fg);
    ok(Math.round(styles.w) === 18 && Math.round(styles.h) === 18, `[${scheme}] 徽章 18×18`, `${styles.w}x${styles.h}`);
    // 与导航图标同轴（A92 的对齐约定）：参照物是导航按钮中心，不是写死的像素值
    ok(styles.navCx !== null && Math.abs(styles.cx - styles.navCx) <= 1,
      `[${scheme}] 徽章中心与导航图标同轴`,
      `cx=${styles.cx.toFixed(1)} nav=${styles.navCx === null ? '未找到' : styles.navCx.toFixed(1)}`);
    ok(styles.rects.length === 7, `[${scheme}] 界面内联 SVG 是 7 根爻线`, `n=${styles.rects.length}`);
    ok(styles.rects.every(r => r.fill === want.fg), `[${scheme}] 爻线 fill 解析正确（currentColor 生效）`, styles.rects[0]?.fill);
    // 阴爻必须真的是「断」的：第 5、6 根同高且左右分开
    const [a, b] = [styles.rects[4], styles.rects[5]];
    ok(a && b && a.y === b.y && b.x > a.x + a.w - 1, `[${scheme}] 离卦中爻是断开的（第 5/6 根同 y 且分离）`,
      a && b ? `y=${a.y} x=${a.x} / ${b.x}` : '缺失');

    // 像素级结构断言：把徽章区域精确裁出来，在关键行上扫一遍，
    // 用「纸色连续段」的个数证明爻线真的画出来了、而且真的是断的。
    //
    // 为什么用 page.screenshot({clip}) 而不是 locator.screenshot()：实测
    // 元素截图的高度会是 38px 而不是 36px（徽章 y=10.5 是分数，取整时
    // 溢出两行），整个采样坐标系随之平移 —— 全是假失败。clip 按 CSS 像素
    // 裁、由 Playwright 自己乘 DPI，尺寸与落点都精确。
    //
    // 为什么扫行而不是取区域极值：断爻的缺口只有约 3 个物理像素宽，
    // 「两段包围盒之间」的区域一取整就把相邻爻线的抗锯齿边算进来
    // （实测 maxAvg=212，其实是右段的第一颗像素）。按行分类后再数
    // 连续段，±1px 的偏移不影响结论。
    const shot = await page.screenshot({ clip: box });
    const px = await page.evaluate(
      async ([b64, rects, sch]) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx2 = c.getContext('2d');
        ctx2.drawImage(img, 0, 0);
        /**
         * 取某一归一化高度的一行，逐像素分类：M=爻线 T=徽章底 ?=抗锯齿过渡。
         *
         * ⚠️ 阈值**随配色方案反转**：浅色态是黑底白爻（avg>200 才算爻线），
         * 深色态是白底黑爻（avg<60 才算爻线）。要是一律按「亮的是爻线」判，
         * 深色态会把整片徽章底当成爻线 —— 阳爻行会数出 2 段而不是 1 段，
         * 全是假失败。这是从朱红方案改纯黑白时新引入的陷阱。
         */
        const rowAt = fy => {
          const y = Math.min(img.height - 1, Math.round(fy * img.height));
          const d = ctx2.getImageData(0, y, img.width, 1).data;
          const cls = [];
          for (let x = 0; x < img.width; x++) {
            const avg = (d[x * 4] + d[x * 4 + 1] + d[x * 4 + 2]) / 3;
            cls.push(
              sch === 'light'
                ? (avg > 200 ? 'M' : avg < 160 ? 'T' : '?')
                : (avg < 60 ? 'M' : avg > 200 ? 'T' : '?')
            );
          }
          return cls;
        };
        /** 某类像素形成了几个互不相邻的连续段 */
        const runs = (cls, kind) => {
          let n = 0;
          let prev = false;
          for (const ch of cls) {
            const is = ch === kind;
            if (is && !prev) n++;
            prev = is;
          }
          return n;
        };
        /** 两个爻段之间隔着的东西（用于证明「断」） */
        const between = (cls, kind) => {
          const idx = cls.map((ch, i) => (ch === kind ? i : -1)).filter(i => i >= 0);
          if (idx.length < 2) return '';
          // 找到前两个爻段的边界，取它们之间的像素
          let end1 = idx[0];
          while (end1 + 1 < cls.length && cls[end1 + 1] === kind) end1++;
          let start2 = idx[idx.length - 1];
          while (start2 - 1 >= 0 && cls[start2 - 1] === kind) start2--;
          return cls.slice(end1 + 1, start2).join('');
        };
        const r0 = rects[0];
        const r1 = rects[1];
        const broken = rects[4];
        return {
          solidRow: rowAt((r0.top + r0.bottom) / 2),
          solidRuns: runs(rowAt((r0.top + r0.bottom) / 2), 'M'),
          gapRow: rowAt((r0.bottom + r1.top) / 2),
          gapRuns: runs(rowAt((r0.bottom + r1.top) / 2), 'M'),
          brokenRow: rowAt((broken.top + broken.bottom) / 2),
          brokenRuns: runs(rowAt((broken.top + broken.bottom) / 2), 'M'),
          brokenBetween: between(rowAt((broken.top + broken.bottom) / 2), 'M'),
        };
      },
      [shot.toString('base64'), styles.rects, scheme]
    );
    ok(px.solidRuns === 1, `[${scheme}] 阳爻行：爻线连成一段（实线画出来了）`, `runs=${px.solidRuns}`);
    ok(px.gapRuns === 0, `[${scheme}] 爻间行：没有爻线（线与线真的分开）`, `runs=${px.gapRuns}`);
    ok(px.brokenRuns === 2, `[${scheme}] 阴爻行：爻线分成两段（离卦中爻真的是断的）`, `runs=${px.brokenRuns}`);
    ok(/T/.test(px.brokenBetween), `[${scheme}] 两段之间是徽章底（缺口有底色透出）`, `"${px.brokenBetween}"`);

    // 徽章是圆角的（设计规格 4px）。注意：不能靠截图的圆角外 alpha 判 ——
    // clip 截图截取的是**页面合成后的区域**，圆角外透出的是标题条底色，
    // alpha 必然是 255；元素截图虽然能给出透明角，但尺寸取整会漂（见上）。
    // 形状断言走计算样式，像素断言只管爻线与底色。
    {
      const radius = await tile.evaluate(el => getComputedStyle(el).borderRadius);
      ok(radius === '4px', `[${scheme}] 徽章圆角 4px（与 OS 图标的圆角徽章同源）`, radius);
    }

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

  // favicon 可访问且带明暗查询
  {
    const ctx = await browser.newContext();
    const r = await ctx.request.get(base + '/favicon.svg');
    ok(r.status() === 200, 'favicon.svg 可访问（200）', String(r.status()));
    ok((r.headers()['content-type'] || '').includes('svg'), 'favicon Content-Type 是 image/svg+xml', r.headers()['content-type']);
    const body = await r.text();
    ok(body.includes('prefers-color-scheme: dark'), 'favicon 内容带 dark 媒体查询（浏览器标签页明暗自适应）');
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
