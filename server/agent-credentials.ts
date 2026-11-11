/**
 * 应用内的 Agent 凭据（API Key / 接入地址）。
 *
 * ## 为什么需要这个模块
 *
 * 在这之前，`definitions.ts` 的 `authEnvs` 只认**进程环境变量**。开发态没问题
 * （在终端里 `export ARK_API_KEY=...` 再 `npm run dev`），但打包成 Electron
 * 之后用户是双击图标的 —— 进程环境里不可能有这些变量，而界面上**没有任何
 * 地方能填**。于是「豆包 / Gemini 未登录」变成用户自己解不开的死结：
 * 名册写着未登录，点进去也没有登录入口。
 *
 * 这里补的就是那条入口：设置页填 Key → 落盘到 data 目录 → 注入 `process.env`
 * → 探测与调用读到的就是它。对适配器而言，这与「用户自己 export 过」**完全
 * 等价**，所以不需要在适配器里加任何分支。
 *
 * ## 为什么落在 data 目录而不是数据库
 *
 * `chat.db` 会被导出 / 备份 / 拷给别人看会话记录，把密钥混进去等于给每一次
 * 「发个数据库给我看看」都附带一份凭据。凭据单独一个文件，且权限收紧到
 * 仅当前用户可读写（POSIX 0600；Windows 走用户目录 ACL）。
 *
 * ## 为什么不加密
 *
 * Electron 的 `safeStorage` 只能加密「本来就要靠系统凭据保护」的东西，而
 * 解密密钥同样在这台机器上 —— 加密挡不住任何能在本机读文件的人，却会让
 * 「换个用户账户/换台机器迁移数据」直接解不开。这里选择**如实存明文 + 收紧
 * 文件权限 + 界面上只显示掩码**，并在文档里写清边界，而不是做一层假加密。
 */

import fs from 'fs';
import path from 'path';
import { allAgentDefs, findDef } from './agents/definitions.js';
import { dataDirPath } from './paths.js';

/**
 * 落盘结构（#15 多账号 profile，向后兼容）。
 *
 * 旧形状 `{ key, baseUrl }` 依然合法，且**单账号时仍然按旧形状写盘**：
 * 老版本读不懂 `{active, profiles}`，而新版本两种都认。这样升级 / 降级
 * 都不会把用户已经填好的 Key 弄丢，也不用做一次破坏性的数据迁移。
 *
 * 只有当出现第二个账号（或账号名不是 default）时才落成新形状。
 */
interface ProfileEntry {
  key?: string;
  baseUrl?: string;
}

interface ProfileStore {
  active: string;
  profiles: Record<string, ProfileEntry>;
}

type StoredCredential = ProfileEntry | ProfileStore;
type Store = Record<string, StoredCredential>;

const DEFAULT_PROFILE = 'default';

/** 任意落盘形状 → 统一的内存视图。坏的 active 回落到第一个账号，绝不丢 Key。 */
function normalizeEntry(raw: StoredCredential | undefined): ProfileStore {
  const fallback = { active: DEFAULT_PROFILE, profiles: {} as Record<string, ProfileEntry> };
  if (!raw || typeof raw !== 'object') return fallback;
  const maybe = raw as Partial<ProfileStore> & ProfileEntry;
  if (maybe.profiles && typeof maybe.profiles === 'object' && !Array.isArray(maybe.profiles)) {
    const profiles: Record<string, ProfileEntry> = {};
    for (const [name, entry] of Object.entries(maybe.profiles)) {
      if (!entry || typeof entry !== 'object') continue;
      profiles[name] = {
        key: typeof entry.key === 'string' ? entry.key : '',
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      };
    }
    const names = Object.keys(profiles);
    const active = typeof maybe.active === 'string' && names.includes(maybe.active)
      ? maybe.active
      : (names[0] ?? DEFAULT_PROFILE);
    return { active, profiles };
  }
  // 旧形状：整条当作名为 default 的唯一账号
  return {
    active: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: {
        key: typeof maybe.key === 'string' ? maybe.key : '',
        baseUrl: typeof maybe.baseUrl === 'string' ? maybe.baseUrl : '',
      },
    },
  };
}

/** 单账号写旧形状（向后兼容），多账号才写新形状。 */
function denormalizeEntry(store: ProfileStore): StoredCredential {
  const names = Object.keys(store.profiles);
  if (names.length === 1 && names[0] === DEFAULT_PROFILE) {
    const only = store.profiles[DEFAULT_PROFILE];
    return { key: (only.key ?? '').trim(), baseUrl: (only.baseUrl ?? '').trim() };
  }
  return { active: store.active, profiles: store.profiles };
}

function entryOf(store: Store, agentId: string): ProfileStore {
  return normalizeEntry(store[agentId]);
}

function activeEntryOf(store: Store, agentId: string): ProfileEntry {
  const norm = entryOf(store, agentId);
  return norm.profiles[norm.active] ?? {};
}

const STORE_PATH = path.join(dataDirPath, 'agent-credentials.json');

/** 内存镜像：避免每次探测都读盘 */
let cache: Store | null = null;

function readStore(): Store {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    // 文件不存在 / 内容坏了都当成「还没配过」。**不要**因此覆盖原文件 ——
    // 解析失败时用户手写的凭据还在，覆盖等于静默销毁它。
    cache = {};
  }
  return cache;
}

function writeStore(next: Store): void {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  // rename 之后权限由 tmp 带来；再显式 chmod 一次，兜住 Windows 上
  // rename 不带权限位的差异（POSIX 下是幂等的）
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
  cache = next;
}

/** 取某个 Agent 的凭据规格（没有就返回 undefined） */
export function credentialSpecOf(agentId: string) {
  return findDef(agentId)?.credential;
}

/**
 * 把一条凭据注入进程环境。
 *
 * 空串视为「没填」—— 写一个空的环境变量会让 `authEnvs` 的
 * `trim().length > 0` 判断失效，还会让 CLI 以为「Key 存在但为空」。
 */
function applyToEnv(agentId: string, entry: ProfileEntry): void {
  const spec = credentialSpecOf(agentId);
  if (!spec) return;

  const key = (entry.key ?? '').trim();
  if (key) {
    // 写第一个候选名（其余候选保持原样：用户环境里若已有别名，不该被清掉）
    process.env[spec.keyEnv[0]] = key;
  }

  if (spec.baseUrlEnv) {
    const base = (entry.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (base) process.env[spec.baseUrlEnv] = base;
    else delete process.env[spec.baseUrlEnv];
  }
}

/**
 * 启动时调用：把已保存的凭据全部注入进程环境。
 *
 * 必须在 `registry` 首次探测**之前**跑完（server/index.ts 顶部），
 * 否则冷启动那一轮探测会按「没有 Key」给出 needs-auth，用户要等 5 分钟
 * TTL 过期或手动刷新才会看到正确状态。
 */
export function loadAgentCredentials(): void {
  const store = readStore();
  for (const agentId of Object.keys(store)) {
    // #15：每个 Agent 只注入它当前激活的那个账号，不是把所有账号的 Key 依次
    // 覆盖进同一组环境变量（那样最后一个 profile 会意外生效）。
    applyToEnv(agentId, activeEntryOf(store, agentId));
  }
}

/** 切换 / 删除账号前先把这组变量清干净，避免上个账号的网关地址残留。 */
function resetEnvFor(agentId: string): void {
  const spec = credentialSpecOf(agentId);
  if (!spec) return;
  for (const n of spec.keyEnv) delete process.env[n];
  if (spec.baseUrlEnv) delete process.env[spec.baseUrlEnv];
}

/** 掩码：只露头尾，够用户确认「填的是哪一把」而不泄露全文 */
function mask(key: string): string {
  const v = key.trim();
  if (!v) return '';
  if (v.length <= 10) return `${v.slice(0, 2)}****`;
  return `${v.slice(0, 6)}****${v.slice(-4)}`;
}

export interface CredentialView {
  agentId: string;
  name: string;
  /** 写入用的变量名（第一个候选） */
  keyEnv: string;
  /** 所有被认可的变量名（界面提示用） */
  keyEnvs: string[];
  baseUrlEnv?: string;
  hint?: string;
  /** 是否已在应用内保存过 */
  configured: boolean;
  /** 掩码后的 Key（未保存为空串） */
  masked: string;
  baseUrl: string;
  /**
   * 环境里是否已有同名变量（可能来自用户自己 export）。
   * 界面据此说明「已通过环境变量配置」，避免用户以为必须再填一遍。
   */
  fromEnv: boolean;
  /** #15：当前激活的账号名（老数据恒为 default） */
  activeProfile: string;
  /** #15：已保存的账号数 */
  profileCount: number;
}

function viewOf(agentId: string): CredentialView | null {
  const def = findDef(agentId);
  const spec = def?.credential;
  if (!def || !spec) return null;

  const norm = entryOf(readStore(), agentId);
  const entry = norm.profiles[norm.active] ?? {};
  const envHit = spec.keyEnv.find(n => (process.env[n] ?? '').trim().length > 0);
  const key = (entry.key ?? '').trim();

  return {
    agentId,
    name: def.descriptor.name,
    keyEnv: spec.keyEnv[0],
    keyEnvs: spec.keyEnv,
    baseUrlEnv: spec.baseUrlEnv,
    hint: spec.hint,
    configured: key.length > 0,
    masked: mask(key),
    baseUrl: (entry.baseUrl ?? '').trim(),
    fromEnv: !key && !!envHit,
    activeProfile: norm.active,
    profileCount: Object.keys(norm.profiles).length,
  };
}

/** 全部「可在应用内配置凭据」的 Agent（设置页据此渲染） */
export function listCredentials(): CredentialView[] {
  // A129：自建厂商不再走这一列表。它们的 Key 由「自定义模型厂商」编辑器
  // 统一管理（同一把 Key 在两个地方各有一个输入框，用户不知道该信哪个）。
  // `saveCredential()` 仍然管它们 —— 只是入口换到 ProviderSettings 里。
  return allAgentDefs()
    .filter(d => !d.descriptor.custom)
    .map(d => viewOf(d.descriptor.id))
    .filter((v): v is CredentialView => v !== null);
}

export function getCredential(agentId: string): CredentialView | null {
  return viewOf(agentId);
}

/**
 * 取**原始** Key，只给服务端内部用（目前是厂商连通性测试要拿它发一次请求）。
 *
 * 绝不能出现在任何 API 响应里 —— 对外只有 `getCredential()` 的掩码视图。
 * 之所以测连通时要用明文：测试必须和真实调用发同样的鉴权头，否则测出来的
 * 「通」不成立。
 */
export function getRawCredentialKey(agentId: string): string {
  return getRawCredential(agentId).key;
}

/**
 * 取原始 Key + 接入地址，只给服务端内部用（真实鉴权校验要拿两者各发一次请求）。
 *
 * 与 `getRawCredentialKey()` 同样的红线：**绝不能出现在任何 API 响应里**。
 * 单独留一个「成对」的出口，是因为校验既要 Key 也要网关地址，分两次读会
 * 在「刚保存完」的窗口里读到不一致的两半。
 */
export function getRawCredential(agentId: string): { key: string; baseUrl: string } {
  // #15：只读当前激活的账号。多账号时若还按旧形状的 `entry.key` 取，
  // 校验 / 连通性测试会拿着一个根本不存在的字段永远拿到空串。
  const entry = activeEntryOf(readStore(), agentId);
  return {
    key: (entry.key ?? '').trim(),
    baseUrl: (entry.baseUrl ?? '').trim(),
  };
}

/** 账号名只做最小校验：能显示、不超长、不含控制字符。 */
function normalizeProfileName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = String(raw).trim();
  if (!name) return DEFAULT_PROFILE;
  if (name.length > 32 || /[\u0000-\u001f]/.test(name)) {
    throw new Error('账号名称不合法（不超过 32 个字符，且不能含控制字符）');
  }
  return name;
}

/**
 * 保存凭据。
 *
 * `key` 传空串 = 删除该账号的 Key（界面上的「清除」走 `clearCredential`）。
 * `name` 给了就是「另存为一个账号」，并立刻激活它 —— 用户刚填完新 Key，
 * 下一步就是要用这把 Key，不该再点一次切换。
 */
export function saveCredential(
  agentId: string,
  input: { key?: string; baseUrl?: string; name?: string }
): CredentialView {
  const spec = credentialSpecOf(agentId);
  if (!spec) throw new Error(`该 Agent 不支持在应用内配置凭据：${agentId}`);

  const store = { ...readStore() };
  const norm = entryOf(store, agentId);
  const target = normalizeProfileName(input.name) ?? norm.active;
  const prev = norm.profiles[target] ?? {};
  const entry: ProfileEntry = {
    key: (input.key ?? prev.key ?? '').trim(),
    baseUrl: (input.baseUrl ?? prev.baseUrl ?? '').trim(),
  };

  if (!entry.key && !entry.baseUrl) {
    delete norm.profiles[target];
    const rest = Object.keys(norm.profiles);
    if (rest.length === 0) delete store[agentId];
    else {
      norm.active = rest.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : rest[0];
      store[agentId] = denormalizeEntry(norm);
    }
  } else {
    norm.profiles[target] = entry;
    norm.active = target;
    store[agentId] = denormalizeEntry(norm);
  }

  writeStore(store);

  // 清除时要把之前注入的变量删掉，否则「清除」后状态仍然是已配置
  const active = store[agentId] ? activeEntryOf(store, agentId) : {};
  if (!active.key) for (const n of spec.keyEnv) if (process.env[n]) delete process.env[n];
  applyToEnv(agentId, active);

  return viewOf(agentId)!;
}

export interface ProfileView {
  name: string;
  configured: boolean;
  /** 掩码，不回传明文 */
  masked: string;
  baseUrl: string;
}

export interface ProfileListView {
  agentId: string;
  active: string;
  profiles: ProfileView[];
}

/** 列出该 Agent 的所有账号（对外只有掩码，没有明文 Key）。 */
export function listProfiles(agentId: string): ProfileListView {
  const norm = entryOf(readStore(), agentId);
  return {
    agentId,
    active: norm.active,
    profiles: Object.entries(norm.profiles).map(([name, e]) => {
      const key = (e.key ?? '').trim();
      return {
        name,
        configured: key.length > 0,
        masked: mask(key),
        baseUrl: (e.baseUrl ?? '').trim(),
      };
    }),
  };
}

/** 切换当前生效的账号。不存在的名字直接抛错，由路由转成 404，不静默纠正。 */
export function switchProfile(agentId: string, name: string): CredentialView {
  if (!credentialSpecOf(agentId)) {
    throw new Error(`该 Agent 不支持在应用内配置凭据：${agentId}`);
  }
  const store = { ...readStore() };
  const norm = entryOf(store, agentId);
  const target = String(name ?? '').trim();
  if (!norm.profiles[target]) throw new Error(`账号不存在：${target}`);

  norm.active = target;
  store[agentId] = denormalizeEntry(norm);
  writeStore(store);

  // 关键是「先清后写」：不清的话新账号没填网关地址时，旧账号的
  // baseUrl 会残留，请求打到上一个账号的网关上。
  resetEnvFor(agentId);
  applyToEnv(agentId, norm.profiles[target]);
  return viewOf(agentId)!;
}

/** 删一个账号。至少留一个 —— 全清走 `clearCredential()`，语义不同。 */
export function deleteProfile(agentId: string, name: string): ProfileListView {
  if (!credentialSpecOf(agentId)) {
    throw new Error(`该 Agent 不支持在应用内配置凭据：${agentId}`);
  }
  const store = { ...readStore() };
  const norm = entryOf(store, agentId);
  const target = String(name ?? '').trim();
  if (!norm.profiles[target]) throw new Error(`账号不存在：${target}`);
  if (Object.keys(norm.profiles).length <= 1) {
    throw new Error('至少保留一个账号；要全部清除请用「清除」');
  }

  delete norm.profiles[target];
  const rest = Object.keys(norm.profiles);
  if (norm.active === target) {
    norm.active = rest.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : rest[0];
  }
  store[agentId] = denormalizeEntry(norm);
  writeStore(store);

  resetEnvFor(agentId);
  applyToEnv(agentId, norm.profiles[norm.active]);
  return listProfiles(agentId);
}

export function clearCredential(agentId: string): CredentialView | null {
  const spec = credentialSpecOf(agentId);
  if (!spec) return null;
  const store = { ...readStore() };
  delete store[agentId];
  writeStore(store);
  resetEnvFor(agentId);
  return viewOf(agentId);
}

/** 测试用：清掉内存镜像（下次读盘） */
export function __resetCredentialCache(): void {
  cache = null;
}
