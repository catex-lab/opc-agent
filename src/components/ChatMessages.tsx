import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loading, MessagePlugin } from 'tdesign-react';
import { ChatMarkdown } from '@tdesign-react/chat';
import { Copy, GitBranch, PencilLine, Quote, RefreshCw, Share2, TextSelect, User, Image as ImageIcon } from 'lucide-react';
import { Message, Model, PermissionRequest, RegisteredAgent, Block, ThinkingBlock, ToolBlock } from '../types';
import { legacyToBlocks, runActivity, streamPhaseLabel, textOfBlocks } from '../../shared/blocks';
import { AgentTrace } from './AgentTrace';
import { BackgroundTasksPill } from './BackgroundTasksPill';
import { useBackgroundTasks } from '../hooks/useBackgroundTasks';
import { formatHandledDuration, hasFileEdits, lingeringToolBlocks } from '../../shared/trace';
import { InlinePermissionCard } from './InlinePermissionCard';
import { VerifyPanel } from './VerifyPanel';
import { FileEvidencePanel } from './FileEvidencePanel';
import { useVerifications } from '../hooks/useVerifications';
import { installCherryCodeIconFix } from './cherryCodeIcon';
import { AgentAvatar } from './AgentAvatar';
import { ImageBubble } from './ImageBubble';
import { TypingText } from './TypingText';
import { formatUsage } from '../utils/formatUsage';

/* ── 消息呈现（A33）─────────────────────────────────────────────────────
 *
 * 形态：先思考后作答 + 答案全宽 + 底部操作行。
 * 新部件全部做成展示层：秒数 tick、按钮反馈各自持状态，与消息数据流
 * （rAF 批刷 / 断线续传 / 服务端投影）互不干扰 —— 那套一行不动。
 * ────────────────────────────────────────────────────────────────────── */

/** 流式已用秒数：active 时每秒 tick，停表即清定时器 */
function useElapsed(startedAt: number | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!startedAt) return null;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

/**
 * 思考块。
 *
 * 流式中是「思考中 · 已用 Ns」实时秒数，完成后定格为「已思考 Ns」。
 * codex 的 reasoning 只有摘要没有原始思维链，必须标「（摘要）」——
 * 否则用户会以为看到了完整推理链。
 */
function ThinkingView({ block }: { block: ThinkingBlock }) {
  const streaming = block.state === 'streaming';
  const live = useElapsed(block.startedAt, streaming);
  const secs =
    block.endedAt && block.startedAt
      ? Math.max(0, Math.round((block.endedAt - block.startedAt) / 1000))
      : null;
  return (
    <details className="tc-thinking mb-2 text-secondary" open={streaming}>
      <summary className="flex cursor-pointer select-none items-center gap-2">
        {streaming && <Loading size="small" />}
        <span>
          {streaming
            ? `思考中 · 已用 ${live ?? 0}s`
            : `已思考 ${secs ?? 0}s${block.format === 'summary' ? '（摘要）' : ''}`}
        </span>
        <span style={{ color: 'var(--td-text-color-placeholder)' }}>
          {block.text.length} 字
        </span>
      </summary>
      <div className="whitespace-pre-wrap leading-relaxed">
        {/* A83：思考正文在流式时逐字浮现；思考结束后传 false ——
            历史消息打开时不该「重打一遍」。 */}
        <TypingText text={block.text} animate={streaming} />
      </div>
    </details>
  );
}

/**
 * 流式状态行（A34）。
 *
 * 文案不再用「深度求索中」——那是 DeepSeek 的专属说法。改成中性的
 * 「正在处理」，并用 spinner mode 做**分阶段语义**：
 *   thinking → 正在思考 / tool → 正在调用 <name> / writing → 正在生成
 *   idle（刚发出、还没有块）→ 正在处理
 * 阶段由 shared/blocks 的 runActivity() 推导，前后端同一套判据。
 *
 * 视觉上把原来的「缩放脉冲点 + 行尾三个跳动点」收敛成**一个呼吸灯**：
 * 实心核 + 向外扩散的环，两个动画同周期（1.8s），读起来是一盏灯在呼吸，
 * 而不是两个互不相干的动画抢注意力。
 */
function StreamStatus({
  startedAt,
  blocks,
  imageMode,
}: {
  startedAt?: number;
  blocks?: readonly Block[];
  imageMode?: boolean;
}) {
  const elapsed = useElapsed(startedAt, true);
  const label = streamPhaseLabel(blocks ?? [], imageMode);

  return (
    <span
      className="flex items-center gap-1.5 text-caption"
      style={{ color: 'var(--td-text-color-placeholder)' }}
      data-stream-status
      data-stream-phase={imageMode ? 'image' : runActivity(blocks ?? [])}
    >
      <span className="tc-live-dot" aria-hidden="true">
        <span className="tc-live-core" style={{ backgroundColor: 'var(--td-brand-color)' }} />
        <span className="tc-live-ring" style={{ borderColor: 'var(--td-brand-color)' }} />
      </span>
      {/* A83：阶段文案走打字机（模糊渐显 + 逐字错开）。
          只包 label、不包后面的「用时 N 秒」—— 那个数字每秒都变，
          一起包进去会让整行每秒重打一遍（startsWith 断在数字上）。
          阶段切换（思考 → 调用工具 → 生成）时才重播，正好对应
          「换了一件事在做」这个语义。

          ⚠️ 外层必须再套一个 span：这一行是 `flex items-center gap-1.5`，
          两个 span 直接并排会被 gap 撑出 6px，渲染成「正在思考 ，用时 0 秒」
          （逗号前多一个空格）。套一层之后 gap 只作用在「指示灯 ↔ 文字」之间，
          文字内部是普通行内流，标点紧贴。 */}
      <span>
        <TypingText text={label} />
        <span>，用时 {elapsed ?? 0} 秒</span>
      </span>
    </span>
  );
}

interface MessageActionsProps {
  /** 纯答案文本（复制按钮用） */
  text: string;
  /** 完整 Markdown（分享按钮用：含思考与工具摘要） */
  shareText: string;
  onRegenerate?: () => void;
  onBranch?: () => void;
}

/**
 * 消息操作行：复制 / 重新生成 / 分享 / 分支。
 *
 * A55：删掉「好评 / 差评 / 复制所有代码块 / 代码自动换行」四个按钮 ——
 * 赞踩只是会话内假反馈（存内存、刷新即忘），留着会让用户以为平台真在收集；
 * 代码块那一组与 Cherry 代码块自带的复制按钮职责重叠，且换行开关
 * 绝大多数场景用不到。删按钮的同时把 wrapIds 状态机一并移除，
 * 不留死代码。
 *
 * 一处如实说明（不假装有而没有的能力）：
 * - 分享是**复制完整 Markdown**，不是生成链接 —— 本项目没有分享服务。
 * 分支与重新生成是真实功能，见 onBranch / onRegenerate 的接线。
 */
function MessageActions({
  text,
  shareText,
  onRegenerate,
  onBranch,
}: MessageActionsProps) {
  const copy = async (content: string, tip: string) => {
    try {
      await navigator.clipboard.writeText(content);
      MessagePlugin.success(tip);
    } catch {
      MessagePlugin.warning('复制失败：浏览器拒绝了剪贴板访问');
    }
  };

  return (
    <div className="tc-actions mt-1.5 flex items-center gap-0.5">
      <button
        type="button"
        className="tc-act-btn"
        title="复制回答"
        aria-label="复制回答"
        onClick={() => copy(text, '已复制到剪贴板')}
      >
        <Copy size={15} />
      </button>
      {onRegenerate && (
        <button
          type="button"
          className="tc-act-btn"
          title="重新生成"
          aria-label="重新生成"
          onClick={onRegenerate}
        >
          <RefreshCw size={15} />
        </button>
      )}
      <button
        type="button"
        className="tc-act-btn"
        title="分享（复制完整 Markdown）"
        aria-label="分享"
        onClick={() => copy(shareText, '已复制可分享的 Markdown')}
      >
        <Share2 size={15} />
      </button>
      {onBranch && (
        <button
          type="button"
          className="tc-act-btn"
          title="从此处分支会话"
          aria-label="分支"
          onClick={onBranch}
        >
          <GitBranch size={15} />
        </button>
      )}
    </div>
  );
}

/**
 * 用户消息操作行（A49）：复制 / 编辑 / 分享。
 *
 * ## 为什么用户侧也要有操作行
 *
 * 助手消息底下早有一排图标（复制 / 赞 / 踩 / 重试 / 分享 / 分支），用户自己
 * 发的那条却什么都没有 —— 想「把刚才那句话再发一遍」「改两个字重发」「把
 * 这句话发给别人」都只能重新打字。用户反馈原话：「在我发的文字下方也要有
 * 复制、编辑、分享图标功能」。
 *
 * ## A55：默认隐藏，悬停才出现
 *
 * 用户反馈原话：「用户发给AI的内容下方的'复制、编辑、分享'按钮图标设计成
 * 只有鼠标移到用户发的内容上时才会出现并允许用户操作」。实现用纯 CSS：
 * `.tc-actions-user` 默认 opacity 0 + pointer-events none，由外层
 * `.tc-user-msg`（用户消息那一列）的 :hover / :focus-within 唤出。
 * 悬停目标是**整列**而不是气泡本身 —— 气泡与按钮行之间有 8px 间距，
 * 鼠标移过去点按钮的途中不会闪断；键盘 Tab 聚焦同样能唤出（focus-within）。
 *
 * ## 三个动作的语义（如实说明，不假装有而没）
 *
 * - **复制**：把这条消息的纯文本写进剪贴板；
 * - **编辑**：把内容**填回输入框**（不删原消息、不静默重发）。改完按回车
 *   就是一条新消息 —— 原消息仍在历史里。真正的「就地改并重跑」需要后端
 *   截断会话，属于另一件事，这里不冒充；
 * - **分享**：同助手侧 —— **复制 Markdown**，本项目没有分享服务。
 *
 * 与助手侧共用 `.tc-actions` / `.tc-act-btn` 两个类，尺寸、间距、悬停底色
 * 天然一致；只是不显示赞踩（对用户自己的话点赞没有意义）。
 */
function UserMessageActions({
  text,
  onEdit,
}: {
  text: string;
  onEdit?: () => void;
}) {
  const copy = async (content: string, tip: string) => {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      MessagePlugin.success(tip);
    } catch {
      MessagePlugin.warning('复制失败：浏览器拒绝了剪贴板访问');
    }
  };

  /* A55-d：鼠标点完按钮，焦点会留在按钮上，.tc-user-msg:focus-within
     会让操作行在鼠标移开后仍然不消失——与「只有鼠标移到这条消息上才
     出现」的需求相反。所以点完即失焦：键盘 Tab 聚焦依然能唤出操作行
   （focus-within 保留给键盘用户），鼠标点完就走。 */
  const afterClick = (fn: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    fn();
    e.currentTarget.blur();
  };

  return (
    <div className="tc-actions tc-actions-user flex items-center gap-0.5" data-user-actions>
      <button
        type="button"
        className="tc-act-btn"
        title="复制这条消息"
        aria-label="复制这条消息"
        data-user-action="copy"
        onClick={afterClick(() => copy(text, '已复制到剪贴板'))}
      >
        <Copy size={15} />
      </button>
      {onEdit && (
        <button
          type="button"
          className="tc-act-btn"
          title="编辑（填回输入框）"
          aria-label="编辑"
          data-user-action="edit"
          onClick={afterClick(onEdit)}
        >
          <PencilLine size={15} />
        </button>
      )}
      <button
        type="button"
        className="tc-act-btn"
        title="分享（复制 Markdown）"
        aria-label="分享"
        data-user-action="share"
        onClick={afterClick(() => copy(text, '已复制可分享的 Markdown'))}
      >
        <Share2 size={15} />
      </button>
    </div>
  );
}

/* ── 选区工具条（A34；A49 重做定位 + 右键菜单加「全选」）──────────────
 *
 * 为什么需要它：正文由 TDesign ChatMarkdown 渲染在 Shadow DOM 里，
 * 原生 Ctrl+C 对「选区落在 shadow root 内」并不总是可靠（用户实测复制
 * 不了）。这里用显式的「复制 / 引用」把这条路径做成确定的：
 * 复制直接读 getSelection().toString()，引用把选中文字交给输入框。
 *
 * ## A49：用户反馈「选中 AI 回答只闪一下」的真实根因
 *
 * 用户侧气泡是普通 DOM，助手侧正文在 **shadow root** 里。实测
 * （`.tmp/probe-a49-rect.mjs`，真实鼠标拖选后取值）：
 *
 *     range.getBoundingClientRect() → 0×0 @ (0,0)
 *     range.getClientRects()        → []（空数组）
 *     sel.anchorNode                → 容器 DIV（端点被 retarget 了）
 *     anchorEl.getBoundingClientRect() → 768×115.6（有值）
 *
 * 也就是说 **选区本身算不出任何矩形**。而旧代码里有一条
 * `if (rect.width === 0 && rect.height === 0) setPos(null)`，于是：
 *   · 左键拖选：每一次 selectionchange 都被判成「没有选区」，工具条根本
 *     不出现（真实窗口里表现为「闪一下就没了」）；
 *   · 右键：onContextMenu 用 e.clientX/clientY 定位，能出来；但紧跟其后的
 *     mouseup 又跑一遍 measure → 矩形仍是 0 → 立刻收起 —— **这就是那次闪烁**。
 *
 * 修法三条：
 *  1. 矩形按「range → clientRects → 端点元素框」逐级兜底，并带上精度标记；
 *     拿不到精确矩形时改用**指针坐标**定位（拖选过程中 mousemove 持续更新）；
 *  2. `selectionchange` 不再负责定位，只负责「选区没了就收起」。定位交给
 *     mousemove / mouseup / contextmenu / keyup 各司其职 —— 去掉两个写入方
 *     互相打架这个结构性原因，而不是给 0 矩形打补丁；
 *  3. 右键菜单多一个「全选」，选中当前这条消息的正文（助手侧穿透 shadow）。
 *
 * 另外三个容易踩的点（A34 起就存在，保持不变）：
 *  - 选区可能落在 shadow root 里 —— contains() 会返回 false，必须顺着
 *    ShadowRoot.host 往上走才算得对；
 *  - 工具条自己不能把选区弄丢 —— mousedown 必须 preventDefault；
 *  - 滚动 / 点击别处要收起，否则会浮在错误的位置上。
 * ────────────────────────────────────────────────────────────────── */

/** 选区节点是否在 root 内（穿透 Shadow DOM 边界） */
function isInsideRoot(node: Node | null, root: HTMLElement): boolean {
  let n: Node | null = node;
  while (n) {
    if (n === root) return true;
    if (n instanceof ShadowRoot) {
      n = n.host;
      continue;
    }
    n = n.parentNode;
  }
  return false;
}

/** 复制纯文本：优先 clipboard API，失败时退回 execCommand */
function copyPlainText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('execCommand failed'));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

/** 选区矩形 + 精度。`precise=false` 表示只是端点元素的大致框（贴不住具体那一行） */
function rectOfSelection(
  range: Range,
  sel: Selection
): { rect: { left: number; top: number; bottom: number; width: number } | null; precise: boolean } {
  // ① 常规路径：range 自己就有框（普通 DOM 的选区都走这里）
  const r = range.getBoundingClientRect();
  if (r.width > 0 || r.height > 0) return { rect: r, precise: true };
  // ② 少数情况下 boundingRect 为空但 clientRects 有值（跨行 / 跨块选区）
  const first = range.getClientRects()[0];
  if (first && (first.width > 0 || first.height > 0)) return { rect: first, precise: true };
  // ③ shadow root 里的选区：上面两条全空（见文件头注释的实测数据）。
  //    退到端点元素 —— 横向中心与顶边仍可用，只是粗一点。
  const node = sel.focusNode ?? sel.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const b = el?.getBoundingClientRect();
  if (b && (b.width > 0 || b.height > 0)) return { rect: b, precise: false };
  return { rect: null, precise: false };
}

/**
 * 选区所在的「正文容器」（穿透 shadow 边界）。
 *
 * 助手侧命中 `.chat-markdown`（真正的正文在它的 shadow root 里），
 * 用户侧命中 `.tc-bubble-user`。「全选」用它来界定「这条消息的正文」，
 * 而不是整篇文档 —— 后者会把时间戳、按钮、相邻消息一起选进去。
 */
function messageTextContainer(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (
      n instanceof HTMLElement &&
      (n.classList.contains('chat-markdown') || n.classList.contains('tc-bubble-user'))
    ) {
      return n;
    }
    n = n instanceof ShadowRoot ? n.host : n.parentNode;
  }
  return null;
}

/**
 * 把 **shadow root 内**的 host 级选区整形成「端点全是文本节点」的 Range。
 *
 * ## 为什么需要（A54 实测）
 *
 * Blink 对 shadow 内容的选区，`anchorNode/focusNode` 上报的是**宿主层的
 * 元素端点**（真实窗口实测：`DIV` offset 0 → `DIV` offset 0），于是：
 *   · `range.getBoundingClientRect()` → 0×0，`getClientRects()` → 空；
 *   · `rectOfSelection` 只能靠端点元素框或指针坐标兜底，工具条贴不准；
 *   · 选区高亮按块盒子渲染，可能把块间空白一并画蓝（用户报的「选取溢出」）。
 *
 * ## 做法
 *
 * 按 `sel.toString()` 的文本，在 shadow 内按文档序的文本节点序列里定位
 * 起止点，重建 Range。选区文本按 `\n` 切段逐段映射 —— Blink 的
 * `Selection.toString()` 在块边界插 `\n`，而文本节点拼接串里没有这个
 * 分隔，不切段就会整串找不到。
 *
 * 找 shadow root 有三条路（A54 实测逐条补上）：
 *  1) 端点本来就在 shadow 里（selectAll 等自己人建的选区）——向上走即到；
 *  2) 端点被 retarget 到宿主 host 元素本身（端点元素自带 shadowRoot）；
 *  3) 端点是 light DOM 包裹层 div.chat-markdown（Blink 对 shadow 内拖选的
 *     上报形态），host 是它的子节点 —— 从包裹层里找 t-chat-md-content。
 * 三条路都只负责「找到 shadow」，选区是否真的全在这个 shadow 里，由后面
 * 的文本映射兜底：映射不上就放弃整形，绝不让选区变形。
 *
 * ## 边界
 *
 *   · 只在**整个选区都在同一个 shadow root 里**时整形；跨出影子边界
 *     （例如拖到消息底部的时间戳行）的选区原样保留，不碰。
 *   · 任一段落按序找不到 → 放弃整形，**保住原生选区**，绝不把用户
 *     选中的东西弄丢。
 *   · light DOM（用户消息气泡）里的选区浏览器自己就是精确的，直接返回 false。
 */
function normalizeSelection(sel: Selection | null): boolean {
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  // 选区所在的 shadow root：
  // 1) 自己人建的选区（selectAll 等）端点就在 shadow 里，向上走能遇到；
  // 2) 用户拖选产生的原生选区，端点被 Blink retarget 到宿主 host 元素
  //    （light DOM 层），向上走永远遇不到 ShadowRoot —— shadowRoot 是
  //    host 的子节点而非祖先。所以端点元素本身就带 shadowRoot 时，那
  //    就是目标 shadow（A54 实测：anchorNode = <t-chat-md-content>）。
  let n: Node | null = range.commonAncestorContainer;
  let shadow: ShadowRoot | null = null;
  while (n) {
    if (n instanceof ShadowRoot) {
      shadow = n;
      break;
    }
    n = n.parentNode;
  }
  if (!shadow) {
    for (const endpoint of [sel.anchorNode, sel.focusNode]) {
      let p: Node | null = endpoint;
      while (p) {
        if (p instanceof Element && p.shadowRoot) {
          shadow = p.shadowRoot;
          break;
        }
        p = p.parentNode;
      }
      if (shadow) break;
    }
  }
  if (!shadow) {
    // 3) A54 实测的第三种形态：用户拖选后 anchorNode 是 light DOM 的
    //    包裹层 div.chat-markdown 本身（host 是它的子节点，向上找不到）。
    //    只有端点容器就在包裹层内时才走这条路 —— 选区跨出影子边界到
    //    页脚行时 commonAncestor 是消息行（包裹层的兄弟/父级），
    //    closest 命不中，天然不会误判。选定 shadow 后仍要过文本映射，
    //    映射不上照样放弃，双保险。
    const container = range.commonAncestorContainer;
    const mdWrap = container instanceof Element ? container.closest('.chat-markdown') : null;
    const mdHost = mdWrap?.querySelector('t-chat-md-content');
    if (mdHost?.shadowRoot) shadow = mdHost.shadowRoot;
  }
  if (!shadow) return false; // light DOM：浏览器自己的选区就是精确的
  const text = sel.toString();
  if (!text.trim()) return false;

  // shadow 内按文档序收集文本节点，拼成「全文字符串 + 每节点的区间」
  const walker = document.createTreeWalker(shadow, NodeFilter.SHOW_TEXT);
  const spans: { node: Text; start: number; len: number }[] = [];
  let full = '';
  let t: Node | null;
  while ((t = walker.nextNode())) {
    const s = t.textContent ?? '';
    if (!s) continue;
    spans.push({ node: t as Text, start: full.length, len: s.length });
    full += s;
  }
  const locate = (pos: number): [Text, number] | null => {
    for (const s of spans) {
      if (pos >= s.start && pos <= s.start + s.len) return [s.node, pos - s.start];
    }
    return null;
  };

  // 逐段按序映射；任何一段找不到就整体放弃
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const seg of text.split('\n')) {
    if (!seg) continue;
    const at = full.indexOf(seg, cursor);
    if (at < 0) return false;
    if (first < 0) first = at;
    last = at + seg.length;
    cursor = last;
  }
  if (first < 0) return false;
  const start = locate(first);
  const end = locate(last);
  if (!start || !end) return false;

  try {
    const rebuilt = document.createRange();
    rebuilt.setStart(start[0], start[1]);
    rebuilt.setEnd(end[0], end[1]);
    sel.removeAllRanges();
    sel.addRange(rebuilt);
    return true;
  } catch {
    return false; // 端点跨树等异常：维持原生选区
  }
}

/** 工具条自身（点它不算「点了别处」） */
function inToolbar(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-selection-toolbar]');
}

/** 选区工具条的模式：拖选出来的（复制/引用）/ 右键弹出的（多一个全选） */
type SelMode = 'drag' | 'context';

interface SelPos {
  top: number;
  left: number;
  text: string;
  below: boolean;
  mode: SelMode;
}

function SelectionToolbar({
  rootRef,
  onQuote,
}: {
  rootRef: React.RefObject<HTMLElement>;
  onQuote?: (text: string) => void;
}) {
  const [pos, setPos] = useState<SelPos | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    /** 指针位置：拖选时持续更新，选区算不出矩形时靠它定位 */
    const pointer = { x: 0, y: 0, down: false };
    /** 右键菜单开着：紧跟其后的 mouseup 不能把它降级成普通拖选条 */
    let contextPinned = false;

    /** 当前选区（必须非空、且落在消息区里） */
    const readSelection = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!sel || sel.rangeCount === 0 || !text.trim()) return null;
      const range = sel.getRangeAt(0);
      if (!isInsideRoot(range.commonAncestorContainer, root)) return null;
      return { range, sel, text };
    };

    /** 定位并显示。`at` 是这次事件自带的指针坐标（右键 / 松手） */
    const place = (mode: SelMode, at?: { x: number; y: number }) => {
      const cur = readSelection();
      if (!cur) {
        setPos(null);
        return;
      }
      const geo = rectOfSelection(cur.range, cur.sel);
      const px = at?.x ?? (pointer.down ? pointer.x : null);
      const py = at?.y ?? (pointer.down ? pointer.y : null);
      // 有指针坐标就贴指针（拖选 / 松手 / 右键都自带坐标）。
      // 只有键盘选没有指针时才退回矩形 —— 而键盘选的选区经过
      // normalizeSelection 整形后，矩形已经是精确的。
      // 为什么不看 precise：shadow 里 range 的矩形要么是 0×0（端点被
      // 上报成宿主层元素），要么是整块 union —— 拿它定位，工具条会在
      // 拖选途中跟着选区外接框乱跳（A54 用户报的「屏闪」之一）。
      const usePointer = px !== null && py !== null;
      const box = usePointer
        ? { left: px as number, top: py as number, bottom: py as number, width: 0 }
        : geo.rect;
      if (!box) {
        setPos(null);
        return;
      }
      // 选区 / 指针贴近窗口顶部时，工具条翻到下方 —— 否则会被顶出可视区
      const below = box.top < 52;
      setPos({
        top: below ? box.bottom + 8 : box.top - 8,
        left: Math.min(window.innerWidth - 12, Math.max(12, box.left + box.width / 2)),
        text: cur.text,
        below,
        mode,
      });
    };

    const schedule = (mode: SelMode) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => place(mode));
    };

    const onMouseDown = (e: MouseEvent) => {
      if (inToolbar(e.target)) return;
      pointer.down = true;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      // 左键按下 = 要开始一次新的选择，右键菜单模式到此结束
      if (e.button === 0) contextPinned = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      // 只在按住拖动时跟随；不按下时鼠标划过不该把工具条带走
      if (pointer.down && !inToolbar(e.target)) {
        schedule(contextPinned ? 'context' : 'drag');
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      // A54 实测：拖选松手点往往正落在工具条上（工具条就贴在选区终点上方），
      // 老代码在这里 inToolbar 就整体 return —— 结果 normalizeSelection 和
      // pointer.down=false 都被跳过：shadow 选区永不整形、拖选状态粘滞。
      // 现在拆分：整形与状态复位永远做；只有「重摆位置」在落点是工具条时
      // 跳过（那通常是用户要去点按钮，或刚在工具条自己的文字上拖选）。
      normalizeSelection(window.getSelection());
      pointer.down = false;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (inToolbar(e.target)) return;
      // 松手这一刻的指针就是「选区终点」，直接按它定位：
      // shadow 里矩形为空也不会再被判成「没有选区」→ 不再闪一下就没
      place(contextPinned ? 'context' : 'drag', { x: e.clientX, y: e.clientY });
    };

    /**
     * 右键：**只有当前确实有一段落在消息区内的非空选区**时才拦掉原生菜单
     * 并就地弹出工具条；没有选区时一律放行，右键该有的一切（检查元素、
     * 复制链接等）都不受影响。
     */
    const onContextMenu = (e: MouseEvent) => {
      if (!readSelection()) return;
      e.preventDefault();
      contextPinned = true;
      // 右键前也整形：复制 / 引用拿到的是精确选区，工具条贴指针
      normalizeSelection(window.getSelection());
      place('context', { x: e.clientX, y: e.clientY });
    };

    /** 键盘选（Shift + 方向键 / Ctrl+A）没有指针，退回矩形或端点元素框 */
    const onKeyUp = (e: KeyboardEvent) => {
      const shifted =
        e.shiftKey ||
        e.key === 'Shift' ||
        e.key.startsWith('Arrow') ||
        e.key === 'a' ||
        e.key === 'A';
      if (!shifted) return;
      // 键盘选同样可能是 host 级选区，整形成精确 Range 后才能拿到真矩形
      normalizeSelection(window.getSelection());
      schedule(contextPinned ? 'context' : 'drag');
    };

    /**
     * A49：这里**只做收起，不做定位**。
     *
     * 旧版把定位也放在这里，于是同一个状态有两个写入方：右键刚用鼠标坐标
     * 摆好，紧跟的 mouseup 又按「算不出来的矩形」把它清掉 —— 用户看到的就是
     * 闪一下。现在定位职责分给 mousemove / mouseup / contextmenu / keyup。
     *
     * A54：拖选途中（pointer.down）完全不在这里收起 —— 拖选时
     * selectionchange 每一小段选区变化都会触发，此时收起会与 mousemove
     * 的持续摆位互相打架，工具条表现为不停闪烁。拖选中想要的位置由
     * mousemove 负责；选没了的情况在松手那一刻的 place() 里收。
     */
    const onSelectionChange = () => {
      if (pointer.down) return;
      if (!readSelection()) setPos(null);
    };

    const hide = () => {
      if (pointer.down) return; // 拖选途中的自动滚动不该把工具条收掉
      setPos(null);
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [rootRef]);

  if (!pos) return null;

  const done = () => {
    window.getSelection()?.removeAllRanges();
    setPos(null);
  };

  /**
   * 全选：选中**当前这条消息的正文**。
   *
   * 助手侧正文在 shadow root 里，range 必须落在 shadow 树内部才有效
   * （端点跨树会被浏览器拒绝），所以对宿主用 `selectNodeContents(shadowRoot)`。
   * 用户侧就是气泡本身。
   *
   * 选完**不动位置**、只把文本换掉：否则工具条会跳到整块正文的上方，
   * 手刚移过去点「复制」就会扑空。
   */
  const selectAll = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const target = messageTextContainer(sel.getRangeAt(0).commonAncestorContainer);
    if (!target) return;
    const mdHost = target.matches('t-chat-md-content')
      ? target
      : target.querySelector('t-chat-md-content');
    const range = document.createRange();
    const sr = (mdHost as HTMLElement | null)?.shadowRoot;
    if (sr) range.selectNodeContents(sr);
    else range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
    // 整形成文本节点端点：selectNodeContents(shadowRoot) 的端点是 shadow
    // 根本身，getBoundingClientRect 同样是 0×0，复制/再次定位都会吃亏
    normalizeSelection(sel);
    setPos(p => (p ? { ...p, text: sel.toString() } : p));
  };

  return createPortal(
    <div
      className={`tc-sel-toolbar${pos.below ? ' tc-sel-toolbar--below' : ''}`}
      data-selection-toolbar
      data-sel-mode={pos.mode}
      style={{
        top: pos.top,
        left: pos.left,
        transform: pos.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
      onMouseDown={e => e.preventDefault()}
    >
      <button
        type="button"
        className="tc-sel-btn"
        data-sel-action="copy"
        onClick={async () => {
          try {
            await copyPlainText(pos.text);
            MessagePlugin.success('已复制选中内容');
          } catch {
            MessagePlugin.warning('复制失败：剪贴板不可用');
          }
          done();
        }}
      >
        <Copy size={13} /> 复制
      </button>
      <span className="tc-sel-sep" aria-hidden="true" />
      <button
        type="button"
        className="tc-sel-btn"
        data-sel-action="quote"
        onClick={() => {
          onQuote?.(pos.text);
          done();
        }}
      >
        <Quote size={13} /> 引用
      </button>
      {/* 右键菜单专属：多一个「全选」。拖选出来的小条保持两项 —— 它贴着手，
          多一项反而更容易点错。 */}
      {pos.mode === 'context' && (
        <>
          <span className="tc-sel-sep" aria-hidden="true" />
          <button type="button" className="tc-sel-btn" data-sel-action="selectall" onClick={selectAll}>
            <TextSelect size={13} /> 全选
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

interface ChatMessagesProps {
  messages: Message[];
  models: Model[];
  messagesEndRef: React.RefObject<HTMLDivElement>;
  /**
   * 按 agentId 反查注册表条目。
   *
   * 一对一给 `id => agent`（会话只绑定一个 Agent）；群聊给
   * `registry.getAgent`，因为同一条消息流里会出现多个作者，
   * 每个气泡要用**它自己**的头像和名字，而不是会话头部那一个。
   */
  getAgent?: (id: string) => RegisteredAgent | undefined;
  /** 会话绑定的 Agent，作为反查不到时的兜底 */
  agent?: RegisteredAgent;
  /** 群聊模式：在气泡上方显示作者名，并渲染编排叙述行 */
  groupMode?: boolean;
  /**
   * 生图场景（P4-4）。开启后，assistant 的「等待中」提示改为「正在生成图像…」，
   * 并给生图消息一个专属头像 —— 图不是会话绑定的那个 Agent 画的，
   * 用它的头像会让人误以为「Hermes 会画图」。
   */
  imageMode?: boolean;
  // 内联权限确认相关
  permissionRequest?: PermissionRequest | null;
  onPermissionAllow?: () => void;
  onPermissionDeny?: () => void;
  /**
   * 点 Agent 头像 → 弹该 Agent 的详情（P7）。
   *
   * 不传（或某个 Agent 反查不到）时头像就是死的静态图 —— 老用法不受影响。
   */
  onShowAgentDetail?: (agentId: string) => void;
  /**
   * 重新生成：用这条 assistant 消息之前的最后一条 user 消息重跑一轮。
   * 不传时消息底部不显示「重新生成」按钮（群聊等暂不支持的场景）。
   */
  onRegenerate?: (message: Message) => void;
  /**
   * 分支：把「截至这条消息」的会话复制成一个新会话并跳过去。
   * 不传时不显示「分支」按钮。
   */
  onBranch?: (message: Message) => void;
  /**
   * 引用：把用户选中的一段文字塞进输入框（以 Markdown 引用块形式）。
   * 不传时选区工具条只显示「复制」。
   */
  onQuote?: (text: string) => void;
  /**
   * 编辑（A49）：把某条**用户消息**的内容填回输入框，让用户改完重发。
   * 不传时用户消息下方不出现「编辑」按钮。
   */
  onEditMessage?: (message: Message) => void;
  /**
   * 点「N 个后台任务运行中」跳到那个还在跑的会话（A36）。
   * 不传时胶囊只显示数量、不可点。
   */
  onOpenSession?: (sessionId: string) => void;
  /** 当前会话 id：后台任务轮询要把它排除掉（眼前这一轮不算「后台」） */
  currentSessionId?: string | null;
  /**
   * 会话绑定的工作目录（A97）。验证面板据此探测「这个项目能跑哪些检查」；
   * 不传时面板只显示「会话未绑定工作目录」，不会给出一个跑不了的按钮。
   */
  sessionCwd?: string;
}

export function ChatMessages({
  messages,
  models,
  messagesEndRef,
  getAgent,
  agent,
  groupMode = false,
  imageMode = false,
  permissionRequest,
  onPermissionAllow,
  onPermissionDeny,
  /** 点 Agent 头像 → 弹该 Agent 的详情（P7） */
  onShowAgentDetail,
  onRegenerate,
  onBranch,
  onQuote,
  onEditMessage,
  onOpenSession,
  currentSessionId,
  sessionCwd,
}: ChatMessagesProps) {
  /** 消息区根节点：选区工具条用它判断「选区是不是在这片消息里」 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** A97：验证结果（按会话取一次，前端按 message_id 分组） */
  const { rows: verifications, refresh: refreshVerifications } = useVerifications(currentSessionId);
  /**
   * A56：Cherry 代码块「复制」按钮的字体图标换成内联 SVG。
   * 按钮在 shadow DOM 里且 hover 时才创建，安装后由模块内部的
   * MutationObserver 持续盯着（新消息 + hover 重建两条路径）。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return installCherryCodeIconFix(root);
  }, []);
  /** 后台任务（A36）：别的会话还在跑的轮次 */
  const backgroundTasks = useBackgroundTasks(currentSessionId);
  /**
   * 兜底复制：正文在 Shadow DOM 里时，浏览器默认的 copy 偶尔拿不到选区。
   * 这里在消息区捕获 copy 事件，若剪贴板还没有 text/plain，就手动填入选区文本。
   */
  const handleCopy = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = window.getSelection()?.toString();
    if (!text) return;
    if (!e.clipboardData.getData('text/plain')) {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    }
  }, []);

  const resolveAgent = useCallback(
    (id?: string): RegisteredAgent | undefined => {
      if (!id) return agent;
      return getAgent?.(id) ?? agent;
    },
    [getAgent, agent]
  );
  const formatModelName = (modelId: string) => {
    const model = models.find(m => m.modelId === modelId);
    const name = model?.name || modelId;
    return name
      .replace(/^(Claude|GPT|Gemini|Kimi|DeepSeek|Qwen|GLM)\s*/i, '')
      .replace(/-/g, ' ')
      .trim() || name;
  };

  /**
   * 旧消息 → 块序列。
   *
   * 新消息直接用 `message.blocks`；老消息只有 content / tool_calls / images
   * 三列（顺序信息已丢），由 `legacyToBlocks` 按旧版渲染顺序还原。
   * 三条分支最终都收敛到同一个渲染器 —— 这样「流式中」和「刷新后」
   * 不会再出现两种长相。
   */
  const toBlocks = useCallback((message: Message): Block[] => {
    if (message.blocks && message.blocks.length > 0) return message.blocks;

    if (message.contentBlocks && message.contentBlocks.length > 0) {
      return message.contentBlocks.map((b, i): Block => {
        if (b.type === 'text') {
          return { id: `cb-${i}`, type: 'text', text: b.text, state: 'done' };
        }
        if (b.type === 'image') {
          return { id: `cb-${i}`, type: 'image', image: b.image };
        }
        const t = b.toolCall;
        return {
          id: `cb-${i}`,
          type: 'tool',
          toolId: t.id,
          name: t.name,
          input: t.input,
          output: t.result,
          status:
            t.status === 'completed' ? 'completed' : t.status === 'error' ? 'failed' : 'running',
          isError: t.isError,
          startedAt: 0,
          endedAt: 0,
        };
      });
    }

    return legacyToBlocks({
      content: message.content,
      thinking: message.thinking,
      toolCalls: message.toolCalls,
      images: message.images,
    });
  }, []);

  /** 把一条消息导出成 Markdown（分享按钮用）：答案 + 思考 + 工具摘要 */
  const messageToMarkdown = (message: Message): string => {
    const parts: string[] = [];
    for (const b of toBlocks(message)) {
      if (b.type === 'text') {
        parts.push(b.text);
      } else if (b.type === 'thinking' && b.text) {
        parts.push(`> **思考过程**\n>\n> ${b.text.split('\n').join('\n> ')}`);
      } else if (b.type === 'tool') {
        const failed = b.status === 'failed' || b.isError;
        parts.push(`- 工具 \`${b.name}\`：${failed ? '失败' : '完成'}`);
      }
    }
    return parts.join('\n\n');
  };

  // 渲染单个内容块
  const renderBlock = (
    block: Block,
    index: number,
    isStreaming?: boolean,
    isLast?: boolean
  ): React.ReactNode => {
    if (block.type === 'text') {
      return (
        <div
          key={block.id}
          className="tc-bubble-assistant tc-answer min-w-0 max-w-full leading-relaxed break-words"
        >
          <div className="chat-markdown min-w-0 max-w-full">
            <ChatMarkdown content={block.text} />
          </div>
          {isStreaming && isLast && (
            <span className="animate-cursor-blink ml-0.5" style={{ color: 'var(--td-brand-color)' }}>
              |
            </span>
          )}
        </div>
      );
    }

    if (block.type === 'thinking') {
      return <ThinkingView key={block.id} block={block} />;
    }

    if (block.type === 'tool') {
      // 正常路径下 tool 块不会走到这里（renderAssistantContent 已把它们
      // 收进轨迹段）。留着这条兜底：万一将来有人单独渲染一个 tool 块，
      // 得到的是「一条只有一步的轨迹」，而不是空白。
      return <AgentTrace key={block.id} blocks={[block]} isStreaming={!!isStreaming} />;
    }

    if (block.type === 'image') {
      return <ImageBubble key={block.id} image={block.image} />;
    }

    if (block.type === 'artifact') {
      const isFileChanges = block.mediaType === 'application/vnd.opc.file-changes+json';
      const changedFiles = isFileChanges && Array.isArray(block.data)
        ? block.data.filter((item): item is { path: string; kind: string } =>
            !!item && typeof item === 'object' &&
            typeof (item as { path?: unknown }).path === 'string' &&
            typeof (item as { kind?: unknown }).kind === 'string'
          )
        : [];
      const imageData = block.mediaType.startsWith('image/') &&
        !!block.data && typeof block.data === 'object' &&
        (block.data as { encoding?: unknown }).encoding === 'base64' &&
        typeof (block.data as { content?: unknown }).content === 'string'
        ? (block.data as { content: string }).content
        : undefined;
      const safeArtifactHref = (() => {
        if (!block.uri) return undefined;
        if (block.uri.startsWith('/')) return block.uri;
        try {
          const url = new URL(block.uri);
          return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
        } catch {
          return undefined;
        }
      })();
      return (
        <div
          key={block.id}
          className="my-2 rounded-lg px-3 py-2"
          style={{ backgroundColor: 'var(--td-bg-color-container)', border: '1px solid var(--tc-divider)' }}
          data-artifact={block.id}
        >
          <div className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            {block.name}
          </div>
          {block.description && (
            <div className="mt-1 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
              {block.description}
            </div>
          )}
          <div className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {block.mediaType}
          </div>
          {safeArtifactHref && (
            <a
              className="mt-2 inline-flex text-caption underline"
              href={safeArtifactHref}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--td-brand-color)' }}
            >
              打开产物
            </a>
          )}
          {imageData && (
            <img
              className="mt-2 max-h-80 max-w-full rounded-md object-contain"
              src={`data:${block.mediaType};base64,${imageData}`}
              alt={block.description || block.name}
              loading="lazy"
            />
          )}
          {isFileChanges && (
            <ul className="mt-2 space-y-1 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
              {changedFiles.length ? changedFiles.map((file, fileIndex) => (
                  <li key={`${file.path}-${fileIndex}`} className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded px-1.5 py-0.5" style={{ backgroundColor: 'var(--td-bg-color-page-container)' }}>{file.kind}</span>
                    <code className="min-w-0 break-all">{file.path}</code>
                  </li>
                )) : <li>未记录文件变更</li>}
            </ul>
          )}
          {block.data !== undefined && !imageData && !isFileChanges && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
              {typeof block.data === 'string' ? block.data : JSON.stringify(block.data, null, 2)}
            </pre>
          )}
        </div>
      );
    }

    return (
      <div key={block.id} className="flex justify-center py-0.5">
        <span
          className="rounded-full px-3 py-1 text-caption"
          style={{
            backgroundColor: 'var(--td-bg-color-secondarycontainer)',
            color: 'var(--td-text-color-placeholder)',
          }}
        >
          {block.text}
        </span>
      </div>
    );
  };

  // 渲染 assistant 消息内容
  /**
   * 一条助手回复 → 块序列（A36：工具与思考合成「执行轨迹」）。
   *
   * 分组规则：从第一个 `tool` 块起，把后面**连续的** tool / thinking 块一并吞进来，
   * 交给 `AgentTrace` 渲染成一条轨迹；遇到 text 就断开。
   *
   * 为什么思考块要被吞进去：思考紧跟在某次工具调用之后时，它是「为什么这么调」的
   * 注解，单独占一行会和步骤平级、抢位置。交给 AgentTrace 之后它会缩进挂到
   * 上一个步骤下面（见 trace.ts 的 buildTrace）。
   *
   * 为什么开头的思考块**不**吞：没有可挂的父级，硬塞进轨迹只会得到一条
   * 「0 步」的空壳；它继续走 ThinkingView，保持「先思考后作答」的老观感。
   *
   * 按「连续」而非「全部」分组，是为了保留「工具 → 文本 → 工具」这种交错顺序
   * （文本是模型对上一批工具结果的解释，位置有语义）。
   */
  const renderAssistantContent = (message: Message) => {
    // 失败原因。后端会把真实错误（未登录 / 网络不可达 / 退出码）带上来，
    // 这里原样展示，不用「发生错误请重试」这种无信息量的文案盖掉它。
    const errorBlock = message.error ? (
      <div
        className="mt-2 whitespace-pre-wrap break-words rounded-xl px-3.5 py-2.5 text-secondary leading-relaxed"
        style={{
          backgroundColor: 'var(--td-error-color-1)',
          color: 'var(--td-error-color-6)',
        }}
      >
        <div className="mb-1 font-medium">调用失败</div>
        {message.error}
      </div>
    ) : null;

    const blocks = toBlocks(message);
    const nodes: React.ReactNode[] = [];

    let i = 0;
    while (i < blocks.length) {
      const block = blocks[i];
      if (block.type === 'tool') {
        const group: Block[] = [];
        let j = i;
        while (
          j < blocks.length &&
          (blocks[j].type === 'tool' || blocks[j].type === 'thinking')
        ) {
          group.push(blocks[j]);
          j++;
        }
        nodes.push(
          <AgentTrace
            key={`trace-${group[0].id}`}
            blocks={group}
            isStreaming={!!message.isStreaming}
          />
        );
        i = j;
      } else {
        nodes.push(
          renderBlock(block, i, message.isStreaming, i === blocks.length - 1)
        );
        i++;
      }
    }

    return (
      <>
        {nodes}
        {errorBlock}
      </>
    );
  };
  /**
   * 编排叙述行（group_note）。
   *
   * 渲染成居中的弱化文字而不是气泡：它是**过程说明**（「主控决定交给
   * OpenCode」「第 2/2 棒」），不是谁的发言。做成气泡会让用户误以为
   * 某个 Agent 说了这句话，也会把真正的发言挤出视觉焦点。
   */
  const renderNote = (message: Message) => (
    <div key={message.id} className="flex justify-center py-1" data-note>
      <span
        className="text-caption"
        style={{ color: 'var(--td-text-color-placeholder)' }}
      >
        · {message.content}
      </span>
    </div>
  );

  /**
   * 后台任务的第二个来源：本轮**已经结束**，但工具调用还停在 running 的那些。
   * 只数已结束的消息 —— 正在流式的那一轮里，running 是正常状态，不是「遗留」。
   */
  const lingeringCount = messages.reduce((n, m) => {
    if (m.role !== 'assistant' || m.isStreaming) return n;
    return n + lingeringToolBlocks(toBlocks(m), true).length;
  }, 0);

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 max-w-[800px] mx-auto flex-col gap-6"
      /* 消息行容器的稳定锚点。此前 `verify:groupchat` 是按
         `max-w-3xl` 这个**宽度类名**找它的，宽度一改成 `max-w-[800px]`
         整段断言就静默空转（rows=[]，于是「作者名标签」全红而看不出原因）。
         宽度是设计变量，不该被测试依赖 —— 留个 data 钩子。 */
      data-msg-list
      onCopy={handleCopy}
    >
      {messages.map(message => {
        // 编排叙述行：不套气泡外壳，直接居中一行
        if (message.note) return renderNote(message);

        const msgAgent = resolveAgent(message.agentId);
        // 这条消息是不是生图产物（新数据走 blocks，老数据走 contentBlocks / images）
        const msgIsImage = !!(
          (message.images && message.images.length > 0) ||
          message.blocks?.some(b => b.type === 'image') ||
          message.contentBlocks?.some(b => b.type === 'image')
        );
        // P6 成本统计：助手消息的用量小字。没有数据返回 null，整行省掉
        //
        // A36：耗时已经挪到头部（「已处理 47m42s」），这里只在**有费用或 token**
        // 时才渲染 —— 否则同一轮会出现两个时长（头部 47m42s + 这里 2862.0s），
        // 而且底下那个还带着一位小数，读起来像两条不同的数据。
        const usageText =
          message.role === 'assistant' && (message.cost || message.tokens)
            ? formatUsage(message)
            : null;

        /**
         * A55：消息级「复制全部代码 / 自动换行」已删。Cherry 代码块自带
         * 复制按钮（Shadow DOM 内），跨块需求由「复制回答」覆盖；
         * 换行开关绝大多数场景用不到。这里不再从纯文本解析围栏。
         */

        return (
        <div
          key={message.id}
          // A35：助手侧整条改成纵向（头部一行 + 正文一行），用户侧保持
          // 「头像在右、气泡在左」的横向排布。
          className={
            message.role === 'user'
              ? 'tc-msg-enter flex flex-row-reverse gap-3'
              : 'tc-msg-enter flex min-w-0 max-w-full flex-col gap-2'
          }
        >
          {message.role === 'user' ? (
            // 用户侧：品牌色圆 + 人像图标。用户没有「官方 logo」，
            // 与 Agent 侧的品牌 logo 形成清晰的左右对照。
            //
            // A26：底色从「品牌色实心」改成**随透明度在实心与淡底之间插值**。
            // 实心圆在 100% 透明度下是玻璃上的一颗黑点（深色主题是一颗白点），
            // 是用户报的「扎眼」里最集中的一处。
            //
            // 为什么不直接换成淡底：那会连不透明模式下的观感一起改掉，
            // 而那一档用户是认可的。用 color-mix 按 --opc-t 插值，t=0 时
            // 100% 品牌色（与原来完全一致），t=1 时 100% 淡底 —— 中间平滑过渡。
            // 图标色同理：白 → 品牌色，否则淡底上的白图标会消失。
            <div
              className="w-9 h-9 flex items-center justify-center flex-shrink-0 rounded-full self-start"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--td-brand-color) calc((1 - var(--opc-t, 0)) * 100%), var(--td-brand-color-light))',
                color:
                  'color-mix(in srgb, #fff calc((1 - var(--opc-t, 0)) * 100%), var(--td-brand-color))',
              }}
            >
              <User size={18} />
            </div>
          ) : null}

          {/* A35（用户反馈）：助手侧改成「头部一行 + 正文另起一行」。
              用户原话：「模型回答的内容，不能与 logo 放在同一行，要换行，
              logo 后面展示的是 agent 的名字」。

              改前头像与正文是同一行 flex 的两个子项，正文的第一行就贴在
              logo 右边，读起来像「这个 logo 在说话」；而且非群聊时那行小字
              显示的是**模型名**，用户根本看不到「是谁在回答」。
              现在：头部 = 头像 + Agent 名 + （模型名，作为次要信息跟在后
              面），正文整宽从下一行开始。群聊与单聊用同一套头部，不再分叉。 */}
          {message.role === 'assistant' && (
            <div className="flex min-w-0 items-center gap-2" data-msg-header>
              {msgIsImage ? (
                // 生图产物用**专属**头像：图是生图 provider 画的，不是会话绑定的
                // 那个 Agent 画的。套用它的头像会让人以为「Hermes 会画图」。
                // A26：同样按透明度插值到淡底（理由见上面用户头像）。
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, #D54941 calc((1 - var(--opc-t, 0)) * 100%), rgb(213 73 65 / 0.14))',
                    color: 'color-mix(in srgb, #fff calc((1 - var(--opc-t, 0)) * 100%), #D54941)',
                  }}
                  title="图像生成"
                >
                  <ImageIcon size={14} />
                </div>
              ) : (
                // 头像是按钮：点它弹出这个 Agent 的详情（P7）——
                // 用户看到头像的第一直觉就是「这是谁，点开看看」。
                <button
                  type="button"
                  onClick={() => {
                    const id = message.agentId || msgAgent?.id;
                    if (onShowAgentDetail && id) onShowAgentDetail(id);
                  }}
                  disabled={!onShowAgentDetail}
                  title={msgAgent ? `${msgAgent.name} · 查看详情` : undefined}
                  aria-label={msgAgent ? `查看 ${msgAgent.name} 的详情` : undefined}
                  data-agent-avatar={message.agentId || msgAgent?.id || undefined}
                  className="shrink-0 rounded-full transition-transform hover:scale-105 disabled:cursor-default disabled:hover:scale-100"
                >
                  <AgentAvatar
                    id={message.agentId || msgAgent?.id || 'assistant'}
                    name={msgAgent?.name || 'Agent'}
                    icon={msgAgent?.icon}
                    color={msgAgent?.color}
                    size={26}
                    showStatus={false}
                  />
                </button>
              )}
              <span
                className="min-w-0 truncate text-caption font-medium"
                style={{ color: 'var(--td-text-color-secondary)' }}
                data-msg-agent={msgAgent?.id || undefined}
              >
                {msgIsImage ? '图像生成' : msgAgent?.name || 'Agent'}
              </span>
              {!msgIsImage && message.model && (
                <span
                  className="shrink-0 text-caption"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  · {formatModelName(message.model)}
                </span>
              )}
              {/* A36：本轮总耗时。参考图把它放在头部右端（「已处理 47m42s」）——
                  它描述的是**这一轮**，不是某一步，放在步骤里反而会被误读成单步耗时。
                  流式中不显示：那一刻还没跑完，写死一个不断变大的数会和下面
                  状态行的秒数打架。 */}
              {!msgIsImage && !message.isStreaming && formatHandledDuration(message.durationMs) && (
                <span
                  className="ml-auto shrink-0 text-caption tabular-nums"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                  data-msg-duration
                >
                  已处理 {formatHandledDuration(message.durationMs)}
                </span>
              )}
            </div>
          )}

          <div
            className={`flex flex-col gap-2 ${message.role === 'user' ? 'items-end max-w-[80%] ml-auto tc-user-msg' : 'min-w-0 max-w-full'}`}
          >

            {/* 用户消息 */}
            {message.role === 'user' && (
              <div className="tc-bubble-user px-4 py-3 leading-relaxed break-words">
                {message.content}
              </div>
            )}

            {/* 用户消息操作行（A49）：复制 / 编辑 / 分享。
                位置与助手侧对称 —— 助手在正文下方、用户在自己的气泡下方；
                因为外层是 `items-end`，这一行自然右对齐贴在气泡右下。
                A55：默认隐藏，只在悬停 / 聚焦这条用户消息时淡入
                （见 index.css 的 .tc-actions-user）。 */}
            {message.role === 'user' && (
              <UserMessageActions
                text={message.content}
                onEdit={onEditMessage ? () => onEditMessage(message) : undefined}
              />
            )}

            {/* 助手消息 - 按顺序渲染内容块 */}
            {message.role === 'assistant' && renderAssistantContent(message)}

            {/* 流式状态行（A34）：从发出请求到最后一条 token 全程在线、
                秒数在涨；文案按阶段变化（正在处理 / 思考 / 调用工具 / 生成）。
                imageMode 时固定为「正在生成图像」。 */}
            {message.role === 'assistant' && message.isStreaming && !message.error && (
              <StreamStatus
                startedAt={message.timestamp?.getTime()}
                blocks={message.blocks}
                imageMode={imageMode}
              />
            )}

            {/* A97：验证状态条。只在这条回答**真的改过文件**时出现 ——
                纯问答不需要「跑测试」入口。未验证也照样显示（它是显式状态），
                不能因为没数据就整块消失，否则用户会默认「应该没问题」，
                而这正是「Agent 说完成就算完成」那个洞。 */}
            {message.role === 'assistant' &&
              !message.isStreaming &&
              !message.error &&
              !!message.id &&
              !!currentSessionId &&
              hasFileEdits(toBlocks(message)) && (
                <VerifyPanel
                  sessionId={currentSessionId}
                  messageId={message.id}
                  cwd={sessionCwd}
                  rows={verifications.filter(v => v.message_id === message.id)}
                  onUpdated={refreshVerifications}
                />
              )}

            {/* A99：文件核对。与上面那条「验证」并排 ——
                验证回答「能不能跑」，核对回答「到底有没有落地」，
                两件事互不替代。同样只在这轮真的改过文件时出现。 */}
            {message.role === 'assistant' &&
              !message.isStreaming &&
              !message.error &&
              !!message.id &&
              !!currentSessionId &&
              hasFileEdits(toBlocks(message)) && (
                <FileEvidencePanel sessionId={currentSessionId} messageId={message.id} />
              )}

            {/* P6 成本统计：耗时 / 费用 / token 一行小字，跟在气泡下面。
                没有用量数据时 formatUsage 返回 null，整行不渲染 ——
                不显示「0 秒 · $0.00」冒充「这次没花钱」。 */}
            {message.role === 'assistant' && usageText && (
              <span
                className="text-caption"
                style={{ color: 'var(--td-text-color-placeholder)' }}
                data-usage={usageText}
              >
                {usageText}
              </span>
            )}

            {/* 消息操作行：复制 / 重新生成 / 分享 / 分支（A55 删了赞踩与代码两个）。
                只在「流式已结束、且没有报错」时出现 —— 正在生成或报错时不给
                用户提供对半成品的操作。 */}
            {message.role === 'assistant' && !message.isStreaming && !message.error && (
              <MessageActions
                text={textOfBlocks(toBlocks(message))}
                shareText={messageToMarkdown(message)}
                onRegenerate={onRegenerate ? () => onRegenerate(message) : undefined}
                onBranch={onBranch ? () => onBranch(message) : undefined}
              />
            )}
          </div>
        </div>
        );
      })}
      
      {/* 内联权限确认 - 横向简洁展示。
          A35：去掉 `ml-12` —— 那是给「头像 36 + 间距 12」让位的旧缩进，
          现在助手侧正文已经整宽铺满（头像在头部那一行），再缩 48px 就会
          比上下消息都往右错一截。 */}
      {permissionRequest && onPermissionAllow && onPermissionDeny && (
        <div className="flex gap-3">
          <InlinePermissionCard
            request={permissionRequest}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
          />
        </div>
      )}
      
      <div ref={messagesEndRef} />
      {/* 后台任务胶囊（A36）：整条列表只挂一颗 —— 每条消息都挂的话，
          同一个数字会在屏幕上重复十遍。放在消息末尾、输入框上方，
          视线正好落在「刚看完的内容」和「准备输入的地方」之间。 */}
      <BackgroundTasksPill
        tasks={backgroundTasks}
        lingering={lingeringCount}
        onOpen={onOpenSession}
      />
      {/* 选区工具条：复制 / 引用。portal 到 body，避免被滚动容器裁掉 */}
      <SelectionToolbar rootRef={rootRef} onQuote={onQuote} />
    </div>
  );
}
