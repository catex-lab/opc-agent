/**
 * A139 验证：逐页第 5 站 —— 项目页 / 群聊创建。
 *
 * ## 这一站为什么先量再改
 *
 * 审查报告是从缩小截图写出来的，本项目已因此误判过三次（A134 的「三颗按钮
 * 无主次」、A136 的「正文 13px」、P0-2 的「令牌形同虚设」）。所以这一站
 * 先跑只读探针（`.tmp/probe-station5.mjs`），量出来的结论是：
 *
 *   已达标：弹窗 880×600 固定、矮窗口退到 552 且底部按钮仍完整可见、
 *          成员行 52px 整行可点、不可用成员带状态词、项目路径已用次级样式、
 *          任务空态有输入入口、移除确认说清了影响范围（不删目录/记忆）。
 *   真缺口：① 项目路径只能靠悬停看全、**没有任何复制入口**；
 *          ② 群聊弹窗搜出空时**没有清除搜索的出口**；
 *          ③ 「完成」灰着却**没说明为什么**（title 与界面文案都没有）。
 *
 * 本脚本守的就是这三条，外加「改完别把原来对的东西弄坏」。
 *
 * ## 为什么「复制」要验内容而不是验按钮存在
 *
 * 按钮在 ≠ 复制的是对的东西。路径与项目名长得很像，复制成 name 一样「有反馈」。
 * 所以这里把 `navigator.clipboard.writeText` 打桩记录实参，断言它等于 `project.path`。
 *
 * ## 反向探针
 *
 * `--probe-old` 在运行时把三处改动**退回旧版**（删 title、删空态第二行、
 * 藏掉复制按钮与清除搜索），不重建 dist。断言必须变红，否则说明它们只是在
 * 数元素、并没有真正守住行为。
 *
 * 运行：node scripts/verify-a139-station5.mjs [--probe-old]（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.render-check', 'a139');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROBE = process.argv.includes('--probe-old');

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

const mkAgent = (id, name, availability) => ({
  id, name, vendor: 'v', kind: 'sdk', icon: 'workbuddy',
  color: '#0EC8A9', description: 'x', capabilities: ['chat'],
  status: { availability, version: '1' },
});

const AGENTS = [
  mkAgent('a1', 'WorkBuddy', 'ready'),
  mkAgent('a2', 'Hermes', 'ready'),
  mkAgent('a3', 'Gemini', 'needs-auth'),
];

/** 长到一定会在 1440 宽下被截断的路径 —— 复制功能的意义就建立在「看不全」上 */
const LONG_PATH = 'd:/work/demo/app/一个非常长的项目目录名用来测试路径是否会被截断';

const PROJECT = {
  id: 'p-a',
  path: LONG_PATH,
  name: 'opc-agent',
  created_at: '2026-10-01T00:00:00.000Z',
  last_opened_at: '2026-10-25T10:00:00.000Z',
  sessionCount: 2,
  memory: { key: 'k', exists: true, coreTokens: 320, coreBudget: 800, skillCount: 3, skillTokens: 900 },
};

const now = Date.now();
const mkSession = (id, title, agentId, kind) => ({
  id, title, agent_id: agentId, model: 'm', kind,
  project_id: 'p-a', cwd: LONG_PATH,
  created_at: new Date(now - 60 * 60000).toISOString(),
});
// 一条群聊：用来验证「有群 + 搜出空」时清除搜索要出现
const SESSIONS = [
  mkSession('s-g1', '产品讨论群', null, 'group'),
  mkSession('s-a1', 'A 里的老会话', 'a1', 'chat'),
];

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

async function newPage({ agents = AGENTS, clipboardThrows = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // 剪贴板打桩：记录实参，顺便让「复制失败」这条路可测
  await ctx.addInitScript(({ throws }) => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t) => {
          if (throws) throw new Error('clipboard denied');
          window.__copied.push(t);
        },
      },
    });
    if (throws) document.execCommand = () => false;
  }, { throws: clipboardThrows });

  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents });
    if (/\/api\/models/.test(url)) return json({ models: [{ modelId: 'm', name: 'Sonnet 4.5' }] });
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
    if (/\/api\/projects$/.test(url)) return json({ projects: [PROJECT] });
    if (/\/api\/projects\/[^/?]+\/tasks/.test(url)) return json({ tasks: [] });
    if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session: SESSIONS[0], messages: [] });
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/**
 * 反向探针：运行时把三处改动退回旧版。
 *
 * ⚠️ 必须用 MutationObserver 持续摘除，**不能只在调用时扫一遍**：
 * 「清除搜索」是输入关键词之后才条件渲染的，一次性扫描时它还不存在 ——
 * 第一版探针就因此漏掉两条断言（照旧全绿）。这正是本项目记过的假绿陷阱：
 * 探针没真把实现退回去，绿的证明力等于零。
 */
async function applyProbe(page) {
  if (!PROBE) return;
  await page.evaluate(() => {
    const revert = () => {
      document.querySelectorAll('[data-new-group-submit]').forEach(el => el.removeAttribute('title'));
      document.querySelectorAll('[data-new-group-dialog] p').forEach(el => {
        if (el.textContent.trim() === '至少 1 名才能发起群聊') el.remove();
      });
      document.querySelectorAll('[data-project-copy-path],[data-new-group-clear-search],[data-project-clear-search]')
        .forEach(el => el.remove());
    };
    revert();
    new MutationObserver(revert).observe(document.body, { childList: true, subtree: true });
  });
  console.log('  ⚠️ --probe-old：三处改动已退回旧版，下面的断言应当变红\n');
}

async function openNewGroup(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.locator('nav button[aria-label="通讯录"]').click();
  await page.waitForTimeout(500);
  await page.locator('[aria-label="添加"]').first().click();
  await page.waitForTimeout(400);
  await page.getByText('发起群聊', { exact: true }).first().click();
  await page.waitForTimeout(500);
}

async function gotoProjectDetail(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.locator('nav button[aria-label="项目"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-project-row="p-a"]').first().click();
  await page.waitForTimeout(700);
}

// ══════════ [1] 群聊弹窗：禁用态必须说明为什么 ══════════
console.log('\n[1] 发起群聊：未选成员时「完成」禁用，且说清原因');
{
  const { ctx, page, errors } = await newPage();
  await openNewGroup(page);
  await applyProbe(page);

  const submit = page.locator('[data-new-group-submit]');
  const disabled = await submit.evaluate(el => el.disabled);
  ok(disabled === true, '未选成员时「完成」是 disabled');

  const title = await submit.getAttribute('title');
  ok(!!title && /先勾选/.test(title), '禁用态带 title 说明原因', `title=${JSON.stringify(title)}`);

  // 界面侧的解释：不能只靠 hover
  const emptyText = await page.locator('[data-new-group-dialog]').innerText();
  ok(/从左侧勾选 AGENT/.test(emptyText), '右栏空态仍给出操作指令（没被改坏）');
  ok(/至少\s*1\s*名/.test(emptyText), '右栏空态说明了「不选会怎样」');

  await page.locator('[data-new-group-agent="a1"]').click();
  await page.waitForTimeout(300);
  const after = await submit.evaluate(el => ({ disabled: el.disabled, title: el.getAttribute('title') }));
  ok(after.disabled === false, '勾 1 人后「完成」可用');
  ok(after.title === null, '可用后 title 不再挂提示（否则会误导成还有前置条件）');
  ok(errors.length === 0, '控制台无错误', errors.length ? JSON.stringify(errors.slice(0, 2)) : '');
  await ctx.close();
}

// ══════════ [2] 群聊弹窗：搜出空要有出口 ══════════
console.log('\n[2] 发起群聊：搜出空时给「清除搜索」，且只在搜出空时给');
{
  const { ctx, page } = await newPage();
  await openNewGroup(page);
  await applyProbe(page);

  ok(await page.locator('[data-new-group-clear-search]').count() === 0,
    '没搜索时不出现「清除搜索」（否定式）');

  await page.locator('[data-new-group-search]').fill('zzz-不存在');
  await page.waitForTimeout(300);
  const text = await page.locator('[data-new-group-dialog]').innerText();
  ok(/没有匹配的 AGENT/.test(text), '搜出空时给出空态文案');

  const clear = page.locator('[data-new-group-clear-search]');
  ok(await clear.count() >= 1, '搜出空时出现「清除搜索」', `count=${await clear.count()}`);

  if (await clear.count() > 0) {
    await clear.first().click();
    await page.waitForTimeout(300);
    const kw = await page.locator('[data-new-group-search]').inputValue();
    ok(kw === '', '点「清除搜索」后搜索框清空', `value=${JSON.stringify(kw)}`);
    ok(await page.locator('[data-new-group-agent]').count() > 0,
      '清除后成员列表恢复（证明列表真的回来了，不是只清了个字符串）');
  }
  await ctx.close();
}

// ══════════ [3] 项目页：复制路径 ══════════
console.log('\n[3] 项目详情：复制路径复制的是 path，不是 name');
{
  const { ctx, page, errors } = await newPage();
  await gotoProjectDetail(page);
  await applyProbe(page);

  const btn = page.locator('[data-project-copy-path]');
  ok(await btn.count() === 1, '详情页头部有「复制路径」按钮');

  if (await btn.count() > 0) {
    const label = await btn.getAttribute('aria-label');
    ok(/复制项目路径/.test(label || ''), '按钮有可读的名称', `aria-label=${JSON.stringify(label)}`);

    await btn.click();
    await page.waitForTimeout(250);
    const copied = await page.evaluate(() => window.__copied);
    ok(copied.length === 1, '点击后调用了剪贴板一次', `calls=${copied.length}`);
    ok(copied[0] === PROJECT.path, '复制的内容等于 project.path（不是 name）',
      `实得=${JSON.stringify(copied[0])}`);

    // 跨状态：先有「已复制」，再复位 —— 只验一帧的话「永远显示已复制」也会绿
    const lit = await btn.evaluate(el => ({ copied: el.dataset.copied, title: el.getAttribute('title') }));
    ok(lit.copied === '1', '点击后进入「已复制」态');
    ok(/已复制路径/.test(lit.title || ''), '「已复制」态改 title（悬停可复现）', `title=${JSON.stringify(lit.title)}`);

    await page.waitForTimeout(1600);
    const reset = await btn.evaluate(el => ({ copied: el.dataset.copied, title: el.getAttribute('title') }));
    ok(reset.copied === undefined, '1.5s 后复位（否则下一次点击没有反馈）', `data-copied=${JSON.stringify(reset.copied)}`);
    ok(/复制项目路径/.test(reset.title || ''), '复位后 title 也回到「复制项目路径」');
  }
  ok(errors.length === 0, '控制台无错误', errors.length ? JSON.stringify(errors.slice(0, 2)) : '');
  await ctx.close();
}

// ══════════ [4] 复制失败要如实提示，不许静默 ══════════
console.log('\n[4] 剪贴板被拒时如实提示（静默失败会让用户以为复制成功）');
{
  const { ctx, page } = await newPage({ clipboardThrows: true });
  await gotoProjectDetail(page);
  await page.locator('[data-project-copy-path]').click();
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText();
  ok(/复制失败/.test(body), '失败时出现「复制失败」提示');
  const lit = await page.locator('[data-project-copy-path]').getAttribute('data-copied');
  ok(lit === null, '失败时不进入「已复制」态（不能撒谎）');
  await ctx.close();
}

// ══════════ [5] 项目栏：搜出空要有出口 ══════════
console.log('\n[5] 项目列表：搜出空时给「清除搜索」');
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.locator('nav button[aria-label="项目"]').click();
  await page.waitForTimeout(700);
  await applyProbe(page);

  ok(await page.locator('[data-project-clear-search]').count() === 0, '没搜索时不出现「清除搜索」');
  await page.locator('[data-project-search]').fill('zzz');
  await page.waitForTimeout(300);
  const clear = page.locator('[data-project-clear-search]');
  ok(await clear.count() === 1, '搜出空时出现「清除搜索」');
  if (await clear.count() > 0) {
    await clear.click();
    await page.waitForTimeout(300);
    ok(await page.locator('[data-project-search]').inputValue() === '', '点它后搜索框清空');
    ok(await page.locator('[data-project-row="p-a"]').count() === 1, '项目行回来了');
  }
  await ctx.close();
}

// ══════════ [6] 原来就对的东西，别改坏 ══════════
console.log('\n[6] 回归：这一站本来就达标的部分');
{
  const { ctx, page } = await newPage();
  await openNewGroup(page);
  const dialog = await page.locator('[data-new-group-dialog]').boundingBox();
  ok(Math.round(dialog.width) === 880 && Math.round(dialog.height) === 600,
    '弹窗尺寸仍是 880×600（没被这轮改动带跑）', `${Math.round(dialog.width)}x${Math.round(dialog.height)}`);

  const rowH = await page.locator('[data-new-group-agent]').first().evaluate(el => el.getBoundingClientRect().height);
  ok(rowH >= 44, '成员行仍是整行可点（≥44px）', `${rowH}px`);

  const bad = await page.locator('[data-new-group-agent="a3"]').innerText();
  ok(/未登录/.test(bad), '不可用成员仍带状态词（原因没丢）', JSON.stringify(bad.replace(/\n/g, ' | ')));

  const submitBox = await page.locator('[data-new-group-submit]').boundingBox();
  ok(submitBox && submitBox.y + submitBox.height <= 900, '底部操作区仍完整可见');
  await ctx.close();
}

// ══════════ [7] 源码契约：口径不能靠运行时偶然 ══════════
console.log('\n[7] 源码契约');
{
  const { readFile: rf } = await import('node:fs/promises');
  const detail = await rf(join(ROOT, 'src/components/ProjectDetail.tsx'), 'utf8');
  const group = await rf(join(ROOT, 'src/components/NewGroupDialog.tsx'), 'utf8');
  const clip = await rf(join(ROOT, 'src/clipboard.ts'), 'utf8');

  ok(/copyText\(project\.path\)/.test(detail), '复制调用的是 project.path（源码层再钉一次）');
  ok(/1500/.test(detail), '复位定时器写的是 1500ms');
  ok(/typeof|navigator\.clipboard/.test(clip), 'clipboard 工具确实优先用 clipboard API');
  ok(/execCommand/.test(clip), 'clipboard 工具保留了 execCommand 兜底');
  ok(/selected\.length === 0 \? '先勾选至少 1 名 AGENT'/.test(group), '禁用态 title 与条件同源');
}

await browser.close();
server.close();

console.log(`\n${total - failures.length}/${total} 通过${PROBE ? '（反向探针模式）' : ''}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
}
console.log(`截图目录：${OUT}`);
process.exit(failures.length ? 1 : 0);
