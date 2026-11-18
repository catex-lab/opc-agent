import { memo, useEffect, useRef } from 'react';

/**
 * 粒子聚散环 —— 「回合工作状态」指示（2026-11-18 落地）。
 *
 * ## 形态来源（已拍板，不再改）
 *
 * 用户在真实方案预览（`particle-preview-live.html`）里确认的形态：
 * **文本灰 + 聚散环，不聚成 M**。算法与那份预览同一族：
 * 黄金角螺旋（GOLDEN = π(3−√5)）铺满圆盘 → 切向旋转 + 呼吸脉冲 + 错峰微抖；
 * 静默时降速转橙；回合结束时向外扩散淡出（散开定格）。
 *
 * ## 为什么是 Canvas 2D 而不是 WebGL
 *
 * HANDOFF.md「历史交接 — 2026-11-13 19:47」的实测结论：原 Three.js 方案
 * 每实例独占一个 WebGL context，多会话并存（列表角标 × N + 状态行主环）在
 * Electron 里有 context 数上限风险；Canvas 2D 无此约束。同一次实测还证明
 * 小尺寸可辨的前提是**粒子数**：24px 槽位 ≥300 颗清晰、16px 用 120 颗
 * （120 与 300 在 16px 下视觉差可忽略）——所以这里按尺寸取默认粒子数，
 * 不复刻当年 72 颗断笔的老问题。
 *
 * ## 性能纪律
 *
 * · **共享 rAF 时钟**：全部实例挂在模块级的一个 `requestAnimationFrame`
 *   循环上（INSTANCES 集合 + 单 dt），不是每实例一个循环 —— 多会话并发时
 *   调度成本 O(1) 次回调而不是 O(N) 次；集合清空即 cancelAnimationFrame。
 * · **页面不可见停表**：`visibilitychange` 里 document.hidden 时取消 rAF、
 *   回到前台再踢一脚（Electron 会节流后台 rAF，与其让它空转不如显式停）。
 * · **dt 钳制**：单帧最多按 50ms 计 —— 从隐藏恢复的那一帧不会让粒子瞬移。
 * · **颜色只取令牌**：工作/完成色 = `currentColor`（宿主行已设
 *   `--td-text-color-secondary` 级文本灰）；静默警示色按需读
 *   `--td-warning-color`（缓存 1s，避免每帧 getComputedStyle）。
 *   不写死任何 hex —— 不为动画新造色值。
 * · **卸载必须 dispose**：从共享时钟摘除 + 清 canvas（见组件卸载 effect）。
 *   `prefers-reduced-motion` 时不进时钟，只画一帧静态环。
 */

export type ParticleOrbState = 'working' | 'silent' | 'done';

/** 黄金角：等角螺线的角增量，让 N 颗粒子在圆盘上近似均匀分布 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface OrbParticle {
  baseA: number;
  baseR: number;
  /** 错峰相位：微抖与呼吸不齐步，聚散才有「群」的质感 */
  phase: number;
  speed: number;
}

function makeParticles(count: number, maxR: number): OrbParticle[] {
  const ps: OrbParticle[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * GOLDEN_ANGLE;
    const r = maxR * Math.sqrt((i + 0.5) / count);
    ps.push({
      baseA: a,
      baseR: r,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 0.8,
    });
  }
  return ps;
}

/* ── 共享 rAF 时钟 ───────────────────────────────────────────────────── */

interface OrbTicker {
  tick(now: number, dt: number): void;
}

const liveInstances = new Set<OrbTicker>();
let rafId: number | null = null;
let lastFrameAt = 0;

function frame(now: number) {
  rafId = null;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (liveInstances.size === 0) return;
  const dt = Math.min((now - (lastFrameAt || now)) / 1000, 0.05);
  lastFrameAt = now;
  for (const inst of liveInstances) inst.tick(now, dt);
  rafId = requestAnimationFrame(frame);
}

function ensureClock() {
  if (rafId == null && liveInstances.size > 0 && !(typeof document !== 'undefined' && document.hidden)) {
    lastFrameAt = 0;
    rafId = requestAnimationFrame(frame);
  }
}

function releaseFromClock(inst: OrbTicker) {
  liveInstances.delete(inst);
  if (liveInstances.size === 0 && rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    lastFrameAt = 0;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 页面不可见：显式停表（浏览器对后台 rAF 本来就会节流，这里取消是
      // 避免回到前台前残留的调度帧把 dt 撑爆 —— dt 钳制是第二道保险）
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        lastFrameAt = 0;
      }
    } else {
      ensureClock();
    }
  });
}

/* ── 引擎 ─────────────────────────────────────────────────────────────── */

class ParticleOrbEngine implements OrbTicker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private particles: OrbParticle[];
  private state: ParticleOrbState = 'working';
  /** 引擎时间（秒）。散开淡出的进度与旋转角都以它为基准 */
  private t = 0;
  private reduced = false;
  private mql: MediaQueryList | null = null;
  private onMediaChange = () => {
    const next = !!this.mql?.matches;
    if (next === this.reduced) return;
    this.reduced = next;
    if (this.reduced) {
      releaseFromClock(this);
      this.drawStatic();
    } else {
      this.t = 0;
      liveInstances.add(this);
      ensureClock();
    }
  };
  /** 静默警示色缓存：令牌值随主题切换会变，每 1s 重读一次足够 */
  private warnColor = '';
  private warnColorAt = 0;

  constructor(canvas: HTMLCanvasElement, size: number, count: number) {
    this.canvas = canvas;
    this.size = size;
    this.ctx = canvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.particles = makeParticles(count, size * 0.42);
    this.mql =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.reduced = !!this.mql?.matches;
    this.mql?.addEventListener('change', this.onMediaChange);
  }

  setState(next: ParticleOrbState) {
    if (next === this.state) return;
    this.state = next;
    // 散开淡出的进度从 0 重计（~800ms 由宿主控制卸载）
    this.t = 0;
    if (this.reduced) this.drawStatic();
  }

  start() {
    if (this.reduced) {
      this.drawStatic();
      return;
    }
    liveInstances.add(this);
    ensureClock();
  }

  dispose() {
    releaseFromClock(this);
    this.mql?.removeEventListener('change', this.onMediaChange);
    this.ctx.clearRect(0, 0, this.size, this.size);
  }

  tick(_now: number, dt: number) {
    this.t += dt;
    this.draw();
  }

  private resolveWarnColor(): string {
    const now = performance.now();
    if (!this.warnColor || now - this.warnColorAt > 1000) {
      this.warnColor = getComputedStyle(this.canvas)
        .getPropertyValue('--td-warning-color')
        .trim();
      this.warnColorAt = now;
    }
    return this.warnColor;
  }

  /** 逐帧绘制。算法与已拍板预览 particle-preview-live.html 的 step() 一致 */
  private draw() {
    const { ctx, size } = this;
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);
    const spinning = this.state === 'working';
    const silent = this.state === 'silent';
    const done = this.state === 'done';
    // 静默降速旋转；完成时保持旋转继续散开（残影感）
    const rot = this.t * (silent ? 0.25 : 1.1);
    const color = silent ? this.resolveWarnColor() || 'currentColor' : 'currentColor';
    // working 呼吸脉冲；done 按时间向外扩散
    const breathe = spinning ? 1 + 0.12 * Math.sin(this.t * 3) : 1;
    const spread = done ? 1 + this.t * 2.5 : 1;
    const alpha = done ? Math.max(0.12, 0.35 - this.t * 0.1) : 0.9;
    const sz = size >= 24 ? 0.9 : 0.7;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    for (const p of this.particles) {
      // 切向旋转（聚拢感）+ 错峰微抖；静默/完成只旋转不加抖
      const a =
        p.baseA + rot * p.speed + (spinning ? Math.sin(this.t * 2 + p.phase) * 0.05 : 0);
      const r =
        p.baseR * breathe * spread + (spinning ? Math.sin(this.t * 4 + p.phase * 3) * 0.6 : 0);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  /** reduced-motion 静态环：base 位置画一帧（散开完成态画淡出的残影） */
  private drawStatic() {
    const { ctx, size } = this;
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);
    const silent = this.state === 'silent';
    const done = this.state === 'done';
    const color = silent ? this.resolveWarnColor() || 'currentColor' : 'currentColor';
    const alpha = done ? 0.35 : 0.9;
    const sz = size >= 24 ? 0.9 : 0.7;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    for (const p of this.particles) {
      const x = cx + Math.cos(p.baseA) * p.baseR;
      const y = cy + Math.sin(p.baseA) * p.baseR;
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }
}

export interface ParticleStatusOrbProps {
  state: ParticleOrbState;
  /** 画布边长（CSS px）。消息列状态行用 24、会话列表角标用 16 */
  size?: number;
  /** 粒子数。缺省按尺寸取实测口径：24px → 300 颗、16px → 120 颗（见头注释） */
  particles?: number;
  /**
   * CSS 旋转圆环降级。
   *
   * 由**调用方**执行并发预算：会话列表里同屏 Canvas 角标 ≤4（见
   * ConversationList 的 CANVAS_ORB_BUDGET），超出传 degrade=true ——
   * 同尺寸同令牌色的空心环 + animate-spin，只丢粒子质感，不丢状态语义。
   * 消息列的 24px 主环全屏唯一，不参与该预算。
   */
  degrade?: boolean;
  /** 无障碍名（列表角标用）。传入时 role=img + aria-label；不传 = 纯装饰 aria-hidden */
  title?: string;
  className?: string;
}

export const ParticleStatusOrb = memo(function ParticleStatusOrb({
  state,
  size = 24,
  particles,
  degrade = false,
  title,
  className,
}: ParticleStatusOrbProps) {
  const count = particles ?? (size >= 24 ? 300 : 120);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ParticleOrbEngine | null>(null);

  useEffect(() => {
    if (degrade) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ParticleOrbEngine(canvas, size, count);
    engineRef.current = engine;
    engine.start();
    // 卸载必须 dispose：从共享时钟摘除（最后一个实例会 cancel rAF）并清画布
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [degrade, size, count]);

  useEffect(() => {
    engineRef.current?.setState(state);
  }, [state]);

  if (degrade) {
    // CSS 旋转圆环：颜色仍走令牌（工作=占位灰、静默=警示橙），animate-spin
    // 是 tailwind 内置关键帧（AddCustomCliDialog 等已在用），不新增 CSS。
    return (
      <span
        role={title ? 'img' : undefined}
        aria-label={title}
        title={title}
        className={`inline-block shrink-0 animate-spin rounded-full ${className ?? ''}`}
        style={{
          width: size,
          height: size,
          borderWidth: size >= 24 ? 2 : 1.5,
          borderStyle: 'solid',
          borderColor:
            state === 'silent'
              ? 'var(--td-warning-color)'
              : 'var(--td-text-color-placeholder)',
          borderTopColor: 'transparent',
        }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
});
