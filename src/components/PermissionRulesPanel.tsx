import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, MessagePlugin } from 'tdesign-react';
import { PlusIcon, DeleteIcon } from 'tdesign-icons-react';

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

const DECISION_LABEL: Record<PermissionRule['decision'], string> = {
  allow: '允许',
  deny: '禁止',
};

const EMPTY_ROW: PermissionRule = { tool: '', decision: 'deny', match: '', note: '' };

export function PermissionRulesPanel() {
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
      MessagePlugin.error('读取权限规则失败');
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!r.ok) throw new Error(j.error || '保存失败');
      setRules(j.rules ?? []);
      MessagePlugin.success('已保存，下次工具调用生效');
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
          权限门禁
        </h2>
        <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          在弹窗问人之前，服务端先按内置分类器（23 条危险 + 14 条需确认）与下面的自定义规则判一遍。
          高危命令（<code>rm -rf /</code>、强推主分支、写块设备等）任何模式都直接拒绝。
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
          自定义规则命中「禁止」时<strong>无条件生效</strong>（deny 优先于 allow），包括全放行模式；
          命中「允许」时跳过弹窗直接放行，但拦不住内置分类器判出的高危命令。
          {note ? ` ${note}` : ''}
        </p>
        <p className="mt-2">
          只对「WorkBuddy（SDK）」类 Agent 生效。CLI / ACP 类 Agent 的工具调用跑在它们自己的
          harness 里，这一层门禁够不到 —— 那边的强度取决于 <code>--permission-mode</code> 等启动参数
          （见「自定义 Agent」里的权限说明）。
        </p>
      </div>

      <div className="space-y-3">
        {rules.length === 0 && !loading && (
          <p className="text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
            还没有自定义规则，先走内置分类器 + 逐次弹窗。
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
              placeholder="工具名，如 Bash / Write / *"
              style={{ width: 150 }}
              tips="支持 * 结尾通配，如 mcp__*"
            />
            <Input
              value={rule.match ?? ''}
              onChange={v => patch(i, { match: v })}
              placeholder="命令/路径包含的关键词（可空）"
              style={{ width: 220 }}
            />
            <Select
              value={rule.decision}
              onChange={v => patch(i, { decision: v as PermissionRule['decision'] })}
              style={{ width: 100 }}
            >
              <Select.Option value="deny">{DECISION_LABEL.deny}</Select.Option>
              <Select.Option value="allow">{DECISION_LABEL.allow}</Select.Option>
            </Select>
            <Input
              value={rule.note ?? ''}
              onChange={v => patch(i, { note: v })}
              placeholder="给人看的理由（可空）"
              style={{ flex: 1, minWidth: 140 }}
            />
            <Button
              shape="circle"
              theme="danger"
              variant="text"
              onClick={() => setRules(prev => prev.filter((_, idx) => idx !== i))}
            >
              <DeleteIcon />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => setRules(prev => [...prev, { ...EMPTY_ROW }])}
        >
          <PlusIcon className="mr-1" />
          添加规则
        </Button>
        <Button theme="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          保存
        </Button>
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          最多 50 条，写道 data/permission-rules.json
        </span>
      </div>
    </div>
  );
}
