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
}

/** 判定 → 展示文案 + 颜色。文案刻意用「结论」而不是「状态词」，用户不用猜。 */
const VERDICT_META: Record<FileVerdict, { text: string; color: string; tone: 'ok' | 'bad' | 'meh' }> = {
  landed: { text: '已核对，内容在磁盘上', color: 'var(--td-success-color)', tone: 'ok' },
  landed_then_modified: { text: '已核对，但之后又被改过', color: 'var(--td-success-color)', tone: 'ok' },
  not_landed: { text: '声明已写入，磁盘上没有这段内容', color: 'var(--td-error-color)', tone: 'bad' },
  missing: { text: '声明已写入，文件不存在', color: 'var(--td-error-color)', tone: 'bad' },
  ambiguous: { text: '无法判定（文件已被大改，归不了因）', color: 'var(--td-warning-color)', tone: 'meh' },
  ephemeral: { text: '临时文件，已被系统清理', color: 'var(--td-text-color-placeholder)', tone: 'meh' },
  skipped: { text: '未核对', color: 'var(--td-text-color-placeholder)', tone: 'meh' },
};

export function FileEvidencePanel({ sessionId, messageId }: FileEvidencePanelProps) {
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
        setError(`核对失败（HTTP ${res.status}）${text ? `：${text.slice(0, 120)}` : ''}`);
        return;
      }
      setData((await res.json()) as EvidenceResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, messageId]);

  // 展开时自动核对一次；已经核对过就不再重复读盘（用户可手动重新核对）
  useEffect(() => {
    if (expanded && !data && !loading && !error) void check();
  }, [expanded, data, loading, error, check]);

  const items = data?.items ?? [];
  const summary = data?.summary;
  const alarm = summary?.alarm ?? null;

  const head = loading
    ? { icon: Loader2, text: '核对中', color: 'var(--td-brand-color)', spin: true }
    : alarm
      ? { icon: XCircle, text: '有文件对不上', color: 'var(--td-error-color)', spin: false }
      : summary
        ? { icon: CheckCircle2, text: '已核对', color: 'var(--td-success-color)', spin: false }
        : { icon: CircleDashed, text: '未核对', color: 'var(--td-text-color-placeholder)', spin: false };

  const Icon = head.icon;

  const metaText = summary
    ? `${summary.landed} 个落地 · ${summary.notLanded} 个对不上 · 共 ${summary.total} 个文件`
    : '读磁盘确认这轮的改动是否真的落地';

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
          文件核对 · {head.text}
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
              会话未绑定工作目录，相对路径无法解析；下面只核对绝对路径。
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
                      <span className="tc-verify-result-label">{it.display || '(无路径)'}</span>
                      <span className="tc-verify-result-status" style={{ color: meta.color }}>
                        {it.reason ?? meta.text}
                      </span>
                      {it.lines != null && <span className="tc-verify-result-code">当前 {it.lines} 行</span>}
                      {it.laterModified && (
                        <span className="tc-verify-result-dur" title="文件修改时间晚于这条消息">
                          之后被改过
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
              {data ? '重新核对' : '核对磁盘'}
            </button>
            <span className="tc-verify-notes">
              只读：读文件比对内容，不修改任何东西。
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
