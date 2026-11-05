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
 * 手动切过之后就不再自动干预。
 *
 * 正文收拢（2026-11-03 生产口径）：`collapse` 只在「最后一个工具之后出现
 * 非空正文」时为真，因此它等价于**首个正文内容 token**，而不是任意首 token。
 * 它变真即收拢；之后若又有工具事件（`collapse` 回落），重新展开，
 * 等正文再次出现或新步骤结束后再收拢。摘要条始终保留，就是展开出口。
 *
 * 单步明细（2026-10-30）：执行中默认展开，**执行完立即收起**；
 * 写入/编辑、删除、权限、报错四类关键步骤完成后仍保持展开。
 * 完成判定见 `src/trace/fold.ts`：真实结束事件优先，缺失时才用
 * 「下一条事件视为上一步完成」兜底，没有后续事件的长耗时步骤不会假装完成。
 * 整条过程流的字号/行高统一为 14px / 1.7（见 index.css `.tc-trace`）。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Brain,
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
  type LucideIcon,
} from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  buildDiffHunks,
  formatHandledDuration,
  formatStepDuration,
  summarizeTrace,
  type TraceDiff,
  type TraceItem,
} from '../../shared/trace';
import { DiffView } from './DiffView';
import { useOverflowY } from '../hooks/useOverflowY';
import {
  hasUnreturnedResult,
  shouldAutoFoldOnTurnEnd,
  type ResolvedTraceItem,
} from '../trace/fold';
import { buildTraceRows, isNarration, stepRows } from '../trace/rows';
import '../trace/traceFold.css';

/**
 * 工具 → 图标 + 颜色。
 *
 * 单色化（2026-10-30 改版）：图标一律 secondary 灰，状态区分靠形状
 * （✓/✗/空心圈/脉冲点），不靠颜色。`--tool-color-*` 令牌保留在 index.css 备用。
 * 入参一律 `String()` 兜底 —— 历史上 `tool.name` 缺失时这里抛过一次
 * `toLowerCase of undefined`，而它发生在消息列表渲染中，直接把整屏打成白屏。
 */
function iconOf(toolName: string): LucideIcon {
  switch (toolName) {
    case 'skill':
      return Sparkles;
    case 'bash':
    case 'shell':
    case 'execute':
      return Terminal;
    case 'websearch':
    case 'search':
    case 'grep':
    case 'glob':
      return Search;
    case 'webfetch':
      return Globe;
    case 'write':
    case 'writefile':
    case 'create_file':
      return FileText;
    case 'read':
    case 'readfile':
      return Eye;
    case 'edit':
    case 'editfile':
    case 'multiedit':
    case 'str_replace_editor':
      return Edit;
    case 'delete':
    case 'deletefile':
      return Trash2;
    case 'listdir':
    case 'ls':
      return FolderSearch;
    case 'imagegen':
      return ImageIcon;
    case 'task':
      return Zap;
    default:
      return Wrench;
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
      <Brain size={12} style={{ flexShrink: 0 }} />
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

/** 折叠过渡时长（ms）。改这里必须同步 traceFold.css 与 index.css 的 `.tc-trace-fold`。 */
const FOLD_MS = 220;

/**
 * F4：贴底跟随的时间预算（ms）。
 *
 * 原来是「连续 12 帧」。帧数是**帧率的函数**：120Hz 屏上 12 帧只有 100ms，
 * 180ms 的明细展开动画还没走完就停了（当前步被顶到折叠线以下）；
 * 掉帧的机器上 12 帧又能拖到 400ms+，白白占着主线程。
 *
 * 这条轨迹里跟「高度还在长」有关的动画只有两个：明细展开 180ms、
 * 折叠 220ms（FOLD_MS）。所以预算做成 `FOLD_MS + 120 = 340ms`：
 * 覆盖最长的那条动画，再留一帧余量给布局抖动。每帧贴底，到点即停，
 * 跨平台表现一致 —— 不再依赖跑了多少帧。
 */
const PIN_BUDGET_MS = FOLD_MS + 120;

/**
 * F3：单步耗时低于这个值就不显示。
 *
 * 工具步骤大多在 1 秒上下，逐行拖一个「1.2s」等于给每行加一段噪音；
 * 真正值得看的是「这一步为什么慢」。总耗时仍留在摘要条上（带「工具」前缀）。
 */
const STEP_DURATION_VISIBLE_MS = 3000;

/** 关键步骤的 tooltip —— 说明它为什么不像别的步骤那样收起 */
const CRITICAL_TITLE: Record<string, string> = {
  write: '写入/编辑步骤：完成后仍保持展开',
  delete: '删除步骤：完成后仍保持展开',
  permission: '权限请求步骤：完成后仍保持展开',
  error: '报错步骤：完成后仍保持展开',
};

/** 单步 */
function StepRow({
  item,
  collapse = false,
}: {
  item: ResolvedTraceItem;
  collapse?: boolean;
}) {
  const running = item.status === 'running';
  /** 写入、删除、权限、报错四类：完成后不折叠，始终摊在过程流里 */
  const critical = item.critical;
  /**
   * 「每执行完一步就自动折叠」（2026-10-30 用户口径）。
   *
   * 执行中的步骤默认展开明细 —— 用户此刻正盯着它干活，命令/输出就是要看的；
   * 一旦状态离开 running（completed / error / interrupted），这一格立即收起，
   * 整条轨迹回到「一行一步」的密度，不会因为跑过的步骤全都摊开而变成一堵墙。
   *
   * 关键步骤例外：它们的明细在完成后常驻，不再提供手动收起 ——
   * 写入/删除一旦出错，事后回看必须还能看到当时改了什么、报了什么。
   */
  const [open, setOpen] = useState(running || critical);
  const prevRunning = useRef(running);
  useEffect(() => {
    if (critical) {
      setOpen(true);
      return;
    }
    if (prevRunning.current && !running) setOpen(false);
    prevRunning.current = running;
  }, [running, critical]);
  // 这一轮已经出答案 → 过程让位，明细一并收起；关键步骤与仍在跑的步骤除外
  // （用户手动展开轨迹时，正在跑的那一步必须还能看到实时输出）
  useEffect(() => {
    if (critical) {
      setOpen(true);
      return;
    }
    if (collapse && !running) setOpen(false);
  }, [collapse, critical, running]);
  /**
   * 明细的「先挂住再卸」：与整条轨迹同一套做法。
   * 收起时先留着播 180ms 高度过渡，播完再卸载，避免隐藏时白养一棵子树。
   */
  const [showBody, setShowBody] = useState(open);
  useEffect(() => {
    if (open) {
      setShowBody(true);
      return;
    }
    const timer = setTimeout(() => setShowBody(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open]);
  const Icon = iconOf(item.toolName);
  const detail = item.kind === 'tool' ? detailOf(item) : null;
  // A96：文件类工具优先给行级 diff。没有 diff 数据（read / delete / 未知工具）
  // 时返回 null，这里自动退回原来的明细渲染 —— 两条路互斥，不会重复显示。
  const hunks = useMemo(
    () =>
      item.kind === 'tool' && item.block ? buildDiffHunks(item.toolName, item.block.input) : null,
    [item.kind, item.toolName, item.block]
  );
  const hasDetail = hunks != null || detail != null || !!item.block?.output;
  const canToggle = hasDetail && !critical;

  const meta =
    item.status === 'running'
      ? '执行中…'
      : item.status === 'interrupted'
        ? // 与「失败」分开说：失败是确定的坏消息，未回传可能还在后台跑
          '结果未回传'
        : item.status === 'error'
          ? '失败'
          : // F3：< 3s 不显示。状态词（执行中 / 失败 / 未回传）照旧常驻，
            // 只有「耗时」这一档受预算约束 —— 短步骤的 1.2s 是纯噪音，
            // 长步骤的耗时才是「为什么慢」的线索。
            item.durationMs != null && item.durationMs >= STEP_DURATION_VISIBLE_MS
            ? formatStepDuration(item.durationMs) ?? ''
            : '';
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
      data-trace-completion={item.completion}
      data-trace-critical={item.criticalReason}
    >
      <span className="tc-step-dot" aria-hidden="true" />
      <div
        className="tc-step-head"
        data-clickable={canToggle ? '1' : undefined}
        data-expanded={canToggle ? (open ? '1' : '0') : undefined}
        onClick={canToggle ? () => setOpen(v => !v) : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? open : undefined}
        onKeyDown={
          canToggle
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen(v => !v);
                }
              }
            : undefined
        }
        title={critical ? CRITICAL_TITLE[item.criticalReason ?? ''] : item.path}
      >
        <Icon size={14} style={{ color: 'var(--td-text-color-secondary)', flexShrink: 0 }} />
        <span className="tc-trace-verb">{item.verb}</span>
        {item.target && <span className="tc-trace-target">{item.target}</span>}
        {item.diff && <DiffTag diff={item.diff} />}
        {critical && (
          // F2：不再写「常驻」两个字 —— 一个 7px 方块 + 左侧 3px 竖条
          // 就够表达「这一步不会跟着收起」。文字退场的理由是：它占的宽度
          // 比它承载的信息多，而且每行都写一遍，读起来像标签墙。
          <span className="tc-trace-pin" data-trace-pin={item.criticalReason} aria-hidden="true" />
        )}
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
      {showBody && (
        <div className="tc-step-body" data-step-body data-open={open ? '1' : '0'}>
          <div className="tc-step-body-inner">
            {hunks ? <DiffView hunks={hunks} /> : detail}
            <OutputBox
              label="输出"
              text={item.block?.output ?? ''}
              running={item.status === 'running'}
              isError={item.status === 'error'}
            />
          </div>
        </div>
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

export function AgentTrace({ blocks, isStreaming = false, collapse = false }: AgentTraceProps) {
  /**
   * 生产口径的完成判定（见 src/trace/fold.ts）：
   * 真实结束事件优先；缺失时才用「下一条事件」兜底；没有后续事件的
   * 长耗时步骤保持 running，本轮结束仍无结束事件的标为 missing。
   *
   * 行序列同时包含旁白（text 块）：它们是过程的一部分，跟着轨迹一起
   * 收拢/展开，不再落在轨迹外面把答案往下推。
   */
  const rows = useMemo(
    () =>
      buildTraceRows(blocks, {
        streaming: !!isStreaming,
        contentStarted: !!collapse,
      }),
    [blocks, isStreaming, collapse]
  );
  const steps = useMemo(() => stepRows(rows), [rows]);
  const summary = useMemo(() => summarizeTrace(steps), [steps]);

  // 既定口径：完成态默认收起；流式中默认展开。
  // 手动切过之后不再自动干预（否则用户刚展开就被「跑完」那一刻关掉）。
  const [expanded, setExpanded] = useState(!!isStreaming);
  const touched = useRef(false);
  const prevStreaming = useRef(!!isStreaming);
  /** 正文是否已经开始（一旦成立就保持；后续工具到达只是临时展开） */
  const contentStartedRef = useRef(!!collapse);
  /** 上一次因正文收拢时的步骤数：之后的步骤才算「新事件」 */
  const foldedAtRef = useRef(0);
  const [foldReason, setFoldReason] = useState<'content' | 'done' | 'manual' | null>(null);
  const prevCollapse = useRef(!!collapse);

  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    prevStreaming.current = !!isStreaming;

    // 本轮结束：完成态收起（手动展开/收起过就尊重手动，不再自动干预）
    if (wasStreaming && !isStreaming) {
      if (
        shouldAutoFoldOnTurnEnd({
          wasStreaming,
          streaming: !!isStreaming,
          manual: touched.current,
        })
      ) {
        setExpanded(false);
        setFoldReason('done');
      }
      return;
    }
    if (!isStreaming) return;

    const wasCollapse = prevCollapse.current;
    prevCollapse.current = !!collapse;

    // collapse 只在「最后一个工具之后出现非空正文」时为真 ——
    // 它就是用户要的「首个正文内容 token」，不是思考 token / 工具 token。
    // 每次它由假变真都收拢一次：正文恢复输出后，过程重新让位。
    if (collapse && !wasCollapse) {
      contentStartedRef.current = true;
      foldedAtRef.current = rows.length;
      if (!touched.current) {
        setExpanded(false);
        setFoldReason('content');
      }
      return;
    }

    // 正文之后又来了工具事件：ChatMessages 的 hasAnswer 会暂时回落。
    // 但那条工具可能落在**下一段轨迹**（正文把轨迹切成多段），本段没有新行，
    // 就不能跟着重开 —— 旧过程已经完成，重新展开只会把正文往下推。
    // 只有本段真的多了行（rows.length > 收拢时的长度）才重新展开。
    if (
      !collapse &&
      wasCollapse &&
      contentStartedRef.current &&
      !touched.current &&
      rows.length > foldedAtRef.current
    ) {
      setExpanded(true);
      setFoldReason(null);
    }
  }, [collapse, isStreaming, rows.length]);

  /**
   * 收拢后仍有新工具事件：重新展开；等正文重新出现（collapse 由假变真）
   * 或正文已经在这些步骤之后（collapse 仍为真）且它们都结束时，再次收拢。
   *
   * 展开期间如果新步骤一直没结束（没有后续事件），它会一直是 running，
   * 这里也就不会把它折掉 —— 不会假装完成。
   */
  useEffect(() => {
    if (!isStreaming || touched.current || !contentStartedRef.current) return;
    const fresh = rows.slice(foldedAtRef.current);
    if (fresh.length === 0) return;
    if (fresh.some(i => !isNarration(i) && i.status === 'running')) {
      setExpanded(true);
      setFoldReason(null);
    } else if (collapse) {
      // collapse 为假说明这些步骤后面还没有正文：此时收拢只是白占版面，
      // 保持展开，等正文重新出现时由上面的 collapse 变真来收。
      setExpanded(false);
      setFoldReason('content');
    }
  }, [rows, isStreaming, collapse]);

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
    const next = !expanded;
    setExpanded(next);
    setFoldReason(next ? null : 'manual');
  };

  const running = rows.some(i => !isNarration(i) && i.status === 'running');
  const stepCount = steps.filter(i => i.kind === 'tool').length;
  const totalMs = steps.reduce((s, i) => s + (i.durationMs ?? 0), 0);
  const durationText = formatHandledDuration(totalMs);
  /** 收拢后摘要条要能交代「最后一步没等到结果」 */
  const unreturned = hasUnreturnedResult(steps);

  // 渐隐遮罩：只有真的溢出时才淡出，否则短轨迹末尾会莫名其妙变虚
  const { ref: scrollRef, el: scrollEl, overflowing } = useOverflowY<HTMLDivElement>();

  /**
   * 流式中贴底：新步骤永远在末尾，不贴底就看不到它。
   *
   * 不能只拍一次：新步骤的明细有 180ms 高度动画，拍第一帧时它还没长出来，
   * 等到动画结束又没有依赖变化可触发 —— 结果就是「当前步被顶到折叠线以下」。
   * F4：预算按**时间**给（PIN_BUDGET_MS = 340ms），不再数帧 —— 见常量注释。
   * 依赖用 `items`（而不是 `items.length`），输出持续追加时也会重新贴底。
   */
  useEffect(() => {
    if (!running || !expanded || !scrollEl) return;
    let raf = 0;
    let stopped = false;
    const startedAt = performance.now();
    const pin = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      if (!stopped && performance.now() - startedAt < PIN_BUDGET_MS) {
        raf = requestAnimationFrame(pin);
      }
    };
    pin();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [running, expanded, showBody, rows, scrollEl]);

  if (rows.length === 0) return null;

  /**
   * 汇总行文案。
   *
   * 刻意**不**在运行中替换成「执行中…」：那句话把最有信息量的东西（干了什么）
   * 盖掉了。文字始终是摘要 —— 流式过程中它随新步骤不断变化，本身就是「在动」
   * 的证据；运行态另有 StreamStatus 的呼吸灯表达。
   */
  const barLabel = summary.text || (expanded ? '收起步骤' : '查看步骤');
  const showTotalDiff = summary.diff.added > 0 || summary.diff.removed > 0;

  /**
   * 收拢原因：content = 首个正文 token 到达；done = 本轮结束；
   * manual = 用户自己收的。摘要条始终保留，点击即可展开 —— 这就是「展开出口」。
   */
  const foldedReason = expanded ? null : (foldReason ?? (isStreaming ? 'content' : 'done'));
  const foldTitle =
    foldedReason === 'content'
      ? '正文已开始，过程已收拢 · 点击展开完整轨迹'
      : foldedReason === 'manual'
        ? '已手动收起 · 点击展开完整轨迹'
        : foldedReason === 'done'
          ? '过程已完成 · 点击展开完整轨迹'
          : undefined;

  return (
    <div className="tc-trace" data-trace data-trace-state={running ? 'running' : 'done'}>
      <div
        className="tc-steps-bar"
        data-steps-bar
        data-trace-fold-reason={foldedReason ?? undefined}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={foldTitle}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {/* 2026-10-30 改版：行首不再摆状态图标三件套
            （绿勾/红叉/脉冲点），chevron 紧跟摘要文案之后而不是钉在行尾 ——
            这一行读起来是「干了什么 ⌄」，状态由步骤行各自表达。 */}
        <span className="tc-trace-summary" data-trace-summary title={summary.text}>
          {barLabel}
        </span>
        <span className="tc-trace-count" data-trace-count>
          {stepCount} 步
        </span>
        {/* 收拢态才提示：展开时这一步的行尾已经有同名胶囊，不必重复 */}
        {!expanded && unreturned && (
          <span
            className="tc-trace-unreturned"
            data-trace-unreturned
            title="最后一步没有等到结束事件，既不算完成也不算失败"
          >
            结果未回传
          </span>
        )}
        {/* 首个正文 token 收拢时给一个可见出口；摘要条本身始终可点 */}
        {foldedReason === 'content' && (
          <span className="tc-trace-foldtag" data-trace-foldtag>
            已收拢
          </span>
        )}
        {expanded ? (
          <ChevronUp size={13} style={{ color: 'var(--td-text-color-placeholder)', flexShrink: 0 }} />
        ) : (
          <ChevronDown size={13} style={{ color: 'var(--td-text-color-placeholder)', flexShrink: 0 }} />
        )}
        {showTotalDiff && (
          <span className="tc-diff" data-diff-total={`+${summary.diff.added} -${summary.diff.removed}`}>
            <span className="tc-diff-add">+{summary.diff.added}</span>
            <span className="tc-diff-del">-{summary.diff.removed}</span>
          </span>
        )}
        {durationText && <span className="tc-trace-meta">工具 {durationText}</span>}
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
                {rows.map(row =>
                  isNarration(row) ? (
                    <div key={row.id} className="tc-trace-solo">
                      <p className="tc-trace-narration" data-trace-narration>
                        {row.text}
                      </p>
                    </div>
                  ) : row.kind === 'thinking' ? (
                    <div key={row.id} className="tc-trace-solo">
                      <ThinkingNode item={row} collapse={collapse} />
                    </div>
                  ) : (
                    <StepRow key={row.id} item={row} collapse={collapse} />
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
