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
        title="打开知识库检索与索引设置"
        onClick={() => setOpen(true)}
      >
        <Database size={13} strokeWidth={1.5} aria-hidden="true" />
        <span>知识库 · {KB_SCOPE_LABEL[scope]}</span>
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
