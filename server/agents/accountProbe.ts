/**
 * 账号与权益探测（只读）。
 *
 * ## 这个模块要回答的两个问题
 *
 * 用户的原话：「打开详情页不知道登录的是哪个账号」「ZCode 已经领了
 * Start Plan（ZCODE WEEKEND BUILD），但应用里看不到、也选不了」。
 *
 * 这两个问题不是同一层的东西：
 *   · 「登录的是哪个账号」是**身份**（邮箱 / 昵称 / 组织）；
 *   · 「领了哪个套餐、为什么用不了」是**权益**（订阅状态 + 是否生效）。
 *
 * 而它们能不能回答，取决于每个 Agent 把信息存在哪里 —— 所以**每个 Agent
 * 一个 adapter**，读得到就读，读不到就明说读不到，绝不拿过期缓存冒充事实。
 *
 * ## 安全边界（这是本模块的红线）
 *
 * 只取**给人看的那几个字段**：邮箱、昵称、套餐名、订阅状态、套餐内的模型名。
 * `access_token` / `refresh_token` / `apiKey` / `pass_hash` / 加密信封
 * （`enc:v1:…`）**一律不读、不落内存、不下发**。前端拿到邮箱后还要再掩码。
 *
 * ## 诚实边界（比上面更要紧的一条）
 *
 * 本应用**改不了**任何 Agent 的账号与套餐：ZCode 只认它自己设置里的选择，
 * zcode 的 CLI 连 `--model` 都没有（实测 `--model` 会让它打印帮助后退出）。
 * 所以返回值里带 `modelSelectable` 与 `switchHint`：能在这里切的才说能切，
 * 不能的给出「去哪儿切」的原话，而不是画一个点了不生效的假控件。
 */
import fs from 'fs';
import path from 'path';
import { agentAcceptsModel } from './definitions.js';
import { PLAN_REASON_LABEL, PLAN_STATUS_LABEL } from './agentConfigModels.js';

/** 身份：能读到的账号信息。读不到的字段一律不填 */
export interface AccountIdentity {
  /** 昵称 / 显示名 */
  name?: string;
  /** 邮箱。**界面必须掩码**，这里给原文是因为掩码要按展示宽度做 */
  email?: string;
  /** 组织 / 账号体系的可读文本（不填原始 id） */
  org?: string;
  /** 当前套餐的展示名（codex 的 `ChatGPT Free` 这类） */
  planLabel?: string;
  /** 身份是从哪个文件读出来的（写在界面上，便于核对） */
  source: string;
  /** 读不到身份时给用户看的原因原话。**不写「未知」** */
  unavailableReason?: string;
}

/** 一个权益套餐（订阅） */
export interface AccountPlan {
  id: string;
  name: string;
  /** active = 可用；inactive = 不可用；unknown = 状态认不出 */
  status: 'active' | 'inactive' | 'unknown';
  /** 状态原话（未订阅该套餐 / 未登录 / OAuth 登录已失效 …） */
  detail?: string;
  /** 这个套餐包含的模型名（套餐内真实模型，不是套餐名） */
  models: string[];
  /** 是否是当前选中的那一个 */
  selected: boolean;
  /** 选中了但没生效 —— 用户报的问题就长这样 */
  effective: boolean;
}

/** 一段「当前选择」（按 provider family 分开：zai / bigmodel） */
export interface AccountSelection {
  family: string;
  familyLabel: string;
  /** 连接方式的展示名（Individual Coding Plan / Start Plan …） */
  kindLabel: string;
  /** 选中的 provider 的展示名 */
  providerName: string;
  /** 选中的 provider 原始键（`builtin:zai-coding-plan`） */
  providerKey: string;
  /** 这个选择现在真的能用吗 */
  effective: boolean;
  /** 不能用的原因 */
  detail?: string;
}

export interface AgentAccountProbe {
  identity?: AccountIdentity;
  currentSelection?: AccountSelection[];
  plans: AccountPlan[];
  /** 整块数据的来源说明（文件路径 + 用途），界面上写一行 */
  source: string;
  /** 数据快照时间（ISO）。本地缓存类数据必须带，否则分不清「没有」与「过期」 */
  checkedAt?: string;
  /** 快照是否已经旧到不能当事实用（> 24h） */
  stale?: boolean;
  /** 这块数据的边界说明（为什么这里改不了 / 为什么看不到） */
  note?: string;
  /** 本应用能不能把这个 Agent 的模型传给 CLI（决定界面能不能出现「选择」） */
  modelSelectable: boolean;
  /** 与 `modelSelectable` 配套的一句话 */
  modelNote: string;
  /** 不能在这里切时，「去哪儿切」的原话 */
  switchHint?: string;
}

const STALE_MS = 24 * 60 * 60 * 1000;

/** config.json 里的 `systemDisabledReason` —— 与 coding-plan-cache 的 reason 不是同一套 */
const SYSTEM_DISABLED_LABEL: Record<string, string> = {
  oauth_provider_inactive: 'OAuth 登录已失效',
  coding_plan_not_entitled: '未订阅该套餐',
};

const FAMILY_LABEL: Record<string, string> = {
  zai: 'Z.ai',
  bigmodel: 'BigModel',
  chatgpt: 'ChatGPT',
};

const CONNECTION_KIND_LABEL: Record<string, string> = {
  'individual-coding-plan': '个人 Coding Plan',
  'start-plan': 'Start Plan',
  'coding-plan': 'Coding Plan',
};

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function homeDir(): string | undefined {
  return process.env.USERPROFILE || process.env.HOME || undefined;
}

/** 只认「订阅套餐」的 provider 键；`builtin:zai` 这种 API Key 入口不算权益 */
function isPlanKey(id: string): boolean {
  return /^builtin:.+-(coding|start)-plan$/.test(id);
}

/**
 * 把 `setting.json` 里的选择键还原成 `config.json` 的 provider 键。
 *
 * 两边格式不一样：setting 里带连接方式前缀（`coding-plan:builtin:zai-coding-plan`），
 * config / coding-plan-cache 里只有 `builtin:zai-coding-plan`。
 * 不做这一步的话，按选择键查 provider 永远查不到 —— 界面上就会出现
 * 「当前套餐」写着 provider 的原始键、「已领取权益」却说没选中。
 */
function providerIdOf(key: string): string {
  const i = key.indexOf('builtin:');
  return i >= 0 ? key.slice(i) : key;
}

/** 名字的「看起来一样」判定：去掉空格与各种连字符后比较 */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-_.·—–]/g, '');
}

/**
 * ZCode：账号身份**读不到**，套餐状态读得到但可能过期。
 *
 * 三份文件分工（都是它自己的本地配置）：
 *   · `setting.json`                 —— 用户当前选的 provider（`modelProviderFamilySelectedKeys`）
 *   · `config.json`                  —— 每个 provider 的启用状态与**套餐内模型名**
 *   · `coding-plan-cache.json`       —— 套餐授权状态 + **快照时间**（`entryStatus.updatedAt`）
 *
 * 为什么必须带快照时间：本机这份缓存的 `updatedAt` 是 2026-09-18，而用户
 * 2026-10 才领的 Weekend Build —— 缓存里当然没有。如果不写时间，
 * 「未订阅该套餐」就会被读成事实，而它只是**42 天前的一张旧照片**。
 */
function probeZcode(home: string): AgentAccountProbe | null {
  const v2Dir = path.join(home, '.zcode', 'v2');
  const config = readJson(path.join(v2Dir, 'config.json'));
  const setting = readJson(path.join(v2Dir, 'setting.json'));
  const planCache = readJson(path.join(v2Dir, 'coding-plan-cache.json'));
  if (!config && !setting && !planCache) return null;

  const providers = (config?.provider ?? {}) as Record<
    string,
    { name?: string; enabled?: boolean; systemDisabledReason?: string; models?: Record<string, unknown> }
  >;
  const cacheItems = (planCache?.entryStatus?.items ?? {}) as Record<
    string,
    { status?: string; reason?: string }
  >;
  const selectedKeys = (setting?.modelProviderFamilySelectedKeys ?? {}) as Record<string, string>;
  const connections = (setting?.providerFamilyConnectionSelections ?? {}) as Record<
    string,
    { kind?: string }
  >;

  const selectedSet = new Set(Object.values(selectedKeys).filter(v => typeof v === 'string').map(providerIdOf));

  const plans: AccountPlan[] = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!isPlanKey(id)) continue;
    const cache = cacheItems[id];
    const cacheStatus = cache?.status;
    const reason = cache?.reason ? PLAN_REASON_LABEL[cache.reason] ?? cache.reason : undefined;
    const sysReason = value.systemDisabledReason
      ? SYSTEM_DISABLED_LABEL[value.systemDisabledReason] ?? value.systemDisabledReason
      : undefined;
    const status: AccountPlan['status'] =
      cacheStatus === 'available' ? 'active' : cacheStatus === 'unavailable' ? 'inactive' : 'unknown';
    const selected = selectedSet.has(id);
    plans.push({
      id,
      name: value.name || id.replace('builtin:', ''),
      status,
      detail: [cacheStatus ? PLAN_STATUS_LABEL[cacheStatus] ?? cacheStatus : undefined, reason || sysReason]
        .filter(Boolean)
        .join(' · ') || undefined,
      models: Object.keys(value.models ?? {}),
      selected,
      // 「选中」与「生效」必须分开：本机就是 selected=true、enabled=false 的状态。
      // 合成一个字段的话，界面只能二选一地说谎（要么说选中（其实不能用），
      // 要么说未选中（其实用户明明选了））。
      effective: selected && value.enabled === true,
    });
  }
  /* 同名消歧：ZCode 里 `zai-coding-plan` 与 `zai-start-plan` 都叫
     「Z.ai - Coding Plan」。不消歧的话，权益列表就是两行一模一样的字，
     用户分不清哪行才是自己领的那一个。 */
  const nameCount = new Map<string, number>();
  for (const plan of plans) nameCount.set(nameKey(plan.name), (nameCount.get(nameKey(plan.name)) ?? 0) + 1);
  for (const plan of plans) {
    if ((nameCount.get(nameKey(plan.name)) ?? 0) > 1) {
      plan.name = `${plan.name}（${plan.id.replace('builtin:', '')}）`;
    }
  }
  /* 排序：生效的 > 选中的 > 可用的 > 其余。
     用户打开这一块是来找「我领的那个到底能不能用」，把当前选择顶到最上面，
     比按 config.json 的书写顺序（先 bigmodel 再 zai）更省一次扫读。 */
  const rank = (p: AccountPlan) => (p.effective ? 0 : p.selected ? 1 : p.status === 'active' ? 2 : 3);
  plans.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (plans.length === 0) return null;

  const currentSelection: AccountSelection[] = Object.entries(selectedKeys).map(([family, key]) => {
    const providerId = providerIdOf(key);
    const provider = providers[providerId];
    const connection = connections[family];
    const cache = cacheItems[providerId];
    const enabled = provider?.enabled === true;
    /* 原因优先用缓存里的那一条：权益列表写的是缓存原因（「未登录」），
       这里若改用 config 的 `systemDisabledReason`（「OAuth 登录已失效」），
       同一件事就会在同一块里出现两种说法。 */
    const reason = cache?.reason
      ? PLAN_REASON_LABEL[cache.reason] ?? cache.reason
      : provider?.systemDisabledReason
        ? SYSTEM_DISABLED_LABEL[provider.systemDisabledReason] ?? provider.systemDisabledReason
        : undefined;
    return {
      family,
      familyLabel: FAMILY_LABEL[family] ?? family,
      kindLabel: connection?.kind ? CONNECTION_KIND_LABEL[connection.kind] ?? connection.kind : '未声明',
      providerName: provider?.name || providerId,
      providerKey: providerId,
      effective: enabled,
      detail: enabled ? undefined : reason || '未启用',
    };
  });

  const updatedAt = planCache?.entryStatus?.updatedAt;
  const checkedAt = typeof updatedAt === 'number' ? new Date(updatedAt).toISOString() : undefined;
  const stale = checkedAt ? Date.now() - Date.parse(checkedAt) > STALE_MS : undefined;

  return {
    identity: {
      source: '~/.zcode/v2/credentials.json',
      unavailableReason:
        'ZCode 把账号信息加密存在 credentials.json（enc:v1 信封），本应用读不到邮箱 / 昵称；只能在 ZCode 里查看当前登录的账号。',
    },
    currentSelection,
    plans,
    source: '~/.zcode/v2/{setting,config,coding-plan-cache}.json（ZCode 自己的本地配置）',
    checkedAt,
    stale,
    note: stale
      ? '套餐状态来自 ZCode 的本地缓存，已经很久没刷新 —— 缓存里没有的权益（例如刚领的 Weekend Build）不代表没领到。'
      : '套餐状态来自 ZCode 的本地缓存；本应用只读，不改它的任何配置。',
    modelSelectable: agentAcceptsModel('zcode'),
    modelNote: agentAcceptsModel('zcode')
      ? '本应用可以把选中的模型传给 zcode。'
      : 'zcode 的 CLI 没有 --model：套餐与模型只能在 ZCode 设置里切换，本应用只读取展示。',
    switchHint:
      '在 ZCode 里打开「设置 → 模型 / 套餐」刷新或切换；选好后从这里发起对话就会用它。若刷新后仍显示未订阅，请核对领取权益时用的是哪个账号。',
  };
}

/**
 * Codex：身份**读得到**（auth.json 的 id_token 是 JWT），套餐也读得到。
 *
 * 只解 `id_token` 的 payload（base64url），**不解 access_token、不读 Key**。
 * 需要的字段：`email` / `name` / `https://api.openai.com/auth.chatgpt_plan_type`。
 */
function probeCodex(home: string): AgentAccountProbe | null {
  const authFile = path.join(home, '.codex', 'auth.json');
  const auth = readJson(authFile);
  if (!auth) return null;

  const idToken = auth?.tokens?.id_token;
  let claims: Record<string, any> | null = null;
  if (typeof idToken === 'string' && idToken.includes('.')) {
    try {
      const payload = idToken.split('.')[1];
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      claims = null;
    }
  }

  if (!claims) {
    return {
      plans: [],
      source: '~/.codex/auth.json',
      note: '~/.codex/auth.json 里的 id_token 解不开（可能已过期或用了 API Key 模式），读不到账号信息。',
      modelSelectable: agentAcceptsModel('codex'),
      modelNote: '本应用可以把选中的模型传给 codex（--model）。',
    };
  }

  const oauth = claims['https://api.openai.com/auth'] as Record<string, any> | undefined;
  const rawPlan = typeof oauth?.chatgpt_plan_type === 'string' ? oauth.chatgpt_plan_type : '';
  const planLabel = rawPlan ? `ChatGPT ${rawPlan.charAt(0).toUpperCase()}${rawPlan.slice(1)}` : undefined;
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const name = typeof claims.name === 'string' ? claims.name : undefined;
  const until = typeof oauth?.chatgpt_subscription_active_until === 'string'
    ? oauth.chatgpt_subscription_active_until
    : undefined;
  const untilMs = until ? Date.parse(until) : NaN;
  /* `last_refresh` 带纳秒（`…15.039310200Z`），Date.parse 在部分引擎上直接 NaN。
     先归一化成毫秒精度的 ISO，再拿去算「多久以前」—— 否则界面上会原样
     吐一个 9 位小数的字符串。 */
  const lastRefreshRaw = typeof auth.last_refresh === 'string' ? auth.last_refresh : undefined;
  const lastRefreshMs = lastRefreshRaw ? Date.parse(lastRefreshRaw) : NaN;
  const checkedAt = Number.isFinite(lastRefreshMs) ? new Date(lastRefreshMs).toISOString() : undefined;

  const plans: AccountPlan[] = rawPlan
    ? [
        {
          id: `chatgpt:${rawPlan}`,
          name: planLabel!,
          status: 'active',
          detail: untilMs
            ? `订阅有效期至 ${new Date(untilMs).toLocaleDateString('zh-CN')}`
            : '当前登录套餐',
          models: [],
          selected: true,
          effective: true,
        },
      ]
    : [];

  return {
    identity: {
      name,
      email,
      planLabel,
      source: '~/.codex/auth.json 的 id_token（只解邮箱 / 昵称 / 套餐，不读 token）',
    },
    currentSelection: rawPlan
      ? [
          {
            family: 'chatgpt',
            // 不写成「ChatGPT：ChatGPT Free → OpenAI」——同一行里三个
            // ChatGPT 谁也记不住。这里说清「账号 → 登录套餐 → 套餐名」。
            familyLabel: 'ChatGPT 账号',
            kindLabel: '登录套餐',
            providerName: planLabel!,
            providerKey: `chatgpt:${rawPlan}`,
            effective: true,
          },
        ]
      : undefined,
    plans,
    source: '~/.codex/auth.json',
    checkedAt,
    stale: checkedAt ? Date.now() - (lastRefreshMs as number) > 30 * STALE_MS : undefined,
    note: '账号信息读自 codex 自己的登录凭据；套餐额度以 OpenAI 后台为准，本应用只展示。',
    modelSelectable: agentAcceptsModel('codex'),
    modelNote: '本应用可以把选中的模型传给 codex（--model），模型在输入框的模型菜单里选。',
  };
}

/**
 * 按 agentId 分派。
 *
 * 返回 null = 这个 Agent 没有可读的账号/权益数据，详情页**整块不出现** ——
 * 不摆一行「未知」占位，那只会让用户以为「查了没查到」。
 */
export function probeAccount(agentId: string, home: string = homeDir() ?? ''): AgentAccountProbe | null {
  if (!home) return null;
  if (agentId === 'zcode') return probeZcode(home);
  if (agentId === 'codex') return probeCodex(home);
  return null;
}
