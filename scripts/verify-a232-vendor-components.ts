/**
 * A232：厂商运行组件按需下载（瘦身批次 2）。
 *
 * 钉死五件事：
 *   1. 组件清单只有 codex / claude，下载源全走 HTTPS，integrity 是 sha512；
 *   2. 组件 id 白名单拒绝一切自由字符串（不留下路径拼接的口子）；
 *   3. tarball 完整性校验 fail closed（错哈希 / 坏格式一律拒绝）；
 *   4. 解包条目拒绝绝对路径、盘符与 `..`（纵深防御）；
 *   5. 安装目录解析：没有文件 = missing，文件落地后 = installed 且能拿到路径；
 *      外加 electron-builder 确实排除了两个平台包、两个适配器都接了回退。
 *
 * 另做一次真实 tar 往返（系统 tar 可用时）：打包 → 解包 → 读回内容。
 * 系统缺 tar 时按项目口径「显式跳过」，退出码仍为 0，不静默省略。
 *
 * 运行：npx tsx scripts/verify-a232-vendor-components.ts
 */
// 必须是第一个 import：把 OPC_DATA_DIR 指到临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  VENDOR_COMPONENTS,
  extractTarball,
  isSafeTarEntry,
  isVendorComponentId,
  resolveEntryFile,
  resolveVendorComponentBinary,
  systemTarPath,
  vendorComponentRoot,
  vendorComponentStatus,
  verifyTarballIntegrity,
} from '../server/agents/vendorComponents.js';

const root = path.resolve(import.meta.dirname, '..');
const failures: string[] = [];
let total = 0;
let skipped = 0;

function eq<T>(actual: T, expected: T, label: string) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// ── 1. 清单契约 ────────────────────────────────────────────────────
{
  eq(Object.keys(VENDOR_COMPONENTS).sort(), ['claude', 'codex'], '组件清单应只有 codex / claude');
  for (const spec of Object.values(VENDOR_COMPONENTS)) {
    ok(spec.tarballUrls.length >= 1, `${spec.id} 至少要有一个下载源`);
    ok(
      spec.tarballUrls.every(url => url.startsWith('https://')),
      `${spec.id} 的下载源必须全部是 HTTPS`
    );
    ok(/^sha512-[A-Za-z0-9+/=]+$/.test(spec.integrity), `${spec.id} 的 integrity 必须是 sha512 SRI`);
    ok(spec.approxBytes > 100 * 1024 * 1024, `${spec.id} 的预估体积应为百 MB 级`);
    ok(spec.agentIds.includes(spec.id), `${spec.id} 应绑定同名 Agent`);
  }
}

// ── 2. 与 package-lock 的版本/哈希保持一致（防 SDK 升级后静默漂移）────
{
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };
  for (const spec of Object.values(VENDOR_COMPONENTS)) {
    const entry = lock.packages?.[`node_modules/${spec.packageName}`];
    ok(Boolean(entry), `package-lock 必须记录 ${spec.packageName}`);
    if (!entry) continue;
    eq(entry.version, spec.version, `${spec.id} 的版本必须与 lockfile 一致`);
    eq(entry.integrity, spec.integrity, `${spec.id} 的 integrity 必须与 lockfile 一字不差`);
    eq(entry.resolved, spec.tarballUrls[0], `${spec.id} 的首选下载源必须与 lockfile 的 resolved 一致`);
  }
}

// ── 3. id 白名单：任何自由字符串都必须拒绝 ─────────────────────────
{
  ok(isVendorComponentId('codex'), 'codex 应被识别');
  ok(isVendorComponentId('claude'), 'claude 应被识别');
  for (const bad of ['', 'Codex', 'codex2', '../codex', 'codex/../claude', 'codex\\..\\x', '/codex', 'codex ']) {
    ok(!isVendorComponentId(bad), `非白名单 id 应拒绝：${JSON.stringify(bad)}`);
  }
}

// ── 4. 完整性校验 fail closed ──────────────────────────────────────
{
  const data = Buffer.from('opc-vendor-component-fixture');
  const spec = VENDOR_COMPONENTS.codex;
  ok(!verifyTarballIntegrity(data, spec.integrity), '内容与锁定哈希不符时必须判失败');
  ok(!verifyTarballIntegrity(data, 'sha512-!!!'), 'integrity 格式非法时必须判失败');
  ok(!verifyTarballIntegrity(data, ''), 'integrity 为空时必须判失败');

  // 用真实 tarball 的锁定哈希反证「算法方向对」：换一份内容必然不通过
  ok(!verifyTarballIntegrity(Buffer.alloc(8), VENDOR_COMPONENTS.claude.integrity), '空内容不得通过锁定哈希');
}

// ── 5. tar 条目安全判定 ────────────────────────────────────────────
{
  const safe = ['package/claude.exe', './package/vendor/x/bin/codex.exe', 'package/文件名.txt'];
  for (const name of safe) ok(isSafeTarEntry(name), `合法条目应通过：${name}`);
  const unsafe = ['../evil', 'package/../../evil', '/etc/passwd', 'C:\\Windows\\evil', 'a\\..\\b', ''];
  for (const name of unsafe) ok(!isSafeTarEntry(name), `危险条目应拒绝：${JSON.stringify(name)}`);
}

// ── 6. 安装目录解析与状态 ──────────────────────────────────────────
{
  eq(resolveVendorComponentBinary('codex'), null, '未安装时应解析为 null');
  eq(vendorComponentStatus('codex').state, 'missing', '未安装时状态应为 missing');

  const entry = path.join(vendorComponentRoot('codex'), 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'stub');
  try {
    eq(resolveVendorComponentBinary('codex'), entry, '文件落地后应解析到真实路径');
    eq(vendorComponentStatus('codex').installed, true, '文件落地后 installed 应为 true');
    eq(vendorComponentStatus('codex').state, 'installed', '文件落地后状态应为 installed');
    ok(
      resolveEntryFile(vendorComponentRoot('codex'), VENDOR_COMPONENTS.codex.entryPath) === entry,
      'resolveEntryFile 与公开解析函数必须一致'
    );
  } finally {
    fs.rmSync(path.join(vendorComponentRoot('codex')), { recursive: true, force: true });
  }

  // 目录在但入口文件缺失：不得假装已安装
  fs.mkdirSync(vendorComponentRoot('claude'), { recursive: true });
  try {
    eq(vendorComponentStatus('claude').installed, false, '只有空目录时不得判为已安装');
  } finally {
    fs.rmSync(vendorComponentRoot('claude'), { recursive: true, force: true });
  }
}

// ── 7. 打包配置与适配器回退 ────────────────────────────────────────
{
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  ok(
    builder.includes('!node_modules/@openai/codex-win32-x64/**'),
    'electron-builder.yml 必须排除 codex 平台包'
  );
  ok(
    builder.includes('!node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**'),
    'electron-builder.yml 必须排除 claude 平台包'
  );
  const asarUnpackBlock = /asarUnpack:([\s\S]*?)(\n\w|$)/.exec(builder)?.[1] ?? '';
  ok(
    !asarUnpackBlock.includes('codex-win32-x64') && !asarUnpackBlock.includes('claude-agent-sdk-win32-x64'),
    'asarUnpack 不得把已排除的平台包再解包回来'
  );

  const codexAdapter = fs.readFileSync(
    path.join(root, 'server/agents/adapters/codex-sdk.ts'),
    'utf8'
  );
  const claudeAdapter = fs.readFileSync(
    path.join(root, 'server/agents/adapters/claude-sdk.ts'),
    'utf8'
  );
  ok(codexAdapter.includes("resolveVendorComponentBinary('codex')"), 'codex 适配器必须回落到下载目录');
  ok(claudeAdapter.includes("resolveVendorComponentBinary('claude')"), 'claude 适配器必须回落到下载目录');
  ok(
    fs.existsSync(path.join(root, 'server/routes/vendor-components.ts')),
    '组件下载路由文件必须存在'
  );
}

// ── 8. 真实 tar 往返（缺 tar 时显式跳过）───────────────────────────
{
  const tar = systemTarPath();
  if (!tar) {
    skipped += 3;
    console.log('  显式跳过 3 条（非断言）：系统缺少 tar，无法验证解包路径');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a232-'));
    try {
      const src = path.join(work, 'src');
      const payload = path.join(src, 'package', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.writeFileSync(payload, 'roundtrip-fixture');

      const tgz = path.join(work, 'fixture.tgz');
      const packed = spawnSync(tar, ['-czf', tgz, '-C', src, 'package'], { windowsHide: true });
      ok(packed.status === 0, 'fixture 打包应成功', String(packed.stderr ?? ''));

      const dest = path.join(work, 'out');
      await extractTarball(tgz, dest);
      const restored = path.join(dest, 'package', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
      ok(fs.existsSync(restored), '解包后入口文件应存在');
      eq(fs.readFileSync(restored, 'utf8'), 'roundtrip-fixture', '解包内容应与打包前一致');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

console.log(
  `A232 结果：通过 ${total - failures.length}，失败 ${failures.length}` +
    (skipped ? `，显式跳过 ${skipped} 条（非断言）` : '')
);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 运行组件清单、白名单、校验 fail-closed、解包防护与适配器回退均符合预期');
