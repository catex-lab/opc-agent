import { useCallback, useState } from 'react';
import { Database } from 'lucide-react';
import { KB_SCOPE_LABEL } from './format';
import { KnowledgeBasePanel, readSavedKbScope } from './KnowledgeBasePanel';
import type { KbScope } from './types';

interface KbScopeChipProps {
  sessionId: string;
  sessionTitle?: string;
}

/** 会话头部入口：展示当前检索范围，点开是完整的知识库面板。 */
export function KbScopeChip({ sessionId, sessionTitle }: KbScopeChipProps) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<KbScope>(() => readSavedKbScope(sessionId));

  const handleScopeChange = useCallback((next: KbScope) => {
    setScope(next);
  }, []);

  return (
    <>
      <button
        type="button"
        className="kb-chip"
        data-kb-chip
        aria-haspopup="dialog"
        aria-expanded={open}
        // 窄宽下文字会被容器查询隐藏（见 kb-ui.css），入口只剩一个图标：
        // 此时 aria-label / title 就是它唯一的自我说明，必须带上当前范围。
        aria-label={`知识库检索与索引，当前范围：${KB_SCOPE_LABEL[scope]}`}
        title={`知识库检索与索引 · 当前范围：${KB_SCOPE_LABEL[scope]}`}
        onClick={() => setOpen(true)}
      >
        <Database size={13} strokeWidth={1.5} aria-hidden="true" />
        <span className="kb-chip-label" data-kb-chip-label>
          知识库 · {KB_SCOPE_LABEL[scope]}
        </span>
      </button>
      <KnowledgeBasePanel
        open={open}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        scope={scope}
        onScopeChange={handleScopeChange}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
