/**
 * 「上一轮指令未完成」的流内确认卡（A207 补充）。
 *
 * ## 为什么是流内卡片，而不是模态弹窗
 *
 * 模态弹窗会把对话盖住，用户要回答「要不要续接」时恰恰需要看上下文：
 * 上一条指令是什么、上一轮为什么失败。卡片跟着消息流一起排，边看边答；
 * 滚动离开再回来，顶部的状态行仍然写着「等待你的操作」，能看出 agent 卡在哪。
 *
 * ## 一次只问一个问题
 *
 * 这里只有一个决策：续接旧 CLI 会话，还是新建。不堆成表单，也不分页
 * （分页会把前一个问题折叠掉，用户回头就找不到自己答过什么）。
 *
 * ## 安全默认与自由输入
 *
 * - 「新建会话」是推荐项，并**写明依据**（不同模型 / 不同目录 / 上轮没等到人回答）。
 * - 「跳过」按推荐项继续，假设写在按钮下方，不藏在 tooltip 里。
 * - 用户仍然可以直接在下方输入框改写指令发送 —— 那会被当成自由输入出口，
 *   按「新建会话」处理，旧指令不会被重放。
 */

import type { DanglingConfirmInfo } from '../hooks/useChat';

export interface ResumeNoticeProps {
  info: DanglingConfirmInfo;
  onChoose: (choice: 'continue' | 'fresh' | 'skip' | 'cancel') => void;
}

export function ResumeNotice({ info, onChoose }: ResumeNoticeProps) {
  const recommendedFresh = info.recommended === 'fresh';

  return (
    <section
      data-resume-notice
      role="group"
      aria-label="等待你的操作：上一轮指令未完成"
      className="mt-3 rounded-lg px-4 py-3"
      style={{
        background: 'color-mix(in srgb, var(--td-warning-color) 7%, transparent)',
        border: '1px solid color-mix(in srgb, var(--td-warning-color) 26%, transparent)',
      }}
    >
      <header className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--td-warning-color)' }}
        />
        <span style={{ color: 'var(--td-warning-color)' }}>等待你的操作</span>
        <span style={{ color: 'var(--td-text-color-placeholder)' }}>·</span>
        <span style={{ color: 'var(--td-text-color-secondary)' }}>{info.title}</span>
      </header>

      <div
        className="mt-2 whitespace-pre-wrap text-body leading-relaxed"
        style={{ color: 'var(--td-text-color-primary)' }}
      >
        {info.detail}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="tc-btn-secondary"
          onClick={() => onChoose('continue')}
        >
          继续那一条
          {!recommendedFresh && '（推荐）'}
        </button>
        <button
          type="button"
          className="tc-btn-secondary"
          onClick={() => onChoose('fresh')}
        >
          新建会话（带历史摘要）
          {recommendedFresh && '（推荐）'}
        </button>
        <button
          type="button"
          className="text-caption underline-offset-2 hover:underline"
          style={{ color: 'var(--td-text-color-secondary)' }}
          onClick={() => onChoose('skip')}
        >
          跳过
        </button>
      </div>

      <p className="mt-2 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
        推荐依据：{info.recommendReason}
      </p>
      <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
        跳过会按「新建会话、不续接旧 CLI 会话」继续；旧指令不会被重放。
        也可以直接在下方输入框改写指令后发送，同样按新指令新建会话。
      </p>
    </section>
  );
}
