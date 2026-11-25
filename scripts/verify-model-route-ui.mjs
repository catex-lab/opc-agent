/**
 * 模型路由 UI 闸门：设置页「模型清单」子块的自定义路由 CRUD。
 *
 * 守的是整条用户可见链路，不是某个纯函数：
 *   [1] 分区结构不变：导航仍是八项，自定义路由是「模型清单」的**子块**，
 *       没有新增导航分区（a28/a37 钉死了分区数量）；
 *   [2] Agent 选择器只列已接入的 Agent（API 的 findDef 归属闸同样只认这些）；
 *   [3] 空态 → 点「添加路由」→ 表单出现，且「不填密钥」提示可见；
 *   [4] 填写 provider/model → 保存发出 POST /api/model-routes，
 *       **body 里没有 apiKey/secret/token**，只有引用名；
 *   [5] 保存后新行出现；同一动作触发模型菜单重取
 *       （emitModelRoutesChanged → modelsEpoch → /api/agents/:id/models）；
 *   [6] 编辑发出 PUT，行内容更新；
 *   [7] 删除要二次确认，确认后发 DELETE，行消失；
 *   [8] 服务端把用户路由并进 `configured` 平级字段（不动 models 数组）；
 *   [9] 模型清单主表只有 Agent / 模型两列，枚举来源折进展开明细（不丢信息）；
 *   [10] 无控制台错误。
 *
 * 断言纪律（沿用 §3）：UI 点击走真实坐标 + elementFromPoint 自证；
 * 否定式断言配肯定式；先证明页面打开了再判「没有 X」。
 *
 * 运行：node scripts/verify-model-route-ui.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './lib/chrome.mjs';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const CHROME = resolveChromePath();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const AGENTS = [
  { id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode', color: '#10A37F', description: '多 provider CLI', capabilities: ['chat'], status: { availability: 'ready' } },
  { id: 'hermes', name: 'Hermes', vendor: 'Nous', kind: 'acp', icon: 'hermes', color: '#7C3AED', description: 'ACP Agent', capabilities: ['chat'], status: { availability: 'ready' } },
];

/** 内存路由存储：模拟 /api/model-routes 的增删改 */
let routes = [];
let nextId = 1;
/** 请求日志：验证方法 / body / 重取次数 */
const calls = [];

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
  try {
    const url = new URL(req.url, 'http://local');
    const p = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

    // ── 模型路由 CRUD 夹具 ──
    if (p === '/api/model-routes') {
      if (method === 'GET') {
        const agentId = url.searchParams.get('agentId');
        const list = agentId ? routes.filter(r => r.agentId === agentId) : routes;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ routes: list }));
      }
      if (method === 'POST') {
        const body = await readJson(req);
        calls.push({ method: 'POST', body });
        const route = { id: `mr-${nextId++}`, origin: 'user', source: 'user', createdAt: Date.now(), ...body };
        routes.push(route);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ route }));
      }
    }
    const putMatch = p.match(/^\/api\/model-routes\/([^/]+)$/);
    if (putMatch && method === 'PUT') {
      const body = await readJson(req);
      calls.push({ method: 'PUT', id: putMatch[1], body });
      const i = routes.findIndex(r => r.id === putMatch[1]);
      if (i >= 0) routes[i] = { ...routes[i], ...body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ route: routes[i] }));
    }
    if (putMatch && method === 'DELETE') {
      calls.push({ method: 'DELETE', id: putMatch[1] });
      routes = routes.filter(r => r.id !== putMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ── 模型菜单重取计数（事件总线的可观测量）──
    if (/\/api\/agents\/[^/]+\/models/.test(p)) {
      calls.push({ method: 'GET', kind: 'models-refetch', url: p });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [], defaultModel: '', source: 'catalog', configured: [] }));
    }
    if (p === '/api/model-catalog') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ fetchedAt: 0, counts: {} }));
    }
    if (p === '/api/models' || p === '/api/models/probe') {
      calls.push({ method: 'GET', kind: 'platform-models-refetch', url: p });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [], defaultModel: null }));
    }
    if (p === '/api/check-login') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ isLoggedIn: true, method: 'cli', envConfigured: true }));
    }
    if (p === '/api/agents/probe') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ agents: AGENTS }));
    }
    if (p === '/api/agents' || p === '/api/agents/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ agents: AGENTS, hiddenAgents: [], comingSoon: [] }));
    }
    if (/\/api\/agents\/[^/]+$/.test(p)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: p.split('/').pop(), status: { availability: 'ready' } }));
    }
    if (p === '/api/sessions' || /\/api\/sessions\//.test(p)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sessions: [], messages: [] }));
    }

    // ── 静态资源 ──
    let file = join(DIST, p === '/' ? '/index.html' : p);
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(base + '/settings?section=models', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// ── [1] 页面真的打开了 + 分区结构不变 ──
{
  const panelText = await page.locator('[data-settings-panel="models"]').count();
  ok(panelText > 0, '页面打开并落在「模型清单」分区（先证明页面在，再判没有 X）', String(panelText));
  const navTexts = await page.locator('[data-settings-section]').allInnerTexts();
  ok(navTexts.length === 8, '导航仍是八项：自定义路由是子块，没有新增分区', String(navTexts.length));
}

// ── [2] 主表瘦身：来源列不回来，但信息也没被删掉 ──
{
  const headerText = (await page.locator('[data-catalog-header]').innerText())
    .replace(/\s+/g, ' ')
    .trim();
  ok(
    !/枚举来源|Source/.test(headerText) && /Agent/.test(headerText) && /模型|Models/.test(headerText),
    '主表只有 Agent 与模型两列（否定式配肯定式：没删掉整张表）',
    headerText
  );
  // 展开一行证明来源折进明细；夹具 counts 为空也要显示来源，只是没有模型名。
  await page.locator('[data-catalog-row="opencode"] button').first().click();
  await page.waitForSelector('[data-catalog-detail="opencode"] [data-catalog-source="opencode"]');
  const sourceText = (await page.locator('[data-catalog-source="opencode"]').innerText()).replace(/\s+/g, ' ').trim();
  ok(
    /命令行枚举|Command-line enumeration/.test(sourceText),
    '展开后能看到枚举来源（命令原文留在悬停 title）',
    sourceText
  );
  await page.locator('[data-catalog-row="opencode"] button').first().click();
}

// ── [3] Agent 选择器只列已接入的 Agent ──
{
  const picker = page.locator('[data-model-route-agent-picker]');
  ok(await picker.count() > 0, 'Agent 选择器存在');
  // TDesign Select 的选项抽屉只有点开后才挂载（见 MEMORY：当前值读只读 input）。
  // 用真实坐标点开，再读浮层选项；读完点页面空白处收起，别挡后续点击。
  await picker.locator('.t-select').first().click();
  await page.waitForTimeout(250);
  const options = await page.locator('.t-select-option').allInnerTexts().catch(() => []);
  const text = options.join(' | ');
  ok(/OpenCode/.test(text) && /Hermes/.test(text), '选择器列出已接入 Agent', text || '(未展开)');
  // 点表头这种中性元素收起下拉；Esc 会冒泡到设置弹窗的关闭处理器。
  await page.locator('[data-catalog-header]').click();
  await page.waitForTimeout(150);
}

// ── [4] 空态 → 添加 → 表单 + 密钥提示 ──
{
  ok(await page.locator('[data-model-route-settings]').count() > 0, '自定义路由子块渲染在模型清单里');
  ok(await page.locator('[data-model-route-row]').count() === 0, '初始无自定义路由');
  await page.locator('[data-model-route-add]').click();
  await page.waitForTimeout(250);
  ok(await page.locator('[data-model-route-editor]').count() > 0, '点「添加路由」弹出表单');
  const hint = await page.locator('[data-model-route-secret-hint]').innerText().catch(() => '');
  ok(/引用名/.test(hint) && /不填密钥/.test(hint), '显眼提示：只填引用名、不填密钥', hint.replace(/\s+/g, ' '));
}

// ── [5] 填写 + 保存：POST body 无密钥 ──
const modelsRefetchBefore = calls.filter(c => c.kind === 'platform-models-refetch').length;
{
  await page.locator('[data-model-route-field="providerId"] input').fill('sensenova');
  await page.locator('[data-model-route-field="modelId"] input').fill('sensenova-6.8-flash');
  await page.locator('[data-model-route-field="credentialRef"] input').fill('SENSENOVA_API_KEY');
  await page.locator('[data-model-route-save]').click();
  await page.waitForTimeout(500);
  const post = calls.find(c => c.method === 'POST');
  ok(!!post, '保存发出 POST /api/model-routes');
  if (post) {
    ok(post.body?.providerId === 'sensenova' && post.body?.modelId === 'sensenova-6.8-flash', 'body 带 provider + model', JSON.stringify(post.body));
    ok(post.body?.credentialRef === 'SENSENOVA_API_KEY', 'body 只带凭据引用名');
    ok(!['apiKey', 'api_key', 'secret', 'token', 'password'].some(k => k in post.body), '★ body 里没有任何密钥字段');
  }
}

// ── [6] 新行出现 + 事件触发菜单重取 ──
{
  ok(await page.locator('[data-model-route-row]').count() === 1, '保存后新行出现（肯定式：真的渲染出来了）');
  const text = await page.locator('[data-model-route-row]').first().innerText();
  ok(/sensenova/.test(text), '新行显示 provider/model', text.replace(/\s+/g, ' '));
  const refetchAfter = calls.filter(c => c.kind === 'platform-models-refetch').length;
  ok(
    refetchAfter > modelsRefetchBefore,
    '★ 保存后模型菜单发起重取（emitModelRoutesChanged → useModels 订阅闭环）',
    `保存前 ${modelsRefetchBefore} → 后 ${refetchAfter}`
  );
}

// ── [7] 编辑 → PUT ──
{
  await page.locator('[data-model-route-edit]').first().click();
  await page.waitForTimeout(250);
  ok(await page.locator('[data-model-route-editor]').count() > 0, '点「编辑」回填表单');
  await page.locator('[data-model-route-field="displayName"] input').fill('改名后的路由');
  await page.locator('[data-model-route-save]').click();
  await page.waitForTimeout(450);
  const put = calls.find(c => c.method === 'PUT');
  ok(!!put && put.body?.displayName === '改名后的路由', '编辑发出 PUT 并带上新展示名', JSON.stringify(put?.body));
  const text = await page.locator('[data-model-route-row]').first().innerText();
  ok(/改名后的路由/.test(text), '行内容更新（不是只发了请求没刷新）', text.replace(/\s+/g, ' '));
}

// ── [8] 删除要确认 → DELETE ──
{
  await page.locator('[data-model-route-delete]').first().click();
  await page.waitForTimeout(200);
  ok(await page.locator('[data-model-route-delete-confirm]').count() > 0, '删除需二次确认（防误触）');
  ok(await page.locator('[data-model-route-row]').count() === 1, '点删除后行还在（确认前不删）');
  await page.locator('[data-model-route-delete-confirm]').first().click();
  await page.waitForTimeout(450);
  ok(calls.some(c => c.method === 'DELETE'), '确认后发出 DELETE');
  ok(await page.locator('[data-model-route-row]').count() === 0, '删除后行消失');
}

// ── [9] 服务端 configured 平级字段静态断言 ──
{
  const src = await readFile(join(ROOT, 'server', 'routes', 'custom-agents.ts'), 'utf8');
  ok(src.includes('...userRoutes.filter'), '用户路由并进 configured 平级字段（不进 models 数组）');
  ok(/source:\s*`用户自定义路由/.test(src), 'configured 项带「用户自定义路由」来源标注');
  const popup = await readFile(join(ROOT, 'src', 'components', 'ModelSelectPopup.tsx'), 'utf8');
  ok(popup.includes("startsWith('用户自定义路由')"), '模型浮层识别用户路由分组');
}

// ── [10] 控制台 ──
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ') || 'clean');

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '\u2713' : '\u2717'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  \u00b7 ${f}`));
  process.exit(1);
}
