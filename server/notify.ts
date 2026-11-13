/**
 * 权限远程审批的通知渠道（A228）。
 *
 * ## 它解决什么问题
 *
 * 权限门是「人在电脑前」的设计：越权请求弹审批浮层，等人点。但 Agent 跑
 * 长任务时人恰恰不在电脑前——手机上看不到请求，任务就永远挂在那里。
 * 这里把待审批的请求**外发**成 IM 卡片，带「放行 / 拒绝」的一次性链接；
 * 人在手机上点一下，请求就地兑现。
 *
 * ## 边界（写死，与 local-first 的约定一致）
 *
 * - **不做官方云端中继**。通知发到用户自配的 webhook（企业 IM 群机器人 /
 *   自建服务）；审批链接的地址由「外部可达地址」设置决定——默认本机
 *   局域网 IP，进阶用户可配自己的反向代理。应用不做任何内网穿透。
 * - **卡片只带摘要**：Agent 名、工具名、输入摘要（截断）。密钥、完整
 *   diff、文件内容一律不上卡——IM 服务商看得见卡片全文。
 * - **一次性 token**：每个请求一枚，用后即焚；审批走 GET（IM 卡片里
 *   能点的只有链接），token 短随机且不重复使用。
 * - **本地界面优先**：通知只是旁路。同一条请求在应用内的审批浮层照常
 *   出现，谁先答复算谁的（`resolvePermissionAnywhere` 天然幂等：后来者 404）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import { dataDirPath } from './paths.js';

export type NotifyChannelKind = 'lark' | 'wecom' | 'dingtalk' | 'generic';

export interface NotifyConfig {
  /** webhook 完整地址（各 IM 群机器人的 webhook URL） */
  url: string;
  kind: NotifyChannelKind;
  enabled: boolean;
  /**
   * 审批链接的对外地址（不含路径）。空 = 用本机局域网 IP 自动推导。
   * 配了反向代理的用户填自己的地址，例如 `https://opc.example.com`。
   */
  externalBaseUrl?: string;
}

const STORE_PATH = path.join(dataDirPath, 'notify-channels.json');

const DEFAULT_CONFIG: NotifyConfig = { url: '', kind: 'lark', enabled: false };

export function loadNotifyConfig(): NotifyConfig {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotifyConfig>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      kind: isNotifyKind(parsed.kind) ? parsed.kind : 'lark',
      enabled: parsed.enabled === true,
      ...(typeof parsed.externalBaseUrl === 'string' && parsed.externalBaseUrl.trim()
        ? { externalBaseUrl: parsed.externalBaseUrl.trim() }
        : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveNotifyConfig(config: NotifyConfig): void {
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function isNotifyKind(v: unknown): v is NotifyChannelKind {
  return v === 'lark' || v === 'wecom' || v === 'dingtalk' || v === 'generic';
}

/** URL 是否合法且指向 http(s)。校验在保存边界做，发通知时信任配置 */
export function validateNotifyUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'webhook 地址只支持 http / https';
    if (!u.hostname) return 'webhook 地址缺少主机名';
    return null;
  } catch {
    return 'webhook 地址不是合法 URL';
  }
}

/** 本机局域网 IPv4（审批链接的默认基址）。取不到 = 只能靠 externalBaseUrl */
export function lanAddress(): string | null {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

// ════════ 一次性审批 token ════════

interface PendingToken {
  requestId: string;
  decision: 'allow' | 'deny';
  createdAt: number;
}

const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 256;
const tokens = new Map<string, PendingToken>();

/** 答复一条远程审批。返回 null = token 无效 / 过期 / 已用 */
export function consumeRemoteToken(token: string): PendingToken | null {
  const t = tokens.get(token);
  if (!t) return null;
  tokens.delete(token);
  if (Date.now() - t.createdAt > TOKEN_TTL_MS) return null;
  return t;
}

function mintToken(requestId: string, decision: 'allow' | 'deny'): string {
  while (tokens.size >= MAX_TOKENS) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
  const token = randomBytes(16).toString('hex');
  tokens.set(token, { requestId, decision, createdAt: Date.now() });
  return token;
}

/** 审批链接的对外基址：外部配置优先，否则本机局域网 IP */
export function approvalBaseOf(config: NotifyConfig, port: number): string | null {
  if (config.externalBaseUrl) return config.externalBaseUrl.replace(/\/+$/, '');
  const lan = lanAddress();
  return lan ? `http://${lan}:${port}` : null;
}

// ════════ 外发 ════════

export interface RemoteApprovalPayload {
  requestId: string;
  agentId: string;
  agentName: string;
  toolName: string;
  sessionId: string;
  /** 工具输入摘要（调用方已截断 / 已扫敏感） */
  inputSummary: string;
  expiresAt?: number;
}

/** POST JSON，10s 超时。失败只记日志——通知是旁路，不能拖垮权限链 */
function postJson(url: string, body: unknown): Promise<void> {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const mod = url.startsWith('https') ? httpsRequest : httpRequest;
    try {
      const req = mod(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 10_000,
        },
        res => {
          res.resume();
          res.on('end', () => resolve());
          res.on('error', () => resolve());
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => resolve());
      req.end(data);
    } catch {
      resolve();
    }
  });
}

/** 卡片正文。按渠道给各自的消息壳，内容一致：谁、要对什么授权、链接 */
function cardText(p: RemoteApprovalPayload, allowUrl: string, denyUrl: string): string {
  const lines = [
    `【OPC Agent 审批请求】${p.agentName} 想执行 ${p.toolName}`,
    p.inputSummary ? `输入：${p.inputSummary}` : '',
    '',
    `✅ 放行：${allowUrl}`,
    `⛔ 拒绝：${denyUrl}`,
    '（链接一次性有效；本机应用内的审批浮层同样可以答复）',
  ];
  return lines.filter(Boolean).join('\n');
}

function wrapForKind(kind: NotifyChannelKind, text: string): unknown {
  switch (kind) {
    case 'lark':
      return { msg_type: 'text', content: { text } };
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: text } };
    case 'dingtalk':
      return { msgtype: 'markdown', markdown: { title: 'OPC Agent 审批请求', text } };
    case 'generic':
    default:
      return { event: 'permission_request', text };
  }
}

/** 外发一条审批请求。config 未启用 / 无 url = 静默跳过 */
export async function notifyPermissionRequest(
  payload: RemoteApprovalPayload,
  config: NotifyConfig,
  port: number
): Promise<void> {
  if (!config.enabled || !config.url) return;
  const base = approvalBaseOf(config, port);
  if (!base) {
    console.warn('[Notify] 找不到本机局域网地址，且未配置外部可达地址——审批链接发不出去，跳过本次通知');
    return;
  }
  const allowUrl = `${base}/api/remote-approve/${mintToken(payload.requestId, 'allow')}`;
  const denyUrl = `${base}/api/remote-approve/${mintToken(payload.requestId, 'deny')}`;
  const text = cardText(payload, allowUrl, denyUrl);
  await postJson(config.url, wrapForKind(config.kind, text));
}

/** 设置页「发送测试」：验证地址可达、消息能进群 */
export async function notifyTest(config: NotifyConfig): Promise<{ ok: boolean; message: string }> {
  const err = validateNotifyUrl(config.url);
  if (err) return { ok: false, message: err };
  const probe: NotifyConfig = { ...config, enabled: true };
  const base = approvalBaseOf(probe, 0) ?? '（无法推导）';
  const text = `【OPC Agent】这是一条测试通知。远程审批通道已打通；审批链接形如 ${base}/api/remote-approve/…`;
  await postJson(config.url, wrapForKind(probe.kind, text));
  // HTTP 侧失败被吞成 resolve()——测试语义上如实说「已发出，是否进群看聊天窗口」
  return { ok: true, message: '已发送：请到对应的聊天窗口确认是否收到' };
}
