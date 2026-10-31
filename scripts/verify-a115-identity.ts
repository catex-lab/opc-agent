/**
 * A115 验证：昵称真的会注入 systemPrompt（服务端）。
 *
 * 用户原话：「增加用户更换自己头像和昵称的功能，**昵称可以被 agent 识别**」。
 *
 * 「能被识别」这件事发生在服务端子进程里，浏览器验证脚本再逼真也测不到 ——
 * 它测的是「输入框能打字、PUT 发出去了」。所以这里单独测注入本身：
 *
 *   1. 空昵称时 systemPrompt 原样返回（不编一个「用户」占位 ——
 *      那等于告诉 Agent「这个人叫用户」，之后它就一直这么叫）
 *   2. 有昵称时**追加**而不是替换（场景模板 / Agent 人设都是用户显式选过的，
 *      我们这一行是补充信息，盖掉任何一句都是越权）
 *   3. 注入点只有一处（registry.stream/prewarm），漏一个适配器就会
 *      「有的 Agent 认得我、有的不认得」—— 那种不一致没有任何报错，
 *      只能靠读源码守。这里用 source 断言兜底。
 *
 * 运行：npm run verify:a115-identity（tsx，写临时 OPC_DATA_DIR，不碰真实 data/）
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在 import 之前设好：paths.ts 在**模块加载时**读这个环境变量，
// 晚一步设就指向仓库里真实的 data/ 了 —— 那会在真实用户库旁边
// 留下一个 user-profile.json，而且测的也不是干净初始态。
const TMP = mkdtempSync(join(tmpdir(), 'opc-a115-identity-'));
process.env.OPC_DATA_DIR = TMP;

const { withUserIdentity, loadUserProfile, saveUserProfile, normalize } = await import('../server/user-profile.ts');

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

// ── [1] 空昵称：原样返回 ────────────────────────────────────────────────
console.log('\n[1] 空昵称：systemPrompt 原样返回');
{
  const before = loadUserProfile();
  ok(before.nickname === '', '初始没有昵称（临时数据目录是干净的）', JSON.stringify(before));

  ok(withUserIdentity('你是助手。') === '你是助手。', '不追加任何东西');
  ok(withUserIdentity(undefined) === undefined, 'undefined 进 undefined 出（不变成空串）');
  ok(withUserIdentity('') === '', '空串进空串出');
}

// ── [2] 有昵称：追加，不替换 ────────────────────────────────────────────
console.log('\n[2] 有昵称：追加一段，原文一字不动');
{
  saveUserProfile({ nickname: '老王' });
  const out = withUserIdentity('你是助手。');
  ok(out !== undefined && out.startsWith('你是助手。'), '原文在前（没有被替换）', JSON.stringify(out));
  ok(out !== undefined && out.includes('与你对话的人叫「老王」'), '追加了称呼行', JSON.stringify(out));
  ok(out !== undefined && out.includes('\n\n---\n'), '用空行 + 分隔线隔开（读起来是独立的一段）');

  // undefined 也要能接上（Agent 没有人设时 systemPrompt 是 undefined）
  const fromUndef = withUserIdentity(undefined);
  ok(fromUndef !== undefined && fromUndef.includes('「老王」'), 'undefined + 昵称 = 只有这一行', JSON.stringify(fromUndef));
  ok(fromUndef !== undefined && !fromUndef.startsWith('\n\n'), '开头不留空行', JSON.stringify(fromUndef));

  // 落盘：重启（新进程）后还得在 —— 这是「服务端唯一事实来源」的意义
  const file = join(TMP, 'user-profile.json');
  ok(existsSync(file), '写进了 user-profile.json');
  if (existsSync(file)) {
    const disk = JSON.parse(readFileSync(file, 'utf-8'));
    ok(disk.nickname === '老王', '磁盘上的昵称是刚保存的那个', JSON.stringify(disk));
  }

  saveUserProfile({ nickname: '' });
  ok(withUserIdentity('你是助手。') === '你是助手。', '清空后又回到原样');
}

// ── [3] normalize 的边界 ────────────────────────────────────────────────
console.log('\n[3] normalize 边界');
{
  ok(normalize({ nickname: '  小明  ' }).nickname === '小明', '昵称 trim');
  ok(normalize({ nickname: 'x'.repeat(40) }).nickname.length === 24, '昵称最长 24 字');
  ok(normalize({ nickname: 42 as unknown as string }).nickname === '', '坏类型当没有（不抛错）');
  ok(normalize(null).nickname === '' && normalize(null).avatar === '', 'null 也能收敛');
  ok(normalize({ avatar: 'panda' }).avatar === 'panda', '头像 id 原样收');

  // A160：图片头像只认服务端自己发的 URL（手改文件塞外链 / 目录穿越都不落盘）
  ok(normalize(null).avatarImage === '', 'null 时图片头像为空串');
  ok(normalize({ avatarImage: '/api/avatars/' + 'a'.repeat(40) + '.webp' }).avatarImage.endsWith('.webp'),
    '合法的 /api/avatars/<hash>.webp 原样收');
  ok(normalize({ avatarImage: 'https://evil.example/x.png' }).avatarImage === '', '外链被丢掉');
  ok(normalize({ avatarImage: '/api/avatars/../../etc/passwd.webp' }).avatarImage === '', '目录穿越被丢掉');
  ok(normalize({ avatarImage: '/api/avatars/x.svg' }).avatarImage === '', '不在白名单的扩展名被丢掉');
  ok(normalize({ avatarImage: 42 as unknown as string }).avatarImage === '', '坏类型当没有');
}

// ── [4] 注入点只有一个入口（源码兜底）────────────────────────────────────
console.log('\n[4] 注入点只有一个入口（源码兜底）');
{
  const src = readFileSync(join(process.cwd(), 'server', 'agents', 'registry.ts'), 'utf-8');
  ok(/stream\([^)]*\)[^{]*\{[\s\S]*?withUserIdentity\(/.test(src), 'stream() 过注入');
  ok(/prewarm\([^)]*\)[^{]*\{[\s\S]*?withUserIdentity\(/.test(src), 'prewarm() 也过注入（两边不一致会让预热白做）');

  // 适配器侧不许自己再拼一次 —— 那会绕过「唯一入口」，
  // 出现「sdk 注入了、http 没注入」的分裂，且没有任何报错。
  const adapterDir = join(process.cwd(), 'server', 'agents', 'adapters');
  const rogue = readdirSync(adapterDir).filter(f => {
    if (!f.endsWith('.ts')) return false;
    const s = readFileSync(join(adapterDir, f), 'utf-8');
    return /用户信息：与你对话的人叫/.test(s);
  });
  ok(rogue.length === 0, '适配器里没有第二处硬编码注入', rogue.join(', ') || 'none');
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${total - failures.length}/${total} 通过`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
