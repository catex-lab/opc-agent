/**
 * 单聊过程流 · 右侧常驻「过程」面板（2026-11-22，参考页 side 面板）。
 *
 * 与终端/浏览器面板同级：不随聊天滚动，宽 236px（与群成员/群设置面板同档）。
 * 内容：状态胶囊、阶段图例、横向时间轴（每步一行，条形按起止时间定位、
 * 运行中实时增长）、详情区、底部时间滑块（按块时间窗定位 + 高亮）。
 *
 * 数据全部从 ProcessFlow 同一份 blocks 派生（groupPhases / buildTraceRows），
 * 不碰 SSE 事件流 —— 历史消息（刷新还原）也能渲染。
 */

import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Minimize2, Move, PanelRight, PanelTop } from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  clampPanelPos,
  snapPanelMode,
  type PanelMode,
} from '../trace/panelGeometry';
import {
  baseName,
  formatStepDuration,
  groupPhases,
  type FlowPhase,
} from '../../shared/trace';
import { buildTraceRows, stepRows } from '../trace/rows';
import { flowIcon } from '../trace/icons';
import { useTranslation, type MessageKey } from '../i18n';
import '../trace/processPanel.css';

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

/** 面板时间轴用的一行 */
interface AxisRow {
  id: string;
  kind: 'tool' | 'thinking';
  verb: string;
  target: string;
  /** shell 命令（判「测试/验证」图标用） */
  cmd: string;
  start?: number;
  end?: number;
  running: boolean;
  error: boolean;
}

/** 从块序列取「有时间轴的行」，归一到 [0,1] 时间窗 */
function axisRows(blocks: readonly Block[]): { rows: AxisRow[]; win: [number, number] | null } {
  const rows: AxisRow[] = [];
  let min = Infinity;
  let max = 0;
  for (const b of blocks) {
    if (b.type === 'thinking') {
      const s = b.startedAt;
      const e = b.endedAt;
      if (s > 0) {
        min = Math.min(min, s);
        max = Math.max(max, e ?? s);
      }
      rows.push({
        id: b.id,
        kind: 'thinking',
        verb: '深度思考',
        target: '',
        cmd: '',
        start: s > 0 ? s : undefined,
        end: typeof e === 'number' && e > 0 ? e : undefined,
        running: b.state === 'streaming',
        error: false,
      });
    } else if (b.type === 'tool') {
      const s = b.startedAt;
      const e = b.endedAt;
      if (s > 0) {
        min = Math.min(min, s);
        max = Math.max(max, e ?? s);
      }
      const input = (b.input ?? {}) as Record<string, unknown>;
      const fp = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
      rows.push({
        id: b.toolId || b.id,
        kind: 'tool',
        verb: b.name ?? 'tool',
        target: fp ? baseName(fp) : '',
        cmd: typeof input.command === 'string' ? input.command : '',
        start: s > 0 ? s : undefined,
        end: typeof e === 'number' && e > 0 ? e : undefined,
        running: b.status === 'running' || b.status === 'pending',
        error: b.status === 'failed' || b.isError === true,
      });
    }
  }
  if (!Number.isFinite(min)) return { rows, win: null };
  return { rows, win: [min, Math.max(max, min)] };
}

export interface ProcessPanelProps {
  blocks: readonly Block[];
  isStreaming?: boolean;
  /** 当前选中的步骤 id（点击聊天里的步骤 → 面板高亮对应行） */
  selectedId?: string | null;
  onSelectStep?: (id: string) => void;
  /** 回放定位：滑块/快捷键把某个时间点映射到步骤，滚动聊天区 */
  onSeek?: (id: string) => void;
  open: boolean;
  /** 停靠形态；缺省 right，保持历史调用方与闸门不变 */
  mode?: PanelMode;
  /** 浮动态视口坐标 */
  pos?: { x: number; y: number };
  onModeChange?: (mode: PanelMode) => void;
  onPosChange?: (pos: { x: number; y: number }) => void;
  /** 最小化时点胶囊回到的位置 */
  restoreMode?: 'right' | 'top' | 'floating';
  /** 输入浮层实测高度，用于拖动禁区下边界 */
  inputHeight?: number;
}

/** 阶段色映射（与 processFlow.css 一致，面板内用同款） */
function phaseKey(p: FlowPhase): string {
  return p.kind;
}

export function ProcessPanel({
  blocks,
  isStreaming = false,
  selectedId,
  onSelectStep,
  onSeek,
  open,
  mode = 'right',
  pos,
  onModeChange,
  onPosChange,
  restoreMode = 'right',
  inputHeight = 0,
}: ProcessPanelProps) {
  const { t } = useTranslation();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const { rows, win } = useMemo(() => axisRows(blocks), [blocks]);
  const phases: FlowPhase[] = useMemo(
    () => groupPhases(stepRows(buildTraceRows(blocks, { streaming: isStreaming, contentStarted: true }))),
    [blocks, isStreaming]
  );

  // 播放头：当前时间（运行中 = now，结束 = 窗尾）
  const playhead = (() => {
    if (!win) return null;
    if (isStreaming) return Date.now();
    return win[1];
  })();

  const span = win ? Math.max(win[1] - win[0], 1) : 0;
  const pct = (ms?: number) => (win && typeof ms === 'number' ? Math.min(Math.max((ms - win[0]) / span, 0), 1) * 100 : null);

  // 回放滑块：0..1000 → 时间点 → 选中「该时刻正在运行/覆盖到它的行」
  const seekTo = (ratio: number) => {
    if (!win || !onSeek) return;
    const t = win[0] + (ratio / 1000) * span;
    // 找覆盖该时刻的行；没有就找该时刻之前最近结束的行
    let hit: AxisRow | null = null;
    for (const r of rows) {
      const s = r.start;
      const e = r.end;
      if (s !== undefined && s <= t && (e === undefined || e >= t)) {
        hit = r;
        break;
      }
    }
    if (!hit) {
      for (const r of rows) {
        if (r.start !== undefined && r.start <= t && (hit === null || (r.end ?? Infinity) > (hit.end ?? -Infinity))) {
          hit = r;
        }
      }
    }
    if (hit) onSeek(hit.id);
  };

  if (!open) return null;

  // 拖动禁区：标题栏 + Agent 名称行在上方，输入浮层在下方。
  const bounds = {
    viewportWidth: typeof window === 'undefined' ? 1440 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 900 : window.innerHeight,
    topGuard: 84,
    bottomGuard: inputHeight + 16,
  };
  const currentPos = pos ?? { x: Math.max(8, bounds.viewportWidth - 268), y: 92 };

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (mode !== 'floating') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: currentPos.x, oy: currentPos.y };
  };
  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    const next = clampPanelPos(
      { x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy, width: el.offsetWidth, height: el.offsetHeight },
      bounds
    );
    onPosChange?.(next);
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const el = panelRef.current;
    if (!dragRef.current || !el) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const snapped = snapPanelMode(
      { ...currentPos, width: el.offsetWidth, height: el.offsetHeight },
      bounds
    );
    dragRef.current = null;
    if (snapped !== 'floating') onModeChange?.(snapped);
  };
  const nudge = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (mode !== 'floating') return;
    const step = e.shiftKey ? 24 : 8;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) {
      if (e.key.toLowerCase() === 'm') onModeChange?.('minimized');
      return;
    }
    e.preventDefault();
    const el = panelRef.current;
    if (el) onPosChange?.(clampPanelPos({ ...currentPos, x: currentPos.x + dx, y: currentPos.y + dy, width: el.offsetWidth, height: el.offsetHeight }, bounds));
  };

  if (mode === 'minimized') {
    return (
      <button
        type="button"
        className="pf-min-pill"
        data-process-panel
        data-panel-mode="minimized"
        aria-label={t('chat.flow.panel.restore', { n: rows.length })}
        title={t('chat.flow.panel.restore', { n: rows.length })}
        onClick={() => onModeChange?.(restoreMode)}
      >
        <PanelRight size={12} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('chat.flow.panelTitle')} {rows.length}</span>
      </button>
    );
  }

  const modeButtons: Array<{ m: 'right' | 'top' | 'floating' | 'minimized'; Icon: typeof PanelRight; key: 'chat.flow.panel.modeRight' | 'chat.flow.panel.modeTop' | 'chat.flow.panel.modeFloat' | 'chat.flow.panel.modeMin' }> = [
    { m: 'right', Icon: PanelRight, key: 'chat.flow.panel.modeRight' },
    { m: 'top', Icon: PanelTop, key: 'chat.flow.panel.modeTop' },
    { m: 'floating', Icon: Move, key: 'chat.flow.panel.modeFloat' },
    { m: 'minimized', Icon: Minimize2, key: 'chat.flow.panel.modeMin' },
  ];

  return (
    <aside
      ref={panelRef}
      className={`pf-panel pf-${mode === 'floating' ? 'float' : `dock-${mode}`}`}
      data-process-panel
      data-panel-mode={mode}
      style={mode === 'floating' ? { left: currentPos.x, top: currentPos.y } : undefined}
    >
      <div className="pf-panel-hd">
        <button
          type="button"
          className="pf-panel-grip"
          data-panel-drag
          aria-label={t('chat.flow.panel.drag')}
          title={t('chat.flow.panel.drag')}
          tabIndex={mode === 'floating' ? 0 : -1}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => { dragRef.current = null; }}
          onKeyDown={nudge}
        >
          <Move size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <b>{t('chat.flow.panelTitle')}</b>
        <span className="pf-panel-pill" data-panel-pill>
          {isStreaming ? t('chat.flow.processing', { n: '' }) : t('chat.flow.handled', { n: '' })}
        </span>
        <span className="pf-modebar" role="group" aria-label={t('chat.flow.panelTitle')}>
          {modeButtons.map(({ m, Icon, key }) => (
            <button
              key={m}
              type="button"
              data-panel-mode-btn={m}
              className={mode === m ? 'is-on' : ''}
              aria-label={t(key)}
              title={t(key)}
              aria-pressed={mode === m}
              onClick={() => onModeChange?.(m)}
            >
              <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ))}
        </span>
      </div>

      {/* 阶段图例（与流程内图例同款） */}
      {phases.length > 0 && (
        <div className="pf-panel-legend" data-panel-legend>
          {phases.map((p, i) => (
            <span key={`${p.kind}:${i}`} className="pf-panel-legend-item">
              <i className={`is-${phaseKey(p)}${p.failed ? ' is-failed' : ''}`} aria-hidden="true" />
              {p.kind}
            </span>
          ))}
        </div>
      )}

      {/* 横向时间轴：每步一行，条形按起止时间定位 */}
      <div className="pf-panel-axis" data-panel-axis>
        {rows.map(r => {
          const left = pct(r.start);
          const endPct = pct(r.end ?? undefined);
          const width = left != null && endPct != null ? Math.max(endPct - left, 1.5) : left != null ? Math.max(100 - left, 1.5) : 0;
          const RowIcon = flowIcon(r.kind, r.verb, r.cmd);
          return (
            <div
              key={r.id}
              className={`pf-panel-row${r.running ? ' is-running' : ''}${r.error ? ' is-error' : ''}${selectedId === r.id ? ' is-sel' : ''}${hoverId === r.id ? ' is-hover' : ''}`}
              data-panel-row={r.id}
              data-panel-row-kind={r.kind}
              onMouseEnter={() => setHoverId(r.id)}
              onMouseLeave={() => setHoverId(prev => (prev === r.id ? null : prev))}
              onClick={() => onSelectStep?.(r.id)}
            >
              <span className="pf-panel-label">
                <RowIcon className="pf-panel-ico" size={12} strokeWidth={1.75} aria-hidden="true" />
                <span className="pf-panel-verb">{VERB_KEY[r.verb] ? t(VERB_KEY[r.verb]) : r.verb}</span>
                {r.target && <span className="pf-panel-target">{r.target}</span>}
              </span>
              <span className="pf-panel-track">
                <i
                  className={`is-${r.kind}${r.error ? ' is-error' : ''}${r.running ? ' is-running' : ''}`}
                  style={{ left: `${left ?? 0}%`, width: `${width}%` }}
                />
                {/* 播放头：只在当前行（悬停/选中）显示，避免每行一条竖线 */}
                {(hoverId === r.id || selectedId === r.id) && playhead != null && (
                  <i
                    className="pf-panel-playhead"
                    aria-hidden="true"
                    style={{ left: `${pct(playhead) ?? 0}%` }}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* 详情区：悬停/选中行显示命令输出或 diff 摘要 */}
      <div className="pf-panel-detail" data-panel-detail>
        {(() => {
          const hit = rows.find(r => r.id === (hoverId ?? selectedId));
          if (!hit) return t('chat.flow.panelHint');
          return (
            <span>
              {VERB_KEY[hit.verb] ? t(VERB_KEY[hit.verb]) : hit.verb}
              {hit.target ? ` ${hit.target}` : ''}
              {hit.start != null && hit.end != null
                ? ` · ${formatStepDuration(hit.end - hit.start) ?? ''}`
                : hit.running
                  ? ` · ${t('chat.flow.panelRunning')}`
                  : ''}
            </span>
          );
        })()}
      </div>

      {/* 底部时间滑块：按块时间窗定位（不重放执行） */}
      <div className="pf-panel-slider">
        <input
          type="range"
          min={0}
          max={1000}
          defaultValue={1000}
          aria-label={t('chat.flow.panelSeek')}
          data-panel-seek
          onInput={e => seekTo(Number((e.target as HTMLInputElement).value ?? 1000))}
        />
      </div>
    </aside>
  );
}

export default ProcessPanel;