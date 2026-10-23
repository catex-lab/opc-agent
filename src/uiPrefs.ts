/**
 * 界面外观偏好 —— 「界面透明度」与「左侧栏宽度」。
 *
 * ## 为什么单独一个模块，而不是塞进某个组件
 *
 * 这两个值都必须在**首帧之前**就位：
 *   · 透明度晚一帧 → 界面先以实色画出来，再淡成玻璃，启动时闪一下；
 *   · 侧栏宽度晚一帧 → 列表栏先按默认 264px 画，再跳到用户拖出来的宽度。
 * 所以它们由 `main.tsx` 在 `createRoot` 之前调用，直接写到 <html> 的内联样式上，
 * 组件只负责**修改**（滑动条 / 拖拽手柄），不负责初始化。
 *
 * ## 为什么写到 <html> 的内联样式而不是某个 React state
 *
 * 消费这些值的是 CSS（`--tc-surface-chrome` 等令牌），不是 React。
 * 走 state 会多一层「渲染 → effect → 改 CSS 变量」的延迟，滑动条拖动时
 * 能看出滞后；直接 `style.setProperty` 是同步的，拖动跟手。
 * 代价是 React 不知道当前值 —— 所以设置页自己保存一份 state 用于显示数字，
 * 初始值从 `readTransparency()` 读，两边不会分叉（都从 localStorage 来）。
 */

const TRANSPARENCY_KEY = 'opc.transparency';
const SIDEBAR_KEY = 'opc.sidebar-width';

/**
 * 界面透明度（百分比）。0 = 全不透明，100 = 只剩系统毛玻璃。数字越大越透。
 *
 * ## 为什么是 0–100，而不是 A23 的 0–45
 *
 * 上限 45 是**被系统按钮逼出来的**：那时三个窗口按钮由 Windows 画，
 * 控件区那块底色永远是实色（系统侧背板 ≈240，页面侧 ≈226，除 alpha=1
 * 之外无解），所以标题条只能不透明 —— 再往上拉，标题条与下面几栏的
 * 差距会越来越刺眼，45 是「标题条还不算突兀」的极限。
 *
 * A24 把三个按钮改成自绘（`frame: false`）之后，整窗每一块都由页面画，
 * 这个上限就没有理由了：0 到 100 是一条真正的直线。
 *
 * ## 100 是什么样子
 *
 * 不是「窗口消失」。窗口底下那层 `backgroundMaterial: 'acrylic'` 由系统画，
 * 页面全透明之后透出来的是**被模糊过的桌面**（一块纯磨砂玻璃），
 * 文字仍然压在上面、仍然可读。所以 100 是「纯玻璃」，不是「看不见」。
 */
export const TRANSPARENCY_MIN = 0;
export const TRANSPARENCY_MAX = 100;

/**
 * 默认值 28：此时框架面 alpha = 1 − 0.28 = 0.72，内容面 0.821，
 * 正是此前手工调出来的那组数值。滑动条上的「默认」刻度就钉在这里。
 */
export const TRANSPARENCY_DEFAULT = 28;

/**
 * 内容面比框架面实一档（×1.14 = 默认档 0.72 → 0.821）。
 *
 * 为什么用**比例**而不是「加 0.10 个 alpha 点」：加法在 t=100 时会留下
 * 0.10 的余量，内容面永远透不干净，滑动条就变成「0–100 但拉到底还剩一层」。
 * 乘法天然满足两个端点（t=0 → 1.0，t=100 → 0），中间只是把差距按比例收窄。
 * 消息区是长时间阅读的地方，比框架面实一档这个关系在整条区间上都成立。
 */
const CONTENT_ALPHA_RATIO = 1.14;

/**
 * 抬升面（消息气泡 / 输入框 / 卡片 / 弹窗）再实一档：×1.22
 * （默认档 0.72 → 0.878）。
 *
 * ## A25：抬升面从「永远实色」改成「一起变」
 *
 * 在此之前 `--tc-surface-raised` 在玻璃态下是**唯一不参与**的表面 ——
 * 理由是「压在内容上的小面，透明了读不清」。用户的反馈推翻了这条：
 * 毛玻璃应该是全局的，气泡、卡片、弹窗自己还是实色，就等于玻璃上贴了一堆
 * 白色纸片，越调越明显。
 *
 * 现在它跟着同一个数字走，但**保持最高的一档**：它是三层里最靠前的一层，
 * 必须比内容面实，否则卡片会「陷」进消息区、失去层级。
 *
 * 读数清晰靠的不是不透明，而是底下垫的那层中性 veil（见 index.css 的
 * `--tc-veil`）。**不要指望 `backdrop-filter`** —— A27 实测它在透明窗口里
 * 不可靠（可能整块空转），而且 blur 只降细节、不降对比度。气泡之所以能透到
 * 0.65 就够，是因为它下面垫的是窗口 acrylic，不是另一层字。
 */
const RAISED_ALPHA_RATIO = 1.22;

/**
 * 用户气泡的不透明度**下限** 0.65。
 *
 * 这是唯一一个「不跟着归零」的表面，理由是可读性而不是美观：
 * 用户气泡是品牌色实心 + 白字（深色主题反过来是浅灰底 + 深字），
 * 它没有「底色」可以退让 —— alpha 一旦掉到 0.5 以下，白字就直接压在
 * 透出来的桌面上：浅色主题的深色气泡合成到 #848484，正文对比度只有
 * 3.6:1，低于 4.5:1 的正文线。
 *
 * 0.65 的实测合成色约 #6D6D6D，对比度 5.1:1，仍在可读区间；
 * 同时它从 1.0 降到 0.65，肉眼看得出「变透了」，不是完全不动。
 *
 * 换句话说：**界面可以彻底透明，自己说的话不行** —— 那是内容，
 * 不是装饰层。
 */
const BUBBLE_ALPHA_FLOOR = 0.65;

/**
 * 浮层（弹窗 / 悬浮名片 / 右键菜单 / 下拉 / 滑出面板）的 alpha 下限。
 *
 * ## 为什么浮层必须有下限，而气泡可以更透
 *
 * 气泡下面垫的是**窗口**：系统 acrylic 已经把那层桌面模糊过一遍，透出来的
 * 是色块，不会是字。浮层下面垫的是**内容**：消息正文、联系人名字、列表行。
 * 一旦浮层的 alpha 跟着滑动条掉到 0，两层字会直接叠在一起 —— 用户的原话是
 * 「弹窗页面杂乱」。
 *
 * ## 为什么是 0.9，而不是「跟内容面同档」的 0.82
 *
 * 原来 `--opc-glass-alpha` 直接取内容面（t=100 时是 0），理由是「浮层压的
 * 就是内容面，比内容面还透会读不清」。方向是对的，但**下限给错了**：
 * 0.82 只是「比内容面实一点」，并不是「字不会穿过来」。
 *
 * 按合成公式算一下（浅色，浮层白 255、下层正文 #1f1f1f）：
 *   α = 0.82 → 穿透后的字 ≈ rgb(214) → 与白底对比 1.42:1，仍能读出一层灰影
 *   α = 0.90 → rgb(233) → 1.23:1，只剩极淡的影
 *   α = 0.94 → rgb(242) → 1.14:1，基本看不出
 * 深色主题同一档更差（浮层 #262626 与正文 #e5e5e5 的亮度差更小），
 * 所以下限取 0.9 而不是 0.82 —— 两套主题在这一档都落在 1.3:1 以内。
 *
 * ## 为什么不是 1.0
 *
 * 浮层仍然是「玻璃」：0.9 时背后的色块还看得见一点轮廓，位置感还在
 * （知道弹窗是从哪儿弹出来的），但已经读不出字。完全实心会丢掉这层
 * 空间关系，而且和「全局毛玻璃」的设定冲突。
 *
 * ## 与滑块的关系
 *
 * `overlay = max(0.9, content)`：t=0 时 content = 1，浮层跟着 1.0（全不透明
 * 模式不该有任何穿透）；content 掉到 0.9 以下之后浮层就钉住不动了。
 * 也就是说**浮层只在「不透明 → 半透明」这段跟着走，进入玻璃态之后不再变**。
 * 这是有意的：滑动条承诺的是「看到多少桌面」，而浮层从来就不透桌面。
 */
const OVERLAY_ALPHA_FLOOR = 0.9;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function readTransparency(): number {
  // ⚠️ 不能写成 `Number(localStorage.getItem(...))`：没存过时 getItem 返回
  //    null，Number(null) === 0，与「用户真的把滑动条拖到 0」撞在一起，
  //    于是默认值会被读成 0（界面全不透明）。
  const raw = localStorage.getItem(TRANSPARENCY_KEY);
  if (raw === null) return TRANSPARENCY_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TRANSPARENCY_DEFAULT;
  return clamp(n, TRANSPARENCY_MIN, TRANSPARENCY_MAX);
}

/**
 * 把透明度写进 CSS 变量。四个 alpha 一起变，不是只变一个 ——
 * 用户要的是「统一管理」：标题条、导航条、列表栏、内容区、消息气泡、
 * 输入框、卡片、弹窗，都由同一个数字推导出来。
 *
 * 四档的先后关系（浅色下 alpha 越大越实）：
 *     chrome  1 − t/100        框架面：导航条 / 列表栏 / 标题条
 *     content chrome × 1.14    内容面：聊天区、设置页
 *     raised  chrome × 1.22    抬升面：气泡 / 输入框 / 卡片
 *     overlay max(0.9, content) 浮层：弹窗 / 悬浮名片 / 右键菜单 / 下拉 / 滑出面板
 * t = 0 时四者都是 1（全不透明）；t = 100 时前三者是 0，浮层停在 0.9。
 */
export function applyTransparency(transparency: number) {
  const t = clamp(transparency, TRANSPARENCY_MIN, TRANSPARENCY_MAX);
  const chrome = 1 - t / 100;
  const content = Math.min(1, chrome * CONTENT_ALPHA_RATIO);
  const raised = Math.min(1, chrome * RAISED_ALPHA_RATIO);
  // 用户气泡：跟大流一起变透，但不低于 0.65（见 BUBBLE_ALPHA_FLOOR）
  const bubble = Math.max(BUBBLE_ALPHA_FLOOR, raised);
  // 浮层：跟到 0.9 为止（见 OVERLAY_ALPHA_FLOOR）
  const overlay = Math.max(OVERLAY_ALPHA_FLOOR, content);
  const root = document.documentElement;
  // 保留三位小数：0.72 / 0.821 这类值在计算样式里会原样显示成 rgba(..., 0.72)
  root.style.setProperty('--opc-chrome-alpha', chrome.toFixed(3));
  root.style.setProperty('--opc-content-alpha', content.toFixed(3));
  root.style.setProperty('--opc-raised-alpha', raised.toFixed(3));
  root.style.setProperty('--opc-bubble-alpha', bubble.toFixed(3));
  /**
   * 浮层单独一档，**不再等于内容面**。
   *
   * A26 之前这里是 `content`，于是 t=100 时浮层和内容面一起归零，弹窗变成
   * 一块纯 `backdrop-filter` 的玻璃纸 —— 背后的字整片穿上来。A27 把它拆成
   * 独立的下限（见 OVERLAY_ALPHA_FLOOR）。这也是「界面可以彻底透明，
   * 压在内容之上的东西不行」这条原则的第三个落点（前两个是用户气泡
   * 的 0.65 和主按钮的 0.72）。
   */
  root.style.setProperty('--opc-overlay-alpha', overlay.toFixed(3));
  /**
   * ## A26：还有一组令牌**故意不在这里算**
   *
   * 表面协调性那套（`--opc-t` / `--tc-split` / `--tc-hairline` /
   * `--tc-veil` / `--tc-solid` / `--tc-halo`）全部由 CSS 里的 `calc()`
   * 从 `--opc-chrome-alpha` 推导，见 `index.css` 的玻璃态令牌段。
   *
   * 为什么不在这里多写五个 `setProperty`：
   *   1. 它们只被 CSS 消费，JS 这边没有任何逻辑要读，多算一遍等于
   *      把同一份公式抄两处，改一处忘一处就会分叉；
   *   2. `calc()` 在浏览器内部是按需求值的，拖动滑动条时只重算样式，
   *      不需要每帧回写五个字符串。
   *
   * 也就是说：**JS 只负责「有多透」，CSS 负责「透成什么样」**。
   * 上面四个 alpha 是「面」，下面是「线和块」—— 面的值必须由 JS 写，
   * 因为它是用户的输入；线的值可以由面推出来，就该让 CSS 推。
   */
}

export function saveTransparency(transparency: number) {
  const t = clamp(Math.round(transparency), TRANSPARENCY_MIN, TRANSPARENCY_MAX);
  localStorage.setItem(TRANSPARENCY_KEY, String(t));
  applyTransparency(t);
  return t;
}

/* ── 左侧二栏宽度 ─────────────────────────────────────────────────────
 *
 * 下限 220：再窄「WorkBuddy · 昨天」这种两行行标题就折行了；
 * 上限 460：宽屏下把列表拖过 460 会挤掉群成员栏（236）和消息区。
 */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 460;

export function readSidebarWidth(): number | null {
  const raw = localStorage.getItem(SIDEBAR_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clamp(n, SIDEBAR_MIN, SIDEBAR_MAX);
}

export function applySidebarWidth(width: number) {
  document.documentElement.style.setProperty(
    '--tc-sidebar-width',
    `${Math.round(clamp(width, SIDEBAR_MIN, SIDEBAR_MAX))}px`
  );
}

export function saveSidebarWidth(width: number) {
  const w = Math.round(clamp(width, SIDEBAR_MIN, SIDEBAR_MAX));
  localStorage.setItem(SIDEBAR_KEY, String(w));
  applySidebarWidth(w);
  return w;
}

/* ── 右侧工作区面板宽度（A82）──────────────────────────────────
 *
 * 与左侧二栏宽度的区别只有一件事：**方向反的**。面板在右边，所以往左拖是变宽
 * （`next = start - dx`），左侧栏是往右拖变宽（`next = start + dx`）。
 * 数值区间反过来推导：下限 240 再窄，文件树的行高加上「工作区 / 目录名 /
 * 标签 / 关闭」这一行就折行了；上限 560 是宽屏上还不至于把消息区挤到
 * 难以阅读的程度（1280 宽的窗口去掉二栏 264 后只剩 456）。
 */
export const WORKSPACE_MIN = 240;
export const WORKSPACE_MAX = 560;
export const WORKSPACE_DEFAULT = 300;

const WORKSPACE_KEY = 'opc.workspace-width';

export function readWorkspaceWidth(): number | null {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clamp(n, WORKSPACE_MIN, WORKSPACE_MAX);
}

export function applyWorkspaceWidth(width: number) {
  document.documentElement.style.setProperty(
    '--tc-workspace-width',
    `${Math.round(clamp(width, WORKSPACE_MIN, WORKSPACE_MAX))}px`
  );
}

export function saveWorkspaceWidth(width: number) {
  const w = Math.round(clamp(width, WORKSPACE_MIN, WORKSPACE_MAX));
  localStorage.setItem(WORKSPACE_KEY, String(w));
  applyWorkspaceWidth(w);
  return w;
}

/** 当前生效的工作区面板宽度（px）。手柄读它当拖动起点。 */
export function currentWorkspaceWidth(): number {
  const inline = document.documentElement.style.getPropertyValue('--tc-workspace-width');
  const fromInline = parseFloat(inline);
  if (Number.isFinite(fromInline) && fromInline > 0) return fromInline;
  return WORKSPACE_DEFAULT;
}

/**
 * 启动时一次性就位（main.tsx 在首帧前调用）
 */
export function applyUiPrefs() {
  applyTransparency(readTransparency());
  const w = readSidebarWidth();
  if (w !== null) applySidebarWidth(w);
  const ws = readWorkspaceWidth();
  if (ws !== null) applyWorkspaceWidth(ws);
  applyGlow(readGlow());
}

/* ── 鼠标光斑（A28）──────────────────────────────────────────────
 *
 * 光斑本身在 A25 就有了（见 index.css 的 `.tc-cursor-glow`）。
 * 那之后它一直是**写死的三件套**：440px / .1 白 / brightness(1.12)。
 * 用户提出两件事：有人就是不喜欢鼠标后面跟一个亮斑（尤其录屏时），
 * 有人想让它更大更亮。所以这里补上开关与两档调节。
 *
 * ## 为什么「未设置过」要用 null 表示，而不是给一个默认数字
 *
 * 光斑大小在 CSS 里是**两套设计值**（浅色 440px、深色 380px ——
 * 深色玻璃更暗，光斑要小一点才不糊）。如果 JS 那边也给一个默认 440，
 * 一旦把值写进 `<html>` 内联样式，深色主题的设计值就被永久覆盖了。
 *
 * 所以 `size === null` 表示「没动过，继续用 CSS 的」；只有用户真的拖过
 * 滑动条，才写入内联值、才开始覆盖主题。亮度同理（倍率 1 = 设计值）。
 *
 * ## 亮度为什么是倍率，而不是绝对 brightness
 *
 * 两套主题的基准亮度不同（1.12 vs 1.38）。绝对值得再记一份主题常量，
 * 切换主题时还要重算；倍率让 CSS 的 calc() 去乘，JS 只管「几倍」，
 * 与「JS 只负责输入，CSS 负责推导」的分工一致（见 applyTransparency 的注释）。
 */
const GLOW_KEY = 'opc.glow';

export const GLOW_SIZE_MIN = 200;
export const GLOW_SIZE_MAX = 900;
/** 亮度倍率的百分比表示：100 = 设计值，0 = 不提亮，200 = 两倍 */
export const GLOW_BRIGHT_MIN = 0;
export const GLOW_BRIGHT_MAX = 200;
export const GLOW_BRIGHT_DEFAULT = 100;

export interface GlowPrefs {
  /** false = 完全关闭光斑 */
  enabled: boolean;
  /** 直径 px；null = 跟随主题的 CSS 设计值 */
  size: number | null;
  /** 亮度倍率百分比；null = 1（设计值） */
  brightness: number | null;
}

/**
 * 从未设置过时的默认。
 *
 * **A66：默认关闭**（用户要求：「将鼠标光斑默认状态设置为关闭，如果用户需要打开，
 * 让用户自己在设置里去打开」）。
 *
 * 为什么这条默认值该是「关」而不是「开」：
 * - 光斑是**纯装饰层**，不承载任何信息。默认开着，等于替用户做了「我要这层效果」
 *   的决定，而它恰恰是最容易被注意到、也最容易碍事的一层（录屏、演示、截图、
 *   觉得晃眼）。反过来的代价只是「想要的人多点一下开关」。
 * - 它是**全屏跟随鼠标的高频视觉层**，默认关掉还能顺带省掉玻璃模式下每帧的
 *   backdrop-filter 合成。
 *
 * `size` / `brightness` 仍是 `null`（跟随主题 CSS 设计值）—— 与开关是两件事：
 * 关掉光斑不该顺手把用户调好的尺寸清掉，下次打开还是他上次的尺寸。
 */
export function defaultGlow(): GlowPrefs {
  return { enabled: false, size: null, brightness: null };
}

export function readGlow(): GlowPrefs {
  try {
    const raw = localStorage.getItem(GLOW_KEY);
    if (!raw) return defaultGlow();
    const o = JSON.parse(raw) as Partial<GlowPrefs>;
    const size = o.size == null ? null : clamp(Number(o.size), GLOW_SIZE_MIN, GLOW_SIZE_MAX);
    const brightness =
      o.brightness == null ? null : clamp(Number(o.brightness), GLOW_BRIGHT_MIN, GLOW_BRIGHT_MAX);
    return {
      // 只有**显式**存了 true 才算开。原来写的是 `o.enabled !== false`——
      // 那意味着「字段缺失」等于开着，与 A66 的「默认关闭」相矛盾。
      // 现在改成 fail-closed：认不出来就是关，用户点一下就能开回来。
      enabled: o.enabled === true,
      size: Number.isFinite(size) ? size : null,
      brightness: Number.isFinite(brightness) ? brightness : null,
    };
  } catch {
    // 存的内容坏了（手改过 localStorage）就当没设置过 ——
    // 绝不让一个坏值把界面卡成没有光斑。
    return defaultGlow();
  }
}

export function applyGlow(prefs: GlowPrefs) {
  const root = document.documentElement;
  // 开关走 data 属性而不是删元素：CSS 侧一条 `display:none` 就够，
  // 不需要 React 重渲染（这层是高频视觉层，不该被 state 牵着走）。
  if (prefs.enabled) root.removeAttribute('data-opc-glow');
  else root.dataset.opcGlow = '0';

  if (prefs.size == null) root.style.removeProperty('--tc-glow-size');
  else root.style.setProperty('--tc-glow-size', `${Math.round(prefs.size)}px`);

  if (prefs.brightness == null) root.style.removeProperty('--tc-glow-brightness');
  else root.style.setProperty('--tc-glow-brightness', String(prefs.brightness / 100));
}

export function saveGlow(prefs: GlowPrefs): GlowPrefs {
  const clean: GlowPrefs = {
    enabled: prefs.enabled,
    size: prefs.size == null ? null : clamp(Math.round(prefs.size), GLOW_SIZE_MIN, GLOW_SIZE_MAX),
    brightness:
      prefs.brightness == null
        ? null
        : clamp(Math.round(prefs.brightness), GLOW_BRIGHT_MIN, GLOW_BRIGHT_MAX),
  };
  localStorage.setItem(GLOW_KEY, JSON.stringify(clean));
  applyGlow(clean);
  return clean;
}

/**
 * 读当前**实际生效**的光斑直径（px）。
 *
 * 用来在设置页显示数值：`size` 是 null 时用户看到的是主题设计值
 * （浅 440 / 深 380），而不是一个空框。直接从计算样式读，
 * 免去在 JS 里再抄一份主题常量。
 */
export function currentGlowSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--tc-glow-size').trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 440;
}

/**
 * 读当前主题的**设计值**（px），不受用户拖动影响（A35）。
 *
 * 与 `currentGlowSize()` 的区别：后者读的是「实际生效值」——用户拖过滑杆
 * 之后就是那个内联值。设置页要在滑杆上画一根「默认刻度」，那根线必须钉在
 * 主题设计值上，不能跟着滑块跑，所以单独读 `--tc-glow-size-design`
 * （见 index.css 里这两个变量的分工）。
 */
export function themeGlowSize(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--tc-glow-size-design')
    .trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : currentGlowSize();
}
