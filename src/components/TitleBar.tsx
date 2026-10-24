import { useEffect, useState } from 'react';
import { AppLogo } from './AppLogo';

/**
 * 自绘标题栏 —— 窗口最顶上那 40px，**连同三个窗口按钮**。
 *
 * ## 为什么需要它
 *
 * 窗口用的是 `frame: false`（见 electron/main.ts）：系统标题栏整条去掉，
 * 页面从窗口第 0 行开始铺满。代价是「标题栏」这件事没人做了 ——
 * 没有应用标识、没有拖动把手、双击也不能最大化。这条横条把那三件事补回来。
 *
 * 好处是它终于**是应用自己画的了**：字体、字号、色板、高度全部走本项目的
 * 令牌。A94 起它的底色是 `--tc-surface-rail`（与导航条同一档），于是
 * 「标题条 + 导航条」合成一个 L 形的框架块，内容面（列表栏 / 消息区）
 * 嵌在这个 L 里面。原来它走 `--tc-surface-chrome`，和列表栏同色 ——
 * 顶部那 56px 的导航条因此成了贴在标题条上的一块灰条，边界只有色阶、
 * 没有任何线或形状交代它。
 *
 * ## 三个按钮为什么也自己画（A24）
 *
 * A23 之前它们由系统画（`titleBarOverlay`），换来 Win11 贴靠布局等原生行为。
 * 但实测发现**控件区那块底色永远是实色**：系统侧背板 ≈ 240，页面侧 ≈ 226，
 * 同一个 alpha 必然合成出两种颜色，只有 alpha = 1 才同色。也就是说
 * 「标题条必须不透明」，透明度的 0–100 永远拉不到标题条上。
 *
 * 自己画之后，标题条与按钮同属一个 DOM、同一套令牌、同一个 alpha，
 * 整窗（含标题条）才能一起透。丢掉的只有「悬停最大化按钮弹出的贴靠布局
 * 面板」—— 贴靠本身（拖到屏幕边缘、Win+方向键、双击标题栏）仍在，
 * 因为那些走的是 `-webkit-app-region: drag`（HTCAPTION）的系统行为，
 * 不是按钮提供的。
 *
 * ## 最大化状态必须问主进程
 *
 * 用户可能双击标题栏、Win+↑、拖到屏幕顶部来最大化 —— 这些都不经过这里的
 * 按钮。所以状态有两个来源：挂载时 `query()` 拉一次初值（Electron 会记住
 * 上次的窗口状态，首帧就是最大化时事件推送等不到），之后靠 `onStateChange`
 * 推。少了任何一条，字形都会与实际状态分叉。
 *
 * ## 浏览器里也照常渲染
 *
 * 本项目坚持「前端不依赖任何 Electron API」，这里也没有 `if (isElectron)`：
 * 没有 `window.opc` 时三个按钮点下去是空操作，DOM 与打包态**完全一致** ——
 * 打靶脚本（跑在浏览器里）量到的标题栏高度、按钮尺寸、列偏移，
 * 跟用户真正看到的一致。
 */

/** preload 暴露的桥。浏览器开发态是 undefined，所有调用都要可选 */
interface WindowBridge {
  windowControl?: {
    send(action: 'minimize' | 'maximize' | 'close'): void;
    query(): Promise<{ maximized: boolean }>;
    onStateChange(cb: (state: { maximized: boolean }) => void): () => void;
  };
}

const bridge = (window as unknown as { opc?: WindowBridge }).opc?.windowControl;

/**
 * 三个按钮的字形。
 *
 * 用 10×10 的 viewBox + 1px 描边，是为了跟 Windows 自带的控件字形同一个
 * 视觉重量：lucide 的图标是 24 网格、2px 描边，缩到 10px 会糊成一团灰。
 * `shape-rendering: crispEdges` 让 1px 的横竖线落在整像素上，不出现半像素
 * 的灰边 —— 这条横条上只有 1px 的线，糊了非常明显。
 */
function Glyph({ d, rect }: { d?: string; rect?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ shapeRendering: 'crispEdges', display: 'block' }}
    >
      {rect ? (
        <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
      ) : (
        <path d={d} stroke="currentColor" strokeWidth="1" />
      )}
    </svg>
  );
}

function CaptionButton({
  action,
  label,
  danger = false,
  children,
}: {
  action: 'minimize' | 'maximize' | 'close';
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // 无边框窗口里没有系统按钮，这三个就是全部的窗口控制入口
      onClick={() => bridge?.send(action)}
      data-caption-button={action}
      aria-label={label}
      title={label}
      className="tc-caption-btn flex items-center justify-center"
      data-danger={danger ? '1' : undefined}
    >
      {children}
    </button>
  );
}

export function TitleBar({ compact = false }: { compact?: boolean }) {
  // 左侧第一格与导航条**同宽**，应用标记在这一格里居中 ——
  // 于是「标题栏标记 / 导航图标」落在同一条竖轴上。
  // 早先直接 px-4 起排：18px 的标记左边缘落在 16px，中心在 25px，
  // 而导航图标中心在 32px（44px 按钮居中于 64px 栏），差 7px，
  // 放大看是能看出来的错位。宽度跟着 compact 一起收，窄屏也不歪。
  // ⚠️ 这两个数字必须等于 NavRail 的 `w-[56px]` / `w-[48px]`，
  //    改一处不改另一处，标记就会歪到图标左边去。
  const railWidth = compact ? 48 : 56;

  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    // 初值：窗口可能是以最大化状态被恢复的，那时不会再有 maximize 事件
    void bridge
      .query()
      .then(s => {
        if (alive) setMaximized(!!s?.maximized);
      })
      .catch(() => {
        /* 拉不到就按未最大化画，点一次按钮即可自愈 */
      });
    const off = bridge.onStateChange(s => setMaximized(!!s?.maximized));
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <div
      // role=banner：等价于顶层 <header> 的语义，但**不能真用 <header>** ——
      // 各打靶脚本用 `document.querySelectorAll('header')` 的**下标**定位
      // 列表栏 / 主区标题栏，多一个 header 会让那些下标整体错位一格。
      role="banner"
      data-titlebar
      data-maximized={maximized ? '1' : undefined}
      aria-label="标题栏"
      className="tc-drag flex shrink-0 items-center"
      style={{
        height: 'var(--tc-titlebar-height)',
        backgroundColor: 'var(--tc-titlebar-surface)',
        // 底边线把「应用框架」和「栏目」分开：没有它，左侧导航条 + 列表栏
        // 和这条横条会连成一整片灰，「OPC Agent」就成了悬在「消息」上面的
        // 一行孤零零的字。
        borderBottom: '1px solid var(--tc-divider)',
      }}
    >
      <span
        className="relative flex h-full shrink-0 items-center justify-center"
        // A103：导航条被 6px 内缩之后，应用标记这一格要跟着右移同样的量，
        // 否则「标记 / 导航图标」的中轴会错开 6px。窗口按钮仍在右上角
        // 顶格 —— 控件属于窗口而不是属于栏目。
        style={{ width: railWidth, marginLeft: 'var(--tc-column-gap)' }}
      >
        {/* A94：这里原本铺了一层 `--tc-surface-rail` 的绝对定位色块（A92 加的），
            为的是让导航条从窗口顶端贯到底、不在标题条高度内断开。现在整条标题条
            本身就等于 rail（`--tc-titlebar-surface` → `var(--tc-surface-rail)`），
            再铺一层等于 rail 盖 rail —— 纯冗余，已删。
            删掉之后这 56px 仍是应用标记的定位格：宽度与 NavRail 同宽，
            标记居中，于是「标记 / 导航图标」落在同一条竖轴上。 */}
        {/* 应用标记：同人卦徽章。黑白双色，与任务栏/桌面图标
            （build/icon.svg 生成）同一枚设计 —— 窗口左上角这枚小徽章是
            用户对「这个应用长什么样」的第一印象，不能和任务栏图标是两张脸。
            界面里随主题反转（--tc-logo-*：浅色黑底白爻、深色白底黑爻），
            OS 图标那边翻不了，靠黑底 + 白描边兼容两种桌面。
            不用 <img>：build/ 不进 app.asar，打包态会静默裂图。 */}
        <span
          data-app-logo
          className="relative flex h-[18px] w-[18px] items-center justify-center rounded-[4px]"
          style={{ backgroundColor: 'var(--tc-logo-tile)', color: 'var(--tc-logo-mark)' }}
        >
          <AppLogo size={13.5} />
        </span>
      </span>
      {/* pl-4 让应用名与左栏标题（PanelHeader 的 px-4）落在同一条竖线上 */}
      <span
        className="truncate pl-4 text-secondary font-medium tracking-tight"
        style={{ color: 'var(--td-text-color-secondary)' }}
      >
        OPC Agent
      </span>

      {/* 三个窗口按钮贴右上角，占满标题条高度 —— 与 Windows 自带控件的
          落点一致（用户不必重新学一个位置）。`ml-auto` 把它们推到最右，
          标题文字再长也不会把按钮挤走。 */}
      <div className="ml-auto flex h-full shrink-0 items-stretch" data-caption-group>
        <CaptionButton action="minimize" label="最小化">
          <Glyph d="M0 5h10" />
        </CaptionButton>
        <CaptionButton action="maximize" label={maximized ? '向下还原' : '最大化'}>
          {maximized ? (
            // 还原：前面一个实心框 + 后面一个只露左上两笔的框
            <Glyph d="M2.5 2.5H9.5V9.5H2.5V2.5ZM0.5 6.5V0.5H6.5V2.5" />
          ) : (
            <Glyph rect />
          )}
        </CaptionButton>
        <CaptionButton action="close" label="关闭" danger>
          <Glyph d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
        </CaptionButton>
      </div>
    </div>
  );
}
