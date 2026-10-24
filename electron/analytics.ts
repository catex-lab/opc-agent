/**
 * 匿名使用统计（可选，默认在未配置端点时完全静默）
 *
 * 上报什么：
 *   - 一个随机生成的安装 ID（UUIDv4，首次启动写入 userData/analytics.json）
 *   - 每次启动的 session_id、启动时间、退出时的使用时长
 *   - 应用版本、操作系统、架构
 *
 * 绝不上报：聊天内容、文件路径、模型输出、Agent 凭据、任何可识别个人的信息。
 *
 * 三个开关（任一关掉即完全不上报）：
 *   1. TELEMETRY_ENDPOINT 为空 —— 默认状态，什么都不发
 *   2. 环境变量 OPC_TELEMETRY=0
 *   3. userData/analytics.json 里 "enabled": false
 *
 * 设计原则：上报失败永远不影响应用 —— 所有请求 3 秒超时、异常全吞。
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// ⚠️ 发布带统计的版本前，把这里改成 'https://github.com/catex-lab/opc-agent'（同域方案，Worker 挂在主域）。
// 留空则统计功能完全不启用：不建会话、不发任何请求，设置页会显示「此版本未配置统计端点」。
//
// 为什么默认留空而不是直接填死：Worker 未部署时填了地址，客户端每次启动都会发
// 三个注定失败的请求（各 3 秒超时）。虽然失败静默、不影响使用，但那是白烧的
// 网络与电量，而且会把「统计可用」这个状态说谎。
const TELEMETRY_ENDPOINT = process.env.OPC_TELEMETRY_URL || '';

/** 编译期/环境层面是否具备上报能力（端点为空的构建永远是关的） */
export function analyticsAvailable(): boolean {
  return TELEMETRY_ENDPOINT.length > 0 && process.env.OPC_TELEMETRY !== '0';
}

interface AnalyticsState {
  installId: string;
  enabled: boolean;
}

let state: AnalyticsState | null = null;
let sessionId = '';
let startedAt = 0;
let ended = false;

/** 当前是否真的在上报：端点存在 + 用户没关 */
function active(): boolean {
  return analyticsAvailable() && !!state?.enabled;
}

function statePath(): string {
  return join(app.getPath('userData'), 'analytics.json');
}

function loadState(): AnalyticsState | null {
  const file = statePath();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AnalyticsState>;
    if (raw && typeof raw.installId === 'string' && raw.installId.length >= 32) {
      return { installId: raw.installId, enabled: raw.enabled !== false };
    }
  } catch {
    // 首次启动或文件损坏，落到下面重建
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const fresh: AnalyticsState = { installId: randomUUID(), enabled: true };
    writeFileSync(file, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  } catch {
    return null;
  }
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function post(path: string, body: unknown, timeoutMs = 3000): Promise<void> {
  if (!active()) return Promise.resolve();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(TELEMETRY_ENDPOINT.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

/** 应用就绪后调用一次。任何异常都只打日志，不抛。 */
export function initAnalytics(): void {
  if (!analyticsAvailable()) return;
  try {
    state = loadState();
    if (!state || !state.enabled) return;

    sessionId = randomUUID();
    startedAt = Date.now();

    const common = {
      install_id: state.installId,
      app_version: app.getVersion(),
      os: process.platform,
      arch: process.arch,
    };

    // 先 upsert 设备（顺带刷新 last_seen），再开一个会话
    void post('/api/v1/install', common);
    void post('/api/v1/session/start', {
      ...common,
      session_id: sessionId,
      day: localDay(new Date()),
    });
  } catch (err) {
    console.error('[Analytics] 初始化失败:', (err as Error).message);
  }
}

/** 退出时调用。返回 Promise 以便主进程给它一个很短的等待窗口。 */
export function endAnalytics(): Promise<void> {
  if (!active() || !state || ended || !sessionId) return Promise.resolve();
  ended = true;
  const duration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return post('/api/v1/session/end', { session_id: sessionId, duration_sec: duration }, 1200);
}

/**
 * 设置页开关。关闭后立即停止上报：当前会话的收尾请求也不再发出。
 * 重新打开时，从下一次启动开始正常上报（不在会话中途补报，避免时长失真）。
 */
export function setAnalyticsEnabled(value: boolean): boolean {
  if (!state) state = loadState();
  if (!state) return false;
  state.enabled = value;
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[Analytics] 保存开关失败:', (err as Error).message);
    return false;
  }
  if (!value) ended = true;
  return true;
}

export interface AnalyticsStateView {
  /** 这个构建是否具备上报能力（端点为空的构建恒为 false） */
  available: boolean;
  /** 用户当前的开关状态 */
  enabled: boolean;
  /** 是否已经上报过（用于设置页显示"本次会话已记录"） */
  sessionActive: boolean;
}

export function getAnalyticsState(): AnalyticsStateView {
  if (!state) state = loadState();
  return {
    available: analyticsAvailable(),
    enabled: !!state?.enabled,
    sessionActive: active() && !!sessionId && !ended,
  };
}
