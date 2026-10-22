/**
 * P3：CDP 附着 —— 让「面板里的浏览器」变成 Agent 也能操作的同一个实例。
 *
 * ## 这条路在解决什么问题
 *
 * P1/P2 之后，用户在右侧面板里看到的是**自己**打开的页面：Agent 改完代码，
 * 刷新得人手点，截图也只能 Agent 自己另开一个浏览器去截 —— 人和机器看的
 * 根本不是同一份页面。
 *
 * 方案 A（`PLAN-WORKSPACE-PANEL.md` §3）：应用启动时带
 * `--remote-debugging-port`，把端点写进数据目录，Agent 侧用 Playwright
 * `connectOverCDP` 连**同一个**实例。于是「Agent 点哪、用户看哪」，截图与
 * 断言都作用在同一页面上。这是「人看」升级到「人机同屏」的分水岭。
 *
 * ## 端口怎么选：交给 Chromium，不自己猜
 *
 * 直觉做法是「在回环上占一个端口再放开，把端口号取回来」。那是**错的**：
 * 占端口是异步的，而 `appendSwitch` 必须在 app ready 之前同步完成 ——
 * 否则只能把端口选择挪到 ready 之后，那时开关已经失效。硬着头皮同步，
 * 就得到一段「用 Promise 冒充返回值」的代码，端口还可能是空的。
 *
 * 正确做法是 `--remote-debugging-port=0`：Chromium 自己选一个空闲端口，
 * 并把「端口 + ws 路径」写进 userData 下的 `DevToolsActivePort` 文件
 * （两行，第一行端口，第二行 `/devtools/browser/<uuid>`）。
 * 本机实测该文件确实生成（见 verify:a79-cdp）。我们只负责读它 ——
 * 不猜、不占、不撞。
 *
 * ## 三件必须做对的事
 *
 * 1. **只绑回环**。Chromium 现在默认就只绑 `127.0.0.1`，这里仍然显式
 *    `--remote-debugging-address=127.0.0.1`：安全默认值不该依赖
 *    「上游某天会不会改默认」。
 * 2. **端点要落地**。Agent 是外部 CLI 子进程，看不见我们的内存。所以除了
 *    把 ws 端点写进数据目录的 `cdp.json`，还塞进 `process.env` ——
 *    `CliAdapter.childEnv()` 是 `...process.env`，Agent 一 spawn 就继承到了。
 * 3. **区分「预览视图的目标」与「应用自己的窗口」**。调试端口是浏览器级的，
 *    `/json/list` 会把应用主窗口也列出来。把整个端点直接丢给 Agent，
 *    它下次就可能点到我们自己的 UI 上。所以这里按 URL 把主窗口排除掉，
 *    只把预览视图的 target 交出去。
 *
 * ## 已知代价（如实记，不美化）
 *
 * 端口常开意味着**本机任何进程都能驱动这个应用的所有页面**，包括应用自己的
 * 窗口 —— 那是 `--remote-debugging-port` 的语义，没法只开一半。接受它的理由：
 * 只绑回环、端口由系统随机分配、且这是「人机同屏」唯一便宜的实现。
 * 不需要时 `OPC_CDP=0` 关掉（冒烟脚本与讲究的用户都走这条）。
 */

import { app } from 'electron';
import { get } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 描述符文件名。放在数据目录里，与 chat.db 同级 —— 卸载/迁移时一起走。 */
export const CDP_FILE_NAME = 'cdp.json';

/** Chromium 自己写「实际端口 + ws 路径」的文件，位于 userData 根下。 */
const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort';

export interface CdpTargetInfo {
  id: string;
  /** 这个 target 自己的 ws 端点。Agent 直接连它，不必在 /json/list 里再认一次 */
  wsUrl: string;
  url: string;
  title: string;
  type: string;
}

export interface CdpDescriptor {
  /** false = 本次启动没开调试端口（OPC_CDP=0 或读取失败） */
  enabled: boolean;
  port: number | null;
  /** 浏览器级 ws 端点（`/json/version` 的 webSocketDebuggerUrl） */
  browserWs: string | null;
  /** 预览视图的 target。null = 视图还没建 / 还没导航 / 认不出来 */
  target: CdpTargetInfo | null;
  /** 应用自己的窗口 URL：列出来只是为了把它从 target 里排除 */
  appUrls: string[];
  pid: number;
  updatedAt: string;
}

let port: number | null = null;
let browserWsPath: string | null = null;
let appUrls: string[] = [];
let last: CdpDescriptor = disabledDescriptor();

function disabledDescriptor(): CdpDescriptor {
  return {
    enabled: false,
    port: null,
    browserWs: null,
    target: null,
    appUrls: [...appUrls],
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
}

/** 本次启动是否开了调试端口（开关层面的答案，不保证端点已解析出来）。 */
export function isCdpEnabled(): boolean {
  return port !== null;
}

/**
 * 追加调试端口开关。**必须在 app ready 之前调用**（Chromium 初始化之后改不了）。
 *
 * `OPC_CDP=0` 是唯一开关：冒烟测试、以及不想把端口开着的用户都走它。
 * 做成环境变量而不是设置项，是因为设置项要有 UI、要持久化、要向用户解释
 * —— 而真正需要它的是脚本（每个 Electron 冒烟都该显式关掉，免得并行跑时
 * 互相干扰）。端口本身由 Chromium 随机分配，不存在「脚本之间抢同一个端口」。
 */
export function enableCdp(): void {
  if (process.env.OPC_CDP === '0') {
    console.log('[CDP] OPC_CDP=0 —— 不开放远程调试端口（人机同屏不可用）');
    last = disabledDescriptor();
    return;
  }
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  // 显式绑回环。Chromium 现在默认就是回环，但不该把安全默认值寄托在
  // 「上游某天不会改默认」上。
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  console.log('[CDP] 已申请远程调试端口（端口由 Chromium 分配，见 DevToolsActivePort）');
}

/**
 * 读回 Chromium 实际选中的端口。**ready 之后调用**。
 *
 * 文件由浏览器进程启动时写，可能比 ready 晚一点，所以给几次重试。
 * 返回 null = 没开（或没读到）—— 调用方照常用面板，只是 Agent 连不上。
 */
export async function initCdpEndpoint(): Promise<boolean> {
  if (process.env.OPC_CDP === '0') {
    last = disabledDescriptor();
    return false;
  }
  const file = path.join(app.getPath('userData'), DEVTOOLS_ACTIVE_PORT);
  for (let i = 0; i < 20; i++) {
    const parsed = readActivePort(file);
    if (parsed) {
      port = parsed.port;
      browserWsPath = parsed.wsPath;
      console.log(`[CDP] 远程调试端点 127.0.0.1:${port}${parsed.wsPath}`);
      return true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.warn('[CDP] 没读到 DevToolsActivePort —— 本次人机同屏不可用（面板仍可正常预览）');
  last = disabledDescriptor();
  return false;
}

function readActivePort(file: string): { port: number; wsPath: string } | null {
  try {
    const text = readFileSync(file, 'utf8');
    const [portLine, wsLine] = text.split(/\r?\n/);
    const p = Number((portLine ?? '').trim());
    if (!Number.isInteger(p) || p <= 0) return null;
    const wsPath = (wsLine ?? '').trim() || '/devtools/browser/';
    return { port: p, wsPath: wsPath.startsWith('/') ? wsPath : `/${wsPath}` };
  } catch {
    return null;
  }
}

/** 记下应用自己的窗口 URL，供 target 解析时排除。 */
export function setCdpAppUrls(urls: string[]): void {
  appUrls = urls.filter(u => typeof u === 'string' && !!u);
  last.appUrls = [...appUrls];
}

/** 描述符落地路径（数据目录，与 chat.db 同级）。 */
export function cdpDescriptorPath(): string {
  const dir = process.env.OPC_DATA_DIR || app.getPath('userData');
  return path.join(dir, CDP_FILE_NAME);
}

/**
 * 读回描述符。
 *
 * 服务端路由用它：`server/**` 不能 import electron（浏览器开发态服务跑在
 * 纯 Node 里，import electron 会直接炸），所以那边只能读文件。
 */
export function readCdpDescriptor(): CdpDescriptor | null {
  try {
    return JSON.parse(readFileSync(cdpDescriptorPath(), 'utf8')) as CdpDescriptor;
  } catch {
    return null;
  }
}

function writeCdpDescriptor(d: CdpDescriptor): void {
  try {
    mkdirSync(path.dirname(cdpDescriptorPath()), { recursive: true });
    writeFileSync(cdpDescriptorPath(), JSON.stringify(d, null, 2));
  } catch (e) {
    // 写不进去不影响功能，只是 Agent 发现不到端点
    console.warn('[CDP] 描述符写入失败:', e instanceof Error ? e.message : e);
  }
}

function httpGetJson<T>(urlPath: string): Promise<T | null> {
  return new Promise(resolve => {
    if (!port) return resolve(null);
    const req = get(
      { host: '127.0.0.1', port, path: urlPath, timeout: 1500 },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 最近一次已知的描述符（含上次解析成功的 target）。 */
export function currentCdpDescriptor(): CdpDescriptor {
  return last;
}

/**
 * 重新解析 target 并落地描述符。在视图创建与每次导航后调用。
 *
 * 失败时保留上一次的结果 —— 一次网络抖动不该让已经拿到 target 的 Agent
 * 突然发现端点没了。
 *
 * @param viewUrl 预览视图当前的 URL。空 / about:blank = 还没导航。
 */
export async function refreshCdpDescriptor(viewUrl: string): Promise<CdpDescriptor> {
  if (port === null) {
    last = disabledDescriptor();
    writeCdpDescriptor(last);
    return last;
  }

  const version = await httpGetJson<{ webSocketDebuggerUrl?: string }>('/json/version');
  const list = await httpGetJson<Array<Record<string, string>>>('/json/list');
  const pages = (Array.isArray(list) ? list : []).filter(t => t && t.type === 'page');

  // ① 先按 URL 精确匹配：视图导航过，这一步就能定下来
  let match =
    viewUrl && viewUrl !== 'about:blank'
      ? pages.find(t => t.url === viewUrl)
      : undefined;

  // ② 没匹配上（about:blank 或刚建出来）就把应用自己的窗口剔掉，
  //    剩下唯一一个 page 就是预览视图 —— DevTools 分离窗口此时没开，
  //    集合很小，这个推断是稳的。多于一个就宁可交出去 null：认错 target
  //    比没有 target 危险得多（那等于让 Agent 去点应用自己的界面）。
  if (!match) {
    const rest = pages.filter(t => !appUrls.some(u => !!u && t.url === u));
    if (rest.length === 1) match = rest[0];
  }

  const next: CdpDescriptor = {
    enabled: true,
    port,
    browserWs: version?.webSocketDebuggerUrl ?? null,
    target: match
      ? {
          id: match.id,
          wsUrl: match.webSocketDebuggerUrl,
          url: match.url,
          title: match.title ?? '',
          type: match.type,
        }
      : null,
    appUrls: [...appUrls],
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  last = next;
  writeCdpDescriptor(next);

  // Agent 是外部 CLI 子进程，靠继承环境变量发现端点（childEnv 是 ...process.env）
  process.env.OPC_CDP_ENDPOINT = `http://127.0.0.1:${port}`;
  if (next.target) process.env.OPC_CDP_TARGET = next.target.wsUrl;
  else delete process.env.OPC_CDP_TARGET;
  return next;
}
