/**
 * 群聊自定义头像 + 成员拼贴默认头像（2026-11-12）验证。
 *
 * 需求（批准稿）：GroupAvatar 渲染链 = 自定义上传图片 > 预设 emoji（A115）>
 * 成员拼贴（新默认，取前 4 位）> Users 图标（无成员兜底）；上传复用 A160 的
 * /api/avatars 基建（服务端按 sessionId 登记引用、移除时自动回收）。
 *
 * 三层：
 *   [S] 源码契约 —— 拼贴 areas 按 1/2/3/4 人切换、grid 列/行随人数收放、
 *       优先级链顺序、三个调用点都传 members + image、拼贴内 showStatus=false、
 *       sessionFlags 三件套、服务端登记/GC 接线。areas 语义用纯函数判定，
 *       并内含反向探针：判据本身必须拒绝写错的 areas 变体。
 *   [F] 服务端仓库实跑 —— tsx 子进程 + 临时 OPC_DATA_DIR（不碰真实 data/）：
 *       登记的文件不会被 GC 误删；解除登记后无人引用才真删；
 *       群与用户头像共用同图时，移除一方不能弄丢另一方。
 *   [B] 浏览器 —— 夹具群会话（4/3/2/1 人）渲染拼贴并量真实坐标；
 *       上传 → 裁剪 → POST(kind=group) → 三处变 cover；移除 → DELETE → 回拼贴；
 *       坏图 URL 落回拼贴；「恢复默认」一次清空图片与预设。
 *
 * 运行：node scripts/verify-group-avatar.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
const read = f => readFileSync(join(ROOT, f), 'utf-8');

// ═══════════════════════════ [S] 源码契约 ═══════════════════════════
console.log('\n[S] 源码契约');

const userAvatarSrc = read('src/components/UserAvatar.tsx');
// 从 members 接口切起：COLLAGE_AREAS 常量与 GroupAvatar 函数都在这个区间里
const groupBody = userAvatarSrc.slice(
  userAvatarSrc.indexOf('export interface GroupAvatarMember'),
  userAvatarSrc.indexOf('export function groupAvatarMembersOf')
);

// ── S1：拼贴 areas 语义（1/2/3/4 人）────────────────────────────────
// 纯函数判 areas 串的**布局语义**，不钉字符串字面量本身。
function parseAreas(spec) {
  // '"a b" "a c"' → [['a','b'],['a','c']]
  return [...spec.matchAll(/"([^"]*)"/g)].map(m => m[1].trim().split(/\s+/));
}
/** 3 人 = 左大右二：左格跨两行占满左列，右列上下各一格 */
const isLeftBigRightTwo = rows =>
  rows.length === 2 &&
  rows[0].length === 2 &&
  rows[1].length === 2 &&
  rows[0][0] === 'a' &&
  rows[1][0] === 'a' &&
  rows[0][1] === 'b' &&
  rows[1][1] === 'c';
/** 2 人 = 上下均分：一行一格（单列两行） */
const isTopBottom = rows =>
  rows.length === 2 && rows[0].length === 1 && rows[1].length === 1 && rows[0][0] === 'a' && rows[1][0] === 'b';
/** 4 人 = 2×2 均分 */
const isQuad = rows =>
  rows.length === 2 &&
  rows[0].join(',') === 'a,b' &&
  rows[1].join(',') === 'c,d';

{
  const m3 = groupBody.match(/3:\s*'("[a-d]\s[a-d]"\s*"[a-d]\s[a-d]")'/);
  const m2 = groupBody.match(/2:\s*'("(?:[a-d]\s)+[a-d]"|"[a-d]"(?:\s*"[a-d]")*)'/);
  const m4 = groupBody.match(/4:\s*'("[a-d]\s[a-d]"\s*"[a-d]\s[a-d]")'/);
  ok(!!m3 && isLeftBigRightTwo(parseAreas(m3[1])), '3 人 areas = 左大右二（a 跨两行，b/c 右列）', m3?.[1]);
  ok(!!m2 && isTopBottom(parseAreas(m2[1])), '2 人 areas = 上下均分（单列两行）', m2?.[1]);
  ok(!!m4 && isQuad(parseAreas(m4[1])), '4 人 areas = 2×2 均分', m4?.[1]);

  // ★ 反向探针（自含）：判据必须抓得住写错的 areas —— 每个变体都是一次
  // 真实的回归方向（顺序对调 / 列数写错 / 少一格）。
  const bad = [
    ['3 人左右对调', '"b a" "c a"', isLeftBigRightTwo],
    ['3 人列数写错', '"a b c"', isLeftBigRightTwo],
    ['2 人并排而非上下', '"a b"', isTopBottom],
    ['4 人少一格', '"a b" "c"', isQuad],
  ];
  const caught = bad.filter(([, spec, judge]) => !judge(parseAreas(spec)));
  ok(
    caught.length === bad.length,
    '★ 反向探针：areas 判据拒绝写错的布局变体（4/4）',
    `${caught.length}/${bad.length} 被拒：${bad.map(b => b[0]).join('、')}`
  );
}

// ── S2：grid 列/行随人数收放 ────────────────────────────────────────
{
  ok(
    /gridTemplateColumns:\s*n >= 3 \? '1fr 1fr' : '1fr'/.test(groupBody),
    '列数随人数切换：3/4 人两列，1/2 人单列'
  );
  ok(
    /gridTemplateRows:\s*n === 1 \? '1fr' : '1fr 1fr'/.test(groupBody),
    '行数随人数切换：1 人单行，其余两行'
  );
  ok(/n > 1 \? \{ gridTemplateAreas/.test(groupBody), '1 人不引用具名 area（独占整圆）');
  ok(
    /data-group-avatar="image"/.test(groupBody) &&
      /data-group-avatar=\{preset\.id\}/.test(groupBody) &&
      /data-group-avatar="collage"/.test(groupBody) &&
      /data-group-avatar="default"/.test(groupBody),
    'data-group-avatar 四档取值齐备（image/预设 id/collage/default）'
  );
}

// ── S3：优先级链顺序 image > preset > collage > fallback ────────────
{
  const pImage = groupBody.indexOf('// ── ① 自定义图片');
  const pPreset = groupBody.indexOf('// ── ② 预设 emoji');
  const pCollage = groupBody.indexOf('// ── ③ 成员拼贴');
  const pFallback = groupBody.indexOf('// ── ④ 兜底');
  ok(
    pImage > -1 && pImage < pPreset && pPreset < pCollage && pCollage < pFallback,
    '渲染分支顺序：图片 > 预设 > 拼贴 > 兜底',
    [pImage, pPreset, pCollage, pFallback].join(' < ')
  );
  ok(
    /const showImage = !!customSrc && !imageBroken;/.test(groupBody) &&
      /const collage = !showImage && !preset && members/.test(groupBody),
    '拼贴只在「无图无预设且有成员」时接管（优先级由分支前置条件保证）'
  );
  ok(/onError\=\{\(\) => setImageBroken\(true\)\}/.test(groupBody), '图片加载失败自动落回下一优先级（不留空圆）');
}

// ── S4：三个调用点都传 members（且都接了 image）─────────────────────
{
  const callers = [
    ['src/components/ConversationList.tsx', '会话列表'],
    ['src/components/GroupChatHeader.tsx', '群聊头部'],
    ['src/components/ContactsPanel.tsx', '通讯录群行'],
  ];
  for (const [file, label] of callers) {
    const src = read(file);
    const blocks = [...src.matchAll(/<GroupAvatar\b[\s\S]*?\/>/g)].map(m => m[0]);
    ok(
      blocks.length >= 1 && blocks.every(b => b.includes('members=') && b.includes('image=')),
      `${label}：每处 GroupAvatar 都传 members 与 image`,
      blocks.length ? `${blocks.length} 处` : '没有调用'
    );
  }
  ok(
    /export function groupAvatarMembersOf/.test(userAvatarSrc),
    '提供 groupAvatarMembersOf（agentIds → members 的统一映射）'
  );
}

// ── S5：拼贴格子的 AgentAvatar 一律 showStatus=false ─────────────────
{
  const agentAvatarCalls = [...groupBody.matchAll(/<AgentAvatar\b[^>]*>/g)].map(m => m[0]);
  ok(
    agentAvatarCalls.length >= 2 &&
      agentAvatarCalls.every(c => /showStatus=\{false\}/.test(c)),
    '拼贴内所有 AgentAvatar 都显式 showStatus={false}（批准稿：42px 塞 4 颗状态点会花掉）',
    `${agentAvatarCalls.length} 处`
  );
  // ★ 反向探针（自含）：判据必须能发现缺了 showStatus={false} 的调用
  const mutated = agentAvatarCalls.map(c => c.replace(/\s*showStatus=\{false\}/, ''));
  ok(
    !mutated.every(c => /showStatus=\{false\}/.test(c)),
    '★ 反向探针：判据对「删掉 showStatus={false}」敏感（非恒真）'
  );
}

// ── S6：sessionFlags 三件套 ─────────────────────────────────────────
{
  const flagsSrc = read('src/sessionFlags.ts');
  ok(/avatarImage\?: string/.test(flagsSrc), 'SessionFlags.avatarImage 字段存在');
  ok(/export function setGroupAvatarImage\(/.test(flagsSrc), 'setGroupAvatarImage 存在');
  ok(/export function useGroupAvatarImage\(/.test(flagsSrc), 'useGroupAvatarImage 存在');
  ok(
    /if \(!flags\.avatarImage\) delete flags\.avatarImage;/.test(flagsSrc),
    '空串清理与 avatar 同款（patch 里不留空壳）'
  );
  ok(
    /export async function uploadGroupAvatar\(/.test(read('src/avatarApi.ts')) &&
      /export async function removeGroupAvatar\(/.test(read('src/avatarApi.ts')),
    'avatarApi 提供 uploadGroupAvatar / removeGroupAvatar'
  );
}

// ── S7：服务端登记 / GC 接线 ─────────────────────────────────────────
{
  const storeSrc = read('server/avatar-store.ts');
  const indexSrc = read('server/index.ts');
  ok(
    /export function setGroupAvatarFile\(/.test(storeSrc) &&
      /export function clearGroupAvatarFile\(/.test(storeSrc),
    'avatar-store 提供群引用登记 / 解除'
  );
  ok(
    /function isFileReferenced\(file: string\): boolean \{[\s\S]*?groupAvatars\(\)/.test(storeSrc),
    'isFileReferenced 把群登记算进「还有没有人用」（共用图不被误删）'
  );
  ok(
    /kind !== "user" && kind !== "agent" && kind !== "group"/.test(indexSrc),
    'POST /api/avatars 接受 kind=group'
  );
  ok(
    /app\.delete\("\/api\/avatars\/group\/:sessionId"/.test(indexSrc),
    'DELETE /api/avatars/group/:sessionId 存在'
  );
  ok(
    /setGroupAvatarFile\(sessionId, file\)/.test(indexSrc) &&
      /clearGroupAvatarFile\(req\.params\.sessionId\)/.test(indexSrc),
    '上传登记引用、移除解除引用（GC 才有依据）'
  );
}

// ═════════════════════ [F] 服务端仓库实跑（tsx 子进程） ═════════════════════
console.log('\n[F] 服务端仓库实跑（临时 OPC_DATA_DIR，不碰真实 data/）');
{
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const checkPath = join(ROOT, '.tmp', 'verify-group-avatar-store.check.ts');
  await writeFile(
    checkPath,
    `/**
 * 由 scripts/verify-group-avatar.mjs 生成：群头像引用登记 / GC 语义实跑。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'opc-gav-store-'));
process.env.OPC_DATA_DIR = TMP;

const { storeAvatar, setGroupAvatarFile, clearGroupAvatarFile, deleteAvatarFileIfUnused, groupAvatarSnapshot }
  = await import('../server/avatar-store.ts');
const { avatarFilePath, avatarUrlOfFile } = await import('../server/avatar-file.ts');
const { saveUserProfile } = await import('../server/user-profile.ts');

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) { failures.push(label); console.log('  x ' + label + (detail ? ' - ' + detail : '')); }
  else console.log('  . ' + label + (detail ? ' - ' + detail : ''));
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const dataUrl = 'data:image/png;base64,' + PNG.toString('base64');

// 1) 登记后文件不被 GC 误删
const { file } = storeAvatar(dataUrl);
const url = setGroupAvatarFile('sess-a', file);
ok(url === avatarUrlOfFile(file), '登记返回 /api/avatars/<file> 形状', url);
ok(groupAvatarSnapshot()['sess-a']?.logo === file, '快照里看得到登记');
deleteAvatarFileIfUnused(file);
ok(existsSync(avatarFilePath(file)), '群还在用 → deleteAvatarFileIfUnused 不删');

// 2) 解除登记后无人引用才真删
const released = clearGroupAvatarFile('sess-a');
ok(released === file, '解除登记返回被释放的文件名');
deleteAvatarFileIfUnused(file);
ok(!existsSync(avatarFilePath(file)), '无人引用 → 文件真删');

// 3) 群与用户头像共用同图：一方移除不弄丢另一方
const again = storeAvatar(dataUrl); // 内容哈希 → 同图同文件
ok(again.file === file, '同内容图落同一个文件（共用图场景成立）');
setGroupAvatarFile('sess-b', again.file);
saveUserProfile({ avatarImage: avatarUrlOfFile(again.file) });
saveUserProfile({ avatarImage: '' }); // 用户移除自己的头像
deleteAvatarFileIfUnused(again.file);
ok(existsSync(avatarFilePath(again.file)), '用户移除后群还在用 → 文件保留');
clearGroupAvatarFile('sess-b');
deleteAvatarFileIfUnused(again.file);
ok(!existsSync(avatarFilePath(again.file)), '群也解除后才回收');

// 4) 非法输入
let threw = false;
try { setGroupAvatarFile('', file); } catch { threw = true; }
ok(threw, '空 sessionId 拒绝');
threw = false;
try { setGroupAvatarFile('sess-c', '../../evil.png'); } catch { threw = true; }
ok(threw, '非法文件名拒绝');

rmSync(TMP, { recursive: true, force: true });
console.log('RESULT ' + (total - failures.length) + '/' + total);
if (failures.length) process.exit(1);
`,
    'utf-8'
  );
  const ran = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), checkPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  const stdout = (ran.stdout || '') + (ran.stderr || '');
  const m = stdout.match(/RESULT (\d+)\/(\d+)/);
  ok(ran.status === 0 && !!m, '群引用登记 / GC 语义实跑通过', m ? `${m[1]}/${m[2]}` : `exit=${ran.status}\n${stdout.slice(0, 800)}`);
}

// ═══════════════════════════ [B] 浏览器 ═══════════════════════════
await mkdir(OUT, { recursive: true });

const GID = 'gav-grp-1';
// 真实 PNG 字节：上传后的头像 URL 必须真的能解码（GroupAvatar 坏图会自动
// 落回拼贴，假 URL 会让「变 cover」的断言永远测不到）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const UPLOADED = '/api/avatars/' + 'b'.repeat(40) + '.png';
const BROKEN = '/api/avatars/' + 'c'.repeat(40) + '.png';

const AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', vendor: '腾讯', kind: 'sdk', icon: 'workbuddy', color: '#0EC8A9', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', kind: 'cli', icon: 'claude', color: '#D97757', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
  { id: 'gemini', name: 'Gemini', vendor: 'Google', kind: 'cli', icon: 'gemini', color: '#5B8DEF', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
  { id: 'cursor', name: 'Cursor', vendor: 'Anysphere', kind: 'cli', icon: 'cursor', color: '#9CA3AF', description: 'x', capabilities: ['chat'], status: { availability: 'ready', version: '1' } },
];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];

/** 服务端状态：成员清单随场景翻转（「删掉一个成员自动重排」靠它） */
const state = { memberIds: ['workbuddy', 'claude', 'gemini', 'cursor'], avatarPosts: [], groupDeletes: [] };
const groupSession = () => ({
  id: GID,
  title: '研发小组',
  agent_id: null,
  model: '',
  kind: 'group',
  agent_ids: JSON.stringify(state.memberIds),
  orchestration: 'dispatch',
  created_at: new Date().toISOString(),
});

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

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
} catch {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}

/** 起一页：夹具 + /api/** 拦截 + 可选的本地 flags 种子 */
async function newPage({ flags = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(f => {
    try {
      if (f) localStorage.setItem('opc:sessionFlags', JSON.stringify(f));
    } catch { /* localStorage 被禁：当默认值 */ }
  }, flags);
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const method = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents\/probe/.test(url) || /\/api\/agents(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (url.includes('/api/user-profile')) {
      if (method === 'PUT') {
        const b = JSON.parse(route.request().postData() || '{}');
        return json({ nickname: b.nickname ?? '', avatar: b.avatar ?? '', avatarImage: b.avatarImage ?? '' });
      }
      return json({ nickname: '', avatar: '', avatarImage: '' });
    }
    if (method === 'POST' && url.includes('/api/avatars')) {
      const b = JSON.parse(route.request().postData() || '{}');
      state.avatarPosts.push(b);
      return json({ url: UPLOADED, sessionId: b.sessionId ?? null });
    }
    if (method === 'DELETE' && /\/api\/avatars\/group\/(.+)$/.test(url)) {
      state.groupDeletes.push(url.match(/\/api\/avatars\/group\/(.+)$/)[1]);
      return json({ ok: true, sessionId: decodeURIComponent(url.match(/\/api\/avatars\/group\/(.+)$/)[1]) });
    }
    // 头像文件：只有 UPLOADED 真的出图；BROKEN 模拟「服务端已回收」
    if (url.endsWith(UPLOADED)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES });
    }
    if (/\/api\/avatars\//.test(url)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"头像不存在"}' });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/').pop().split('?')[0];
      const s = id === GID ? groupSession() : null;
      return json({
        session: s,
        messages: s
          ? [{ id: 'm1', role: 'user', session_id: id, created_at: new Date().toISOString(), content: '开个会', model: 'm' }]
          : [],
      });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: [groupSession()] });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, errors };
}

/** 会话列表里那颗群头像的实况（含格子几何） */
async function collageLive(page, scopeSelector) {
  return page.evaluate(scope => {
    const scopeEl = scope ? document.querySelector(scope) : document;
    const root = scopeEl && scopeEl.querySelector('[data-group-avatar-collage]');
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const cells = [...root.querySelectorAll('[data-group-avatar-cell]')].map(c => {
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        // A132 教训：几何要配「真实坐标点下去真的命中这一格」
        hitInside: !!hit && (c === hit || c.contains(hit)),
        hasImg: !!c.querySelector('img'),
        id: c.getAttribute('data-group-avatar-cell'),
      };
    });
    return {
      mode: root.getAttribute('data-group-avatar'),
      w: rr.width,
      h: rr.height,
      radius: getComputedStyle(root).borderRadius,
      overflow: getComputedStyle(root).overflow,
      cells,
      statusDots: root.querySelectorAll('[data-status-dot]').length,
    };
  }, scopeSelector);
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

// ── B1：4 人拼贴（默认）─────────────────────────────────────────────
console.log('\n[B1] 4 人拼贴：4 格、2×2、圆形裁切、无状态点');
{
  const { ctx, page, errors } = await newPage({ flags: {} });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await page.waitForTimeout(400);
  const live = await collageLive(page, `[data-conversation-item="${GID}"]`);
  ok(!!live && live.mode === 'collage', '默认渲染成员拼贴（非兜底图标）', live?.mode ?? 'null');
  ok(!!live && live.cells.length === 4, '4 位成员 → 4 格', String(live?.cells.length));
  ok(!!live && live.statusDots === 0, '拼贴里不渲染状态点（showStatus=false 的 DOM 证据）');
  if (live && live.cells.length === 4) {
    const byId = Object.fromEntries(live.cells.map(c => [c.id, c]));
    const [m1, m2, m3, m4] = [byId.workbuddy, byId.claude, byId.gemini, byId.cursor];
    ok(near(m1.y, m2.y) && m1.x < m2.x, '第 1/2 格同排在上（左 / 右）', `y ${m1.y.toFixed(1)}≈${m2.y.toFixed(1)}`);
    ok(near(m3.x, m1.x) && m3.y > m1.y, '第 3 格在左下（与第 1 格同列）', `x ${m3.x.toFixed(1)}≈${m1.x.toFixed(1)}`);
    ok(near(m4.x, m2.x) && near(m4.y, m3.y), '第 4 格在右下（与第 3 格同排）');
    ok(near(m1.w, 19.5, 1.2) && near(m1.h, 19.5, 1.2), '每格 ≈ (42-2-1)/2 = 19.5px 均分', `${m1.w.toFixed(1)}×${m1.h.toFixed(1)}`);
    ok(near(live.w, 42, 0.6) && near(live.h, 42, 0.6), '整颗 42px（会话列表档）', `${live.w.toFixed(1)}×${live.h.toFixed(1)}`);
  }
  ok(!!live && live.cells.every(c => c.hitInside), '每格中心用 elementFromPoint 都命中自己（真实坐标）');
  ok(!!live && live.cells.every(c => c.hasImg), '每格都是 AgentAvatar 的 logo 图（4 个内置 logo 夹具）');
  ok(!!live && (live.radius === '50%' || parseFloat(live.radius) >= 20) && live.overflow === 'hidden', '整体圆形裁切（radius + overflow hidden）', `${live?.radius} / ${live?.overflow}`);
  await page.screenshot({ path: join(OUT, 'group-avatar-collage-4.png') });

  // ── B2：删掉一个成员 → 自动重排为 3 格（左大右二）──
  console.log('\n[B2] 成员变动自动重排：4 → 3（左大右二）');
  state.memberIds = ['workbuddy', 'claude', 'gemini'];
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await page.waitForTimeout(400);
  const live3 = await collageLive(page, `[data-conversation-item="${GID}"]`);
  ok(!!live3 && live3.cells.length === 3, '3 位成员 → 3 格（无需手动维护）', String(live3?.cells.length));
  ok(!!live3 && !live3.cells.some(c => c.id === 'cursor'), '被移出的成员格子消失');
  if (live3 && live3.cells.length === 3) {
    const byId = Object.fromEntries(live3.cells.map(c => [c.id, c]));
    const big = byId.workbuddy;
    const tb = byId.claude;
    const bb = byId.gemini;
    ok(near(big.h, tb.h * 2 + 1, 1.6), '左格高度 ≈ 右格两倍 + 1px 格隙（左大）', `${big.h.toFixed(1)} ≈ 2×${tb.h.toFixed(1)}+1`);
    ok(big.x < tb.x && near(tb.x, bb.x) && tb.y < bb.y, '右列上下各一格');
    ok(near(big.w, tb.w, 1.2), '左右列等宽（areas 只换行分配）', `${big.w.toFixed(1)} ≈ ${tb.w.toFixed(1)}`);
    ok(live3.statusDots === 0 && live3.cells.every(c => c.hitInside), '3 格同样无状态点、坐标命中');
  }
  await page.screenshot({ path: join(OUT, 'group-avatar-collage-3.png') });
  await ctx.close();
}

// ── B3：2 人上下均分 / B4：1 人独占 ─────────────────────────────────
console.log('\n[B3/B4] 2 人上下均分；1 人独占');
{
  state.memberIds = ['workbuddy', 'claude'];
  const { ctx, page } = await newPage({ flags: {} });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await page.waitForTimeout(400);
  const live2 = await collageLive(page, `[data-conversation-item="${GID}"]`);
  ok(!!live2 && live2.cells.length === 2, '2 位成员 → 2 格', String(live2?.cells.length));
  if (live2 && live2.cells.length === 2) {
    const [top, bottom] = live2.cells[0].y < live2.cells[1].y ? [live2.cells[0], live2.cells[1]] : [live2.cells[1], live2.cells[0]];
    ok(near(top.w, 40, 1.2) && near(bottom.w, 40, 1.2), '上下两格全宽（上下均分）', `${top.w.toFixed(1)}/${bottom.w.toFixed(1)}`);
    ok(near(top.h, 19.5, 1.2) && near(bottom.h, 19.5, 1.2) && bottom.y > top.y, '每格 ≈ 半高、上下排布', `${top.h.toFixed(1)}+${bottom.h.toFixed(1)}`);
    ok(live2.statusDots === 0, '2 格同样不渲染状态点');
  }
  await page.screenshot({ path: join(OUT, 'group-avatar-collage-2.png') });
  await ctx.close();

  state.memberIds = ['workbuddy'];
  const ctx2P = await newPage({ flags: {} });
  await ctx2P.page.goto(base + '/', { waitUntil: 'networkidle' });
  await ctx2P.page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await ctx2P.page.waitForTimeout(400);
  const live1 = await collageLive(ctx2P.page, `[data-conversation-item="${GID}"]`);
  ok(!!live1 && live1.cells.length === 1, '1 位成员 → 1 格', String(live1?.cells.length));
  ok(
    !!live1 && !!live1.cells[0] && near(live1.cells[0].w, 40, 1.2) && near(live1.cells[0].h, 40, 1.2),
    '独占整颗圆（40px 内容盒）',
    live1 && live1.cells[0] ? `${live1.cells[0].w.toFixed(1)}×${live1.cells[0].h.toFixed(1)}` : 'no cell'
  );
  await ctx2P.ctx.close();
}

// ── B5：优先级链 image > 预设 > 拼贴；坏图落回拼贴 ──────────────────
console.log('\n[B5] 优先级链与坏图回落');
state.memberIds = ['workbuddy', 'claude', 'gemini', 'cursor'];
{
  // a) 图 + 预设同时在 → 图赢
  const a = await newPage({ flags: { [GID]: { avatar: 'panda', avatarImage: UPLOADED } } });
  await a.page.goto(base + '/', { waitUntil: 'networkidle' });
  await a.page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await a.page.waitForTimeout(400);
  const modeA = await a.page.evaluate(scope => {
    const row = document.querySelector(scope);
    return row?.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null;
  }, `[data-conversation-item="${GID}"]`);
  ok(modeA === 'image', '自定义图片优先于预设', String(modeA));
  const imgInfo = await a.page.evaluate(scope => {
    const row = document.querySelector(scope);
    const img = row?.querySelector('[data-group-avatar-image]');
    if (!img) return null;
    const cs = getComputedStyle(img);
    return { fit: cs.objectFit, loaded: img.naturalWidth > 0, coversBox: img.getBoundingClientRect().width >= 40 };
  }, `[data-conversation-item="${GID}"]`);
  ok(!!imgInfo && imgInfo.fit === 'cover', '图片整圆 cover 铺满', imgInfo ? imgInfo.fit : 'no img');
  ok(!!imgInfo && imgInfo.loaded, '图片真的解码加载（不是坏图假绿）');
  ok(!!imgInfo && imgInfo.coversBox, '图片铺满头像框（宽度撑满 42px）');
  await a.ctx.close();

  // b) 只有预设 → 预设（A115 行为不回归）
  const b = await newPage({ flags: { [GID]: { avatar: 'panda' } } });
  await b.page.goto(base + '/', { waitUntil: 'networkidle' });
  await b.page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  const modeB = await b.page.evaluate(scope => {
    const row = document.querySelector(scope);
    return row?.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null;
  }, `[data-conversation-item="${GID}"]`);
  ok(modeB === 'panda', '只有预设时显示预设', String(modeB));
  await b.ctx.close();

  // c) 图 URL 404（服务端已回收）→ 自动落回拼贴，不是空圆
  const c = await newPage({ flags: { [GID]: { avatarImage: BROKEN } } });
  await c.page.goto(base + '/', { waitUntil: 'networkidle' });
  await c.page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await c.page.waitForTimeout(600);
  const modeC = await c.page.evaluate(scope => {
    const row = document.querySelector(scope);
    const av = row?.querySelector('[data-group-avatar]');
    return {
      mode: av?.getAttribute('data-group-avatar') ?? null,
      cells: av?.querySelectorAll('[data-group-avatar-cell]').length ?? 0,
    };
  }, `[data-conversation-item="${GID}"]`);
  ok(modeC.mode === 'collage' && modeC.cells === 4, '坏图 URL 自动落回成员拼贴', `${modeC.mode} / ${modeC.cells} 格`);
  await c.ctx.close();
}

// ── B6：群设置上传流程（选文件 → 裁剪 → POST → 三处变 cover → 移除回拼贴）──
console.log('\n[B6] 群设置：上传 → 三处生效 → 移除');
{
  state.memberIds = ['workbuddy', 'claude', 'gemini', 'cursor'];
  state.avatarPosts.length = 0;
  state.groupDeletes.length = 0;
  const SAMPLE_PNG = join(OUT, 'group-avatar-sample.png');
  await writeFile(SAMPLE_PNG, PNG_BYTES);

  const { ctx, page, errors } = await newPage({ flags: {} });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await page.locator(`[data-conversation-item="${GID}"]`).click();
  await page.locator('button[aria-label="群聊设置"]').click();
  await page.waitForTimeout(600);

  ok(await page.locator('[data-group-avatar-preview]').count() === 1, '72px 预览在（点头像也能传）');
  ok(await page.locator('[data-group-avatar-upload]').count() === 1, '「上传自定义头像」主按钮在');
  ok(await page.locator('[data-group-avatar-upload]').evaluate(el => el.classList.contains('tc-btn-brand')), '上传按钮走 .tc-btn-brand（32 档主按钮）');
  ok(await page.locator('[data-group-avatar-remove-image]').count() === 0, '没上传时不显示「移除自定义」');
  ok(await page.locator('[data-group-avatar-reset]').count() === 0, '没有任何自定义时不显示「恢复默认」');

  // A115 兼容：「使用预设」展开 12 枚预设
  await page.locator('[data-group-avatar-toggle]').click();
  await page.waitForTimeout(300);
  ok(await page.locator('[data-avatar-option]').count() === 12, '「使用预设」展开 A115 的 12 枚预设');

  // 选文件 → 裁剪 → 确认（A160 同款流程）
  await page.locator('[data-group-avatar-file]').setInputFiles(SAMPLE_PNG);
  await page.locator('[data-avatar-crop]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  await page.locator('[data-avatar-crop-confirm]').click();
  await page.waitForTimeout(900);

  const post = state.avatarPosts[state.avatarPosts.length - 1];
  ok(!!post && post.kind === 'group', '发出了 POST /api/avatars（kind=group）', post ? JSON.stringify({ kind: post.kind }) : 'none');
  ok(!!post && post.sessionId === GID, '请求带上 sessionId（服务端据此登记引用）', String(post?.sessionId));
  ok(!!post && typeof post.dataUrl === 'string' && post.dataUrl.startsWith('data:image/webp;base64,'), '上传的是裁剪后的 WebP dataUrl', post ? post.dataUrl.slice(0, 30) : 'none');

  const listMode = await page.evaluate(scope => {
    const row = document.querySelector(scope);
    return row?.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null;
  }, `[data-conversation-item="${GID}"]`);
  ok(listMode === 'image', '会话列表换成自定义图', String(listMode));
  await page
    .waitForSelector('[data-group-avatar="image"][aria-label="研发小组"]', { timeout: 8000 })
    .catch(() => null);
  const headerMode = await page.evaluate(() => {
    // 头部那颗带 aria-label（= 群名）；列表行不传 title，用它区分
    return document.querySelector('[data-group-avatar][aria-label="研发小组"]')?.getAttribute('data-group-avatar') ?? null;
  });
  ok(headerMode === 'image', '群聊头部同步（三处共用同一字段）', String(headerMode));
  const fit = await page.evaluate(() => {
    const img = document.querySelector('[data-group-avatar][aria-label="研发小组"] [data-group-avatar-image]');
    return img ? getComputedStyle(img).objectFit : null;
  });
  ok(fit === 'cover', '头部自定义图 cover 铺满（28px 小档）', String(fit));
  ok(await page.locator('[data-group-avatar-remove-image]').count() === 1, '上传后出现「移除自定义」');

  await page.locator('[data-group-avatar-remove-image]').click();
  await page.waitForTimeout(700);
  ok(state.groupDeletes.length === 1 && state.groupDeletes[0] === GID, '移除发出 DELETE /api/avatars/group/:sessionId', JSON.stringify(state.groupDeletes));
  const afterRemove = await page.evaluate(scope => {
    const row = document.querySelector(scope);
    return row?.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null;
  }, `[data-conversation-item="${GID}"]`);
  ok(afterRemove === 'collage', '移除后回到成员拼贴（不是空圆）', String(afterRemove));

  const realErrors = errors.filter(e => !/Failed to load resource|404/.test(e));
  ok(realErrors.length === 0, '上传/移除全程无 JS 报错', realErrors.slice(0, 2).join(' | ') || 'clean');
  await page.screenshot({ path: join(OUT, 'group-avatar-settings.png') });
  await ctx.close();
}

// ── B7：恢复默认一次清空图片与预设 ──────────────────────────────────
console.log('\n[B7] 恢复默认（成员拼贴）：清 image + preset');
{
  const flags = { [GID]: { avatar: 'rocket', avatarImage: UPLOADED } };
  const { ctx, page } = await newPage({ flags });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-conversation-item="${GID}"]`, { timeout: 10000 });
  await page.locator(`[data-conversation-item="${GID}"]`).click();
  await page.locator('button[aria-label="群聊设置"]').click();
  await page.waitForTimeout(600);
  ok(await page.locator('[data-group-avatar-reset]').count() === 1, '有预设/图片时出现「恢复默认（成员拼贴）」');
  await page.locator('[data-group-avatar-reset]').click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(gid => {
    const f = JSON.parse(localStorage.getItem('opc:sessionFlags') || '{}');
    const row = document.querySelector(`[data-conversation-item="${gid}"]`);
    return {
      avatar: f[gid]?.avatar ?? null,
      image: f[gid]?.avatarImage ?? null,
      rendered: row?.querySelector('[data-group-avatar]')?.getAttribute('data-group-avatar') ?? null,
      deletes: null,
    };
  }, GID);
  ok(after.avatar === null && after.image === null, 'sessionFlags 里 avatar 与 avatarImage 一起清空', JSON.stringify(after));
  ok(after.rendered === 'collage', '界面回到成员拼贴', String(after.rendered));
  ok(state.groupDeletes.includes(GID), '图片引用同步解除（服务端可回收）');
  await ctx.close();
}

await browser.close();
server.close();

// ═══════════════════════════ 汇总 ═══════════════════════════
console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
