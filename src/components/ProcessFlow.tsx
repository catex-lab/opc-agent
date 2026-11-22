/**
 * 单聊过程流（2026-11-22 改版）——以用户提供的 HTML 参考页（单聊过程流 · 电脑版）
 * 为唯一蓝本整体重做。旧 AgentTrace v2 方案同日封存：本组件不借鉴其结构、
 * 类名与交互，全部类名走 `pf-*` 新命名空间。
 *
 * ## 参考页的架构（一轮 = 一条流）
 *
 *   处理中 / 已处理 X 秒          ← 整轮唯一时钟
 *   ▓▓▓▓░░░░░░  阶段条 + 图例    ← 按耗时比例分段；图例独立可折叠（用户拍板）
 *   ● 正在执行 xxx · 3.2s        ← 唯一状态胶囊（aria-live；实时秒 = startedAt→now）
 *   改了 1 个文件 · 成功 · 重试 1 次 │ N 步 │ 执行中 ⌄   ← 摘要线（步骤折叠开关）
 *   ┊ 深度思考 / 执行 / 旁白      ← 步骤流，中途旁白在流内，不拆段
 *   答案正文（流式）              ← 答案在流末尾，不折进摘要线
 *
 * ## 与参考页的刻意差异（真实数据 vs 演示数据）
 *
 *   · 参考页的事件是逐条带时间的模拟流；真实块只有 startedAt/endedAt，
 *     「上一步/下一步/回放滑杆/倍速」是演示器机制，不搬。
 *   · 答案用 AnswerMarkdown 渲染（真实回复是 markdown，参考页是纯文本）。
 *   · 桌面右侧过程面板 / 移动端吸顶条 / 底部悬浮胶囊是参考页的投影层，
 *     本期先落主流程，投影层待主流程定版后另起一批。
 *   · 「结果未回传」的诚实口径保留（A125/A206 的产品要求，参考页未覆盖）。
 *
 * ## 数据层（不是旧 UI 方案的一部分，继续沿用）
 *
 * 完成判定 src/trace/fold.ts（真实结束事件 > 后续事件兜底 > 未回传）；
 * 阶段分组 shared/trace.ts groupPhases（分类/合并/fix 归属）；
 * 摘要与重试口径 summarizeTrace。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Brain, FileText, Search, Globe, Pencil, FilePlus, FlaskConical, Terminal, Bot, Plug, ShieldAlert, MessageSquare, type LucideIcon } from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  baseName,
  buildDiffHunks,
  formatHandledDurationText,
  formatStepDuration,
  groupPhases,
  summarizeTrace,
  type DiffHunk,
  type FlowPhase,
  type TraceDiff,
  type TraceItem,
} from '../../shared/trace';
import { buildTraceRows, isNarration, stepRows } from '../trace/rows';
import { useTranslation, type MessageKey } from '../i18n';
import { AnswerMarkdown } from './AnswerMarkdown';
import '../trace/processFlow.css';
import { flowIcon, isWaitingTool } from '../trace/icons';

/** 轨迹动词（shared/trace 的中文常量产出）→ i18n 键。胶囊里「已读取」特判为进行态「读取」。 */
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
};

const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'execute']);
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['edit', 'editfile', 'multiedit', 'str_replace_editor']);
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'writefile', 'create_file']);

/** 阶段图例（含「失败」色标）。独立成行、可折叠——2026-11-21 用户拍板，随改版沿用。 */
const PHASE_LEGEND_ORDER: ReadonlyArray<{ kind: string; key: MessageKey }> = [
  { kind: 'understand', key: 'chat.trace.phase.understand' },
  { kind: 'change', key: 'chat.trace.phase.change' },
  { kind: 'verify', key: 'chat.trace.phase.verify' },
  { kind: 'failed', key: 'chat.trace.failed' },
  { kind: 'fix', key: 'chat.trace.phase.fix' },
];

const LEGEND_PREF_KEY = 'opc.trace.phaseLegend';
/** 详情/思考正文的展示上限（真实输出远长于演示页，不设上限会把流撑爆） */
const DETAIL_LINE_LIMIT = 160;
const THINK_NOTE_LIMIT = 2000;

/** 行内单行内容：文件步骤给文件名，其余给命令/查询/URL/主入参 */
function targetOf(item: { path?: string; toolName: string; block?: { input?: Record<string, unknown> }; target: string }): string {
  if (item.path) return baseName(item.path);
  const input = item.block?.input;
  if (input) {
    for (const k of ['command', 'query', 'url', 'pattern', 'skill']) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim().split('\n')[0].slice(0, 80);
    }
  }
  return item.target || '';
}

/** `+109 -16` / `+N` / `±0`（口径与数据层 lineDiff 一致） */
function DiffTag({ diff }: { diff: TraceDiff }) {
  if (diff.known) {
    return (
      <span className="pf-diff" data-flow-diff={`+${diff.added} -${diff.removed}`}>
        <span className="pf-diff-add">+{diff.added}</span>
        <span className="pf-diff-del">-{diff.removed}</span>
      </span>
    );
  }
  if (diff.added > 0) {
    return (
      <span className="pf-diff" data-flow-diff={`+${diff.added}`}>
        <span className="pf-diff-add">+{diff.added}</span>
      </span>
    );
  }
  return (
    <span className="pf-diff" data-flow-diff="±0">
      <span className="pf-diff-none">±0</span>
    </span>
  );
}

/** 编辑/写入的详情行（参考页形态：mono + +/-/上下文着色，超长截断） */
function detailOfEdit(hunks: DiffHunk[]): { kind: 'add' | 'del' | 'ctx'; text: string }[] {
  const lines: { kind: 'add' | 'del' | 'ctx'; text: string }[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      const prefix = l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ';
      lines.push({ kind: l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : 'ctx', text: prefix + l.text });
    }
  }
  return lines;
}

export interface ProcessFlowProps {
  /** 一整轮的块（含思考 / 旁白 / 工具 / 答案文本）——参考页口径：一轮就是一条流 */
  blocks: readonly Block[];
  isStreaming?: boolean;
  /**
   * 服务端 run_end 盖章的整轮时长（S1-2 单口径）。回合结束后时钟优先用它——
   * 块时间戳只覆盖过程块，答案段的时长不在里面；流式中没有它，用块起点现算。
   */
  durationMs?: number;
  /** AnswerMarkdown 的透传参数（与旧答案区同一渲染器，真实回复是 markdown） */
  cwd?: string;
  at?: string;
}

type RowState = 'running' | 'done' | 'error' | 'interrupted' | 'wait';

export function ProcessFlow({ blocks, isStreaming = false, durationMs, cwd, at }: ProcessFlowProps) {
  const { t, locale } = useTranslation();

  /** 答案 = 最后一个过程块（tool/thinking）之后的全部文本；其余文本是流内旁白 */
  let lastProcIdx = -1;
  blocks.forEach((b, i) => {
    if (b.type === 'tool' || b.type === 'thinking') lastProcIdx = i;
  });
  const answerText = blocks
    .filter((b, i) => b.type === 'text' && i > lastProcIdx)
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('');
  const hasAnswer = answerText.trim().length > 0;

  const flowBlocks = useMemo(() => blocks.slice(0, lastProcIdx + 1), [blocks, lastProcIdx]);
  const rows = useMemo(
    () => buildTraceRows(flowBlocks, { streaming: !!isStreaming, contentStarted: true }),
    [flowBlocks, isStreaming]
  );
  /**
   * 参考页形态：思考是步骤流里的**兄弟行**（紧跟它的工具行之后），不缩进、
   * 不隐藏。buildTrace 会把工具后的思考挂进 item.nested（数据层语义），
   * 渲染前在这里拉平——渲染顺序 = 工具行 → 它的思考行。
   * 嵌套思考在 fold.ts 里已完成状态判定（runtime 对象带 completion），
   * 声明类型是 TraceItem，FlowRow 也只消费 TraceItem 上的字段。
   */
  const flatRows = useMemo(() => {
    const out: Array<{ kind: 'narration'; id: string; text: string } | { kind: 'row'; item: TraceItem }> = [];
    for (const row of rows) {
      if (isNarration(row)) {
        out.push({ kind: 'narration', id: row.id, text: row.text });
        continue;
      }
      out.push({ kind: 'row', item: row });
      for (const n of row.nested) out.push({ kind: 'row', item: n });
    }
    return out;
  }, [rows]);
  const steps = useMemo(() => stepRows(rows), [rows]);

  /** 每秒一跳：时钟与胶囊的实时秒现算（Date.now() 现取，不累计漂移） */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const iv = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, [isStreaming]);

  // ── 整轮时钟（参考页 hdr：处理中 X 秒 / 已处理 X 秒） ──────────────
  const clockMs = (() => {
    // 回合结束：服务端盖章的 durationMs 优先（S1-2 单口径）
    if (!isStreaming && typeof durationMs === 'number' && durationMs > 0) return durationMs;
    let start = Infinity;
    let end = 0;
    for (const b of blocks) {
      if (b.type !== 'tool' && b.type !== 'thinking') continue;
      const s = b.startedAt ?? 0;
      const e = b.endedAt ?? 0;
      if (s > 0) start = Math.min(start, s);
      if (e > 0) end = Math.max(end, e);
    }
    if (!Number.isFinite(start)) return durationMs ?? null;
    if (isStreaming) return Math.max(0, Date.now() - start);
    return end > start ? end - start : null;
  })();
  const clockText = clockMs != null && clockMs > 0
    ? t(isStreaming ? 'chat.flow.processing' : 'chat.flow.handled', {
        n: formatHandledDurationText(clockMs, locale ?? 'zh') ?? '',
      })
    : null;

  // ── 阶段条（几何与旧纯函数同源；老数据无时间戳 → 等宽兜底） ─────────
  const phases: FlowPhase[] = useMemo(() => groupPhases(steps), [steps]);
  const phaseSegments = (() => {
    const timed = phases.some(p => (p.startMs ?? 0) > 0);
    if (!timed) {
      const totalSteps = phases.reduce((s, p) => s + p.steps, 0) || 1;
      let acc = 0;
      return phases.map(p => {
        const width = (p.steps / totalSteps) * 100;
        const seg = { ...p, left: acc, width, live: false };
        acc += width;
        return seg;
      });
    }
    const starts = phases.filter(p => (p.startMs ?? 0) > 0).map(p => p.startMs!) as number[];
    const winStart = Math.min(...starts);
    const maxEnd = Math.max(...phases.map(p => p.endMs ?? 0), winStart);
    const hasOpen = phases.some(p => p.endMs === undefined);
    const winEnd = hasOpen && isStreaming ? Date.now() : Math.max(maxEnd, winStart);
    const span = Math.max(winEnd - winStart, 1);
    return phases.map(p => {
      const s = p.startMs ?? winStart;
      const e = p.endMs ?? winEnd;
      const left = Math.min(((s - winStart) / span) * 100, 98.5);
      const width = Math.min(Math.max(((e - s) / span) * 100, 1.5), 100 - left);
      return { ...p, left, width, live: isStreaming && p.endMs === undefined };
    });
  })();

  /** 图例开合：本地偏好（默认展开 = 参考页形态），跨消息共享 */
  const [legendOpen, setLegendOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LEGEND_PREF_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleLegend = () => {
    setLegendOpen(prev => {
      const next = !prev;
      try {
        localStorage.setItem(LEGEND_PREF_KEY, next ? '1' : '0');
      } catch {
        /* 存不下就算了：本次会话内仍然生效 */
      }
      return next;
    });
  };

  // ── 状态胶囊（参考页 pill：任何时刻只有一个） ─────────────────────
  const runningTool = [...steps].reverse().find(i => i.kind === 'tool' && i.status === 'running');
  const runningThink = steps.some(i => i.kind === 'thinking' && i.status === 'running');
  const summary = useMemo(() => summarizeTrace(steps), [steps]);
  const unreturned = steps.length > 0 && (() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const it = steps[i]!;
      if (it.kind !== 'tool') continue;
      return it.completion === 'missing' || it.status === 'interrupted';
    }
    return false;
  })();

  const pill = (() => {
    if (isStreaming && runningTool) {
      const verbRaw = runningTool.verb;
      const verbKey = verbRaw === '已读取' ? 'chat.trace.verb.read' : VERB_KEY[verbRaw];
      const verb = verbKey ? t(verbKey) : verbRaw;
      const target = targetOf(runningTool);
      const startedAt = runningTool.block?.startedAt ?? 0;
      const liveMs = startedAt > 0 ? Date.now() - startedAt : 0;
      const secs = formatStepDuration(liveMs);
      const prefix = t('chat.trace.pill.doingPrefix');
      return {
        state: 'tool' as const,
        tone: 'running' as const,
        text: `${prefix}${verb}${target ? ` ${target}` : ''}${secs ? ` · ${secs}` : ''}`,
      };
    }
    if (isStreaming && hasAnswer) {
      return { state: 'answering' as const, tone: 'running' as const, text: t('chat.trace.pill.answering') };
    }
    if (isStreaming && runningThink) {
      return { state: 'thinking' as const, tone: 'running' as const, text: t('chat.trace.thinkingLive') };
    }
    if (isStreaming) {
      return { state: 'waiting' as const, tone: 'running' as const, text: t('chat.flow.waitingNext') };
    }
    // 回合结束：如实给结论
    if (unreturned) {
      return { state: 'unreturned' as const, tone: 'interrupted' as const, text: t('chat.trace.noResult') };
    }
    if (summary.outcome === 'error') {
      return {
        state: 'failed' as const,
        tone: 'error' as const,
        text: clockText
          ? `${t('chat.trace.outcome.error')} · ${t('chat.trace.pill.elapsed', { n: formatHandledDurationText(clockMs ?? 0, locale ?? 'zh') ?? '' })}`
          : t('chat.trace.outcome.error'),
      };
    }
    const retried = summary.retries > 0;
    const doneWord = retried
      ? t('chat.trace.outcome.okRetried', { n: summary.retries })
      : t('chat.trace.pill.done');
    return {
      state: retried ? ('retried' as const) : ('done' as const),
      tone: 'ok' as const,
      text: clockText
        ? `${doneWord} · ${t('chat.trace.pill.elapsed', { n: formatHandledDurationText(clockMs ?? 0, locale ?? 'zh') ?? '' })}`
        : doneWord,
    };
  })();

  // ── 摘要线（参考页 tc-steps-bar：结果语义 + 步数 + 折叠开关 + 总 diff） ──
  const toolCount = steps.filter(i => i.kind === 'tool').length;
  const hasThinking = steps.some(i => i.kind === 'thinking');
  const verbsText =
    summary.verbs.slice(0, 3).join(t('chat.trace.listSeparator')) +
    (summary.verbs.length > 3 ? t('chat.trace.more') : '');
  const head = summary.editedFiles.length
    ? t('chat.trace.summary.edited', { n: summary.editedFiles.length })
    : summary.files.length
      ? t('chat.trace.summary.read', { n: summary.files.length })
      : summary.verbs.length
        ? t('chat.trace.summary.verbs', { verbs: verbsText })
        : t('chat.trace.thinking');
  const outcomeWord =
    summary.outcome === 'running'
      ? t('chat.trace.outcome.running')
      : summary.outcome === 'error'
        ? t('chat.trace.outcome.error')
        : summary.outcome === 'interrupted'
          ? t('chat.trace.outcome.interrupted')
          : summary.retries > 0
            ? t('chat.trace.outcome.okRetried', { n: summary.retries })
            : t('chat.trace.outcome.ok');
  const summaryText = head ? `${head} · ${outcomeWord}` : outcomeWord;

  /** 折叠：答案出现即自动收（参考页 folded = !!ans），手动点摘要线可覆盖 */
  const [manualFold, setManualFold] = useState<boolean | null>(null);
  const folded = manualFold !== null ? manualFold : hasAnswer;
  const toggleFold = () => setManualFold(!folded);

  /** 行明细开合（参考页 opened[]；运行中的工具只要有输出就自动露尾） */
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (steps.length === 0 && !hasAnswer) return null;

  const showTotalDiff = summary.diff.added > 0 || summary.diff.removed > 0;
  const stepCount = toolCount + (hasThinking ? 1 : 0);

  return (
    <div className="pf" data-flow data-flow-state={isStreaming ? 'running' : 'done'}>
      {/* 整轮时钟：唯一的计时口径（旧「已工作」收纳线随 v2 封存） */}
      {clockText && (
        <div className="pf-hdr" data-flow-clock={clockMs ?? undefined}>
          {clockText}
        </div>
      )}

      {/* 阶段条 + 可折叠图例 */}
      {phases.length > 0 && (
        <>
          <div className="pf-bar-row">
            <div className="pf-bar" aria-hidden="true">
              {phaseSegments.map((p, i) => (
                <i
                  key={`${p.kind}:${i}`}
                  className={`is-${p.kind}${p.failed ? ' is-failed' : ''}${p.live ? ' is-live' : ''}`}
                  data-phase-segment={p.kind}
                  data-phase-failed={p.failed ? '1' : undefined}
                  style={{ left: `${p.left}%`, width: `${p.width}%` }}
                />
              ))}
            </div>
            <button
              type="button"
              className="pf-toggle"
              data-phase-toggle
              aria-expanded={legendOpen}
              aria-label={t('chat.trace.phase.legend')}
              title={t('chat.trace.phase.legend')}
              onClick={toggleLegend}
            >
              <ChevronRight size={13} className={`pf-chev${legendOpen ? ' open' : ''}`} aria-hidden="true" />
            </button>
          </div>
          {legendOpen && (
            <div className="pf-legend" data-phase-legend>
              {PHASE_LEGEND_ORDER.map(it => (
                <span key={it.kind} className="pf-legend-item">
                  <i className={`is-${it.kind}`} aria-hidden="true" />
                  {t(it.key)}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* 状态胶囊：整轮唯一 */}
      <div className="pf-pill-row">
        <span className="pf-pill" data-flow-pill={pill.state}>
          <i className={`pf-pill-dot is-${pill.tone}`} aria-hidden="true" />
          <span aria-live="polite">{pill.text}</span>
        </span>
      </div>

      {/* 摘要线 = 步骤区的折叠开关（参考页形态） */}
      <div
        className="pf-steps-bar"
        data-flow-summary
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        onClick={toggleFold}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleFold();
          }
        }}
      >
        <ChevronRight size={13} className={`pf-chev${!folded ? ' open' : ''}`} aria-hidden="true" />
        <span className="pf-trace-summary">{summaryText}</span>
        {folded && (
          <span className="pf-foldtag" data-flow-foldtag>
            {isStreaming ? t('chat.trace.running') : manualFold === null ? t('chat.trace.folded') : ''}
          </span>
        )}
        {stepCount > 0 && <span className="pf-count">{t('chat.trace.stepsCount', { n: stepCount })}</span>}
        {showTotalDiff && (
          <span className="pf-diff" data-flow-diff-total={`+${summary.diff.added} -${summary.diff.removed}`}>
            <span className="pf-diff-add">+{summary.diff.added}</span>
            <span className="pf-diff-del">-{summary.diff.removed}</span>
          </span>
        )}
      </div>

      {/* 步骤流：思考 / 工具 / 旁白同一平面（折叠时隐藏，答案永远可见） */}
      {!folded && (
        <div className="pf-steps" data-flow-steps>
          {flatRows.map(fr =>
            fr.kind === 'narration' ? (
              <p key={fr.id} className="pf-narration" data-flow-narration>
                {fr.text}
              </p>
            ) : (
              <FlowRow
                key={fr.item.id}
                item={fr.item}
                open={openIds.has(fr.item.id)}
                onToggle={() => toggleRow(fr.item.id)}
              />
            )
          )}
        </div>
      )}

      {/* 答案在流内（参考页 .ans），不折进摘要线。
          排版沿用全站答案类（.tc-answer）：markdown 的字号/行高/断行规则
          与纯文本回答同一套——答案排版不属于被推翻的流程方案。 */}
      <div className="pf-ans" data-flow-answer>
        {answerText ? (
          <div className="tc-answer min-w-0 max-w-full break-words">
            <AnswerMarkdown text={answerText} streaming={!!isStreaming} cwd={cwd} at={at} />
            {isStreaming && <span className="pf-caret" aria-hidden="true" />}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── 单行步骤（思考 / 工具） ─────────────────────────────────────────

function FlowRow({
  item,
  open,
  onToggle,
}: {
  item: TraceItem;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isThink = item.kind === 'thinking';
  const redacted = isThink && !!item.thinking?.redacted;
  /** 等待确认：权限类工具 → 盾牌图标 + 琥珀色（参考页 is-wait） */
  const waiting = !isThink && isWaitingTool('tool', item.toolName);
  const state: RowState = waiting
    ? 'wait'
    : item.status === 'running'
      ? 'running'
      : item.status === 'error'
        ? 'error'
        : item.status === 'interrupted'
          ? 'interrupted'
          : 'done';
  const running = state === 'running';
  const Icon = flowIcon(isThink ? 'thinking' : 'tool', item.toolName, typeof item.block?.input?.command === 'string' ? item.block.input.command : '');

  const verb = isThink
    ? running
      ? t('chat.trace.thinkingLive')
      : t('chat.trace.verb.thinking')
    : VERB_KEY[item.verb]
      ? t(VERB_KEY[item.verb])
      : item.verb;

  const mono = !isThink && SHELL_TOOL_NAMES.has(item.toolName);
  const target = isThink ? '' : targetOf(item);
  const hunks =
    !isThink && (EDIT_TOOL_NAMES.has(item.toolName) || WRITE_TOOL_NAMES.has(item.toolName))
      ? buildDiffHunks(item.toolName, item.block?.input)
      : null;
  const cmd =
    !isThink && SHELL_TOOL_NAMES.has(item.toolName)
      ? typeof item.block?.input?.command === 'string'
        ? item.block.input.command
        : ''
      : '';
  const output = !isThink ? item.block?.output ?? '' : '';
  const otherInput =
    !isThink && hunks == null && !cmd
      ? targetOf(item)
      : '';

  const hasDetail = isThink
    ? !!(item.thinking?.text && !item.thinking.redacted)
    : hunks != null || !!cmd || !!output;
  // 可点击 = 有明细；思考行只要有正文就可点开（已隐去的没有正文，点了也没反应 → 不可点）
  const clickable = hasDetail || (isThink && !redacted && !!item.thinking?.text);
  // 参考页口径：展开看明细；运行中的工具只要有输出就自动露尾
  const detailVisible = hasDetail && (open || (running && !!output));

  let meta = '';
  if (redacted) {
    meta = '';
  } else if (isThink) {
    // 思考行的秒数参考页是实时跳动（dur = en ?? now − st）
    if (running) {
      const startedAt = item.thinking?.startedAt ?? 0;
      meta =
        startedAt > 0
          ? formatStepDuration(Math.max(0, Date.now() - startedAt)) ?? t('chat.trace.executing')
          : t('chat.trace.executing');
    } else {
      meta = formatStepDuration(item.durationMs) ?? '';
    }
  } else if (running) {
    meta = t('chat.trace.running');
  } else if (state === 'error') {
    const dur = formatStepDuration(item.durationMs);
    meta = dur ? `${t('chat.trace.failed')} · ${dur}` : t('chat.trace.failed');
  } else if (state === 'interrupted') {
    meta = t('chat.trace.noResult');
  } else {
    meta = formatStepDuration(item.durationMs) ?? '';
  }

  const thinkText = isThink ? item.thinking?.text ?? '' : '';
  const thinkNoteVisible = isThink && (running || open) && !!thinkText && !redacted;
  // A126：summary = 厂商只给了摘要，必须标注——否则用户以为看到了完整思维链
  const isSummary = isThink && item.thinking?.format === 'summary';

  return (
    <div
      className={`pf-step is-${state}`}
      data-flow-row={item.id}
      data-flow-row-state={state}
      data-flow-row-kind={isThink ? 'thinking' : 'tool'}
      data-flow-verb={isThink ? undefined : item.verb}
    >
      <Icon className="pf-ico" size={14} strokeWidth={1.75} aria-hidden="true" />
      <div
        className="pf-step-head"
        data-clickable={clickable ? '1' : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? open : undefined}
        onClick={clickable ? onToggle : undefined}
        onKeyDown={
          clickable
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        <span className="pf-verb">{redacted ? t('chat.trace.redacted') : verb}</span>
        {isSummary && (
          <span className="pf-badge" data-flow-think-badge="summary" title={t('chat.trace.summaryBadge')}>
            {t('chat.trace.summaryBadge')}
          </span>
        )}
        {target && <span className={`pf-target${mono ? ' mono' : ''}`}>{target}</span>}
        {item.diff && <DiffTag diff={item.diff} />}
        {meta && <span className="pf-meta">{meta}</span>}
      </div>
      {detailVisible && !isThink && (
        <div className="pf-detail" data-flow-detail>
          {hunks
            ? renderDetailLines(detailOfEdit(hunks))
            : (
              <>
                {cmd && <div className="pf-detail-cmd">$ {cmd.slice(0, 500)}</div>}
                {renderOutputLines(output)}
              </>
            )}
        </div>
      )}
      {thinkNoteVisible && (
        <div className="pf-think-note" data-flow-think-note>
          {thinkText.length > THINK_NOTE_LIMIT
            ? `${thinkText.slice(0, THINK_NOTE_LIMIT)}…`
            : thinkText}
        </div>
      )}
    </div>
  );
}

function renderDetailLines(lines: { kind: 'add' | 'del' | 'ctx'; text: string }[]) {
  const shown = lines.slice(0, DETAIL_LINE_LIMIT);
  const hidden = lines.length - shown.length;
  return (
    <>
      {shown.map((l, i) => (
        <span key={i} className={`pf-line is-${l.kind}`}>
          {l.text}
          {'\n'}
        </span>
      ))}
      {hidden > 0 && <span className="pf-line-more">…其余 {hidden} 行未显示</span>}
    </>
  );
}

function renderOutputLines(output: string) {
  if (!output) return null;
  const lines = output.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-40);
  return (
    <>
      {lines.length > 40 && <span className="pf-line-more">…（仅显示最后 40 行）</span>}
      {tail.map((l, i) => (
        <span key={i} className={`pf-line${/^(✗|error|Error|ERROR|失败)/.test(l.trim()) ? ' is-del' : ''}`}>
          {l}
          {'\n'}
        </span>
      ))}
    </>
  );
}
