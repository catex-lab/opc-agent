/**
 * 执行轨迹（A36）—— 替代 A35 的「步骤时间线」。
 *
 * ## 与 A35 的差别
 *
 * A35 已经把「卡片」换成了「一行一步 + 竖线」，但那还是**逐条罗列**：
 * 用户要滚动完 20 行才知道「它到底动了哪些文件」。这一版补上参考图里
 * 真正有价值的三样东西：
 *
 *   1. **活动摘要**：整条轨迹压成一句话（`编辑、已读取：SettingsPage.tsx`），
 *      收起时它就是那一行，展开时它仍在顶部 —— 任何时候都知道「干了什么」。
 *   2. **diff 统计**：文件类步骤后面跟 `+109 -16`，一眼看出改动量。
 *   3. **嵌套思考**：紧跟在某个工具后面的思考节点缩进挂到它下面，
 *      带一条连接线，默认收起一行「深度思考」。
 *
 * 底部还有一层**渐隐遮罩**：轨迹超过可视高度时，最后一行淡出，
 * 提示「下面还有」，而不是硬切一刀。
 *
 * ## 展开策略（既定口径）
 *
 * 完成态**默认收起**（长会话里一条消息挂 20 行会把上下文冲散），
 * 但流式过程中默认展开 —— 用户此刻正在盯着它干活。
 * 用户手动切过之后就不再自动干预。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Terminal,
  Sparkles,
  Search,
  Globe,
  Wrench,
  FileText,
  Eye,
  Edit,
  Trash2,
  FolderSearch,
  Image as ImageIcon,
  Zap,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  type LucideIcon,
} from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  buildDiffHunks,
  buildTrace,
  formatHandledDuration,
  formatStepDuration,
  summarizeTrace,
  type TraceDiff,
  type TraceItem,
} from '../../shared/trace';
import { DiffView } from './DiffView';
import { useOverflowY } from '../hooks/useOverflowY';

/**
 * 工具 → 图标 + 颜色。
 *
 * 颜色全部走 index.css 的 `--tool-color-*` 语义变量：字面量无法跟随深浅主题，
 * 深色下 Ant Design 那套蓝绿会发闷。入参一律 `String()` 兜底 —— 历史上
 * `tool.name` 缺失时这里抛过一次 `toLowerCase of undefined`，
 * 而它发生在消息列表渲染中，直接把整屏打成白屏。
 */
function iconOf(toolName: string): { icon: LucideIcon; color: string } {
  switch (toolName) {
    case 'skill':
      return { icon: Sparkles, color: 'var(--tool-color-skill)' };
    case 'bash':
    case 'shell':
    case 'execute':
      return { icon: Terminal, color: 'var(--tool-color-shell)' };
    case 'websearch':
    case 'search':
    case 'grep':
    case 'glob':
      return { icon: Search, color: 'var(--tool-color-search)' };
    case 'webfetch':
      return { icon: Globe, color: 'var(--tool-color-network)' };
    case 'write':
    case 'writefile':
    case 'create_file':
      return { icon: FileText, color: 'var(--tool-color-file)' };
    case 'read':
    case 'readfile':
      return { icon: Eye, color: 'var(--tool-color-file)' };
    case 'edit':
    case 'editfile':
    case 'multiedit':
    case 'str_replace_editor':
      return { icon: Edit, color: 'var(--tool-color-file)' };
    case 'delete':
    case 'deletefile':
      return { icon: Trash2, color: 'var(--tool-color-danger)' };
    case 'listdir':
    case 'ls':
      return { icon: FolderSearch, color: 'var(--tool-color-file)' };
    case 'imagegen':
      return { icon: ImageIcon, color: 'var(--tool-color-file)' };
    case 'task':
      return { icon: Zap, color: 'var(--tool-color-task)' };
    default:
      return { icon: Wrench, color: 'var(--td-text-color-secondary)' };
  }
}

const DETAIL_LIMIT = 500;

/**
 * 明细里的输出块。
 *
 * 流式中贴底滚动并显示**尾部**（最新内容在末尾，截头部会让用户以为卡住）；
 * 结束后显示**头部**（那才是「这条命令在干什么」的上下文）。
 */
function OutputBox({
  label,
  text,
  running,
  isError,
}: {
  label: string;
  text: string;
  running: boolean;
  isError?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!running) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [running, text]);

  if (!text) return null;
  const shown =
    text.length > DETAIL_LIMIT
      ? running
        ? `…\n${text.slice(-DETAIL_LIMIT)}`
        : `${text.slice(0, DETAIL_LIMIT)}\n…`
      : text;

  return (
    <div
      ref={ref}
      className="tc-step-detail"
      style={{ color: isError ? 'var(--td-error-color)' : undefined }}
      data-tool-output
    >
      <span style={{ color: 'var(--td-text-color-placeholder)' }}>
        {running ? '输出中' : isError ? '错误' : label}:{' '}
      </span>
      {shown}
    </div>
  );
}

/** `+109 -16` / `+12` / `±0` —— 三种口径各自对应「有真实 diff / 只知新增 / 没有数据」 */
function DiffTag({ diff }: { diff: TraceDiff }) {
  if (diff.known) {
    return (
      <span className="tc-diff" data-diff={`+${diff.added} -${diff.removed}`}>
        <span className="tc-diff-add">+{diff.added}</span>
        <span className="tc-diff-del">-{diff.removed}</span>
      </span>
    );
  }
  if (diff.added > 0) {
    return (
      <span className="tc-diff" data-diff={`+${diff.added}`}>
        <span className="tc-diff-add">+{diff.added}</span>
      </span>
    );
  }
  // 没有 diff 数据：按既定口径显示 ±0，而不是留空 ——
  // 留空会让「读文件」和「没读到东西」看起来一样。
  return (
    <span className="tc-diff" data-diff="±0">
      <span className="tc-diff-none">±0</span>
    </span>
  );
}

/**
 * 思考节点（方案 C）：缩进挂在上一个工具下面，一行「深度思考」+ 字数 + 秒数。
 *
 * 排版与方案 A 同一套语言（头部 12px secondary、正文正体沿 2px 左细线铺开），
 * 只降半档字号、缩进更浅 —— 它挂在轨迹里，左边已经被缩进吃掉 18px。
 *
 * 为什么不再用 `.tc-step-detail`（等宽 12px + 3% 底）：那是**工具输出**的语言，
 * 机器文本等宽才对；思考是自然语言，套等宽 + 最淡一档灰，长推理比工具输出还难读。
 *
 * `collapse`：这条消息已经有正文了。既定口径是「输出正文前折叠上面的」——
 * 答案出现后，过程让位，不再自动铺开。
 */
function ThinkingNode({ item, collapse = false }: { item: TraceItem; collapse?: boolean }) {
  const t = item.thinking;
  if (!t) return null;
  const running = t.state === 'streaming';
  // 被厂商隐去的思考：正文是密的，但「确实想过一段」是事实。
  // 这里既不能伪造内容，也不能什么都不显示 —— 空一行、标明「已隐去」最诚实。
  const redacted = !!t.redacted;
  const secs = item.durationMs != null ? Math.max(1, Math.round(item.durationMs / 1000)) : null;

  const row = (
    <>
      <Sparkles size={12} style={{ flexShrink: 0 }} />
      <span className="tc-think-note-title">
        {redacted ? '已隐去' : running ? '深度思考中' : '深度思考'}
      </span>
      {!redacted && t.format === 'summary' && <span className="tc-think-badge">摘要</span>}
      <span className="tc-think-note-meta">
        {redacted ? '内容被厂商隐去' : `${t.text.length} 字`}
      </span>
      {secs != null && <span className="tc-think-note-meta">{secs}s</span>}
    </>
  );

  return (
    <div className="tc-trace-nested" data-trace-thinking={item.id}>
      {redacted ? (
        // 没有正文就没有可展开的东西：渲染成一行静态说明，而不是一个点了没反应的折叠条
        <div className="tc-thinking tc-think-note" data-redacted="1">
          <div className="tc-think-note-redacted">{row}</div>
        </div>
      ) : (
        <details className="tc-thinking tc-think-note" open={running && !collapse}>
          <summary>{row}</summary>
          <div className="tc-think-note-body">{t.text}</div>
        </details>
      )}
    </div>
  );
}

/** 展开明细：不同工具只差在「哪几段」，样式统一交给 .tc-step-detail */
function detailOf(item: TraceItem): ReactNode {
  const input = item.block?.input ?? {};
  const name = item.toolName;

  if (name === 'skill') {
    const args = String(input.args ?? '');
    return args ? <div className="tc-step-detail">{args.slice(0, 300)}</div> : null;
  }
  if (name === 'bash' || name === 'shell' || name === 'execute') {
    const cmd = String(input.command ?? '');
    if (!cmd) return null;
    return (
      <div className="tc-step-detail">
        <span style={{ color: 'var(--td-text-color-placeholder)' }}>$ </span>
        {cmd.slice(0, DETAIL_LIMIT)}
      </div>
    );
  }
  if (name === 'webfetch') {
    const url = String(input.url ?? '');
    return url ? (
      <div className="tc-step-detail">
        <span style={{ color: 'var(--td-text-color-placeholder)' }}>URL: </span>
        {url}
      </div>
    ) : null;
  }
  if (item.path) {
    const content = String(input.content ?? '');
    return (
      <div className="tc-step-detail">
        <div style={{ color: 'var(--td-text-color-placeholder)' }}>{item.path}</div>
        {content && <div className="mt-1">{content.slice(0, 1000)}</div>}
      </div>
    );
  }
  if (Object.keys(input).length === 0) return null;
  let json = '';
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return (
    <div className="tc-step-detail">
      <span style={{ color: 'var(--td-text-color-placeholder)' }}>输入: </span>
      {json.slice(0, 300)}
    </div>
  );
}

/** 单步 */
function StepRow({ item, collapse = false }: { item: TraceItem; collapse?: boolean }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, color } = iconOf(item.toolName);
  const detail = item.kind === 'tool' ? detailOf(item) : null;
  // A96：文件类工具优先给行级 diff。没有 diff 数据（read / delete / 未知工具）
  // 时返回 null，这里自动退回原来的明细渲染 —— 两条路互斥，不会重复显示。
  const hunks = useMemo(
    () =>
      item.kind === 'tool' && item.block ? buildDiffHunks(item.toolName, item.block.input) : null,
    [item.kind, item.toolName, item.block]
  );
  const hasDetail = hunks != null || detail != null || !!item.block?.output;

  const meta =
    item.status === 'running'
      ? '执行中…'
      : item.status === 'interrupted'
        ? // 与「失败」分开说：失败是确定的坏消息，未回传可能还在后台跑
          '结果未回传'
        : item.status === 'error'
          ? '失败'
          : formatStepDuration(item.durationMs) ?? '';
  const stepState =
    item.status === 'running'
      ? 'running'
      : item.status === 'error'
        ? 'error'
        : item.status === 'interrupted'
          ? 'interrupted'
          : 'done';

  return (
    <div
      className={`tc-step is-${stepState}`}
      data-tool-step={item.id}
      data-trace-verb={item.verb}
    >
      <span className="tc-step-dot" aria-hidden="true" />
      <div
        className="tc-step-head"
        data-clickable={hasDetail ? '1' : undefined}
        data-expanded={hasDetail ? (open ? '1' : '0') : undefined}
        onClick={hasDetail ? () => setOpen(v => !v) : undefined}
        role={hasDetail ? 'button' : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? open : undefined}
        onKeyDown={
          hasDetail
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen(v => !v);
                }
              }
            : undefined
        }
        title={item.path}
      >
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span className="tc-trace-verb">{item.verb}</span>
        {item.target && <span className="tc-trace-target">{item.target}</span>}
        {item.diff && <DiffTag diff={item.diff} />}
        {/* A100：事件来源标签。**只标纯文本解析那一种** —— 原生 / 结构化
            输出是绝大多数，逐条标出来反而把轨迹刷满噪音；而「解析出来的」
            是少数且可信度低一档，值得让人一眼看见。
            A102：标签挪到耗时**前面**，并且不再复用 `.tc-trace-meta`。
            那个类带 `margin-left:auto`，两个自动边距会把行内剩余空间对半
            分，耗时从此贴不到右缘（实测同轮 600ms 停在 x=915，别行 200ms
            在 x=1284）。现在只有耗时带 auto，每行右缘一致。 */}
        {item.kind === 'tool' && item.block?.source === 'parsed_text' && (
          <span
            className="tc-trace-src"
            data-trace-source="parsed_text"
            title="这个 Agent 只输出纯文本，工具事件由 OPC 从输出里解析得出。与官方结构化事件相比，这一步的可信度低一档"
          >
            文本解析
          </span>
        )}
        {meta && (
          <span className="tc-trace-meta" data-trace-status={item.status}>
            {meta}
          </span>
        )}
      </div>
      {open && (
        <>
          {hunks ? <DiffView hunks={hunks} /> : detail}
          <OutputBox
            label="输出"
            text={item.block?.output ?? ''}
            running={item.status === 'running'}
            isError={item.status === 'error'}
          />
        </>
      )}
      {item.nested.length > 0 && (
        <div className="tc-trace-nest">
          {item.nested.map(n => (
            <ThinkingNode key={n.id} item={n} collapse={collapse} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface AgentTraceProps {
  /** 一条轨迹段：连续的「工具 / 思考」块 */
  blocks: readonly Block[];
  /** 这一轮是否还在流式（决定默认展开 + 自动贴底） */
  isStreaming?: boolean;
  /** 这条消息已经有正文：收起轨迹，把版面让给答案（既定口径） */
  collapse?: boolean;
}

/** 折叠过渡时长（ms）。改这里必须同步 index.css 的 `.tc-trace-fold`。 */
const FOLD_MS = 220;

export function AgentTrace({ blocks, isStreaming = false, collapse = false }: AgentTraceProps) {
  const items = useMemo(() => buildTrace(blocks), [blocks]);
  const summary = useMemo(() => summarizeTrace(items), [items]);

  // 既定口径：完成态默认收起；流式中默认展开。
  // 手动切过之后不再自动干预（否则用户刚展开就被「跑完」那一刻关掉）。
  const [expanded, setExpanded] = useState(!!isStreaming);
  const touched = useRef(false);
  const prevStreaming = useRef(!!isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming && !touched.current) setExpanded(false);
    prevStreaming.current = !!isStreaming;
  }, [isStreaming]);

  // 正文开始输出 → 收起。同样尊重手动选择：用户自己点开过就不再抢。
  useEffect(() => {
    if (collapse && !touched.current) setExpanded(false);
  }, [collapse]);

  /**
   * 折叠动画要「先挂住再卸」。
   *
   * 直接 `expanded && <div>` 会让 300px 高的轨迹在一帧内消失，答案猛地往上跳；
   * 一直挂在 DOM 里又会让收起态白养一棵子树（`verify-a36` 明着断言
   * 「收起时步骤不渲染」）。所以：收起时先留着播 220ms 过渡，播完再卸载。
   */
  const [showBody, setShowBody] = useState(expanded);
  useEffect(() => {
    if (expanded) {
      setShowBody(true);
      return;
    }
    const timer = setTimeout(() => setShowBody(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [expanded]);

  const toggle = () => {
    touched.current = true;
    setExpanded(v => !v);
  };

  const running = items.some(i => i.status === 'running');
  const failed = items.some(i => i.status === 'error');
  const interrupted = items.some(i => i.status === 'interrupted');
  const stepCount = items.filter(i => i.kind === 'tool').length;
  const totalMs = items.reduce((s, i) => s + (i.durationMs ?? 0), 0);
  const durationText = formatHandledDuration(totalMs);

  // 渐隐遮罩：只有真的溢出时才淡出，否则短轨迹末尾会莫名其妙变虚
  const { ref: scrollRef, el: scrollEl, overflowing } = useOverflowY<HTMLDivElement>();

  // 流式中贴底：新步骤永远在末尾，不贴底就看不到它
  useEffect(() => {
    if (!running || !expanded) return;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [running, expanded, showBody, items.length, scrollEl]);

  if (items.length === 0) return null;

  /**
   * 汇总行文案。
   *
   * 刻意**不**在运行中替换成「执行中…」：那句话把最有信息量的东西（干了什么）
   * 盖掉了，而且和下面的呼吸灯重复。运行中的状态由圆点表达，文字始终是摘要 ——
   * 流式过程中它还会随新步骤不断变化，本身就是「在动」的证据。
   */
  const barLabel = summary.text || (expanded ? '收起步骤' : '查看步骤');
  const showTotalDiff = summary.diff.added > 0 || summary.diff.removed > 0;

  return (
    <div className="tc-trace" data-trace data-trace-state={running ? 'running' : 'done'}>
      <div
        className="tc-steps-bar"
        data-steps-bar
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {expanded ? (
          <ChevronUp size={13} style={{ color: 'var(--td-text-color-placeholder)', flexShrink: 0 }} />
        ) : (
          <ChevronDown size={13} style={{ color: 'var(--td-text-color-placeholder)', flexShrink: 0 }} />
        )}
        {running ? (
          <span className="tc-live-dot" aria-hidden="true">
            <span className="tc-live-core" style={{ backgroundColor: 'var(--td-brand-color)' }} />
            <span className="tc-live-ring" style={{ borderColor: 'var(--td-brand-color)' }} />
          </span>
        ) : failed ? (
          <CircleX size={13} style={{ color: 'var(--td-error-color)', flexShrink: 0 }} />
        ) : interrupted ? (
          // 不画绿勾：这一轮结束了，但至少有一个工具没回结果。
          // 空心圈 = 「不确定」，比打勾诚实，也比打叉克制。
          <span className="tc-unknown-dot" aria-hidden="true" data-unknown-dot />
        ) : (
          <CircleCheck size={13} style={{ color: 'var(--td-success-color)', flexShrink: 0 }} />
        )}
        <span className="tc-trace-summary" data-trace-summary title={summary.text}>
          {barLabel}
        </span>
        <span className="tc-trace-count" data-trace-count>
          {stepCount} 步
        </span>
        {showTotalDiff && (
          <span className="tc-diff" data-diff-total={`+${summary.diff.added} -${summary.diff.removed}`}>
            <span className="tc-diff-add">+{summary.diff.added}</span>
            <span className="tc-diff-del">-{summary.diff.removed}</span>
          </span>
        )}
        {durationText && <span className="tc-trace-meta">{durationText}</span>}
      </div>

      {showBody && (
        <div className="tc-trace-fold" data-trace-fold data-fold={expanded ? '1' : '0'}>
          <div className="tc-trace-fold-inner">
            <div
              ref={scrollRef}
              className="tc-trace-scroll tc-scroll-fade"
              data-trace-scroll
              data-fade={overflowing ? '1' : undefined}
            >
              <div className="tc-steps">
                {items.map(item =>
                  item.kind === 'thinking' ? (
                    <div key={item.id} className="tc-trace-solo">
                      <ThinkingNode item={item} collapse={collapse} />
                    </div>
                  ) : (
                    <StepRow key={item.id} item={item} collapse={collapse} />
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentTrace;
