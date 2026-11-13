import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Play, Terminal, X } from 'lucide-react';
import { Button } from 'tdesign-react';
import { useTranslation, type MessageKey } from '../i18n';

/**
 * 手动添加本地 CLI Agent 的对话框（A223）。
 *
 * ## 为什么入口在通讯录而不是设置页
 *
 * 自定义模型厂商（A114）放设置页是对的：那是**凭据**配置，用户的心智是
 * 「填地址配 Key」。手动 CLI 接的是**联系人**——它进入名册、参与群聊分派，
 * 与「添加模型厂商」不是一类动作。IM 的心智里「新增联系人」就在通讯录里做。
 *
 * ## 表单分四步的心智模型
 *
 * ① 命令（是什么）→ ② 参数（怎么喂）→ ③ 输入/输出（怎么读）→ ④ 能力（会什么）。
 * 「检测」与「试跑」分开：检测是零成本解析（命令存不存在），试跑是一次
 * **真实的 LLM 调用**（可能花钱、要等 30s）——把两件事合并成一个按钮，
 * 用户为了确认路径就要被扣一次额度，不合理。
 */

interface AddCustomCliDialogProps {
  open: boolean;
  /** 编辑模式：要改的那条 spec 的 id；null = 新建 */
  editingId: string | null;
  onClose: () => void;
  /** 保存成功后回调（上层刷新名册） */
  onSaved: () => void;
}

/** 与后端 SELECTABLE_CAPABILITIES 对齐（shared 化收益低——6 个词的枚举） */
const CAPABILITIES: Array<{ key: string; labelKey: string }> = [
  { key: 'chat', labelKey: 'addcli.capChat' },
  { key: 'code', labelKey: 'addcli.capCode' },
  { key: 'write', labelKey: 'addcli.capWrite' },
  { key: 'tools', labelKey: 'addcli.capTools' },
  { key: 'search', labelKey: 'addcli.capSearch' },
];

interface TrialResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  resolvedPath: string | null;
  stdout: string;
  stderr: string;
  message: string;
}

const FIELD_LABEL: React.CSSProperties = { color: 'var(--td-text-color-secondary)' };

export function AddCustomCliDialog({ open, editingId, onClose, onSaved }: AddCustomCliDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [stdin, setStdin] = useState(false);
  const [protocol, setProtocol] = useState<'text' | 'jsonl'>('text');
  const [caps, setCaps] = useState<string[]>(['chat']);
  const [checkState, setCheckState] = useState<{ checking: boolean; ok: boolean | null; path: string | null; error: string }>(
    { checking: false, ok: null, path: null, error: '' }
  );
  const [trial, setTrial] = useState<{ running: boolean; result: TrialResult | null }>({
    running: false,
    result: null,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 打开时重置；编辑模式拉取现有 spec
  useEffect(() => {
    if (!open) return;
    setError('');
    setCheckState({ checking: false, ok: null, path: null, error: '' });
    setTrial({ running: false, result: null });
    if (editingId) {
      let cancelled = false;
      fetch('/api/agents/custom-cli')
        .then(r => r.json())
        .then((data: { agents?: Array<Record<string, unknown>> }) => {
          if (cancelled) return;
          const spec = data.agents?.find(a => a.id === editingId);
          if (!spec) return;
          setName(String(spec.name ?? ''));
          setCommand(String(spec.command ?? ''));
          setArgsText(Array.isArray(spec.args) ? (spec.args as string[]).join('\n') : '');
          setStdin(spec.stdin === true);
          setProtocol(spec.protocol === 'jsonl' ? 'jsonl' : 'text');
          setCaps(Array.isArray(spec.capabilities) ? (spec.capabilities as string[]) : ['chat']);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    setName('');
    setCommand('');
    setArgsText('');
    setStdin(false);
    setProtocol('text');
    setCaps(['chat']);
  }, [open, editingId]);

  if (!open) return null;

  const runCheck = async () => {
    if (!command.trim()) {
      setCheckState({ checking: false, ok: false, path: null, error: t('addcli.errorNeedCommand') });
      return;
    }
    setCheckState(s => ({ ...s, checking: true, error: '' }));
    try {
      const r = await fetch('/api/agents/custom-cli/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args: argsText, stdin, protocol, capabilities: caps }),
      });
      const data = await r.json();
      if (!r.ok) {
        setCheckState({ checking: false, ok: false, path: null, error: String(data.error ?? '') });
      } else {
        setCheckState({
          checking: false,
          ok: data.ok === true,
          path: data.resolvedPath ?? null,
          error: data.ok ? '' : t('addcli.checkNotFound', { command }),
        });
      }
    } catch (e: any) {
      setCheckState({ checking: false, ok: false, path: null, error: e?.message || '检测失败' });
    }
  };

  const runTrial = async () => {
    setTrial({ running: true, result: null });
    try {
      const r = await fetch('/api/agents/custom-cli/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args: argsText, stdin, protocol, capabilities: caps }),
      });
      const data = await r.json();
      if (!r.ok) {
        setTrial({ running: false, result: null });
        setError(String(data.error ?? ''));
        return;
      }
      setTrial({ running: false, result: data as TrialResult });
    } catch (e: any) {
      setTrial({ running: false, result: null });
      setError(e?.message || '试跑失败');
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = JSON.stringify({ name, command, args: argsText, stdin, protocol, capabilities: caps });
      const url = editingId ? `/api/agents/custom-cli/${editingId}` : '/api/agents/custom-cli';
      const r = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await r.json();
      if (!r.ok) {
        setError(String(data.error ?? ''));
        return;
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('addcli.title')}
        data-add-cli-dialog
        className="tc-dialog flex max-h-[min(720px,100%)] w-[min(560px,100%)] flex-col overflow-hidden rounded-2xl"
      >
        {/* 头部：标题 + 关闭。与 NewGroupDialog 同一条 72px 头部规矩 */}
        <div
          className="flex h-[72px] shrink-0 items-center justify-between px-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <div className="flex items-center gap-2">
            <Terminal size={16} style={{ color: 'var(--td-text-color-secondary)' }} />
            <h3 className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {editingId ? t('addcli.titleEdit') : t('addcli.title')}
            </h3>
          </div>
          <Button variant="text" shape="circle" icon={<X />} onClick={onClose} aria-label={t('addcli.cancel')} />
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* ① 名称 + 命令 */}
          <div>
            <label className="mb-1 block text-caption" style={FIELD_LABEL}>
              {t('addcli.name')}
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={20}
              placeholder={t('addcli.namePlaceholder')}
              data-add-cli-name
              className="h-9 w-full rounded-lg px-3 text-body outline-none"
              style={{ backgroundColor: 'var(--tc-fill-input, var(--td-bg-color-component))', color: 'var(--td-text-color-primary)' }}
            />
          </div>
          <div>
            <label className="mb-1 block text-caption" style={FIELD_LABEL}>
              {t('addcli.command')}
            </label>
            <div className="flex gap-2">
              <input
                value={command}
                onChange={e => {
                  setCommand(e.target.value);
                  setCheckState({ checking: false, ok: null, path: null, error: '' });
                }}
                spellCheck={false}
                placeholder="my-agent 或 C:\tools\my-agent.exe"
                data-add-cli-command
                className="h-9 min-w-0 flex-1 rounded-lg px-3 font-mono text-body outline-none"
                style={{ backgroundColor: 'var(--tc-fill-input, var(--td-bg-color-component))', color: 'var(--td-text-color-primary)' }}
              />
              <Button variant="outline" className="tc-btn-secondary" onClick={runCheck} disabled={checkState.checking} data-add-cli-check>
                {checkState.checking ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {t('addcli.check')}
              </Button>
            </div>
            {checkState.ok === true && checkState.path && (
              <p className="mt-1 truncate text-caption" style={{ color: 'var(--tc-status-success)' }} data-add-cli-check-ok>
                {t('addcli.checkOk', { path: checkState.path })}
              </p>
            )}
            {checkState.error && (
              <p className="mt-1 text-caption" style={{ color: 'var(--tc-status-danger)' }} data-add-cli-check-error>
                {checkState.error}
              </p>
            )}
          </div>

          {/* ② 参数 */}
          <div>
            <label className="mb-1 block text-caption" style={FIELD_LABEL}>
              {t('addcli.args')}
            </label>
            <textarea
              value={argsText}
              onChange={e => setArgsText(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'--run\n{prompt}'}
              data-add-cli-args
              className="w-full rounded-lg px-3 py-2 font-mono text-body outline-none"
              style={{ backgroundColor: 'var(--tc-fill-input, var(--td-bg-color-component))', color: 'var(--td-text-color-primary)', resize: 'vertical' }}
            />
            <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {t('addcli.argsHint')}
            </p>
          </div>

          {/* ③ 输入方式 + 输出协议 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-caption" style={FIELD_LABEL}>
                {t('addcli.inputMode')}
              </label>
              <div className="flex rounded-lg p-0.5" style={{ backgroundColor: 'var(--td-bg-color-component)' }} data-add-cli-input-mode>
                {([['argv', 'addcli.inputArgv'], ['stdin', 'addcli.inputStdin']] as Array<['argv' | 'stdin', MessageKey]>).map(
                  ([key, labelKey]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setStdin(key === 'stdin')}
                      className="h-8 flex-1 rounded-md text-caption transition-colors"
                      style={{
                        backgroundColor: (key === 'stdin') === stdin ? 'var(--td-bg-color-container)' : 'transparent',
                        color: (key === 'stdin') === stdin ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
                      }}
                    >
                      {t(labelKey)}
                    </button>
                  )
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-caption" style={FIELD_LABEL}>
                {t('addcli.protocol')}
              </label>
              <div className="flex rounded-lg p-0.5" style={{ backgroundColor: 'var(--td-bg-color-component)' }} data-add-cli-protocol>
                {([['text', 'addcli.protocolText'], ['jsonl', 'addcli.protocolJsonl']] as Array<['text' | 'jsonl', MessageKey]>).map(
                  ([key, labelKey]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setProtocol(key)}
                      className="h-8 flex-1 rounded-md text-caption transition-colors"
                      style={{
                        backgroundColor: protocol === key ? 'var(--td-bg-color-container)' : 'transparent',
                        color: protocol === key ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
                      }}
                    >
                      {t(labelKey)}
                    </button>
                  )
                )}
              </div>
            </div>
          </div>

          {/* ④ 能力 */}
          <div>
            <label className="mb-1 block text-caption" style={FIELD_LABEL}>
              {t('addcli.capabilities')}
            </label>
            <div className="flex flex-wrap gap-1.5" data-add-cli-capabilities>
              {CAPABILITIES.map(({ key, labelKey }) => {
                const on = caps.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCaps(v => (on ? v.filter(c => c !== key) : [...v, key]))}
                    className="rounded-full px-3 py-1 text-caption transition-colors"
                    style={{
                      border: `1px solid ${on ? 'var(--td-brand-color)' : 'var(--tc-divider)'}`,
                      color: on ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                    }}
                  >
                    {t(labelKey as MessageKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 试跑（可选）：一次真实调用。结果原样展示，成功失败都是结论 */}
          <div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="tc-btn-secondary" onClick={runTrial} disabled={trial.running} data-add-cli-trial>
                {trial.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                {t('addcli.trial')}
              </Button>
              <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('addcli.trialHint')}
              </span>
            </div>
            {trial.result && (
              <div
                className="mt-2 max-h-40 overflow-y-auto rounded-lg p-2.5 font-mono text-caption whitespace-pre-wrap"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  color: trial.result.ok ? 'var(--tc-status-success)' : 'var(--tc-status-danger)',
                }}
                data-add-cli-trial-result
              >
                {trial.result.message}
                {(trial.result.stdout || trial.result.stderr) &&
                  `\n────\n${trial.result.stdout || trial.result.stderr}`}
              </div>
            )}
          </div>

          {error && (
            <p className="text-caption" style={{ color: 'var(--tc-status-danger)' }} data-add-cli-error>
              {error}
            </p>
          )}
        </div>

        {/* 底部：取消 / 保存。与既有弹窗同一对按钮规格 */}
        <div
          className="flex h-[64px] shrink-0 items-center justify-end gap-2 px-5"
          style={{ borderTop: '1px solid var(--tc-divider)' }}
        >
          <Button variant="outline" className="tc-btn-secondary" onClick={onClose}>
            {t('addcli.cancel')}
          </Button>
          <Button theme="primary" className="tc-btn-brand" onClick={save} disabled={saving || !name.trim() || !command.trim()} data-add-cli-save>
            {t('addcli.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
