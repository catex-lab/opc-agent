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

const ROOT = process.cwd();
const OUT = join(ROOT, '.render-check', 'kb-ui');
// 夹具只是构建产物，放在系统临时目录：项目盘空间紧张时不必为它腾位置，
// 也不会在仓库里留下任何中间文件。
const FIXTURE_DIR = join(tmpdir(), 'opc-kb-a173-fixture');
const SHOTS = join(OUT, 'shots');
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
import './tokens.css';
import '../../../src/kb-ui.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('state') || 'ready';

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
  return (
    <MemoryRouter>
      <KnowledgeBasePanel
        open
        sessionId="s1"
        sessionTitle="重构权限中间件"
        scope={scope}
        onScopeChange={setScope}
        onClose={function () {}}
        onOpenConversation={function (sessionId, messageId) {
          window.__kbOpened = { sessionId: sessionId, messageId: messageId };
        }}
      />
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')).render(<Fixture />);
`;

// 夹具入口落在系统临时目录，相对路径的 ../../../src 会指到 Temp 的上一级，
// 因此这里把真实组件与样式换成绝对路径，脚本从任何工作目录都成立。
const FIXTURE_SOURCE = FIXTURE_ENTRY
  .replace(
    "'../../../src/components/kb/KnowledgeBasePanel'",
    JSON.stringify(join(ROOT, 'src', 'components', 'kb', 'KnowledgeBasePanel'))
  )
  .replace("'../../../src/kb-ui.css'", JSON.stringify(join(ROOT, 'src', 'kb-ui.css')));

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

const indexCss = await readFile(join(ROOT, 'src', 'index.css'), 'utf8');
await writeFile(join(FIXTURE_DIR, 'tokens.css'), themeTokensFromIndexCss(indexCss), 'utf8');
await writeFile(join(FIXTURE_DIR, 'entry.tsx'), FIXTURE_SOURCE, 'utf8');
await writeFile(
  join(FIXTURE_DIR, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="./entry.css"></head>' +
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
  // 夹具在系统临时目录里，依赖解析必须显式指回项目 node_modules。
  nodePaths: [join(ROOT, 'node_modules')],
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

try {
  console.log('\n[1] 默认范围');
  const ready = await openPanel('ready');
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
  const manualText = await manualPage.locator('[data-kb-session-section]').innerText();
  ok(manualText.includes('你手动关'), '手动关有独立标签');
  ok(
    (await manualPage.locator('[data-kb-stop-reason="user"]').count()) === 1,
    '手动关使用 user 语义'
  );
  ok(manualText.includes('恢复索引'), '手动关也提供恢复入口');

  console.log('\n[6] 重建提示与空态');
  ok((await ready.locator('[data-kb-rebuild]').innerText()).includes('重建索引'), '重建入口可见');
  await ready.locator('[data-kb-rebuild]').click();
  await ready.waitForSelector('[data-kb-rebuild-confirm]');
  const confirmText = await ready.locator('[data-kb-rebuild-confirm]').innerText();
  ok(confirmText.includes('不影响聊天记录'), '重建前提示不影响聊天记录');
  await ready.getByRole('button', { name: '取消' }).click();
  await ready.locator('[data-kb-rebuild-confirm]').waitFor({ state: 'detached' });

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

  for (const page of [ready, autoPage, manualPage, emptyPage]) await page.close();
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(`\nA173 闸门：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length > 0) {
  console.error('失败项：', failures.join('、'));
  process.exitCode = 1;
}
