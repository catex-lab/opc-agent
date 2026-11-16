import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Button } from 'tdesign-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useTranslation, type MessageKey } from '../i18n';
import { api } from '../api';

/**
 * 定时任务管理对话框（A224）。
 *
 * ## 入口在哪里
 *
 * 单聊 = 头部「⋯」菜单；群聊 = 群设置面板。两处打开的是**同一个**对话框，
 * 管理的是同一个会话的任务 —— 排班挂在会话上，不在入口上。
 *
 * ## 表单只有两个字段
 *
 * 指令（到点执行什么）+ 表达式（什么时候）。预设下拉覆盖九成场景，
 * 自定义表达式带即时预览（下一次是几点，选完就能看到，不用心算 cron）。
 * 没有做的：按日历挑时间——那要一个日期选择器，为一个低频配置页不值。
 */

interface ScheduleDialogProps {
  open: boolean;
  session: { id: string; title: string; kind: 'direct' | 'group' } | null;
  onClose: () => void;
}

interface ScheduleTaskView {
  id: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'skipped' | 'missed';
  lastError?: string;
  runtime: { running: boolean };
}

const PRESETS: Array<{ expr: string; labelKey: MessageKey }> = [
  { expr: '0 9 * * 1-5', labelKey: 'sched.presetWeekday' },
  { expr: '0 9 * * *', labelKey: 'sched.presetDaily' },
  { expr: '0 9 * * 1', labelKey: 'sched.presetMonday' },
  { expr: '0 9,18 * * *', labelKey: 'sched.presetTwice' },
];

const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--tc-status-success)',
  error: 'var(--tc-status-danger)',
  skipped: 'var(--td-text-color-placeholder)',
  missed: 'var(--tc-status-warning, #E37318)',
};

function fmtTime(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const FIELD_LABEL: React.CSSProperties = { color: 'var(--td-text-color-secondary)' };

export function ScheduleDialog({ open, session, onClose }: ScheduleDialogProps) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ScheduleTaskView[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<ScheduleTaskView | null>(null);

  const load = async (silent = false) => {
    if (!session) return;
    if (!silent) setLoading(true);
    try {
      const r = await api.get(`/api/schedules?sessionId=${encodeURIComponent(session.id)}`);
      const data = await r.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch {
      /* 静默失败：下次打开再取 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setCreating(false);
    setPrompt('');
    setCron('0 9 * * 1-5');
    setPreview([]);
    setError('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.id]);

  // 表达式预览：300ms 防抖，选完就能看到下一次是几点
  useEffect(() => {
    if (!open || !creating || !cron.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await api.post('/api/schedules/preview', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron }),
        });
        const data = await r.json();
        if (!cancelled) setPreview(Array.isArray(data.runs) ? data.runs : []);
      } catch {
        if (!cancelled) setPreview([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, creating, cron]);

  const save = async () => {
    if (!session) return;
    setSaving(true);
    setError('');
    try {
      const r = await api.post('/api/schedules', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, prompt, cron }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(String(data.error ?? ''));
        return;
      }
      setCreating(false);
      setPrompt('');
      await load(true);
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (task: ScheduleTaskView) => {
    try {
      await api.patch(`/api/schedules/${task.id}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      await load(true);
    } catch {
      /* 下次打开再同步 */
    }
  };

  const doRemove = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/schedules/${removing.id}`);
      await load(true);
    } finally {
      setRemoving(null);
    }
  };

  const cronError = useMemo(() => {
    // 轻校验只在 UI 侧提示形状；真正拦截（含高频上限）在服务端
    if (!creating) return '';
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return t('sched.errFiveFields');
    return '';
  }, [creating, cron, t]);

  if (!open || !session) return null;

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
        aria-label={t('sched.title')}
        data-schedule-dialog
        className="tc-dialog flex max-h-[min(680px,100%)] w-[min(600px,100%)] flex-col overflow-hidden rounded-2xl"
      >
        <div
          className="flex h-[72px] shrink-0 items-center justify-between px-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <CalendarClock size={16} style={{ color: 'var(--td-text-color-secondary)' }} />
            <div className="min-w-0">
              <h3 className="text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                {t('sched.title')}
              </h3>
              <p className="truncate text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {session.title}
              </p>
            </div>
          </div>
          <Button variant="text" shape="circle" icon={<X />} onClick={onClose} aria-label={t('sched.cancel')} />
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--td-text-color-placeholder)' }} />
            </div>
          ) : tasks.length === 0 && !creating ? (
            <div className="px-4 py-10 text-center">
              <p className="text-body" style={{ color: 'var(--td-text-color-secondary)' }}>
                {t('sched.empty')}
              </p>
              <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                {t('sched.emptyHint')}
              </p>
            </div>
          ) : (
            tasks.map(task => (
              <div
                key={task.id}
                className="rounded-xl p-3"
                style={{ backgroundColor: 'var(--td-bg-color-component)', opacity: task.enabled ? 1 : 0.55 }}
                data-schedule-row={task.id}
              >
                <div className="flex items-center gap-2">
                  {/* 启用开关：左列直读状态，比文字徽标更省一次扫视 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={task.enabled}
                    onClick={() => void toggle(task)}
                    data-schedule-toggle={task.id}
                    className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
                    style={{ backgroundColor: task.enabled ? 'var(--td-brand-color)' : 'var(--td-text-color-placeholder)' }}
                  >
                    <span
                      className="absolute top-0.5 h-3 w-3 rounded-full transition-all"
                      style={{ left: task.enabled ? 14 : 2, backgroundColor: '#fff' }}
                    />
                  </button>
                  <span className="font-mono text-caption" style={{ color: 'var(--td-text-color-primary)' }}>
                    {task.cron}
                  </span>
                  {task.runtime.running && (
                    <span className="text-caption" style={{ color: 'var(--td-brand-color)' }}>
                      {t('sched.running')}
                    </span>
                  )}
                  {!task.runtime.running && task.lastStatus && (
                    <span className="text-caption" style={{ color: STATUS_COLOR[task.lastStatus] }} title={task.lastError}>
                      {t(`sched.status.${task.lastStatus}` as MessageKey)}
                    </span>
                  )}
                  <Button
                    variant="text"
                    shape="circle"
                    icon={<Trash2 />}
                    onClick={() => setRemoving(task)}
                    aria-label={t('sched.delete')}
                    style={{ marginLeft: 'auto', color: 'var(--td-text-color-secondary)' }}
                  />
                </div>
                <p
                  className="mt-1.5 line-clamp-2 text-body"
                  style={{ color: 'var(--td-text-color-primary)' }}
                  title={task.prompt}
                >
                  {task.prompt}
                </p>
                <div className="mt-1 flex items-center gap-3 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {task.enabled && task.nextRunAt && (
                    <span>
                      {t('sched.nextRun')}: {fmtTime(task.nextRunAt)}
                    </span>
                  )}
                  {task.lastRunAt && <span>{t('sched.lastRun')}: {fmtTime(task.lastRunAt)}</span>}
                </div>
                {task.lastError && (
                  <p className="mt-1 text-caption" style={{ color: 'var(--tc-status-danger)' }}>
                    {task.lastError}
                  </p>
                )}
              </div>
            ))
          )}

          {creating ? (
            <div
              className="space-y-3 rounded-xl p-3"
              style={{ backgroundColor: 'var(--td-bg-color-component)' }}
              data-schedule-form
            >
              <div>
                <label className="mb-1 block text-caption" style={FIELD_LABEL}>
                  {t('sched.prompt')}
                </label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder={t('sched.promptPlaceholder')}
                  data-schedule-prompt
                  className="w-full rounded-lg px-3 py-2 text-body outline-none"
                  style={{
                    backgroundColor: 'var(--td-bg-color-container)',
                    color: 'var(--td-text-color-primary)',
                    resize: 'vertical',
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-caption" style={FIELD_LABEL}>
                  {t('sched.cron')}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map(p => (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => setCron(p.expr)}
                      className="rounded-full px-2.5 py-1 text-caption transition-colors"
                      style={{
                        border: `1px solid ${cron === p.expr ? 'var(--td-brand-color)' : 'var(--tc-divider)'}`,
                        color: cron === p.expr ? 'var(--td-brand-color)' : 'var(--td-text-color-secondary)',
                      }}
                    >
                      {t(p.labelKey)}
                    </button>
                  ))}
                </div>
                <input
                  value={cron}
                  onChange={e => setCron(e.target.value)}
                  spellCheck={false}
                  className="mt-2 h-9 w-full rounded-lg px-3 font-mono text-body outline-none"
                  style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-primary)' }}
                  data-schedule-cron
                />
                {cronError ? (
                  <p className="mt-1 text-caption" style={{ color: 'var(--tc-status-danger)' }}>
                    {cronError}
                  </p>
                ) : preview.length > 0 ? (
                  <p className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }} data-schedule-preview>
                    {t('sched.preview')}: {preview.map(p => fmtTime(Date.parse(p))).join(' · ')}
                  </p>
                ) : null}
              </div>
              {error && (
                <p className="text-caption" style={{ color: 'var(--tc-status-danger)' }} data-schedule-error>
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" className="tc-btn-secondary" onClick={() => setCreating(false)}>
                  {t('sched.cancel')}
                </Button>
                <Button
                  theme="primary"
                  className="tc-btn-brand"
                  onClick={save}
                  disabled={saving || !prompt.trim() || !!cronError}
                  data-schedule-save
                >
                  {t('sched.save')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-center pt-1">
              <Button variant="outline" className="tc-btn-secondary" icon={<Plus />} onClick={() => setCreating(true)} data-schedule-create>
                {t('sched.new')}
              </Button>
            </div>
          )}

          <p className="pt-1 text-center text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {t('sched.footnote')}
          </p>
        </div>

        <ConfirmDialog
          open={removing !== null}
          title={t('sched.delete')}
          danger
          confirmText={t('sched.delete')}
          cancelText={t('sched.cancel')}
          onConfirm={() => void doRemove()}
          onCancel={() => setRemoving(null)}
        >
          <p>{t('sched.deleteConfirm')}</p>
        </ConfirmDialog>
      </div>
    </div>,
    document.body
  );
}
