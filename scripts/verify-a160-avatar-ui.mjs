/**
 * A160 验证：上传本地图片作为「我的头像」与「Agent Logo」（浏览器）。
 *
 * 需求原话：允许用户把自己上传的本地图片设成各 Agent 的 logo，以及自己头像。
 *
 * 服务端的安全与去重由 `verify-a160-avatar-store.ts` 覆盖；这里只测
 * 「界面真的能走到那条接口」，以及用户可见的三件事：
 *
 *   [1] Agent 资料页有「更换 Logo」入口；未上传时没有「恢复默认」
 *   [2] 选文件 → 裁剪对话框 → 导出 320×320 WebP → POST /api/avatars
 *   [3] 上传后资料页与通讯录列表都换成新图（不是只改了资料页）
 *   [4] 「恢复默认」发 DELETE，界面退回官方 logo
 *   [5] 我的资料：上传 / 移除图片，图片优先于预设、移除后回到预设
 *   [6] 深色主题下新头像仍有描边（不是一块没有边界的图）
 *
 * 运行：node scripts/verify-a160-avatar-ui.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
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

/**
 * 夹具：两个 Agent。
 * workbuddy 用官方 logo（用来验证「恢复默认」退回到什么）；
 * claude 只用来让通讯录不是单行。
 */
function agentFixtures(logoUrl) {
  return [
    {
      id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy',
      color: '#0EC8A9', description: 'x', capabilities: ['chat'],
      status: { availability: 'ready', version: '1' },
      ...(logoUrl ? { logoUrl } : {}),
    },
    {
      id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude',
      color: '#D97757', description: 'x', capabilities: ['chat'],
      status: { availability: 'ready', version: '1' },
    },
  ];
}

const SESSIONS = [{ id: 's1', title: 'WorkBuddy', agent_id: 'workbuddy', model: 'm', created_at: new Date().toISOString() }];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const UPLOADED = '/api/avatars/' + 'a'.repeat(40) + '.webp';

/** 服务端状态：夹具随上传/恢复在内存里翻转 */
const state = { logoUrl: null, avatarImage: '' };

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

/** 给 setInputFiles 用的一张真实 PNG（1×1 足够：裁剪会放大到 320） */
const SAMPLE_PNG = join(OUT, 'a160-sample.png');
await writeFile(
  SAMPLE_PNG,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const requests = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const method = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents\/probe/.test(url)) return json({ agents: agentFixtures(state.logoUrl) });
    if (/\/api\/agents\/([^/]+)\/logo$/.test(url) && method === 'DELETE') {
      requests.push({ path: 'agent-logo-delete', agentId: url.match(/\/api\/agents\/([^/]+)\/logo$/)[1] });
      state.logoUrl = null;
      return json({ ok: true });
    }
    if (/\/api\/agents(\?|$)/.test(url)) return json({ agents: agentFixtures(state.logoUrl) });
    if (url.includes('/api/avatars')) {
      if (method === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        requests.push({ path: 'avatar-post', ...body });
        if (body.kind === 'user') {
          state.avatarImage = UPLOADED;
          return json({ url: UPLOADED, profile: { nickname: '', avatar: '', avatarImage: UPLOADED } });
        }
        state.logoUrl = UPLOADED;
        return json({ url: UPLOADED, agentId: body.agentId });
      }
      if (method === 'DELETE') {
        requests.push({ path: 'avatar-delete' });
        state.avatarImage = '';
        return json({ ok: true, profile: { nickname: '', avatar: '', avatarImage: '' } });
      }
    }
    if (url.includes('/api/user-profile')) {
      if (method === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        requests.push({ path: 'profile-put', ...body });
        state.avatarImage = body.avatarImage ?? state.avatarImage;
        return json({ nickname: body.nickname ?? '', avatar: body.avatar ?? '', avatarImage: state.avatarImage });
      }
      return json({ nickname: '', avatar: '', avatarImage: state.avatarImage });
    }
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/** 通讯录 → 资料页 */
async function openDetail(page, id = 'workbuddy') {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.locator('nav button[aria-label="通讯录"]').click();
  await page.waitForTimeout(600);
  const row = page.locator(`[data-agent-row="${id}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 8000 });
  await row.click();
  await page.waitForTimeout(700);
}

/** 走一遍「选文件 → 裁剪 → 确认」 */
async function uploadThroughCrop(page, inputSelector, confirmSelector) {
  await page.locator(inputSelector).setInputFiles(SAMPLE_PNG);
  await page.locator('[data-avatar-crop]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  await page.locator(confirmSelector).click();
  await page.waitForTimeout(700);
}

// ============= [1]-[4] Agent Logo =============
console.log('\n[1]-[4] Agent Logo：入口、上传、全界面生效、恢复默认');
{
  state.logoUrl = null;
  state.avatarImage = '';
  const { ctx, page, errors } = await newPage();
  await openDetail(page);

  ok(await page.locator('[data-agent-logo-upload]').count() === 1, '资料页有「更换 Logo」入口');
  ok(await page.locator('[data-agent-logo-reset]').count() === 0, '没有自定义 Logo 时不显示「恢复默认」');
  ok(await page.locator('[data-agent-avatar-image]').count() === 0, '默认渲染官方 logo（不是用户图）');

  await uploadThroughCrop(page, '[data-agent-logo-file]', '[data-avatar-crop-confirm]');

  const post = requests.find(r => r.path === 'avatar-post' && r.kind === 'agent');
  ok(!!post, '发出了 POST /api/avatars（kind=agent）', post ? JSON.stringify({ kind: post.kind, agentId: post.agentId }) : 'none');
  ok(!!post && post.agentId === 'workbuddy', '请求带上了 agentId', post?.agentId);
  ok(!!post && typeof post.dataUrl === 'string' && post.dataUrl.startsWith('data:image/webp;base64,'),
    '上传的是 WebP dataUrl', post ? post.dataUrl.slice(0, 30) : 'none');

  // 尺寸：真正解码这张 WebP，确认是 320×320（不是原始 1×1，也不是别的尺寸）
  const size = post
    ? await page.evaluate(async d => {
        const img = new Image();
        img.src = d;
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
      }, post.dataUrl)
    : [0, 0];
  ok(size[0] === 320 && size[1] === 320, '裁剪产物是 320×320', `${size[0]}×${size[1]}`);

  await page.waitForTimeout(600);
  const detailSrc = await page.locator('[data-agent-detail-page] [data-agent-avatar-image]').first().getAttribute('src');
  ok(detailSrc === UPLOADED, '资料页头像换成上传的图', String(detailSrc));
  ok(await page.locator('[data-agent-logo-reset]').count() === 1, '上传后出现「恢复默认」');

  // 深色：描边必须还在（白图压白底会糊成一片）
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(300);
  const ring = await page.locator('[data-agent-avatar] [data-agent-avatar-image]').first().evaluate(img => {
    const box = img.closest('[data-agent-avatar]');
    return { shadow: getComputedStyle(box).boxShadow, fit: getComputedStyle(img).objectFit };
  });
  ok(ring.shadow && ring.shadow !== 'none', '深色下头像有描边（不是无边界色块）', ring.shadow);
  ok(ring.fit === 'cover', '自定义 Logo 圆形铺满（cover）', ring.fit);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // 回到通讯录：列表行也必须同步
  await page.locator('[data-detail-back]').click();
  await page.waitForTimeout(600);
  const listSrc = await page.locator('[data-agent-row="workbuddy"] [data-agent-avatar-image]').first().getAttribute('src');
  ok(listSrc === UPLOADED, '通讯录列表同步换成新 Logo', String(listSrc));

  // 恢复默认
  await page.locator('[data-agent-row="workbuddy"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-agent-logo-reset]').click();
  await page.waitForTimeout(700);
  const del = requests.find(r => r.path === 'agent-logo-delete');
  ok(!!del && del.agentId === 'workbuddy', '发出 DELETE /api/agents/:id/logo', JSON.stringify(del ?? null));
  ok(await page.locator('[data-agent-logo-reset]').count() === 0, '恢复后「恢复默认」入口消失');
  const backSrc = await page.locator('[data-agent-detail-page] [data-agent-avatar] img').first().getAttribute('src');
  ok(backSrc && !backSrc.startsWith('/api/avatars/'), '头像退回官方 logo（不再是上传图）', String(backSrc));

  const realErrors = errors.filter(e => !/Failed to load resource|404/.test(e));
  ok(realErrors.length === 0, '页面无额外 JS 报错', realErrors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

// ============= [5] 我的资料：上传 / 移除 =============
console.log('\n[5] 我的资料：图片优先于预设，移除后回到预设');
{
  state.avatarImage = '';
  requests.length = 0;
  const { ctx, page } = await newPage();
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('[data-settings-section="profile"]').click();
  await page.waitForTimeout(500);

  ok(await page.locator('[data-user-avatar-upload]').count() === 1, '「上传图片」入口在');
  ok(await page.locator('[data-user-avatar-remove]').count() === 0, '没上传时不显示「移除图片」');

  await uploadThroughCrop(page, '[data-user-avatar-file]', '[data-avatar-crop-confirm]');
  const post = requests.find(r => r.path === 'avatar-post' && r.kind === 'user');
  ok(!!post && typeof post.dataUrl === 'string' && post.dataUrl.startsWith('data:image/webp'),
    '用户头像也走同一套 WebP 上传', post ? post.dataUrl.slice(0, 30) : 'none');

  await page.waitForTimeout(500);
  const img = await page.locator('[data-user-avatar="image"] img').first().getAttribute('src');
  ok(img === UPLOADED, '大头像换成上传图', String(img));
  ok(await page.locator('[data-user-avatar-remove]').count() === 1, '上传后出现「移除图片」');

  await page.locator('[data-user-avatar-remove]').click();
  await page.waitForTimeout(600);
  const del = requests.find(r => r.path === 'avatar-delete');
  ok(!!del, '发出 DELETE /api/avatars');
  ok(await page.locator('[data-user-avatar="image"]').count() === 0, '移除后回到预设/首字（不是空白）');
  await ctx.close();
}

// ============= 汇总 =============
await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
