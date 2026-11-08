/**
 * 「上一轮指令未完成」的流内状态行 + 处理对话框（A207 补充 · 方案 C）。
 *
 * ## 为什么改成「一行状态 + 弹层」
 *
 * 之前的流内大卡在 420 宽下要占 379.5px（长文案还要继续长高），把对话流
 * 挤掉一大块。方案 C 把「常驻信息」和「一次性的决策」拆开：
 *
 *   · 对话流里只留 38px 高的一行状态：`● 上一轮指令未完成` + `[查看处理]`。
 *     它跟着消息流一起滚，滚动离开再回来、切走再切回、刷新后都还在，
 *     用户始终能看出「卡在哪一步、为什么停」。
 *   · 点「查看处理」才弹出轻量对话框，承载原有全文（判定依据、推荐依据、
 *     跳过假设、自由输入说明）与三决策。宽 420、限高 60vh、超出内部滚动。
 *
 * ## 关闭 ≠ 决策
 *
 * X / Esc / 点遮罩**只关闭弹层，不替用户作答**：
 *   · 用户按下这三个键时，意图通常是「先收起来看看上下文」，
 *     而不是「替我选一个」；
 *   · 「新建会话」有副作用（清掉旧 CLI 续接令牌、旧指令不再重放），
 *     不该在用户没看全文时被一次误触执行；
 *   · 关闭后状态行仍在，用户随时可以再点「查看处理」回来作答
 *     （待决项另外按会话写进 localStorage，刷新也不会丢）。
 *
 * 所以这里选择「保持未决」，而不是「按推荐项执行 + 回写假设」。
 * 只有三个决策按钮会真正作答；跳过按钮的假设写在按钮正下方，完整不省略。
 *
 * ## 自由输入出口
 *
 * 确认期间用户直接在下方输入框改写指令发送，按「新建会话」处理
 * （useChat 的 sendMessage 里已有这条规则），弹层正文里也写明了。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DanglingConfirmInfo } from '../hooks/useChat';

export interface ResumeNoticeProps {
  info: DanglingConfirmInfo;
  onChoose: (choice: 'continue' | 'fresh' | 'skip' | 'cancel') => void;
}

/** 取服务端给的选项文案；拿不到时退回固定说法，保证不出现空按钮 */
function labelOf(info: DanglingConfirmInfo, action: 'continue' | 'fresh' | 'skip'): string {
  return info.options.find(o => o.action === action)?.label
    || (action === 'continue'
      ? '继续那一条'
      : action === 'fresh'
        ? '新建会话（带历史摘要）'
        : '跳过');
}

/**
 * 处理对话框。
 *
 * 高度上限 60vh：正文再长也不把屏幕撑爆，超出的部分在内部滚动；
 * 底部三个决策不跟着滚，用户不需要先滚到底才能作答。
 */
function ResumeDialog({
  info,
  onChoose,
  onClose,
}: {
  info: DanglingConfirmInfo;
  onChoose: ResumeNoticeProps['onChoose'];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 只关弹层，不作答（见文件头「关闭 ≠ 决策」）
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // 锁定背景滚动，关闭时还原原来的值（父级可能已有自己的设置）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const recommendedFresh = info.recommended === 'fresh';
  const freshLabel = labelOf(info, 'fresh');
  const continueLabel = labelOf(info, 'continue');

  /** 推荐项用主按钮（品牌色实心），另一项是描边按钮 —— 两者都保留，不藏 */
  const freshButton = (
    <button
      type="button"
      key="fresh"
      className={recommendedFresh ? 'tc-btn-brand' : 'tc-btn-secondary'}
      onClick={() => onChoose('fresh')}
    >
      {freshLabel}
      {recommendedFresh && '（推荐）'}
    </button>
  );
  const continueButton = (
    <button
      type="button"
      key="continue"
      className={recommendedFresh ? 'tc-btn-secondary' : 'tc-btn-brand'}
      onClick={() => onChoose('continue')}
    >
      {continueLabel}
      {!recommendedFresh && '（推荐）'}
    </button>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      /* 与 ConfirmDialog 同一档遮罩：面板是半透明玻璃，实色底会让整块变黑 */
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        // 只有点在遮罩本身才关闭；从面板里拖出来松手不该关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-resume-title"
        data-resume-dialog
        className="tc-dialog flex w-full max-w-[420px] flex-col rounded-xl"
        style={{ maxHeight: '60vh' }}
      >
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <h2
            id="tc-resume-title"
            className="min-w-0 flex-1 text-title-lg font-semibold"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {info.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭（保持未决）"
            title="关闭（保持未决）"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-body-lg"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            ×
          </button>
        </header>

        {/* 正文：原有全部信息都在这里，不因为进弹层而删减 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-2">
          <div
            className="whitespace-pre-wrap text-body leading-relaxed"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {info.detail}
          </div>
          <p className="mt-2 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
            推荐依据：{info.recommendReason}
          </p>
        </div>

        <footer
          className="shrink-0 border-t px-5 py-3"
          style={{ borderColor: 'var(--td-component-stroke)' }}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* 推荐项在前：安全默认先被看到；两项都是显式决策 */}
            {recommendedFresh ? [freshButton, continueButton] : [continueButton, freshButton]}
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded px-2 text-caption"
              style={{ color: 'var(--td-text-color-secondary)' }}
              onClick={() => onChoose('skip')}
            >
              跳过
            </button>
          </div>

          {/* 「跳过」的假设当面说清：不藏菜单、不被省略号截断，整段可读 */}
          <p className="mt-2 text-caption" style={{ color: 'var(--td-text-color-secondary)' }}>
            跳过会按「新建会话、不续接旧 CLI 会话」继续；旧指令不会被重放。
            也可以直接在下方输入框改写指令后发送，同样按新指令新建会话。
          </p>
          <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            关闭此窗口不会替你做决定；状态行会保留，随时可以再点「查看处理」。
          </p>
        </footer>
      </div>
    </div>,
    document.body
  );
}

export function ResumeNotice({ info, onChoose }: ResumeNoticeProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section
        data-resume-notice
        role="group"
        aria-label="上一轮指令未完成，可查看处理"
        className="mt-3 flex h-[38px] items-center gap-2 rounded-lg px-3"
        style={{
          background: 'color-mix(in srgb, var(--td-warning-color) 7%, transparent)',
          border: '1px solid color-mix(in srgb, var(--td-warning-color) 26%, transparent)',
        }}
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: 'var(--td-warning-color)' }}
        />
        <span className="shrink-0 text-caption" style={{ color: 'var(--td-warning-color)' }}>
          上一轮指令未完成
        </span>
        {/* 常驻行里给一句「为什么停」；全文在弹层里，这里只省空间，不删信息 */}
        <span
          className="min-w-0 flex-1 truncate text-caption"
          style={{ color: 'var(--td-text-color-secondary)' }}
          title={info.reason}
        >
          · {info.reason}
        </span>
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center rounded px-2 text-caption"
          style={{ color: 'var(--td-brand-color)' }}
          onClick={() => setOpen(true)}
        >
          查看处理
        </button>
      </section>

      {open && (
        <ResumeDialog
          info={info}
          onChoose={onChoose}
          /* 关闭只收起弹层：待决项仍然挂着，状态行不消失 */
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
