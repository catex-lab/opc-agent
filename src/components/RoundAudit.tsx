import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { VerificationRow } from '../hooks/useVerifications';
import { VerifyPanel } from './VerifyPanel';
import { FileEvidencePanel } from './FileEvidencePanel';

interface RoundAuditProps {
  sessionId: string;
  messageId: string;
  cwd?: string;
  rows: VerificationRow[];
  /** 这一轮的工具步骤数（摘要里的「N 步」来自过程流，不重算） */
  stepCount: number;
  onUpdated: () => void;
}

/**
 * D1：把「验证状态条」和「文件核对条」并为**一条**「本轮核对」。
 *
 * 之前的形态是两条并列的状态行（A97 验证 + A99 文件核对），每条都带标题、
 * 说明和图标 —— 一轮改过文件的回答下面因此常驻三行（过程摘要 + 验证 + 核对），
 * 而其中两行九成时间是「0 验证 / 未核对」这种**没有结论的结论**。
 *
 * 现在默认只有一行：
 *
 *     本轮核对 · 3 步 · 0 验证 · 文件未核对        ⌄
 *
 * 三个数字各自都能一眼读完，也不用再在两行之间判断「哪个是重点」。
 * 点开就是原来的两个面板本身（组件原样复用，不另写一份），信息一点没少。
 */
export function RoundAudit({
  sessionId,
  messageId,
  cwd,
  rows,
  stepCount,
  onUpdated,
}: RoundAuditProps) {
  const [open, setOpen] = useState(false);
  /** 文件核对是否已经跑过（由面板回报；展开前一律是「未核对」） */
  const [evidence, setEvidence] = useState<{ done: boolean; alarm: boolean }>({
    done: false,
    alarm: false,
  });
  /**
   * 回调必须稳定：FileEvidencePanel 在 effect 里回报状态，父级每次渲染都
   * 换一个新函数会把 effect 变成每帧跑一次。
   */
  const onEvidenceState = useCallback((next: { done: boolean; alarm: boolean }) => {
    setEvidence(prev =>
      prev.done === next.done && prev.alarm === next.alarm ? prev : next
    );
  }, []);

  const verifiedCount = rows.length;
  const evidenceText = evidence.done
    ? evidence.alarm
      ? '文件有对不上'
      : '文件已核对'
    : '文件未核对';

  return (
    <div className="tc-verify" data-round-audit>
      <button
        type="button"
        className="tc-verify-bar"
        data-round-audit-bar
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="tc-verify-title">本轮核对</span>
        <span className="tc-verify-meta" data-round-audit-meta>
          {stepCount} 步 · {verifiedCount} 验证 · {evidenceText}
        </span>
        {open ? <ChevronDown size={13} className="tc-verify-chev" /> : <ChevronRight size={13} className="tc-verify-chev" />}
      </button>

      {open && (
        <div className="tc-round-audit-body" data-round-audit-body>
          <VerifyPanel
            sessionId={sessionId}
            messageId={messageId}
            cwd={cwd}
            rows={rows}
            onUpdated={onUpdated}
          />
          <FileEvidencePanel
            sessionId={sessionId}
            messageId={messageId}
            onStateChange={onEvidenceState}
          />
        </div>
      )}
    </div>
  );
}
