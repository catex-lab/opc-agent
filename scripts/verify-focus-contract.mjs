/**
 * A190 闸门：输入框焦点契约。
 *
 * 不依赖 dist/（发布线在改设置页下拉，禁止跑全量 build），
 * 这里用 esbuild 把真实组件 + 真实样式表打成一个临时夹具页：
 * 样式顺序与产品完全一致 —— kb-ui.css → focus-contract.css → index.css 正文。
 *
 * 覆盖：
 *   [1] TDesign Textarea：不再「边框变品牌色 + 光环」，只留 2px 中性环
 *   [2] TDesign Input：3px 旧晕换成 2px 契约环
 *   [3] .kb-input：2px/55% outline 收回契约口径
 *   [4] .tc-input：聚焦不改边框色，hover 才抬到 edge-strong
 *   [5] 勾选框：键盘 :focus-visible 有 2px outline，鼠标点击不出环
 *   [6] 聊天输入面：保持 --tc-focus-shadow 的 3px 抬升语义，不被合并成 2px
 *   [7] 浅 / 深两套主题各自断言一次
 *
 * 运行：node scripts/verify-focus-contract.mjs
 * 截图：node scripts/verify-focus-contract.mjs --shots
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const OUT = join(ROOT, '.render-check', 'focus-contract');
const FIXTURE_DIR = join(tmpdir(), 'opc-focus-contract-fixture');
const SHOTS_DIR = join(OUT, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WANT_SHOTS = process.argv.includes('--shots');

const failures = [];
const checks = { total: 0 };
function ok(condition, label, detail) {
  checks.total++;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

/** 去掉 Tailwind 指令与 @import / @layer utilities，只保留令牌与全局样式。 */
function cssBodyOnly(css) {
  let next = css
    .replace(/@tailwind\s+[a-z]+;/g, '')
    .replace(/@import\s+'\.\/[^']+\.css';/g, '');
  const marker = '@layer utilities {';
  const start = next.indexOf(marker);
  if (start >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = next.indexOf('{', start); i < next.length; i++) {
      if (next[i] === '{') depth++;
      else if (next[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) next = next.slice(0, start) + next.slice(end + 1);
  }
  return next;
}

function parseRgba(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (!parts.length) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

const isNeutral = c => c && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 2;

const FIXTURE_ENTRY = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Input, Textarea } from 'tdesign-react';
import { ChatSender } from '@tdesign-react/chat';
// 与 main.tsx 相同的样式入场顺序：TDesign 组件样式 → chat 样式 → 项目样式。
// 前两份由 esbuild 打进 entry.css（HTML 里必须显式链上，否则组件基础样式不生效）；
// 项目样式走独立的 styles.css 链接，排在 entry.css 之后。
import 'tdesign-react/dist/tdesign.css';
import '@tdesign/web-components-chat/style/index.css';

const box = { padding: '20px 24px' };
const bar = { padding: '12px 24px 24px' };

function App() {
  return (
    <div id="fx" style={{ width: '560px', background: 'var(--td-bg-color-page)' }}>
      <div data-shot="textarea" style={box}><Textarea placeholder="多行文本" /></div>
      <div data-shot="input" style={box}><Input placeholder="单行输入" /></div>
      <div data-shot="kb" style={box}><input className="kb-input" placeholder="知识库检索" /></div>
      <div data-shot="tc" style={box}><input className="tc-input" placeholder="备注" /></div>
      <div data-shot="checkbox" style={bar}><input type="checkbox" /></div>
      <div data-shot="chat" style={bar}><ChatSender placeholder="输入消息..." /></div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

/** 只在 --shots 时注入：把契约覆盖回旧值，拍「改前」用，不改仓库里的任何文件。 */
const LEGACY_CSS = `
html[data-legacy] .t-textarea .t-textarea__inner:focus {
  border-color: var(--td-brand-color) !important;
  box-shadow: 0 0 0 2px var(--td-brand-color-focus) !important;
}
html[data-legacy] .t-textarea .t-textarea__inner:hover {
  border-color: var(--td-brand-color) !important;
}
html[data-legacy] .t-input.t-is-focused,
html[data-legacy] .t-input:focus-within {
  box-shadow: var(--tc-focus-shadow) !important;
}
html[data-legacy] .kb-input.kb-input:focus {
  outline: 2px solid color-mix(in srgb, var(--td-brand-color) 55%, transparent) !important;
  outline-offset: 2px !important;
  box-shadow: none !important;
}
html[data-legacy] .tc-input.tc-input:focus {
  border-color: var(--tc-edge-strong) !important;
  box-shadow: var(--tc-focus-shadow) !important;
}
html[data-legacy] input[type='checkbox']:focus-visible {
  outline: none !important;
}
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const file = join(FIXTURE_DIR, path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    res.writeHead(404).end(String(error));
  }
});

await mkdir(OUT, { recursive: true });
await mkdir(FIXTURE_DIR, { recursive: true });
if (WANT_SHOTS) await mkdir(SHOTS_DIR, { recursive: true });

const [indexCss, kbCss, contractCss] = await Promise.all([
  readFile(join(ROOT, 'src', 'index.css'), 'utf8'),
  readFile(join(ROOT, 'src', 'kb-ui.css'), 'utf8'),
  readFile(join(ROOT, 'src', 'focus-contract.css'), 'utf8'),
]);
// 真实级联顺序：kb-ui → focus-contract → index.css 正文。
await writeFile(join(FIXTURE_DIR, 'styles.css'), `${kbCss}\n${contractCss}\n${cssBodyOnly(indexCss)}`, 'utf8');
await writeFile(join(FIXTURE_DIR, 'entry.tsx'), FIXTURE_ENTRY, 'utf8');
await writeFile(
  join(FIXTURE_DIR, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    // entry.css 是 esbuild 产出的组件样式（TDesign → chat），必须先于项目样式。
    '<link rel="stylesheet" href="./entry.css">' +
    '<link rel="stylesheet" href="./styles.css"></head>' +
    '<body style="margin:0;background:var(--td-bg-color-page)"><div id="root"></div>' +
    '<script src="./entry.js"></script></body></html>',
  'utf8'
);

await build({
  entryPoints: [join(FIXTURE_DIR, 'entry.tsx')],
  outdir: FIXTURE_DIR,
  entryNames: 'entry',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(ROOT, 'node_modules')],
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
  logLevel: 'silent',
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
  viewport: { width: 900, height: 900 },
  deviceScaleFactor: 2,
});

const CASES = {
  textarea: {
    focus: '[data-shot="textarea"] .t-textarea__inner',
    style: '[data-shot="textarea"] .t-textarea__inner',
    label: 'Textarea',
  },
  input: {
    focus: '[data-shot="input"] .t-input__inner',
    style: '[data-shot="input"] .t-input',
    label: 'TDesign Input',
  },
  kb: {
    focus: '[data-shot="kb"] .kb-input',
    style: '[data-shot="kb"] .kb-input',
    label: '.kb-input',
  },
  tc: {
    focus: '[data-shot="tc"] .tc-input',
    style: '[data-shot="tc"] .tc-input',
    label: '.tc-input',
  },
};

async function readStyle(page, key) {
  return page.evaluate(
    ({ focus, style }) => {
      const f = document.querySelector(focus);
      const t = document.querySelector(style);
      const cs = getComputedStyle(t);
      return {
        border: cs.borderTopColor,
        shadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset,
        focused: document.activeElement === f,
      };
    },
    { focus: CASES[key].focus, style: CASES[key].style }
  );
}

async function openPage(theme) {
  const page = await context.newPage();
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForSelector('[data-shot="textarea"] .t-textarea__inner');
  await page.waitForTimeout(150);
  return page;
}

async function resetMouse(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(260);
}

async function focusByMouse(page, key) {
  await page.locator(CASES[key].focus).click();
  // 移开鼠标：点击后的 :hover 边框会被 hover 规则接管，测「聚焦本身」要排除它。
  await resetMouse(page);
}

async function runTheme(theme) {
  console.log(`\n[${theme}]`);
  const page = await openPage(theme);

  // [7] 令牌本身：两套主题各自存在且不是同一支。
  const ringToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--opc-focus-ring').trim()
  );
  ok(ringToken.length > 0, `${theme}·焦点环令牌已定义`, ringToken);

  const ring = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.boxShadow = '0 0 0 2px var(--opc-focus-ring)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).boxShadow;
    probe.remove();
    return value;
  });
  const ringColor = parseRgba(ring);
  ok(isNeutral(ringColor), `${theme}·焦点环是中性色`, ring);
  ok(ringColor && ringColor.a <= 0.2, `${theme}·焦点环 alpha ≤ 0.2`, ringColor ? `α=${ringColor.a}` : 'n/a');
  ok(
    ringColor && (theme === 'dark' ? ringColor.r > 128 : ringColor.r < 128),
    `${theme}·焦点环方向正确（${theme === 'dark' ? '提白' : '压黑'}）`,
    ringColor ? `rgb(${ringColor.r},${ringColor.g},${ringColor.b})` : 'n/a'
  );

  // [1]-[4] 四类输入控件。
  for (const key of Object.keys(CASES)) {
    await resetMouse(page);
    const before = await readStyle(page, key);
    await focusByMouse(page, key);
    const after = await readStyle(page, key);
    const label = `${theme}·${CASES[key].label}`;

    ok(after.focused, `${label} 已真实聚焦`);
    ok(after.outlineStyle === 'none', `${label} 无 outline`, `${after.outlineStyle}/${after.outlineWidth}`);
    ok(after.border === before.border, `${label} 聚焦不改边框色`, `${before.border} → ${after.border}`);
    ok(after.shadow !== before.shadow, `${label} 聚焦有可见反馈`, after.shadow);
    ok(/0px 0px 0px 2px/.test(after.shadow), `${label} 环宽为 2px`, after.shadow);
    const color = parseRgba(after.shadow);
    ok(isNeutral(color), `${label} 环为中性色`, after.shadow);
    ok(color && color.a <= 0.2, `${label} 环 alpha ≤ 0.2`, color ? `α=${color.a}` : 'n/a');

    if (WANT_SHOTS) {
      const shot = page.locator(`[data-shot="${key}"]`);
      await shot.screenshot({ path: join(SHOTS_DIR, `${theme}-${key}-after.png`) });
    }

    // 改前对照：仅注入旧声明，不改仓库文件。
    if (WANT_SHOTS) {
      await page.evaluate(() => document.documentElement.setAttribute('data-legacy', '1'));
      const styleTag = await page.addStyleTag({ content: LEGACY_CSS });
      await focusByMouse(page, key);
      await page.locator(`[data-shot="${key}"]`).screenshot({
        path: join(SHOTS_DIR, `${theme}-${key}-before.png`),
      });
      await page.evaluate(() => {
        document.documentElement.removeAttribute('data-legacy');
      });
      await styleTag.evaluate(node => node.remove());
    }
  }

  // [5] 勾选框：键盘 Tab 聚焦要有环，鼠标点击不能有环。
  await page.locator('body').click({ position: { x: 8, y: 8 } });
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => !!document.activeElement && document.activeElement.matches('input[type=checkbox]'));
  }
  ok(reached, `${theme}·勾选框可通过 Tab 聚焦`);
  if (reached) {
    const box = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return {
        visible: el.matches(':focus-visible'),
        style: cs.outlineStyle,
        width: cs.outlineWidth,
        offset: cs.outlineOffset,
        color: cs.outlineColor,
      };
    });
    ok(box.visible, `${theme}·勾选框键盘态命中 :focus-visible`);
    ok(box.style === 'solid' && box.width === '2px', `${theme}·勾选框有 2px outline`, `${box.style}/${box.width}`);
    ok(box.offset === '2px', `${theme}·勾选框 outline-offset 为 2px`, box.offset);
    const boxColor = parseRgba(box.color);
    ok(isNeutral(boxColor), `${theme}·勾选框焦点环为中性色`, box.color);
    ok(boxColor && boxColor.a >= 0.4 && boxColor.a <= 0.6, `${theme}·勾选框焦点环可见`, boxColor ? `α=${boxColor.a}` : 'n/a');

    if (WANT_SHOTS) {
      await page.locator('[data-shot="checkbox"]').screenshot({ path: join(SHOTS_DIR, `${theme}-checkbox.png`) });
    }

    // 鼠标点击后 :focus-visible 不应命中，环必须消失。
    // 先点空白处让勾选框失焦：Chrome 对「已经聚焦」的元素再次点击不会切换模态，
    // 不先失焦会把键盘态残留误判成鼠标态。
    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.locator('[data-shot="checkbox"] input').click();
    const byMouse = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { visible: el.matches(':focus-visible'), style: cs.outlineStyle };
    });
    ok(!byMouse.visible, `${theme}·勾选框鼠标点击不命中 :focus-visible`);
    ok(byMouse.style === 'none', `${theme}·勾选框鼠标点击无 outline`, byMouse.style);
  }

  // [6] 聊天输入面：保持 3px 抬升晕，不做 2px 契约环。
  const chat = await page.evaluate(() => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of list) {
        if (rule.selectorText && rule.selectorText.includes('t-chat-sender')) {
          rules.push({
            sel: rule.selectorText,
            shadow: rule.style.boxShadow || '',
            border: rule.style.borderColor || '',
            outline: rule.style.outlineStyle || '',
            outlineWidth: rule.style.outlineWidth || '',
          });
        }
      }
    }
    const probe = document.createElement('div');
    probe.style.boxShadow = 'var(--tc-focus-shadow)';
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).boxShadow;
    probe.remove();
    return { rules, resolved };
  });
  const chatRule = chat.rules.find(rule => rule.shadow.includes('var(--tc-focus-shadow)'));
  ok(!!chatRule, `${theme}·聊天输入面仍使用 --tc-focus-shadow`, chatRule ? chatRule.sel : 'n/a');
  ok(!chat.rules.some(rule => rule.shadow.includes('opc-focus-ring')), `${theme}·聊天输入面未被 2px 契约环接管`);
  if (chatRule) {
    ok(chatRule.border === 'transparent', `${theme}·聊天输入面边框保持透明`, chatRule.border || 'n/a');
    ok(chatRule.outline === '' || chatRule.outline === 'none', `${theme}·聊天输入面无 outline`, chatRule.outline || 'n/a');
  }
  ok(/0px 0px 0px 3px/.test(chat.resolved), `${theme}·聊天环仍为 3px（未合并进 2px 契约）`, chat.resolved);
  const chatColor = parseRgba(chat.resolved);
  ok(isNeutral(chatColor), `${theme}·聊天环为中性色`, chat.resolved);
  ok(chatColor && chatColor.a <= 0.2, `${theme}·聊天环 alpha ≤ 0.2`, chatColor ? `α=${chatColor.a}` : 'n/a');

  if (WANT_SHOTS) {
    await page.locator('[data-shot="chat"]').screenshot({ path: join(SHOTS_DIR, `${theme}-chat.png`) });
  }

  await page.close();
}

try {
  await runTheme('light');
  await runTheme('dark');
} finally {
  await browser.close();
  server.close();
}

console.log(`\nA190 焦点契约：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('失败项：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log('截图目录：', SHOTS_DIR);
