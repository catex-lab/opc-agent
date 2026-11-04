/**
 * A171 闸门：应用内检查更新的纯逻辑与接线。
 *
 * ## 这一层守的是什么
 *
 * 更新链路真正的风险不在「下载失败」，而在**通过了不该通过的清单**：
 * 签名没验、哈希没比、资产名带 `..`、非 HTTPS 也照下、运行时版本不一致
 * 还硬替换 `app.asar`。这些分支全是纯函数，能在这里穷举，不必等真发布。
 *
 * 因此分两组：
 *
 *   逻辑组  版本比较（含预发布）、规范化稳定性、验签成功/失败、
 *           体积与摘要不匹配、路径穿越拒绝、URL 白名单、
 *           运行时版本不一致 → requiresFull。
 *   接线组  主进程四个 IPC、preload 桥、关于页渲染、暂存目录不碰 data/、
 *           发布脚本与 CI 工作流确实存在。
 *
 * 接线组是**静态断言**，只证明「线接上了」，不证明「跑起来对」——
 * 后者需要真机点一次，不属于这道闸门的范围。
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  canonicalManifestBody,
  checkAssetName,
  checkAssetUrl,
  compareVersions,
  evaluateManifest,
  isLegacyPubkeyFailure,
  parseManifest,
  sha512Base64,
  verifyAssetDigest,
  verifyManifestSignature,
} from '../shared/update-manifest.js';
import type { UpdateManifest } from '../shared/update.js';
import { UPDATE_MANIFEST_URL, UPDATE_REPO_SLUG } from '../shared/update.js';
import { UPDATE_PUBLIC_KEY_BASE64 } from '../electron/updater/config.js';
import { parseUpdateNotes } from '../src/utils/updateNotes.js';

let pass = 0;
let fail = 0;

function ok(cond: unknown, msg: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log('  ✓', msg);
  } else {
    fail += 1;
    console.log('  ✗', msg, detail === undefined ? '' : `[${String(detail)}]`);
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ══════════════ 版本比较 ══════════════ */

section('版本比较（SemVer 2.0，含预发布）');

const VERSION_CASES: Array<[string, string, number, string]> = [
  ['1.0.0', '1.0.0', 0, '同版本相等'],
  ['1.0.1', '1.0.0', 1, '补丁号更大'],
  ['1.1.0', '1.0.9', 1, '次版本优先于补丁'],
  ['2.0.0', '1.99.99', 1, '主版本优先'],
  ['1.0.0-beta.1', '1.0.0', -1, '预发布小于正式版'],
  ['1.0.0', '1.0.0-beta.1', 1, '正式版大于预发布'],
  ['1.0.0-beta.2', '1.0.0-beta.1', 1, '预发布序号递增'],
  ['1.0.0-beta.10', '1.0.0-beta.2', 1, '预发布数字段按数值比（不是字典序）'],
  ['1.0.0-alpha', '1.0.0-beta', -1, '字母段按字典序'],
  ['1.0.0-1', '1.0.0-alpha', -1, '数字段小于字母段'],
  ['1.0.0-alpha', '1.0.0-alpha.1', -1, '前缀更短者更小'],
  ['1.0.0+build.5', '1.0.0+build.1', 0, '构建元数据不参与比较'],
  ['v1.2.3', '1.2.3', 0, 'v 前缀可接受'],
];

for (const [a, b, expected, label] of VERSION_CASES) {
  let actual = NaN;
  try {
    actual = Math.sign(compareVersions(a, b));
  } catch (e) {
    actual = e instanceof Error ? -99 : -99;
  }
  ok(actual === expected, `${label}：${a} vs ${b}`, `期望 ${expected}，实际 ${actual}`);
}

ok(
  (() => {
    try {
      compareVersions('1.0', '1.0.0');
      return false;
    } catch {
      return true;
    }
  })(),
  '非法版本号（缺段）会抛错，不会静默当 0',
  'compareVersions 对非法输入必须抛错'
);

/* ══════════════ 规范化 ══════════════ */

section('规范化 JSON（签名正文稳定性）');

const left = { b: 2, a: { d: 4, c: 3 }, e: [1, 'x', null] };
const right = { a: { c: 3, d: 4 }, e: [1, 'x', null], b: 2 };
ok(canonicalJson(left) === canonicalJson(right), '键顺序不同 → 规范化结果相同', canonicalJson(left));
ok(!/\s/.test(canonicalJson(left)), '规范化结果不含空白', canonicalJson(left));
ok(canonicalJson({ a: 1, b: undefined }) === '{"a":1}', 'undefined 字段被丢弃', canonicalJson({ a: 1, b: undefined }));

/* ══════════════ 验签 ══════════════ */

section('清单验签（ed25519）');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyBase64 = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
const dummyDigest = sha512Base64(Buffer.from('dummy-asar-bytes'));
const dummyBytes = Buffer.from('dummy-asar-bytes');

function makeManifest(overrides: Partial<UpdateManifest> = {}, opts: { sign?: boolean } = {}): UpdateManifest {
  const base: UpdateManifest = {
    schemaVersion: 1,
    version: '1.0.1',
    releasedAt: '2026-11-01T00:00:00.000Z',
    notes: '修复若干问题',
    runtimeVersion: '44.7.2',
    channel: 'stable',
    assets: {
      asar: {
        name: 'app-1.0.1.asar',
        url: 'https://github.com/catex-lab/opc-agent/releases/download/v1.0.1/app-1.0.1.asar',
        sha512: dummyDigest,
        size: dummyBytes.length,
      },
      full: {
        name: 'OPC-Agent-1.0.1-x64-full.zip',
        url: 'https://github.com/catex-lab/opc-agent/releases/download/v1.0.1/OPC-Agent-1.0.1-x64-full.zip',
        sha512: dummyDigest,
        size: dummyBytes.length,
      },
    },
    signature: '',
  };
  const merged: UpdateManifest = { ...base, ...overrides };
  merged.signature = opts.sign === false
    ? 'AAAA'
    : sign(null, Buffer.from(canonicalManifestBody(merged), 'utf8'), privateKey).toString('base64');
  return merged;
}

const validManifest = makeManifest();
ok(verifyManifestSignature(validManifest, publicKeyBase64).ok, '正确签名通过');

const tampered = makeManifest({ notes: '被替换的更新说明' }, { sign: false });
tampered.notes = '被替换的更新说明';
// 用原签名但改了正文 → 必须失败
const tamperedKeepSig: UpdateManifest = { ...validManifest, notes: '被替换的更新说明' };
ok(!verifyManifestSignature(tamperedKeepSig, publicKeyBase64).ok, '正文被改一个字段 → 验签失败', verifyManifestSignature(tamperedKeepSig, publicKeyBase64).error);

const other = generateKeyPairSync('ed25519');
const otherPub = Buffer.from(other.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
ok(!verifyManifestSignature(validManifest, otherPub).ok, '换一把公钥 → 验签失败');
ok(!verifyManifestSignature({ ...validManifest, signature: '' }, publicKeyBase64).ok, '缺少签名 → 拒绝');
ok(!verifyManifestSignature(tampered, publicKeyBase64).ok, '伪造签名 → 拒绝');

/* ══════════════ 资产名与 URL ══════════════ */

section('路径穿越与 URL 白名单');

const BAD_NAMES: Array<[string, 'asar' | 'full', string]> = [
  ['../evil.asar', 'asar', '上级目录'],
  ['..\\evil.asar', 'asar', '反斜杠上级目录'],
  ['C:\\evil.asar', 'asar', '盘符绝对路径'],
  ['/abs.asar', 'asar', 'POSIX 绝对路径'],
  ['a/b.asar', 'asar', '插入子目录'],
  ['app-1.0.0.exe', 'asar', '扩展名不属于 asar'],
  ['app-1.0.0.asar', 'full', 'asar 不能冒充 full'],
  ['', 'asar', '空名'],
  ['app 1.0.0.asar', 'asar', '含空格'],
];

for (const [name, kind, label] of BAD_NAMES) {
  const err = checkAssetName(name, kind);
  ok(err !== null, `拒绝${label}：${JSON.stringify(name)}`, err ?? '竟然通过了');
}

ok(checkAssetName('app-1.0.0.asar', 'asar') === null, '合法 asar 名通过');
ok(checkAssetName('OPC-Agent-1.0.0-x64-full.zip', 'full') === null, '合法 full 名通过');

ok(checkAssetUrl('https://github.com/a/b/download/x.asar') === null, 'github.com 通过');
ok(checkAssetUrl('https://objects.githubusercontent.com/x.asar') === null, 'objects 重定向域名通过');
ok(checkAssetUrl('http://github.com/x.asar') !== null, 'HTTP 被拒绝（fail closed）', checkAssetUrl('http://github.com/x.asar'));
ok(checkAssetUrl('https://evil.example/x.asar') !== null, '非白名单域名被拒绝', checkAssetUrl('https://evil.example/x.asar'));
ok(checkAssetUrl('not-a-url') !== null, '非法 URL 被拒绝');
ok(checkAssetUrl('file:///C:/x.asar') !== null, 'file 协议被拒绝', checkAssetUrl('file:///C:/x.asar'));

/* ══════════════ 摘要 ══════════════ */

section('体积与 sha512 校验');

const bytes = Buffer.from('asar-bytes-for-digest');
const goodAsset = { sha512: sha512Base64(bytes), size: bytes.length };
ok(verifyAssetDigest(bytes, goodAsset) === null, '正确体积与摘要通过');
ok(
  verifyAssetDigest(bytes, { ...goodAsset, size: bytes.length + 1 }) !== null,
  '体积不符被拒绝',
  verifyAssetDigest(bytes, { ...goodAsset, size: bytes.length + 1 })
);
ok(
  verifyAssetDigest(bytes, { ...goodAsset, sha512: sha512Base64(Buffer.from('other')) }) !== null,
  '摘要不符被拒绝',
  verifyAssetDigest(bytes, { ...goodAsset, sha512: sha512Base64(Buffer.from('other')) })
);
ok(
  verifyAssetDigest(Buffer.concat([bytes, Buffer.from('x')]), goodAsset) !== null,
  '被追加字节的下载被拒绝'
);

/* ══════════════ 清单解析与综合判定 ══════════════ */

section('清单解析与综合判定');

const parsed = parseManifest(validManifest);
ok(parsed.ok, '完整清单解析通过', parsed.error);
ok(!parseManifest({ ...validManifest, schemaVersion: 2 }).ok, 'schemaVersion 不支持 → 拒绝');
ok(!parseManifest({ ...validManifest, version: '1.0' }).ok, '非法版本号 → 拒绝');
ok(!parseManifest({ ...validManifest, channel: 'Stable' }).ok, '非法 channel → 拒绝');
ok(!parseManifest({ ...validManifest, signature: '' }).ok, '缺签名 → 拒绝');
ok(!parseManifest({ ...validManifest, assets: undefined }).ok, '缺 assets → 拒绝');

const OPT = {
  currentVersion: '1.0.0',
  runtimeVersion: '44.7.2',
  publicKeyBase64,
};

ok(evaluateManifest(validManifest, OPT).status === 'available', '新版本 + 运行时一致 → available');
const sameVersion = makeManifest({ version: '1.0.0' });
ok(evaluateManifest(sameVersion, OPT).status === 'latest', '同版本 → latest（不提示更新）');
const older = makeManifest({ version: '0.9.9' });
ok(evaluateManifest(older, OPT).status === 'latest', '清单更旧 → latest（不会降级）');

const mismatch = makeManifest({ runtimeVersion: '50.0.0' });
const decision = evaluateManifest(mismatch, OPT);
ok(
  decision.status === 'available' && decision.requiresFull === true,
  'runtimeVersion 不一致 → available + requiresFull',
  JSON.stringify(decision)
);
const matched = evaluateManifest(validManifest, OPT);
ok(
  matched.status === 'available' && matched.requiresFull === false,
  'runtimeVersion 一致 → available + 可做代码层替换',
  JSON.stringify(matched)
);

const tamperedDecision = evaluateManifest(tamperedKeepSig, OPT);
ok(tamperedDecision.status === 'invalid' && tamperedDecision.code === 'signature', '验签失败即便版本更新也判 invalid', JSON.stringify(tamperedDecision));

const badPath = makeManifest({
  assets: {
    ...validManifest.assets,
    asar: { ...validManifest.assets.asar, name: '../evil.asar' },
  },
}, { sign: false });
const badPathSigned: UpdateManifest = { ...badPath };
badPathSigned.signature = sign(null, Buffer.from(canonicalManifestBody(badPathSigned), 'utf8'), privateKey).toString('base64');
ok(evaluateManifest(badPathSigned, OPT).status === 'invalid', '签名有效但资产名含 .. → invalid');

const httpAsset = makeManifest({
  assets: {
    ...validManifest.assets,
    asar: { ...validManifest.assets.asar, url: 'http://github.com/a.asar' },
  },
}, { sign: false });
httpAsset.signature = sign(null, Buffer.from(canonicalManifestBody(httpAsset), 'utf8'), privateKey).toString('base64');
ok(evaluateManifest(httpAsset, OPT).status === 'invalid', '签名有效但资产是 HTTP → invalid');

ok(
  evaluateManifest(validManifest, { ...OPT, publicKeyBase64: '' }).status === 'invalid',
  '没有内置公钥 → invalid（不降级为「跳过验签」）'
);

/* ══════════════ 旧版公钥提示 ══════════════ */

section('旧版公钥提示（判定必须保守）');

ok(isLegacyPubkeyFailure('signature', '1.0.0'), '1.0.0 + 验签失败 → 旧版提示');
ok(isLegacyPubkeyFailure('signature', '1.0.0-beta.1'), '预发布 ≤1.0.0 + 验签失败 → 旧版提示');
ok(!isLegacyPubkeyFailure('signature', '1.0.1'), '1.0.1 + 验签失败 → 普通失败（不能误报）');
ok(!isLegacyPubkeyFailure('signature', '2.0.0'), '2.0.0 + 验签失败 → 普通失败');
ok(!isLegacyPubkeyFailure('digest', '1.0.0'), '哈希失败 → 不显示旧版提示');
ok(!isLegacyPubkeyFailure('network', '1.0.0'), '网络失败 → 不显示旧版提示');
ok(!isLegacyPubkeyFailure('version', '1.0.0'), '版本号不合法 → 不显示旧版提示');
ok(!isLegacyPubkeyFailure(undefined, '1.0.0'), '没有错误码 → 不显示旧版提示');
ok(!isLegacyPubkeyFailure('signature', 'not-a-version'), '本机版本号不合法 → 不显示旧版提示');

// 端到端：真清单用「另一把钥匙」签（模拟旧客户端验新清单），判定链必须给出 signature
const stranger = generateKeyPairSync('ed25519');
const strangerPub = Buffer.from(stranger.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
const signedByStranger = signWith(validManifest, stranger.privateKey);
const strangerDecision = evaluateManifest(signedByStranger, { ...OPT, publicKeyBase64 });
ok(strangerDecision.status === 'invalid' && strangerDecision.code === 'signature', '其它公钥签的清单 → code=signature', JSON.stringify(strangerDecision));
ok(isLegacyPubkeyFailure(strangerDecision.code, '1.0.0'), '  且 1.0.0 → 旧版提示');
ok(!isLegacyPubkeyFailure(strangerDecision.code, '1.0.1'), '  但 1.0.1 → 普通签名错误');

/* ══════════════ 静态接线 ══════════════ */

section('静态接线');

const sharedSource = read('shared/update.ts');
const configSource = read('electron/updater/config.ts');
ok(sharedSource.includes("'catex-lab/opc-agent'"), '仓库 slug 写死在 shared/update.ts');
ok(sharedSource.includes('/releases/latest/download/latest.json'), '清单地址是 releases/latest/download 固定地址');
ok(UPDATE_REPO_SLUG === 'catex-lab/opc-agent', `slug 常量为 catex-lab/opc-agent（实际 ${UPDATE_REPO_SLUG}）`);
ok(
  UPDATE_MANIFEST_URL === `https://github.com/${UPDATE_REPO_SLUG}/releases/latest/download/latest.json`,
  '清单地址由 slug 拼出且大小写一致',
  UPDATE_MANIFEST_URL
);
ok(configSource.includes('OPC_UPDATE_MANIFEST_URL'), '清单地址允许环境变量覆盖');
ok(configSource.includes('OPC_UPDATE_PUBLIC_KEY'), '公钥允许环境变量覆盖（便于本地联调）');
ok(/export const UPDATE_PUBLIC_KEY_BASE64[\s\S]*?'[A-Za-z0-9+/=]{40,}'/.test(configSource), '内置了 ed25519 公钥');

const mainSource = read('electron/main.ts');
for (const channel of ['opc:update-state', 'opc:update-check', 'opc:update-download', 'opc:update-quit-install']) {
  ok(mainSource.includes(`'${channel}'`), `主进程注册 ${channel}`);
}
ok(mainSource.includes('updater.start()'), '启动时调用 updater.start()');
ok(mainSource.includes('updater.confirmHealthy()'), '窗口加载后写健康标记');
ok(mainSource.includes('updater.dispose()'), '退出时清理定时器');

const preloadSource = read('electron/preload.cjs');
for (const key of ['getState', 'check', 'download', 'quitAndInstall', 'onStateChange']) {
  ok(preloadSource.includes(key), `preload 暴露 update.${key}`);
}

const aboutSource = read('src/components/AboutPanel.tsx');
ok(aboutSource.includes("from './UpdateCard'"), '关于页引入 UpdateCard');
ok(aboutSource.includes('<UpdateCard'), '关于页渲染 UpdateCard');

const stale = read('src/components/UpdateCard.tsx');
for (const phase of ['checking', 'latest', 'available', 'downloading', 'ready']) {
  ok(stale.includes(`'${phase}'`), `更新卡片有 ${phase} 状态`);
}
// 1.0.6 起失败提示不再绑在 phase === 'error' 上：交接失败要和新版本信息
// 同时在「available」里常驻，否则启动 5 秒后的自动检查一清就看不见了。
ok(
  stale.includes('{error && (') && stale.includes('data-update-error'),
  '更新卡片按 error 字段渲染失败提示（不再依赖 phase）'
);
ok(stale.includes('data-update-check'), '检查更新按钮带测试锚点');
ok(stale.includes('data-update-progress'), '下载进度带测试锚点');
ok(stale.includes('legacyManualUpdate'), '更新卡片根据旧版标记切换文案');
ok(stale.includes('此版本需手动更新一次'), '旧版提示是一句结论');
ok(stale.includes('下载完整安装包'), '旧版提示给一个完整包动作');
ok(stale.includes('data-update-legacy'), '旧版提示带测试锚点');
ok(stale.includes('data-update-manual-link'), '普通失败仍保留「手动下载」入口');

const updaterSource = read('electron/updater/index.ts');
ok(!updaterSource.includes('OPC_DATA_DIR'), '更新链路不读写 data/（无 OPC_DATA_DIR）');
ok(updaterSource.includes('isLegacyPubkeyFailure'), '主进程只在签名失败 + 旧版本时置旧版标记');
ok(updaterSource.includes("message: '此版本需手动更新一次'"), '旧版错误文案与界面一致');
ok(updaterSource.includes("app.getPath('temp')"), '暂存目录落在系统 temp');
ok(updaterSource.includes('checkAssetUrl'), '重定向每一跳都校验域名与协议');
ok(updaterSource.includes('ELECTRON_RUN_AS_NODE'), '交换 helper 以纯 Node 模式启动');
ok(updaterSource.includes('timeoutMs'), '下载与清单请求都有超时');

// v1.0.2 真机事故：暂存包按 `asset.name` 存成 `app-<ver>.asar`，Electron 的 asar
// 层把它当归档 —— 交接前二次摘要的 createReadStream 抛
// `ENOENT, not found in <path>`，用户点「退出并重启」只看到一串英文。
// 暂存名必须单点定义、且结尾不能是 `.asar`。
ok(
  !/join\(dir,\s*asset\.name\)/.test(updaterSource),
  '暂存文件名不再直接用 asset.name（否则以 .asar 结尾）',
  '仍有 join(dir, asset.name)'
);
ok(
  /function stagedFile\(dir: string, assetName: string\): string \{[\s\S]{0,160}\$\{assetName\}\.download/.test(updaterSource),
  '暂存文件名单点定义在 stagedFile()，且以 .download 结尾',
  '缺 stagedFile() 或结尾不是 .download'
);
ok(
  (updaterSource.match(/stagedFile\(/g) ?? []).length >= 3,
  '下载与交接共用 stagedFile()（不存在第二处路径硬编码）',
  `实际 ${(updaterSource.match(/stagedFile\(/g) ?? []).length} 处`
);
ok(
  /try \{[\s\S]{0,160}await fileDigest\(stagedPath\)[\s\S]{0,240}\} catch/.test(updaterSource),
  '二次摘要读不出来 → catch 成可读错误（不把 ENOENT 抛给 IPC）',
  'fileDigest 仍可能直接抛出'
);
ok(
  updaterSource.includes('abandonStaged') && updaterSource.includes('请重新下载'),
  '缺失 / 不可读 / 摘要不符 → 中文错误 + 回到可重试状态',
  '缺 abandonStaged 或重试文案'
);
const artifactsSource = read('electron/updater/apply-artifacts.ts');
ok(
  artifactsSource.includes("'.download'") &&
    artifactsSource.includes("'.part'") &&
    artifactsSource.includes("'.asar'"),
  '清理覆盖半成品、暂存包与历史 .asar 残留',
  '缺 apply-artifacts 的后缀集合'
);

const helperSource = read('electron/updater/swap-helper-source.ts');
ok(helperSource.includes('.bak'), '交换前把旧 asar 备份为 .bak');
ok(helperSource.includes('rolled-back'), '启动超时后记录 rolled-back');
ok(helperSource.includes('health'), '用健康文件确认新版本启动成功');
ok(helperSource.includes('stagedSize'), 'helper 动旧 asar 之前先确认暂存包在且体积一致');

const buildSource = read('scripts/build-update.ts');
ok(buildSource.includes('canonicalManifestBody'), '发布脚本与客户端共用签名正文函数');
ok(buildSource.includes('createPrivateKey'), '发布脚本从 base64 PKCS#8 读私钥');

// full zip 的条目名不能带 `./` 前缀：Windows 资源管理器的 zip 处理器会枚举出
// 0 个条目并报「压缩(zipped)文件夹无效」（v1.0.2 实测，见 build-update.ts 注释）。
// 所以打包时必须显式列出顶层条目，不能再出现 `-C <dir> '.'` 这种 argv 写法。
ok(
  !/['"]-C['"]\s*,\s*[A-Za-z_$][\w$]*\s*,\s*['"]\.['"]/.test(buildSource),
  'full zip 不用 `-C <dir> .`（避免 `./` 前缀条目名）',
  '出现 tar ... -C appDir "." 写法'
);
ok(buildSource.includes('fs.readdirSync(appDir)'), 'full zip 显式枚举顶层条目名', '缺 readdirSync(appDir)');
ok(
  /spawnSync\('tar',[^\n]*\.\.\.topLevel/.test(buildSource),
  'tar 参数展开顶层条目列表（...topLevel）',
  '缺 tar argv 的 ...topLevel'
);

const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  repository?: { url?: string };
};
ok(pkg.scripts['update:keygen'] === 'node scripts/update-keygen.mjs', '注册 update:keygen');
ok(pkg.scripts['update:build'] === 'tsx scripts/build-update.ts', '注册 update:build');
ok(pkg.scripts['verify:a171-update'] === 'tsx scripts/verify-a171-update.ts', '注册 verify:a171-update');

const pkgRepo = pkg.repository?.url?.match(/github\.com[/:]([^/]+)\/([^./]+)/);
ok(
  pkgRepo != null && `${pkgRepo[1]}/${pkgRepo[2]}` === UPDATE_REPO_SLUG,
  'package.json 的 repository 与 slug 常量一致（含大小写）',
  pkg.repository?.url ?? '缺 repository'
);

const workflowPath = path.join(ROOT, '.github/workflows/release-update.yml');
ok(fs.existsSync(workflowPath), '存在 release-update 工作流');
if (fs.existsSync(workflowPath)) {
  const wf = fs.readFileSync(workflowPath, 'utf8');
  ok(/tags:\s*\n?\s*-?\s*['"]?v\*/.test(wf) || wf.includes("- 'v*'") || wf.includes('- "v*"'), 'tag v* 触发');
  ok(wf.includes('OPC_UPDATE_PRIVATE_KEY'), '私钥从 Secrets 注入');
  ok(wf.includes('gh release'), '用 gh release 上传资产');
  ok(wf.includes('latest.json'), '上传 latest.json');
  ok(wf.includes('app-') && wf.includes('.asar'), '上传 asar 资产');
  ok(wf.includes('.zip'), '上传全量 zip');
  ok(
    wf.includes('--repo "${{ github.repository }}"'),
    'CI 用实际仓库拼资产 URL（不写死 slug，fork 也不会指错）',
    '缺 --repo github.repository'
  );

  // 发布说明不能退化成一行提交标题（v1.0.3 之前就是这样，Release 页只有版本号）。
  ok(wf.includes('release-notes/$tag.md'), '发布说明优先读 release-notes/<tag>.md', '缺 release-notes 分支');
  ok(wf.includes('CHANGELOG.md'), '发布说明可回退到 CHANGELOG.md 的版本段落', '缺 CHANGELOG 分支');
  ok(
    !/git log -1 --pretty=format:'- %s'\s*\n\s*\$body/.test(wf),
    '不再把「提交标题」直接当发布说明',
    '仍存在 git log 标题直出'
  );
  ok(wf.includes('发布说明过短') && wf.includes('Write-Error'), '发布说明为空/只有版本号时 CI 失败而不是静默', '缺长度或版本号守卫');
  const changelog = read('CHANGELOG.md');
  ok(changelog.includes('## [1.0.4]'), 'CHANGELOG 收录 1.0.4 段落', '缺 1.0.4');
  ok(/## \[1\.0\.0\]/.test(changelog) && /## \[1\.0\.1\]/.test(changelog), 'CHANGELOG 覆盖 1.0.0 起的历史版本', '缺早期版本');
  ok(
    read('release-notes/v1.0.4.md').trim().length > 200,
    'release-notes/v1.0.4.md 是完整说明而不是占位',
    '说明过短'
  );
}

/* ══════════════ Release 说明渲染 ══════════════ */

section('Release 说明渲染（Markdown → 结构，不再字面显示）');

const notesSample = [
  '## 修复',
  '',
  '- **加粗标题** 与 `code` 混排',
  '  续行要拼回上一条，不能拆段',
  '',
  '### 注意',
  '',
  '普通段落第一行',
  '第二行（中文折行不加空格）',
].join('\n');
const notesBlocks = parseUpdateNotes(notesSample);

const firstBlock = notesBlocks[0];
ok(
  !!firstBlock && firstBlock.kind === 'heading' && firstBlock.level === 2,
  '`##` 解析成二级标题，不再字面显示井号',
  JSON.stringify(firstBlock)
);

const bulletBlock = notesBlocks.find(b => b.kind === 'bullet');
const bulletText = bulletBlock ? bulletBlock.inlines.map(t => t.text).join('') : '';
ok(!!bulletBlock && bulletText.includes('加粗标题'), '`- ` 解析成列表项，加粗内容取出', bulletText);
ok(
  !!bulletBlock && bulletBlock.inlines.some(t => t.kind === 'bold' && t.text === '加粗标题'),
  '`**加粗**` 变成加粗片段，不残留星号',
  JSON.stringify(bulletBlock?.inlines)
);
ok(
  !!bulletBlock && bulletBlock.inlines.some(t => t.kind === 'code' && t.text === 'code'),
  '行内代码变成 code 片段，不残留反引号',
  JSON.stringify(bulletBlock?.inlines)
);
ok(!bulletText.includes('**') && !bulletText.includes('`'), '列表项正文里不再出现字面 `**` / 反引号', bulletText);
ok(bulletText.includes('混排续行要拼回上一条'), '折行续行拼回同一条列表项（中文不加空格）', bulletText);

const escapedBlocks = parseUpdateNotes('- \\*\\*加粗\\*\\* 和 \\# 标题');
const escapedBullet = escapedBlocks.find(b => b.kind === 'bullet');
const escapedText = escapedBullet ? escapedBullet.inlines.map(t => t.text).join('') : '';
ok(
  !!escapedBullet && escapedBullet.inlines.some(t => t.kind === 'bold' && t.text === '加粗'),
  '转义写法 `\\*\\*加粗\\*\\*` 先还原再按加粗渲染',
  JSON.stringify(escapedBullet?.inlines)
);
ok(!escapedText.includes('\\') && !escapedText.includes('**'), '转义反斜杠不再露到界面上', escapedText);

const paragraph = notesBlocks.find(b => b.kind === 'paragraph');
const paragraphText = paragraph ? paragraph.inlines.map(t => t.text).join('') : '';
ok(paragraphText.includes('普通段落第一行第二行'), '中文折行的段落拼回一段', paragraphText);

const cardSrc = read('src/components/UpdateCard.tsx');
ok(cardSrc.includes('parseUpdateNotes') && cardSrc.includes('data-update-notes'), '关于页用结构化渲染而非原文直出', '缺解析器接线');
ok(!cardSrc.includes('className="tc-update-notes">{release.notes}'), '旧的 `<p>{release.notes}</p>` 已移除');

const css = read('src/index.css');
ok(
  /\.tc-update-notes\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/.test(css),
  '说明区限高并在 700px 卡片内滚动',
  '缺 max-height / overflow-y'
);
ok(
  !/\.tc-update-notes\s*\{[^}]*white-space:\s*pre-wrap/.test(css),
  '不再用 pre-wrap 原样输出 Markdown'
);

/* ══════════════ 真实密钥联调 ══════════════ */

section('真实密钥联调（本地私钥 → 内置公钥）');

const fingerprintOf = (pub: string): string =>
  createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);

ok((() => {
  try {
    createPublicKey({
      key: Buffer.from(UPDATE_PUBLIC_KEY_BASE64.trim(), 'base64'),
      format: 'der',
      type: 'spki',
    });
    return true;
  } catch {
    return false;
  }
})(), '内置公钥是可解析的 SPKI DER', `指纹 ${fingerprintOf(UPDATE_PUBLIC_KEY_BASE64)}`);

function signWith(manifest: UpdateManifest, key: ReturnType<typeof createPrivateKey>): UpdateManifest {
  const body: UpdateManifest = { ...manifest, signature: '' };
  body.signature = sign(null, Buffer.from(canonicalManifestBody(body), 'utf8'), key).toString('base64');
  return body;
}

const LOCAL_KEY = path.join(ROOT, '.tmp', 'update-signing-key.json');

if (fs.existsSync(LOCAL_KEY)) {
  const raw = JSON.parse(fs.readFileSync(LOCAL_KEY, 'utf8')) as { publicKey?: string; privateKey?: string };
  ok(typeof raw.privateKey === 'string' && raw.privateKey.length > 0, '本地密钥文件包含私钥');

  if (typeof raw.privateKey === 'string' && raw.privateKey) {
    const localPriv = createPrivateKey({
      key: Buffer.from(raw.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const derived = Buffer.from(
      createPublicKey(localPriv).export({ format: 'der', type: 'spki' })
    ).toString('base64');

    ok(
      derived === UPDATE_PUBLIC_KEY_BASE64.trim(),
      `本地私钥与内置公钥配对（指纹 ${fingerprintOf(derived)}）`,
      `本地 ${fingerprintOf(derived)} / 内置 ${fingerprintOf(UPDATE_PUBLIC_KEY_BASE64)}`
    );
    ok(raw.publicKey === derived, '密钥文件里的公钥与私钥一致');

    // 每次运行都**现签一份**清单，不复用上一轮的夹具
    const fresh = signWith(
      makeManifest(
        { version: `1.0.1-local.${Date.now()}`, notes: `新密钥联调 ${new Date().toISOString()}` },
        { sign: false }
      ),
      localPriv
    );
    ok(verifyManifestSignature(fresh, UPDATE_PUBLIC_KEY_BASE64.trim()).ok, '内置公钥能验过新私钥的签名');

    const freshDecision = evaluateManifest(fresh, {
      currentVersion: '1.0.0',
      runtimeVersion: '44.7.2',
      publicKeyBase64: UPDATE_PUBLIC_KEY_BASE64.trim(),
    });
    ok(
      freshDecision.status === 'available',
      '新私钥签的清单走完整判定 → available',
      JSON.stringify(freshDecision)
    );

    const tamperedFresh: UpdateManifest = { ...fresh, notes: '篡改后的说明' };
    ok(
      !verifyManifestSignature(tamperedFresh, UPDATE_PUBLIC_KEY_BASE64.trim()).ok,
      '新私钥签的清单被改一个字段 → 验签失败'
    );

    // 夹具：上一版公钥（公钥不是秘密，只为验证轮换后旧客户端不再信任新清单）
    const OLD_PUBLIC_KEY = 'MCowBQYDK2VwAyEAsxogKAgI5zkQIz6mfYBIbj47HsPc1c8tNzeNCW6lfjU='; // secret-scan:ignore
    ok(
      !verifyManifestSignature(fresh, OLD_PUBLIC_KEY).ok,
      '旧公钥不再信任新密钥签的清单（轮换确实生效）'
    );
  }
} else {
  console.log('  · 未找到 .tmp/update-signing-key.json —— 跳过真实密钥联调（CI 上属预期）');
}

ok(/^\.tmp\/$/m.test(read('.gitignore')), '.tmp/ 已被 gitignore（私钥文件不会进仓库）');

/* ══════════════ 汇总 ══════════════ */

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
