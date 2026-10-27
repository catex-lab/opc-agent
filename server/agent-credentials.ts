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

/** 落盘结构：agentId → { key, baseUrl } */
interface StoredCredential {
  key?: string;
  baseUrl?: string;
}

type Store = Record<string, StoredCredential>;

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
function applyToEnv(agentId: string, entry: StoredCredential): void {
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
  for (const [agentId, entry] of Object.entries(store)) {
    applyToEnv(agentId, entry);
  }
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
}

function viewOf(agentId: string): CredentialView | null {
  const def = findDef(agentId);
  const spec = def?.credential;
  if (!def || !spec) return null;

  const entry = readStore()[agentId] ?? {};
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
  return (readStore()[agentId]?.key ?? '').trim();
}

/**
 * 保存凭据。
 *
 * `key` 传空串 = 删除该 Agent 的 Key（界面上的「清除」走这条）。
 * `baseUrl` 同理。
 */
export function saveCredential(
  agentId: string,
  input: { key?: string; baseUrl?: string }
): CredentialView {
  const spec = credentialSpecOf(agentId);
  if (!spec) throw new Error(`该 Agent 不支持在应用内配置凭据：${agentId}`);

  const store = { ...readStore() };
  const prev = store[agentId] ?? {};
  const next: StoredCredential = {
    key: (input.key ?? prev.key ?? '').trim(),
    baseUrl: (input.baseUrl ?? prev.baseUrl ?? '').trim(),
  };

  if (!next.key && !next.baseUrl) delete store[agentId];
  else store[agentId] = next;

  writeStore(store);

  // 清除时要把之前注入的变量删掉，否则「清除」后状态仍然是已配置
  if (!next.key) {
    for (const n of spec.keyEnv) {
      if (process.env[n] && !next.key) delete process.env[n];
    }
  }
  applyToEnv(agentId, next);

  return viewOf(agentId)!;
}

export function clearCredential(agentId: string): CredentialView | null {
  const spec = credentialSpecOf(agentId);
  if (!spec) return null;
  const store = { ...readStore() };
  delete store[agentId];
  writeStore(store);
  for (const n of spec.keyEnv) delete process.env[n];
  if (spec.baseUrlEnv) delete process.env[spec.baseUrlEnv];
  return viewOf(agentId);
}

/** 测试用：清掉内存镜像（下次读盘） */
export function __resetCredentialCache(): void {
  cache = null;
}
