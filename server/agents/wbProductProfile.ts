/**
 * A211：WorkBuddy 官方产品配置的**运行时发现**与 profile 选择。
 *
 * ## 为什么必须有这一层
 *
 * `definitions.ts` 里 WorkBuddy 的三项参数（environment / endpoint / configDir）
 * 是 2026-10 从 `~/.workbuddy/cache/acc-product-config-v3.json` 抄下来的快照。
 * 抄的时候是对的，错在把**官方会随版本改的声明**当成了常量：
 *
 * - 官方客户端把国内版与国际版的安装程序合并后，活跃数据目录从
 *   `~/.workbuddy` 换成了 `~/.workbuddy-ai`；我们仍指旧目录，读到
 *   2026-09-24 的 keyblob ⇒ 每次发消息 401，而「重新登录」刷不到旧目录。
 * - 同一份配置里官方自己写了 `dataFolderName` / `endpoint` /
 *   `networkEnvironment` / `productName`，还写了 `productConfigPathEnv`。
 *   也就是说：**该跟随的事实一直都在磁盘上，只是我们没去读**。
 * - 产品配置现在按进程落多份带 PID+UUID 后缀的快照，不再写固定的
 *   `acc-product-config-v3.json`，只读固定名的旧代码恒返回 null。
 *
 * 于是这里把所有 WorkBuddy 相关的磁盘事实收敛到一个模块：扫描 → 读官方声明
 * → 选活跃 profile → 派生运行参数 / keyblob 路径 / 模型补齐源 / 自定义模型。
 * 定义表那三项**保留**，但降级为①兜底（一个客户端都没装）②漂移告警的对照基准。
 *
 * ## 覆盖四种安装组合（验收口径）
 *
 * | 本机状态 | 行为 |
 * | --- | --- |
 * | 只装国内版 / 只装国际版 | 自动选中那一个，端点/环境/配置根/清单全跟着它走 |
 * | 两个都装 | 按活跃度自动选正在用的那个，可在设置里固定或一键切换 |
 * | 一个都没装 / 未登录 | 退回定义表内置值，明确标 `fallback: true` + 漂移告警，不显示假绿 |
 *
 * 扫描不写死目录名列表：遍历主目录顶层，凡 `<dir>/cache/acc-product-config-v3*.json`
 * 存在即认为是一个官方数据根，并用配置里的 `dataFolderName` 自证身份。
 * 官方以后改目录名、新增第三个版本，不用改代码。
 *
 * ## 隐私边界（不可放宽）
 *
 * `<root>/models.json` 是官方客户端保存的自定义模型，**含用户填写的 apiKey 与 url**。
 * 本模块只把 `id / name / vendor / 能力布尔位` 挑出来构造成展示对象，
 * 绝不把 `apiKey` / `url` 放进返回值、日志、落盘结构或任何 HTTP 响应。
 * 调用自定义模型时由官方 SDK 自己读它自己目录里的凭据 —— 我们不代管、不转发。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDirPath } from '../paths.js';
import { findDef, type SdkSpec } from './definitions.js';
import type { CliConfiguredModel } from './cliConfiguredModels.js';

const CONFIG_BASENAME = 'acc-product-config-v3.json';
const CONFIG_PREFIX = 'acc-product-config-v3';
/** 一个数据根下最多合并几份快照（官方每次启动可能落一份，按 mtime 取新的） */
const MAX_SNAPSHOTS = 8;
const MAX_CUSTOM_MODELS = 50;
const MAX_MODEL_ID_LEN = 200;
/** 磁盘发现结果的缓存时长；切换 profile 时由 invalidateWorkbuddyProfile() 显式清掉 */
const CACHE_TTL_MS = 30_000;
/** 磁盘快照的新鲜度上限：与 wbProductConfig 的 7 天口径一致，但判 mtime 而非构建日 */
export const WB_SNAPSHOT_FRESH_MS = 7 * 86_400_000;

export interface WorkbuddyProfile {
  /** 稳定 id = 官方自己写的 dataFolderName（如 `.workbuddy` / `.workbuddy-ai`） */
  id: string;
  productName: string;
  applicationName?: string;
  /** 数据根绝对路径 */
  root: string;
  dataFolderName: string;
  endpoint: string;
  environment: 'internal' | 'external';
  region: 'cn' | 'intl';
  authType?: string;
  /** 官方配置里的构建日（只作展示，不作新鲜度判据） */
  configDate?: string;
  configCommit?: string;
  keyblobAt?: number;
  modelsAt?: number;
  configAt?: number;
  /** 活跃度：上面三种时间戳的最大值，越大说明官方客户端越近还在写它 */
  activity: number;
  /** 是否真的从官方产品配置读到（false = 定义表内置兜底） */
  detected: boolean;
  /** 四项关键声明是否齐全；缺项时对应字段回退到定义表，并在 UI 上诚实标注 */
  complete: boolean;
}

export interface ProfileDrift {
  field: 'configDir' | 'endpoint' | 'environment';
  hardcoded: string;
  official: string;
}

export interface WorkbuddyState {
  profiles: WorkbuddyProfile[];
  activeId: string;
  /** 用户手动固定了 profile（否则是自动按活跃度选的） */
  pinned: boolean;
  /** 生效的是定义表内置兜底（没检测到任何官方产品配置） */
  fallback: boolean;
  /** 生效值与定义表硬编码值不一致 —— 官方更新没跟上时当天就能看见 */
  drift: ProfileDrift[];
  reason: string;
  /** 脱敏后的自定义模型（只含展示字段） */
  customModels: CliConfiguredModel[];
}

interface MergedConfig {
  cfg: Record<string, unknown>;
  /** 这批快照里最新的 mtime */
  at: number;
}

/** 测试夹具用：把主目录指向临时目录，不碰真实用户数据 */
function homeDir(): string {
  return process.env.OPC_WB_HOME || os.homedir();
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function safeJson(p: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * 展示字段的安全化。
 *
 * `models.json` 是用户在桌面端自由编辑的，`name` / `vendor` 理论上可以填进
 * 任意长文本甚至整段凭据。这里不是在做输入校验，而是在守隐私边界：
 * 只取一行、限长、剥控制字符，确保返回值里**只可能**是人类可读的标签。
 */
function display(v: unknown, max = 120): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const oneLine = s.replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return oneLine ? oneLine.slice(0, max) : undefined;
}

/**
 * 该数据根下所有官方产品配置快照，按 mtime 降序。
 *
 * 官方现在落 `acc-product-config-v3-<pid>-<uuid>.json`；旧版本落不带后缀的
 * `acc-product-config-v3.json`。两种都认，顺序以文件时间为准 —— 构建日
 * (`cfg.date`) 反映的是官方发版时间，不是本机最后一次使用时间。
 */
export function snapshotFiles(root: string): string[] {
  const cache = path.join(root, 'cache');
  try {
    return fs
      .readdirSync(cache)
      .filter(f => f === CONFIG_BASENAME || (f.startsWith(`${CONFIG_PREFIX}-`) && f.endsWith('.json')))
      .map(f => path.join(cache, f))
      .sort((a, b) => mtimeOf(b) - mtimeOf(a));
  } catch {
    return [];
  }
}

/**
 * 合并一个数据根下的多份快照。
 *
 * 为什么要合并：本机实测同一目录里两类快照字段并不完全一样 ——
 * 含 `agents` 的那类有 `networkEnvironment`，含 `models` 的那类有
 * `productConfigEnv`，只取最新一份可能恰好缺关键字段。按 mtime 从新到旧，
 * **先到先占**、只补缺失键，既不丢新值也不因为一份不完整就放弃整个数据根。
 */
export function readOfficialConfig(root: string): MergedConfig | null {
  const files = snapshotFiles(root).slice(0, MAX_SNAPSHOTS);
  const merged: Record<string, unknown> = {};
  let at = 0;
  for (const file of files) {
    const cfg = safeJson(file);
    if (!cfg) continue;
    for (const [k, v] of Object.entries(cfg)) {
      if (merged[k] === undefined) merged[k] = v;
    }
    at = Math.max(at, mtimeOf(file));
  }
  return Object.keys(merged).length > 0 ? { cfg: merged, at } : null;
}

/** 定义表里保留的三项，作为兜底值与漂移对照基准（不在本模块复制字面量） */
function hardcodedSpec(): { environment: 'internal' | 'external'; endpoint: string; configDir: string } {
  const sdk = findDef('workbuddy')?.sdk;
  return {
    environment: sdk?.environment ?? 'internal',
    endpoint: sdk?.endpoint ?? 'https://www.workbuddy.cn',
    configDir: sdk?.configDir ?? '~/.workbuddy',
  };
}

function expandHome(p: string): string {
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2));
  return p;
}

/** 装了但还没写过产品配置的目录也列出来，让 UI 能如实显示「检测到目录、读不到声明」 */
function fallbackRoots(home: string, found: string[]): string[] {
  const roots: string[] = [];
  const defRoot = expandHome(hardcodedSpec().configDir);
  if (!found.includes(defRoot) && isDir(defRoot)) roots.push(defRoot);
  return roots;
}

function profileFrom(root: string, merged: MergedConfig | null): WorkbuddyProfile {
  const hard = hardcodedSpec();
  const cfg = merged?.cfg ?? {};
  const dataFolderName = str(cfg.dataFolderName) ?? path.basename(root);
  const productName = str(cfg.productName) ?? path.basename(root);
  const endpoint = str(cfg.endpoint) ?? hard.endpoint;
  const rawEnv = str(cfg.networkEnvironment);
  const environment: 'internal' | 'external' =
    rawEnv === 'internal' || rawEnv === 'external' ? rawEnv : hard.environment;
  const auth = cfg.authentication;
  const authType =
    auth && typeof auth === 'object' && !Array.isArray(auth)
      ? str((auth as Record<string, unknown>).type)
      : undefined;

  const keyblobAt = mtimeOf(path.join(root, 'keyblob')) || undefined;
  const modelsAt = mtimeOf(path.join(root, 'models.json')) || undefined;
  const configAt = merged?.at || undefined;
  const activity = Math.max(keyblobAt ?? 0, modelsAt ?? 0, configAt ?? 0);

  return {
    id: dataFolderName,
    productName,
    ...(str(cfg.applicationName) ? { applicationName: str(cfg.applicationName) } : {}),
    root,
    dataFolderName,
    endpoint,
    environment,
    // 用 endpoint 判区域，不用 networkEnvironment：后者描述的是「走不走内网」，
    // 实测两份配置恰好一内一外，但它是网络策略声明，不是产品身份声明。
    region: /\.cn(?:[/:]|$)/.test(endpoint) ? 'cn' : 'intl',
    ...(authType ? { authType } : {}),
    ...(str(cfg.date) ? { configDate: str(cfg.date) } : {}),
    ...(str(cfg.commit) ? { configCommit: str(cfg.commit) } : {}),
    ...(keyblobAt ? { keyblobAt } : {}),
    ...(modelsAt ? { modelsAt } : {}),
    ...(configAt ? { configAt } : {}),
    activity,
    detected: Boolean(merged),
    complete: Boolean(str(cfg.dataFolderName) && str(cfg.productName) && str(cfg.endpoint) && rawEnv),
  };
}

/**
 * 扫描主目录顶层，找出所有官方数据根。
 *
 * 不预设 `.workbuddy` / `.workbuddy-ai` 这两个名字：判据是「该目录下有官方
 * 产品配置快照」。官方改目录名或新增第三个版本时，这里自动认。
 * 只读顶层、不递归，避免误扫进 AppData / node_modules 之类的大树。
 */
export function discoverWorkbuddyProfiles(home: string = homeDir()): WorkbuddyProfile[] {
  const found: string[] = [];
  try {
    for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const root = path.join(home, ent.name);
      if (snapshotFiles(root).length > 0) found.push(root);
    }
  } catch {
    // home 不可读：后面还有定义表兜底，不抛
  }
  for (const root of fallbackRoots(home, found)) found.push(root);

  const profiles = found.map(root => profileFrom(root, readOfficialConfig(root)));
  // 一个都没装 / 一个配置都没写过：给一个明确标注的内置兜底，绝不假装发现了
  if (profiles.length === 0) {
    const hard = hardcodedSpec();
    profiles.push({
      ...profileFrom(expandHome(hard.configDir), null),
      id: path.basename(expandHome(hard.configDir)),
      productName: 'WorkBuddy（内置默认值）',
      detected: false,
      complete: false,
    });
  }
  return profiles.sort((a, b) => b.activity - a.activity);
}

const PIN_PATH = path.join(dataDirPath, 'workbuddy-profile.json');

/**
 * profile 固定值单独一个小文件，不塞进 preferences.json。
 *
 * 它是**服务端运行配置**（决定 SDK 子进程拿哪份凭据），不是界面首帧偏好；
 * 塞进 `window.__OPC_PREFS__` 只会多一条用不到的注入，还会让 A131 那套
 * 首帧同步闸门多一个需要兼顾的键。
 */
export function getPinnedProfile(): string | null {
  const raw = safeJson(PIN_PATH);
  const id = raw && str(raw.pinned);
  return id ?? null;
}

/** 固定 / 取消固定。id 必须是当前真扫到的 profile，否则拒绝写入（不制造指向空气的开关） */
export function setPinnedWorkbuddyProfile(id: string | null): { ok: boolean; reason?: string } {
  if (id !== null) {
    const exists = discoverWorkbuddyProfiles().some(p => p.id === id);
    if (!exists) return { ok: false, reason: `本机没有检测到这个产品版本：${id}` };
  }
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    fs.writeFileSync(PIN_PATH, JSON.stringify({ pinned: id }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    invalidateWorkbuddyProfile();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * 自定义模型：只挑展示字段，**绝不读 apiKey / url 进返回值**。
 *
 * 选中只是把 id 原样交给 SDK（`session.setModel()`），端点与密钥由官方 SDK
 * 从它自己的数据根读取。我们既不代管凭据，也不自行拼请求。
 */
export function readWorkbuddyCustomModels(root: string): CliConfiguredModel[] {
  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: CliConfiguredModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = display(m.id, MAX_MODEL_ID_LEN);
    if (!id) continue;
    const name = display(m.name) ?? id;
    const vendor = display(m.vendor, 40) ?? 'Custom';
    // 只把字符串化的展示信息带出去，能力位一个都不取原对象引用。
    // url / apiKey / supportsXxx 等键一律不读 —— 它们不参与展示。
    out.push({
      id,
      label: name,
      source: `WorkBuddy 桌面端自定义模型 · ${vendor}`,
      agentIds: ['workbuddy'],
    });
    if (out.length >= MAX_CUSTOM_MODELS) break;
  }
  return out;
}

function driftOf(active: WorkbuddyProfile): ProfileDrift[] {
  const hard = hardcodedSpec();
  const drift: ProfileDrift[] = [];
  // official 一律给「~/目录名」而不是绝对路径：这个对象会进 HTTP 响应，
  // 没有理由把用户本机的绝对路径广播给页面；与 hard 的写法同形也更好比对。
  if (active.root !== expandHome(hard.configDir)) {
    drift.push({ field: 'configDir', hardcoded: hard.configDir, official: `~/${active.dataFolderName}` });
  }
  if (active.endpoint !== hard.endpoint) {
    drift.push({ field: 'endpoint', hardcoded: hard.endpoint, official: active.endpoint });
  }
  if (active.environment !== hard.environment) {
    drift.push({ field: 'environment', hardcoded: hard.environment, official: active.environment });
  }
  return drift;
}

let cached: { state: WorkbuddyState; at: number } | null = null;

export function invalidateWorkbuddyProfile(): void {
  cached = null;
}

/**
 * 当前生效状态。带 30s 缓存（每次 probe / 发消息都会问，不能每轮全盘扫描）；
 * 切换 profile 或刷新时显式 invalidate。
 */
export function workbuddyState(force = false): WorkbuddyState {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.state;

  const profiles = discoverWorkbuddyProfiles();
  const pinnedId = getPinnedProfile();
  const pinned = pinnedId ? profiles.find(p => p.id === pinnedId) : undefined;
  const auto = profiles[0];
  const active = pinned ?? auto;
  const fallback = !active?.detected;

  let reason: string;
  if (pinned && pinnedId) reason = `已固定到 ${pinned.productName}（${pinned.dataFolderName}）`;
  else if (profiles.length > 1) {
    reason = `检测到 ${profiles.length} 个版本，自动选用最近活跃的那个；可在设置里固定`;
  } else if (fallback) reason = '未检测到官方客户端的产品配置，使用内置默认值（可能已过期）';
  else reason = `检测到 ${active.productName}，按其官方声明接入`;

  const state: WorkbuddyState = {
    profiles,
    activeId: active?.id ?? '',
    pinned: Boolean(pinned),
    fallback,
    drift: active ? driftOf(active) : [],
    reason,
    customModels: active ? readWorkbuddyCustomModels(active.root) : [],
  };
  cached = { state, at: now };
  return state;
}

export function activeWorkbuddyProfile(): WorkbuddyProfile | undefined {
  const state = workbuddyState();
  return state.profiles.find(p => p.id === state.activeId);
}

/**
 * 把定义表的静态 `SdkSpec` 覆盖成官方声明的运行时值。
 *
 * 只有 workbuddy 走这里；其它 SDK Agent 原样返回，避免把腾讯产品的规则
 * 误套到 claude / codex 的命名空间。两个消费方（index.ts 的 sdkRuntimeFor、
 * SdkAdapter 构造器）都调这一个函数，杜绝 sdkRuntime.ts 头注释担心的
 * 「两处硬编码再次分叉」。
 */
export function applyWorkbuddyProfile(
  spec: SdkSpec | undefined,
  agentId: string
): SdkSpec | undefined {
  if (agentId !== 'workbuddy') return spec;
  const active = activeWorkbuddyProfile();
  if (!active || !active.detected) return spec;
  return {
    ...(spec ?? {}),
    environment: active.environment,
    endpoint: active.endpoint,
    configDir: active.root,
  };
}

/** 供 credentialStatus 显示「keyblob 最后更新」：路径必须跟着生效 profile 走 */
export function workbuddyKeyblobPath(): string {
  return path.join(activeWorkbuddyProfile()?.root ?? expandHome(hardcodedSpec().configDir), 'keyblob');
}

/**
 * 给人看的登录态路径（`~/.workbuddy-ai/keyblob` 这种形态）。
 *
 * 恢复话术与探测来源说明都用这一份：既跟随生效 profile，又不把本机用户名
 * 写进聊天记录 / 名册文案。返回 `~/` 前缀也让旧闸门那条
 * `/~\/\.workbuddy/` 保持有效 —— 它钉的是「说明里必须指出登录态在哪」，
 * 而不是「必须永远是那个旧目录」。
 */
export function workbuddyKeyblobDisplay(): string {
  const folder = activeWorkbuddyProfile()?.dataFolderName ??
    path.basename(expandHome(hardcodedSpec().configDir));
  return `~/${folder}/keyblob`;
}

/** 供 wbProductConfig 补齐模型：返回生效 profile 的合并配置 + 文件新鲜度信号 */
export function officialConfigForActive(): MergedConfig | null {
  const active = activeWorkbuddyProfile();
  if (!active?.detected) return null;
  return readOfficialConfig(active.root);
}

/** 供 /api/agents/:id/models 下发：脱敏后的自定义模型 */
export function workbuddyCustomModels(): CliConfiguredModel[] {
  return workbuddyState().customModels;
}
