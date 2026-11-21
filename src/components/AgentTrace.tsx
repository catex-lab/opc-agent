/**
 * 执行轨迹 v2（2026-11-21 定版，对照 ZCode 过程条形态，用户逐图拍板）。
 *
 * ## 定版形态（五张效果图口径）
 *
 *   1. **收纳线**：整个执行过程流唯一的门面是一行「已工作 X 秒」（满 1 分钟
 *      「M 分 S 秒」）。旧的「执行、检查 · 成功」摘要字样退役。
 *      · 执行中（正文未开始）：自动展开跟滚，秒数逐秒跳动；
 *      · 正文一开始输出：立即折叠成一行，且**不再自动展开**（手动点开回看
 *        仍允许，收起后回到折叠态）；
 *      · 回合结束：定格（真实墙钟 = 最后一个块 endedAt − 第一个块 startedAt）。
 *   2. **扁平单行**：每步一行、全部同层（旧的一级二级缩进退役）——
 *      `[hover 浮现箭头][类型图标][动词][单行内容 flex-1 截断][耗时]`。
 *      内容永不折行；展开详情面板内部才允许层级。
 *   3. **图标随步骤类型**（lucide，ZCode 同款映射思路）。
 *   4. **连续同类型步骤合并成组**（一期就做，用户拍板）：相邻且动词相同的
 *      步骤合并为组头「图标 + 类型 + N 次 + 累计耗时」，点组头开合；
 *      进行中的组自动展开跟随（组头扫光）。思考/旁白插队即断组。
 *   5. **运行中三件套**：行背景光晕自左而右循环 + 动词/实时内容文字扫光 +
 *      左缘光晕条；内容 = 实时尾部逐帧刷新 + 光标。
 *   6. **详情面板**：命令区（$ 提示符 + mono，pre-wrap + break-words）、
 *      输出区（**上限 5 行区内滚动 + 吸底跟随 + 上滚冻结**，用户拍板）、
 *      思考详情（全文 + 字数）。字数 chip 从行上退役，归入详情。
 *
 * ## 与 gate 的契约
 *
 * `[data-steps-bar]`（收纳线，aria-expanded = 展开态）、`[data-trace-scroll]`
 * （步骤容器，仅展开时挂载）、`[data-tool-step]` / `data-trace-verb` /
 * `data-trace-completion` / `.tc-trace-meta`（行级耗时/状态）/
 * `data-trace-tail` / `data-trace-narration` / `data-trace-thinking` /
 * `data-trace-totalms` / `data-trace-unreturned` 保留；
 * 新增 `[data-trace-group]`（组头）与 `data-trace-elapsed`（收纳线上的毫秒数）。
 * `.tc-step-dot` 随圆点形态退役（图标即状态载体）。
 *
 * ## 状态收口（不变）
 *
 * 行状态仍走 src/trace/fold.ts 的完成判定（真实结束事件 > 下一条事件兜底 >
 * 本轮结束标「未回传」）。
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
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  baseName,
  buildDiffHunks,
  formatHandledDurationText,
  formatStepDuration,
  summarizeTrace,
  type TraceDiff,
  type TraceItem,
} from '../../shared/trace';
import { DiffView } from './DiffView';
import { useOverflowY } from '../hooks/useOverflowY';
import { hasUnreturnedResult, resolveTraceItems, type ResolveTraceOptions, type ResolvedTraceItem } from '../trace/fold';
import { buildTraceRows, isNarration, stepRows, type TraceRow } from '../trace/rows';
import { useTranslation, type Locale, type MessageKey, type Translate } from '../i18n';
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

/** 命令行类工具：折叠行内容用等宽字体（命令 / 脚本一眼可辨） */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'execute']);

/**
 * 工具 → 图标。单色化：图标一律 placeholder 灰，状态区分靠形状与动效，
 * 不靠颜色。入参一律 `String()` 兜底 —— 历史上 `tool.name` 缺失时这里抛过
 * `toLowerCase of undefined`，直接把整屏打成白屏。
 */
function iconOf(toolName: string): LucideIcon {
  switch (String(toolName).toLowerCase()) {
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
/** 工具主入参：没有输出时的尾部回退（让活跃行显示「在处理什么」） */
function primaryInputOf(input?: Record<string, unknown>): string {
  if (!input) return '';
  for (const k of ['command', 'query', 'url', 'pattern', 'file_path', 'path', 'skill', 'args']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 完成态单行摘要：文件步骤给文件名，其余给命令/查询/URL/主入参本身 */
function summaryOf(item: ResolvedTraceItem): string {
  if (item.path) return baseName(item.path);
  return primaryInputOf(item.block?.input) || item.target || '';
}

/** 折叠过渡时长（ms）。改这里必须同步 traceFold.css 与 index.css 的 `.tc-trace-fold`。 */
const FOLD_MS = 220;

/**
 * F4：贴底跟随的时间预算（ms）。预算按**时间**给（FOLD_MS + 120 = 340ms），
 * 覆盖最长的展开动画再留一帧余量 —— 不依赖帧率，跨平台一致。
 */
const PIN_BUDGET_MS = FOLD_MS + 120;

/** 关键步骤的 tooltip —— 说明它为什么带着 pin 标记 */
const CRITICAL_TITLE_KEY: Record<string, MessageKey> = {
  write: 'chat.trace.criticalWrite',
  delete: 'chat.trace.criticalDelete',
  permission: 'chat.trace.criticalPermission',
  error: 'chat.trace.criticalError',
};

/**
 * 展开明细：不同工具只差在「哪几段」，样式统一交给面板（.tcv2-detail）。
 * 命令区带 `$` 提示符（1ch 列，ZCode ExecuteCommand 同款）。
 */
function detailOf(item: ResolvedTraceItem, t: Translate): ReactNode {
  const input = item.block?.input ?? {};
  const name = item.toolName;

  if (name === 'skill') {
    const args = String(input.args ?? '');
    return args ? (
      <pre className="tcv2-pre">{args.slice(0, 300)}</pre>
    ) : null;
  }
  if (name === 'bash' || name === 'shell' || name === 'execute') {
    const cmd = String(input.command ?? '');
    if (!cmd) return null;
    return (
      <pre className="tcv2-pre">
        <span className="tcv2-prompt">$ </span>
        {cmd.slice(0, DETAIL_LIMIT)}
      </pre>
    );
  }
  if (name === 'webfetch') {
    const url = String(input.url ?? '');
    return url ? (
      <pre className="tcv2-pre">
        <span className="tcv2-prompt">URL </span>
        {url}
      </pre>
    ) : null;
  }
  if (item.path) {
    const content = String(input.content ?? '');
    return (
      <pre className="tcv2-pre">
        {item.path}
        {content ? `\n${content.slice(0, 1000)}` : ''}
      </pre>
    );
  }
  if (Object.keys(input).length === 0) return null;
  let json = '';
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return <pre className="tcv2-pre">{json.slice(0, 300)}</pre>;
}

/**
 * 输出块：**上限 5 行区内滚动 + 吸底跟随 + 上滚冻结**（用户拍板，ZCode
 * ExecuteOutput 同款）。流式中贴底；用户向上滚动即冻结视口（不再被新输出
 * 拽走），滚回底部恢复跟随。结束后保留阅读位置。
 */
function OutputBox({ text, running, isError }: { text: string; running: boolean; isError?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  /** 用户向上滚走后冻结在当时的文本快照上（回到底部自动解冻） */
  const [frozen, setFrozen] = useState<string | null>(null);
  const followedRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    followedRef.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [running, text]);

  if (!text) return null;
  const display = frozen ?? text;
  const shown =
    display.length > DETAIL_LIMIT
      ? running
        ? `…\n${display.slice(-DETAIL_LIMIT)}`
        : `${display.slice(0, DETAIL_LIMIT)}\n…`
      : display;

  return (
    <div className="tcv2-out-wrap">
      <div className="tcv2-dlabel">
        <span>{isError ? t('chat.trace.error') : t('chat.trace.output')}</span>
        <span className="tcv2-dhint">{t('chat.trace.outputCap')}</span>
      </div>
      <div
        ref={ref}
        className="tcv2-out fade-tail"
        style={{ color: isError ? 'var(--td-error-color)' : undefined }}
        data-tool-output
        onScroll={el => {
          if (!running || !followedRef.current) return;
          const box = el.currentTarget;
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 8;
          if (!atBottom && frozen === null) setFrozen(text);
          else if (atBottom && frozen !== null) setFrozen(null);
        }}
      >
        {shown}
      </div>
    </div>
  );
}

/** 单行步骤行（v2）：`[箭头 hover 浮现][图标][动词][单行内容][右侧列]`。
 *  内容永不折行（nowrap + ellipsis），展开详情面板在行下方。 */
function StepRow({
  item,
  open,
  onToggle,
  insideGroup,
  seenAt,
}: {
  item: ResolvedTraceItem;
  open: boolean;
  onToggle: () => void;
  insideGroup?: boolean;
  /** 该行首次出现的时间（运行中行的秒数从这里起算） */
  seenAt: number;
}) {
  const { t } = useTranslation();
  const running = item.status === 'running';
  const critical = item.critical;
  const [showBody, setShowBody] = useState(open);
  useEffect(() => {
    if (open) {
      setShowBody(true);
      return;
    }
    const timer = setTimeout(() => setShowBody(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const isThink = item.kind === 'thinking';
  const redacted = isThink && !!item.thinking?.redacted;
  const Icon = isThink ? Brain : iconOf(item.toolName);
  const verb = VERB_KEY[item.verb] ? t(VERB_KEY[item.verb]) : item.verb;
  const mono = !isThink && SHELL_TOOL_NAMES.has(String(item.toolName).toLowerCase());

  // 明细是否存在：思考行永远有全文；工具行看 diff / detail / 输出
  const hunks = useMemo(
    () => (!isThink && item.block ? buildDiffHunks(item.toolName, item.block.input) : null),
    [isThink, item]
  );
  const detail = !isThink ? detailOf(item, t) : null;
  const thinkText = item.thinking;
  const hasDetail = isThink ? !!(thinkText && !thinkText.redacted) : hunks != null || detail != null || !!item.block?.output;
  const canToggle = hasDetail;

  /**
   * 行内单行内容：运行中 = 实时尾部（最新内容）；完成后 =
   * 命令/查询/URL/文件名本身（正在干什么优先于抽象 target）。
   */
  const tail = running
    ? isThink
      ? tailOf(thinkText?.text)
      : tailOf(item.block?.output) || tailOf(primaryInputOf(item.block?.input), 56)
    : '';
  const summary = !running
    ? isThink
      ? (thinkText?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      : summaryOf(item)
    : '';

  // 右侧列：运行中 = 该行已跑秒数（逐秒跳动）；完成 = 真实耗时；
  // error/interrupted = 状态词（与耗时互斥——失败行给原因不给时长）。
  let meta: string;
  if (redacted) {
    // 被厂商隐去的思考：没有正文可数，字数与秒数都省（v1 同口径）
    meta = '';
  } else if (running) {
    const live = seenAt > 0 ? Math.max(1, Math.round((Date.now() - seenAt) / 1000)) : 0;
    meta = formatStepDuration(live * 1000) ?? t('chat.trace.executing');
  } else if (item.status === 'error') {
    meta = t('chat.trace.failed');
  } else if (item.status === 'interrupted') {
    meta = t('chat.trace.noResult');
  } else {
    meta = formatStepDuration(item.durationMs) ?? '';
  }

  const stepState =
    item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : item.status === 'interrupted' ? 'interrupted' : 'done';

  return (
    <div
      className={`tcv2-step is-${stepState}${insideGroup ? ' in-group' : ''}`}
      data-tool-step={!isThink ? item.id : undefined}
      data-trace-thinking={isThink ? item.id : undefined}
      data-redacted={redacted ? '1' : undefined}
      data-trace-verb={item.verb}
      data-trace-completion={item.completion}
      data-trace-critical={item.criticalReason}
      data-expanded={canToggle ? (open ? '1' : '0') : undefined}
    >
      <div className={`tcv2-row is-${stepState}`}>
        {canToggle && (
          <ChevronRight size={13} className="tcv2-chev" aria-hidden="true" />
        )}
        {!canToggle && <span className="tcv2-chev-blank" aria-hidden="true" />}
        <Icon size={15} className="tcv2-ic" aria-hidden="true" />
        <div
          className="tcv2-rowhead"
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
          title={
            critical
              ? t(CRITICAL_TITLE_KEY[item.criticalReason ?? ''] ?? 'chat.trace.critical')
              : isThink
                ? undefined
                : item.path
          }
        >
        <span className={`tcv2-verb${running ? ' opc-sweep-text' : ''}`}>
          {redacted ? t('chat.trace.redacted') : isThink && running ? t('chat.trace.thinkingLive') : verb}
        </span>
        {tail ? (
          <span className={`tcv2-line${mono ? ' mono' : ''}`} data-trace-tail>
            {tail}
            <span className="opc-caret" aria-hidden="true" />
          </span>
        ) : redacted ? (
          <span className="tcv2-line">{t('chat.trace.redactedReason')}</span>
        ) : (
          summary && (
            <span className={`tcv2-line${mono ? ' mono' : ''}`}>
              {summary}
            </span>
          )
        )}
        {item.diff && <DiffTag diff={item.diff} />}
        {critical && (
          // F2：7px 方块 + 左侧竖条就够表达「这一步值得回看」。
          <span className="tc-trace-pin" data-trace-pin={item.criticalReason} aria-hidden="true" />
        )}
        {item.kind === 'tool' && item.block?.source === 'parsed_text' && (
          <span className="tc-trace-src" data-trace-source="parsed_text" title={t('chat.trace.parsedTitle')}>
            {t('chat.trace.parsedBadge')}
          </span>
        )}
        {meta && (
          <span className={`tc-trace-meta tcv2-chip${running ? ' opc-sweep-soft' : ''}`} data-trace-status={item.status}>
            {meta}
          </span>
        )}
        </div>
      </div>
      {showBody && (
        <div className="tc-step-body tcv2-body" data-step-body data-open={open ? '1' : '0'}>
          <div className="tc-step-body-inner tcv2-detail">
            {isThink ? (
              thinkText && !thinkText.redacted ? (
                <>
                  <div className="tcv2-dlabel">
                    <span>{t('chat.trace.thinkingFull')}</span>
                    <span className="tcv2-dhint">{t('chat.thinking.chars', { n: thinkText.text.length })}</span>
                  </div>
                  <pre className="tcv2-pre tcv2-think-full">{thinkText.text}</pre>
                </>
              ) : null
            ) : (
              <>
                {hunks ? <DiffView hunks={hunks} /> : detail}
                <OutputBox
                  text={item.block?.output ?? ''}
                  running={item.status === 'running'}
                  isError={item.status === 'error'}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** tick 只负责触发重渲染；真实时间一律 Date.now() 现取，不累计漂移。
 *  （已并入调用点：行/组的运行中耗时直接 Date.now() 现算。） */

/** 组头（连续同类型步骤合并，一期形态）：`[箭头][图标][类型][N 次][累计耗时]` */
function GroupBlock({
  group,
  open,
  onToggle,
  openIds,
  toggleRow,
  seenAtOf,
}: {
  group: TraceGroup;
  open: boolean;
  onToggle: () => void;
  openIds: ReadonlySet<string>;
  toggleRow: (id: string) => void;
  seenAtOf: (id: string) => number;
}) {
  const { t } = useTranslation();
  const Icon = iconOf(group.items[0]?.toolName ?? '');
  const verb = VERB_KEY[group.verb] ? t(VERB_KEY[group.verb]) : group.verb;
  // 累计耗时：完成步用真实 duration；运行中的成员按 seenAt 现算
  const total =
    group.items.reduce((sum, it) => {
      if (it.status === 'running') {
        const seen = seenAtOf(it.id);
        return sum + (seen > 0 ? Date.now() - seen : 0);
      }
      return sum + (it.durationMs ?? 0);
    }, 0) || undefined;

  return (
    <div className={`tcv2-group${group.running ? ' is-running' : ''}`} data-trace-group={group.id} data-trace-group-running={group.running ? '1' : undefined}>
      <div
        className="tcv2-gh"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronRight size={13} className="tcv2-chev" aria-hidden="true" />
        <Icon size={15} className="tcv2-ic" aria-hidden="true" />
        <span className={`tcv2-verb${group.running ? ' opc-sweep-text' : ''}`}>{verb}</span>
        <span className={`tcv2-line${group.running ? ' opc-sweep-soft' : ''}`}>
          {group.running ? t('chat.trace.executing') : t('chat.trace.groupRuns', { n: group.items.length })}
        </span>
        {total != null && (
          <span className={`tc-trace-meta tcv2-chip${group.running ? ' opc-sweep-soft' : ''}`}>
            {formatStepDuration(total) ?? ''}
          </span>
        )}
      </div>
      {open && (
        <div className="tcv2-gbody">
          {group.items.map(it => (
            <StepRow
              key={it.id}
              item={it}
              open={openIds.has(it.id)}
              onToggle={() => toggleRow(it.id)}
              insideGroup
              seenAt={seenAtOf(it.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 连续同类型步骤的组（一期形态，用户拍板） */
interface TraceGroup {
  id: string;
  verb: string;
  items: ResolvedTraceItem[];
  running: boolean;
}

/** 展开段：旁白 / 单行 / 组 */
type Segment =
  | { kind: 'narration'; id: string; text: string }
  | { kind: 'row'; row: ResolvedTraceItem }
  | { kind: 'group'; group: TraceGroup };

/**
 * 扁平化 + 分组：
 * 1. 旧形态里思考会缩进挂在工具下（item.nested）——v2 全部拉平成兄弟行，
 *    顺序 = 工具行紧跟它的思考行；嵌套思考同样过一遍 fold 的完成判定
 *    （它们此前是未解析的裸 TraceItem）；
 * 2. 相邻且动词相同的步骤合并成组（思考/旁白插队即断组）；
 * 3. 单行成组没有意义：只有 ≥2 行才包组。
 */
function buildSegments(rows: readonly TraceRow[], opts: ResolveTraceOptions): Segment[] {
  // 先拉平
  const flat: TraceRow[] = [];
  for (const row of rows) {
    if (isNarration(row)) {
      flat.push(row);
      continue;
    }
    flat.push(row);
    if (row.nested.length > 0) flat.push(...resolveTraceItems(row.nested, opts));
  }

  const segments: Segment[] = [];
  let pending: ResolvedTraceItem[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    if (pending.length >= 2) {
      const verb = pending[0]!.verb;
      segments.push({
        kind: 'group',
        group: {
          id: `${pending[0]!.id}:grp`,
          verb,
          items: pending,
          running: pending.some(i => i.status === 'running'),
        },
      });
    } else {
      segments.push({ kind: 'row', row: pending[0]! });
    }
    pending = [];
  };

  for (const row of flat) {
    if (isNarration(row)) {
      flushPending();
      segments.push({ kind: 'narration', id: row.id, text: row.text });
      continue;
    }
    if (pending.length > 0 && pending[0]!.verb !== row.verb) flushPending();
    pending.push(row);
  }
  flushPending();
  return segments;
}

export interface AgentTraceProps {
  /** 一条轨迹段：连续的「工具 / 思考」块 */
  blocks: readonly Block[];
  /** 这一轮是否还在流式（决定活跃行的动态与自动贴底） */
  isStreaming?: boolean;
  /** 正文已开始 / 本轮已结束：收纳线自动折叠的信号（见组件内自动开合） */
  collapse?: boolean;
}

export function AgentTrace({ blocks, isStreaming = false, collapse = false }: AgentTraceProps) {
  const { t, locale } = useTranslation();

  const rows = useMemo(
    () =>
      buildTraceRows(blocks, {
        streaming: !!isStreaming,
        contentStarted: !!collapse,
      }),
    [blocks, isStreaming, collapse]
  );
  const segments = useMemo(() => buildSegments(rows, { streaming: !!isStreaming, contentStarted: !!collapse }), [rows, isStreaming, collapse]);
  const steps = useMemo(() => stepRows(rows), [rows]);
  const summary = useMemo(() => summarizeTrace(steps), [steps]);
  const totalMs = steps.reduce((s, i) => s + (i.durationMs ?? 0), 0);
  const unreturned = hasUnreturnedResult(steps);
  const running = rows.some(i => !isNarration(i) && i.status === 'running');

  /** 明细开合的唯一事实源（行点击都写这里） */
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 收纳线开合。
   *
   * 自动规则（用户定版）：
   *   · 执行中（isStreaming 且正文未开始）→ 展开，跟随滚动；
   *   · 正文开始输出（collapse 翻真）→ 立即折叠，且**不再自动展开**；
   *   · 回合结束 → 折叠。
   * 手动点开允许（拍板「可以点开」）：手动操作写入 userOverride，自动规则
   * 在流式期间不再覆盖它；回合结束强制回折叠默认态。
   */
  const [open, setOpen] = useState<boolean>(!!isStreaming && !collapse);
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  /** 回合结束强制回折叠默认态（只在 流式→结束 的沿上生效，不盯 override） */
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setUserOverride(null);
      setOpen(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);
  /** 流式期间：正文开始 → 自动收；手动点过则尊重手动（拍板「可以点开」） */
  useEffect(() => {
    if (!isStreaming) return;
    if (userOverride !== null) return;
    setOpen(!collapse);
  }, [isStreaming, collapse, userOverride]);
  const toggleOpen = () => {
    setUserOverride(open ? false : true);
    setOpen(prev => !prev);
  };

  /**
   * 「已工作」墙钟：第一个块 startedAt →（流式中）now /（结束）最后一个块
   * endedAt。历史消息没有 live 时钟，直接用真实时间戳算 —— 刷新后定格
   * 数字不变。流式中每秒重渲染一次让秒数跳动；因此这里**刻意不用
   * useMemo** —— 每次渲染现算，秒跳才可见。
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const iv = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, [isStreaming]);

  const computeElapsedMs = (): number => {
    let start = Infinity;
    let end = 0;
    for (const b of blocks) {
      if (b.type !== 'tool' && b.type !== 'thinking') continue;
      const s = (b as { startedAt?: number }).startedAt ?? 0;
      const e = (b as { endedAt?: number }).endedAt ?? 0;
      if (s > 0) start = Math.min(start, s);
      if (e > 0) end = Math.max(end, e);
    }
    if (!Number.isFinite(start)) return totalMs;
    // 流式中 = 到现在为止；结束 = 真实墙钟（没有 endedAt 的轮退回 totalMs）
    if (isStreaming) return Math.max(0, Date.now() - start);
    return end > start ? end - start : totalMs;
  };
  const elapsedMs = computeElapsedMs();

  /** 行首见时间：运行中行的秒数从这里起算（真实 duration 要等结束事件） */
  const seenAtRef = useRef<Map<string, number>>(new Map());
  const seenAtOf = (id: string): number => seenAtRef.current.get(id) ?? 0;
  useEffect(() => {
    const now = Date.now();
    for (const row of rows) {
      if (isNarration(row)) continue;
      if (!seenAtRef.current.has(row.id)) seenAtRef.current.set(row.id, now);
      for (const n of row.nested) {
        if (!seenAtRef.current.has(n.id)) seenAtRef.current.set(n.id, now);
      }
    }
  }, [rows]);

  /** 组开合：运行中的组自动展开（跟随）；用户点过组头则尊重用户 */
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({});
  const toggleGroup = (id: string) => {
    setGroupOverride(prev => ({ ...prev, [id]: !(prev[id] ?? false) }));
  };
  const groupOpen = (g: TraceGroup): boolean => {
    const o = groupOverride[g.id];
    if (o !== undefined) return o;
    return g.running;
  };

  // 渐隐遮罩：只有真的溢出时才淡出
  const { ref: scrollRef, el: scrollEl, overflowing } = useOverflowY<HTMLDivElement>();

  /**
   * 流式中贴底：新步骤永远在末尾。F4 预算按时间给（340ms），
   * 依赖用 segments —— 组开合 / 行追加都会重新贴底。
   */
  useEffect(() => {
    if (!running || !open || !scrollEl) return;
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
  }, [running, open, segments, scrollEl]);

  if (rows.length === 0) return null;

  const showTotalDiff = summary.diff.added > 0 || summary.diff.removed > 0;
  const stepCount = steps.filter(i => i.kind === 'tool').length;
  const worked = formatHandledDurationText(elapsedMs, (locale ?? 'zh') as Locale);

  return (
    <div className="tc-trace tcv2-shell" data-trace data-trace-state={running ? 'running' : 'done'}>
      <div
        className="tc-steps-bar tcv2-collapser"
        data-steps-bar
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={t('chat.trace.viewSteps')}
        onClick={toggleOpen}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleOpen();
          }
        }}
      >
        <ChevronRight size={14} className={`tcv2-chev${open ? ' open' : ''}`} aria-hidden="true" />
        <span className="tcv2-worked" data-trace-elapsed={elapsedMs}>
          {worked ? t('chat.trace.worked', { n: worked }) : t('chat.trace.worked', { n: '0 秒' })}
        </span>
        {unreturned && (
          <span className="tc-trace-unreturned" data-trace-unreturned title={t('chat.trace.unreturnedTitle')}>
            {t('chat.trace.unreturned')}
          </span>
        )}
        {showTotalDiff && (
          <span className="tc-diff" data-diff-total={`+${summary.diff.added} -${summary.diff.removed}`}>
            <span className="tc-diff-add">+{summary.diff.added}</span>
            <span className="tc-diff-del">-{summary.diff.removed}</span>
          </span>
        )}
        {stepCount > 0 && <span className="tcv2-hint">{t('chat.trace.stepsCount', { n: stepCount })}</span>}
      </div>

      {open && (
        <div
          ref={scrollRef}
          className="tc-trace-scroll tc-scroll-fade tcv2-rows"
          data-trace-scroll
          data-fade={overflowing ? '1' : undefined}
        >
          {segments.map(seg => {
            if (seg.kind === 'narration') {
              return (
                <p key={seg.id} className="tc-trace-narration" data-trace-narration>
                  {seg.text}
                </p>
              );
            }
            if (seg.kind === 'row') {
              return (
                <StepRow
                  key={seg.row.id}
                  item={seg.row}
                  open={openIds.has(seg.row.id)}
                  onToggle={() => toggleRow(seg.row.id)}
                  seenAt={seenAtOf(seg.row.id)}
                />
              );
            }
            return (
              <GroupBlock
                key={seg.group.id}
                group={seg.group}
                open={groupOpen(seg.group)}
                onToggle={() => toggleGroup(seg.group.id)}
                openIds={openIds}
                toggleRow={toggleRow}
                seenAtOf={seenAtOf}
              />
            );
          })}
        </div>
      )}
      {totalMs > 0 && <span data-trace-totalms hidden>{totalMs}</span>}
    </div>
  );
}

export default AgentTrace;
