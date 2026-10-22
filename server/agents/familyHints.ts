/**
 * 同厂「其他版本」与「上次实际请求」的本地探测（A69，PLAN-AGENT-FAMILY §6 P1/P2）。
 *
 * ## 这个文件解决什么问题
 *
 * 名册里只有 14 条，但用户机器上往往还装着**同一厂商的另一个版本**：
 * `~/.qoder-cn`（Qoder 国内版桌面端）、`~/.workbuddy-ai`（WorkBuddy 国际版）、
 * `~/.kimi-code/region = mainland-cn`（Kimi Code 当前在中国站）。
 *
 * 如果名册对此一声不吭，用户会得出两个都不好的结论：要么「你们不支持国际版」，
 * 要么更糟 ——「现在这条就是国际版」。所以必须**如实说一句「检测到了，但没接入，因为…」**。
 *
 * ## 三条纪律
 *
 * 1. **只报探测到的事实**。不写「应该」「可能」。拿不到就整块不出现，
 *    不摆一行「未知」占位。
 * 2. **不猜区域**。`~/.workbuddy-ai` 存在不等于它是国际版 —— 要读到
 *    `acc-product-config-v3.json` 里的 `networkEnvironment` 才敢说。
 * 3. **不提供接入按钮**。真接入需要**第二份凭据**（一个子进程只能持一份），
 *    这是用户侧的前置条件，不是点一下就能完成的。所以这里只给文字指引，
 *    不摆一个按下去就失败的假控件（PLAN §7）。
 *
 * ## 为什么要能注入 `home`
 *
 * 这个模块全部靠文件系统判断。写死 `homedir()` 就只能靠「本机碰巧装着什么」来验证，
 * 换台机器脚本就全绿或全红，等于没测。所以每个探测函数都接受 `home`，
 * 测试里用临时目录造夹具（见 `scripts/verify-family-hints.ts`）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 同厂但**未接入**的另一个版本。字段全部是「探测到的事实」，没有推断。 */
export interface LocalSibling {
  /** 若将来接入会用的条目 id。**现在不写进任何地方**，只用于 UI 的 data 属性与文案锚点 */
  id: string;
  /** 厂商官方叫法（与 `regionName` 同一套口径，不自创） */
  name: string;
  regionName: string;
  /** 探测到的绝对路径 —— 用户能自己去看一眼，这比一句「检测到了」可信 */
  detectedPath: string;
  /** 到底探测到了什么（文件 / 字段 / 值） */
  evidence: string;
  /**
   * 现在**缺什么**（前置条件）。有值就表示「不是漏了，是卡在某个条件上」。
   *
   * 与 `nextStep` 是**互补**关系，不是二选一：
   *   - 只 `blockedBy`：卡死了，用户做什么都没用（例：Qoder CN 没有 CLI）；
   *   - `blockedBy` + `nextStep`：卡在一个用户能满足的条件上（例：要另备一份凭据），
   *     `nextStep` 说的是「条件满足之后怎么做」；
   *   - 只 `nextStep`：不卡，只是还没接。
   *
   * ⚠️ 最初把这两个写成互斥，验证脚本一跑就自己撞上了 —— 因为
   * 「国际版要另备凭据」既是前置条件、又确实有下一步可走。**这两个不是同一维度。**
   */
  blockedBy?: string;
  /** 前置条件满足后怎么做（可能是空的：卡死时给不出下一步） */
  nextStep?: string;
}

/**
 * 「上次实际请求走的哪个账号体系」。
 *
 * ⚠️ 措辞必须是**上次请求**，不能写成「当前连接」：这个数据来自使用记录
 * （`model_usage` 表），不是当前设置。zcode 把当前 provider 存在加密字段里，
 * 读不出来 —— 与其猜一个，不如说清楚这条证据是哪来的、有多新。
 */
export interface LastRequestHint {
  /** 归一化后的账号体系 */
  account: 'zai' | 'bigmodel' | 'custom' | 'unknown';
  /** 给人看的官方叫法 */
  accountLabel: string;
  /** 上次用的模型 */
  model: string;
  /** 上次请求时间（ISO） */
  at: string;
  /** 数据来源（**必须**带上「这是使用记录不是当前设置」这层意思） */
  source: string;
}

/** 挂在单个 Agent 上的探测结果。两个字段都可空 —— 没有就不出现。 */
export interface AgentFamilyHints {
  localSiblings?: LocalSibling[];
  lastRequest?: LastRequestHint;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Qoder 国内版：`~/.qoder-cn`。
 *
 * ## A76 之后它不再挂在 `qoder` 的「未接入兄弟」里
 *
 * 以前这里返回的提示会挂到 `qoder` 条目上，说「检测到了国内版，但没接入」。
 * 现在 `qoder-cn` 已经是名册里**真实的一条**（definitions.ts），再说
 * 「没接入」就是假话 —— 所以 `probeFamilyHints` 不再 push 它。
 *
 * 这个函数保留下来是因为还有一处真用途：`qoder-cn` 的适配器在**找不到
 * `qoderclicn`** 时，用它把「到底检测到了什么」写进状态文案 ——
 * 「PATH 里没有这个命令」和「你装的是桌面端，bin 下只有 computer-use」
 * 对用户是两条完全不同的信息。
 *
 * ## 为什么先看 `bin/` 里有没有命令行
 *
 * 这是「能不能接」的唯一分界线。本机实测 `~/.qoder-cn/bin` 只有 `7zr.exe`
 * 与 `qoder-cn-computer-use`，而国际版 `~/.qoder/bin` 有 `qodercli`。
 * 没有 headless 入口的形态**一律不接**（PLAN §7：接进来是假能力）。
 */
export function probeQoderCn(home: string): LocalSibling | null {
  const root = join(home, '.qoder-cn');
  if (!isDir(root)) return null;

  // `qoderclicn` 是 CN 版真正的 CLI 名（@qodercn-ai/qoderclicn 的 bin 名，
  // 2026-10-22 查包元数据确认）；其余几个是历史/别名的兜底。
  const cliNames = ['qoderclicn', 'qodercli', 'qoder-cli', 'qoder'];
  const cliPath = cliNames.map(n => join(root, 'bin', n)).find(p => existsSync(p));

  return {
    id: 'qoder-cn',
    name: 'Qoder CN',
    regionName: '国内版',
    detectedPath: root,
    evidence: cliPath
      ? `检测到命令行入口 ${cliPath}`
      : '检测到桌面端；~/.qoder-cn/bin 下没有 qodercli（只有 qoder-cn-computer-use）',
    ...(cliPath
      ? {
          nextStep:
            '接入前先用 --help 核对参数是否与国际版一致，并给它独立的配置根；凭据不能与国际版共用',
        }
      : {
          blockedBy: '这个版本只提供桌面端，没有 headless 命令行入口',
        }),
  };
}

/**
 * WorkBuddy 国际版：`~/.workbuddy-ai`。
 *
 * 「存在这个目录」**不足以**判定是国际版 —— 必须读到产品配置里的
 * `networkEnvironment`。本机实测：国际版是 `external` + `productName=WorkBuddy AI`
 * + `endpoint=https://www.workbuddy.ai`；国内版是 `internal` + `www.workbuddy.cn`。
 *
 * 读不到产品配置时仍然提示「检测到配置根」，但**不下区域结论**（evidence 里写明
 * 「没读到产品配置」）—— 这比猜一个「应该是国际版」诚实。
 */
export function probeWorkbuddyIntl(home: string): LocalSibling | null {
  const root = join(home, '.workbuddy-ai');
  if (!isDir(root)) return null;

  const cfg = readJson(join(root, 'cache', 'acc-product-config-v3.json'));
  const env = typeof cfg?.networkEnvironment === 'string' ? cfg.networkEnvironment : null;
  const product = typeof cfg?.productName === 'string' ? cfg.productName : null;
  const endpoint = typeof cfg?.endpoint === 'string' ? cfg.endpoint : null;

  // 只认 external 这一种硬证据；其余（缺失 / internal / 其它值）都不说「国际版」
  const confirmedIntl = env === 'external';

  const detail = cfg
    ? [
        product ? `productName=${product}` : null,
        env ? `networkEnvironment=${env}` : null,
        endpoint ? `endpoint=${endpoint}` : null,
      ]
        .filter(Boolean)
        .join('，')
    : '没有读到产品配置（cache/acc-product-config-v3.json 不存在）';

  return {
    id: 'workbuddy-intl',
    name: confirmedIntl ? 'WorkBuddy AI' : 'WorkBuddy（另一个配置根）',
    regionName: confirmedIntl ? '国际版' : '区域未确认',
    detectedPath: root,
    evidence: detail,
    // 无论确认与否，接入的前提都是同一件事：另备一份凭据。
    // 注意这里 blockedBy 与 nextStep 会**同时**出现：前者说「缺什么」，
    // 后者说「有了之后怎么走」。这不是矛盾，见 LocalSibling 的字段说明。
    blockedBy: confirmedIntl
      ? '国际站是独立账号体系，需要另备一份凭据（一个子进程只能持一份）'
      : '还没读到能确认区域的配置，先不判断能不能接',
    ...(confirmedIntl
      ? {
          nextStep:
            '准备一份国际站凭据后，可用独立的 CODEBUDDY_CONFIG_DIR + CODEBUDDY_BASE_URL 起第二条目',
        }
      : {}),
  };
}

/**
 * Kimi Code 的区域：`~/.kimi-code/region`。
 *
 * 实测值是 `mainland-cn`。**当前就是中国站时不提示「国际站」** ——
 * 那会变成「检测到一个你并不缺的东西」。只有当用户可能想要国际站时
 * （即当前是中国站）才说明「接国际站要独立配置根并重新登录」。
 *
 * 反过来若 `region` 已是 `global`，说明用户本来就在国际站，也没有可提示的。
 */
export function probeKimiRegion(home: string): LocalSibling | null {
  const root = join(home, '.kimi-code');
  const regionFile = join(root, 'region');
  const region = readText(regionFile)?.trim();
  if (!region) return null;
  if (region !== 'mainland-cn') return null;

  return {
    id: 'kimi-intl',
    name: 'Kimi Code',
    regionName: '国际站',
    detectedPath: regionFile,
    evidence: `~/.kimi-code/region = ${region}（当前是中国站）`,
    blockedBy: '国际站要独立的配置根并重新登录；与现有中国站会话是两套（额度不互通）',
    nextStep: '用 KIMI_CODE_HOME 指向新的配置根，再 login --region global',
  };
}

/**
 * ZCode 上次实际请求走的账号体系。
 *
 * 数据来自 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表：每行都有
 * `provider_id` / `model_id` / `started_at`。本机实测 `provider_id` 的取值形态：
 *   - `account:zai-start-plan` / `builtin:zai-start-plan` → Z.ai 套餐
 *   - `builtin:bigmodel-start-plan`                       → BigModel 套餐
 *   - 一个 UUID                                           → 用户自己加的第三方 provider
 *
 * **为什么不读设置里的「当前 provider」**：`~/.zcode/v2/credentials.json` 里
 * `oauth:active_provider` 是 `enc:v1:` 加密的，解不开。硬猜一个就是假信息。
 * 而使用记录是**事实**：它记录的是「上一次请求真的打到了哪」，还能给出时间。
 * 所以 UI 上的措辞是「上次请求」而不是「当前连接」。
 *
 * 任何一步失败（文件不在 / 没有表 / sqlite 打不开）都返回 `null`，
 * 界面上不出现这一行 —— 不写「未知」占位。
 */
export function readZcodeLastRequest(home: string): LastRequestHint | null {
  const dbPath = join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  if (!existsSync(dbPath)) return null;

  let row: { provider_id?: unknown; model_id?: unknown; started_at?: unknown } | undefined;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      row = db
        .prepare('SELECT provider_id, model_id, started_at FROM model_usage ORDER BY started_at DESC LIMIT 1')
        .get() as typeof row;
    } finally {
      db.close();
    }
  } catch {
    // 表不存在 / 版本不认识 / 被独占 —— 都当作「读不到」
    return null;
  }
  if (!row) return null;

  const providerId = typeof row.provider_id === 'string' ? row.provider_id : '';
  const model = typeof row.model_id === 'string' ? row.model_id : '';
  const startedAt = typeof row.started_at === 'number' ? row.started_at : Number(row.started_at);
  if (!model || !Number.isFinite(startedAt)) return null;

  // 先判 bigmodel：`builtin:bigmodel-start-plan` 里不含 zai，但顺序写死更不容易出错
  const account: LastRequestHint['account'] = /bigmodel/i.test(providerId)
    ? 'bigmodel'
    : /zai/i.test(providerId)
      ? 'zai'
      : providerId
        ? 'custom'
        : 'unknown';

  const accountLabel =
    account === 'bigmodel'
      ? 'BigModel 套餐'
      : account === 'zai'
        ? 'Z.ai 套餐'
        : account === 'custom'
          ? '自定义 provider'
          : '未知';

  return {
    account,
    accountLabel,
    model,
    at: new Date(startedAt).toISOString(),
    source: '~/.zcode/cli/db 的使用记录（上次实际请求，不是当前设置）',
  };
}

/** 30 秒缓存：`/api/agents` 每次刷新都会调，别每次都开 sqlite */
const CACHE_TTL_MS = 30 * 1000;
let cache: { at: number; home: string; value: Map<string, AgentFamilyHints> } | null = null;

/**
 * 一次探测出全部提示，按 **agent id** 归档。
 *
 * 为什么按 agent id 而不是按 family：这些提示要说的是「你名册里**这一条**还有
 * 一个兄弟没接」，落点必须精确到条目。例如 `kimi-intl` 只该挂在 `kimicli` 上，
 * 挂到 `kimicode`（HTTP 开放平台）上就是错的 —— 那是另一套账号体系。
 */
export function probeFamilyHints(home: string = homedir()): Map<string, AgentFamilyHints> {
  const now = Date.now();
  if (cache && cache.home === home && now - cache.at < CACHE_TTL_MS) return cache.value;

  const out = new Map<string, AgentFamilyHints>();
  const push = (agentId: string, sibling: LocalSibling | null) => {
    if (!sibling) return;
    const prev = out.get(agentId) ?? {};
    out.set(agentId, { ...prev, localSiblings: [...(prev.localSiblings ?? []), sibling] });
  };

  // A76：`qoder-cn` 已经是名册里的真实条目，不再作为「未接入兄弟」挂在 qoder 上。
  // 它的本地痕迹由 `probeQoderCn()` 在 qoder-cn 自己的探测里使用。
  push('workbuddy', probeWorkbuddyIntl(home));
  push('kimicli', probeKimiRegion(home));

  const lastRequest = readZcodeLastRequest(home);
  if (lastRequest) out.set('zcode', { lastRequest });

  cache = { at: now, home, value: out };
  return out;
}

/** 单个 Agent 的提示（内部走同一个缓存，不会重复探测） */
export function familyHintsFor(agentId: string, home: string = homedir()): AgentFamilyHints | undefined {
  return probeFamilyHints(home).get(agentId);
}

/** 测试用：清掉缓存，避免 30 秒 TTL 把不同夹具串在一起 */
export function resetFamilyHintsCache(): void {
  cache = null;
}
