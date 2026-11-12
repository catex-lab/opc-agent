/**
 * 发现「用户在本机 CLI 配置里写过的模型名」（自动发现并可选，第一版）。
 *
 * ## 诚实边界（本模块存在的全部前提）
 *
 * - 这里发现的是**本机配置里写过的名字**，**不代表该账号真有权益**、
 *   也不代表 CLI 现在还认这个名字。界面必须标「未验证」并允许选前标定；
 *   选中只是把名字**原样透传给 CLI**，由 CLI 用它自己的配置连网关，
 *   本应用不代为验证、不代为连网关。
 * - **绝不读凭据值**：API Key / token / secret 的值不落内存、不进返回值。
 *   白名单只认「模型名」字段；对 `ANTHROPIC_API_KEY` / `*_BASE_URL` 这类字段
 *   **只看键是否存在**（存在 ⇒ 给一句来源提示），从不取它的值。
 * - 纯模块：不 import definitions / registry（那会带 SQLite 等副作用），
 *   只依赖 node:fs / node:path / node:os。
 *
 * ## 四类来源
 *
 * | 来源 | 文件 / 字段 |
 * |---|---|
 * | Claude Code | `~/.claude/settings.json` 的 `env` 段模型键 + 顶层 `model` |
 * | Codex | `~/.codex/config.toml` 的 `model` / `model_providers.*.models` |
 * | OpenCode | `~/.config/opencode/opencode.json(c)` 的 `provider.*.models` 键 + `model` |
 * | 通用环境变量 | `CLI_CONFIG_MODEL_ENV_KEYS` 列出的模型名键 |
 *
 * 文件不存在 / JSON 坏 / 权限错一律静默跳过、绝不抛异常 —— 这是每次拉
 * 模型菜单都会调的路径，不能因为它挂掉。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 界面用的形状；字段与前端 `src/types.ts` 的 CliConfiguredModel 一致。 */
export interface CliConfiguredModel {
  /** 模型名，原样传给 CLI */
  id: string;
  /** 界面显示名。没有更友好的名字就等于 id（本模块只拿得到名字本身） */
  label: string;
  /** 人类可读来源，如 '~/.claude/settings.json' 或 'env:ANTHROPIC_MODEL' */
  source: string;
  /** 这条模型适用于哪些已注册 Agent id */
  agentIds: string[];
}

/** 供验证闸门断言：通用环境变量里认哪几个「模型名」键。 */
export const CLI_CONFIG_MODEL_ENV_KEYS: readonly string[] = [
  'OPENAI_MODEL',
  'ANTHROPIC_MODEL',
  'OPENROUTER_MODEL',
  'OLLAMA_MODEL',
  'AZURE_OPENAI_DEPLOYMENT',
];

/**
 * 来源 → 归属的 Agent id 映射表。
 *
 * claude / codex / opencode 各自只归自己；env 一档列的是「kind==='cli' 且
 * 接受 --model」的**候选集合**。纯模块不 import definitions（会带副作用），
 * 所以这里是一张静态表：**归属由路由层用 agentAcceptsModel() 二次过滤** ——
 * 表里多写的 id、以及将来新增的 cli Agent，都由那一边用权威判据收口，
 * 本表只负责给出可见的候选，不冒充最终结论。
 */
export const CLI_CONFIG_AGENT_MAP: Record<string, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  opencode: ['opencode'],
  env: [
    'claude', 'codex', 'opencode', 'gemini', 'pi', 'antigravity',
    'kimicli', 'cursor', 'qoder', 'qoder-cn',
  ],
};

/** 调用方可注入环境 / 家目录 / 时钟，便于纯函数测试与确定性重放。 */
export interface CliConfiguredModelsOptions {
  /** 不传 = 用 process.env；传 `{}` 可完全隔离真实环境 */
  env?: NodeJS.ProcessEnv;
  /** 不传 = 从 env 的 USERPROFILE / HOME 推，再退到 os.homedir() */
  home?: string;
  /**
   * 预留的稳定时钟。本模块无状态、不缓存、输出里也不带时间戳，
   * 所以这个值当前不影响结果；保留它是为了让调用方（含路由层的缓存）
   * 能传同一份「现在」，避免各读各的 Date.now()。
   */
  now?: number;
}

/** Claude Code `env` 段里我们认的模型键（值与字段名都是白名单，别的键不碰）。 */
const CLAUDE_MODEL_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

/** 只认「像模型名」的值：非空、<=200、不含任何空白/换行。其余一律丢掉。 */
function cleanModelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > 200) return null;
  if (/\s/.test(raw)) return null;
  return raw;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 只看键是否存在，绝不把它的值读进内存或返回值。 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // 不存在 / 权限错 / 目录被占用：静默跳过
    return null;
  }
}

/**
 * 容忍 `//` 与 `/* *\/` 注释的 JSON 解析（.jsonc）。
 * 逐字符扫描、尊重字符串与转义，避免把 "https://..." 里的 // 当注释切掉。
 * 先试严格 JSON.parse，失败再剥注释；仍失败返回 null（绝不抛）。
 */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    /* 落到剥注释再试 */
  }
  try {
    const stripped = stripJsonComments(raw);
    const v = JSON.parse(stripped);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function stripJsonComments(text: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : '';
    if (quote) {
      if (c === '\\') {
        // 把转义符与它后面的字符一起原样保留
        out += c;
        out += n;
        i++;
        continue;
      }
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // 跳过结尾的 '/'
      continue;
    }
    out += c;
  }
  return out;
}

/** 去掉 TOML 值两侧引号；没引号时原样 trim。 */
function unquote(v: string): string {
  const m = /^["']([^"']*)["']/.exec(v.trim());
  return m ? m[1] : v.trim();
}

/** 去掉 TOML 行注释（`#`，不切字符串里的 #）。 */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * 从 `models = ...` 的值里保守地取模型名。
 * 只认两种形状：数组里的带引号字符串、内联表里紧挨 `=` 的带引号键。
 * 不做完整 TOML 解析，也不试图解析嵌套对象的值 —— 那是「保守」。
 */
function tomlModelTokens(value: string): string[] {
  const out: string[] = [];
  if (value.startsWith('[')) {
    const re = /["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) out.push(m[1]);
  } else if (value.startsWith('{')) {
    const re = /["']([^"']+)["']\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) out.push(m[1]);
  }
  return out;
}

/** 内联表里常见的配置键（不是模型名），命中就丢掉。 */
const TOML_NON_MODEL_KEYS = new Set([
  'name', 'id', 'slug', 'description', 'base_url', 'env_key', 'wire_api',
  'type', 'query_params', 'http_headers', 'request_max_retries',
  'stream_max_retries', 'stream_idle_timeout_ms', 'requires_openai_auth',
  'context_window', 'max_output_tokens', 'supports_parallel_tool_calls',
]);

type AddFn = (rawId: unknown, source: string, agentIds: string[]) => void;

function byId(a: CliConfiguredModel, b: CliConfiguredModel): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

/**
 * 收集器：按 id 去重（同 agentId + 同 id 只留一条，source 取**先命中的**），
 * agentIds 取各次命中的并集，最后按 id 排序保证输出稳定。
 */
function makeCollector(): { add: AddFn; finish: () => CliConfiguredModel[] } {
  const map = new Map<string, CliConfiguredModel>();
  return {
    add(rawId, source, agentIds) {
      const id = cleanModelId(rawId);
      if (!id) return;
      const ids = [...new Set(agentIds)].sort();
      const existing = map.get(id);
      if (existing) {
        // 去重：source / label 保持第一次命中；agentIds 取并集
        existing.agentIds = [...new Set([...existing.agentIds, ...ids])].sort();
        return;
      }
      // 没有更友好的显示名，label 就等于 id
      map.set(id, { id, label: id, source, agentIds: ids });
    },
    finish() {
      return [...map.values()].sort(byId);
    },
  };
}

// ── Claude Code ────────────────────────────────────────────────────────────
function scanClaude(home: string, add: AddFn): void {
  const raw = readText(path.join(home, '.claude', 'settings.json'));
  if (raw === null) return;
  const json = parseJsonLoose(raw);
  if (!json) return;
  const source = '~/.claude/settings.json';
  const agentIds = CLI_CONFIG_AGENT_MAP.claude;
  const envSeg = isObj(json.env) ? json.env : null;
  // 只看 ANTHROPIC_API_KEY 这个键在不在：在 ⇒ 说明配了自定义网关。
  // 绝不读它的值，也不把值写进 source。
  const hint = envSeg && hasOwn(envSeg, 'ANTHROPIC_API_KEY') ? '（配了自定义网关）' : '';
  const src = source + hint;
  if (envSeg) {
    for (const k of CLAUDE_MODEL_ENV_KEYS) {
      if (hasOwn(envSeg, k)) add(envSeg[k], src, agentIds);
    }
  }
  if (hasOwn(json, 'model')) add(json.model, src, agentIds);
}

// ── Codex（保守的正则逐行解析，不引入 TOML 依赖）────────────────────────────
function scanCodex(home: string, add: AddFn): void {
  const raw = readText(path.join(home, '.codex', 'config.toml'));
  if (raw === null) return;
  const source = '~/.codex/config.toml';
  const agentIds = CLI_CONFIG_AGENT_MAP.codex;
  const lines = raw.split(/\r?\n/);
  // 预扫一遍：model_provider 是 provider 选择器，**不是模型名** —— 只看它在不在，
  // 在就给一句来源提示，绝不把它的值当模型发出去（那会摆一个假选项）。
  const hasProviderSelector = lines.some(l => /^\s*model_provider\s*=/.test(stripTomlComment(l)));
  const hint = hasProviderSelector ? '（配了自定义 provider）' : '';
  let section = '';
  for (const lineRaw of lines) {
    const line = stripTomlComment(lineRaw).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      // [model_providers.<name>.models.<MODEL>]：末段就是模型名
      const m = /^model_providers\.[^.]+\.models\.(.+)$/.exec(section);
      if (m) add(unquote(m[1]), `${source} · ${section}${hint}`, agentIds);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    const inProviders = /^model_providers\b/.test(section);
    if (key === 'model') {
      // 顶层 model = "..." 与 provider 段里的 model = "..." 都算模型名
      add(unquote(value), `${inProviders ? `${source} · ${section}` : source}${hint}`, agentIds);
    } else if (key === 'model_provider') {
      // 已在预扫里按「存在」登记，这里只是跳过，绝不取它的值造模型
      continue;
    } else if (inProviders && key === 'models') {
      for (const tok of tomlModelTokens(value)) {
        if (TOML_NON_MODEL_KEYS.has(tok.toLowerCase())) continue;
        add(tok, `${source} · ${section}.models${hint}`, agentIds);
      }
    }
  }
}

// ── OpenCode ───────────────────────────────────────────────────────────────
function scanOpenCode(home: string, add: AddFn): void {
  const base = path.join(home, '.config', 'opencode');
  const agentIds = CLI_CONFIG_AGENT_MAP.opencode;
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const raw = readText(path.join(base, name));
    if (raw === null) continue;
    const json = parseJsonLoose(raw);
    if (!json) continue;
    const source = `~/.config/opencode/${name}`;
    // 顶层 model 字段
    if (hasOwn(json, 'model')) add(json.model, source, agentIds);
    // provider.<name>.models 对象的键 = 模型名；provider 段里的 model 字段也算
    const provider = isObj(json.provider) ? json.provider : null;
    if (!provider) continue;
    for (const pname of Object.keys(provider)) {
      const p = provider[pname];
      if (!isObj(p)) continue;
      if (hasOwn(p, 'model')) add(p.model, `${source} · provider.${pname}.model`, agentIds);
      const models = isObj(p.models) ? p.models : null;
      if (!models) continue;
      for (const mid of Object.keys(models)) {
        add(mid, `${source} · provider.${pname}.models`, agentIds);
      }
    }
  }
}

// ── 通用环境变量 ───────────────────────────────────────────────────────────
function scanEnv(env: NodeJS.ProcessEnv, add: AddFn): void {
  // 只看 BASE_URL 这两个键在不在：在 ⇒ 「已配置自定义端点」来源提示。
  // 绝不读它们的值（值里可能带 token），也绝不因它们存在就凭空造模型条目。
  const hasEndpoint = hasOwn(env, 'OPENAI_BASE_URL') || hasOwn(env, 'ANTHROPIC_BASE_URL');
  const hint = hasEndpoint ? '（已配置自定义端点）' : '';
  const agentIds = CLI_CONFIG_AGENT_MAP.env;
  for (const k of CLI_CONFIG_MODEL_ENV_KEYS) {
    if (!hasOwn(env, k)) continue;
    add(env[k], `env:${k}${hint}`, agentIds);
  }
}

function resolveEnv(opts?: CliConfiguredModelsOptions): NodeJS.ProcessEnv {
  return opts?.env ?? process.env;
}

function resolveHome(opts: CliConfiguredModelsOptions | undefined, env: NodeJS.ProcessEnv): string {
  return opts?.home ?? env.USERPROFILE ?? env.HOME ?? os.homedir();
}

/**
 * 扫描本机四类配置，返回发现的模型名（去重、按 id 排序）。
 * 任何异常都静默降级成空数组 —— 这是每次拉模型菜单都会调的路径。
 */
export function listCliConfiguredModels(
  opts?: CliConfiguredModelsOptions
): CliConfiguredModel[] {
  try {
    const env = resolveEnv(opts);
    const home = resolveHome(opts, env);
    const collector = makeCollector();
    // 顺序即「先命中」的顺序：claude → codex → opencode → env
    scanClaude(home, collector.add);
    scanCodex(home, collector.add);
    scanOpenCode(home, collector.add);
    scanEnv(env, collector.add);
    return collector.finish();
  } catch {
    return [];
  }
}

/** 某 Agent 可用的「本机配置模型名」清单（已按 id 排序）。 */
export function configuredModelIdsFor(
  agentId: string,
  opts?: CliConfiguredModelsOptions
): string[] {
  if (!agentId) return [];
  return listCliConfiguredModels(opts)
    .filter(m => m.agentIds.includes(agentId))
    .map(m => m.id);
}

/**
 * 某个模型名是否属于「该 Agent 的本机配置模型」。
 * 供路由层注册使用：它据此判断请求值是不是用户自己配过的名字，
 * 从而决定要不要放行（而不是被 def.models 白名单静默换成默认模型）。
 */
export function isConfiguredModelForAgent(
  agentId: string,
  modelId: string,
  opts?: CliConfiguredModelsOptions
): boolean {
  if (!agentId) return false;
  const id = cleanModelId(modelId);
  if (!id) return false;
  return listCliConfiguredModels(opts).some(
    m => m.id === id && m.agentIds.includes(agentId)
  );
}
