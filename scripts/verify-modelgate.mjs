/**
 * 模型下拉 / 发送禁用条件 探针。
 *
 * 背景：ChatInput 原来用 `disabled={!selectedModel}`，而 hermes 这类
 * ACP Agent 自己管模型（models 为空、selectedModel 为空），于是明明在线
 * 却完全发不出消息。修复后按 `models.length > 0` 才要求必选。
 *
 * 四组断言：
 *   [1] 无模型列表（自管模型）→ 不渲染下拉、渲染说明徽标、输入框可编辑
 *   [2] 有模型列表           → 触发器显示选中模型
 *   [2b] A73 浮层改版         → 标题栏 ⓘ / 行内 ✓ / 字标 / 角标 / 倍率右对齐 / 底部通栏
 *   [3] unreachable 状态      → 通讯录显示「网络不通」而不是「未接入」
 *
 * 依赖：先 npm run build（脚本托管 dist/）。运行：npm run verify:modelgate
 */
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const AGENTS = [
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous Research', kind: 'acp', icon: 'hermes',
    color: '#834EC2', description: '多 provider 网关型 Agent，自己决定用哪个模型',
    capabilities: ['chat', 'code', 'tools'],
    status: { availability: 'ready', version: '0.21.6', message: 'ACP 握手成功' },
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
    color: '#0EC8A9', description: '通用编码与自动化助手',
    capabilities: ['chat', 'code', 'tools'],
    status: { availability: 'ready', version: '2.4.1' },
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', kind: 'cli', icon: 'codex',
    color: '#10A37F', description: '后端网络不可达的 Agent',
    capabilities: ['chat', 'code'],
    status: { availability: 'unreachable', installed: true, version: '0.161.0', message: '后端网络不可达：chatgpt.com' },
  },
];

// hermes 会话：kind=acp，/api/agents/hermes/models 返回空
const SESSIONS = [
  { id: 'g-hermes', title: 'Hermes', agent_id: 'hermes', kind: 'direct', created_at: new Date().toISOString() },
  { id: 'g-wb', title: 'WorkBuddy', agent_id: 'workbuddy', kind: 'direct', created_at: new Date(Date.now() - 864e5).toISOString() },
];

// A73： fixture 里补上角标 / 倍率 / provider 名 —— 新版浮层这三样都要渲染，
// 一条都不带就验不出「行内 ✓ 与倍率右对齐」这些截图规格。
const MODELS = [
  {
    modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选',
    providerName: 'Anthropic', tag: '付费', multiplier: '1.0x',
  },
  {
    modelId: 'glm-5.3-flash-free', name: 'GLM-5.3 Flash', description: '免费档',
    providerName: 'Z.AI', tag: '免费', multiplier: '0.34x',
  },
];
const MESSAGES = [
  { id: 'm1', role: 'user', content: '你好', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', role: 'assistant', content: '你好，我在。', created_at: new Date().toISOString() },
];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = p === '/' ? 'index.html' : p;
  let file = join(ROOT, 'dist', f);
  let body;
  try {
    body = await readFile(file);
  } catch {
    // SPA 回退：/chat/:id 这类前端路由必须落到 index.html
    file = join(ROOT, 'dist', 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 前置检查：没有 dist 就直接报错，别让失败看起来像 UI 坏了
try { await access(join(ROOT, 'dist', 'index.html')); } catch {
  console.error('缺少 dist/index.html —— 请先执行 npm run build');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/agents/hermes/models')) return json({ models: [] });
  if (url.includes('/api/agents/workbuddy/models')) return json({ models: MODELS });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS, defaultModel: 'claude-sonnet-4-5' });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.match(/\/api\/sessions\/([^/?]+)/)?.[1];
    return json({ session: SESSIONS.find(s => s.id === id) || SESSIONS[0], messages: MESSAGES });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

console.log('\n[1] 自管模型的 Agent（hermes，models 为空）');
await page.goto(`${base}/chat/g-hermes`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
{
  const badge = await page.locator('text=模型由 Agent 决定').count();
  check('渲染「模型由 Agent 决定」说明徽标', badge > 0);

  const sender = page.locator('.t-chat-sender, t-chat-sender, [class*="chat-sender"]').first();
  const ta = page.locator('textarea').first();
  const taState = await ta.evaluate(el => ({ disabled: el.disabled, readOnly: el.readOnly, cls: el.className })).catch(() => null);
  check('输入框未被禁用（否则 Agent 在线也发不出消息）',
    !!taState && taState.disabled === false && taState.readOnly === false,
    JSON.stringify(taState));
  // 注意：TDesign 的 web component 把布尔 prop 渲染成字符串属性
  // （`disabled="false"` 也是"有这个属性"），所以必须读**值**而不是 hasAttribute
  const senderDisabled = await sender.evaluate(el => el.getAttribute('disabled')).catch(() => 'n/a');
  check('ChatSender 的 disabled 不是 true', senderDisabled !== 'true' && senderDisabled !== true, `disabled=${JSON.stringify(senderDisabled)}`);

  // 真实尝试输入并读取值，确认可编辑
  await ta.click();
  await ta.fill('测试输入');
  const v = await ta.inputValue().catch(() => '');
  check('可以向输入框写入内容', v.length > 0, JSON.stringify(v.slice(0, 20)));
}

console.log('\n[2] 有模型列表的 Agent（workbuddy）');
await page.goto(`${base}/chat/g-wb`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
{
  const badge = await page.locator('text=模型由 Agent 决定').count();
  check('不渲染说明徽标', badge === 0);
  // ⚠️ A73 起模型选择器不再是 TDesign `<Select>`，触发器是一颗自带
  // `data-model-trigger` 的按钮，选中项是**文本节点**（不再是 input 的 value）。
  // 原来这里读 `input.t-input__inner[placeholder="选择模型"]` 的 inputValue，
  // 那个 input 已经不存在了。改成读按钮文本，语义不变：
  // 「选中的模型名显示在触发器上」。
  const trigger = page.locator('[data-model-trigger]');
  check('模型触发器在场', (await trigger.count()) === 1);
  const label = (await trigger.first().innerText().catch(() => '')).trim();
  check('触发器显示平台模型', label === 'Claude Sonnet 4.5', `text=${JSON.stringify(label)}`);
}

// ── [2b] A73：浮层按截图改版后的四条规格 ──
console.log('\n[2b] 模型浮层规格（标题栏 / 行内 ✓ / 底部通栏）');
{
  const trigger = page.locator('[data-model-trigger]').first();
  await trigger.click();
  await page.waitForTimeout(350);
  const pop = page.locator('[data-model-popup]');
  check('点触发器浮层出现', (await pop.count()) === 1);

  // 规格 1：标题栏「内置模型」+ ⓘ
  check('标题栏写「内置模型」', (await pop.getByText('内置模型', { exact: true }).count()) === 1);
  check('标题栏有 ⓘ 说明按钮', (await pop.locator('[data-model-popup-info]').count()) === 1);

  // 规格 2：每行 = 名称 + 角标 + 右侧倍率
  const rows = pop.locator('[role="option"]');
  check('两行模型', (await rows.count()) === 2, `rows=${await rows.count()}`);
  check('有免费角标', (await pop.getByText('免费', { exact: true }).count()) === 1);
  check('有付费角标', (await pop.getByText('付费', { exact: true }).count()) === 1);
  check('倍率按右对齐渲染', (await pop.getByText('0.34x', { exact: true }).count()) === 1);
  /* A93：用户要求「取消模型选框里的模型前面的 logo」。
     这里原来是「断言字标 = provider 首字母（A/Z）」，现在反过来断言它**不存在**。
     顺带守两件容易漏的事：
       · 浮层宽度收窄 —— 用户原话「太宽了，留白太大」。272 是实测的
         「最长模型名不截断」宽度，闸门给到 300 留一点余量；
       · 删掉字标后左边不能留一块空位 —— 否则等于「换了个隐形 logo」。 */
  const letters = await pop.locator('[role="option"] > span[aria-hidden]').allInnerTexts();
  check('行内不再有字标方块（A93 移除）', letters.length === 0, `letters=${JSON.stringify(letters)}`);
  const popBox = await pop.boundingBox();
  check('浮层宽度收窄（≤ 300px）', !!popBox && popBox.width <= 300, popBox ? `width=${Math.round(popBox.width)}` : 'n/a');
  const firstTextLeft = await rows.first().evaluate(row => {
    const r = row.getBoundingClientRect();
    for (const el of row.querySelectorAll('*')) {
      if (!el.textContent.trim() || el.children.length) continue;
      return el.getBoundingClientRect().left - r.left;
    }
    return null;
  });
  check(
    '行内文字从左侧内边距开始（删字标后没留空位）',
    firstTextLeft !== null && firstTextLeft <= 16,
    `left=${firstTextLeft === null ? 'n/a' : Math.round(firstTextLeft)}`
  );

  // 规格 3：选中行右侧 ✓ —— 用 data-model-row 而不是数 svg，
  // 因为「有几条被选中」才是这条断言真正想守的东西
  const selected = pop.locator('[data-model-row="1"]');
  check('只有一行被选中', (await selected.count()) === 1);
  check('选中行是 Claude Sonnet 4.5', (await selected.first().innerText()).includes('Claude Sonnet 4.5'));
  check('选中行带 ✓ 图标', (await selected.first().locator('svg').count()) >= 1);
  check('选中行标了 aria-selected', (await selected.first().getAttribute('aria-selected')) === 'true');

  // 规格 4：底部通栏「添加模型」，且是钉在底边的（不在列表滚动区里）
  const add = pop.locator('[data-model-popup-add]');
  check('底部有「添加模型」通栏按钮', (await add.count()) === 1);
  check('按钮文案是「添加模型」', (await add.innerText()).trim() === '添加模型');
  const addBox = await add.boundingBox();
  const listBox = await pop.locator('[data-model-popup-list]').boundingBox();
  check(
    '「添加模型」在列表下方（不跟着列表滚）',
    !!addBox && !!listBox && addBox.y >= listBox.y + listBox.height - 1,
    addBox && listBox ? `add.y=${Math.round(addBox.y)} list.bottom=${Math.round(listBox.y + listBox.height)}` : 'n/a'
  );

  // 交互：点第二行 → 选中切换、触发器文案跟着变、浮层收起
  await rows.nth(1).click();
  await page.waitForTimeout(250);
  check('点选后浮层收起', (await pop.count()) === 0);
  const after = (await trigger.innerText().catch(() => '')).trim();
  check('触发器切成新选中的模型', after === 'GLM-5.3 Flash', `text=${JSON.stringify(after)}`);

  // 键盘：Esc 能关（TDesign Select 自带的能力，换成自绘后不能丢）
  await trigger.click();
  await page.waitForTimeout(300);
  check('再点能重新打开', (await pop.count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc 能关掉浮层', (await pop.count()) === 0);
}

console.log('\n[3] unreachable 状态在资料页的呈现');
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const openBtn = page.locator("text=打开通讯录").first(); const oc = await openBtn.count(); console.log("  打开通讯录按钮:", oc); if (oc) await openBtn.click(); await page.waitForTimeout(1400);
{
  // 通讯录行现在只留「头像 + 名称 + 在线圆点」，状态文字收进了二级资料页。
  // 所以必须先点进 Codex 的资料页再断言 —— 直接在列表里找「网络不通」会
  // 永远找不到，而那正是这次改版的目的（列表不承载详情）。
  const row = page.locator('button:has-text("Codex")').first();
  const rc = await row.count();
  check('通讯录能定位到 Codex 行', rc > 0, `matches=${rc}`);
  if (rc) {
    await row.click();
    await page.waitForTimeout(800);
  }

  const lbl = await page.locator("text=网络不通").count();
  check('资料页显示「网络不通」而不是「未接入/未探测」', lbl > 0, `matches=${lbl}`);

  // 反向断言：列表行里不该再出现厂商名。否则说明详情信息又漏回列表了，
  // 改版等于白做 —— 这类「改回去了但没人发现」只能靠反向断言兜住。
  const vendorInRow = await page.locator('button:has-text("Codex")').locator("text=OpenAI").count();
  check('列表行不再显示厂商等详情', vendorInRow === 0, `matches=${vendorInRow}`);
}

check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n模型门控探针：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
