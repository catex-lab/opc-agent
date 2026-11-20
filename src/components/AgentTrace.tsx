/**
 * 执行轨迹（A36 → 2026-11-21 行式步骤条重设计，对照 ZCode 官方形态）。
 *
 * ## 这一版改了什么（用户拍板「过程流可视化」）
 *
 * 旧形态：完成态收成一行摘要，步骤只在展开态渲染 —— 「干了什么」被压进一句
 * 摘要，步骤行本身不可见。
 *
 * 新形态（对照 zai-org/ZCode 的过程条）：
 *
 *   1. **步骤行常驻**：每步一行（图标 + 动作词 + 目标 + diff + 状态/耗时），
 *      明细默认收起 —— 「默认不展开，只是一行」；点击行展开明细。
 *   2. **活跃行动态**：运行中步骤的动词短语做**文字扫光**（自左而右的光晕
 *      循环，ZCode 同款机制——它的注释明确说旋转 loading 长期占用渲染资源，
 *      改用文案扫光），并在行内显示**实时尾部**（输出/思考的最后 ~48 字），
 *      不展开也能看到它确实在动。
 *   3. **头部汇总**：摘要一句 + 进度 chips（执行中 x · 完成 n）+ 总 diff。
 *   4. **状态收口**：行状态走 src/trace/fold.ts 的完成判定（真实结束事件 >
 *      下一条事件兜底 > 本轮结束标「未回传」）——「已完成仍显示进行中」在
 *      轮次结束这一侧收口；运行中的行如实显示实时尾部。
 *
 * ## 与 gate 的契约
 *
 * `[data-steps-bar]`（头部，aria-expanded = 任一明细展开）、`[data-trace-scroll]`
 * （步骤容器，常驻）、`[data-tool-step]` / `data-trace-verb` /
 * `data-trace-completion` / `.tc-step-dot` / `.tc-trace-meta`（行级）全部保留；
 * verify-a36/a34/a35/a96/a101/a102/a149 的断言已跟随本形态更新。
 *
 * ## 展开策略（新口径）
 *
 * 所有步骤**默认一行**（含写入/删除等关键步骤——行上的 diff 徽章已经表达
 * 「改了什么」，明细点击即达）。关键步骤保留 pin 标记与 tooltip。手动展开/
 * 收起完全由用户控制，不再有自动展开。
 *
 * 单步明细的「先挂住再卸」与整条轨迹的贴底跟随、渐隐遮罩沿用原实现。
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
  type LucideIcon,
} from 'lucide-react';
// ChevronDown/Up 已随「摘要条折叠」机制退役：新形态步骤行常驻，头部不再翻转。
import type { Block } from '../../shared/blocks';
import {
  buildDiffHunks,
  formatStepDuration,
  summarizeTrace,
  type TraceDiff,
  type TraceItem,
} from '../../shared/trace';
import { DiffView } from './DiffView';
import { useOverflowY } from '../hooks/useOverflowY';
import { hasUnreturnedResult, type ResolvedTraceItem } from '../trace/fold';
import { buildTraceRows, isNarration, stepRows } from '../trace/rows';
import { useTranslation, type MessageKey, type Translate } from '../i18n';
import '../trace/traceFold.css';

/**
 * 轨迹里的动作词由 `shared/trace` 的中文常量产出（门禁与 Skill 沉淀也在用）。
 * 界面层只按这张表翻译，`data-trace-verb` 仍写原值，判定逻辑不受语言影响。
 */
const VERB_KEY: Record<string, MessageKey> = {
  '写入': 'chat.trace.verb.write',
  '编辑': 'chat.trace.verb.edit',
  '已读取': 'chat.trace.verb.readDone',
  '删除': 'chat.trace.verb.delete',
  '检查': 'chat.trace.verb.check',
  '执行': 'chat.trace.verb.run',
  '搜索': 'chat.trace.verb.search',
  '获取': 'chat.trace.verb.fetch',
  '查看': 'chat.trace.verb.view',
  '使用技能': 'chat.trace.verb.skill',
  '生成图像': 'chat.trace.verb.image',
  '调用': 'chat.trace.verb.call',
  '深度思考': 'chat.trace.verb.thinking',
};

const TARGET_KEY: Record<string, MessageKey> = {
  '命令': 'chat.trace.target.command',
  '网页': 'chat.trace.target.web',
  '技能': 'chat.trace.target.skill',
  '内容': 'chat.trace.target.content',
};

const OUTCOME_KEY: Record<string, MessageKey> = {
  running: 'chat.trace.outcome.running',
  error: 'chat.trace.outcome.error',
  interrupted: 'chat.trace.outcome.interrupted',
  ok: 'chat.trace.outcome.ok',
};

/** 与 `summarizeTrace().text` 语义一致，只是按当前语言重排 */
function summaryText(summary: ReturnType<typeof summarizeTrace>, t: Translate): string {
  const outcome = t(OUTCOME_KEY[summary.outcome] ?? 'chat.trace.outcome.ok');
  const head = summary.editedFiles.length
    ? t('chat.trace.summary.edited', { n: summary.editedFiles.length })
    : summary.files.length
      ? t('chat.trace.summary.read', { n: summary.files.length })
      : summary.verbs.length
        ? t('chat.trace.summary.verbs', {
            verbs:
              summary.verbs
                .slice(0, 3)
                .map(v => (VERB_KEY[v] ? t(VERB_KEY[v]) : v))
                .join(t('chat.trace.listSeparator')) +
              (summary.verbs.length > 3 ? t('chat.trace.more') : ''),
          })
        : '';
  return head ? `${head} · ${outcome}` : outcome;
}

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
  const { t } = useTranslation();
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
        {running ? t('chat.trace.outputting') : isError ? t('chat.trace.error') : label}:{' '}
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

/** 运行中行的实时尾部：最后 ~48 字符，压成单行 */
function tailOf(text: string | undefined, n = 48): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trimEnd();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * 思考节点（行式）：一行「深度思考」+ 字数 + 秒数，运行中加扫光 + 实时尾部。
 *
 * 被厂商隐去的思考：正文是密的，但「确实想过一段」是事实。
 * 这里既不能伪造内容，也不能什么都不显示 —— 空一行、标明「已隐去」最诚实。
 *
 * 2026-11-21 行式重设计：details 默认收起（点击看全文），运行中在行内显示
 * 思考尾部 —— 不展开也能看到「正在想什么」。
 */
function ThinkingNode({ item }: { item: TraceItem }) {
  const { t } = useTranslation();
  const thinkText = item.thinking;
  if (!thinkText) return null;
  const running = thinkText.state === 'streaming';
  // 被厂商隐去的思考：正文是密的，但「确实想过一段」是事实。
  // 这里既不能伪造内容，也不能什么都不显示 —— 空一行、标明「已隐去」最诚实。
  const redacted = !!thinkText.redacted;
  const secs = item.durationMs != null ? Math.max(1, Math.round(item.durationMs / 1000)) : null;
  const tail = running ? tailOf(thinkText.text) : '';

  const row = (
    <>
      <Brain size={12} style={{ flexShrink: 0 }} />
      <span className={`tc-think-note-title${running ? ' opc-sweep-text' : ''}`}>
        {redacted ? t('chat.trace.redacted') : running ? t('chat.trace.thinkingLive') : t('chat.trace.thinking')}
      </span>
      {!redacted && thinkText.format === 'summary' && <span className="tc-think-badge">{t('chat.trace.summaryBadge')}</span>}
      <span className="tc-think-note-meta">
        {redacted ? t('chat.trace.redactedReason') : t('chat.thinking.chars', { n: thinkText.text.length })}
      </span>
      {secs != null && <span className="tc-think-note-meta">{secs}s</span>}
      {tail && (
        <span className="tc-trace-tail" data-trace-tail>
          {tail}
        </span>
      )}
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
        <details className="tc-thinking tc-think-note">
          <summary>{row}</summary>
          <div className="tc-think-note-body">{thinkText.text}</div>
        </details>
      )}
    </div>
  );
}

/** 展开明细：不同工具只差在「哪几段」，样式统一交给 .tc-step-detail */
function detailOf(item: TraceItem, t: Translate): ReactNode {
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
      <span style={{ color: 'var(--td-text-color-placeholder)' }}>{t('chat.trace.input')}: </span>
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

/** 关键步骤的 tooltip —— 说明它为什么带着 pin 标记 */
const CRITICAL_TITLE_KEY: Record<string, MessageKey> = {
  write: 'chat.trace.criticalWrite',
  delete: 'chat.trace.criticalDelete',
  permission: 'chat.trace.criticalPermission',
  error: 'chat.trace.criticalError',
};

/** 单步（行式，2026-11-21）：默认一行，点击展开明细 */
function StepRow({
  item,
  open,
  onToggle,
}: {
  item: ResolvedTraceItem;
  /** 开合状态由 AgentTrace 统一持有（行点击 / 头部全开全收都写这里） */
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const running = item.status === 'running';
  const critical = item.critical;
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
  const detail = item.kind === 'tool' ? detailOf(item, t) : null;
  // A96：文件类工具优先给行级 diff。没有 diff 数据（read / delete / 未知工具）
  // 时返回 null，这里自动退回原来的明细渲染 —— 两条路互斥，不会重复显示。
  const hunks = useMemo(
    () =>
      item.kind === 'tool' && item.block ? buildDiffHunks(item.toolName, item.block.input) : null,
    [item.kind, item.toolName, item.block]
  );
  const hasDetail = hunks != null || detail != null || !!item.block?.output;
  const canToggle = hasDetail;

  const meta =
    item.status === 'running'
      ? t('chat.trace.executing')
      : item.status === 'interrupted'
        ? // 与「失败」分开说：失败是确定的坏消息，未回传可能还在后台跑
          t('chat.trace.noResult')
        : item.status === 'error'
          ? t('chat.trace.failed')
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
  /** 运行中的实时尾部（工具输出）—— 行内可见，不展开也在动 */
  const tail = running ? tailOf(item.block?.output) : '';

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
        onClick={canToggle ? onToggle : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? open : undefined}
        onKeyDown={
          canToggle
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        title={critical ? t(CRITICAL_TITLE_KEY[item.criticalReason ?? ''] ?? 'chat.trace.critical') : item.path}
      >
        <Icon size={14} style={{ color: 'var(--td-text-color-secondary)', flexShrink: 0 }} />
        <span className={`tc-trace-verb${running ? ' opc-sweep-text' : ''}`}>
          {VERB_KEY[item.verb] ? t(VERB_KEY[item.verb]) : item.verb}
        </span>
        {item.target && <span className="tc-trace-target">{TARGET_KEY[item.target] ? t(TARGET_KEY[item.target]) : item.target}</span>}
        {item.diff && <DiffTag diff={item.diff} />}
        {critical && (
          // F2：不再写「常驻」两个字 —— 一个 7px 方块 + 左侧 3px 竖条
          // 就够表达「这一步值得回看」。文字退场的理由是：它占的宽度
          // 比它承载的信息多，而且每行都写一遍，读起来像标签墙。
          <span className="tc-trace-pin" data-trace-pin={item.criticalReason} aria-hidden="true" />
        )}
        {/* A100：事件来源标签。**只标纯文本解析那一种** —— 原生 / 结构化
            输出是绝大多数，逐条标出来反而把轨迹刷满噪音。 */}
        {item.kind === 'tool' && item.block?.source === 'parsed_text' && (
          <span
            className="tc-trace-src"
            data-trace-source="parsed_text"
            title={t('chat.trace.parsedTitle')}
          >
            {t('chat.trace.parsedBadge')}
          </span>
        )}
        {/* 运行中的实时尾部：占掉行内剩余空间，把「正在干什么」亮出来 */}
        {tail && (
          <span className="tc-trace-tail" data-trace-tail>
            {tail}
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
              label={t('chat.trace.output')}
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
            <ThinkingNode key={n.id} item={n} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface AgentTraceProps {
  /** 一条轨迹段：连续的「工具 / 思考」块 */
  blocks: readonly Block[];
  /** 这一轮是否还在流式（决定活跃行的动态与自动贴底） */
  isStreaming?: boolean;
  /** 这条消息已经有正文：仅作为 fold 的 contentStarted 证据（行式形态下不再收拢容器） */
  collapse?: boolean;
}

export function AgentTrace({ blocks, isStreaming = false, collapse = false }: AgentTraceProps) {
  const { t } = useTranslation();
  /**
   * 生产口径的完成判定（见 src/trace/fold.ts）：
   * 真实结束事件优先；缺失时才用「下一条事件」兜底；没有后续事件的
   * 长耗时步骤保持 running；本轮结束仍无结束事件的标 missing（未回传）。
   *
   * 行序列同时包含旁白（text 块）：它们是过程的一部分，跟着步骤一起渲染。
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

  /**
   * 头部「全部展开 / 收起」：任一明细展开 → aria-expanded=true。
   * 点击在两种态之间整批切换（新行按当前批状态挂载）。
   */
  /**
   * 明细开合的**唯一事实源**（行点击 / 头部全开全收都写这里）。
   * 头部 aria-expanded = 任一明细展开。
   */
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const anyOpen = openIds.size > 0;
  const toggleRow = (id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllRows = () => {
    if (anyOpen) {
      setOpenIds(new Set());
      return;
    }
    // 全部可展开的行都打开（旁白没有明细，跳过）
    setOpenIds(new Set(rows.filter(r => !isNarration(r)).map(r => r.id)));
  };

  const running = rows.some(i => !isNarration(i) && i.status === 'running');
  const stepCount = steps.filter(i => i.kind === 'tool').length;
  const doneCount = steps.filter(i => i.kind === 'tool' && i.status !== 'running').length;
  /** 活跃（运行中）步骤数：头部 chip 用 */
  const activeCount = rows.filter(i => !isNarration(i) && i.status === 'running').length;
  // S1-2：总耗时只保留头部那一个（「已处理 32 秒」）。摘要条不再重复展示
  // 工具耗时；totalMs 若将来要在别处呈现，计算仍在此处（埋点不动）。
  const totalMs = steps.reduce((s, i) => s + (i.durationMs ?? 0), 0);
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
   * 依赖用 `rows`（而不是 `rows.length`），输出持续追加时也会重新贴底。
   */
  useEffect(() => {
    if (!running || !scrollEl) return;
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
  }, [running, rows, scrollEl]);

  if (rows.length === 0) return null;

  /**
   * 汇总行文案。
   *
   * 刻意**不**在运行中替换成「执行中…」：那句话把最有信息量的东西（干了什么）
   * 盖掉了。文字始终是摘要 —— 流式过程中它随新步骤不断变化，本身就是「在动」
   * 的证据；运行态另有扫光动词与实时尾部表达。
   */
  const barLabel = summaryText(summary, t) || t('chat.trace.viewSteps');
  const showTotalDiff = summary.diff.added > 0 || summary.diff.removed > 0;



  return (
    <div className="tc-trace" data-trace data-trace-state={running ? 'running' : 'done'}>
      <div
        className="tc-steps-bar"
        data-steps-bar
        role="button"
        tabIndex={0}
        aria-expanded={anyOpen}
        title={t('chat.trace.viewSteps')}
        onClick={toggleAllRows}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleAllRows();
          }
        }}
      >
        <span className="tc-trace-summary" data-trace-summary title={summaryText(summary, t)}>
          {barLabel}
        </span>
        {/* 进度 chips（对照 ZCode：处理中 x/y · 已完成 n），右对齐 */}
        <span className="tc-trace-chips" data-trace-chips>
          {activeCount > 0 && (
            <span className="tc-trace-chip" data-trace-chip-running>
              {t('chat.trace.chipRunning', { n: activeCount })}
            </span>
          )}
          <span className="tc-trace-chip" data-trace-chip-done>
            {t('chat.trace.chipDone', { n: doneCount, total: stepCount })}
          </span>
        </span>
        {showTotalDiff && (
          <span className="tc-diff" data-diff-total={`+${summary.diff.added} -${summary.diff.removed}`}>
            <span className="tc-diff-add">+{summary.diff.added}</span>
            <span className="tc-diff-del">-{summary.diff.removed}</span>
          </span>
        )}
        {unreturned && (
          <span
            className="tc-trace-unreturned"
            data-trace-unreturned
            title={t('chat.trace.unreturnedTitle')}
          >
            {t('chat.trace.unreturned')}
          </span>
        )}
      </div>

      {/* 步骤行常驻：明细各自收起，容器限高滚动 + 底部渐隐 */}
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
                <ThinkingNode item={row} />
              </div>
            ) : (
              <StepRow
                key={row.id}
                item={row}
                open={openIds.has(row.id)}
                onToggle={() => toggleRow(row.id)}
              />
            )
          )}
        </div>
      </div>
      {totalMs > 0 && <span data-trace-totalms hidden>{totalMs}</span>}
    </div>
  );
}

export default AgentTrace;
