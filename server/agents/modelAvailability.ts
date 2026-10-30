/**
 * 模型「能不能真的路由」的标定（A151 / P2）。
 *
 * ## 为什么「CLI 列出来的」与「官方清单里的」都不够
 *
 * 2026-10-30 在 qodercli 1.1.78 上实测三份数据互不相等：
 *
 * | 来源 | 条数 | 说明 |
 * |---|---|---|
 * | `qodercli --list-models` | 3 | 只列账号自己的 Default + Custom |
 * | 官方 IDE 文案表 `~/.qoder/.auth/dynamic-texts.json` | 18 个真模型 | 含套餐里所有可选模型 |
 * | 真正 `-m` 能路由的 | ? | 需要逐个打 |
 *
 * 而且「官方有」既不等于「CLI 认」，也不等于「不能用」：
 *   - `-m GLM-5.3-Flash` → `You've reached your credit usage limit` =
 *     **名字有效、路由通过**，只是账号没额度 → 该显示，但 `--list-models` 不列它；
 *   - `-m Qwen3.7-Plus` → `Model "…" is not available right now; using "qfmodel"
 *     instead.` = **名字无效、被静默替换** → 显示它就是假控件。
 *
 * 所以「把官方 18 条铺上去」和「只信 CLI 那 3 条」都是错的，
 * 中间缺的正是这一层：**逐个打一枪，按 CLI 的反应分类**。
 *
 * ## 三档判定（判据全部来自 CLI 的真实输出，不是猜的）
 *
 * - `invalid`：出现 `is not available right now` —— 名字无效，被换成别的模型；
 * - `routed`：出现 `credit usage limit` —— 名字有效、路由已通过，只是没额度；
 * - `ok`：退出码 0 且有非空回复 —— 真跑通了；
 * - `unknown`：超时 / 挂起 / 认不出的输出。**不猜**，界面上标「未验证」。
 *
 * ## 边界
 *
 * 标定是**显式动作**（`POST /api/agents/:id/models/probe`），不会挂在
 * 打开菜单、启动应用这类自动路径上：每一条都要真起一次 CLI、真花 token。
 * 结果落 `data/model-availability.json`，TTL 7 天 —— 账号套餐会变，
 * 结论不能永久有效。
 */
import fs from 'fs';
import path from 'path';
import { dataDirPath } from '../paths.js';
import { findDef } from './definitions.js';
import { expandPath, findExecutable, resolveAnyLaunchTarget, runCapture } from './probe.js';
import type { ModelOption } from './modelCatalog.js';

export type ModelVerdict = 'ok' | 'routed' | 'invalid' | 'unknown';

export interface AvailabilityRecord {
  verdict: ModelVerdict;
  /** 判定时间（ms）。超过 TTL 就当没有，重新标 */
  at: number;
  /** 判定依据：CLI 原文里那一行，截断到 200 字符 */
  evidence?: string;
}

interface AvailabilityFile {
  version: number;
  agents: Record<string, Record<string, AvailabilityRecord>>;
}

const FILE = path.join(dataDirPath, 'model-availability.json');
const VERSION = 1;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单条标定的超时。实测 qoder 冷态一次要 8-20s（含 218MB CLI 启动） */
const PROBE_TIMEOUT_MS = 60_000;

/** 标定用的最小提示词：只要它回一句话就说明路由通了 */
const PROBE_PROMPT = '回复OK';

// ============= 纯函数（可离线验证） =============

/**
 * 按 CLI 的反应分类。**判据只认官方原文**，不做语义猜测。
 *
 * 顺序不能反：`invalid` 必须先判 —— 被静默替换的那次调用退出码也是 0、
 * 也可能有回复（回复来自被替换后的模型），先判 `ok` 会把它当成成功。
 */
export function classifyProbe(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean
): { verdict: ModelVerdict; evidence?: string } {
  const all = `${stdout}\n${stderr}`;
  const pick = (re: RegExp): string | undefined => {
    const line = all.split(/\r?\n/).find(l => re.test(l));
    return line ? line.trim().slice(0, 200) : undefined;
  };

  if (timedOut) return { verdict: 'unknown', evidence: '超时（CLI 无响应）' };

  const invalid = pick(/is not available right now/i);
  if (invalid) return { verdict: 'invalid', evidence: invalid };

  const routed = pick(/credit usage limit|reached your credit/i);
  if (routed) return { verdict: 'routed', evidence: routed };

  if (code === 0 && stdout.trim().length > 0) {
    return { verdict: 'ok', evidence: stdout.trim().slice(0, 200) };
  }
  return { verdict: 'unknown', evidence: pick(/./) ?? '无输出' };
}

/**
 * 把「官方清单里、CLI 没列」的模型并进列表。
 *
 * 三档处置（与标定结果一一对应）：
 *   - `invalid`  → **丢掉**。放上去就是「点了被静默替换」的假控件；
 *   - `ok`/`routed` → 并进去，`verified: true`；
 *   - 没有记录   → 并进去，`verified: false`（界面标「未验证」，选之前要标定）。
 *
 * 保持 CLI 自己给的顺序在前 —— 那几条是账号的 Default/Custom，
 * 理应排在最上面（与官方菜单一致）。
 */
export function mergeOfficialExtras(
  base: ModelOption[],
  extras: ModelOption[],
  verdicts: Record<string, AvailabilityRecord>,
  now = Date.now()
): { models: ModelOption[]; dropped: string[]; unverified: string[] } {
  const models = [...base.map(m => ({ ...m, verified: true }))];
  const dropped: string[] = [];
  const unverified: string[] = [];
  const seen = new Set(models.map(m => m.modelId));

  for (const extra of extras) {
    if (seen.has(extra.modelId)) continue;
    seen.add(extra.modelId);
    const rec = verdicts[extra.modelId];
    const fresh = rec && now - rec.at < TTL_MS ? rec : undefined;
    if (fresh?.verdict === 'invalid') {
      dropped.push(extra.modelId);
      continue;
    }
    if (!fresh || fresh.verdict === 'unknown') {
      unverified.push(extra.modelId);
      models.push({ ...extra, verified: false });
      continue;
    }
    models.push({ ...extra, verified: true });
  }
  return { models, dropped, unverified };
}

// ============= 官方清单（公开 UI 文案表） =============

/**
 * 官方 IDE 的「模型选择器」文案表里的条目。
 *
 * 为什么读它：`qodercli --list-models` 只吐 3 条，而官方面板上的模型
 * 一个不少地写在 `~/.qoder/.auth/dynamic-texts.json` 里（namespace 文案表）。
 * 这份文件是**明文、公开的前端文案**（本项目早就用它取模型描述了），
 * 不是 `~/.qoder/.models/<uid>/catalog-v7` 那种私有二进制格式 —— 那个不碰。
 *
 * 过滤掉「思考档位」那一批：`Auto / 经济 / 快速 / 性能 / 轻量 / 极致`
 * 是档位不是模型，它们也在这张表里（`efficient` / `fast` / `performance` …），
 * 混进模型菜单会变成四个点不出效果的选项。
 */
const EFFORT_LABELS = new Set(['Auto', '自动', '经济', '快速', '性能', '轻量', '极致']);

export function parseOfficialModelTexts(
  texts: Record<string, unknown> | null | undefined
): ModelOption[] {
  if (!texts) return [];
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(texts)) {
    const m = key.match(/^modelSelector\.item\.([^.]+)$/);
    if (!m) continue;
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || EFFORT_LABELS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const desc = texts[`modelSelector.item.${m[1]}.description`];
    out.push({
      modelId: name,
      name,
      description: typeof desc === 'string' ? desc : undefined,
    });
  }
  return out;
}

function readOfficialTexts(home: string, dir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(home, dir, '.auth', 'dynamic-texts.json'), 'utf8');
    const j = JSON.parse(raw) as { locales?: Record<string, Record<string, unknown>> };
    const locales = j?.locales ?? {};
    return locales['zh-CN'] ?? locales.zh ?? locales['en-US'] ?? locales.en ?? null;
  } catch {
    return null;
  }
}

/** 按 agentId 取官方清单。目前只有 qoder 家族有这张表 */
export function readOfficialModels(agentId: string): ModelOption[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  if (agentId === 'qoder') return parseOfficialModelTexts(readOfficialTexts(home, '.qoder'));
  if (agentId === 'qoder-cn') return parseOfficialModelTexts(readOfficialTexts(home, '.qoder-cn'));
  return [];
}

// ============= 存储 =============

function loadFile(): AvailabilityFile {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) as AvailabilityFile;
    if (j?.version !== VERSION || !j.agents) return { version: VERSION, agents: {} };
    return j;
  } catch {
    return { version: VERSION, agents: {} };
  }
}

function saveFile(next: AvailabilityFile): void {
  try {
    fs.mkdirSync(dataDirPath, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[ModelAvailability] 写标定结果失败（非致命）：', String(e));
  }
}

export function getVerdicts(agentId: string): Record<string, AvailabilityRecord> {
  return loadFile().agents[agentId] ?? {};
}

export function recordVerdicts(
  agentId: string,
  results: Record<string, AvailabilityRecord>
): void {
  const file = loadFile();
  file.agents[agentId] = { ...(file.agents[agentId] ?? {}), ...results };
  saveFile(file);
}

// ============= 真打一枪 =============

/**
 * 对单个模型真跑一次「回复OK」，按 CLI 的反应判定。
 *
 * 走的是 `definitions.ts` 里**同一份 `buildArgs`** —— 这样标定验的
 * 就是用户真发消息时那条路径，而不是另写一套近似参数。
 */
export async function probeOneModel(
  agentId: string,
  modelId: string
): Promise<AvailabilityRecord> {
  const def = findDef(agentId);
  const cli = def?.cli;
  if (!cli) {
    return { verdict: 'unknown', at: Date.now(), evidence: '该 Agent 没有 CLI 通道' };
  }
  const binPath = findExecutable(cli.bin, (def.extraPaths ?? []).map(expandPath));
  if (!binPath) {
    return { verdict: 'unknown', at: Date.now(), evidence: `PATH 中未找到 ${cli.bin}` };
  }
  const target = resolveAnyLaunchTarget(binPath);
  if (target.problem) {
    return { verdict: 'unknown', at: Date.now(), evidence: target.problem };
  }

  const args = cli.buildArgs(PROBE_PROMPT, {
    // 标定是一次性的最小调用：sessionId / prompt 只是 SendContext 的必填位，
    // 不落库、不进会话，所以给一个明显是标定用的占位值。
    sessionId: `probe-${agentId}-${modelId}`,
    prompt: PROBE_PROMPT,
    cwd: process.cwd(),
    model: modelId,
    // 标定不该弹权限：一律用不问就走的模式。这一步只为了拿 CLI 的一句回复。
    permissionMode: 'bypassPermissions',
  });

  const res = await runCapture(target, args, {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', TERM: 'dumb' },
  });

  const { verdict, evidence } = classifyProbe(res.stdout, res.stderr, res.code, res.timedOut);
  return { verdict, at: Date.now(), evidence };
}

/** 批量标定（串行：并行会把 CLI 的凭据/锁打出问题） */
export async function probeModels(
  agentId: string,
  modelIds: string[]
): Promise<Record<string, AvailabilityRecord>> {
  const out: Record<string, AvailabilityRecord> = {};
  for (const id of modelIds) {
    out[id] = await probeOneModel(agentId, id);
  }
  recordVerdicts(agentId, out);
  return out;
}
