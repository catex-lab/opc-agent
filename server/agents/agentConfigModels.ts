/**
 * 从 Agent **自己的配置文件**里读模型清单（只读）。
 *
 * ## 为什么需要这一层
 *
 * `modelCatalog.ts` 只能接「CLI 有枚举命令」的 Agent。ZCode 属于另一种：
 * 它 0.17.0 既没有 `--model`（实测 `--help` 只有 `/model` 斜杠命令，
 * 而 `-p "/model"` 会被当成普通提问发出去），也没有任何枚举子命令。
 * 于是它的模型下拉是空的，界面显示「模型由 Agent 决定」——
 * 用户看到的是「连 z.ai / Start Plan 这些套餐都不显示」，而实际上
 * 这些信息**就摆在它的配置目录里**，只是没人读。
 *
 * ## 读什么、不读什么
 *
 * | 文件 | 读它做什么 |
 * |---|---|
 * | `~/.zcode/v2/config.json` | `provider` 的键 = 它内置的 6 个 provider（含 4 个套餐） |
 * | `~/.zcode/v2/provider_config.json` | 自定义 provider 的 `personalModelIds`（真正的模型名） |
 * | `~/.zcode/v2/coding-plan-cache.json` | 4 个套餐的授权状态（未订阅 / 未认证 / 可用） |
 * | `~/.zcode/cli/rollout/model-io-*.jsonl` | 最近一次真正跑过的模型（`model.modelId`） |
 *
 * **不读 `db.sqlite`**（329MB，且是它的内部会话库），也不碰任何带凭据的字段：
 * `provider_config.json` 里有 `apiKey`，本模块只取 `providerName` 与
 * `personalModelIds` 两个字段，其余一律不落内存。
 *
 * ## 诚实边界（这是本模块存在的全部意义）
 *
 * 读出来的清单**不可选**。我们改不了 ZCode 的模型 —— 它只认自己设置里的选择。
 * 所以上层必须把 `selectable: false` 透到界面：能看、能知道现在用的是哪个，
 * 但点了不会生效的事一律不做。
 */
import fs from 'fs';
import path from 'path';
import type { ModelOption } from './modelCatalog.js';

export interface AgentConfigModels {
  models: ModelOption[];
  /** 该 Agent 自己配置里「最近一次真正用过的模型」。读不到就不填，不猜 */
  currentModel?: string;
  /** 界面上要显示的一句解释（为什么不能在这里切） */
  note?: string;
}

/**
 * 套餐状态的中文说明。认不出的状态直接显示原文，不翻译成猜的意思。
 *
 * 导出是因为 `accountProbe.ts` 读同一份 `coding-plan-cache.json` —— 两处
 * 各抄一份标签，迟早会出现「模型菜单说未订阅、账号区块说未认证」的分叉。
 */
export const PLAN_STATUS_LABEL: Record<string, string> = {
  available: '可用',
  unavailable: '不可用',
};

export const PLAN_REASON_LABEL: Record<string, string> = {
  coding_plan_not_entitled: '未订阅该套餐',
  coding_plan_not_connected: '未连接',
  coding_plan_not_authenticated: '未登录',
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

/**
 * 最近一次真正跑过的模型。
 *
 * 为什么从 rollout 读而不是从 config 读：`config.json` / `setting.json` 里
 * 只有「账号套餐选择」（`providerFamilyConnectionSelections`），**没有模型名**；
 * 模型是每次请求带着走的，只有 rollout 的 `model-io-*.jsonl` 留下了证据。
 *
 * 只读文件开头一小段：这些 jsonl 是逐行 JSON，第一条就带 `model` 字段，
 * 整个文件可能有几十 MB，全读进来纯属浪费。
 */
function readZcodeLastModel(v2Dir: string): string | undefined {
  const rolloutDir = path.join(path.dirname(v2Dir), 'cli', 'rollout');
  let newest: { file: string; mtime: number } | undefined;
  try {
    for (const name of fs.readdirSync(rolloutDir)) {
      if (!name.startsWith('model-io-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(rolloutDir, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;

  try {
    const fd = fs.openSync(newest.file, 'r');
    const buf = Buffer.alloc(262144);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.subarray(0, n).toString('utf8');
    const firstLine = text.split('\n')[0] ?? '';
    try {
      const obj = JSON.parse(firstLine) as { model?: { modelId?: unknown } };
      const id = obj?.model?.modelId;
      if (typeof id === 'string' && id) return id;
    } catch {
      // 第一条被窗口截断（这些行里有整段错误堆栈，动辄几十 KB）——
      // 退化成正则找 `"model":{"modelId":"…"`，仍然只认这一个字段。
    }
    const m = text.match(/"model"\s*:\s*\{\s*"modelId"\s*:\s*"([^"]+)"/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * ZCode 的模型清单（只读）。
 *
 * 返回 null 表示「这台机器上没有可读的 ZCode 配置」—— 上层据此维持
 * 「模型由 Agent 决定」的原有文案，而不是显示一个空面板。
 */
export function readZcodeModels(): AgentConfigModels | null {
  const home = homeDir();
  if (!home) return null;
  const v2Dir = path.join(home, '.zcode', 'v2');
  const config = readJson(path.join(v2Dir, 'config.json'));
  const providerConfig = readJson(path.join(v2Dir, 'provider_config.json'));
  const planCache = readJson(path.join(v2Dir, 'coding-plan-cache.json'));
  if (!config && !providerConfig) return null;

  const models: ModelOption[] = [];
  const seen = new Set<string>();

  // ① 内置 provider（6 个：4 个套餐 + 2 个 API Key 入口）。
  //    套餐名与状态都来自它自己的配置，我们不判断「你应该订哪个」。
  const builtin = (config?.provider ?? {}) as Record<string, { name?: string }>;
  const planItems = (planCache?.entryStatus?.items ?? {}) as Record<
    string,
    { status?: string; reason?: string }
  >;
  const builtinRows: ModelOption[] = [];
  for (const [id, value] of Object.entries(builtin)) {
    if (!id.startsWith('builtin:')) continue;
    const st = planItems[id];
    const key = id.replace('builtin:', '');
    /* 两类内置项要分开说：`*-coding-plan` / `*-start-plan` 是**订阅套餐**，
       而 `builtin:zai` / `builtin:bigmodel` 只是「填 API Key」的入口。
       一律写成「套餐」会让用户以为 Key 入口也要订阅。 */
    const isPlan = /-(coding|start)-plan$/.test(key);
    const status = st?.status ? PLAN_STATUS_LABEL[st.status] ?? st.status : '';
    const reason = st?.reason ? PLAN_REASON_LABEL[st.reason] ?? st.reason : '';
    const detail = isPlan
      ? ['套餐', status || '状态未知', reason].filter(Boolean).join(' · ')
      : 'API Key 入口';
    builtinRows.push({
      modelId: id,
      name: value?.name || key,
      description: detail,
      provider: 'builtin',
      providerName: 'ZCode 内置',
    });
    seen.add(id);
  }

  /* 同名消歧：它的配置里 `zai-coding-plan` 与 `zai-start-plan` 的 name
     都是「Z.ai - Coding Plan」，直接铺出来就是两行一模一样的字。
     只在**真的重名**时补上配置键，别给每一行都挂一串 id。 */
  const nameCount = new Map<string, number>();
  for (const row of builtinRows) nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);
  for (const row of builtinRows) {
    if ((nameCount.get(row.name) ?? 0) > 1) {
      row.name = `${row.name}（${row.modelId.replace('builtin:', '')}）`;
    }
    models.push(row);
  }

  // ② 自定义 provider 的模型名（`personalModelIds`）。
  //    这是**唯一**能拿到真实模型名的地方 —— 上面的套餐条目只有套餐名。
  const rules = providerConfig?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const providerName = typeof rule?.providerName === 'string' ? rule.providerName : '';
      const ids = rule?.config?.personalModelIds;
      if (!Array.isArray(ids)) continue;
      for (const raw of ids) {
        const id = typeof raw === 'string' ? raw : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          modelId: id,
          name: id,
          description: providerName ? `自定义 provider · ${providerName}` : '自定义 provider',
          provider: rule?.providerId,
          providerName: providerName || '自定义',
        });
      }
    }
  }

  if (models.length === 0) return null;

  return {
    models,
    currentModel: readZcodeLastModel(v2Dir),
    note: 'ZCode 不支持命令行切换模型：模型在它自己的设置里选，这里只读取展示。',
  };
}

/** 按 agentId 分派。目前只有 zcode 有可读的配置文件 */
export function readAgentConfigModels(agentId: string): AgentConfigModels | null {
  if (agentId === 'zcode') return readZcodeModels();
  return null;
}
