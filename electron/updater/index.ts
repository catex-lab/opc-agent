/**
 * 主进程里的更新控制器。
 *
 * ## 职责边界
 *
 * 这里只做**副作用**：HTTPS 下载、落盘、写标记、退出时交给分离进程替换
 * `resources/app.asar`。判定逻辑（版本、验签、哈希、路径）全部在
 * `shared/update-manifest.ts`，由 `verify:a171-update` 穷举。
 *
 * ## 三条不可退让的约束
 *
 * 1. **绝不写用户数据目录**。下载与标记落在系统 temp 下的
 *    `opc-agent-update/`，`data/`（会话库、图片缓存）一个字节都不碰。
 * 2. **只有白名单里的那个文件会被替换**：`<resources>/app.asar`。
 *    清单里的文件名已经在解析阶段拒绝路径分隔符 / `..` / 盘符。
 * 3. **fail closed**：网络、验签、摘要、写盘任一失败都停在 error 态，
 *    没有「跳过校验继续装」的分支。
 *
 * ## 启动失败自动回滚
 *
 * 替换动作交给 `swap-helper-source.ts` 里那个分离进程：它等本进程退出 →
 * 备份旧 asar → 放入新 asar → 启动新版本 → 45 秒内等健康文件；等不到
 * 就恢复 `.bak` 并重启旧版本。健康文件由本文件的 `confirmHealthy()` 在
 * 窗口加载成功后写出。
 */

import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import type { UpdateAsset, UpdateManifest, UpdateReleaseInfo, UpdateState } from '../../shared/update.js';
import { checkAssetUrl, evaluateManifest, isLegacyPubkeyFailure, parseManifest } from '../../shared/update-manifest.js';
import {
  CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  HEALTH_TIMEOUT_MS,
  UPDATE_PUBLIC_KEY_BASE64,
  manifestUrl,
  releasesPageUrl,
} from './config.js';
import { clearApplyArtifacts, sweepStagedFiles } from './apply-artifacts.js';
import { decideBootOutcome, isDismissableError } from './boot-outcome.js';
import { SWAP_HELPER_SOURCE } from './swap-helper-source.js';

/** 下载/暂存目录：系统 temp，绝不写进 data/ */
function stagingDir(): string {
  const override = process.env.OPC_UPDATE_STAGING_DIR?.trim();
  if (override) return override;
  return join(app.getPath('temp'), 'opc-agent-update');
}

function ensureStagingDir(): string {
  const dir = stagingDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 暂存文件的**唯一定义点**：下载写它、交接前校验它、传给 helper 也用它。
 * 任何一处再手写文件名都会重新长出这次的 bug。
 *
 * ⚠️ 结尾**绝不能**是 `.asar`。Electron 会把以 `.asar` 结尾的路径当成 asar
 * 归档交给 asar 层：`statSync` 返回 0、`createReadStream` 直接抛
 * `ENOENT, not found in <path>`。1.0.2 真机上就是这么失败的 —— 包好好躺在
 * temp 里（42,129,728 B），读它的主进程却报「不存在」。
 *
 * 命名成 `<asset>.download`（而不是裸 `<asset>`）还能顺带区分「下载完的」
 * 与 `.part`（半成品）。
 */
function stagedFile(dir: string, assetName: string): string {
  return join(dir, `${assetName}.download`);
}

/** 一次更新留在磁盘上的所有位置：暂存目录 + resources 下的 `.bak` */
function applyArtifactScope(): { stagingDir: string; backupPath: string } {
  return {
    stagingDir: stagingDir(),
    backupPath: `${join(process.resourcesPath, 'app.asar')}.bak`,
  };
}

interface PendingAsset {
  version: string;
  asset: UpdateAsset;
  stagedPath: string;
}

interface ApplyMarker {
  state?: 'pending' | 'unconfirmed' | 'confirmed' | 'rolled-back' | 'failed';
  version?: string;
  error?: string;
  at?: string;
}

class UpdateFailed extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function markerPath(): string {
  return join(stagingDir(), 'apply-state.json');
}

function healthPath(): string {
  return join(stagingDir(), 'health.json');
}

function readMarker(): ApplyMarker | null {
  try {
    return JSON.parse(readFileSync(markerPath(), 'utf8')) as ApplyMarker;
  } catch {
    return null;
  }
}

function writeMarker(patch: ApplyMarker): void {
  try {
    const prev = readMarker() ?? {};
    writeFileSync(markerPath(), JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2));
  } catch {
    /* 标记写不进去只影响回滚证据，不该阻塞下载/安装 */
  }
}

/* ══════════════ 网络 ══════════════ */

/**
 * 手动跟随重定向，每一跳都重新做 HTTPS + 域名白名单校验。
 *
 * 用 `redirect: 'follow'` 会漏掉中间跳转的域名校验 —— 一个白名单域名
 * 完全可以 302 到任意主机。这里逐跳校验，跳数也有上限。
 */
async function fetchChecked(url: string, timeoutMs: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const err = checkAssetUrl(current);
    if (err) throw new UpdateFailed('manifest-invalid', err);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal });
    } catch (e) {
      throw new UpdateFailed(
        'network',
        `网络请求失败：${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new UpdateFailed('network', `重定向缺少 Location（HTTP ${res.status}）`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new UpdateFailed('network', `服务端返回 HTTP ${res.status}`);
    return res;
  }
  throw new UpdateFailed('network', '重定向次数过多');
}

async function fetchManifest(): Promise<unknown> {
  const res = await fetchChecked(manifestUrl(), 20_000);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdateFailed('manifest-invalid', '清单不是合法 JSON');
  }
}

/* ══════════════ 文件 ══════════════ */

async function fileDigest(path: string): Promise<{ size: number; sha512: string }> {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    size += buf.length;
    hash.update(buf);
  }
  return { size, sha512: hash.digest('base64') };
}

function sameBase64(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  return x.length === y.length && x.equals(y);
}

/**
 * 单次读取的超时包装。
 *
 * `fetchChecked` 的超时只覆盖「拿到响应头」；正文开始后若连接卡住，
 * 进度会永远停在同一个数上、状态机也停在 downloading。这里给每次读取
 * 设 60 秒上限，超时按网络失败处理（fail closed，不继续装）。
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpdateFailed('network', '下载超时：长时间没有收到数据')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 下载单个资产到暂存目录。
 *
 * 边下边算 sha512，**不把整个 asar 读进内存**；结束时同时校验字节数与
 * 摘要。中途超过清单声明的大小时立即中止 —— 否则一个被替换的下载源
 * 可以先把磁盘写满再被拒绝。
 */
async function downloadAsset(
  asset: UpdateAsset,
  onProgress: (received: number, total: number) => void
): Promise<string> {
  const dir = ensureStagingDir();
  const staged = stagedFile(dir, asset.name);
  const part = `${staged}.part`;
  rmSync(part, { force: true });

  const res = await fetchChecked(asset.url, 10 * 60_000);
  if (!res.body) throw new UpdateFailed('network', '响应没有内容');

  const hash = createHash('sha512');
  let received = 0;
  const stream = createWriteStream(part);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await readChunk(reader, 60_000);
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > asset.size) {
        throw new UpdateFailed('digest', '下载体积超过清单声明，已中止');
      }
      hash.update(value);
      if (!stream.write(value)) await once(stream, 'drain');
      onProgress(received, asset.size);
    }
  } catch (e) {
    stream.destroy();
    rmSync(part, { force: true });
    if (e instanceof UpdateFailed) throw e;
    throw new UpdateFailed('network', `下载中断：${e instanceof Error ? e.message : String(e)}`);
  }

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });

  const actualDigest = hash.digest('base64');
  if (received !== asset.size) {
    rmSync(part, { force: true });
    throw new UpdateFailed('digest', `体积不符：期望 ${asset.size}，实际 ${received}`);
  }
  if (!sameBase64(actualDigest, asset.sha512)) {
    rmSync(part, { force: true });
    throw new UpdateFailed('digest', '摘要不符（下载内容与清单不一致）');
  }

  // 同目录改名：目标文件要么不存在、要么是完整内容，不会出现半截包
  rmSync(staged, { force: true });
  renameSync(part, staged);
  return staged;
}

/* ══════════════ 控制器 ══════════════ */

/**
 * 最新 Release 里的完整包直链。
 *
 * 只有 `parseManifest` 通过（版本号已被校验为合法 SemVer）时才拼版本号；
 * 否则退回 Release 页面 —— 验签失败时清单正文不可信，不能拿它拼出一个
 * 可能 404 的地址当唯一出口。
 */
function fullZipUrl(version?: string): string {
  return version
    ? `${releasesPageUrl()}/download/OPC-Agent-${version}-x64-full.zip`
    : releasesPageUrl();
}

class UpdateController {
  private state: UpdateState;
  private pending: PendingAsset | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastEmit = 0;

  constructor() {
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      supported: app.isPackaged,
    };
  }

  getState(): UpdateState {
    return JSON.parse(JSON.stringify(this.state)) as UpdateState;
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('opc:update-state', snapshot);
    }
  }

  private fail(code: string, message: string): void {
    this.set({
      phase: 'error',
      progress: undefined,
      error: { code, message, manualUrl: releasesPageUrl() },
      checkedAt: new Date().toISOString(),
      // 普通失败必须显式清掉旧版提示，避免上一次的标记残留到新错误上
      legacyManualUpdate: false,
    });
  }

  /** 启动后延迟检查一次，之后每 6 小时一次；只检查，不下载 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reportBootOutcome();
    const schedule = (): void => {
      if (this.checkTimer) clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => {
        void this.check();
      }, CHECK_DELAY_MS);
      this.checkTimer.unref?.();
    };
    schedule();
    this.intervalTimer = setInterval(schedule, CHECK_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  /**
   * 上一次退出时的替换结果。
   *
   * 只有「失败记录指向的版本仍比当前版本新」才需要告诉用户 —— 用户可能
   * 已经手动装了完整包、或重试成功过一次，这时旧记录已被现实消解：既不该
   * 再展示，也不该让一个永久失败记录留在 temp 里。判定见 `boot-outcome.ts`。
   */
  private reportBootOutcome(): void {
    const marker = readMarker();
    const outcome = decideBootOutcome(marker, this.state.currentVersion);
    if (outcome.kind === 'none' || outcome.kind === 'in-progress') return;

    if (outcome.kind === 'resolved') {
      // 已消解 / 已成功：静默清掉状态文件与所有中间产物，不打扰用户
      this.clearApplyResidue();
      return;
    }

    // 仍要展示：状态文件留给界面，其余残留一并清掉（失败路径不留渣）
    this.clearApplyResidue({ keepState: true });
    if (outcome.kind === 'rolled-back') {
      this.set({
        phase: 'error',
        legacyManualUpdate: false,
        error: {
          code: 'rollback',
          message: `版本 ${outcome.version ?? ''} 启动失败，已自动回滚到 ${this.state.currentVersion}`.trim(),
          manualUrl: releasesPageUrl(),
        },
      });
    } else {
      // 这条必须让用户一直看得见：交接 helper 失败时文件根本没换，桌面版
      // 重启后仍是旧版本。以前它只在启动后 5 秒内存在，随后自动检查把它清掉，
      // 用户看到的就是「重启了还是旧版本、界面还提示有新版本」。
      this.set({
        phase: 'error',
        legacyManualUpdate: false,
        error: {
          code: 'apply-failed',
          message: `上次更新没有装好：${outcome.error ?? '未知原因'}。可以重新下载并重试；若反复失败，请先关闭所有 OPC Agent 窗口，或手动下载完整包。`,
          manualUrl: releasesPageUrl(),
        },
      });
    }
  }

  /**
   * 用户点「忽略」：清掉上次交接失败的提示与残留。
   *
   * 只接受 `apply-failed` / `rollback`（见 `isDismissableError`）：网络、
   * 验签、哈希这类错误重试一次就会重新出现，给「忽略」只会让用户误以为
   * 问题消失了。
   */
  dismissError(): UpdateState {
    if (!isDismissableError(this.state.error?.code)) return this.getState();
    this.clearApplyResidue();
    this.set({
      phase: this.state.phase === 'error' ? 'idle' : this.state.phase,
      error: undefined,
      legacyManualUpdate: false,
    });
    return this.getState();
  }

  /** 清掉状态文件与中间产物；清不了的留给下次启动，不改变任何结论 */
  private clearApplyResidue(opts: { keepState?: boolean; keepHealth?: boolean } = {}): void {
    clearApplyArtifacts({ ...applyArtifactScope(), ...opts });
  }

  async check(): Promise<UpdateState> {
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      return this.getState();
    }
    if (!this.state.supported) {
      this.set({ phase: 'idle' });
      return this.getState();
    }
    // 启动时的 5 秒自动检查不能把「上次更新没装好」清掉：那是用户必须看到的
    // 事实，只有他自己点「下载更新」重试时才应消失。
    const stickyApplyError =
      this.state.error?.code === 'apply-failed' || this.state.error?.code === 'rollback'
        ? this.state.error
        : undefined;
    this.set({
      phase: 'checking',
      error: stickyApplyError,
      progress: undefined,
      legacyManualUpdate: false,
    });
    try {
      const raw = await fetchManifest();
      const decision = evaluateManifest(raw, {
        currentVersion: this.state.currentVersion,
        runtimeVersion: process.versions.electron,
        publicKeyBase64: UPDATE_PUBLIC_KEY_BASE64,
      });

      if (decision.status === 'invalid') {
        // 旧版客户端（≤1.0.0）内置旧公钥，看到新私钥签的清单必然「签名不匹配」。
        // 这是唯一可以把它解释成「需要手动更新一次」的组合；其余 code 一律照实报错。
        if (isLegacyPubkeyFailure(decision.code, this.state.currentVersion)) {
          const parsed = parseManifest(raw);
          this.set({
            phase: 'error',
            progress: undefined,
            checkedAt: new Date().toISOString(),
            legacyManualUpdate: true,
            error: {
              code: 'signature',
              message: '此版本需手动更新一次',
              manualUrl: fullZipUrl(parsed.manifest?.version),
            },
          });
        } else {
          this.fail(decision.code, decision.message);
        }
        return this.getState();
      }
      if (decision.status === 'latest') {
        this.pending = null;
        this.set({
          phase: 'latest',
          release: undefined,
          checkedAt: new Date().toISOString(),
          stagedVersion: undefined,
        });
        return this.getState();
      }

      const manifest = raw as UpdateManifest;
      const release: UpdateReleaseInfo = {
        version: manifest.version,
        releasedAt: manifest.releasedAt,
        notes: manifest.notes,
        channel: manifest.channel,
        size: manifest.assets.asar.size,
        fullSize: manifest.assets.full.size,
        fullUrl: manifest.assets.full.url,
        requiresFull: decision.requiresFull,
      };
      this.pending = { version: manifest.version, asset: manifest.assets.asar, stagedPath: '' };
      // 这里同样不清 error：上一次交接失败的提示要和新版本信息一起显示
      this.set({ phase: 'available', release, checkedAt: new Date().toISOString() });
      return this.getState();
    } catch (e) {
      if (e instanceof UpdateFailed) this.fail(e.code, e.message);
      else this.fail('network', `检查更新失败：${e instanceof Error ? e.message : String(e)}`);
      return this.getState();
    }
  }

  async download(): Promise<UpdateState> {
    const { phase, release } = this.state;
    if (phase !== 'available' || !release || !this.pending) return this.getState();
    if (release.requiresFull) {
      this.fail('unsupported', '本次更新需要完整安装包，不能只替换代码层');
      return this.getState();
    }
    if (!this.state.supported) return this.getState();

    this.set({
      phase: 'downloading',
      error: undefined,
      progress: { received: 0, total: release.size, percent: 0 },
    });

    try {
      const dir = ensureStagingDir();
      const staged = await downloadAsset(this.pending.asset, (received, total) => {
        const now = Date.now();
        if (now - this.lastEmit < 100) return;
        this.lastEmit = now;
        this.set({
          progress: {
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
          },
        });
      });
      this.pending.stagedPath = staged;
      // 清掉旧版本残留与半成品，只保留本次待安装的那一个
      sweepStagedFiles(dir, staged);
      this.set({
        phase: 'ready',
        progress: undefined,
        stagedVersion: this.pending.version,
      });
    } catch (e) {
      if (e instanceof UpdateFailed) this.fail(e.code, e.message);
      else this.fail('io', `下载失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return this.getState();
  }

  /**
   * 交给分离进程替换 asar，然后退出。
   *
   * 替换前再算一次摘要 —— 暂存文件可能在这期间被别的东西动过；只信
   * 清单，不信「上次下载时是对的」。
   *
   * 这一段**不允许抛异常**：它由 `opc:update-quit-install` 直连按钮，
   * 抛出去会被 Electron 包成 `Error invoking remote method ...`，用户只
   * 能看到一串英文。任何读不出来 / 对不上都得转成一句中文 + 可重试状态。
   */
  async quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.supported) return { ok: false, error: '当前不是打包版，不能替换 app.asar' };
    if (this.state.phase !== 'ready' || !this.pending) {
      return { ok: false, error: '没有已下载好的更新' };
    }
    const { asset, version } = this.pending;
    const dir = ensureStagingDir();
    // 路径必须走同一个函数：下载时写哪儿、交接时读哪儿，不允许各写一遍
    const stagedPath = stagedFile(dir, asset.name);

    if (!existsSync(stagedPath)) {
      return this.abandonStaged('io', '暂存的更新文件不见了（可能被系统清理），请重新下载');
    }

    let digest: { size: number; sha512: string };
    try {
      digest = await fileDigest(stagedPath);
    } catch (e) {
      return this.abandonStaged(
        'io',
        `暂存的更新文件读不出来（${e instanceof Error ? e.message : String(e)}），请重新下载`
      );
    }
    if (digest.size !== asset.size || !sameBase64(digest.sha512, asset.sha512)) {
      return this.abandonStaged('digest', '暂存文件与清单不一致，已删除，请重新下载');
    }

    const targetAsar = join(process.resourcesPath, 'app.asar');
    if (!existsSync(targetAsar)) {
      return { ok: false, error: '找不到 resources/app.asar（不是打包形态）' };
    }

    const helperPath = join(dir, 'update-swap.cjs');
    const jobPath = join(dir, 'apply-job.json');
    writeFileSync(helperPath, SWAP_HELPER_SOURCE, 'utf8');
    writeFileSync(
      jobPath,
      JSON.stringify(
        {
          parentPid: process.pid,
          version,
          targetAsar,
          stagedAsar: stagedPath,
          stagedSize: asset.size,
          backupPath: `${targetAsar}.bak`,
          markerPath: markerPath(),
          healthPath: healthPath(),
          helperPath,
          jobPath,
          appExe: process.execPath,
          healthTimeoutMs: HEALTH_TIMEOUT_MS,
        },
        null,
        2
      ),
      'utf8'
    );
    writeMarker({ state: 'pending', version });

    try {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      const child = spawn(process.execPath, [helperPath, jobPath], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      if (!child.pid) throw new Error('helper 进程没有启动');
      child.unref();
    } catch (e) {
      return this.abandonStaged(
        'io',
        `替换进程没有启动（${e instanceof Error ? e.message : String(e)}），请重新下载`
      );
    }

    setTimeout(() => app.quit(), 120);
    return { ok: true };
  }

  /**
   * 暂存包缺失 / 读不出来 / 摘要不符 / helper 没起来：清掉半成品与交接触点，
   * 回到可重试的错误态。
   *
   * 「可重试」的意思是：状态机不再是 `ready`（不会让用户反复点「退出并重启」），
   * 且这一版仍能从「检查更新」重新走一遍下载；暂存目录里不会留下半个包。
   */
  private abandonStaged(code: string, message: string): { ok: false; error: string } {
    this.pending = null;
    // 暂存包已不可信：连同状态文件、交接脚本、`.bak`、健康文件一起清掉
    this.clearApplyResidue();
    this.set({ stagedVersion: undefined });
    this.fail(code, message);
    return { ok: false, error: message };
  }

  /**
   * 窗口加载成功后写健康文件（分离进程据此判定新版本「起来了」）。
   *
   * 只在存在待确认标记时写 —— 正常启动不该在 temp 里留一个文件。
   */
  confirmHealthy(): void {
    const marker = readMarker();
    // 只有 helper 真正换过文件（unconfirmed）才写健康文件。`pending` 只是
    // 「请求了替换」，helper 可能还没起来 —— 此时标记健康会误导 helper，
    // 也会把已下载好的暂存 asar 一并清掉。
    if (marker?.state !== 'unconfirmed') return;
    const version = this.state.currentVersion;
    try {
      ensureStagingDir();
      writeFileSync(
        healthPath(),
        JSON.stringify({ version, at: new Date().toISOString() }, null, 2)
      );
      writeMarker({ state: 'confirmed', version });
      // 成功升级后不留常驻状态：`.bak`、下载包、job、helper、状态文件一并清掉。
      // health.json 必须留到 helper 读到它（否则会被判成启动失败而回滚）。
      this.clearApplyResidue({ keepHealth: true });
    } catch {
      /* 健康检查写失败不该影响启动 */
    }
  }

  dispose(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.checkTimer = null;
    this.intervalTimer = null;
  }
}

export const updater = new UpdateController();
