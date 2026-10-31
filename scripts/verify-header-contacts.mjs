/**
 * 头部简化 + 通讯录改版 的 UI 验证。
 *
 * 覆盖两件事：
 *   1. 聊天头部（一对一 / 群聊）：52px 单行、无头像、无模型按钮，
 *      详情与删除收进「⋯」菜单（删除走两步确认）；
 *   2. 通讯录：QQ 式版式 —— 搜索胶囊 + 圆钮 + Tab（Agent / 群聊），
 *      没有「通讯录」大标题，也没有好友管理器 / 新朋友 / 新群聊。
 *
 * 全部离线：静态服务器托管 dist/ + Playwright 拦 /api/** 喂夹具。
 * 运行：node scripts/verify-header-contacts.mjs（需先 npm run build）
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
// permissionSupport 必须带：ChatPage 的权限缺口提示靠它算，缺了会静默不显示。
const AGENTS = [
  // gemini 故意排在最前且不可用：通讯录按「在线的排最上面」排序，
  // 它必须在列表末尾 —— 顺序断言才有意义（见 [3] 的顺序检查）。
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3186FF', description: '多模态与大规模检索', capabilities: ['chat', 'search', 'image'], status: { availability: 'needs-auth', version: '0.9.2', message: '请先完成登录授权' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat', 'code', 'tools'], status: { availability: 'ready', version: '2.4.1' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: '擅长长上下文重构与代码审查', capabilities: ['chat', 'code', 'write'], status: { availability: 'ready', version: '1.0.44' }, permissionSupport: { enforced: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] } },
  { id: 'cursor', name: 'Cursor Agent', vendor: 'Anysphere', kind: 'acp', icon: 'cursor', color: '#43413C', description: '编辑器内联协作', capabilities: ['chat', 'code', 'write', 'tools'], status: { availability: 'ready', version: '0.42.0' }, permissionSupport: { enforced: ['default'] } },
];
/**
 * A68 用的夹具：带产品族元数据的一份名册。
 *
 * 刻意做成「一个同族两条 + 两个单条」：
 *   - Kimi 族两条、账号不同 → 必须成组，且资料页要说「额度不互通」；
 *   - Google / OpenCode 各一条 → **不成组**（单条目画标题只会把名单撑成目录树）；
 *   - OpenCode 的 region 是 `any` → **不画角标**（满屏角标等于没有重点）。
 * 老夹具 AGENTS 没有这些字段，用于验证「老后端下优雅降级」。
 */
const AGENTS_WITH_FAMILY = [
  {
    id: 'kimicode', name: 'Kimi', vendor: 'Moonshot', kind: 'http', icon: 'kimicode', color: '#0F0F0F',
    description: '开放平台 API', capabilities: ['chat'],
    family: 'kimi', familyName: 'Kimi', surface: 'http', region: 'cn', regionName: '中国站',
    authScope: 'kimi-open-platform', authScopeName: 'Kimi 开放平台 API Key',
    endpointHosts: ['api.moonshot.cn'],
    // 双向 peers：真实后端由 registry 按 family 反查生成，两边都会有；
    // 夹具必须照这个形状写，否则「跳过去之后回不去」测不出来。
    familyPeers: [{ id: 'kimicli', name: 'Kimi Code CLI', authScope: 'kimi-code-cn', regionName: '中国站' }],
    status: { availability: 'ready', version: '1.0.0' },
  },
  {
    id: 'kimicli', name: 'Kimi Code CLI', vendor: 'Moonshot', kind: 'cli', icon: 'kimicode', color: '#0F0F0F',
    description: 'Kimi Code 命令行', capabilities: ['chat', 'code', 'tools'],
    family: 'kimi', familyName: 'Kimi', surface: 'cli', region: 'cn', regionName: '中国站',
    authScope: 'kimi-code-cn', authScopeName: 'Kimi Code 账号',
    familyPeers: [{ id: 'kimicode', name: 'Kimi', authScope: 'kimi-open-platform', regionName: '中国站' }],
    status: { availability: 'ready', version: '2.3.0' },
  },
  {
    id: 'gemini', name: 'Gemini', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3186FF',
    description: '多模态', capabilities: ['chat', 'search'],
    family: 'google', familyName: 'Google', surface: 'cli', region: 'intl', regionName: '国际站',
    authScope: 'google', authScopeName: 'Google 账号',
    status: { availability: 'needs-auth', version: '0.9.2', message: '请先完成登录授权' },
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'SST', kind: 'cli', icon: 'opencode', color: '#1F1F1F',
    description: '跟随 provider', capabilities: ['chat', 'code'],
    family: 'opencode', familyName: 'OpenCode', surface: 'cli', region: 'any', regionName: '跟随模型 provider',
    authScope: 'none', authScopeName: '无自有账号',
    status: { availability: 'ready', version: '0.9.0' },
  },
];

/**
 * 「获取」夹具（A71）。
 *
 * 五条各守一种形态，故意把**边界情形**都放进来：
 *   - codex  npm + 本机没 Node → 要出现复制按钮**和**「命令会失败」的警告
 *   - antigravity  script → 主按钮是打开安装页，复制是次按钮
 *   - zcode  installer 且**没有 url** → 一个按钮都不该有（宁缺勿假）
 *   - doubao  key + needs-auth → 必须出现「填写 API Key」（这一类靠的是 needs-auth）
 *   - gemini  cli + needs-auth + 有 install 元数据 → **必须不出现**获取卡片（反例）
 *
 * 最后一条是关键：没有它的话，「needs-auth 不出现下载按钮」这条规则就没人守着，
 * 而它一崩，用户会被引去重装一个已经装好的东西。
 */
const AGENTS_FOR_INSTALL = [
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    kind: 'cli',
    icon: 'codex',
    color: '#0F0F0F',
    description: 'OpenAI 命令行',
    capabilities: ['chat', 'code'],
    install: {
      method: 'npm',
      pkg: '@openai/codex',
      command: 'npm i -g @openai/codex',
      url: 'https://github.com/openai/codex',
      requires: 'node',
      note: '装完运行 codex login 登录',
      checkedAt: '2026-10-22',
      checkedFrom: 'npm registry 实查',
    },
    installEnv: { node: { ok: false } },
    status: {
      availability: 'not-installed',
      installed: false,
      message: 'PATH 中未找到命令 `codex`',
      probedAt: new Date().toISOString(),
    },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    kind: 'cli',
    icon: 'antigravity',
    color: '#4285F4',
    description: 'Google 终端 Agent',
    capabilities: ['chat', 'code'],
    install: {
      method: 'script',
      command: 'irm https://antigravity.google/cli/install.ps1 | iex',
      url: 'https://antigravity.google/docs/getting-started?tab=cli',
      requires: 'powershell',
      note: '装完先交互运行一次 agy 完成 Google 登录',
      checkedAt: '2026-10-22',
      checkedFrom: '官方文档实读',
    },
    installEnv: { powershell: { ok: true } },
    status: {
      availability: 'not-installed',
      installed: false,
      message: 'PATH 中未找到命令 `agy`',
      probedAt: new Date().toISOString(),
    },
  },
  {
    id: 'zcode',
    name: 'ZCode',
    vendor: '智谱',
    kind: 'cli',
    icon: 'zcode',
    color: '#0F0F0F',
    description: 'GLM 桌面版引擎',
    capabilities: ['chat', 'code'],
    install: {
      method: 'installer',
      requires: 'none',
      note: '随 ZCode 桌面版分发，没有命令行安装方式；装完把引擎软链到 PATH',
      checkedAt: '2026-10-22',
      checkedFrom: '未找到可核实的独立下载页',
    },
    status: {
      availability: 'not-installed',
      installed: false,
      message: 'PATH 中未找到命令 `zcode`',
      probedAt: new Date().toISOString(),
    },
  },
  {
    id: 'doubao',
    name: '豆包',
    vendor: '字节跳动',
    kind: 'http',
    icon: 'doubao',
    color: '#1E6FFF',
    description: '火山方舟 API',
    capabilities: ['chat'],
    install: {
      method: 'key',
      requires: 'none',
      note: '不需要安装：只缺 ARK_API_KEY（火山方舟控制台获取）',
      checkedAt: '2026-10-22',
      checkedFrom: '后端只需 ARK_API_KEY',
    },
    status: {
      availability: 'needs-auth',
      installed: false,
      message: '未配置 ARK_API_KEY',
      probedAt: new Date().toISOString(),
    },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    kind: 'cli',
    icon: 'gemini',
    color: '#3186FF',
    description: '多模态',
    capabilities: ['chat', 'search'],
    install: {
      method: 'npm',
      pkg: '@google/gemini-cli',
      command: 'npm i -g @google/gemini-cli',
      url: 'https://github.com/google-gemini/gemini-cli',
      requires: 'node',
      note: '装完设置 GEMINI_API_KEY',
      checkedAt: '2026-10-22',
      checkedFrom: 'npm registry 实查',
    },
    status: {
      availability: 'needs-auth',
      installed: true,
      version: '0.65.0',
      message: '请先完成登录授权',
      probedAt: new Date().toISOString(),
    },
  },
];

/** 当前生效的名册夹具：默认用老夹具（无产品族字段），[3c] 段会换成带字段的那份 */
let CURRENT_AGENTS = AGENTS;

const MODELS = [  { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '均衡，日常首选' },
  { modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1', description: '最强推理' },
];
// agent_ids 在 DB 里是 JSON 字符串（useSessions.parseAgentIds 只认字符串）
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'claude-sonnet-4-5', kind: 'direct', agent_ids: null, orchestration: null, created_at: new Date().toISOString() },
  { id: 'g1', title: '', agent_id: null, model: null, kind: 'group', agent_ids: JSON.stringify(['workbuddy', 'claude']), orchestration: 'dispatch', created_at: new Date(Date.now() - 36e5).toISOString() },
];
const MESSAGES = [
  { id: 'm1', session_id: 's1', role: 'user', content: '帮我确认一下品牌色', created_at: new Date(Date.now() - 6e4).toISOString() },
  { id: 'm2', session_id: 's1', role: 'assistant', content: '确实有两套品牌蓝。', model: 'claude-sonnet-4-5', author_agent_id: 'workbuddy', created_at: new Date().toISOString() },
  { id: 'm3', session_id: 'g1', role: 'user', content: '拉个群', created_at: new Date(Date.now() - 18e5).toISOString() },
  { id: 'm4', session_id: 'g1', role: 'assistant', content: '好。', model: 'claude-sonnet-4-5', author_agent_id: 'claude', created_at: new Date(Date.now() - 17e5).toISOString() },
];

const failures = [];
const checks = { total: 0 };
/** 记录 POST /api/agents/probe 的次数（[3f] 断言「重新检测」真的发请求） */
let PROBE_HITS = 0;
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/chat')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (url.includes('/api/agents/probe')) {
    PROBE_HITS++;
    return json({ agents: CURRENT_AGENTS });
  }
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: CURRENT_AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    return json({ session: SESSIONS.find(s => s.id === id) ?? SESSIONS[0], messages: MESSAGES.filter(m => m.session_id === id) });
  }
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
}

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

// ============= [1] 聊天头部（一对一）=============
console.log('\n[1] 一对一聊天头部：52px 单行 / 无 logo / ⋯ 菜单');
await go('/chat/s1');

const header = page.locator('main header').first();
ok((await header.count()) === 1, '会话头部存在');
const headerBox = await header.boundingBox();
ok(!!headerBox && headerBox.height >= 46 && headerBox.height <= 58, '头部高度压到约 52px', headerBox ? `h=${Math.round(headerBox.height)}` : '无 box');
ok((await header.locator('img').count()) === 0, '头部没有头像/logo（不要 logo）');
ok((await header.getByTitle('切换模型').count()) === 0, '头部没有模型选择按钮（已移到输入框底部）');
ok((await header.getByText('WorkBuddy', { exact: true }).count()) >= 1, '标题是 Agent 名');
ok((await header.getByText('在线', { exact: false }).count()) >= 1, '状态在位（· 在线）');
ok((await page.locator('[data-chat-more] summary').count()) === 1, '有「⋯」更多按钮');

// ⋯ 菜单：恰好两项
await page.locator('[data-chat-more] summary').click();
await page.waitForTimeout(250);
const menuItems = page.locator('[data-chat-more] .absolute button');
ok((await menuItems.count()) === 2, '菜单里恰好两项（详情 / 删除）', `count=${await menuItems.count()}`);
ok((await menuItems.nth(0).innerText()).includes('详情'), '第一项是详情');
ok((await menuItems.nth(1).innerText()).includes('删除'), '第二项是删除');
await shot('verify-header-more');

// 详情 → 弹窗（不再撑高头部），菜单收起
await menuItems.nth(0).click();
await page.waitForTimeout(300);
const detail = page.getByRole('dialog');
ok((await detail.count()) === 1, 'Agent 详情以弹窗呈现');
ok((await detail.getByText('擅长领域', { exact: false }).count()) === 1, '弹窗里有擅长领域');
ok((await detail.getByText('接入方式', { exact: false }).count()) === 1, '弹窗里有接入方式');
ok(!(await page.locator('[data-chat-more][open]').count()), '点完菜单项后菜单收起');
{
  // 详情从「抽屉」改成「弹窗」的核心收益：头部高度不再被撑开，
  // 背后的消息区也不会被推走。这条断言就是守这件事。
  const hb = await header.boundingBox();
  ok(!!hb && hb.height >= 46 && hb.height <= 58, '弹窗打开时头部高度不变（没有被撑高）', hb ? `h=${Math.round(hb.height)}` : '无 box');
}
await shot('verify-header-detail');

// 点空白处 → 弹窗消失。
// 坐标选在窗口右侧的消息区（1400,450）：弹窗最宽 440px 且居中，
// 这里一定落在遮罩本身；避开左侧导航条与列表，免得关闭瞬间的
// mouseup 误触一次导航。
await page.mouse.click(1400, 450);
await page.waitForTimeout(250);
ok((await page.getByRole('dialog').count()) === 0, '点空白处弹窗消失');
ok((await header.boundingBox())?.height <= 58, '关闭后头部仍是 52px');

// 删除 → 两步确认（ConfirmDialog），取消不删
await page.locator('[data-chat-more] summary').click();
await page.waitForTimeout(200);
await page.locator('[data-chat-more] .absolute button').nth(1).click();
await page.waitForTimeout(250);
const dialog = page.getByRole('dialog');
ok((await dialog.count()) === 1, '删除弹两步确认框');
ok((await dialog.getByText('不可恢复', { exact: false }).count()) >= 1, '确认框说明后果');
await dialog.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(200);
ok((await page.getByRole('dialog').count()) === 0, '取消后确认框关闭');
ok(page.url().endsWith('/chat/s1'), '取消后还在原会话（没被删）');

// 模型选择仍在输入框底部（回归：从头显移除，不能整个丢掉）
//
// A74：原来这里数的是 `.t-select input.t-input__inner` 的 value —— A73 把模型
// 选择器从 TDesign Select 换成自绘触发器（`[data-model-trigger]`）之后，这条
// 断言就再也拿不到模型名了（它量的是另外两颗下拉）。按「断言用 data-* 钩子」
// 的约定改成直接读触发器的可见文字，断言的**意图**不变：
// 「模型选择还在输入框底部，而且显示的是当前模型」。
{
  const trigger = page.locator('[slot="footer-prefix"] [data-model-trigger]');
  const n = await trigger.count();
  const text = n > 0 ? (await trigger.first().innerText()).trim() : '';
  ok(n === 1, '输入框底部仍能选模型（触发器在位）', `count=${n}`);
  ok(text.includes('Claude Sonnet 4.5'), '触发器上显示的是当前模型', `text=${text || '(空)'}`);
}

// ============= [2] 群聊头部 ==============
console.log('\n[2] 群聊头部：同一 compact 规格');
await go('/chat/g1');
const gHeader = page.locator('main header').first();
const gBox = await gHeader.boundingBox();
ok(!!gBox && gBox.height >= 46 && gBox.height <= 58, '群聊头部同样约 52px', gBox ? `h=${Math.round(gBox.height)}` : '无 box');
ok((await gHeader.locator('img').count()) >= 2, '成员头像堆叠在位（群聊的识别信息）');
// 人数直接跟在群名后面（QQ 的「群名（N）」），在线数单独一个徽标
{
  const text = await gHeader.innerText();
  ok(text.includes('（2）'), '群名后带人数「（2）」', text.replace(/\n/g, ' ').slice(0, 60));
  ok(text.includes('2 在线'), '在线人数徽标在位', text.replace(/\n/g, ' ').slice(0, 60));
}
// 编排模式选择器：当前模式标签（如「分派」）显示在头部操作区。
// 注意：不要在全头部用 getByText('分派') —— 关闭的 ModePicker 下拉里也含
// 当前模式的标签文字，会多匹配一次。改为定位 ModePicker 的 summary。
const modePicker = gHeader.locator('[title="切换编排模式"]');
ok((await modePicker.count()) === 1, '编排模式选择在位');
ok((await modePicker.innerText()).includes('分派'), '编排模式显示当前模式：分派');
ok((await page.locator('[data-chat-more]').count()) === 1, '群聊设置收进右上角「⋯」');
await shot('verify-group-header');

// ============= [3] 通讯录（QQ 式）=============
console.log('\n[3] 通讯录：搜索胶囊 + Tab + 分区列表');
await go('/');
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(1200);

ok((await page.getByRole('heading', { name: '通讯录' }).count()) === 0, '没有「通讯录」大标题（QQ 式无标题）');
ok((await page.getByText('好友管理器').count()) === 0, '没有「好友管理器」行');
ok((await page.getByText('新朋友', { exact: true }).count()) === 0, '没有「新朋友」行');
ok((await page.getByText('新群聊', { exact: true }).count()) === 0, '没有「新群聊」行');

// 搜索胶囊：存在 + 全圆角
const search = page.getByPlaceholder('搜索 AGENT、群聊');
ok((await search.count()) === 1, '有顶部搜索框');
{
  const radius = await search.evaluate(el => {
    const pill = el.closest('div');
    return pill ? getComputedStyle(pill).borderRadius : '';
  });
  ok(radius === '9999px', '搜索框是全圆胶囊', String(radius));
}
// 右侧只有一个「+」，探测与建群都收进它的菜单（QQ 的做法）
ok((await page.getByRole('button', { name: '添加', exact: true }).count()) === 1, '搜索框右侧有「+」添加按钮');
await page.getByRole('button', { name: '添加', exact: true }).click();
await page.waitForTimeout(200);
ok((await page.getByRole('button', { name: '重新探测' }).count()) === 1, '「+」菜单里有重新探测');
ok((await page.getByRole('button', { name: '发起群聊' }).count()) === 1, '「+」菜单里有发起群聊');
await page.getByRole('button', { name: '添加', exact: true }).click();
await page.waitForTimeout(200);

// Tab：两个，激活项品牌色下划线
const tabs = page.getByRole('tab');
ok((await tabs.count()) === 2, '恰好两个 Tab（AGENT / 群聊）', `count=${await tabs.count()}`);
{
  const styles = await tabs.evaluateAll(els =>
    els.map(el => ({
      text: el.textContent.trim(),
      color: getComputedStyle(el).color,
      border: getComputedStyle(el).borderBottomColor,
      width: getComputedStyle(el).borderBottomWidth,
    }))
  );
  const [a, g] = styles;
  ok(a.text === 'AGENT' && g.text === '群聊', 'Tab 文案（A72：联系人 → AGENT）', styles.map(s => s.text).join(' | '));
  ok(a.border !== 'rgba(0, 0, 0, 0)' && a.width === '2px', '激活 Tab 有品牌色下划线', `${a.border} ${a.width}`);
  ok(g.border === 'rgba(0, 0, 0, 0)', '未激活 Tab 下划线透明');
  ok(a.color !== g.color, '激活/未激活文字颜色有区分');
}

// 联系人列表：**不再分段**（在线 / 待处理 / 未接入），改成一整条平铺名单，
// 在线的排最上面。状态信息没有丢 —— **每一行行尾都有状态词**（A134 起，
// 原先只写不可用的行，于是「三个 Agent 只有绿点」读不出状态），头像角上还有圆点。
for (const title of ['在线', '待处理', '未接入']) {
  ok((await page.getByRole('heading', { name: title, exact: true }).count()) === 0, `没有「${title}」分段标题`);
}
{
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.tc-list-item')].map(el => el.innerText.replace(/\n/g, ' ').trim())
  );
  ok(rows.length === 4, '四个 Agent 都在同一条名单里', `rows=${rows.length}`);
  // 夹具里 Gemini CLI（未登录）排在最前，排序后必须落到末尾
  ok(/^WorkBuddy/.test(rows[0] ?? ''), '第一个是在线的 WorkBuddy（在线优先）', rows[0]?.slice(0, 24));
  ok(/Gemini CLI/.test(rows[rows.length - 1] ?? ''), '不可用的 Gemini CLI 被排到最末', rows[rows.length - 1]?.slice(0, 24));
  ok(rows[rows.length - 1]?.includes('未登录'), '不可用的行尾标出状态文字（不是只剩颜色）', rows[rows.length - 1]);
  // A134：在线行也必须有词 —— 这条是审查报告 P0-3 的正面证据
  ok(rows[0]?.includes('在线'), '在线行同样有状态文字（不再只有一颗绿点）', rows[0]);
  const withWord = rows.filter(r => /在线|未登录|需修复|网络不通|未安装|不可用|未探测|缺 Key/.test(r)).length;
  ok(withWord === rows.length, '每一行都带状态词（同一列表只有一种表达方式）', `${withWord}/${rows.length}`);
}
await shot('verify-contacts');

// ============= [3b] 资料页：没有页标题，只有返回键（A23 用户要求）=============
console.log('\n[3b] 通讯录资料页：去掉「详细资料」标题、资料区上提');
{
  await page.locator('button[title^="查看 "]').first().click();
  await page.waitForTimeout(500);

  ok((await page.getByText('详细资料', { exact: true }).count()) === 0, '页头不再有「详细资料」文案');
  const back = page.locator('[data-detail-back]');
  ok((await back.count()) === 1, '返回键保留');
  ok((await back.getAttribute('aria-label')) === '返回通讯录', '返回键的语义没丢', String(await back.getAttribute('aria-label')));

  const geo = await page.evaluate(() => {
    const bar = document.querySelector('[data-detail-back]')?.parentElement;
    const name = document.querySelector('main h2');
    const scroller = document.querySelector('main [class*="overflow-y-auto"]');
    return {
      barH: bar ? bar.getBoundingClientRect().height : 0,
      nameTop: name ? name.getBoundingClientRect().top : 0,
      padTop: scroller ? parseFloat(getComputedStyle(scroller.firstElementChild).paddingTop) : -1,
    };
  });
  // 早先是一条 88px 的 PanelHeader；现在只剩返回键的窄条
  ok(geo.barH > 0 && geo.barH <= 56, '页头收窄成一条（不再是 88px 的标题栏）', `${Math.round(geo.barH)}px`);
  ok(geo.padTop >= 0 && geo.padTop <= 16, '资料区内边距收紧，内容整体上提', `pt=${geo.padTop}px`);
  // 早先：标题栏 40 + PanelHeader 88 + py-8 32 + 头像 80 + mt-4 16 ≈ 256
  // 现在：标题栏 40 + 窄条 52 + pt-3 12 + 头像 80 + mt-4 16 ≈ 200
  ok(geo.nameTop > 0 && geo.nameTop < 215, '大头像/名字确实提上来了', `name.top=${Math.round(geo.nameTop)}（原 ≈256）`);

  await shot('verify-agent-detail');
  await back.click();
  await page.waitForTimeout(400);
  ok((await page.locator('[data-detail-back]').count()) === 0, '点返回键回到通讯录列表');
}

// 群聊 Tab：已有群聊目录
await page.getByRole('tab', { name: '群聊' }).click();
await page.waitForTimeout(300);
ok(
  (await page.getByRole('heading', { name: '我的群聊' }).count()) === 0,
  '群聊目录没有「我的群聊」分类标题（2026-10-18 用户要求去掉）'
);
ok((await page.getByText('WorkBuddy、Claude Code', { exact: false }).count()) === 1, '群聊行标题 = 成员名拼接（会话没起名时）');
ok((await page.getByText('2 人', { exact: false }).count()) === 1, '群聊行显示人数');
await shot('verify-contacts-groups');

// 点群聊行 → 打开会话
await page.getByText('WorkBuddy、Claude Code', { exact: false }).first().click();
await page.waitForTimeout(400);
ok(page.url().endsWith('/chat/g1'), '点群聊行进入该群聊', page.url());

// 回到通讯录，点 + → 菜单 → 发起群聊 → 打开**与会话栏同一个**建群弹窗
// （A48：用户要求两处入口统一成同一个新窗口逻辑，通讯录不再有内联多选态）
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: '添加', exact: true }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: '发起群聊' }).click();
await page.waitForTimeout(400);
ok((await page.locator('[data-new-group-dialog]').count()) === 1, '「发起群聊」打开建群弹窗（不再是内联多选）');
ok((await page.getByRole('button', { name: '取消多选' }).count()) === 0, '「+」不再变成 X（没有多选态）');
ok((await page.getByText('点击选择', { exact: false }).count()) === 0, '列表不再出现「点击选择」的分区说明');

// 勾一个 → 弹窗右栏计数为 1
await page.locator('[data-new-group-agent]').first().click();
await page.waitForTimeout(250);
{
  const t = await page.locator('[data-new-group-dialog]').innerText();
  ok(/已选择\s*1\s*个 AGENT/.test(t), '弹窗里勾选后计数为 1', t.split('\n').find(l => l.includes('已选择')) ?? '');
}
await shot('verify-contacts-newgroup');

// 取消 → 弹窗关闭，通讯录回到普通列表
await page.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(300);
ok((await page.locator('[data-new-group-dialog]').count()) === 0, '点「取消」关闭弹窗');
ok((await page.getByRole('button', { name: '添加', exact: true }).count()) === 1, '关闭后回到普通通讯录（+ 仍是「添加」）');
ok(
  (await page.getByRole('heading', { name: '我的群聊' }).count()) === 0,
  '群聊目录始终没有「我的群聊」分类标题'
);

// ============= [3c] 产品族分组 + 区域角标 + 身份小节（A68）=============
console.log('\n[3c] 同族分组 + 区域角标 + 身份小节');
CURRENT_AGENTS = AGENTS_WITH_FAMILY;
await go('/');
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(1200);
{
  // 只有 Kimi 同族两条 → 只有它成组
  ok((await page.locator('[data-family-group="kimi"]').count()) === 1, '同族两条的 Kimi 成组');
  ok(
    (await page.locator('[data-family-group="google"]').count()) === 0,
    '单条目族不成组（不画只有一行的标题）'
  );
  const groupText = await page.locator('[data-family-group="kimi"]').innerText();
  ok(groupText.includes('Kimi'), '组标题显示官方族名', groupText.replace(/\n/g, ' ').slice(0, 30));
  ok(groupText.includes('Kimi Code CLI'), '组内成员默认展开可见（不用先点开）');

  // 区域信息只留在资料页「身份」小节；列表行不再画 CN / INTL 角标
  const badges = await page.evaluate(() => document.querySelectorAll('[data-region-badge]').length);
  ok(badges === 0, '列表行不再显示区域角标（CN / INTL）', `实际 ${badges} 个`);

  // 折叠 / 展开
  await page.locator('[data-family-group="kimi"] button').first().click();
  await page.waitForTimeout(250);
  const collapsed = await page.evaluate(() => document.querySelectorAll('.tc-list-item').length);
  ok(collapsed === 2, '收起后组内两行隐藏（只剩两条单条目）', `rows=${collapsed}`);
  await page.locator('[data-family-group="kimi"] button').first().click();
  await page.waitForTimeout(250);
  const expanded = await page.evaluate(() => document.querySelectorAll('.tc-list-item').length);
  ok(expanded === 4, '再点展开回来', `rows=${expanded}`);
}

// 资料页「身份」小节：同族不同账号必须明说「额度不互通」
{
  await page.getByText('Kimi Code CLI', { exact: true }).first().click();
  await page.waitForTimeout(700);
  ok((await page.locator('[data-agent-identity]').count()) === 1, '资料页有「身份」小节');
  const idText = await page.locator('[data-agent-identity]').innerText();
  ok(idText.includes('Kimi'), '身份小节显示产品族', idText.replace(/\n/g, ' ').slice(0, 50));
  ok(idText.includes('中国站'), '身份小节显示区域（厂商官方口径）', idText.replace(/\n/g, ' ').slice(0, 60));
  ok(idText.includes('Kimi Code 账号'), '身份小节显示账号体系的官方叫法');
  ok(/额度不互通/.test(idText), '同族不同账号时明确写「额度不互通」', idText.replace(/\n/g, ' ').slice(0, 90));

  // 同族互跳：点对方名字直接切过去（A68 P1 最后一条）
  ok((await page.locator('[data-family-jump="kimicode"]').count()) === 1, '同族名字可点（跳转入口存在）');
  await page.locator('[data-family-jump="kimicode"]').click();
  await page.waitForTimeout(600);
  ok(
    (await page.locator('[data-family-jump="kimicli"]').count()) === 1,
    '点同族名字切到了另一条资料（对侧反向出现）'
  );
  const jumpedText = await page.locator('[data-agent-identity]').innerText();
  ok(
    jumpedText.includes('Kimi 开放平台 API Key'),
    '跳过去的是 Kimi（HTTP 条目），不是原地刷新',
    jumpedText.replace(/\n/g, ' ').slice(0, 70)
  );
}
await shot('verify-contacts-family');

// ============= [3d] 同族**同账号**：必须说「共用额度」（A68）=============
// 反例覆盖：[3c] 只测了 Kimi（同厂不同账号 → 额度不互通）。
// Google 是另一种关系：Gemini 与 Antigravity 同厂、**同账号**、同区域，
// 只是产品形态/代际不同。文案必须跟着反过来，否则会把「一份额度」说成「两份」。
console.log('\n[3d] 同族同账号（Google 代际）');
const GEMINI_PAIR = [
  {
    id: 'gemini', name: 'Gemini', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3186FF',
    description: '多模态', capabilities: ['chat'],
    family: 'google', familyName: 'Google', surface: 'cli', region: 'intl', regionName: '国际站',
    authScope: 'google', authScopeName: 'Google 账号',
    familyPeers: [{ id: 'antigravity', name: 'Antigravity CLI', authScope: 'google' }],
    status: { availability: 'ready', version: '0.9.2' },
  },
  {
    id: 'antigravity', name: 'Antigravity CLI', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#3186FF',
    description: '智能体优先的编码工具', capabilities: ['code'],
    family: 'google', familyName: 'Google', surface: 'cli', region: 'intl', regionName: '国际站',
    authScope: 'google', authScopeName: 'Google 账号',
    familyPeers: [{ id: 'gemini', name: 'Gemini', authScope: 'google' }],
    status: { availability: 'ready', version: '1.0.0' },
  },
];
CURRENT_AGENTS = GEMINI_PAIR;
await go('/');
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(1200);
{
  ok((await page.locator('[data-family-group="google"]').count()) === 1, 'Google 两条成组');
  const g = await page.locator('[data-family-group="google"]').innerText();
  ok(g.includes('Antigravity CLI'), '组标题下的两个成员都在', g.replace(/\n/g, ' ').slice(0, 40));

  await page.getByText('Antigravity CLI', { exact: true }).first().click();
  await page.waitForTimeout(700);
  const t = await page.locator('[data-agent-identity]').innerText();
  ok(/共用同一账号/.test(t), '同账号时写「共用同一账号（额度同池）」', t.replace(/\n/g, ' ').slice(0, 90));
  ok(!/不互通/.test(t), '同账号时**不能**说「不互通」（否则把一份额度说成两份）');
  ok(t.includes('Gemini'), '点名对方是谁', t.replace(/\n/g, ' ').slice(0, 70));
}
await shot('verify-contacts-family-google');

// ============= [3e] 同厂其他版本 + 上次请求（A69 / PLAN P2 + P1 剩余）=============
// 这一段的夹具是**受控**的：本机装没装 Qoder CN / 国际版不影响结论，
// 因为探测逻辑本身由 verify:family-hints 用临时 home 单独验过。
// 这里只验「后端给了这些字段时，界面有没有如实、完整地显示」。
console.log('\n[3e] 同厂其他版本（未接入）+ 上次请求');
const HINTS_FIXTURE = [
  {
    id: 'qoder', name: 'Qoder', vendor: 'Qoder', kind: 'cli', icon: 'qoder', color: '#6B4EFF',
    description: '国际版 CLI', capabilities: ['code'],
    family: 'qoder', familyName: 'Qoder', surface: 'cli', region: 'intl', regionName: '国际版',
    authScope: 'qoder.com', authScopeName: 'Qoder 账号',
    localSiblings: [
      {
        id: 'qoder-cn', name: 'Qoder CN', regionName: '国内版',
        detectedPath: 'C:\\Users\\me\\.qoder-cn',
        evidence: '检测到桌面端；~/.qoder-cn/bin 下没有 qodercli（只有 qoder-cn-computer-use）',
        blockedBy: '这个版本只提供桌面端，没有 headless 命令行入口',
      },
    ],
    status: { availability: 'ready', version: '1.2.3' },
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0052D9',
    description: '腾讯的编码 Agent', capabilities: ['chat', 'code'],
    family: 'tencent-workbuddy', familyName: 'WorkBuddy', surface: 'sdk', region: 'cn', regionName: '国内版',
    authScope: 'tencent-cloud-cn', authScopeName: '腾讯云账号',
    localSiblings: [
      {
        id: 'workbuddy-intl', name: 'WorkBuddy AI', regionName: '国际版',
        detectedPath: 'C:\\Users\\me\\.workbuddy-ai',
        evidence: 'productName=WorkBuddy AI，networkEnvironment=external，endpoint=https://www.workbuddy.ai',
        blockedBy: '国际站是独立账号体系，需要另备一份凭据（一个子进程只能持一份）',
        nextStep: '准备一份国际站凭据后，可用独立的 CODEBUDDY_CONFIG_DIR + CODEBUDDY_BASE_URL 起第二条目',
      },
    ],
    status: { availability: 'ready', version: '5.7.7' },
  },
  {
    id: 'zcode', name: 'ZCode', vendor: '智谱 (Z.AI)', kind: 'cli', icon: 'zcode', color: '#534AB7',
    description: '智谱 GLM 官方 CLI', capabilities: ['code'],
    family: 'zhipu-glm', familyName: '智谱 GLM', surface: 'cli', region: 'any', regionName: '登录时选择',
    authScope: 'bigmodel-or-zai', authScopeName: 'BigModel 或 Z.ai 账号',
    lastRequest: {
      account: 'zai', accountLabel: 'Z.ai 套餐', model: 'GLM-5.3-Flash',
      at: new Date(Date.now() - 3 * 60_000).toISOString(),
      source: '~/.zcode/cli/db 的使用记录（上次实际请求，不是当前设置）',
    },
    status: { availability: 'ready', version: '0.14.5' },
  },
];
CURRENT_AGENTS = HINTS_FIXTURE;
await go('/');
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(1200);
{
  // ── Qoder CN：只卡死，没有下一步 ──
  await page.getByText('Qoder', { exact: true }).first().click();
  await page.waitForTimeout(700);
  ok((await page.locator('[data-local-siblings]').count()) === 1, '资料页出现「其他版本」区块');
  ok((await page.locator('[data-local-sibling="qoder-cn"]').count()) === 1, '列出的是 Qoder CN');
  const qoderBlock = await page.locator('[data-local-sibling="qoder-cn"]').innerText();
  ok(/国内版/.test(qoderBlock), '版本用厂商官方口径（国内版）', qoderBlock.replace(/\n/g, ' ').slice(0, 40));
  ok(/\.qoder-cn/.test(qoderBlock), '给出探测到的真实路径（用户能自己去看）');
  ok(/未接入/.test(qoderBlock), '明确写「未接入」，不含糊成「可用」');
  ok(/没有 headless/.test(qoderBlock), '说清具体原因，不是一句「不支持」', qoderBlock.replace(/\n/g, ' ').slice(0, 80));
  ok((await page.locator('[data-local-sibling="qoder-cn"] [data-sibling-next-step]').count()) === 0, '卡死时不给下一步（不画空头支票）');
  await shot('verify-contacts-hints-qoder');

  // ── WorkBuddy 国际版：缺什么 + 有了之后怎么做，两行都要有 ──
  await page.locator('[data-detail-back]').click();
  await page.waitForTimeout(500);
  await page.getByText('WorkBuddy', { exact: true }).first().click();
  await page.waitForTimeout(700);
  const wbBlock = await page.locator('[data-local-sibling="workbuddy-intl"]').innerText();
  ok(/国际版/.test(wbBlock), 'WorkBuddy 那条写「国际版」', wbBlock.replace(/\n/g, ' ').slice(0, 50));
  ok(/networkEnvironment=external/.test(wbBlock), '把判定依据（external）摆出来，不是空口说国际版');
  ok(/另备一份凭据/.test(wbBlock), '说清缺什么（第二份凭据）');
  ok(
    (await page.locator('[data-local-sibling="workbuddy-intl"] [data-sibling-next-step]').count()) === 1,
    '**同时**给出条件满足后怎么做（两层信息都要有，别只报问题）'
  );
  ok(/CODEBUDDY_CONFIG_DIR/.test(wbBlock), '下一步是具体命令/环境变量，不是「请自行配置」');
  // 断言要**限定在这个区块内**：通讯录栏头的「+ 添加」是合法按钮，
  // 全页数按钮会把正常控件也算进来（第一版就是这么误报的）。
  ok(
    (await page.locator('[data-local-siblings] button').count()) === 0,
    '**提示块里不放接入按钮**（真接入要先有第二份凭据，按钮是假控件）'
  );

  // ── ZCode：上次请求（不是「当前连接」）──
  await page.locator('[data-detail-back]').click();
  await page.waitForTimeout(500);
  await page.getByText('ZCode', { exact: true }).first().click();
  await page.waitForTimeout(700);
  const zText = await page.locator('[data-agent-identity]').innerText();
  ok(/上次请求/.test(zText), '标签是「上次请求」', zText.replace(/\n/g, ' ').slice(0, 60));
  ok(!/当前连接/.test(zText), '**不写**「当前连接」—— 使用记录不能冒充实时状态');
  ok(/Z\.ai 套餐/.test(zText), '账号体系用官方套餐名');
  ok(/GLM-5\.3-Flash/.test(zText), '给出上次用的模型');
  ok(/3 分钟前/.test(zText), '给相对时间（不用自己做减法）', zText.replace(/\n/g, ' ').slice(0, 120));
  ok(/不是当前设置/.test(zText), '来源里保留「不是当前设置」的免责说明');
}
await shot('verify-contacts-hints');

// ============= [3f] 获取 Agent（A71）=============
console.log('\n[3f] 获取 Agent：按 method 出按钮 / needs-auth 反例 / 不画假控件');
CURRENT_AGENTS = AGENTS_FOR_INSTALL;
// 拦 window.open：界面上「打开安装页 / 打开项目页」必须走系统浏览器，
// 不能在应用内开新窗口。这里只记录不真开，顺带验证 URL 是不是白名单内那个。
await page.addInitScript(() => {
  window.__opened = [];
  window.open = url => {
    window.__opened.push(String(url));
    return null;
  };
});
await go('/');
// `go()` 是整页重载，导航会回到默认 Tab，得再点一次通讯录
await page.locator('nav button[aria-label="通讯录"]').click();
await page.waitForTimeout(1200);

// ── 全空时的提示条 ──
const banner = page.locator('[data-get-agents-banner]');
ok((await banner.count()) === 1, '一条都没就绪时出现「获取」提示条（新用户第一屏）');
ok(
  /4 个 Agent 还没就绪/.test(await banner.innerText()),
  '提示条写清数量（4 个可获取，needs-auth 的 CLI 不算）',
  (await banner.innerText()).replace(/\n/g, ' ')
);

// ── 「+」菜单入口 ──
await page.locator('button[aria-label="添加"]').click();
await page.waitForTimeout(250);
const getEntry = page.locator('[data-contacts-get-agents]');
ok((await getEntry.count()) === 1, '「+」菜单里有「获取 Agent」');
await getEntry.click();
await page.waitForTimeout(500);

const getDialog = page.locator('[data-get-agents]');
ok((await getDialog.count()) === 1, '打开「获取 Agent」清单弹窗');
const dlgText = await getDialog.innerText();
ok(
  /复制命令/.test(dlgText) && /打开安装页/.test(dlgText) && /填写 API Key/.test(dlgText),
  '清单里三种按钮都在'
);
ok(!/一键安装/.test(dlgText) && !/立即安装/.test(dlgText), '**没有「一键安装」字样**（我们只复制与跳转）');

// ── 分组 ──
for (const [m, n] of [['npm', 1], ['script', 1], ['installer', 1], ['key', 1]]) {
  const cnt = await page.locator(`[data-get-agents-group="${m}"] [data-get-agents-row]`).count();
  ok(cnt === n, `分组 ${m} 有 ${n} 条`, `实际 ${cnt}`);
}
ok((await page.locator('[data-get-agents-group="unknown"]').count()) === 0, 'unknown 分组不出现（没有这种条目）');
ok(
  (await page.locator('[data-get-agents-row="gemini"]').count()) === 0,
  'needs-auth 的 CLI **不进清单**（它已经装好了，只差登录）'
);

// ── npm 形态：复制 + 打开项目页 + Node 警告 ──
const codexRow = page.locator('[data-get-agents-row="codex"] [data-install-card]');
ok((await codexRow.count()) === 1, 'codex 有获取卡片');
ok(
  (await codexRow.getAttribute('data-install-method')) === 'npm',
  'codex 的 method 是 npm'
);
const codexCmd = (await page.locator('[data-get-agents-row="codex"] [data-install-command]').innerText()).trim();
ok(codexCmd === 'npm i -g @openai/codex', '命令逐字正确（含包名）', codexCmd);
ok(
  (await codexRow.locator('[data-install-copy]').count()) === 1,
  'npm 类主按钮是「复制命令」'
);
ok((await codexRow.locator('[data-install-open]').count()) === 1, 'npm 类次按钮是打开项目页');
ok((await codexRow.locator('[data-install-open-settings]').count()) === 0, 'npm 类没有「填 Key」按钮');
ok(
  /没有 Node\.js/.test(await codexRow.locator('[data-install-env-warn]').innerText()),
  '本机没 Node 时**提前说明这条命令会失败**'
);

// ── script 形态：主按钮是打开安装页 ──
const agyRow = page.locator('[data-get-agents-row="antigravity"] [data-install-card]');
ok((await agyRow.getAttribute('data-install-method')) === 'script', 'antigravity 的 method 是 script');
const agyOpen = agyRow.locator('[data-install-open]');
ok(
  (await agyOpen.count()) === 1 && /打开安装页/.test(await agyOpen.innerText()),
  'script 类主按钮是「打开安装页」'
);
ok((await agyRow.locator('[data-install-copy]').count()) === 1, 'script 类次按钮是复制命令');
ok((await agyRow.locator('[data-install-env-warn]').count()) === 0, '本机有 PowerShell 时不出现环境警告');

// ── installer 且没有 url：一个按钮都不该有 ──
const zcRow = page.locator('[data-get-agents-row="zcode"] [data-install-card]');
ok((await zcRow.getAttribute('data-install-method')) === 'installer', 'zcode 的 method 是 installer');
ok(
  (await zcRow
    .locator('[data-install-open], [data-install-copy], [data-install-open-settings]')
    .count()) === 0,
  '**核实不到官方页时不画按钮**（画一个 404 比不画更糟）'
);
ok(/没有命令行安装方式/.test(await zcRow.innerText()), '但把「为什么没有按钮」说清');

// ── key 形态：needs-auth 也要出现「填写 API Key」──
const dbRow = page.locator('[data-get-agents-row="doubao"] [data-install-card]');
ok((await dbRow.getAttribute('data-install-method')) === 'key', '豆包的 method 是 key');
ok(
  (await dbRow.locator('[data-install-open-settings]').count()) === 1,
  'key 类出现「填写 API Key」（不需要安装的那一类）'
);
ok((await dbRow.locator('[data-install-copy]').count()) === 0, 'key 类没有复制按钮');

// ── 复制：剪贴板内容与展示的必须是同一份 ──
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await codexRow.locator('[data-install-copy]').click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip === codexCmd, '剪贴板内容与屏幕上的命令**逐字一致**', `剪贴板="${clip}"`);
ok(
  /已复制/.test(await codexRow.locator('[data-install-copy]').innerText()),
  '复制后按钮变成「已复制」（有反馈）'
);

// ── 打开官网：URL 必须是白名单里那一个 ──
const opened = await page.evaluate(() => window.__opened);
await codexRow.locator('[data-install-open]').click();
await page.waitForTimeout(200);
const opened2 = await page.evaluate(() => window.__opened);
ok(
  opened2.length === opened.length + 1 && opened2[opened2.length - 1] === 'https://github.com/openai/codex',
  '「打开项目页」打开的是白名单内的官方 URL',
  opened2.join(',')
);

// ── 重新检测：真的发了 POST ──
const before = PROBE_HITS;
await page.locator('[data-get-agents-reprobe]').click();
await page.waitForTimeout(600);
ok(PROBE_HITS > before, '「重新检测」真的请求了 /api/agents/probe', `${before} → ${PROBE_HITS}`);

// ── A134：清单页不再逐张卡画「重新检测」 ──
/**
 * 原来 4 张卡各一颗 + 底栏一颗 = 一屏 5 颗按钮打同一个接口。它不是行级动作
 * （`POST /api/agents/probe` 是全量重探），画在卡上等于把一个全局动作伪装成
 * 行级动作；底栏是 shrink-0 常驻的，不需要第二入口。
 *
 * 这条必须用「计数」钉住，不能用「底栏那颗还在」代替 —— 后者在 5 颗都在时
 * 同样绿，正是被修掉的那个状态。
 */
ok(
  (await page.locator('[data-get-agents-row] [data-install-reprobe]').count()) === 0,
  '清单页的卡片里没有「重新检测」（全局动作收进底栏）',
  `还剩 ${await page.locator('[data-get-agents-row] [data-install-reprobe]').count()} 颗`
);
ok((await page.locator('[data-get-agents-reprobe]').count()) === 1, '底栏那颗「重新检测」还在（唯一的入口）');

// zcode（installer 且没有 url）本来就没有主操作，去掉重新检测后整行按钮应该消失，
// 不能留一段空白行 —— 那会在卡片底部多出 12px 幽灵间距。
ok(
  (await page.locator('[data-get-agents-row="zcode"] [data-install-card] > div.mt-3').count()) === 0,
  '没有主操作的卡片不留空按钮行',
  '留了空行 = 卡片底部多一段说不清来历的间距'
);

// ── A134：内容溢出时底边渐隐（Windows 的 overlay 滚动条静止时不画）──
{
  const fade = await page.evaluate(() => {
    const sc = document.querySelector('[data-get-agents] .overflow-y-auto');
    if (!sc) return { missing: true };
    const cs = getComputedStyle(sc);
    return {
      missing: false,
      fade: sc.getAttribute('data-fade'),
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      mask: cs.maskImage || cs.webkitMaskImage || '',
      padBottom: cs.paddingBottom,
    };
  });
  ok(!fade.missing, '找到清单的滚动容器');
  if (!fade.missing) {
    ok(fade.scrollHeight > fade.clientHeight, '内容确实装不下（这条断言的前提）', `${fade.scrollHeight} > ${fade.clientHeight}`);
    ok(fade.fade === '1', '溢出时挂上渐隐标记', String(fade.fade));
    ok(/gradient/.test(fade.mask), '底边是渐变遮罩（不是硬切在半个字上）', fade.mask.slice(0, 60));
    ok(parseFloat(fade.padBottom) >= 20, '底部留了与渐隐同高的空隙（滚到底时淡掉的是留白）', fade.padBottom);
  }
}

// 滚到底：最后一张卡必须**完整**可见，且不被淡掉（底边距容器底 ≥ 留白高度）
{
  const bottom = await page.evaluate(() => {
    const px = n => Math.round(n * 100) / 100;
    const sc = document.querySelector('[data-get-agents] .overflow-y-auto');
    sc.scrollTop = sc.scrollHeight;
    const sr = sc.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-get-agents-row]')];
    const last = rows[rows.length - 1];
    const lr = last.getBoundingClientRect();
    return {
      agent: last.getAttribute('data-get-agents-row'),
      gap: px(sr.bottom - lr.bottom),
      pad: parseFloat(getComputedStyle(sc).paddingBottom),
      scrollTop: sc.scrollTop,
    };
  });
  ok(bottom.scrollTop > 0, '滚动区真的滚动了（否则下面两条是空断言）', `scrollTop=${bottom.scrollTop}`);
  ok(bottom.gap >= 0, '滚到底后最后一张卡完整可见（没被底栏切掉）', `${bottom.agent} 距底 ${bottom.gap}px`);
  ok(bottom.gap >= bottom.pad - 2, '滚到底时最后一张卡落在渐隐区之上（不会永远半虚）', `gap=${bottom.gap} pad=${bottom.pad}`);
  await page.evaluate(() => {
    document.querySelector('[data-get-agents] .overflow-y-auto').scrollTop = 0;
  });
}

await shot('verify-get-agents');

// ── 资料页：卡片复用同一套 ──
await page.locator('[data-get-agents-overlay]').click({ position: { x: 5, y: 5 } });
await page.waitForTimeout(300);
await page.getByText('Codex', { exact: true }).first().click();
await page.waitForTimeout(600);
ok(
  (await page.locator('[data-agent-install] [data-install-card]').count()) === 1,
  '资料页也有「获取」卡片（与清单页同一组件）'
);
ok(
  (await page.locator('[data-agent-install] [data-install-command]').innerText()).trim() === codexCmd,
  '资料页里的命令与清单页一致'
);
/**
 * 与上面「清单页卡片里没有重新检测」互补的一条。
 *
 * 只有前者的话，把 `canReprobe` 直接删掉（两个形态都不画）也会全绿 ——
 * 资料页**没有**常驻底栏，那颗按钮是唯一的重新探测入口，丢了它用户装完
 * 只能去别处找。这条守的就是「`!bare` 这个条件还在起作用」。
 */
ok(
  (await page.locator('[data-agent-install] [data-install-reprobe]').count()) === 1,
  '资料页的卡片**保留**「重新检测」（那里没有底栏，这是唯一入口）',
  `实际 ${await page.locator('[data-agent-install] [data-install-reprobe]').count()} 颗`
);

// ── 反例：CLI 类条目在 needs-auth 下不许出现获取卡片 ──
await page.locator('[data-detail-back]').click();
await page.waitForTimeout(400);
await page.getByText('Gemini', { exact: true }).first().click();
await page.waitForTimeout(600);
ok(
  (await page.locator('[data-agent-install]').count()) === 0,
  '**反例**：已装未登录的 CLI 不出现获取卡片（否则用户会去重装一个没坏的东西）'
);
ok((await page.locator('[data-agent-install] [data-install-open]').count()) === 0, '同一条：也不出现任何打开/复制按钮');

// ── 反例：key 类在 needs-auth 下必须出现 ──
// （A153：详情页不再弹去设置页，而是就地展开凭据编辑器。
//   所以这里断言跳转按钮消失、编辑器出现。）
await page.locator('[data-detail-back]').click();
await page.waitForTimeout(400);
await page.getByText('豆包', { exact: true }).first().click();
await page.waitForTimeout(600);
ok(
  (await page.locator('[data-agent-install] [data-install-open-settings]').count()) === 0,
  '**反例**：key 类在详情页**不**再弹「填写 API Key」跳转按钮'
);
ok(
  (await page.locator('[data-agent-credential-inline]').count()) === 1,
  'key 类就地展开凭据编辑器（取/存/清 + 连通性 + 模型）'
);

// ============= [4] 控制台 ==============
console.log('\n[4] 控制台');
ok(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败（共 ${checks.total} 项）：`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✓ ${checks.total}/${checks.total} 全部通过`);
