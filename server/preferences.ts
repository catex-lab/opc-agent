/**
 * 界面偏好（主题 / 界面透明度 / 两侧栏宽 / 工作区开关 / 鼠标光斑 / 默认模型 /
 * 关闭窗口行为）。
 *
 * ## 为什么必须在服务端，不能只留 localStorage
 *
 * 打包态传的是 `PORT=0`（`electron/bootstrap.cjs`），系统每次分配一个空闲端口，
 * 页面地址是 `http://127.0.0.1:<端口>`（`electron/main.ts`）。**换端口就是换源，
 * localStorage 按源隔离** —— 用户把界面调成深色 + 透明度 60，下次打开全部回默认。
 * A131 实测本机 Chromium 里出现过 43 个端口源，`theme` 同时躺在其中 3 个源上。
 *
 * 与 `dismissed-directories.json` / `user-profile.json` 同一套路：这是**全局单例**
 * 小清单，不按会话、不按项目变，建表要迁移而这里不用。
 *
 * ## 为什么是「注入 HTML」而不是让前端 fetch
 *
 * 这些值必须在**首帧之前**就位（见 `src/uiPrefs.ts` 顶部注释）：透明度晚一帧，
 * 界面会先以实色画一遍再淡成玻璃；侧栏宽度晚一帧，列表栏会先按 264px 画再跳。
 * fetch 是异步的，来不及。所以 `server/index.ts` 在返回 index.html 时把整份偏好
 * 内联成 `window.__OPC_PREFS__`（见 `sendIndexHtml`），前端同步读。
 *
 * ## 为什么还写 localStorage
 *
 * 它是**镜像**，不是事实来源。留着有三个用处：① `npm run dev`（Vite 托管前端，
 * 拿不到注入）仍然能用；② 七条既有闸门断言的就是 localStorage 里的键，镜像让它们
 * 继续有效；③ 注入失败时还有一层兜底。读取顺序固定为 **注入 > localStorage > 默认**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDirPath } from './paths.js';
import { isCloseBehavior, type CloseBehavior } from '../shared/close-behavior.js';
import { isAnswerLanguage, type AnswerLanguage } from '../shared/answer-language.js';
import { isInterfaceLanguage, type InterfaceLanguage } from '../shared/interface-language.js';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface GlowPrefs {
  enabled: boolean;
  /** 直径 px；null = 跟随主题的 CSS 设计值 */
  size: number | null;
  /** 亮度倍率百分比；null = 1（设计值） */
  brightness: number | null;
}

/**
 * 只存**用户真的设过**的键。
 *
 * 缺键 = 没设过（前端回落到自己的默认），而不是「设成了 null」——
 * 两者在 UI 上不同：透明度没设过要显示默认 28，而不是显示 0。
 */
export interface Prefs {
  theme?: ThemePreference;
  transparency?: number;
  sidebarWidth?: number;
  workspaceWidth?: number;
  workspaceOpen?: boolean;
  /**
   * 左侧二级栏是否收起（导航条底部的折叠钮）。
   *
   * 只决定「二级栏在不在」，不动 56px 图标栏、不动标题栏。缺键 = 展开，
   * 与加这个开关之前逐像素一致。哪些页面上真的允许收起由前端按当前选中项
   * 判断（通讯录 / 项目 / 扩展没有选中项时，收起会把唯一的入口藏起来）。
   */
  sidebarCollapsed?: boolean;
  glow?: GlowPrefs;
  defaultModel?: string;
  /**
   * 关闭窗口的行为（A154）。
   *
   * 放在服务端而不是只在主进程存一份：设置页与主进程必须读同一个值，
   * 而主进程与 Express 就在同一个进程里（见 `electron/main.ts` 头注释），
   * `loadPrefs()` 读到的就是设置页刚 PATCH 进来的那份缓存。
   */
  closeBehavior?: CloseBehavior;
  /**
   * 正文外链的默认打开方式（A174）。
   *
   * `system` = 系统浏览器（主进程 `shell.openExternal`）；
   * `in-app` = 右侧工作区里的浏览标签页。缺键 = 没设过，前端回落到 `system`。
   */
  linkOpenMode?: LinkOpenMode;
  /**
   * 回答语言（A209）。
   *
   * 只决定 Agent 回答正文的语言，与界面文案无关；缺键 = `auto`
   * （不向模型注入任何指令，与加这个设置之前的行为逐字节一致）。
   * 判定与指令组装见 `server/answer-language.ts`。
   */
  answerLanguage?: AnswerLanguage;
  /**
   * 界面语言（i18n pilot）。
   *
   * `system` = 启动时按系统 locale 解析；`zh` / `en` = 用户显式固定。
   * 缺键等同 `system`。缺键与 `system` 在 UI 上都显示「跟随系统」，
   * 但缺键不会写文件，保持既有用户的 preferences.json 不变。
   */
  interfaceLanguage?: InterfaceLanguage;
}

export type LinkOpenMode = 'system' | 'in-app';

const isLinkOpenMode = (v: unknown): v is LinkOpenMode => v === 'system' || v === 'in-app';

/** `null` 在补丁里表示**清空这一项**（回到「没设过」），与 `undefined`（不动）不同 */
export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | null };

/**
 * 合法区间。**必须与 `src/uiPrefs.ts` 的同名常量一致** ——
 * 服务端是最后一道闸，前端滑块只是引导；两边分叉会出现「前端拖得动、后端 400」。
 */
export const PREFS_LIMITS = {
  transparency: [0, 100],
  sidebarWidth: [220, 460],
  workspaceWidth: [240, 560],
  glowSize: [200, 900],
  glowBrightness: [0, 200],
} as const;

const MAX_MODEL_ID_LEN = 200;

let cached: Prefs | null = null;

function filePath(): string {
  return path.join(dataDirPath, 'preferences.json');
}

const isIntIn = (v: unknown, [lo, hi]: readonly [number, number]): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= lo && v <= hi;

const isTheme = (v: unknown): v is ThemePreference =>
  v === 'system' || v === 'light' || v === 'dark';

/**
 * 把磁盘上读到的任意内容收敛成合法形状。
 *
 * 坏字段**一律当没设过**而不是抛错：这个文件是给人手改的，改坏一个字段
 * 不该让整个服务端起不来（同 `user-profile.ts` / `dismissed-dirs.ts`）。
 */
export function normalizePrefs(input: unknown): Prefs {
  const o = (input ?? {}) as Record<string, unknown>;
  const out: Prefs = {};
  if (isTheme(o.theme)) out.theme = o.theme;
  if (isIntIn(o.transparency, PREFS_LIMITS.transparency)) out.transparency = o.transparency;
  if (isIntIn(o.sidebarWidth, PREFS_LIMITS.sidebarWidth)) out.sidebarWidth = o.sidebarWidth;
  if (isIntIn(o.workspaceWidth, PREFS_LIMITS.workspaceWidth)) out.workspaceWidth = o.workspaceWidth;
  if (typeof o.workspaceOpen === 'boolean') out.workspaceOpen = o.workspaceOpen;
  if (typeof o.sidebarCollapsed === 'boolean') out.sidebarCollapsed = o.sidebarCollapsed;
  if (typeof o.defaultModel === 'string' && o.defaultModel.trim()) {
    out.defaultModel = o.defaultModel.trim().slice(0, MAX_MODEL_ID_LEN);
  }
  if (isCloseBehavior(o.closeBehavior)) out.closeBehavior = o.closeBehavior;
  if (isLinkOpenMode(o.linkOpenMode)) out.linkOpenMode = o.linkOpenMode;
  if (isAnswerLanguage(o.answerLanguage)) out.answerLanguage = o.answerLanguage;
  if (isInterfaceLanguage(o.interfaceLanguage)) out.interfaceLanguage = o.interfaceLanguage;
  const g = o.glow as Record<string, unknown> | undefined;
  if (g && typeof g === 'object') {
    const size = isIntIn(g.size, PREFS_LIMITS.glowSize) ? g.size : null;
    const brightness = isIntIn(g.brightness, PREFS_LIMITS.glowBrightness) ? g.brightness : null;
    out.glow = { enabled: g.enabled === true, size, brightness };
  }
  return out;
}

function readFromDisk(): Prefs {
  try {
    if (!existsSync(filePath())) return {};
    return normalizePrefs(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    return {};
  }
}

function persist(next: Prefs): void {
  cached = next;
  try {
    mkdirSync(dataDirPath, { recursive: true });
    writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    // 写不进去只影响「下次启动还认不认得」；本次进程内仍然生效
    console.warn('[Preferences] 写入失败（本次进程内仍生效）:', (e as Error).message);
  }
}

export function loadPrefs(): Prefs {
  if (!cached) cached = readFromDisk();
  return { ...cached };
}

export type PrefsValidation =
  | { ok: true; patch: PrefsPatch }
  /** `error` 直接回给前端（400），**不做静默纠正** —— 见 AGENTS.md 的会话设置四步 */
  | { ok: false; error: string };

/**
 * 严格校验一个补丁。
 *
 * 三条规矩：
 *   1. 未知字段 400（拼错 `sidebarWidht` 若被静默忽略，用户会以为「设了但没生效」）；
 *   2. 越界 400（不夹紧。夹紧等于替用户改值，而他看到的结果与自己拖的位置不一致）；
 *   3. 类型错 400（`"60"` 与 `60` 不接受互换 —— 前端只有一个写入口，写错就是 bug）。
 */
export function validatePrefsPatch(input: unknown): PrefsValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body 必须是一个对象' };
  }
  const o = input as Record<string, unknown>;
  const patch: PrefsPatch = {};

  for (const key of Object.keys(o)) {
    const v = o[key];
    switch (key) {
      case 'theme':
        if (v === null) patch.theme = null;
        else if (isTheme(v)) patch.theme = v;
        else return { ok: false, error: `theme 只能是 system / light / dark，收到 ${JSON.stringify(v)}` };
        break;
      case 'transparency':
        if (v === null) patch.transparency = null;
        else if (isIntIn(v, PREFS_LIMITS.transparency)) patch.transparency = v;
        else return { ok: false, error: `transparency 必须是 0–100 的整数，收到 ${JSON.stringify(v)}` };
        break;
      case 'sidebarWidth':
        if (v === null) patch.sidebarWidth = null;
        else if (isIntIn(v, PREFS_LIMITS.sidebarWidth)) patch.sidebarWidth = v;
        else return { ok: false, error: `sidebarWidth 必须是 220–460 的整数，收到 ${JSON.stringify(v)}` };
        break;
      case 'workspaceWidth':
        if (v === null) patch.workspaceWidth = null;
        else if (isIntIn(v, PREFS_LIMITS.workspaceWidth)) patch.workspaceWidth = v;
        else return { ok: false, error: `workspaceWidth 必须是 240–560 的整数，收到 ${JSON.stringify(v)}` };
        break;
      case 'workspaceOpen':
        if (v === null) patch.workspaceOpen = null;
        else if (typeof v === 'boolean') patch.workspaceOpen = v;
        else return { ok: false, error: `workspaceOpen 必须是布尔值，收到 ${JSON.stringify(v)}` };
        break;
      case 'sidebarCollapsed':
        if (v === null) patch.sidebarCollapsed = null;
        else if (typeof v === 'boolean') patch.sidebarCollapsed = v;
        else return { ok: false, error: `sidebarCollapsed 必须是布尔值，收到 ${JSON.stringify(v)}` };
        break;
      case 'defaultModel':
        if (v === null) patch.defaultModel = null;
        else if (typeof v === 'string' && v.trim() && v.length <= MAX_MODEL_ID_LEN) {
          patch.defaultModel = v.trim();
        } else return { ok: false, error: 'defaultModel 必须是非空字符串（≤200 字）' };
        break;
      case 'closeBehavior':
        if (v === null) patch.closeBehavior = null;
        else if (isCloseBehavior(v)) patch.closeBehavior = v;
        else {
          return {
            ok: false,
            error: `closeBehavior 只能是 quit / tray / ask，收到 ${JSON.stringify(v)}`,
          };
        }
        break;
      case 'linkOpenMode':
        if (v === null) patch.linkOpenMode = null;
        else if (isLinkOpenMode(v)) patch.linkOpenMode = v;
        else {
          return {
            ok: false,
            error: `linkOpenMode 只能是 system / in-app，收到 ${JSON.stringify(v)}`,
          };
        }
        break;
      case 'answerLanguage':
        if (v === null) patch.answerLanguage = null;
        else if (isAnswerLanguage(v)) patch.answerLanguage = v;
        else {
          return {
            ok: false,
            error: `answerLanguage 只能是 auto / zh / en，收到 ${JSON.stringify(v)}`,
          };
        }
        break;
      case 'interfaceLanguage':
        if (v === null) patch.interfaceLanguage = null;
        else if (isInterfaceLanguage(v)) patch.interfaceLanguage = v;
        else {
          return {
            ok: false,
            error: `interfaceLanguage 只能是 system / zh / en，收到 ${JSON.stringify(v)}`,
          };
        }
        break;
      case 'glow': {
        if (v === null) {
          patch.glow = null;
          break;
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          return { ok: false, error: 'glow 必须是对象或 null' };
        }
        const g = v as Record<string, unknown>;
        for (const gk of Object.keys(g)) {
          if (gk !== 'enabled' && gk !== 'size' && gk !== 'brightness') {
            return { ok: false, error: `glow 里没有字段 ${gk}` };
          }
        }
        if (typeof g.enabled !== 'boolean') {
          return { ok: false, error: 'glow.enabled 必须是布尔值' };
        }
        if (g.size !== null && !isIntIn(g.size, PREFS_LIMITS.glowSize)) {
          return { ok: false, error: `glow.size 必须是 200–900 的整数或 null` };
        }
        if (g.brightness !== null && !isIntIn(g.brightness, PREFS_LIMITS.glowBrightness)) {
          return { ok: false, error: `glow.brightness 必须是 0–200 的整数或 null` };
        }
        patch.glow = {
          enabled: g.enabled,
          size: (g.size as number | null) ?? null,
          brightness: (g.brightness as number | null) ?? null,
        };
        break;
      }
      default:
        return { ok: false, error: `未知字段 ${key}` };
    }
  }

  return { ok: true, patch };
}

/** 合并补丁并落盘。`null` = 清掉该项；`undefined` = 不动 */
export function savePrefs(patch: PrefsPatch): Prefs {
  const next: Prefs = { ...loadPrefs() };
  for (const key of Object.keys(patch) as (keyof Prefs)[]) {
    const v = patch[key];
    if (v === null) delete next[key];
    else if (v !== undefined) (next as Record<string, unknown>)[key] = v;
  }
  persist(next);
  return { ...next };
}

/**
 * 把偏好序列化成可安全内联进 `<script>` 的 JSON。
 *
 * `<` 必须转义：`defaultModel` 是用户可控字符串，含 `</script>` 就会提前
 * 结束脚本块，后面整段变成 HTML 文本。`JSON.stringify` 不会转义它。
 */
export function prefsAsInlineScript(): string {
  const json = JSON.stringify(loadPrefs()).replace(/</g, '\\u003c');
  return `window.__OPC_PREFS__=${json};`;
}

/** 只给闸门用：清掉进程内缓存，逼下一次读盘（模拟重启） */
export function resetPrefsCacheForTests(): void {
  cached = null;
}
