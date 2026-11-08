import { useCallback, useState } from 'react';
import { Database } from 'lucide-react';
import { KnowledgeBasePanel, readSavedKbScope } from './KnowledgeBasePanel';
import type { KbScope } from './types';
import { useTranslation, type MessageKey } from '../../i18n';

/** 范围词只在这里翻译；面板内部仍用 `KB_SCOPE_LABEL`，不在本轮范围内 */
const SCOPE_KEY: Record<KbScope, MessageKey> = {
  session: 'kb.scope.session',
  workspace: 'kb.scope.workspace',
  project: 'kb.scope.project',
  all: 'kb.scope.all',
};

interface KbScopeChipProps {
  sessionId: string;
  sessionTitle?: string;
}

/** 会话头部入口：展示当前检索范围，点开是完整的知识库面板。 */
export function KbScopeChip({ sessionId, sessionTitle }: KbScopeChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<KbScope>(() => readSavedKbScope(sessionId));
  const scopeLabel = t(SCOPE_KEY[scope]);

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
        aria-label={t('kb.chipAria', { scope: scopeLabel })}
        title={t('kb.chipTitle', { scope: scopeLabel })}
        onClick={() => setOpen(true)}
      >
        <Database size={13} strokeWidth={1.5} aria-hidden="true" />
        <span className="kb-chip-label" data-kb-chip-label>
          {t('kb.chipLabel', { scope: scopeLabel })}
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
