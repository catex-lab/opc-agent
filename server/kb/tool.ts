/**
 * 跨 Agent 知识库的 MCP 工具（stdio）。
 *
 * 工具名 `kb.search`，入参只允许 `query / scope / topK`。
 * **sessionId 由宿主注入**（环境变量 `OPC_KB_SESSION_ID`），客户端传
 * `sessionId` 或任何路径参数会被直接拒绝 —— 因为范围收口要靠服务端
 * 从会话反查工作区/项目，不能信任请求里的任意路径。
 *
 * ## 能力覆盖矩阵（诚实边界）
 *
 * | 通道            | 工具 | 说明 |
 * |-----------------|------|------|
 * | claude-sdk      | ✅   | `mcpServers` 起本 stdio server，`canUseTool` 放行 `mcp__kb__*` |
 * | 腾讯 SDK        | ✅   | 同上（WorkBuddy / CodeBuddy） |
 * | CLI · qoder     | ✅   | `--mcp-config`（复用扩展分发的同类机制），argv 含 `mcp__kb__search` |
 * | CLI · qoder-cn  | ✅   | 与 qoder 同构 |
 * | ACP（Hermes）   | ✅   | `session/new` 的 `mcpServers` |
 * | CLI · claude    | ⚠️   | 仅在非双向模式给 `--allowedTools`；双向模式靠 can_use_tool 放行 |
 * | Codex SDK       | ❌   | 该 SDK 没有 MCP 注入面，只享受首轮自动注入 |
 * | HTTP 型         | ❌   | 豆包 / Kimi / 自定义（商汤等）没有 function calling，只享受自动注入 |
 *
 * 不具备工具面的通道**不会**收到假的工具声明：宁可只用自动注入，
 * 也不要在 prompt 里写「你可以调用 kb.search」而实际调不到。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as chatDb from '../db.js';
import { dataDirPath } from '../paths.js';
import type { KbCitationRef } from '../../shared/blocks.js';
import { redactForStorage } from './redact.js';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOP_K,
  searchKnowledge,
  type KbScope,
} from './search.js';

/** MCP server 名（Claude/腾讯 SDK 用它拼工具全名 `mcp__kb__...`） */
export const KB_MCP_SERVER_NAME = 'kb';
/** 工具名（用户口径固定为 `kb.search`） */
export const KB_MCP_TOOL_NAME = 'kb.search';
/** 放行用的工具全名：宿主对点号的转义口径不统一，两种都放 */
export const KB_MCP_ALLOWED_TOOL_IDS = ['mcp__kb__kb.search', 'mcp__kb__search'] as const;
export const KB_MCP_TOOL_PREFIX = 'mcp__kb__';
export const KB_MCP_SESSION_ENV = 'OPC_KB_SESSION_ID';

export interface KbMcpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 判断一个工具名是不是本知识库工具（审批桥的放行用） */
export function isKbMcpTool(toolName: string): boolean {
  return String(toolName ?? '').startsWith(KB_MCP_TOOL_PREFIX);
}

/**
 * 解析 stdio server 的启动方式。
 *
 * 三种形态，优先级从高到低：
 *   1. 打包态：`resources/app.asar.unpacked/dist-electron/kb-mcp.cjs`
 *      （electron-builder 的 asarUnpack 已包含该文件）；
 *   2. 开发态已构建：仓库 `dist-electron/kb-mcp.cjs`；
 *   3. 开发态未构建：源码 `server/kb/mcp-main.ts` + `--import tsx`
 *      （tsx 是 devDependency，打包态不会走到这里）。
 *
 * 统一用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`：Electron 主进程里
 * 它就是应用自带的 Node，避免要求用户另装 node。
 */
function resolveKbMcpLaunch(): { command: string; args: string[]; env: Record<string, string> } {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const unpacked = resources
    ? path.join(resources, 'app.asar.unpacked', 'dist-electron', 'kb-mcp.cjs')
    : null;
  if (unpacked && fs.existsSync(unpacked)) {
    return { command: process.execPath, args: [unpacked], env: {} };
  }

  const built = path.join(process.cwd(), 'dist-electron', 'kb-mcp.cjs');
  if (fs.existsSync(built)) {
    return { command: process.execPath, args: [built], env: {} };
  }

  const source = path.join(process.cwd(), 'server', 'kb', 'mcp-main.ts');
  return { command: process.execPath, args: ['--import', 'tsx', source], env: {} };
}

/**
 * 生成一份可直接塞进 mcpServers 的 stdio 配置。
 *
 * `sessionId` 只在宿主自己起进程时写进 env（SDK / ACP 路径）；
 * CLI 路径用继承环境，避免把会话 id 固化进磁盘配置。
 */
export function kbMcpServerSpec(sessionId?: string): KbMcpServerSpec {
  const launch = resolveKbMcpLaunch();
  const env: Record<string, string> = {
    OPC_DATA_DIR: dataDirPath,
    // Electron 二进制以 Node 模式跑脚本；普通 node 进程里该变量无副作用
    ELECTRON_RUN_AS_NODE: '1',
    ...launch.env,
  };
  if (sessionId) env[KB_MCP_SESSION_ENV] = sessionId;
  return { command: launch.command, args: launch.args, env };
}

/** 支持 `--mcp-config` 且已实测/同构的 CLI Agent */
const KB_MCP_CONFIG_AGENTS = new Set(['qoder', 'qoder-cn', 'claude']);

/**
 * 给 CLI Agent 生成 MCP 启动参数（复用扩展分发的 `--mcp-config` 机制）。
 *
 * 写盘位置固定 `data/extensions/mcp-kb-<agentId>.json`，与扩展分发的
 * `mcp-<agentId>.json` 分开，避免两条线程互相覆盖。
 * 会话 id 不写进文件：CLI 子进程继承宿主环境里的 `OPC_KB_SESSION_ID`。
 */
export function kbMcpArgsFor(agentId: string): string[] {
  if (!KB_MCP_CONFIG_AGENTS.has(agentId)) return [];
  try {
    const dir = path.join(dataDirPath, 'extensions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `mcp-kb-${agentId}.json`);
    const spec = kbMcpServerSpec();
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { [KB_MCP_SERVER_NAME]: spec } }, null, 2),
      'utf8'
    );
    return ['--mcp-config', file];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[KB] 生成 MCP 配置失败（该 Agent 本轮无 kb.search）: ${message}`);
    return [];
  }
}

// ============= MCP stdio 协议实现 =============

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

class ToolInputError extends Error {}

const TOOL_INPUT_KEYS = new Set(['query', 'scope', 'topK']);
const VALID_SCOPES = new Set<KbScope>(['session', 'workspace', 'project', 'all']);

function clip(input: string, max: number): string {
  const chars = Array.from(String(input ?? '').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

function sessionTitleOf(sessionId: string): string | undefined {
  try {
    const session = chatDb.getSession(sessionId);
    if (!session?.title) return undefined;
    const { text, redactedCount } = redactForStorage(session.title);
    return redactedCount > 0 ? '（标题已脱敏）' : clip(text, 60);
  } catch {
    return undefined;
  }
}

/**
 * 执行 `kb.search`。抛 `ToolInputError` 表示参数不合法（回给模型的 isError）。
 */
export function executeKbSearchTool(
  rawArgs: unknown,
  sessionId: string | undefined
): { citations: KbCitationRef[]; tokensUsed: number; scopeApplied: string; filteredOut: number } {
  if (!sessionId) {
    throw new ToolInputError('缺少宿主注入的会话上下文（sessionId 不允许由调用方提供）');
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new ToolInputError('入参必须是对象，且只允许 query / scope / topK');
  }

  const args = rawArgs as Record<string, unknown>;
  const illegal = Object.keys(args).filter(key => !TOOL_INPUT_KEYS.has(key));
  if (illegal.length > 0) {
    throw new ToolInputError(
      `拒绝参数：${illegal.join('、')}。只允许 query / scope / topK；sessionId 与路径必须由宿主注入`
    );
  }

  const query = String(args.query ?? '').trim();
  if (!query) throw new ToolInputError('query 不能为空');
  if (Array.from(query).length > 2000) throw new ToolInputError('query 过长（上限 2000 字符）');

  let scope: KbScope = 'workspace';
  if (args.scope !== undefined) {
    const value = String(args.scope);
    if (!VALID_SCOPES.has(value as KbScope)) {
      throw new ToolInputError('scope 只允许 session / workspace / project / all');
    }
    scope = value as KbScope;
  }

  // topK 上限与面板一致（4）；maxTokens 固定 1600，调用方不能抬高预算
  let topK = DEFAULT_TOP_K;
  if (args.topK !== undefined) {
    const n = Number(args.topK);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) {
      throw new ToolInputError('topK 必须是正整数');
    }
    topK = Math.min(DEFAULT_TOP_K, Math.max(1, Math.floor(n)));
  }

  const result = searchKnowledge({
    sessionId,
    query,
    scope,
    topK,
    maxTokens: DEFAULT_MAX_TOKENS,
  });

  const citations: KbCitationRef[] = result.hits.map(hit => ({
    citationId: hit.citationId,
    sessionId: hit.sessionId,
    sessionTitle: sessionTitleOf(hit.sessionId),
    sourceType: hit.sourceType,
    role: hit.role,
    agentId: hit.authorAgentId ?? hit.agentId,
    timeEnd: hit.timeEnd,
    snippet: clip(hit.snippet || hit.summary, 240),
    messageIds: hit.messageIds,
  }));

  return {
    citations,
    tokensUsed: result.tokensUsed,
    scopeApplied: result.scopeApplied,
    filteredOut: result.filteredOut,
  };
}

function toolDefinition() {
  return {
    name: KB_MCP_TOOL_NAME,
    description:
      '只读检索本机跨 Agent 历史会话知识库。默认范围为本工作区；project/all 需用户在面板显式开启。' +
      '只返回脱敏后的摘要与片段，不会返回完整原文。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言问题' },
        scope: {
          type: 'string',
          enum: ['session', 'workspace', 'project', 'all'],
          description: '检索范围，默认 workspace；project/all 未开启时会被服务端拒绝',
        },
        topK: { type: 'number', description: `返回条数（1-${DEFAULT_TOP_K}）` },
      },
      required: ['query'],
    },
  };
}

/**
 * stdio MCP server 主循环：一行一个 JSON-RPC。
 *
 * stdout 只允许协议帧，日志一律走 stderr。
 */
export function runKbMcpStdioServer(): void {
  const sessionId = process.env[KB_MCP_SESSION_ENV];
  const out = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const reply = (id: number | string | null | undefined, result: unknown) => {
    out({ jsonrpc: '2.0', id: id ?? null, result });
  };
  const fail = (id: number | string | null | undefined, code: number, message: string) => {
    out({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };

  const handle = async (req: JsonRpcRequest) => {
    if (!req || typeof req !== 'object') return;
    // 通知（无 id）只确认，不回包
    if (req.id == null && req.method !== 'tools/call') {
      if (req.method === 'notifications/initialized') return;
      if (req.method === 'ping') return;
      return;
    }

    switch (req.method) {
      case 'initialize':
        reply(req.id, {
          protocolVersion:
            typeof req.params?.protocolVersion === 'string'
              ? req.params.protocolVersion
              : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'opc-kb', version: '1.0.0' },
        });
        return;

      case 'ping':
        reply(req.id, {});
        return;

      case 'tools/list':
        reply(req.id, { tools: [toolDefinition()] });
        return;

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (String(params.name ?? '') !== KB_MCP_TOOL_NAME) {
          reply(req.id, {
            content: [{ type: 'text', text: `未知工具：${String(params.name ?? '')}` }],
            isError: true,
          });
          return;
        }
        try {
          const result = executeKbSearchTool(params.arguments, sessionId);
          reply(req.id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  scopeApplied: result.scopeApplied,
                  count: result.citations.length,
                  tokensUsed: result.tokensUsed,
                  filteredOut: result.filteredOut,
                  hits: result.citations,
                }),
              },
            ],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // 参数错误回给模型（isError），协议层保持 200，让模型能纠错重试
          reply(req.id, { content: [{ type: 'text', text: message }], isError: true });
        }
        return;
      }

      default:
        fail(req.id, -32601, `不支持的方法：${String(req.method ?? '')}`);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      fail(null, -32700, 'JSON 解析失败');
      return;
    }
    // 串行处理：检索读同一个 SQLite 连接，并发没有收益
    chain = chain.then(() => handle(req)).catch(err => {
      console.error('[KB-MCP] 请求处理失败:', err);
    });
  });
  rl.on('close', () => {
    chain.finally(() => process.exit(0));
  });
}
