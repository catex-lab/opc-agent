/**
 * A160 验证：头像 / Logo 服务端仓库。
 *
 * 需求：用户可以把本地图片传成「自己的头像」和「每个 Agent 的 Logo」。
 * 浏览器闸门能证明「按钮点了、请求发了」，但真正决定安全与正确性的是
 * 服务端这一层 —— 只信任前端的 mime 等于允许任意字节写盘，删除旧图时
 * 忘了「还有别人引用」会把共用图一起删掉。所以这里单独测：
 *
 *   [1] dataUrl 解析：只收 PNG/JPEG/WebP，且声明必须与文件头一致
 *   [2] 体积上限 / 空内容
 *   [3] 内容哈希去重 + 先写临时文件再 rename（不留半张图）
 *   [4] 目录穿越白名单
 *   [5] Agent Logo 映射：设置 / 读取 / 恢复默认
 *   [6] 删除旧图时按「无人引用」决定是否真删（用户头像与 Agent 可能共用）
 *   [7] 用户资料只接受服务端自己发的 `/api/avatars/<file>` 形状
 *
 * 运行：npm run verify:a160-avatar-store（写临时 OPC_DATA_DIR，不碰真实 data/）
 */
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在 import 之前设好：paths.ts 在模块加载时读环境变量
const TMP = mkdtempSync(join(tmpdir(), 'opc-a160-avatar-'));
process.env.OPC_DATA_DIR = TMP;

const {
  decodeAvatarDataUrl,
  storeAvatar,
  setAgentLogo,
  getAgentLogoUrl,
  clearAgentLogo,
  deleteAvatarFileIfUnused,
  agentAppearanceSnapshot,
  MAX_AVATAR_BYTES,
} = await import('../server/avatar-store.ts');
const { avatarFilePath, avatarUrlOfFile, isSafeAvatarFile } = await import('../server/avatar-file.ts');
const { loadUserProfile, saveUserProfile, normalize } = await import('../server/user-profile.ts');

const failures: string[] = [];
let total = 0;
function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

// 真实的最小图片字节（浏览器裁剪产物就是这几类）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
const WEBP = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'base64'
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

// ── [1] dataUrl 解析 ─────────────────────────────────────────────────────
console.log('\n[1] dataUrl 解析：只收三种位图，且声明与文件头必须一致');
{
  ok(decodeAvatarDataUrl(dataUrl('image/png', PNG)).ext === 'png', 'PNG 收下');
  ok(decodeAvatarDataUrl(dataUrl('image/jpeg', JPEG)).ext === 'jpg', 'JPEG 收下');
  ok(decodeAvatarDataUrl(dataUrl('image/jpg', JPEG)).ext === 'jpg', 'image/jpg 别名收下');
  ok(decodeAvatarDataUrl(dataUrl('image/webp', WEBP)).ext === 'webp', 'WebP 收下');

  for (const [label, value] of [
    ['SVG 拒绝（内嵌脚本可 XSS）', dataUrl('image/svg+xml', SVG)],
    ['GIF 拒绝（需求只收静态图）', dataUrl('image/gif', GIF)],
    ['空串拒绝', ''],
    ['不是 dataUrl 拒绝', 'https://example.com/a.png'],
  ] as const) {
    let threw = false;
    try {
      decodeAvatarDataUrl(value);
    } catch {
      threw = true;
    }
    ok(threw, label);
  }

  // 声明 webp、内容其实是 png —— 不能因为「声明合法」就放行
  let mismatch = false;
  try {
    decodeAvatarDataUrl(dataUrl('image/webp', PNG));
  } catch {
    mismatch = true;
  }
  ok(mismatch, '声明与文件头不一致时拒绝');
}

// ── [2] 体积上限 ────────────────────────────────────────────────────────
console.log('\n[2] 体积上限');
{
  // 保留合法 PNG 头，把体量撑到上限以上
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES + 1)]);
  let threw = false;
  try {
    decodeAvatarDataUrl(dataUrl('image/png', big));
  } catch {
    threw = true;
  }
  ok(threw, `超过 ${(MAX_AVATAR_BYTES / 1024 / 1024).toFixed(0)}MB 拒绝`);

  let emptyThrew = false;
  try {
    decodeAvatarDataUrl(dataUrl('image/png', Buffer.alloc(0)));
  } catch {
    emptyThrew = true;
  }
  ok(emptyThrew, '空内容拒绝');
}

// ── [3] 去重 + 原子写 ───────────────────────────────────────────────────
console.log('\n[3] 内容哈希去重 + 原子写');
{
  const first = storeAvatar(dataUrl('image/png', PNG));
  const again = storeAvatar(dataUrl('image/png', PNG));
  ok(first.file === again.file, '同一张图两次上传得到同一个文件名', first.file);
  ok(isSafeAvatarFile(first.file), '文件名满足白名单');
  ok(existsSync(avatarFilePath(first.file)), '文件确实落盘');

  const files = readdirSync(join(TMP, 'avatars'));
  ok(files.filter(f => f.endsWith('.tmp') || f.includes('.tmp-')).length === 0, '没有残留临时文件', files.join(', '));
  ok(files.length === 1, '第二张同内容图没有产生副本', String(files.length));

  const webp = storeAvatar(dataUrl('image/webp', WEBP));
  ok(webp.file.endsWith('.webp'), '扩展名跟随真实类型', webp.file);
}

// ── [4] 目录穿越 ────────────────────────────────────────────────────────
console.log('\n[4] 目录穿越白名单');
{
  for (const bad of ['../../server/index.ts', '../user-profile.json', 'a.png', 'abc.png', '/etc/passwd']) {
    let threw = false;
    try {
      avatarFilePath(bad);
    } catch {
      threw = true;
    }
    ok(threw, `拒绝非法文件名 ${bad}`);
  }
  ok(!isSafeAvatarFile('..%2f..%2findex.ts'), '编码过的穿越也不在白名单内');
}

// ── [5] Agent Logo 映射 ─────────────────────────────────────────────────
console.log('\n[5] Agent Logo：设置 / 读取 / 恢复默认');
{
  const { file } = storeAvatar(dataUrl('image/webp', WEBP));
  const url = setAgentLogo('agent-x', file);
  ok(url === avatarUrlOfFile(file), 'set 返回 URL', url);
  ok(getAgentLogoUrl('agent-x') === url, 'get 读回同一个 URL');
  ok(getAgentLogoUrl('agent-y') === undefined, '没设置的 Agent 返回 undefined（界面退回内置图标）');
  ok(Object.keys(agentAppearanceSnapshot()).length === 1, '映射只写了一条');

  const released = clearAgentLogo('agent-x');
  ok(released === file, '恢复默认返回被释放的文件名');
  ok(getAgentLogoUrl('agent-x') === undefined, '恢复后回到内置图标');
  ok(existsSync(join(TMP, 'agent-appearance.json')), '映射文件落盘');
}

// ── [6] 共用图片的删除保护 ──────────────────────────────────────────────
console.log('\n[6] 删除旧图按「无人引用」判断');
{
  const { url, file } = storeAvatar(dataUrl('image/png', PNG));
  saveUserProfile({ avatarImage: url });
  ok(loadUserProfile().avatarImage === url, '用户头像用了这张图');

  // 让 Agent 也用同一张图
  setAgentLogo('agent-shared', file);
  ok(getAgentLogoUrl('agent-shared') === url, 'Agent 也用了同一张图');

  clearAgentLogo('agent-shared');
  deleteAvatarFileIfUnused(file);
  ok(existsSync(avatarFilePath(file)), '用户还在用 → 文件保留');

  // 用户也移除后才真正删
  saveUserProfile({ avatarImage: '' });
  deleteAvatarFileIfUnused(file);
  ok(!existsSync(avatarFilePath(file)), '无人引用 → 文件删除');
}

// ── [7] 用户资料字段收敛 ────────────────────────────────────────────────
console.log('\n[7] 用户资料只接受自家头像 URL');
{
  ok(normalize({ avatarImage: '/api/avatars/abc.png' }).avatarImage === '', '非十六进制文件名不落盘');
  ok(normalize({ avatarImage: 'https://evil.example/a.png' }).avatarImage === '', '外链不落盘');
  ok(normalize({ avatarImage: '/api/avatars/../../x.webp' }).avatarImage === '', '../ 不落盘');
  const good = 'a'.repeat(40) + '.webp';
  ok(
    normalize({ avatarImage: `/api/avatars/${good}` }).avatarImage === `/api/avatars/${good}`,
    '合法 URL 原样收下'
  );
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
