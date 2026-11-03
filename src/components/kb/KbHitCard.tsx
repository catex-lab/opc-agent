import { useState } from 'react';
import type { KbHit } from './types';
import { formatTime } from './format';

interface KbHitCardProps {
  hit: KbHit;
  index: number;
  agentName: string;
  sessionTitle: string;
  onOpenConversation: (sessionId: string, messageId: string) => void;
}

/**
 * 一条检索来源。
 *
 * 「展开原文」只读切片里的脱敏正文，不回 chat.db 重新拉原始消息；
 * 「回到原对话」只拿 messageIds 定位主键，避免把脱敏文本当成原文回填。
 */
export function KbHitCard({
  hit,
  index,
  agentName,
  sessionTitle,
  onOpenConversation,
}: KbHitCardProps) {
  const [expanded, setExpanded] = useState(false);
  const messageId = hit.messageIds[0];

  return (
    <article className="kb-hit" data-kb-hit>
      <div className="kb-hit-top">
        <span className="kb-hit-no">{String(index + 1).padStart(2, '0')}</span>
        <p className="kb-hit-sum">{hit.summary}</p>
      </div>

      <p className="kb-hit-snippet">{hit.snippet}</p>

      <div className="kb-hit-meta">
        <span data-kb-hit-agent>{agentName}</span>
        <span className="kb-hit-sep" aria-hidden="true" />
        <span data-kb-hit-session>{sessionTitle}</span>
        <span className="kb-hit-sep" aria-hidden="true" />
        <span data-kb-hit-time>{formatTime(hit.timeEnd)}</span>
        <span className="kb-hit-sep" aria-hidden="true" />
        <span>{hit.sourceType === 'group' ? '群聊' : '单聊'}</span>
        <span className="kb-hit-sep" aria-hidden="true" />
        <span data-kb-hit-redacted>脱敏 {hit.redactedCount} 处</span>
      </div>

      <div className="kb-hit-actions">
        <button
          type="button"
          className="kb-link"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          {expanded ? '收起原文' : '展开原文'}
        </button>
        <button
          type="button"
          className="kb-link"
          disabled={!messageId}
          title={messageId ? '回到这段来源所在的会话消息' : '来源没有可定位的消息主键'}
          onClick={() => messageId && onOpenConversation(hit.sessionId, messageId)}
        >
          回到原对话
        </button>
      </div>

      {expanded ? <div className="kb-hit-orig">{hit.content}</div> : null}
    </article>
  );
}
