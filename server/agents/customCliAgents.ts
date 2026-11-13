/**
 * 用户手动接入的本地 CLI Agent（A223）。
 *
 * ## 它解决什么问题
 *
 * 内置 15 条覆盖的是「我们已经核实过接入方式」的 Agent，自动发现白名单是
 * 刻意收紧的（防 IDE 图形启动器误判，见 definitions.ts 顶部说明）。但用户
 * 手上确实有名单之外的本地 CLI：公司内部工具、自己写的脚本 Agent、还没被
 * 收录的新产品。他们需要一个**用户明确操作**才开的口子—— 与自动发现是
 * 两个动作，互不越界。
 *
 * ## 与 A114 自建厂商（HTTP）的分工
 *
 * A114 接的是「只有 HTTP API、没有 CLI」的端点，复用 http 适配器；
 * 这里接的是「本机有可执行文件」的 CLI，复用 cli 适配器。两者共用
 * `custom: true` 的产品语义（通讯录独立分组、可移除），但存储、校验、
 * 合成定义完全分开 —— 改动越少，两条链路行为分叉的机会越少。
 *
 * ## 分发约定（用户要填什么）
 *
 * 一条接入声明 = 启动命令 + 参数模板 + 输入/输出方式：
 *   - 命令：PATH 里的名字或完整路径。进程**不经过 shell** 拉起（cli.ts 同款），
 *     所以路径带空格也安全；
 *   - 参数：一个字符串数组，支持三个占位符 —— `{prompt}`（用户输入）、
 *     `{cwd}`（会话工作目录）、`{model}`（模型名，填了才认模型参数）。
 *     没写 `{prompt}` 且不走 stdin 时，prompt 追加为最后一个参数；
 *   - 输入方式：argv（默认）或 stdin（prompt 写进标准输入后立即 EOF）；
 *   - 输出协议：`text`（整段 stdout 即回答）或 `jsonl`（每行一个 JSON 事件，
 *     字段约定见 `mapCustomCliLine`）。
 *
 * ## 为什么「检测」与「试跑」分开
 *
 * 检测只做**零成本**的解析（命令能不能找到）；试跑会真的拉起进程发一句
 * prompt —— 那是一次真实的 LLM 调用，可能花钱、可能要等。把它做成可选按钮
 * 而不是保存的前置条件，用户才不会为了「验证一下」莫名被扣一次额度。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDirPath } from '../paths.js';
import type { AgentCapability } from './types.js';
import type { SendContext } from './types.js';
import type { AgentDefinition } from './definitions.js';
import type { AgentEvent } from './types.js';
import { findExecutable } from './probe.js';

/** 一条手动接入 CLI 的定义（不含任何密钥——CLI 用的是用户自己的登录态） */
export interface CustomCliSpec {
  /** `customcli-<uuid 前 8 位>`。与 HTTP 自建的 `custom-` 前缀区分路由与凭据语义 */
  id: string;
  name: string;
  /** 命令名（在 PATH 里找）或可执行文件的完整路径 */
  command: string;
  /**
   * 参数模板。占位符：`{prompt}` / `{cwd}` / `{model}`。
   * 没写 `{prompt}` 且不走 stdin 时，prompt 追加为最后一个参数。
   */
  args: string[];
  /** true = prompt 写进 stdin（写完立即 EOF），argv 里不再带 prompt */
  stdin: boolean;
  /** stdout 解析方式：text = 整段即回答；jsonl = 每行一个约定格式的 JSON */
  protocol: 'text' | 'jsonl';
  /** 用户勾选的能力标签。只影响名册徽标与技能匹配，不改变进程实际能干什么 */
  capabilities: AgentCapability[];
  createdAt: number;
}

const STORE_PATH = path.join(dataDirPath, 'custom-cli-agents.json');

const MAX_NAME_LEN = 20;
const MAX_COMMAND_LEN = 260;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 2000;

/** 用户可勾选的能力。与内置 Agent 用同一套词汇，不给自定义词汇 */
const SELECTABLE_CAPABILITIES: AgentCapability[] = ['chat', 'code', 'write', 'tools', 'search'];

/** 用户提交的原始字段（创建/编辑时用） */
export interface CustomCliInput {
  name: string;
  command: string;
  args: string[];
  stdin: boolean;
  protocol: 'text' | 'jsonl';
  capabilities: AgentCapability[];
}

export type NormalizeCliResult =
  | { ok: true; value: CustomCliInput }
  | { ok: false; error: string };

/**
 * 校验并归一化用户输入。纯函数（不碰盘、不拉进程），验证脚本直接跑边界用例。
 *
 * 安全边界：进程不经 shell 拉起，所以参数里的 `|&;` 等只是普通字符；
 * 真正要拦的是**换行**（argv 里出现换行几乎必然是粘贴错误）与空命令。
 */
export function normalizeCustomCliInput(raw: unknown): NormalizeCliResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim();
  const command = String(r.command ?? '').trim();
  const stdin = r.stdin === true;
  const protocol = r.protocol === 'jsonl' ? 'jsonl' : 'text';
  const rawArgs = Array.isArray(r.args)
    ? r.args.map(a => String(a ?? ''))
    : typeof r.args === 'string' && r.args.trim()
      ? r.args.split('\n')
      : [];
  const args = rawArgs
    .map(a => a.trim())
    // 空行直接丢（textarea 尾部回车是常态），但保留参数内部的空格
    .filter(a => a.length > 0);
  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter(
        (c): c is AgentCapability =>
          typeof c === 'string' && (SELECTABLE_CAPABILITIES as string[]).includes(c)
      )
    : [];

  if (!name) return { ok: false, error: '请填写名称' };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `名称不能超过 ${MAX_NAME_LEN} 个字` };
  }
  if (!command) return { ok: false, error: '请填写启动命令' };
  if (command.length > MAX_COMMAND_LEN) {
    return { ok: false, error: `命令过长（上限 ${MAX_COMMAND_LEN} 字符）` };
  }
  if (/[\r\n]/.test(command)) return { ok: false, error: '命令不能包含换行' };
  if (/["`;]/.test(command)) {
    return { ok: false, error: '命令里不要包含引号、反引号或分号——进程不经过 shell，这些字符只会原样传给系统' };
  }
  if (args.length > MAX_ARGS) {
    return { ok: false, error: `参数最多 ${MAX_ARGS} 个` };
  }
  if (args.some(a => a.length > MAX_ARG_LEN)) {
    return { ok: false, error: `单个参数不能超过 ${MAX_ARG_LEN} 个字符` };
  }
  if (args.some(a => /[\r\n]/.test(a))) {
    return { ok: false, error: '参数不能包含换行（每行一个参数）' };
  }
  if (!stdin && !args.some(a => a.includes('{prompt}'))) {
    // 不是错误：没写占位符就追加为末位参数。这里只做形状归一。
  }
  return { ok: true, value: { name, command, args, stdin, protocol, capabilities: caps } };
}

function readStore(): CustomCliSpec[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_PATH, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[CustomCli] custom-cli-agents.json 解析失败，按「没有手动接入」处理');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CustomCliSpec[] = [];
  for (const item of parsed) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const norm = normalizeCustomCliInput(r);
    if (!norm.ok) continue;
    const id = String(r.id ?? '').trim();
    if (!id.startsWith('customcli-')) continue;
    out.push({
      ...norm.value,
      id,
      createdAt: Number(r.createdAt) || Date.now(),
    });
  }
  return out;
}

function writeStore(list: CustomCliSpec[]): void {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
}

/** 全部手动接入的 CLI 定义 */
export function loadCustomCliSpecs(): CustomCliSpec[] {
  return readStore();
}

/** 新建一条并落盘 */
export function createCustomCliSpec(input: CustomCliInput): CustomCliSpec {
  const spec: CustomCliSpec = {
    id: `customcli-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    ...input,
    createdAt: Date.now(),
  };
  const list = readStore();
  list.push(spec);
  writeStore(list);
  return spec;
}

/** 编辑一条。id 与 createdAt 不可改（会话历史按 id 归属） */
export function updateCustomCliSpec(
  id: string,
  input: CustomCliInput
): CustomCliSpec | null {
  const list = readStore();
  const i = list.findIndex(s => s.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...input };
  writeStore(list);
  return list[i];
}

/** 删除一条。幂等 */
export function deleteCustomCliSpec(id: string): boolean {
  const list = readStore();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  writeStore(next);
  return true;
}

/**
 * 解析命令：PATH 里的名字 → 命中路径；带路径分隔符 → 直接检查。
 * 返回 null = 本机找不到（界面上要给「检测不到」而不是存一条必然失败的声明）。
 */
export function resolveCustomCliCommand(spec: Pick<CustomCliSpec, 'command'>): string | null {
  return findExecutable(spec.command);
}

/** 试跑结论（测试结论，不是服务端故障——失败也用 200 返回） */
export interface CustomCliTrialResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** 解析到的可执行文件路径；null = 检测不到 */
  resolvedPath: string | null;
  stdout: string;
  stderr: string;
  message: string;
}

/** 试跑预算：真的会做一次 LLM 调用，给足首字时间但绝不无限等 */
const TRIAL_TIMEOUT_MS = 30_000;
const TRIAL_CAPTURE_BYTES = 4000;

/**
 * 试跑：真的拉起进程发一句 prompt，把原始输出原样带回来。
 *
 * 与「检测」的分工：检测回答「命令存在吗」（零成本），试跑回答
 * 「按这份声明拉起来真的能出东西吗」（一次真实调用）。任何一步失败
 * 都不算服务端错误，ok:false + message 说明原因。
 */
export function trialCustomCli(
  spec: CustomCliSpec,
  prompt: string,
  cwd?: string
): Promise<CustomCliTrialResult> {
  const resolvedPath = resolveCustomCliCommand(spec);
  if (!resolvedPath) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      timedOut: false,
      resolvedPath: null,
      stdout: '',
      stderr: '',
      message: `检测不到命令：${spec.command}（不在 PATH 里，路径也不存在）`,
    });
  }

  return new Promise(resolve => {
    const args = buildCustomCliArgs(spec, prompt, { cwd: cwd || process.cwd() });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(resolvedPath, args, {
      cwd: cwd || process.cwd(),
      shell: false,
      windowsHide: true,
      stdio: spec.stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hasOutput = stdout.trim().length > 0 || stderr.trim().length > 0;
      const ok = !timedOut && exitCode === 0;
      resolve({
        ok,
        exitCode,
        timedOut,
        resolvedPath,
        stdout: stdout.slice(0, TRIAL_CAPTURE_BYTES),
        stderr: stderr.slice(0, TRIAL_CAPTURE_BYTES),
        message: timedOut
          ? `试跑超时（${Math.round(TRIAL_TIMEOUT_MS / 1000)}s）没有退出——有的 CLI 会等交互输入，检查是否该改用「stdin 输入」`
          : ok
            ? hasOutput
              ? '试跑通过：进程正常退出且有输出'
              : '试跑通过：进程正常退出（无输出，确认该命令是否真的接收了 prompt）'
            : `试跑失败：退出码 ${exitCode ?? '未知'}`,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, TRIAL_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < TRIAL_CAPTURE_BYTES) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < TRIAL_CAPTURE_BYTES) stderr += d.toString('utf8');
    });
    child.on('error', (err: Error) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        resolvedPath,
        stdout,
        stderr,
        message: `拉起失败：${err.message}`,
      });
    });
    child.on('close', code => finish(code));

    if (spec.stdin && child.stdin) {
      child.stdin.on('error', () => {
        /* 对端没了：终止链会收尸（与 cli.ts 的 EPIPE 处理同一口径） */
      });
      try {
        child.stdin.end(prompt + '\n');
      } catch {
        /* 收尾交给 close */
      }
    }
  });
}

/**
 * 构造 argv（与 CliAdapter 调 buildArgs 的时机对齐，合成定义时复用同一函数，
 * 保证「试跑时看到的」和「真正跑的」是同一份参数）。
 */
export function buildCustomCliArgs(
  spec: Pick<CustomCliSpec, 'args' | 'stdin'>,
  prompt: string,
  ctx: Pick<SendContext, 'cwd' | 'model'>
): string[] {
  const out: string[] = [];
  let placed = false;
  for (const template of spec.args) {
    let arg = template;
    if (arg.includes('{prompt}')) {
      arg = arg.split('{prompt}').join(prompt);
      placed = true;
    }
    if (arg.includes('{cwd}')) {
      arg = arg.split('{cwd}').join(ctx.cwd || process.cwd());
    }
    if (arg.includes('{model}')) {
      arg = arg.split('{model}').join(ctx.model ?? '');
    }
    out.push(arg);
  }
  if (!placed && !spec.stdin) out.push(prompt);
  return out;
}

/**
 * jsonl 协议的行映射约定（用户按这个格式输出，就能拿到结构化的界面）：
 *   - `{"type":"text","content":"…"}`                正文增量
 *   - `{"type":"thinking","content":"…"}`            思考过程
 *   - `{"type":"tool","name":"…","input":{…}}`       工具开始（id 缺省自动编）
 *   - `{"type":"tool_result","toolId":"…","content":"…","isError":true}`
 *   - `{"type":"usage","tokens":…,"cost":…,"durationMs":…}`
 *   - `{"type":"error","message":"…"}`
 *   - `{"type":"session","id":"…"}`（或顶层 `"sessionId"`) 续接令牌——
 *     这里**只返回 null**：令牌由 cli 适配器的 `extractResumeToken` 统一提取
 *     并自己发 init（cli.ts:1157），映射器再发一遍会出两条 init。
 * 认不出的行**不丢**：返回 null 交给适配器的 raw 旁路（A111 的口径——
 * 映射不到也要留着，且通道标注统一走 `cli:` 前缀）。
 */
export function mapCustomCliLine(obj: unknown, seq: { toolCount: number }): AgentEvent | AgentEvent[] | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  switch (o.type) {
    case 'text':
    case 'thinking': {
      const content = String(o.content ?? '');
      if (!content) return null;
      return { type: o.type, content };
    }
    case 'tool': {
      const name = String(o.name ?? 'tool');
      seq.toolCount += 1;
      return {
        type: 'tool',
        id: String(o.id ?? `custom-tool-${seq.toolCount}`),
        name,
        input: (o.input ?? null) as Record<string, unknown> | null,
      };
    }
    case 'tool_result': {
      const content = String(o.content ?? '');
      return {
        type: 'tool_result',
        toolId: String(o.toolId ?? ''),
        content,
        ...(o.isError === true ? { isError: true } : {}),
      };
    }
    case 'usage': {
      const ev: AgentEvent = { type: 'usage' };
      if (typeof o.durationMs === 'number') ev.durationMs = o.durationMs;
      if (typeof o.cost === 'number') ev.cost = o.cost;
      if (typeof o.tokens === 'number') ev.tokens = o.tokens;
      return ev;
    }
    case 'error':
      return { type: 'error', message: String(o.message ?? '未知错误') };
    case 'session':
      // 令牌提取归 extractResumeToken（见函数头注释），这里不重复发 init
      return null;
    default:
      return null;
  }
}

/**
 * 合成 AgentDefinition。形态对齐内置 CLI 条目：`kind: 'cli'`，事件来源按
 * 协议如实标注（text = parsed_text，jsonl = structured_cli）——界面据此
 * 区分「结构化输出」与「解析出来的」，不谎报。
 */
export function customCliSpecToDefinition(spec: CustomCliSpec): AgentDefinition {
  const jsonl = spec.protocol === 'jsonl';
  return {
    descriptor: {
      id: spec.id,
      name: spec.name,
      vendor: '自建',
      kind: 'cli',
      // 与 HTTP 自建同一个产品语义：通讯录独立分组、详情页有移除入口
      custom: true,
      capabilities: spec.capabilities.length > 0 ? [...spec.capabilities] : ['chat'],
      eventCapabilities: jsonl ? ['thinking', 'tool', 'usage'] : undefined,
      description: `手动接入的本地 CLI：${spec.command}${spec.stdin ? '（stdin 输入）' : ''}`,
      color: '#8C6CFF',
      command: spec.command,
      installHint: '在通讯录「手动添加 Agent」里修改或移除',
    },
    cli: {
      bin: spec.command,
      buildArgs: (prompt: string, ctx: SendContext) =>
        buildCustomCliArgs(spec, prompt, ctx),
      parse: spec.protocol,
      ...(jsonl
        ? {
            // 有状态工厂：工具 id 自增序号必须跨行累计（cli.ts:979 每会话一份），
            // 无状态的 mapLine 闭包做不到这一点
            createMapper: () => {
              const seq = { toolCount: 0 };
              return (obj: unknown) => mapCustomCliLine(obj, seq);
            },
            extractResumeToken: (obj: unknown) => {
              if (obj === null || typeof obj !== 'object') return null;
              const o = obj as Record<string, unknown>;
              if (o.type === 'session' && typeof o.id === 'string') return o.id;
              if (typeof o.sessionId === 'string' && o.type === undefined) return o.sessionId;
              return null;
            },
          }
        : {}),
      ...(spec.stdin ? { stdinPrompt: true } : {}),
      timeoutMs: 8 * 60 * 1000,
    },
  };
}
