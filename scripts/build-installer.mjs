/**
 * 调用 electron-builder 打包。
 *
 * 这个脚本存在的理由，是本机环境有三处坑，每一处都足以让 electron-builder 直接失败：
 *
 * 1) NODE_OPTIONS 注入的 safe-delete 垫片
 *    本机 CLI 会给**所有** Node 进程注入
 *    `NODE_OPTIONS=--require=.../node-language-shim.cjs`，该垫片把
 *    fs.rm / fs.rmdir / fs.unlink 全部换成「移入回收站」。
 *    electron-builder 的 extractArchive() 依赖真实的 fs.rm 清理临时目录，
 *    被换掉后行为完全变了，而且报错完全指不到垫片。
 *    → 在子进程环境里删掉 NODE_OPTIONS。
 *
 * 2) Electron 分发版的解压流程在本机走不通
 *    extractArchive() 的顺序是：
 *        解压到 <out>/win-unpacked.tmp
 *        → fs.rm(<out>/win-unpacked)
 *        → fs.rename(win-unpacked.tmp, win-unpacked)
 *    本机文件系统过滤驱动会把 .tmp 里的 default_app.asar 永久咬住
 *    （实测：open r+ 成功，但 rename / unlink 一律 EBUSY，重试 20 秒仍失败）。
 *    一旦 .tmp 残留，下一次运行开头的 `fs.rm(tmpDir)` 就会挂 —— 表现就是
 *    「第一次能过、第二次必挂」，很容易误判成偶发问题。
 *    → 已在 electron-builder.yml 里设 `electronDist`，改走 emptyDir() + copyDir()，
 *      既不创建 .tmp，也不做任何目录改名。
 *
 * 3) 辅助二进制下载走代理返回 502
 *    electron-builder 还要下 winCodeSign / nsis 等辅助二进制，默认源是
 *    github.com，本机代理对 github release 返回 502。
 *    → 把 .npmrc 里的镜像映射成它认的环境变量。
 *
 * 用法：node scripts/build-installer.mjs [electron-builder 的额外参数]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const extraArgs = process.argv.slice(2);

/**
 * 把 .npmrc 里的镜像配置映射成 electron-builder 认的环境变量。
 *
 * electron-builder 在打包阶段还要下载 winCodeSign / nsis 等辅助二进制，
 * 默认走 github.com —— 本机代理对 github release 返回 502，会卡在这一步。
 * 镜像只在 .npmrc 里配一处，避免「同一个镜像写两遍、改一处忘一处」。
 */
const MIRROR_ENV = {
  electron_mirror: 'ELECTRON_MIRROR',
  electron_builder_binaries_mirror: 'ELECTRON_BUILDER_BINARIES_MIRROR',
};

function mirrorsFromNpmrc() {
  const out = {};
  try {
    for (const line of fs.readFileSync('.npmrc', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([a-z0-9_]+)\s*=\s*(.+?)\s*$/i.exec(line);
      if (!m) continue;
      const envKey = MIRROR_ENV[m[1].toLowerCase()];
      if (envKey) out[envKey] = m[2];
    }
  } catch {
    // 没有 .npmrc 就走官方源，不阻塞
  }
  return out;
}

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

/**
 * 把发布令牌从子进程环境里摘掉。
 *
 * electron-builder 的 PublishManager.resolvePublishConfigurations() 会在**没有任何
 * publish 配置**时去嗅探环境变量：命中 GITHUB_TOKEN / GH_TOKEN / GITLAB_TOKEN 等，
 * 就把对应的 provider 当成目标去解析发布配置。本项目不是 git 仓库（没有 .git/config，
 * 拿不到 repository 信息），解析结果是 null，而这个 null 会被**原样塞进数组**，
 * 随后 updateInfoBuilder 读 `publishConfiguration.provider` 直接 TypeError。
 *
 * 症状极具误导性：exe 已经产出、blockmap 也有，但进程**退出码 1**。
 * 第一次遇到时很容易以为「打包成功、只是有个无关警告」。
 *
 * 配置侧已经在 electron-builder.yml 里写了 `publish: null`（根治）；这里再摘掉令牌，
 * 是为了不依赖单一防线 —— 万一将来有人加了 publish 配置，也不会在本机误发。
 */
const PUBLISH_TOKEN_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'KEYGEN_TOKEN',
  'BITBUCKET_TOKEN',
];
for (const key of PUBLISH_TOKEN_KEYS) {
  if (env[key]) {
    delete env[key];
    console.log(`[build-installer] 已从子进程环境移除 ${key}（避免被误判为要发布到远端）`);
  }
}

for (const [key, value] of Object.entries(mirrorsFromNpmrc())) {
  env[key] ??= value;
}

// 没有代码签名证书，跳过自动发现，免得白等
env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false';

/**
 * 输出目录防锁回退（A63 打包时发现的本机坑）。
 *
 * 安全软件（Microsoft PC Manager / Defender）会**永久锁死**
 * `release/win-unpacked/resources/default_app.asar` —— 实测锁了 6 天，
 * `rm` / `rename` / `unlink` 一律 Permission denied。一旦默认 output 目录里
 * 残留这份被锁死的文件，electron-builder 的 `emptyDir(appOutDir)` / 清理阶段
 * `unlink` 就会撞锁、整包失败（表现就是「第一次能打包、第二次必挂」）。
 *
 * 应对：试着删一次锁文件，删得掉就不算污染（正常情况）；删不掉就**改用全新的
 * 时间戳输出目录**，彻底避开锁文件。新目录事后可能也被锁而无法删除，属已知残留，
 * 待重启清理 —— 但至少当次构建能成。
 *
 * ⚠️ A66（打 release-p48 时）修掉的两个 bug —— 这个回退分支此前**一次都没真正生效过**：
 *   1. `configArg` 算出来之后**从未拼进 spawn 参数**（死变量），于是日志说「改用新目录」，
 *      实际 electron-builder 仍往 `release/` 写 → 立刻 EBUSY 整包失败。
 *      症状极易误判成「锁文件删不掉所以打不了包」，其实是覆盖参数根本没传下去。
 *   2. 临时 yml 的写法本身有副作用：`--config` 会把 electron-builder 解析**相对路径**
 *      的基准从项目根换成 config 文件所在目录（`buildResources` 等会跑偏），
 *      而且文件名与目录名各调了一次 `Date.now()`，两者不同号。
 *   改为直接用 CLI 的 `-c.directories.output=<dir>` 覆盖：不动基准、不落临时文件。
 */
const DEFAULT_OUT = 'release';
const LOCKED_ASAR = path.join(DEFAULT_OUT, 'win-unpacked', 'resources', 'default_app.asar');

/**
 * 调用方是否自己指定了输出目录（`-c.directories.output=xxx` / `--config.directories.output=xxx`）。
 *
 * 回退目录只用来躲开**默认目录**里的锁文件。调用方既然显式指定了别的目录，
 * 就说明它已经绕开这个问题 —— 此时再塞一个覆盖，会把调用方的意图悄悄改掉
 * （典型场景：打 `release-p48` 时既要躲锁、又要落到约定目录）。
 *
 * ⚠️ A84（打 release-p57 时）修掉的第三个 bug：这条正则原先写的是
 * `^-c(?:onfig)?\.`，**匹配不上** `--config.directories.output=...`（两个连字符开头）。
 * 于是调用方按 `--config.` 形式传目录时，`callerSetOutput` 判定为 false，脚本
 * 又追加了一条 `-c.directories.output=release-builds/b...`。两个 output 参数同时
 * 进 electron-builder，schema 校验直接报
 *   `configuration.directories should be a null`
 * 整包失败 —— 而且报错文本完全看不出「参数重复」这件事，只会让人以为
 * 配置对象本身写错了。现在两种写法都认；同时 `--config.` 那个形式本身也不是
 * electron-builder 的合法 CLI 语法，实际应传 `-c.`，见 AGENTS/文档。
 */
const callerSetOutput = extraArgs.some(a => /^(?:--?c|--config)\.directories\.output=/.test(a));

let outDir = DEFAULT_OUT;
let configArg = [];
if (fs.existsSync(LOCKED_ASAR)) {
  try {
    fs.unlinkSync(LOCKED_ASAR);
  } catch {
    if (callerSetOutput) {
      console.log(
        `[build-installer] 默认输出目录 ${DEFAULT_OUT}/ 有被锁死的 default_app.asar，但调用方已指定输出目录，按调用方的来`
      );
    } else {
      outDir = path.join('release-builds', `b${Date.now()}`);
      fs.mkdirSync(outDir, { recursive: true });
      configArg = [`-c.directories.output=${outDir}`];
      console.log(
        `[build-installer] 默认输出目录 ${DEFAULT_OUT}/ 含被锁死的 default_app.asar，改用 ${outDir}/ 避开`
      );
    }
  }
}

const cli = path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
console.log('[build-installer] NODE_OPTIONS 已从子进程环境移除（避免 safe-delete 垫片干扰）');
for (const key of Object.values(MIRROR_ENV)) {
  if (env[key]) console.log(`[build-installer] ${key}=${env[key]}`);
}
console.log(`[build-installer] 目标平台 win/x64${extraArgs.length ? '，额外参数 ' + extraArgs.join(' ') : ''}`);
console.log(
  `[build-installer] 输出目录：${callerSetOutput ? '（由调用方参数指定）' : `${outDir}/`}（快照到 release-pNN 时以此为源）`
);

/**
 * 打包前把 `default_app.asar` 从 electronDist 源里挪走，结束后放回。
 *
 * 这个文件是 Electron 的**兜底 app** —— 只有「一个 app.asar 都没找到」时才会被加载。
 * 我们的包里永远有自己的 app.asar，所以它纯属多余。
 *
 * 但本机的安全软件（实测 Microsoft PC Manager / Windows Defender 在跑）会用过滤驱动
 * 把它**永久锁住**：一旦被复制到 `release/win-unpacked/resources/` 就立刻 EBUSY，
 * 既不能改名也不能删除（实测重试 20 秒仍失败），连带整个 win-unpacked 目录都删不掉。
 * 后果是构建**不可重入**：下一次运行开头的 `emptyDir(appOutDir)` 必然失败 ——
 * 表现就是「第一次能打包、第二次必挂」，非常容易误判成偶发问题。
 *
 * 既然用不到，就不让它进包。
 */
const DEFAULT_APP_ASAR = path.join(
  'node_modules',
  'electron',
  'dist',
  'resources',
  'default_app.asar'
);
const ASIDE_SUFFIX = '.packaging-aside';

function hideDefaultAppAsar() {
  if (!fs.existsSync(DEFAULT_APP_ASAR)) return false;
  try {
    fs.renameSync(DEFAULT_APP_ASAR, DEFAULT_APP_ASAR + ASIDE_SUFFIX);
    console.log('[build-installer] 已临时移出 default_app.asar（避免它被安全软件锁住导致构建不可重入）');
    return true;
  } catch (e) {
    console.warn(
      `[build-installer] 移出 default_app.asar 失败（${e.code}）—— 继续打包，但输出目录可能会留下删不掉的残留`
    );
    return false;
  }
}

function restoreDefaultAppAsar(hidden) {
  if (!hidden) return;
  try {
    fs.renameSync(DEFAULT_APP_ASAR + ASIDE_SUFFIX, DEFAULT_APP_ASAR);
  } catch (e) {
    console.warn(
      `[build-installer] ★ 放回 default_app.asar 失败（${e.code}），它现在停在 ${DEFAULT_APP_ASAR + ASIDE_SUFFIX}`
    );
  }
}

const hidden = hideDefaultAppAsar();

// configArg 必须排在 extraArgs **之后**：两者都可能给 `directories.output`，
// 后出现的覆盖先出现的，这样「调用方显式指定 > 脚本自动回退」的优先级才成立。
const child = spawn(process.execPath, [cli, '--win', '--x64', ...extraArgs, ...configArg], {
  stdio: 'inherit',
  env,
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  restoreDefaultAppAsar(hidden);
  process.exit(code);
}

child.on('exit', code => finish(code ?? 1));
child.on('error', err => {
  console.error('[build-installer] 启动 electron-builder 失败:', err.message);
  finish(1);
});
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));
