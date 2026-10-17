/**
 * 生图消息渲染验证（P4-4）。
 *
 * 复用 render-check.mjs 的手法：静态服务器托管 dist/ + Playwright 拦截 /api/**，
 * 无需真实后端、不打真实生图接口。
 *
 * 关键点：夹具里的图片消息是**从 DB 还原的形态**（只有 `images`，没有
 * contentBlocks）—— 这正是刷新后走的那条路径。所以这个用例真正验证的是
 * 「刷新后图片还在、且长得和刚生成时一样」，而不只是「刚生成时能显示」。
 *
 * 断言：
 *   [1] 两条生图消息都渲染出图片气泡
 *   [2] 能加载的图真的加载成功（naturalWidth > 0，不是裂图占位）
 *   [3] 图下的提示词/尺寸/模型说明可见
 *   [4] 加载失败的图走降级界面（提示「图像无法加载」），而不是留个裂图
 *   [5] 生图消息用专属头像（不是会话绑定 Agent 的头像）
 *   [6] 输入区切成生图模式（生图模型 + 尺寸选择器）
 *   [7] 全程无控制台错误
 *
 * 运行：node scripts/verify-image-ui.mjs（需先 npm run build）
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

/** 1x1 透明 PNG —— 真实字节，浏览器会真的解码成功 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const AGENTS = [
  { id: 'hermes', name: 'Hermes', kind: 'acp', icon: 'hermes', color: '#5F5E5A', description: 'ACP Agent', capabilities: ['chat', 'image'], status: { availability: 'ready', version: '0.21.6' } },
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: '通用助手', capabilities: ['chat', 'tools'], status: { availability: 'ready', version: '2.4.1' } },
];
const MODELS = [{ modelId: 'zai/glm-4.7', name: 'GLM-4.7', description: '默认' }];

const NOW = new Date().toISOString();

/** 生图会话：scenario_id = 'image' → 前端进入生图模式 */
const SESSIONS = [
  {
    id: 'img1',
    title: '生图：一只戴墨镜的橘猫',
    agent_id: 'hermes',
    model: 'cogview-3-flash',
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    scenario_id: 'image',
    system_prompt: null,
    created_at: NOW,
  },
];

/**
 * 消息夹具：模拟从 DB 读回的形态。
 * 注意没有 contentBlocks —— 只有 images，即「刷新后」的路径。
 */
const MESSAGES = [
  {
    id: 'u1', session_id: 'img1', role: 'user', content: '一只戴墨镜的橘猫，扁平插画风格',
    model: null, author_agent_id: null, created_at: NOW, tool_calls: null, images: null,
  },
  {
    id: 'a1', session_id: 'img1', role: 'assistant', content: '',
    model: 'cogview-3-flash', author_agent_id: 'hermes', created_at: NOW, tool_calls: null,
    images: [{
      url: '/api/images/ok.png',
      sourceUrl: 'https://example.com/original.png?Expires=1',
      prompt: '一只戴墨镜的橘猫，扁平插画风格',
      size: '1344x768',
      model: 'cogview-3-flash',
      provider: 'cogview',
      alt: '一只戴墨镜的橘猫',
    }],
  },
  {
    id: 'u2', session_id: 'img1', role: 'user', content: '再来一张不存在的',
    model: null, author_agent_id: null, created_at: NOW, tool_calls: null, images: null,
  },
  {
    id: 'a2', session_id: 'img1', role: 'assistant', content: '',
    model: 'cogview-3-flash', author_agent_id: 'hermes', created_at: NOW, tool_calls: null,
    images: [{
      url: '/api/images/missing.png',
      sourceUrl: 'https://example.com/gone.png',
      prompt: '这张图已经失效了',
      size: '1024x1024',
      model: 'cogview-3-flash',
      provider: 'cogview',
      alt: '失效的图',
    }],
  },
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

await ctx.route('**/api/**', async route => {
  const url = route.request().url();
  const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  // 图片：一张真图、一张 404（用来验证降级界面）
  if (url.includes('/api/images/ok.png')) {
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  }
  if (url.includes('/api/images/missing.png')) {
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  }

  if (url.includes('/api/chat') || url.includes('/api/image')) {
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n' });
  }
  if (url.includes('/api/permission-response')) return json({ ok: true });
  if (url.includes('/api/agents/probe')) return json({ agents: AGENTS });
  if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
  if (/\/api\/models/.test(url)) return json({ models: MODELS });
  if (/\/api\/sessions\/[^/]+$/.test(url)) return json({ session: SESSIONS[0], messages: MESSAGES });
  if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
  return json({});
});

const page = await ctx.newPage();
/**
 * 记录控制台错误。
 *
 * 带上 location().url 而不是只留文本：夹具里那张失效图**必然**产生一条
 * 404 控制台错误（这正是我们要验证的降级路径）。只有能按 URL 把这条
 * 预期噪音挑出来，「无控制台错误」才是一条有意义的断言 —— 否则要么
 * 放过真错误，要么因为预期噪音而永远失败。
 */
const errors = [];
page.on('console', m => {
  if (m.type() === 'error') errors.push({ text: m.text(), url: m.location()?.url || '' });
});
page.on('pageerror', e => errors.push({ text: String(e), url: '' }));

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  · 截图 ${name}.png`);
}

await page.goto(base + '/chat/img1', { waitUntil: 'networkidle' });
// 等图片加载状态稳定（成功那张 onLoad、失败那张 onError）
await page.waitForTimeout(2000);

console.log('\n[1] 生图气泡渲染');
const bubbles = await page.locator('[data-image-bubble]').count();
ok(bubbles === 2, '渲染出 2 个图片气泡', `count=${bubbles}`);

console.log('\n[2] 可用的图真的加载成功');
const loaded = await page.evaluate(() => {
  const img = document.querySelector('img[src*="ok.png"]');
  if (!img) return { found: false };
  return { found: true, complete: img.complete, w: img.naturalWidth, h: img.naturalHeight };
});
ok(loaded.found, '找到 ok.png 的 <img>');
ok(loaded.found && loaded.complete && loaded.w > 0, '图片解码成功（naturalWidth > 0）', JSON.stringify(loaded));

console.log('\n[3] 图下说明');
ok((await page.getByText('一只戴墨镜的橘猫，扁平插画风格').count()) >= 1, '显示生成提示词');
ok((await page.getByText('1344x768', { exact: false }).count()) >= 1, '显示尺寸');
ok((await page.getByText('cogview-3-flash', { exact: false }).count()) >= 1, '显示生图模型');

console.log('\n[4] 加载失败降级');
ok((await page.getByText('图像无法加载', { exact: false }).count()) === 1, '失效图走降级界面');
ok((await page.getByText('尝试打开原始链接', { exact: false }).count()) === 1, '降级界面给出原始链接入口');

console.log('\n[5] 生图消息专属头像');
const imageAvatars = await page.locator('[title="图像生成"]').count();
ok(imageAvatars === 2, '两条生图消息都用专属头像（不是 Hermes 头像）', `count=${imageAvatars}`);

console.log('\n[6] 输入区切到生图模式');
// TDesign 的 Select 把选中项渲染成 <input> 的 value（不是文本节点），
// 所以这里读 value 而不是用 getByText —— 后者对 Select 是无效断言。
const selectValues = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.t-select input.t-input__inner')).map(el => el.value)
);
ok(selectValues.includes('CogView-3-Flash'), '生图模型选择器已渲染且选中默认模型', selectValues.join(' | '));
ok(selectValues.includes('正方形 1024×1024'), '尺寸选择器已渲染且选中默认正方形', selectValues.join(' | '));
ok(!selectValues.includes('GLM-4.7'), '生图模式下不再显示文本模型选择器', selectValues.join(' | '));
await shot('image-chat');

console.log('\n[7] 控制台');
const others = errors.filter(e => !e.url.includes('missing.png'));
ok(
  errors.some(e => e.url.includes('missing.png')),
  '夹具中的失效图确实走了加载失败路径'
);
ok(others.length === 0, '除预期的失效图 404 外无其它控制台错误', others.map(e => e.text).slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n✗ 生图消息渲染断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`);
  process.exit(1);
}
console.log(`\n生图消息渲染断言：${checks.total}/${checks.total} 通过`);
