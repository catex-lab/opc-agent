/**
 * A85 验收 —— 过程信息视觉层级降权：正文是主角，过程是脚注。
 *
 * 用户反馈：聊天页面中思考链文字、工具调用结果「喧宾夺主」，
 * 和正文答案的视觉重量拉不开。
 *
 * 覆盖：
 *   [1] 工具轨迹汇总行退到 placeholder + caption（不再和正文同大）
 *   [2] 步骤动词退到 placeholder；文件名退到 secondary（不再比正文黑）
 *   [3] diff 统计常态降 opacity（不再每一步都跳饱和色）
 *   [4] 工具图标常态淡化，hover 恢复（语义颜色保留，只是不抢眼）
 *   [5] 思考链展开正文：正体 12.5px secondary + 2px 左细线（方案 C，2026-10-26 改）
 *   [6] 步骤明细退到 placeholder + 3% 背景
 *   [7] 轨迹与正文之间有 8px 物理分隔
 *   [8] 编排叙述行去掉胶囊背景，变成纯文本脚注
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
  '.png': 'image/png',
};

const AGENTS = [
  { id: 'wb', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用编码与自动化助手', capabilities: ['chat'], status: { availability: 'ready', version: '2.4.1' } },
];

const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const SESSIONS = [
  { id: 's1', title: 'WorkBuddy', agent_id: 'wb', model: 'm', created_at: new Date().toISOString() },
];

const TRACE_MESSAGE = {
  id: 'm-trace',
  role: 'assistant',
  session_id: 's1',
  model: 'm',
  created_at: new Date().toISOString(),
  blocks: [
    {
      id: 'b-text',
      type: 'text',
      text: '我来做一个单文件的 Three.js 中国地形三维动画，内置按真实经纬度（73–135°E, 18–54°N）和真实海拔（米）构建的地形高程模型——青藏高原、喜马拉雅、天山、塔里木盆地、长江中下游平原等按实际位置与高程还原，双击打开即可观看。',
      state: 'done',
    },
    {
      id: 'b-tool-1',
      type: 'tool',
      toolId: 't1',
      name: 'write',
      input: { path: 'china-terrain.html', content: '<!DOCTYPE html>...' },
      output: '文件已写入',
      status: 'completed',
      startedAt: Date.now() - 8000,
      endedAt: Date.now() - 7000,
    },
    {
      id: 'b-think-1',
      type: 'thinking',
      text: '用户想要一个中国地形动画，我需要用 Three.js 构建一个 384×216 的网格，按真实经纬度范围生成海拔数据。关键点：青藏高原均值 4600m、喜马拉雅 8848m 标注、昆仑山、天山、阿尔泰山、秦岭、阴山、贺兰山、大兴安岭、长白山、南岭、武夷山。',
      state: 'done',
      format: 'raw',
      startedAt: Date.now() - 12000,
      endedAt: Date.now() - 8000,
    },
    {
      id: 'b-tool-2',
      type: 'tool',
      toolId: 't2',
      name: 'bash',
      input: { command: 'ls -la china-terrain.html' },
      output: '-rw-r--r--  1 user user  45K  Oct 23 14:20 china-terrain.html',
      status: 'completed',
      startedAt: Date.now() - 6000,
      endedAt: Date.now() - 5000,
    },
  ],
};

const NOTE_MESSAGE = {
  id: 'm-note',
  role: 'assistant',
  session_id: 's1',
  model: 'm',
  created_at: new Date().toISOString(),
  note: true,
  content: '主控决定交给 OpenCode',
};

const MESSAGES = [
  { id: 'm0', role: 'user', session_id: 's1', created_at: new Date().toISOString(), content: '你用 three.js 帮我做一个中国地形的动画' },
  TRACE_MESSAGE,
  NOTE_MESSAGE,
];

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
await ctx.route('**/api/**', route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.includes('/api/agent-credentials')) return json({ credentials: [] });
  if (/\api\/sessions\/[^/]+$/.test(url)) {
    const id = url.split('/api/sessions/')[1].split('?')[0];
    const s = SESSIONS.find(x => x.id === id) ?? SESSIONS[0];
    return json({ session: s, messages: MESSAGES });
  }
  if (/\api\/agents\/probe/.test(url)) return json({ agents: AGENTS });
  if (/\api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\api\/models/.test(url)) return json({ models: MODELS });
  if (/\api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

async function go(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
}

await go('/chat/s1');

// ── [1] 轨迹汇总行：placeholder + caption ─────────────────────────────
const summary = await page.evaluate(() => {
  const el = document.querySelector('.tc-trace-summary');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { color: cs.color, fontSize: cs.fontSize };
});
ok(summary != null, '轨迹汇总行存在', summary ? `${summary.color} / ${summary.fontSize}` : 'missing');
if (summary) {
  ok(
    summary.color === 'rgb(163, 163, 163)',
    '汇总行颜色 = placeholder (#a3a3a3)',
    summary.color
  );
  ok(
    // A102 把汇总行从 caption(11px) 提到 secondary(12px)，与步骤行主信息同档 ——
    // 原来 11px 的汇总行配 12px 的步骤行，同一块区域两种字号。
    summary.fontSize === '12px',
    '汇总行字号 = secondary (12px，A102 起与步骤行主信息同档)',
    summary.fontSize
  );
}

// ── [2] 步骤动词 = placeholder；文件名 = secondary ─────────────────────
// 完成态轨迹默认收起，先展开才能读到步骤
const stepsBar = await page.$('.tc-steps-bar');
if (stepsBar) {
  await stepsBar.click();
  await page.waitForTimeout(300);
}

const verb = await page.evaluate(() => {
  const el = document.querySelector('.tc-trace-verb');
  return el ? getComputedStyle(el).color : null;
});
ok(verb === 'rgb(163, 163, 163)', '步骤动词颜色 = placeholder', verb);

const target = await page.evaluate(() => {
  const el = document.querySelector('.tc-trace-target');
  return el ? getComputedStyle(el).color : null;
});
ok(target === 'rgb(115, 115, 115)', '文件名颜色 = secondary（不再比正文黑）', target);

// ── [3] diff 统计常态 opacity < 1 ─────────────────────────────────────
// 鼠标可能在汇总行上（刚点击展开），移开才能测到常态值
await page.mouse.move(10, 10);
await page.waitForTimeout(150);
const diffOp = await page.evaluate(() => {
  const el = document.querySelector('.tc-diff');
  return el ? parseFloat(getComputedStyle(el).opacity) : null;
});
ok(diffOp != null && diffOp < 1 && diffOp > 0, 'diff 常态 opacity 降权', diffOp);

// ── [4] 工具图标常态淡化 ───────────────────────────────────────────────
const iconOp = await page.evaluate(() => {
  const el = document.querySelector('.tc-step-head svg');
  return el ? parseFloat(getComputedStyle(el).opacity) : null;
});
ok(iconOp != null && iconOp < 1 && iconOp > 0, '工具图标常态 opacity 淡化', iconOp);

// hover 反证：鼠标移上去后 opacity 应该恢复
await page.hover('.tc-step-head');
await page.waitForTimeout(200);
const iconOpHover = await page.evaluate(() => {
  const el = document.querySelector('.tc-step-head svg');
  return el ? parseFloat(getComputedStyle(el).opacity) : null;
});
ok(iconOpHover === 1, '工具图标 hover 后 opacity 恢复为 1', iconOpHover);

// ── [5] 思考链展开正文：正体 secondary + 浅灰圆角卡片 ─────────────────
// 先展开思考块
await page.click('.tc-thinking > summary');
await page.waitForTimeout(200);
const thinkingDiv = await page.evaluate(() => {
  const el = document.querySelector('.tc-thinking > div');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const probe = (prop, value) => {
    const s = document.createElement('span');
    s.style[prop] = value;
    document.body.appendChild(s);
    const out = getComputedStyle(s)[prop];
    s.remove();
    return out;
  };
  return {
    color: cs.color,
    bg: cs.backgroundColor,
    italic: cs.fontStyle,
    border: `${cs.borderLeftWidth} ${cs.borderLeftStyle}`,
    borderRadius: cs.borderTopLeftRadius,
    card: probe('backgroundColor', 'var(--td-bg-color-secondarycontainer)'),
    secondary: probe('color', 'var(--td-text-color-secondary)'),
  };
});
ok(thinkingDiv != null, '思考链展开正文存在');
if (thinkingDiv) {
  // 2026-10-30（改版）：思考正文从「正体 + 左细线」改成
  // 「正体 secondary + 浅灰圆角卡片」。旧的左细线 / 无底色期望随之作废 ——
  // 这是本脚本第 N 次「界面改了、期望表没跟上」，改样式时先 grep 这里。
  ok(thinkingDiv.color === thinkingDiv.secondary, '思考正文颜色 = secondary（不再是最浅一档）', thinkingDiv.color);
  ok(thinkingDiv.italic === 'normal', '思考正文 font-style = normal（自然语言不用等宽斜体）', thinkingDiv.italic);
  ok(thinkingDiv.bg === thinkingDiv.card, '思考正文是灰卡（secondarycontainer 令牌）', thinkingDiv.bg);
  ok(thinkingDiv.border === '0px none', '思考正文不再有左细线', thinkingDiv.border);
  ok(parseFloat(thinkingDiv.borderRadius) >= 6, '思考灰卡有圆角（≥6px）', thinkingDiv.borderRadius);
}

// ── [6] 步骤明细：placeholder + 3% 背景 ───────────────────────────────
// 展开第一个有明细的步骤
const clickableHead = await page.$('.tc-step-head[data-clickable="1"]');
if (clickableHead) {
  await clickableHead.click();
  await page.waitForTimeout(200);
}
const detail = await page.evaluate(() => {
  const el = document.querySelector('.tc-step-detail');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { color: cs.color, bg: cs.backgroundColor };
});
ok(detail != null, '步骤明细存在');
if (detail) {
  ok(detail.color === 'rgb(163, 163, 163)', '步骤明细颜色 = placeholder', detail.color);
  const bgLum = detail.bg;
  ok(
    bgLum.includes('0.03') || bgLum.includes('rgb(4') || bgLum.includes('rgb(7'),
    '步骤明细背景 ≈ 3%',
    bgLum
  );
}

// ── [7] 轨迹与正文之间有物理分隔 ───────────────────────────────────────
const traceMargin = await page.evaluate(() => {
  const el = document.querySelector('.tc-trace');
  return el ? getComputedStyle(el).marginTop : null;
});
ok(traceMargin === '8px', '轨迹上下有 8px 物理分隔', traceMargin);

// ── [8] 编排叙述行无背景 ───────────────────────────────────────────────
const noteSpan = await page.evaluate(() => {
  const el = document.querySelector('[data-note] span');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { bg: cs.backgroundColor, color: cs.color };
});
ok(noteSpan != null, '编排叙述行存在');
if (noteSpan) {
  ok(
    noteSpan.bg === 'rgba(0, 0, 0, 0)' || noteSpan.bg === 'transparent',
    '编排叙述行无背景',
    noteSpan.bg
  );
  ok(
    noteSpan.color === 'rgb(163, 163, 163)',
    '编排叙述行颜色 = placeholder',
    noteSpan.color
  );
}

// ── 截图 ──────────────────────────────────────────────────────────────
await page.screenshot({ path: join(OUT, 'a85-trace-light.png'), fullPage: false });

// 深色模式
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'a85-trace-dark.png'), fullPage: false });

// 深色下颜色翻转验证
const summaryDark = await page.evaluate(() => {
  const el = document.querySelector('.tc-trace-summary');
  return el ? getComputedStyle(el).color : null;
});
ok(summaryDark === 'rgb(115, 115, 115)', '深色下汇总行仍走 placeholder', summaryDark);

await browser.close();
server.closeAllConnections?.();
server.close?.();

console.log(`\nA85 结果：${checks.total - failures.length}/${checks.total}`);
if (failures.length) {
  console.log('失败项：', failures.join('；'));
  process.exit(1);
}
