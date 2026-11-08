import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, MessagePlugin } from 'tdesign-react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation, type MessageKey } from '../i18n';

/**
 * 权限门禁规则（A40）。
 *
 * 面板只是 `data/permission-rules.json` 的编辑器：裁决在服务端
 * `server/agents/permission-gate.ts`，内置分类器改不了，这里只能追加。
 * 边界要说清：只对 SDK（WorkBuddy）类 Agent 生效 —— CLI/ACP 的工具调用
 * 发生在人家的 harness 里，我们拦不到，UI 上如实标注。
 */

interface PermissionRule {
  tool: string;
  match?: string;
  decision: 'allow' | 'deny';
  note?: string;
}

const DECISION_KEY: Record<PermissionRule['decision'], MessageKey> = {
  allow: 'settings.permission.allow',
  deny: 'settings.permission.deny',
};

const EMPTY_ROW: PermissionRule = { tool: '', decision: 'deny', match: '', note: '' };

export function PermissionRulesPanel() {
  const { t, locale } = useTranslation();
  const en = locale === 'en';
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/permission-rules');
      const j = await r.json();
      setRules(j.rules ?? []);
      setNote(j.note ?? '');
    } catch {
      MessagePlugin.error(t('settings.permission.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/permission-rules', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rules: rules
            .filter(x => x.tool.trim())
            .map(x => ({
              tool: x.tool.trim(),
              decision: x.decision,
              match: x.match?.trim() || undefined,
              note: x.note?.trim() || undefined,
            })),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || t('settings.permission.saveFailedShort'));
      setRules(j.rules ?? []);
      MessagePlugin.success(t('settings.permission.saved'));
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const patch = (i: number, p: Partial<PermissionRule>) =>
    setRules(prev => prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)));

  const dirty = !loading;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          {t('settings.permission.title')}
        </h2>
        <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          {t('settings.permission.introPrefix')}
          <code>rm -rf /</code>
          {t('settings.permission.introSuffix')}
        </p>
      </div>

      <div
        className="rounded-lg p-3 text-sm"
        style={{
          backgroundColor: 'var(--td-bg-color-container)',
          color: 'var(--td-text-color-secondary)',
        }}
      >
        <p>
          {t('settings.permission.denyPrefix')}
          <strong>{t('settings.permission.denyStrong')}</strong>
          {t('settings.permission.denySuffix')}
          {note ? ` ${note}` : ''}
        </p>
        <p className="mt-2">
          {t('settings.permission.scopePrefix')}
          <code>--permission-mode</code>
          {t('settings.permission.scopeSuffix')}
        </p>
      </div>

      <div className="space-y-3">
        {rules.length === 0 && !loading && (
          <p className="text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {t('settings.permission.empty')}
          </p>
        )}

        {rules.map((rule, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-lg p-3"
            style={{ backgroundColor: 'var(--td-bg-color-container)' }}
          >
            <Input
              value={rule.tool}
              onChange={v => patch(i, { tool: v })}
              placeholder={t('settings.permission.toolPlaceholder')}
              style={{ width: en ? 180 : 150 }}
              tips={t('settings.permission.toolTips')}
            />
            <Input
              value={rule.match ?? ''}
              onChange={v => patch(i, { match: v })}
              placeholder={t('settings.permission.matchPlaceholder')}
              style={{ width: en ? 250 : 220 }}
            />
            <Select
              value={rule.decision}
              onChange={v => patch(i, { decision: v as PermissionRule['decision'] })}
              style={{ width: en ? 110 : 100 }}
            >
              <Select.Option value="deny">{t(DECISION_KEY.deny)}</Select.Option>
              <Select.Option value="allow">{t(DECISION_KEY.allow)}</Select.Option>
            </Select>
            <Input
              value={rule.note ?? ''}
              onChange={v => patch(i, { note: v })}
              placeholder={t('settings.permission.notePlaceholder')}
              style={{ flex: 1, minWidth: 140 }}
            />
            <Button
              shape="circle"
              theme="danger"
              variant="text"
              onClick={() => setRules(prev => prev.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* A124：加号原来写成裸 svg + mr-1，落在文字基线上，实测比按钮中心高 3px。
            改走 TDesign 的 icon 插槽 —— 对齐由组件负责，不再靠手写 margin 猜。 */}
        <Button
          variant="outline"
          icon={<Plus size={14} />}
          onClick={() => setRules(prev => [...prev, { ...EMPTY_ROW }])}
        >
          {t('settings.permission.add')}
        </Button>
        <Button theme="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          {t('settings.permission.save')}
        </Button>
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {t('settings.permission.footerNote')}
        </span>
      </div>
    </div>
  );
}
