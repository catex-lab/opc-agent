/**
 * A173 闸门：跨 Agent 知识库 P1 界面。
 *
 * 不依赖 dist/（发布线正在打包，禁止跑全量 build），
 * 这里用 esbuild 把真实组件 + 真实主题令牌打成一个临时夹具页，
 * 再用 Playwright 拦住 /api/** 喂固定数据。
 *
 * 覆盖：
 *   [1] 默认范围是本工作区
 *   [2] 「本项目 / 全部」默认上锁，必须显式开启并写入范围策略
 *   [3] 来源卡字段：Agent、会话标题、摘要 + snippet、脱敏计数
 *   [4] 「回到原对话」只带 messageIds，不用脱敏正文回填
 *   [5] 自动停 / 手动关的区分与恢复入口
 *   [6] 空态给出「先建索引」动作，完成后有反馈
 *   [7] 重建提示写明不影响聊天记录
 *   [8] 浅 / 深主题截图与主按钮对比度
 *
 * 运行：node scripts/verify-a173-kb-ui.mjs
 */
import { createServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const ROOT = process.cwd();
const OUT = join(ROOT, '.render-check', 'kb-ui');
// 夹具只是构建产物，放在系统临时目录：项目盘空间紧张时不必为它腾位置，
// 也不会在仓库里留下任何中间文件。
const FIXTURE_DIR = join(tmpdir(), 'opc-kb-a173-fixture');
const SHOTS = join(OUT, 'shots');
/** 会话头部三档截图单独放目录：它们是「头部布局」的证据，不是知识库面板的。 */
const HEADER_SHOTS = join(ROOT, '.render-check', 'header');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

function parseCssColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function relativeLuminance(color) {
  const channel = v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 主按钮文字与底色的对比度，防止深色下出现灰对灰。 */
function buttonContrast(button) {
  const bg = parseCssColor(button.bg);
  const fg = parseCssColor(button.color);
  if (!bg || !fg) return 0;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 去掉 Tailwind 指令与 @layer utilities 块，只保留主题令牌与全局样式。 */
function themeTokensFromIndexCss(css) {
  let next = css
    .replace(/@tailwind\s+[a-z]+;/g, '')
    .replace(/@import\s+'\.\/kb-ui\.css';/g, '');
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

const FIXTURE_ENTRY = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { KnowledgeBasePanel } from '../../../src/components/kb/KnowledgeBasePanel';
import { ChatHeader } from '../../../src/components/ChatHeader';
import { GroupChatHeader } from '../../../src/components/GroupChatHeader';
import './tokens.css';
import '../../../src/kb-ui.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('state') || 'ready';
/**
 * 同一个夹具页三种用法：默认渲染知识库面板；mode=header 渲染单聊头部那一行；
 * mode=group 渲染群聊头部那一行（两者必须共用同一套 .chat-row 降级规则）。
 */
const mode = params.get('mode') || 'panel';
/** 会话头部夹具的容器宽度（900 / 1024 / 1280 三档）。 */
const headerWidth = Number(params.get('w') || 1280);

let allowProject = false;
let allowAll = false;
let disabledReason = scenario === 'auto' ? 'auto_failure' : scenario === 'manual' ? 'user' : null;
let chunkCount = scenario === 'empty' ? 0 : 386;
let sizeBytes = scenario === 'empty' ? 0 : 1887436;
let lastBackfillAt = scenario === 'empty' ? null : '2026-11-03T02:18:00.000Z';

const calls = [];
window.__kbCalls = calls;
window.__kbOpened = null;

function disabledSessions() {
  if (!disabledReason) return [];
  return [{
    sessionId: 's1',
    reason: disabledReason,
    sourceKind: 'direct',
    consecutiveFailures: disabledReason === 'auto_failure' ? 3 : 0,
    lastError: disabledReason === 'auto_failure' ? '索引写入失败：SQLITE_BUSY' : null,
  }];
}

function statusPayload() {
  const disabled = disabledSessions();
  return {
    initialized: chunkCount > 0,
    chunkCount: chunkCount,
    sessionCount: chunkCount > 0 ? 8 : 0,
    sizeBytes: sizeBytes,
    lastBackfillAt: lastBackfillAt,
    scopePolicy: { allowProject: allowProject, allowAll: allowAll },
    policy: { allowProject: allowProject, allowAll: allowAll },
    optedOut: 0,
    disabledSessionCount: disabled.length,
    disabledByReason: {
      user: disabled.filter(s => s.reason === 'user').length,
      autoFailure: disabled.filter(s => s.reason === 'auto_failure').length,
    },
    disabledSessions: disabled,
  };
}

const HITS = [
  {
    citationId: 'c1',
    sessionId: 's1',
    agentId: 'claude',
    authorAgentId: null,
    workspaceKey: '/work/opc',
    projectId: 'p1',
    role: 'assistant',
    sourceType: 'direct',
    visibility: 'normal',
    summary: '权限中间件重构：把注入点收敛到一处',
    snippet: '把 token 注入逻辑从三个调用点收回到权限中间件，失败时统一 fail closed。',
    content: '把 token 注入逻辑从三个调用点收回到权限中间件，失败时统一 fail closed。',
    messageIds: ['m1'],
    tokenCount: 86,
    timeStart: '2026-11-02T10:12:00.000Z',
    timeEnd: '2026-11-02T10:20:00.000Z',
    score: 0.82,
    redactedCount: 2,
  },
  {
    citationId: 'c2',
    sessionId: 's2',
    agentId: null,
    authorAgentId: 'workbuddy',
    workspaceKey: '/work/other',
    projectId: 'p2',
    role: 'assistant',
    sourceType: 'group',
    visibility: 'source_only',
    summary: '群聊里确认了回填范围',
    snippet: '先跑近 90 天，确认切片质量后再补全量。',
    content: '先跑近 90 天，确认切片质量后再补全量。',
    messageIds: ['m2'],
    tokenCount: 42,
    timeStart: '2026-11-01T08:00:00.000Z',
    timeEnd: '2026-11-01T08:05:00.000Z',
    score: 0.61,
    redactedCount: 0,
  },
];

function json(data, statusCode) {
  return new Response(JSON.stringify(data), {
    status: statusCode || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

window.fetch = async function (input, init) {
  const url = String(input);
  const method = ((init && init.method) || 'GET').toUpperCase();
  let body = null;
  if (init && init.body) {
    try { body = JSON.parse(init.body); } catch { body = null; }
  }
  calls.push({ method: method, url: url, body: body });

  if (url.indexOf('/api/kb/sessions/') >= 0 && method === 'PATCH') {
    disabledReason = body && body.indexed ? null : 'user';
    return json({ sessionId: 's1', chunks: 0, skipped: false, reason: null, state: null });
  }
  if (url.indexOf('/api/kb/policy') >= 0 && method === 'PATCH') {
    if (body && body.allowProject) allowProject = true;
    if (body && body.allowAll) allowAll = true;
    return json({ allowProject: allowProject, allowAll: allowAll });
  }
  if (url.indexOf('/api/kb/status') >= 0) return json(statusPayload());
  // kb.search 逐 Agent 开关（31b4533）后新增的独立端点；夹具缺它时面板拿到
  // 兜底的空对象，在 toolPolicy.agents.map 处直接崩，整块面板都挂不上。
  if (url.indexOf('/api/kb/tool-policy') >= 0) {
    return json({
      maxPerTurn: 2,
      agents: [
        { id: 'claude', name: 'Claude Code', supported: true, enabled: true },
        { id: 'workbuddy', name: 'WorkBuddy', supported: true, enabled: false },
      ],
    });
  }
  if (url.indexOf('/api/kb/search') >= 0 && method === 'POST') {
    return json({
      query: body ? body.query : '',
      scope: body ? body.scope : 'workspace',
      mode: 'fts',
      scopeApplied: body ? body.scope : 'workspace',
      hits: chunkCount > 0 ? HITS : [],
      tokensUsed: 168,
      filteredOut: 1,
      topK: 4,
      maxTokens: 900,
    });
  }
  if (url.indexOf('/api/kb/backfill') >= 0 || url.indexOf('/api/kb/rebuild') >= 0) {
    chunkCount = 120;
    sizeBytes = 712000;
    lastBackfillAt = '2026-11-03T03:00:00.000Z';
    return json({
      sessions: 8, indexedSessions: 8, skippedSessions: 1,
      messages: 42, chunks: 120, errors: 0, since: null,
    });
  }
  if (url.indexOf('/api/sessions') >= 0) {
    return json({ sessions: [
      { id: 's1', title: '重构权限中间件', kind: 'direct', created_at: '2026-11-02T09:00:00.000Z' },
      { id: 's2', title: '产品与研发协作群', kind: 'group', created_at: '2026-11-01T07:00:00.000Z' },
    ] });
  }
  if (url.indexOf('/api/agents') >= 0) {
    return json({ agents: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'workbuddy', name: 'WorkBuddy' },
    ] });
  }
  return json({});
};

function Fixture() {
  const [scope, setScope] = useState('workspace');
  // E1：夹具要能真实反映「关闭」—— 否则 Esc 关不掉也没人发现。
  const [open, setOpen] = useState(true);
  return (
    <MemoryRouter>
      <KnowledgeBasePanel
        open={open}
        sessionId="s1"
        sessionTitle="重构权限中间件"
        scope={scope}
        onScopeChange={setScope}
        onClose={() => setOpen(false)}
        onOpenConversation={function (sessionId, messageId) {
          window.__kbOpened = { sessionId: sessionId, messageId: messageId };
        }}
      />
    </MemoryRouter>
  );
}

/**
 * 会话头部夹具：容器宽度由 URL 参数 w 固定，正好是三档断点。
 *
 * 名字故意给得很长 —— 这一行的病灶就是「名字被挤成 Qo…」，
 * 只有长名字才看得出「截断有地板、悬停可读全名」。
 */
function HeaderFixture() {
  const agent = {
    id: 'qoder',
    // 长名字是刻意的：这一行的病灶就是「名字被挤成 Qo…」，
    // 名字够长才会在 900 档真的走到截断，才拍得出「截断有地板」。
    name: 'Qoder 本地代码助手 · 工作区知识库索引与检索（这是一个用于验证窄宽截断的长名字示例）',
    kind: 'cli',
    capabilities: [],
    status: { availability: 'ready', message: '当前可用', updatedAt: '2026-11-03T00:00:00.000Z' },
  };
  const scenario = { id: 'coding', label: '编码', description: '代码编写与重构', color: '#0052D9' };
  return (
    <MemoryRouter>
      <div style={{ width: headerWidth, overflow: 'hidden', background: 'var(--tc-surface-chrome)' }}>
        <ChatHeader
          agent={agent}
          fallbackTitle="未注册 Agent"
          isLoading={false}
          scenario={scenario}
          cwd="C:/work/opc-agent/knowledge-base-ui"
          onCwdChange={function () {}}
          workspaceOpen={false}
          onToggleWorkspace={function () {}}
          onDelete={function () {}}
          sessionId="s1"
          sessionTitle="重构权限中间件"
        />
      </div>
    </MemoryRouter>
  );
}

/**
 * 群聊头部夹具：与单聊同一套容器宽度档位。
 *
 * 群的识别信息更多（成员头像堆叠 + 人数 + 编排模式 + 工作流），
 * 长群名用来验证「先挤名字以外的东西，名字有 6 汉字地板」。
 */
function GroupHeaderFixture() {
  const members = [
    { id: 'claude', name: 'Claude Code', kind: 'cli', capabilities: [],
      status: { availability: 'ready', message: '当前可用', updatedAt: '2026-11-03T00:00:00.000Z' } },
    { id: 'qoder', name: 'Qoder', kind: 'cli', capabilities: [],
      status: { availability: 'ready', message: '当前可用', updatedAt: '2026-11-03T00:00:00.000Z' } },
    { id: 'workbuddy', name: 'WorkBuddy', kind: 'cli', capabilities: [],
      status: { availability: 'busy', message: '忙碌', updatedAt: '2026-11-03T00:00:00.000Z' } },
    { id: 'cursor', name: 'Cursor', kind: 'cli', capabilities: [],
      status: { availability: 'offline', message: '离线', updatedAt: '2026-11-03T00:00:00.000Z' } },
    { id: 'gemini', name: 'Gemini CLI', kind: 'cli', capabilities: [],
      status: { availability: 'offline', message: '离线', updatedAt: '2026-11-03T00:00:00.000Z' } },
  ];
  return (
    <MemoryRouter>
      <div style={{ width: headerWidth, overflow: 'hidden', background: 'var(--tc-surface-chrome)' }}>
        <GroupChatHeader
          title="产品与研发协作群 · 知识库索引与检索验收（这是一个用于验证群聊窄宽截断的长群名示例）"
          members={members}
          onlineCount={2}
          orchestration="dispatch"
          onOrchestrationChange={function () {}}
          onRename={function () {}}
          onShowAgentDetail={function () {}}
          settingsOpen={false}
          onSettingsOpenChange={function () {}}
          onOpenWorkflow={function () {}}
          sessionId="s1"
        />
      </div>
    </MemoryRouter>
  );
}

if (mode === 'header') {
  createRoot(document.getElementById('root')).render(<HeaderFixture />);
} else if (mode === 'group') {
  createRoot(document.getElementById('root')).render(<GroupHeaderFixture />);
} else {
  createRoot(document.getElementById('root')).render(<Fixture />);
}
`;

// 夹具入口落在系统临时目录，相对路径的 ../../../src 会指到 Temp 的上一级，
// 因此这里把 `'../../../src/` 前缀整体换成绝对路径，脚本从任何工作目录都成立。
const SRC_ROOT = join(ROOT, 'src').replace(/\\/g, '/');
const FIXTURE_SOURCE = FIXTURE_ENTRY.replace(/'\.\.\/\.\.\/\.\.\/src\//g, `'${SRC_ROOT}/`);

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
await mkdir(SHOTS, { recursive: true });
await mkdir(HEADER_SHOTS, { recursive: true });

const indexCss = await readFile(join(ROOT, 'src', 'index.css'), 'utf8');
await writeFile(join(FIXTURE_DIR, 'tokens.css'), themeTokensFromIndexCss(indexCss), 'utf8');
await writeFile(join(FIXTURE_DIR, 'entry.tsx'), FIXTURE_SOURCE, 'utf8');
await writeFile(
  join(FIXTURE_DIR, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="./entry.css">' +
    // 会话头部用的是 Tailwind 工具类，夹具必须带上真实生成的 utilities，
    // 否则 flex/truncate 全都不生效，拍出来的只会是「竖排」的假象。
    '<link rel="stylesheet" href="./utilities.css"></head>' +
    '<body style="margin:0;background:var(--td-bg-color-page)"><div id="root"></div>' +
    '<script src="./entry.js"></script></body></html>',
  'utf8'
);

// 按项目自己的 tailwind.config.js 生成 utilities（preflight 在项目里已关闭）。
const utilities = await postcss([
  tailwindcss({
    config: join(ROOT, 'tailwind.config.js'),
    content: [`${join(ROOT, 'src').replace(/\\/g, '/')}/**/*.{tsx,ts}`],
    corePlugins: { preflight: false },
  }),
]).process('@tailwind utilities;', { from: undefined });
await writeFile(join(FIXTURE_DIR, 'utilities.css'), utilities.css, 'utf8');

await build({
  entryPoints: [join(FIXTURE_DIR, 'entry.tsx')],
  outdir: FIXTURE_DIR,
  entryNames: 'entry',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // 夹具在系统临时目录里，依赖解析必须显式指回项目 node_modules。
  nodePaths: [join(ROOT, 'node_modules')],
  // Agent 头像等静态资源：Vite 下由资源管线处理，esbuild 这里给个等价实现。
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
  logLevel: 'silent',
});

// 构建输入用完即删：夹具只需要 index.html + entry.js + entry.css，
// 留在盘上除了占空间没有任何作用。
for (const name of ['entry.tsx', 'tokens.css']) {
  await unlink(join(FIXTURE_DIR, name)).catch(() => {});
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
  viewport: { width: 1180, height: 900 },
  // 夹具截图只用于人工核对，1x 已足够，也避免在磁盘紧张时写出大文件
  deviceScaleFactor: 1,
});

async function openPanel(state, theme) {
  const page = await context.newPage();
  await page.goto(`${base}/index.html?state=${state}`, { waitUntil: 'load' });
  // 截图与取样都要确定性：全局过渡会让主题切换停在中间值 ——
  // 深色主按钮会读到「灰底灰字」（对比度 2.6），外层遮罩也会拍成没换主题的样子。
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.waitForSelector('[data-kb-panel]');
  if (theme === 'dark') {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
  }
  return page;
}

/** 打开会话头部夹具：`mode` 区分单聊 / 群聊，容器宽度固定为 `width`，正好压在三档断点上。 */
async function openHeader(mode, width, theme) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 140 });
  await page.goto(`${base}/index.html?mode=${mode}&w=${width}`, { waitUntil: 'load' });
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.waitForSelector('.chat-row');
  if (theme === 'dark') {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  return page;
}

try {
  console.log('\n[1] 默认范围');
  const ready = await openPanel('ready');
  // A1（需求）：检索是主功能，必须排在索引概览之前且首屏可见；
  // 范围 / 本会话 / 主动检索 / 回填与重建收进默认收起的「知识库设置」。
  const layout = await ready.evaluate(() => {
    const y = sel => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top : null;
    };
    return {
      search: y('[data-kb-search-section]'),
      stats: y('[data-kb-stats]'),
      visible: !!document.querySelector('[data-kb-search-input]')?.getClientRects().length,
    };
  });
  ok(!!layout.search && !!layout.stats && layout.search < layout.stats, '检索区排在索引概览之前', `search=${layout.search} stats=${layout.stats}`);
  ok(layout.visible, '首屏可直接操作检索输入');
  ok(
    (await ready.locator('[data-kb-settings-fold]').getAttribute('data-open')) === 'false',
    '知识库设置默认收起'
  );
  ok((await ready.locator('[data-kb-settings-body]').count()) === 0, '收起时不渲染设置正文');
  ok(
    (await ready.locator('[data-kb-settings-toggle]').getAttribute('aria-expanded')) === 'false',
    '收起行 aria-expanded=false'
  );
  // E1（需求）：弹层由标题 id 命名，打开后焦点在面板内。
  ok(
    (await ready.locator('[data-kb-panel]').getAttribute('aria-labelledby')) === 'kb-panel-title',
    '弹层由标题 id 命名（aria-labelledby）'
  );
  ok(
    await ready.evaluate(() => !!document.activeElement?.closest('[data-kb-panel]')),
    '打开后焦点移入面板'
  );
  await ready.locator('[data-kb-settings-toggle]').click();
  ok(
    (await ready.locator('[data-kb-settings-fold]').getAttribute('data-open')) === 'true',
    '点击后设置展开'
  );
  ok((await ready.locator('[data-kb-settings-body]').count()) === 1, '展开后渲染设置正文');
  ok(
    (await ready.locator('[data-kb-scope="workspace"]').getAttribute('aria-checked')) === 'true',
    '默认选中「本工作区」'
  );
  ok(
    (await ready.locator('[data-kb-scope="workspace"]').getAttribute('data-kb-scope-locked')) === 'false',
    '本工作区不需要额外开启'
  );
  const workspaceRowText = await ready.locator('[data-kb-scope="workspace"]').innerText();
  ok(workspaceRowText.includes('默认'), '本工作区标注为默认范围');

  console.log('\n[2] 越权范围必须显式开启');
  ok(
    (await ready.locator('[data-kb-scope="project"]').getAttribute('data-kb-scope-locked')) === 'true',
    '「本项目」默认上锁'
  );
  ok(
    (await ready.locator('[data-kb-scope="all"]').getAttribute('data-kb-scope-locked')) === 'true',
    '「全部」默认上锁'
  );
  await ready.locator('[data-kb-scope="project"]').click();
  await ready.waitForSelector('[data-kb-scope-notice]');
  const noticeText = await ready.locator('[data-kb-scope-notice]').innerText();
  ok(noticeText.includes('其他会话内容可被检索'), '开启提示写明其他会话可被检索');
  const policyCallsBefore = await ready.evaluate(() =>
    window.__kbCalls.filter(c => c.url.indexOf('/api/kb/policy') >= 0 && c.method === 'PATCH').length
  );
  ok(policyCallsBefore === 0, '点范围本身不会静默改写策略');
  await ready.getByRole('button', { name: '开启并切换' }).click();
  await ready.waitForFunction(() =>
    document.querySelector('[data-kb-scope="project"]').getAttribute('aria-checked') === 'true'
  );
  const policyCall = await ready.evaluate(() =>
    window.__kbCalls.find(c => c.url.indexOf('/api/kb/policy') >= 0 && c.method === 'PATCH')
  );
  ok(!!policyCall && policyCall.body && policyCall.body.allowProject === true, '确认后写入 allowProject=true');

  console.log('\n[3] 来源卡字段');
  await ready.locator('[data-kb-search-input]').fill('权限中间件');
  await ready.locator('[data-kb-search-action]').click();
  await ready.waitForSelector('[data-kb-hit]');
  const firstHit = ready.locator('[data-kb-hit]').first();
  const firstText = await firstHit.innerText();
  ok(firstText.includes('Claude Code'), '显示 Agent 名称');
  ok(firstText.includes('重构权限中间件'), '显示会话标题');
  ok(firstText.includes('把 token 注入逻辑'), '显示摘要与 snippet');
  ok(/脱敏\s*2\s*处/.test(firstText), '显示脱敏计数');
  ok(firstText.includes('单聊'), '显示来源类型');
  ok((await firstHit.getByRole('button', { name: '回到原对话' }).count()) === 1, '来源卡有「回到原对话」');
  await firstHit.getByRole('button', { name: '展开原文' }).click();
  ok(await firstHit.locator('.kb-hit-orig').isVisible(), '可展开脱敏原文');

  console.log('\n[4] 回到原对话只带 messageIds');
  await firstHit.getByRole('button', { name: '回到原对话' }).click();
  const opened = await ready.evaluate(() => window.__kbOpened);
  ok(!!opened && opened.sessionId === 's1' && opened.messageId === 'm1', '跳转参数来自 messageIds', JSON.stringify(opened));

  console.log('\n[5] 自动停 / 手动关');
  const autoPage = await openPanel('auto');
  await autoPage.locator('[data-kb-settings-toggle]').click();
  const autoBadge = await autoPage.locator('[data-kb-stop-reason]').innerText();
  ok(autoBadge.includes('自动停'), '自动停有独立标签');
  ok(
    (await autoPage.locator('[data-kb-stop-reason="auto"]').count()) === 1,
    '自动停使用 auto_failure 语义'
  );
  const autoText = await autoPage.locator('[data-kb-session-section]').innerText();
  ok(autoText.includes('连续失败 3 次'), '写明连续失败次数');
  ok(autoText.includes('恢复索引'), '自动停提供恢复入口');
  await autoPage.locator('[data-kb-session-action]').click();
  await autoPage.waitForSelector('[data-kb-feedback]');
  const restoreCall = await autoPage.evaluate(() =>
    window.__kbCalls.find(c => c.url.indexOf('/api/kb/sessions/') >= 0 && c.method === 'PATCH')
  );
  ok(!!restoreCall && restoreCall.body.indexed === true, '恢复索引调用 PATCH indexed=true');

  const manualPage = await openPanel('manual');
  await manualPage.locator('[data-kb-settings-toggle]').click();
  const manualText = await manualPage.locator('[data-kb-session-section]').innerText();
  ok(manualText.includes('你手动关'), '手动关有独立标签');
  ok(
    (await manualPage.locator('[data-kb-stop-reason="user"]').count()) === 1,
    '手动关使用 user 语义'
  );
  ok(manualText.includes('恢复索引'), '手动关也提供恢复入口');

  console.log('\n[6] 重建提示与空态');
  // A1 之后回填/重建收在设置分组里，这里新开一页并展开，避免被前面的交互状态干扰。
  const rebuildPage = await openPanel('ready');
  await rebuildPage.locator('[data-kb-settings-toggle]').click();
  ok((await rebuildPage.locator('[data-kb-rebuild]').innerText()).includes('重建索引'), '重建入口可见');
  await rebuildPage.locator('[data-kb-rebuild]').click();
  await rebuildPage.waitForSelector('[data-kb-rebuild-confirm]');
  const confirmText = await rebuildPage.locator('[data-kb-rebuild-confirm]').innerText();
  ok(confirmText.includes('不影响聊天记录'), '重建前提示不影响聊天记录');
  // D4（需求）：破坏性操作要量化后果（清空多少切片），不能只说「重新生成」。
  ok(/重建会清空\s*386\s*个切片/.test(confirmText), '重建提示写明会清空的切片数量', confirmText);
  ok(
    await rebuildPage.locator('[data-kb-rebuild-confirm]').evaluate(el => {
      const s = getComputedStyle(el);
      return s.borderLeftWidth === '3px' && s.borderLeftStyle === 'solid';
    }),
    '重建确认有左侧危险色实心条'
  );
  await rebuildPage.getByRole('button', { name: '取消' }).click();
  await rebuildPage.locator('[data-kb-rebuild-confirm]').waitFor({ state: 'detached' });

  console.log('\n[6b] Esc 关闭');
  const escPage = await openPanel('ready');
  await escPage.keyboard.press('Escape');
  await escPage.locator('[data-kb-panel]').waitFor({ state: 'detached' });
  ok(true, 'Esc 关闭知识库弹层');

  console.log('\n[7] 浅 / 深主题截图');
  // 新开一页保持默认策略（本项目 / 全部仍上锁），只做一次检索，截图更贴近首次打开。
  const shotPage = await openPanel('ready');
  await shotPage.locator('[data-kb-search-input]').fill('权限中间件');
  await shotPage.locator('[data-kb-search-action]').click();
  await shotPage.waitForSelector('[data-kb-hit]');
  ok(!(await shotPage.locator('[data-kb-search-action]').isDisabled()), '结果出来后检索按钮可用');
  await shotPage.setViewportSize({ width: 1180, height: 1240 });
  await shotPage.evaluate(() => {
    const body = document.querySelector('.kb-body');
    if (body) body.scrollTop = 0;
  });
  const lightPanelBg = await shotPage.locator('[data-kb-panel]').evaluate(el => getComputedStyle(el).backgroundColor);
  const lightBtn = await shotPage.locator('[data-kb-search-action]').evaluate(el => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
  await shotPage.screenshot({ path: join(SHOTS, 'light.png'), fullPage: true });
  await shotPage.evaluate(() => document.documentElement.classList.add('dark'));
  // 过渡已关掉（见 openPanel），这里只等两帧让新主题完成绘制。
  await shotPage.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const darkPanelBg = await shotPage.locator('[data-kb-panel]').evaluate(el => getComputedStyle(el).backgroundColor);
  const darkBtn = await shotPage.locator('[data-kb-search-action]').evaluate(el => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
  await shotPage.screenshot({ path: join(SHOTS, 'dark.png'), fullPage: true });
  await shotPage.evaluate(() => document.documentElement.classList.remove('dark'));
  await shotPage.close();
  ok(buttonContrast(lightBtn) >= 4.5, '浅色主按钮文字对比度 ≥ 4.5:1', buttonContrast(lightBtn).toFixed(2));
  ok(buttonContrast(darkBtn) >= 4.5, '深色主按钮文字对比度 ≥ 4.5:1', buttonContrast(darkBtn).toFixed(2));
  ok(lightPanelBg !== darkPanelBg, '浅 / 深主题走了同一套令牌', `${lightPanelBg} → ${darkPanelBg}`);
  ok(true, '浅色截图', join(SHOTS, 'light.png'));
  ok(true, '深色截图', join(SHOTS, 'dark.png'));

  const emptyPage = await openPanel('empty');
  await emptyPage.setViewportSize({ width: 1180, height: 1240 });
  ok(await emptyPage.locator('[data-kb-empty]').isVisible(), '空态不是空白页');
  ok((await emptyPage.locator('[data-kb-empty]').innerText()).includes('先建索引'), '空态给出「先建索引」动作');
  await emptyPage.screenshot({ path: join(SHOTS, 'empty.png'), fullPage: true });
  await emptyPage.locator('[data-kb-empty-action]').click();
  await emptyPage.waitForSelector('[data-kb-feedback]');
  const feedbackText = await emptyPage.locator('[data-kb-feedback]').innerText();
  ok(feedbackText.includes('回填完成'), '建索引后有完成反馈');
  ok((await emptyPage.locator('[data-kb-empty]').count()) === 0, '索引完成后空态消失');
  ok(true, '空态截图', join(SHOTS, 'empty.png'));

  console.log('\n[9] 会话头部窄宽降级（900 / 1024 / 1280）');
  // 防止以后新增 chip 又把这一行撑破：三档都必须满足
  // 「这一行不溢出 + 在线徽标横排 + 名字保底 6 汉字」，超出宽度的部分只能靠降级让位。
  for (const width of [900, 1024, 1280]) {
    const page = await openHeader('header', width, 'light');
    const rowMetrics = await page.locator('.chat-row').evaluate(el => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    ok(
      rowMetrics.scroll <= rowMetrics.client + 1,
      `${width}px：这一行不溢出`,
      `${rowMetrics.scroll}/${rowMetrics.client}`
    );

    const statusInfo = await page.locator('[data-chat-status]').first().evaluate(el => ({
      text: el.textContent.trim(),
      whiteSpace: getComputedStyle(el).whiteSpace,
      height: el.getBoundingClientRect().height,
    }));
    ok(
      statusInfo.text === '在线' && statusInfo.whiteSpace === 'nowrap' && statusInfo.height <= 28,
      `${width}px：在线徽标横排、不参与压缩`,
      `h=${statusInfo.height.toFixed(1)}px`
    );

    const titleInfo = await page.locator('.chat-row h1').evaluate(el => ({
      minWidth: parseFloat(getComputedStyle(el).minWidth),
      width: el.getBoundingClientRect().width,
      text: el.textContent.trim(),
    }));
    ok(
      titleInfo.minWidth >= 96 && titleInfo.width >= titleInfo.minWidth - 0.5,
      `${width}px：名字保底约 6 个汉字宽`,
      `${titleInfo.width.toFixed(0)}px / min ${titleInfo.minWidth}px`
    );

    const kbLabelVisible = await page.locator('[data-kb-chip-label]').isVisible();
    const chevronVisible = await page
      .locator('[data-workspace-badge] summary svg')
      .last()
      .isVisible();
    if (width <= 1024) {
      ok(!kbLabelVisible, `${width}px：知识库入口退化为单色图标`);
      ok(!chevronVisible, `${width}px：工作区 chip 去掉展开箭头`);
      const ariaLabel = await page.locator('[data-kb-chip]').getAttribute('aria-label');
      ok(!!ariaLabel && ariaLabel.includes('知识库'), `${width}px：图标按钮保留 aria-label`, ariaLabel || '');
    } else {
      ok(kbLabelVisible, `${width}px：知识库入口保留文字`);
      ok(chevronVisible, `${width}px：工作区 chip 保留展开箭头`);
    }
    ok((await page.locator('[data-chat-more]').count()) === 1, `${width}px：次要动作仍在「…」里`);

    await page.locator('[data-chat-more] summary').click();
    const moreItems = await page.locator('[data-chat-more] [role="menuitem"], [data-chat-more] button').count();
    ok(moreItems >= 2, `${width}px：更多操作收纳在「…」里`, `${moreItems} 项`);
    await page.locator('[data-chat-more] summary').click();

    await page.screenshot({ path: join(HEADER_SHOTS, `${width}-light.png`) });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: join(HEADER_SHOTS, `${width}-dark.png`) });
    ok(true, `${width}px 浅 / 深截图`, join(HEADER_SHOTS, `${width}-light.png`));
    await page.close();
  }

  console.log('\n[10] 群聊头部窄宽降级（900 / 1024 / 1280）');
  // 与单聊同一套 .chat-row 容器查询：单聊好、群聊坏说明有第二套数值，
  // 所以这里按同一优先级逐档复核，截图落在 header 目录里成对比较。
  for (const width of [900, 1024, 1280]) {
    const page = await openHeader('group', width, 'light');
    const rowMetrics = await page.locator('.chat-row').evaluate(el => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    ok(
      rowMetrics.scroll <= rowMetrics.client + 1,
      `群聊 ${width}px：这一行不溢出`,
      `${rowMetrics.scroll}/${rowMetrics.client}`
    );

    const statusInfo = await page.locator('[data-chat-status]').first().evaluate(el => ({
      text: el.textContent.trim(),
      whiteSpace: getComputedStyle(el).whiteSpace,
      height: el.getBoundingClientRect().height,
    }));
    ok(
      statusInfo.text.includes('在线') && statusInfo.whiteSpace === 'nowrap' && statusInfo.height <= 28,
      `群聊 ${width}px：在线徽标横排、不参与压缩`,
      `h=${statusInfo.height.toFixed(1)}px`
    );

    const titleInfo = await page.locator('.chat-row h1').evaluate(el => ({
      minWidth: parseFloat(getComputedStyle(el).minWidth),
      width: el.getBoundingClientRect().width,
      text: el.textContent.trim(),
      fullName: el.querySelector('span[title]')?.getAttribute('title') || '',
    }));
    ok(
      titleInfo.minWidth >= 96 && titleInfo.width >= titleInfo.minWidth - 0.5,
      `群聊 ${width}px：群名保底约 6 个汉字宽`,
      `${titleInfo.width.toFixed(0)}px / min ${titleInfo.minWidth}px`
    );
    ok(
      titleInfo.fullName.includes('产品与研发协作群'),
      `群聊 ${width}px：群名截断后仍可读回全名（title）`
    );
    ok(
      titleInfo.text.includes('（5）'),
      `群聊 ${width}px：成员数未被挤掉`,
      titleInfo.text.slice(-8)
    );
    // textContent 里有不算数：必须真的落在 h1 的框内，不能被 overflow 裁掉。
    const countInfo = await page.locator('.chat-row h1').evaluate(el => {
      const count = Array.from(el.querySelectorAll('span')).find(s => /（\d+）/.test(s.textContent || ''));
      if (!count) return null;
      const rect = count.getBoundingClientRect();
      return { width: rect.width, right: rect.right, boxRight: el.getBoundingClientRect().right };
    });
    ok(
      !!countInfo && countInfo.width > 0 && countInfo.right <= countInfo.boxRight + 0.5,
      `群聊 ${width}px：成员数在可视区内（未被裁切）`,
      countInfo ? `${countInfo.right.toFixed(0)} / ${countInfo.boxRight.toFixed(0)}` : 'missing'
    );

    const avatarCount = await page.locator('[data-member-avatar]').count();
    ok(avatarCount === 4, `群聊 ${width}px：成员头像堆叠保留 4 个`, `${avatarCount} 个`);

    const kbLabelVisible = await page.locator('[data-kb-chip-label]').isVisible();
    if (width <= 1024) {
      ok(!kbLabelVisible, `群聊 ${width}px：知识库入口退化为单色图标`);
      const ariaLabel = await page.locator('[data-kb-chip]').getAttribute('aria-label');
      ok(!!ariaLabel && ariaLabel.includes('知识库'), `群聊 ${width}px：图标按钮保留 aria-label`, ariaLabel || '');
    } else {
      ok(kbLabelVisible, `群聊 ${width}px：知识库入口保留文字`);
    }

    await page.screenshot({ path: join(HEADER_SHOTS, `group-${width}-light.png`) });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: join(HEADER_SHOTS, `group-${width}-dark.png`) });
    ok(true, `群聊 ${width}px 浅 / 深截图`, join(HEADER_SHOTS, `group-${width}-light.png`));
    await page.close();
  }

  for (const page of [ready, autoPage, manualPage, emptyPage]) await page.close();
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

// 夹具的运行期文件用完即删（截图与日志不进临时目录）。
for (const name of ['index.html', 'entry.js', 'entry.css', 'utilities.css']) {
  await unlink(join(FIXTURE_DIR, name)).catch(() => {});
}

console.log(`\nA173 闸门：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length > 0) {
  console.error('失败项：', failures.join('、'));
  process.exitCode = 1;
}
