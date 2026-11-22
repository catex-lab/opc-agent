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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2, PanelRight, PanelTop, Square } from 'lucide-react';
import type { Block } from '../../shared/blocks';
import {
  clampPanelPos,
  snapMinimizedDrop,
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
  open: boolean;
  /** 停靠形态；缺省 right，保持历史调用方与闸门不变 */
  mode?: PanelMode;
  /** 浮动态视口坐标 */
  pos?: { x: number; y: number };
  /** 最小化胶囊的视口坐标（与浮动态分开，避免两种尺寸互相顶位置） */
  minPos?: { x: number; y: number };
  onModeChange?: (mode: PanelMode) => void;
  onPosChange?: (pos: { x: number; y: number }) => void;
  onMinPosChange?: (pos: { x: number; y: number }) => void;
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
  open,
  mode = 'right',
  pos,
  minPos,
  onModeChange,
  onPosChange,
  onMinPosChange,
  restoreMode = 'right',
  inputHeight = 0,
}: ProcessPanelProps) {
  const { t } = useTranslation();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);
  const [dragHint, setDragHint] = useState<PanelMode | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    width: number;
    height: number;
    moved: boolean;
    switched: boolean;
    latest: { x: number; y: number };
    kind: 'panel' | 'pill';
    apply: (p: { x: number; y: number }) => void;
    fromMain: boolean;
    originalMode: PanelMode;
  } | null>(null);

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

  // 形态菜单：点外面 / Esc 关闭。必须挂在 return 之前，否则 minimized 早退会漏。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !mainRef.current?.contains(target)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  if (!open) return null;

  // 拖动禁区：标题栏 + Agent 名称行在上方，输入浮层在下方。
  const bounds = {
    viewportWidth: typeof window === 'undefined' ? 1440 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 900 : window.innerHeight,
    topGuard: 84,
    bottomGuard: inputHeight + 16,
  };
  const currentPos = pos ?? { x: Math.max(8, bounds.viewportWidth - 268), y: 92 };

  const FLOAT_SIZE = { width: 260, height: 320 };
  // 窄屏工作区抽屉会占右侧 360px；抽屉在场时胶囊默认让到它左边（A86 实测点不到）
  const drawerShift = typeof document !== 'undefined' && document.querySelector('[data-workspace-drawer="true"]') ? 368 : 0;
  const defaultMinPos = { x: Math.max(8, bounds.viewportWidth - 116 - drawerShift), y: 62 };
  const currentMinPos = minPos ?? defaultMinPos;

  /** 一帧最多写一次位置：拖动时几十个 pointermove 不把 React 逼成逐事件重排 */
  const flushPos = (apply: (p: { x: number; y: number }) => void) => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) apply(next);
  };

  const openMenuAtMain = () => {
    const r = mainRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenuPos({
      x: Math.max(8, Math.min(r.left, bounds.viewportWidth - 124)),
      y: r.bottom + 4,
    });
    setMenuOpen(true);
  };

  const startPanelDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 菜单项在 portal 里，不会命中这里；主图标允许按下，靠移动阈值区分「点开菜单」和「拖动」
    if ((e.target as HTMLElement).closest('[data-panel-mode-btn]')) return;
    const el = panelRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const origin = { x: rect.left, y: rect.top };
    setMenuOpen(false);
    setDragging(true);
    // 从停靠态拖走时先量尺寸；真正切 floating 放到首次移动之后，
    // 这样组件不会在 pointerdown 这一帧换 DOM 位置（吸顶此前就是这么断掉捕获的）。
    dragRef.current = {
      sx: e.clientX, sy: e.clientY, ox: origin.x, oy: origin.y,
      width: rect.width, height: rect.height, moved: false, switched: false,
      latest: origin, kind: 'panel', apply: p => onPosChange?.(p),
      fromMain: !!(e.target as HTMLElement).closest('[data-panel-mode-main]'),
      originalMode: mode,
    };
  };

  const startPillDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const origin = { x: rect.left, y: rect.top };
    dragRef.current = {
      sx: e.clientX, sy: e.clientY, ox: origin.x, oy: origin.y,
      width: rect.width, height: rect.height, moved: false, switched: false,
      latest: origin, kind: 'pill', apply: p => onMinPosChange?.(p),
      fromMain: false, originalMode: 'minimized',
    };
  };

  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      if (d.kind === 'panel' && !d.switched && d.originalMode !== 'floating') {
        d.switched = true;
        // 停靠态高度可达数百像素，若照搬进浮层会被底部禁区钳在顶部，
        // 松手永远判成吸顶。切浮层时改用浮层自己的尺寸。
        d.width = FLOAT_SIZE.width;
        d.height = FLOAT_SIZE.height;
        setDragSize({ ...FLOAT_SIZE });
        onPosChange?.(d.latest);
        onModeChange?.('floating');
      }
    }
    const next = clampPanelPos(
      { x: d.ox + dx, y: d.oy + dy, width: d.width, height: d.height },
      bounds
    );
    d.latest = next;
    const hint = d.kind === 'pill'
      ? snapMinimizedDrop(next, bounds, { width: d.width, height: d.height })
      : snapPanelMode({ ...next, width: d.width, height: d.height }, bounds);
    setDragHint(prev => prev === hint ? prev : hint);
    pendingRef.current = next;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const p = pendingRef.current;
        pendingRef.current = null;
        if (p) d.apply(p);
      });
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    flushPos(d.apply);
    dragRef.current = null;
    setDragging(false);
    setDragSize(null);
    setDragHint(null);

    // 主图标「按下没移动」= 点开菜单，不当成拖动，也不改形态
    if (d.fromMain && !d.moved) {
      openMenuAtMain();
      return;
    }
    if (d.kind === 'pill' && !d.moved) {
      onModeChange?.(restoreMode);
      return;
    }
    const snapped = d.kind === 'pill'
      ? snapMinimizedDrop(d.latest, bounds, { width: d.width, height: d.height })
      : snapPanelMode({ ...d.latest, width: d.width, height: d.height }, bounds);
    if (snapped !== 'floating') {
      onModeChange?.(snapped);
      return;
    }
    if (d.kind === 'pill') {
      onModeChange?.('floating');
      onPosChange?.(clampPanelPos({ ...d.latest, ...FLOAT_SIZE }, bounds));
      return;
    }
    onPosChange?.(d.latest);
  };

  const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return;
    const step = e.shiftKey ? 24 : 8;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) {
      if (e.key.toLowerCase() === 'm') onModeChange?.('minimized');
      return;
    }
    e.preventDefault();
    onPosChange?.(clampPanelPos({ ...currentPos, x: currentPos.x + dx, y: currentPos.y + dy, ...FLOAT_SIZE }, bounds));
  };

  const pillNudge = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 24 : 8;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onModeChange?.(restoreMode);
      } else if (e.key.toLowerCase() === 'm') {
        onModeChange?.('minimized');
      }
      return;
    }
    e.preventDefault();
    onMinPosChange?.(clampPanelPos({ ...currentMinPos, x: currentMinPos.x + dx, y: currentMinPos.y + dy, width: 100, height: 30 }, bounds));
  };

  const dropHintPortal = dragging && dragHint && typeof document !== 'undefined'
    ? createPortal(
        <div className={`pf-drop-hint is-${dragHint}`} data-panel-drop-hint aria-hidden="true" />,
        document.body
      )
    : null;

  if (mode === 'minimized') {
    return (
      <>
      <button
        type="button"
        className="pf-min-pill"
        data-process-panel
        data-panel-mode="minimized"
        data-panel-drag
        style={{ transform: `translate3d(${currentMinPos.x}px, ${currentMinPos.y}px, 0)` }}
        aria-label={t('chat.flow.panel.restore', { n: rows.length })}
        title={`${t('chat.flow.panel.restore', { n: rows.length })} · ${t('chat.flow.panel.drag')}`}
        onPointerDown={startPillDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onKeyDown={pillNudge}
      >
        {isStreaming && <i className="pf-live" data-panel-live aria-hidden="true" />}
        <PanelRight size={12} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('chat.flow.panelTitle')} {rows.length}</span>
      </button>
      {dropHintPortal}
    </>
    );
  }

  const modeButtons: Array<{ m: 'right' | 'top' | 'floating' | 'minimized'; Icon: typeof PanelRight; key: 'chat.flow.panel.modeRight' | 'chat.flow.panel.modeTop' | 'chat.flow.panel.modeFloat' | 'chat.flow.panel.modeMin' }> = [
    { m: 'right', Icon: PanelRight, key: 'chat.flow.panel.modeRight' },
    { m: 'top', Icon: PanelTop, key: 'chat.flow.panel.modeTop' },
    { m: 'floating', Icon: Square, key: 'chat.flow.panel.modeFloat' },
    { m: 'minimized', Icon: Minimize2, key: 'chat.flow.panel.modeMin' },
  ];
  const MainIcon = modeButtons.find(b => b.m === mode)?.Icon ?? PanelRight;
  const detailHit = rows.find(r => r.id === (hoverId ?? selectedId));

  return (
    <>
    <aside
      ref={panelRef}
      className={`pf-panel pf-${mode === 'floating' ? 'float' : `dock-${mode}`}`}
      data-process-panel
      data-panel-mode={mode}
      data-dragging={dragging ? '1' : undefined}
      style={{
        ...(mode === 'floating' ? { transform: `translate3d(${currentPos.x}px, ${currentPos.y}px, 0)` } : {}),
        ...(dragSize ? { width: dragSize.width, height: dragSize.height } : {}),
      }}
    >
      <div
        className="pf-panel-hd"
        data-panel-drag
        aria-label={t('chat.flow.panel.drag')}
        title={t('chat.flow.panel.drag')}
        tabIndex={mode === 'floating' ? 0 : -1}
        onPointerDown={startPanelDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); setDragSize(null); }}
        onKeyDown={nudge}
      >
        <button
          ref={mainRef}
          type="button"
          className="pf-mode-main"
          data-panel-mode-main
          aria-expanded={menuOpen}
          aria-label={t('chat.flow.panel.modes')}
          title={`${t('chat.flow.panel.modes')} · ${t('chat.flow.panel.drag')}`}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openMenuAtMain();
            }
          }}
        >
          <MainIcon size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <b>{t('chat.flow.panelTitle')}</b>
        <span className="pf-panel-pill" data-panel-pill>
          {t('chat.flow.panel.stepCount', { n: rows.length })}
        </span>
        {isStreaming && <i className="pf-live" data-panel-live aria-hidden="true" />}
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

      {/* 详情区：四种形态都不摆空态提示；只在悬停/点击某一步时出现 */}
      {detailHit && (
        <div className="pf-panel-detail" data-panel-detail>
          <span>
            {VERB_KEY[detailHit.verb] ? t(VERB_KEY[detailHit.verb]) : detailHit.verb}
            {detailHit.target ? ` ${detailHit.target}` : ''}
            {detailHit.start != null && detailHit.end != null
              ? ` · ${formatStepDuration(detailHit.end - detailHit.start) ?? ''}`
              : detailHit.running
                ? ` · ${t('chat.flow.panelRunning')}`
                : ''}
          </span>
        </div>
      )}
    </aside>

    {menuOpen && menuPos && typeof document !== 'undefined' && createPortal(
      <div
        ref={menuRef}
        className="pf-mode-menu"
        role="menu"
        aria-label={t('chat.flow.panel.modes')}
        style={{ left: menuPos.x, top: menuPos.y }}
        data-panel-mode-menu
      >
        {modeButtons.map(({ m, Icon, key }) => (
          <button
            key={m}
            type="button"
            role="menuitemradio"
            data-panel-mode-btn={m}
            className={mode === m ? 'is-on' : ''}
            aria-label={t(key)}
            title={t(key)}
            aria-checked={mode === m}
            onClick={() => { onModeChange?.(m); setMenuOpen(false); }}
          >
            <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{t(key)}</span>
          </button>
        ))}
      </div>,
      document.body
    )}
    {dropHintPortal}
    </>
  );
}

export default ProcessPanel;