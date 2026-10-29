/**
 * 过程流（A149）—— 答案之前那一堆「思考 / 旁白 / 轨迹」，压成一行。
 *
 * ## 为什么需要它
 *
 * 一条消息里过程与答案原本是**并列**的兄弟节点：思考正文、模型的中途旁白
 * （「我先查一下官方渠道」）、若干条轨迹条，全部铺在答案上方。实测截图里
 * 一轮 3m50s 的检索任务铺开了 5 段过程，答案被挤到屏幕下方只剩 4 行 ——
 * 而用户要读的是答案，过程只该是「想追的时候追得下去」的第二层。
 *
 * ## 折叠口径（与 AgentTrace 同一套，避免两条链路各自演化）
 *
 *   · 还在流、还没有答案 → 展开。此刻过程就是正文，用户正盯着它看进度。
 *   · 答案一开始输出     → 自动收起，只留一行摘要。
 *   · 用户手动点过之后   → 不再自动干预（否则刚点开就被「跑完」那一刻关掉）。
 *
 * ## 为什么是「包一层」而不是「让每个子组件自己收」
 *
 * 中途旁白是普通文本块，没有可折叠的头部；思考块能收，但收起后仍占一行。
 * 只有把「答案之前」这一段整体当一个东西，才可能做到「只剩答案」。
 * 判据复用 ChatMessages 里那条 `hasAnswer`（最后一个工具之后的第一段非空文本），
 * 不另立一套 —— 两套判据迟早会分叉，表现为「轨迹收了但旁白还在」。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, CircleCheck, CircleX } from 'lucide-react';
import type { Block } from '../../shared/blocks';
import { buildTrace, formatHandledDuration } from '../../shared/trace';

/** 折叠过渡时长（ms）。与 AgentTrace 的 FOLD_MS 一致，两条链路同一节奏。 */
const FOLD_MS = 220;

export interface ProcessFlowProps {
  /** 过程区的原始块（只用来数「几段思考 / 几步工具 / 花了多久」） */
  blocks: readonly Block[];
  /** 已经渲染好的过程节点（思考块 / 旁白 / 轨迹条），原样塞进来 */
  children: ReactNode;
  /** 这条消息已经有答案正文：自动收起，把版面让给答案 */
  hasAnswer: boolean;
}

export function ProcessFlow({ blocks, children, hasAnswer }: ProcessFlowProps) {
  const stats = useMemo(() => {
    const items = buildTrace(blocks);
    const stepCount = items.filter(i => i.kind === 'tool').length;
    const thinkingCount = items.reduce(
      (n, i) => n + (i.kind === 'thinking' ? 1 : 0) + i.nested.length,
      0
    );
    const totalMs = items.reduce((s, i) => s + (i.durationMs ?? 0), 0);
    return {
      stepCount,
      thinkingCount,
      duration: formatHandledDuration(totalMs),
      running: items.some(i => i.status === 'running'),
      failed: items.some(i => i.status === 'error'),
      interrupted: items.some(i => i.status === 'interrupted'),
    };
  }, [blocks]);

  // 初值就按「有没有答案」定：历史消息打开时不该先展开再收（那一帧会闪）。
  const [expanded, setExpanded] = useState(!hasAnswer);
  const touched = useRef(false);
  useEffect(() => {
    if (hasAnswer && !touched.current) setExpanded(false);
  }, [hasAnswer]);

  /**
   * 折叠动画「先挂住再卸」：直接 `expanded && <div>` 会让一整屏过程在一帧内
   * 消失、答案猛地往上跳。与 AgentTrace 同一处理（见那边的注释）。
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

  /**
   * 摘要文案：「思考 3 段 · 工具 7 步 · 3m50s」。
   *
   * 不放「查看过程 / 收起过程」这种纯动作词：收起时它是这一整块过程在屏幕上
   * **唯一**的痕迹，说清「里面有什么」比说「点了会怎样」有用。
   * 展开 / 收起由左侧箭头表达。
   */
  const summary = [
    stats.thinkingCount > 0 ? `思考 ${stats.thinkingCount} 段` : '',
    stats.stepCount > 0 ? `工具 ${stats.stepCount} 步` : '',
    stats.duration ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="tc-proc" data-process-flow data-process-open={expanded ? '1' : '0'}>
      <div
        className="tc-proc-bar"
        data-process-bar
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? '收起过程' : '展开过程'}
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
        {stats.running ? (
          <span className="tc-live-dot" aria-hidden="true">
            <span className="tc-live-core" style={{ backgroundColor: 'var(--td-brand-color)' }} />
            <span className="tc-live-ring" style={{ borderColor: 'var(--td-brand-color)' }} />
          </span>
        ) : stats.failed ? (
          <CircleX size={13} style={{ color: 'var(--td-error-color)', flexShrink: 0 }} />
        ) : stats.interrupted ? (
          // 与 AgentTrace 一致：有一个工具没回结果时不打勾，画空心圈
          <span className="tc-unknown-dot" aria-hidden="true" data-unknown-dot />
        ) : (
          <CircleCheck size={13} style={{ color: 'var(--td-success-color)', flexShrink: 0 }} />
        )}
        <span className="tc-proc-label">过程</span>
        <span className="tc-proc-summary" data-process-summary>
          {summary}
        </span>
      </div>

      {showBody && (
        <div className="tc-proc-fold" data-process-fold data-fold={expanded ? '1' : '0'}>
          <div className="tc-proc-fold-inner">
            <div className="tc-proc-body">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProcessFlow;
