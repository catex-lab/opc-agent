/**
 * A75 断言：交互填充色只有两档，且「选中」必须压得住「悬停」。
 *
 * 背景（用户原话）：「要求选中回显态的填充色要一致，截图我发现的，其他的
 * 地方的你也要检查并修复」。
 *
 * 修之前，同一档浅灰在界面上有四种写法：
 *   rgba(0,0,0,0.06)     框架面 hover
 *   rgba(31,31,31,0.06)  选中回显（--td-brand-color-light）
 *   #eeeeee              组件面 hover（下拉选项 / 模型行 / 右键菜单）
 *   rgba(0,0,0,0.12)     框架面激活（会话行）
 * 并且权限下拉里「选中」与「悬停」同色（都是 0.06），选中态等于不存在。
 *
 * 这类问题编译通过、页面不报错、截图单看一处也看不出 —— 只有把各处
 * **实际计算出来的底色**摆在一起比，才暴露得出来。所以这里不数类名、
 * 不看截图，而是逐个取 getComputedStyle 的 backgroundColor 做相等断言。
 *
 * 断言分三组：
 *   [1] 令牌阶梯：hover < selected < pressed，且两个别名指向同一档
 *   [2] 悬停：五个不同来源的悬停底色必须完全相同
 *   [3] 选中：五个不同来源的选中底色必须完全相同，且 ≠ 悬停
 *   [4] 芯片四态：空闲/悬停/展开/关闭，三颗芯片逐态同值
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
  '.json': 'application/json',
};

const AGENTS = [
  { id: 'qoder', name: 'Qoder', vendor: 'Alibaba', kind: 'acp', icon: 'qoder', color: '#2BA471', description: 'Qoder', capabilities: ['chat'], status: { availability: 'ready', version: '0.9.1' } },
];
/** 两个模型：第一个带档位表（思考强度下拉才会渲染），第二个不带。 */
const MODELS = [
  {
    modelId: 'm1', name: 'Qwen3.8-Flash', providerName: 'Z.AI', multiplier: '0.0x',
    reasoning: { levels: [{ value: 'low', label: '低', description: '快' }, { value: 'high', label: '高', description: '慢' }], defaultLevel: 'low' },
  },
  { modelId: 'm2', name: 'GLM-5.3', providerName: 'Z.AI', multiplier: '0.34x' },
];
const NOW = new Date().toISOString();
const SESSIONS = [
  { id: 's1', title: 'Qoder', agent_id: 'qoder', model: 'm1', kind: 'direct', created_at: NOW },
  { id: 's2', title: '另一个会话', agent_id: 'qoder', model: 'm1', kind: 'direct', created_at: NOW },
];
const MESSAGES = [{ id: 'm1', role: 'assistant', content: '你好', created_at: NOW }];

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

const server = createServer(async (req, res) => {
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
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route('**/api/**', route => {
  const u = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/\/api\/agents\/[^/]+\/models/.test(u)) return json({ models: MODELS });
  if (u.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(u)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(u)) return json({ models: MODELS, defaultModel: 'm1' });
  if (/\/api\/sessions\/[^/]+$/.test(u)) return json({ session: SESSIONS[0], messages: MESSAGES });
  if (/\/api\/sessions/.test(u)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

const FOOT = 't-chat-sender [slot="footer-prefix"]';
const CHIP = {
  model: `${FOOT} [data-model-trigger]`,
  reasoning: `${FOOT} [data-reasoning-select] .t-input`,
  permission: `${FOOT} [data-permission-mode-select] .t-input`,
};

const bgOf = sel => page.evaluate(s => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).backgroundColor : null;
}, sel);
const bgNth = (sel, i) => page.evaluate(([s, n]) => {
  const el = document.querySelectorAll(s)[n];
  return el ? getComputedStyle(el).backgroundColor : null;
}, [sel, i]);
const park = async () => { await page.mouse.move(640, 90); await page.waitForTimeout(240); };
const alphaOf = c => {
  if (!c) return null;
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map(s => Number(s.trim()));
  return parts.length === 4 ? parts[3] : 1;
};
/** 归一化：CSS 变量里写的是 `.1`、计算样式给的是 `0.1`，直接比字符串会假红。 */
const norm = c => {
  if (!c) return null;
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return c;
  const p = m[1].split(',').map(s => Number(s.trim()));
  const a = p.length === 4 ? p[3] : 1;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${Number(a.toFixed(3))})`;
};

await page.goto(base + '/chat/s1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);

// ── [1] 令牌阶梯 ────────────────────────────────────────────────
console.log('\n[1] 令牌阶梯：hover < selected < pressed');
const tok = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return {
    hover: v('--tc-fill-hover'), selected: v('--tc-fill-selected'), pressed: v('--tc-fill-pressed'),
    aliasHover: v('--tc-hover-chrome'), aliasSelected: v('--td-brand-color-light'),
  };
});
const aHover = alphaOf(tok.hover);
const aSel = alphaOf(tok.selected);
const aPress = alphaOf(tok.pressed);
ok(aHover !== null && aSel !== null && aPress !== null, '三档令牌都已定义且是 rgba', `${tok.hover} / ${tok.selected} / ${tok.pressed}`);
ok(aHover < aSel, '选中比悬停深（否则选中态看不出来）', `${aHover} < ${aSel}`);
ok(aSel < aPress, '按下比选中更深', `${aSel} < ${aPress}`);
ok(tok.aliasHover === tok.hover, '--tc-hover-chrome 就是 hover 档（不留第二套值）', `${tok.aliasHover}`);
ok(tok.aliasSelected === tok.selected, '--td-brand-color-light 就是 selected 档', `${tok.aliasSelected}`);

// ── [2][4] 芯片四态 ────────────────────────────────────────────
console.log('\n[2] 三颗芯片：空闲 / 悬停 / 展开 / 关闭');
await park();
const chipIdle = {};
for (const [k, s] of Object.entries(CHIP)) chipIdle[k] = await bgOf(s);
ok(Object.values(chipIdle).every(v => v === 'rgba(0, 0, 0, 0)'), '空闲态三颗都是透明', JSON.stringify(chipIdle));

const chipHover = {};
for (const [k, s] of Object.entries(CHIP)) {
  await page.locator(s).hover();
  await page.waitForTimeout(240);
  chipHover[k] = await bgOf(s);
  await park();
}
ok(new Set(Object.values(chipHover)).size === 1, '悬停态三颗同值', JSON.stringify(chipHover));
ok(norm(Object.values(chipHover)[0]) === norm(tok.hover), '悬停值 = hover 档', `${Object.values(chipHover)[0]}`);

const chipOpen = {};
const chipClosed = {};
for (const [k, s] of Object.entries(CHIP)) {
  await page.locator(s).click();
  await page.waitForTimeout(420);
  await page.mouse.move(500, 300); // 移到弹层上：触发器不再 hover，只剩「展开」这一个信号
  await page.waitForTimeout(320);
  chipOpen[k] = await bgOf(s);
  await page.keyboard.press('Escape');
  await park();
  chipClosed[k] = await bgOf(s);
}
ok(new Set(Object.values(chipOpen)).size === 1, '展开态三颗同值（鼠标移开触发器后仍保持）', JSON.stringify(chipOpen));
ok(norm(Object.values(chipOpen)[0]) === norm(tok.hover), '展开值 = hover 档', `${Object.values(chipOpen)[0]}`);
ok(new Set(Object.values(chipClosed)).size === 1, '关闭后三颗同值', JSON.stringify(chipClosed));
ok(Object.values(chipClosed)[0] === 'rgba(0, 0, 0, 0)', 'Esc 关闭后三颗都回落到透明', JSON.stringify(chipClosed));

// ── [3] 悬停：五个来源必须同色 ────────────────────────────────
console.log('\n[3] 悬停填充：五个不同来源');
const hoverSamples = {};

// 3a 会话行
await page.locator('.tc-list-item').nth(1).hover();
await page.waitForTimeout(240);
hoverSamples['会话行'] = await bgNth('.tc-list-item', 1);
await park();

// 3b 导航图标
const navHoverIdx = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('nav button')];
  const i = btns.findIndex(b => !b.querySelector('span.scale-y-100'));
  return i;
});
if (navHoverIdx >= 0) {
  await page.locator('nav button').nth(navHoverIdx).hover();
  await page.waitForTimeout(240);
  hoverSamples['导航图标'] = await bgNth('nav button', navHoverIdx);
  await park();
}

// 3c 权限下拉的选项
await page.locator(CHIP.permission).click();
await page.waitForTimeout(450);
const permOpts = await page.evaluate(() =>
  [...document.querySelectorAll('.permission-select-popup .t-select-option')].map((e, i) => ({
    i, sel: e.classList.contains('t-is-selected'),
  }))
);
const permHoverIdx = permOpts.find(o => !o.sel)?.i;
if (permHoverIdx !== undefined) {
  await page.locator('.permission-select-popup .t-select-option').nth(permHoverIdx).hover();
  await page.waitForTimeout(260);
  hoverSamples['下拉选项'] = await bgNth('.permission-select-popup .t-select-option', permHoverIdx);
}
const permSelBg = await page.evaluate(() => {
  const el = document.querySelector('.permission-select-popup .t-select-option.t-is-selected');
  return el ? getComputedStyle(el).backgroundColor : null;
});
await page.keyboard.press('Escape');
await park();

// 3d 模型弹窗的行
await page.locator(CHIP.model).click();
await page.waitForTimeout(450);
const modelRows = await page.evaluate(() =>
  [...document.querySelectorAll('[data-model-row]')].map((e, i) => ({ i, sel: e.getAttribute('data-model-row') === '1' }))
);
const modelHoverIdx = modelRows.find(r => !r.sel)?.i;
if (modelHoverIdx !== undefined) {
  await page.locator('[data-model-row]').nth(modelHoverIdx).hover();
  await page.waitForTimeout(260);
  hoverSamples['模型行'] = await bgNth('[data-model-row]', modelHoverIdx);
}
const modelSelBg = await page.evaluate(() => {
  const el = document.querySelector('[data-model-row="1"]');
  return el ? getComputedStyle(el).backgroundColor : null;
});
await page.keyboard.press('Escape');
await park();

// 3e 自绘菜单的行（附件菜单）
await page.locator('[data-attach-toggle]').click();
await page.waitForTimeout(420);
await page.locator('[data-attach-menu] [role="menuitem"]').first().hover();
await page.waitForTimeout(260);
hoverSamples['自绘菜单行'] = await page.evaluate(() => {
  const el = document.querySelector('[data-attach-menu] [role="menuitem"]');
  return el ? getComputedStyle(el).backgroundColor : null;
});
await page.keyboard.press('Escape');
await park();

for (const [k, v] of Object.entries(hoverSamples)) {
  ok(norm(v) === norm(tok.hover), `悬停 · ${k} = hover 档`, `${v}`);
}
ok(Object.keys(hoverSamples).length >= 4, '悬停采样点够多（≥4 处）', `n=${Object.keys(hoverSamples).length}`);

// ── [4] 选中：五个来源必须同色 ────────────────────────────────
console.log('\n[4] 选中回显：五个不同来源');
const selSamples = {
  '会话行(当前)': await bgNth('.tc-list-item', 0),
  '权限下拉(选中)': permSelBg,
  '模型弹窗(选中)': modelSelBg,
};
const navActive = await page.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find(x => x.querySelector('span.scale-y-100'));
  return b ? getComputedStyle(b).backgroundColor : null;
});
selSamples['导航(当前)'] = navActive;

await page.goto(base + '/settings', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const secSel = await page.evaluate(() => {
  const b = document.querySelector('[data-settings-section][aria-current="page"]');
  return b ? getComputedStyle(b).backgroundColor : null;
});
selSamples['设置分区(当前)'] = secSel;

for (const [k, v] of Object.entries(selSamples)) {
  ok(norm(v) === norm(tok.selected), `选中 · ${k} = selected 档`, `${v}`);
}
ok(
  Object.values(selSamples).every(v => v === Object.values(selSamples)[0]),
  '所有选中态两两相等（这就是用户要的「填充色一致」）',
  `${new Set(Object.values(selSamples)).size} 种取值`
);
ok(norm(Object.values(selSamples)[0]) !== norm(tok.hover), '选中 ≠ 悬停（否则看不出选中）', `${Object.values(selSamples)[0]} vs ${tok.hover}`);

// ── [5] 控制台 ────────────────────────────────────────────────
console.log('\n[5] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 2).join(' | '));

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
}
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
