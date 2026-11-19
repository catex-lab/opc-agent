/**
 * 按需下载的厂商运行组件（瘦身批次 2，2026-11-19）。
 *
 * ## 为什么不再随安装包分发
 *
 * Codex / Claude 的 npm 平台包里各带一个几百 MB 的可执行文件
 * （`codex.exe` 354.5MB、`claude.exe` 319.9MB），打进安装包后 setup 是
 * 385MB —— 绝大多数用户第一次打开并不需要这两个 Agent。瘦身批次 2 的
 * 结论是把它们从包里拿掉，等用户真的要用时再下载。
 *
 * ## 为什么从 npm 镜像取，而不是自建 Release 资产
 *
 * `package-lock.json` 里已经记录了每个平台包的 tarball 地址与 sha512
 * integrity：直接按这份记录下载 + 校验，等于免掉「自己上传 1GB 资产、
 * 自己签清单、自己维护版本对应关系」这一整套。镜像优先 `npmmirror`
 * （国内速度），失败回退官方 `registry.npmjs.org`。
 *
 * ## 安全边界
 *
 * - 组件 id 只认白名单，路由层不接受自由字符串（不做路径拼接）；
 * - 下载先落 `.part`，sha512 与 lockfile 记录不一致即删除并 fail closed；
 * - 解包前用 `tar -tf` 逐条检查条目名，出现绝对路径 / `..` 直接拒绝；
 * - 安装目录固定为 `<dataDir>/vendor/<id>/`，不写任何仓库或用户目录之外的位置。
 *
 * ## 与适配器的关系
 *
 * 适配器里的 `bundledBinary()` 仍优先扫 `node_modules`（开发态就是这份）；
 * 打包态找不到时才回落到这里解析 `<dataDir>/vendor/<id>/` 下的真实文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { dataDirPath } from '../paths.js';

export type VendorComponentId = 'codex' | 'claude';

export interface VendorComponentSpec {
  id: VendorComponentId;
  /** 展示名（与 Agent 名一致，避免同一组件两种叫法） */
  label: string;
  /** 需要这个组件的 Agent；界面按 agentId 反查 */
  agentIds: readonly string[];
  /** npm 平台包名（只用于展示与排错） */
  packageName: string;
  version: string;
  /** 下载源，按顺序尝试；全部必须是 https */
  tarballUrls: readonly string[];
  /** npm tarball 的 sha512（SRI 格式，抄自 package-lock.json） */
  integrity: string;
  /** 预估下载体积（字节），仅用于界面展示 */
  approxBytes: number;
  /** 解包后必须存在的入口，相对安装根；`*` 匹配一层目录 */
  entryPath: string;
}

const CODEX_SPEC: VendorComponentSpec = {
  id: 'codex',
  label: 'Codex',
  agentIds: ['codex'],
  packageName: '@openai/codex-win32-x64',
  version: '0.166.0-win32-x64',
  tarballUrls: [
    'https://registry.npmmirror.com/@openai/codex/-/codex-0.166.0-win32-x64.tgz',
    'https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-win32-x64.tgz',
  ],
  integrity:
    'sha512-NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA==',
  approxBytes: 479_500_000,
  // 平台三元组写死 x64-windows：本安装包只面向 Windows x64（与 electron-builder.yml 一致）
  entryPath: 'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
};

const CLAUDE_SPEC: VendorComponentSpec = {
  id: 'claude',
  label: 'Claude Code',
  agentIds: ['claude'],
  packageName: '@anthropic-ai/claude-agent-sdk-win32-x64',
  version: '0.3.316',
  tarballUrls: [
    'https://registry.npmmirror.com/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.316.tgz',
    'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.316.tgz',
  ],
  integrity:
    'sha512-FzQA1zHbYJTtLR9nn1McwkGYeiEmroTmYjIg7xZqo5eweJ8U/DESZKR/QdfF04MXe2DF23oLL8WHjEa+WxbGQw==',
  approxBytes: 319_900_000,
  entryPath: 'claude.exe',
};

export const VENDOR_COMPONENTS: Record<VendorComponentId, VendorComponentSpec> = {
  codex: CODEX_SPEC,
  claude: CLAUDE_SPEC,
};

/** 组件 id 白名单。路由层拿到的是 URL 参数，必须先过这一关再谈路径。 */
export function isVendorComponentId(value: unknown): value is VendorComponentId {
  return value === 'codex' || value === 'claude';
}

export function vendorComponentForAgent(agentId: string): VendorComponentSpec | null {
  return Object.values(VENDOR_COMPONENTS).find(spec => spec.agentIds.includes(agentId)) ?? null;
}

/** 安装根：`<dataDir>/vendor/<id>/`，与 chat.db / avatars 同级 */
export function vendorComponentRoot(id: VendorComponentId): string {
  return path.join(dataDirPath, 'vendor', id);
}

/**
 * 按 `entryPath` 解析入口文件。
 *
 * 支持一层 `*`：平台三元组目录名由 SDK 的包结构决定，写死反而更容易随
 * 上游改布局失效；扫一层足以覆盖 `vendor/<triple>/bin/codex.exe`。
 */
export function resolveEntryFile(root: string, entryPath: string): string | null {
  let candidates = [root];
  for (const part of entryPath.split('/')) {
    const next: string[] = [];
    for (const base of candidates) {
      if (part === '*') {
        try {
          for (const name of fs.readdirSync(base)) next.push(path.join(base, name));
        } catch {
          /* 目录不存在 = 这条分支没有候选 */
        }
      } else {
        next.push(path.join(base, part));
      }
    }
    candidates = next;
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续看下一个候选 */
    }
  }
  return null;
}

/** 已安装时返回可执行文件绝对路径；没装返回 null（适配器用它做回退） */
export function resolveVendorComponentBinary(id: VendorComponentId): string | null {
  const spec = VENDOR_COMPONENTS[id];
  if (!spec) return null;
  return resolveEntryFile(vendorComponentRoot(id), spec.entryPath);
}

export type VendorComponentState = 'installed' | 'missing' | 'downloading' | 'failed';

export interface VendorComponentStatus {
  id: VendorComponentId;
  label: string;
  agentIds: readonly string[];
  version: string;
  approxBytes: number;
  installed: boolean;
  binaryPath: string | null;
  state: VendorComponentState;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
}

interface DownloadJob {
  controller: AbortController;
  received: number;
  total: number;
  error?: string;
  cancelled: boolean;
  /** 网络静默超时：120 秒没有任何新数据就中止，避免一直挂着 */
  idleTimer: NodeJS.Timeout | null;
}

const jobs = new Map<VendorComponentId, DownloadJob>();

function clearIdleTimer(job: DownloadJob): void {
  if (job.idleTimer) {
    clearTimeout(job.idleTimer);
    job.idleTimer = null;
  }
}

export function vendorComponentStatus(id: VendorComponentId): VendorComponentStatus {
  const spec = VENDOR_COMPONENTS[id];
  const binaryPath = resolveVendorComponentBinary(id);
  const job = jobs.get(id);
  const base = {
    id: spec.id,
    label: spec.label,
    agentIds: spec.agentIds,
    version: spec.version,
    approxBytes: spec.approxBytes,
    installed: Boolean(binaryPath),
    binaryPath,
  };
  if (binaryPath) return { ...base, state: 'installed' };
  if (job && !job.cancelled && !job.error) {
    return {
      ...base,
      state: 'downloading',
      receivedBytes: job.received,
      totalBytes: job.total || undefined,
    };
  }
  if (job?.error) {
    return { ...base, state: 'failed', error: job.error };
  }
  return { ...base, state: 'missing' };
}

export function listVendorComponentStatuses(): VendorComponentStatus[] {
  return Object.keys(VENDOR_COMPONENTS)
    .filter(isVendorComponentId)
    .map(vendorComponentStatus);
}

/**
 * 校验 tarball 的 sha512。
 *
 * fail closed：integrity 缺失、格式不对、算不出来，一律判失败 —— 不降级成
 * 「不校验也能装」。
 */
export function verifyTarballIntegrity(data: Buffer, integrity: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) return false;
  const digest = createHash('sha512').update(data).digest('base64');
  return digest === match[1];
}

/**
 * tar 条目安全判定：拒绝绝对路径、盘符、以及任何 `..` 段。
 *
 * 我们对 tarball 已经做了 sha512 校验，这一层是纵深防御 —— 上游包如果被
 * 替换（或镜像投毒而 integrity 被同步改掉），也不能写出安装根之外。
 */
export function isSafeTarEntry(name: string): boolean {
  if (!name) return false;
  if (name.includes('\0')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  const parts = name.split(/[\\/]+/);
  if (parts.includes('..')) return false;
  return true;
}

/** Windows 自带 bsdtar（1803+）。用绝对路径，不依赖 PATH 被改过。 */
export function systemTarPath(): string | null {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const p = path.join(root, 'System32', 'tar.exe');
    return fs.existsSync(p) ? p : null;
  }
  return fs.existsSync('/usr/bin/tar') ? '/usr/bin/tar' : null;
}

function runTar(tar: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tar, args, { windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => {
      stdout += String(d);
    });
    child.stderr?.on('data', d => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tar 退出码 ${code}${stderr.trim() ? `：${stderr.trim().split('\n')[0]}` : ''}`));
    });
  });
}

/**
 * 解包 npm tarball 到指定目录（导出供闸门做真实 tar 往返验证）。
 *
 * `package/` 前缀是 npm pack 的固定布局，这里原样保留，安装时再整体搬走。
 */
export async function extractTarball(tgzPath: string, destDir: string, signal?: AbortSignal): Promise<void> {
  const tar = systemTarPath();
  if (!tar) {
    throw new Error('系统缺少 tar 解压组件（Windows 需要 1803 以上版本的 System32\\tar.exe）');
  }
  const signalOrNone = signal ?? new AbortController().signal;
  const listing = await runTar(tar, ['-tf', tgzPath], signalOrNone);
  for (const raw of listing.split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    if (!isSafeTarEntry(name)) throw new Error(`tarball 含不安全条目：${name}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  await runTar(tar, ['-xzf', tgzPath, '-C', destDir], signalOrNone);
}

async function downloadTo(
  url: string,
  filePath: string,
  job: DownloadJob,
  touch: () => void
): Promise<void> {
  const res = await fetch(url, { signal: job.controller.signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  job.total = Number(res.headers.get('content-length') ?? 0) || 0;
  const stream = fs.createWriteStream(filePath);
  const reader = res.body.getReader();
  // 只挂一个 error 监听：每次背压都挂一个会把 listeners 堆到上限（实测 11 个时告警）
  const streamError = new Promise<never>((_, reject) => {
    stream.once('error', reject);
  });
  // 边读边写：写盘失败（磁盘满等）时 finished / streamError 会 reject，不会留下未处理的 error 事件。
  const writer = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      touch();
      job.received += value.byteLength;
      if (!stream.write(Buffer.from(value))) {
        await Promise.race([
          new Promise<void>(resolve => stream.once('drain', resolve)),
          streamError,
        ]);
      }
    }
    stream.end();
  })();
  await Promise.all([writer, finished(stream)]);
}

async function installComponent(id: VendorComponentId, job: DownloadJob): Promise<void> {
  const spec = VENDOR_COMPONENTS[id];
  const base = path.join(dataDirPath, 'vendor');
  const workDir = path.join(base, `.tmp-${id}-${Date.now()}`);
  const tgzPath = path.join(workDir, `${id}.tgz`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    let lastError: unknown = null;
    for (const url of spec.tarballUrls) {
      job.received = 0;
      try {
        await downloadTo(url, tgzPath, job, () => {
          clearIdleTimer(job);
          job.idleTimer = setTimeout(() => {
            job.controller.abort(new Error('网络 120 秒无数据，已中止下载'));
          }, 120_000);
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (job.cancelled) throw error;
      }
    }
    if (lastError) throw lastError;

    clearIdleTimer(job);
    const data = fs.readFileSync(tgzPath);
    if (!verifyTarballIntegrity(data, spec.integrity)) {
      throw new Error('校验失败：下载文件与锁定版本不一致，已丢弃');
    }

    const unpackDir = path.join(workDir, 'unpack');
    await extractTarball(tgzPath, unpackDir, job.controller.signal);

    const pkgDir = path.join(unpackDir, 'package');
    if (!fs.existsSync(pkgDir)) throw new Error('tarball 结构异常：缺少 package/ 目录');
    if (!resolveEntryFile(pkgDir, spec.entryPath)) {
      throw new Error(`组件入口缺失（期望 ${spec.entryPath}）`);
    }

    // 安装目录整体替换：先删旧目录再改名。这里只碰 <dataDir>/vendor/<id>/，
    // 不与 chat.db、avatars 等用户数据交叉。
    const target = vendorComponentRoot(id);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(pkgDir, target);
  } finally {
    clearIdleTimer(job);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响已安装结果，下次启动会再清 */
    }
  }
}

/**
 * 启动下载。同步返回是否受理：真正的下载在后台跑，前端轮询
 * `vendorComponentStatus` 拿进度。
 */
export function startVendorComponentDownload(
  id: VendorComponentId
): { ok: true } | { ok: false; error: string } {
  if (resolveVendorComponentBinary(id)) return { ok: false, error: '组件已就绪，无需下载' };
  const running = jobs.get(id);
  if (running && !running.cancelled && !running.error) {
    return { ok: false, error: '这个组件正在下载中' };
  }

  const job: DownloadJob = {
    controller: new AbortController(),
    received: 0,
    total: 0,
    cancelled: false,
    idleTimer: null,
  };
  jobs.set(id, job);

  void installComponent(id, job)
    .then(() => {
      jobs.delete(id);
      console.log(`[VendorComponents] ${id} 安装完成`);
    })
    .catch(error => {
      const cancelled = job.cancelled;
      if (cancelled) {
        jobs.delete(id);
        console.log(`[VendorComponents] ${id} 下载已取消`);
        return;
      }
      job.error = error instanceof Error ? error.message : String(error);
      clearIdleTimer(job);
      console.error(`[VendorComponents] ${id} 安装失败：${job.error}`);
    });

  return { ok: true };
}

/** 取消进行中的下载；没有在下载时返回 false。 */
export function cancelVendorComponentDownload(id: VendorComponentId): boolean {
  const job = jobs.get(id);
  if (!job || job.cancelled || job.error) return false;
  job.cancelled = true;
  clearIdleTimer(job);
  job.controller.abort(new Error('用户取消'));
  return true;
}
