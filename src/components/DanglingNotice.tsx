/**
 * 「上一轮没有产出回复」提示条（A100）。
 *
 * ## 它解决什么
 *
 * 运行态（runHub）只活在内存里。应用被关掉、进程崩溃、或者用户中止之后，
 * 库里会留下一条「发出去了但没有回答」的用户消息，而界面上什么都不说 ——
 * 用户会以为是消息丢了、或者自己根本没发出去。
 *
 * 验收标准里那句「刷新或重启后，根据实际持久化能力**恢复或明确说明无法恢复**」
 * 就是这一条。这里选的是后半句：**明确说明无法恢复**，而不是假装恢复。
 *
 * ## 为什么不做「恢复」
 *
 * 要真恢复，得在 run 开始时就把执行现场持久化（子进程、已产生的块、
 * Agent 侧的原生会话 id）。而绝大多数 Agent 是一轮一个子进程，进程没了
 * 就是没了 —— 能「恢复」的只有重新跑一遍，那是**重跑**不是恢复。
 * 与其做一个名字叫恢复、实际是重跑的功能，不如把事实说清楚。
 *
 * ## 为什么不显示具体原因
 *
 * 「应用被关闭」「进程崩溃」「用户中止」在库里留下的痕迹**完全一样**：
 * 一条没有回答的用户消息。硬要区分只能靠猜，而猜错的方向恰恰是最糟的那种
 * （把崩溃说成用户中止）。所以只说「没有产出回复」这个可确认的事实。
 */

import { useState } from 'react';
import { X } from 'lucide-react';

export interface DanglingNoticeProps {
  /** 那条没有回答的用户消息时间（ISO） */
  at: string;
}

/** ISO → 本地 HH:MM；解析不了就不显示时间，不编一个 */
function clockOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DanglingNotice({ at }: DanglingNoticeProps) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const clock = clockOf(at);

  return (
    <div
      data-dangling
      className="mx-6 mb-2 flex items-start gap-2 rounded-lg px-3 py-2"
      style={{
        background: 'color-mix(in srgb, var(--td-warning-color) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--td-warning-color) 28%, transparent)',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <path
          d="M8 1.8 15 14H1L8 1.8Z"
          fill="none"
          stroke="var(--td-warning-color)"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M8 6v3.6" stroke="var(--td-warning-color)" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="11.7" r="0.8" fill="var(--td-warning-color)" />
      </svg>

      <div className="min-w-0 flex-1 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
        <span style={{ color: 'var(--td-warning-color)' }}>上一轮没有产出回复</span>
        {clock && <span>（{clock} 那条消息）</span>}
        <span>：应用可能被关闭或进程中断，这一轮无法恢复。需要的话重新发送一次即可。</span>
      </div>

      <button
        type="button"
        aria-label="收起提示"
        onClick={() => setHidden(true)}
        style={{
          flexShrink: 0,
          color: 'var(--td-text-color-placeholder)',
          lineHeight: 0,
          marginTop: 1,
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
