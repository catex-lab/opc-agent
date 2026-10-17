/**
 * 模型下拉 / 发送禁用条件 探针。
 *
 * 背景：ChatInput 原来用 `disabled={!selectedModel}`，而 hermes 这类
 * ACP Agent 自己管模型（models 为空、selectedModel 为空），于是明明在线
 * 却完全发不出消息。修复后按 `models.length > 0` 才要求必选。
 *
 * 三组断言：
 *   [1] 无模型列表（自管模型）→ 不渲染下拉、渲染说明徽标、输入框可编辑
 *   [2] 有模型列表           → 正常渲染下拉，不出现徽标
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

const MODELS = [
  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' },
  { modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1', description: '最强推理' },
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
  const selectText = await page.locator('text=Claude Sonnet 4.5').count();
  check('模型下拉显示平台模型', selectText > 0);
}

console.log('\n[3] unreachable 状态在通讯录的呈现');
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const openBtn = page.locator("text=打开通讯录").first(); const oc = await openBtn.count(); console.log("  打开通讯录按钮:", oc); if (oc) await openBtn.click(); await page.waitForTimeout(1200);
await page.waitForTimeout(1400);
{
  const dump = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log("  --- 页面文本 ---\n" + dump.split("\n").filter(Boolean).slice(0, 30).map(l => "    " + l).join("\n"));
  const lbl = await page.locator("text=网络不通").count();
  check('显示「网络不通」而不是「未接入/未探测」', lbl > 0, `matches=${lbl}`);
}

check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n模型门控探针：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
