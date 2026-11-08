/**
 * 文件核对条（A99）—— 回答「Agent 说它改的文件，现在到底在不在」。
 *
 * ## 与上面那条「验证」的区别（这两条并排出现，必须一眼分得清）
 *
 * | 条 | 回答 | 手段 |
 * |---|---|---|
 * | 验证（A97） | 这轮改动**能不能跑** | 执行 test / build / lint |
 * | 文件核对（A99） | 这轮改动**有没有落地** | 读磁盘比对内容 |
 *
 * 两者不能互相替代：测试全绿也可能改的是别的文件；文件落地了测试也可能是红的。
 *
 * ## 为什么不自动核对
 *
 * 一个会话里可能有几十条改过文件的消息，每条都去读磁盘就是几十次 IO，
 * 而且绝大多数时候用户并不关心。所以默认是「未核对」这个**显式状态**，
 * 用户展开时才读一次，之后可以手动重新核对。
 *
 * 这与 A97 的「未验证」是同一条原则：没做的事要显示成「没做」，
 * 而不是留白让用户默认「应该没问题」。
 *
 * ## 为什么结论要写得这么啰嗦
 *
 * 「无法判定」不是废话 —— 它是真实存在的第三种情况（文件后来又被改过）。
 * 把它硬塞进「已落地」或「没落地」都是在骗人，而用户恰恰要靠这个区分
 * 决定「要不要去 git diff 看一眼」。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Play,
  XCircle,
} from 'lucide-react';
import { useTranslation, type MessageKey } from '../i18n';

type FileVerdict =
  | 'landed'
  | 'landed_then_modified'
  | 'not_landed'
  | 'ambiguous'
  | 'missing'
  | 'ephemeral'
  | 'skipped';

interface FileEvidence {
  blockId: string;
  toolName: string;
  file: string;
  display: string;
  verdict: FileVerdict;
  laterModified: boolean;
  lines?: number;
  reason?: string;
}

interface EvidenceResponse {
  cwd: string | null;
  items: FileEvidence[];
  summary: { total: number; landed: number; notLanded: number; other: number; alarm: string | null };
}

export interface FileEvidencePanelProps {
  sessionId: string;
  messageId: string;
  /**
   * D1：向「本轮核对」合并行回报核对结果（是否已核对 / 是否有对不上）。
   * 合并行收起后仍要显示「文件已核对」，所以状态留在父级，而不是随
   * 本组件卸载一起丢掉。
   */
  onStateChange?: (state: { done: boolean; alarm: boolean }) => void;
}

/** 判定 → 展示文案 + 颜色。文案刻意用「结论」而不是「状态词」，用户不用猜。 */
const VERDICT_META: Record<FileVerdict, { textKey: MessageKey; color: string; tone: 'ok' | 'bad' | 'meh' }> = {
  landed: { textKey: 'chat.evidence.verdict.landed', color: 'var(--td-success-color)', tone: 'ok' },
  landed_then_modified: { textKey: 'chat.evidence.verdict.modified', color: 'var(--td-success-color)', tone: 'ok' },
  not_landed: { textKey: 'chat.evidence.verdict.notLanded', color: 'var(--td-error-color)', tone: 'bad' },
  missing: { textKey: 'chat.evidence.verdict.missing', color: 'var(--td-error-color)', tone: 'bad' },
  ambiguous: { textKey: 'chat.evidence.verdict.ambiguous', color: 'var(--td-warning-color)', tone: 'meh' },
  ephemeral: { textKey: 'chat.evidence.verdict.ephemeral', color: 'var(--td-text-color-placeholder)', tone: 'meh' },
  skipped: { textKey: 'chat.evidence.verdict.skipped', color: 'var(--td-text-color-placeholder)', tone: 'meh' },
};

export function FileEvidencePanel({ sessionId, messageId, onStateChange }: FileEvidencePanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ sessionId, messageId });
      const res = await fetch(`/api/files/evidence?${qs.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(t('chat.evidence.checkFailed', { status: res.status, text: text ? `：${text.slice(0, 120)}` : '' }));
        return;
      }
      setData((await res.json()) as EvidenceResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, messageId, t]);

  // 展开时自动核对一次；已经核对过就不再重复读盘（用户可手动重新核对）
  useEffect(() => {
    if (expanded && !data && !loading && !error) void check();
  }, [expanded, data, loading, error, check]);

  const items = data?.items ?? [];
  const summary = data?.summary;
  const alarm = summary?.alarm ?? null;

  // D1：把「是否已核对 / 有没有对不上」上报给合并行。只在真正变化时更新，
  // 避免父级 setState → 重渲染 → effect 再跑的抖动。
  useEffect(() => {
    onStateChange?.({ done: !!summary, alarm: !!alarm });
  }, [summary, alarm, onStateChange]);

  const head = loading
    ? { icon: Loader2, text: t('chat.evidence.checking'), color: 'var(--td-brand-color)', spin: true }
    : alarm
      ? { icon: XCircle, text: t('chat.evidence.alarm'), color: 'var(--td-error-color)', spin: false }
      : summary
        ? { icon: CheckCircle2, text: t('chat.evidence.checked'), color: 'var(--td-success-color)', spin: false }
        : { icon: CircleDashed, text: t('chat.evidence.unchecked'), color: 'var(--td-text-color-placeholder)', spin: false };

  const Icon = head.icon;

  const metaText = summary
    ? t('chat.evidence.meta', { landed: summary.landed, notLanded: summary.notLanded, total: summary.total })
    : t('chat.evidence.hint');

  return (
    <div className="tc-verify" data-file-evidence={loading ? 'loading' : summary ? 'done' : 'idle'}>
      <button
        type="button"
        className="tc-verify-bar"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <Icon
          size={13}
          style={{
            color: head.color,
            flexShrink: 0,
            animation: head.spin ? 'tc-spin 1s linear infinite' : undefined,
          }}
        />
        <span className="tc-verify-title" style={{ color: head.color }}>
          {t('chat.evidence.title')} · {head.text}
        </span>
        <span className="tc-verify-meta" data-file-evidence-meta>
          {metaText}
        </span>
        {expanded ? <ChevronDown size={13} className="tc-verify-chev" /> : <ChevronRight size={13} className="tc-verify-chev" />}
      </button>

      {expanded && (
        <div className="tc-verify-body">
          {error && <div className="tc-verify-note is-error">{error}</div>}

          {alarm && <div className="tc-verify-note is-error">{alarm}</div>}

          {!loading && data && data.cwd === null && (
            <div className="tc-verify-note">
              {t('chat.evidence.noCwd')}
            </div>
          )}

          {items.length > 0 && (
            <div className="tc-verify-results">
              {items.map(it => {
                const meta = VERDICT_META[it.verdict];
                return (
                  <div
                    key={`${it.blockId}-${it.file}`}
                    className="tc-verify-result"
                    data-file-verdict={it.verdict}
                    title={it.file || undefined}
                  >
                    <div className="tc-verify-result-head">
                      <span className="tc-verify-result-label">{it.display || t('chat.evidence.noPath')}</span>
                      <span className="tc-verify-result-status" style={{ color: meta.color }}>
                        {it.reason ?? t(meta.textKey)}
                      </span>
                      {it.lines != null && <span className="tc-verify-result-code">{t('chat.evidence.lines', { n: it.lines })}</span>}
                      {it.laterModified && (
                        <span className="tc-verify-result-dur" title={t('chat.evidence.laterModifiedTitle')}>
                          {t('chat.evidence.laterModified')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="tc-verify-actions">
            <button
              type="button"
              className="tc-verify-btn"
              onClick={() => void check()}
              disabled={loading}
            >
              <Play size={12} />
              {data ? t('chat.evidence.recheck') : t('chat.evidence.check')}
            </button>
            <span className="tc-verify-notes">
              {t('chat.evidence.readOnly')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
