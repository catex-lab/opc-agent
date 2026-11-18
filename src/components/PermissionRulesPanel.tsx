import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, MessagePlugin } from 'tdesign-react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation, type MessageKey } from '../i18n';
import { InfoHint } from './InfoHint';
import { api } from '../api';

/**
 * 权限门禁规则（A40）。
 *
 * 面板只是 `data/permission-rules.json` 的编辑器：裁决在服务端
 * `server/agents/permission-gate.ts`，内置分类器改不了，这里只能追加。
 * 边界要说清：只对 SDK（WorkBuddy）类 Agent 生效 —— CLI/ACP 的工具调用
 * 发生在人家的 harness 里，我们拦不到，UI 上如实标注。
 *
 * T3-1（P0）：本面板是权限分区三组里的**第一组「自定义规则」**。
 * 机制说明缩成一行 intro，deny/scope 全文收进 ⓘ（T3-2/T3-3）；
 * 「保存」在无改动时渲染为禁用态（T3-4）。
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
  /**
   * T3-4：上次保存（或本次载入）时服务端返回的规则快照。
   * 与当前编辑内容逐字节对比，得出「有没有改动」—— 保存按钮只在真的
   * 改过的时候才可点，否则它是一颗会引发误导的假按钮。
   */
  const [snapshot, setSnapshot] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/api/permission-rules');
      const j = await r.json();
      setRules(j.rules ?? []);
      setNote(j.note ?? '');
      setSnapshot(JSON.stringify(j.rules ?? []));
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
      const r = await api.put('/api/permission-rules', {
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
      setSnapshot(JSON.stringify(j.rules ?? []));
      MessagePlugin.success(t('settings.permission.saved'));
    } catch (e) {
      MessagePlugin.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const patch = (i: number, p: Partial<PermissionRule>) =>
    setRules(prev => prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)));

  // T3-4：无规则、无改动 → 禁用。快照在首次载入成功前是 null，同样按禁用处理。
  const dirty = !loading && snapshot !== null && JSON.stringify(rules) !== snapshot;

  // T3-3：机制说明收进 ⓘ。服务端附言（note）存在时并入同一段，不再单独占一行。
  const introDetail = `${t('settings.permission.introDetail')}${note ? ` ${note}` : ''}`;

  return (
    <div className="space-y-4" data-permission-rules-panel>
      {/* T3-2：三段机制说明缩成一行 intro；全文（deny 优先级 + 适用范围 + 服务端附言）
          收进同一枚 ⓘ —— 这些是「第一次配置才需要」的背景，不值得常驻占四行。 */}
      <div className="flex items-start gap-1.5">
        <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          {t('settings.permission.intro')}
        </p>
        <InfoHint
          label={t('settings.common.about', { label: t('settings.permission.title') })}
          text={introDetail}
        />
      </div>

      {/* T3-1：组一标题。分区内容区不再有大标题（T1-1），组标题就是本组的第一行。 */}
      <h2 className="tc-section-title">{t('settings.permission.groupRules')}</h2>

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
        {/* T3-4：保存是「提交改动」的动作，没改动时禁用 —— 与效果图一致，
            也避免用户在没改任何东西时误点一遍全量写盘。 */}
        <Button theme="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          {t('settings.permission.save')}
        </Button>
      </div>
    </div>
  );
}
