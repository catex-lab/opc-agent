/**
 * B1：「最近删除」回收站面板（设置 → 最近删除）。
 *
 * ## 为什么必须有这个入口
 *
 * B1 的删除改成了「先快照再删、保留 30 天」。但恢复接口存在 ≠ 用户找得到：
 * 删除确认框写着「30 天内可恢复」，如果界面上没有任何地方能恢复，
 * 这句话就是**对用户说谎**。所以这个面板不是锦上添花，是 B1 的收尾。
 *
 * ## 为什么只做「恢复」，不做「永久删除」
 *
 * 用户点删除时的意图已经表达过了；这里再多一个「彻底删除」按钮，
 * 只会多一次误点机会。条目 30 天后自然过期，不需要人管。
 *
 * ## 数据来源
 *
 * `GET /api/trash` 返回 `{ items: [{ id, kind, sessionId, label, deletedAt, expiresAt }] }`。
 * 一律按服务端给的 `expiresAt` 显示剩余天数 —— 前端不自己算保留期，
 * 否则改了 `OPC_TRASH_RETENTION_DAYS` 界面就会说谎。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Loading, MessagePlugin } from 'tdesign-react';
import { Trash2, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { httpErrorText } from '../lib/http-error';
import { useTranslation } from '../i18n';

interface TrashItem {
  id: string;
  kind: 'session' | 'messages';
  sessionId: string;
  label: string;
  deletedAt: string;
  expiresAt: string;
}

/** 剩余天数：向上取整（「还剩 1 天」比「还剩 0 天」诚实）。 */
function daysLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function TrashPanel() {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/trash');
      if (!res.ok) {
        setError(httpErrorText(res.status));
        setItems([]);
        return;
      }
      const data = (await res.json()) as { items?: TrashItem[] };
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch {
      setError(httpErrorText(500));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const res = await api.post(`/api/trash/${id}/restore`);
        if (res.ok) {
          MessagePlugin.success(t('settings.trash.restored'));
          // 恢复后会话列表要重拉才有这条 —— 用一个显式事件通知外层，
          // 不在这里直接 import 会话 hook（设置页不该依赖聊天状态）。
          window.dispatchEvent(new CustomEvent('opc:sessions-changed'));
          await load();
          return;
        }
        if (res.status === 409) {
          // 业务冲突：同名会话已被重建。这不是故障，措辞不能像报错。
          MessagePlugin.warning(t('settings.trash.conflict'));
          await load();
          return;
        }
        if (res.status === 410) {
          // 已过保留期（服务端按 expires_at 判的）。说明「为什么没了」，
          // 别让用户以为是 bug；同时重拉列表让这条从界面上消失。
          MessagePlugin.warning(t('settings.trash.expired'));
          await load();
          return;
        }
        MessagePlugin.error(httpErrorText(res.status));
        await load();
      } catch {
        MessagePlugin.error(httpErrorText(500));
      } finally {
        setBusy(null);
      }
    },
    [load, t]
  );

  if (items === null) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loading size="small" />
      </div>
    );
  }

  if (error) {
    return (
      <p data-trash-error style={{ color: 'var(--td-error-color)' }}>
        {error}
      </p>
    );
  }

  if (items.length === 0) {
    // 空态要说明「删除的东西会来这里」，否则用户以为功能不存在
    return (
      <div data-trash-empty className="py-10 text-center" style={{ color: 'var(--td-text-color-placeholder)' }}>
        <Trash2 size={28} className="mx-auto mb-3 opacity-60" aria-hidden />
        <p>{t('settings.trash.empty')}</p>
      </div>
    );
  }

  return (
    <div data-trash-list className="flex flex-col">
      <p className="mb-3" style={{ color: 'var(--td-text-color-placeholder)' }}>
        {t('settings.trash.hint')}
      </p>
      {items.map(item => (
        <div
          key={item.id}
          data-trash-item
          className="flex items-center gap-3 py-2.5"
          style={{ borderBottom: '1px solid var(--tc-rule)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate" title={item.label}>
              {item.label}
            </div>
            <div className="mt-0.5" style={{ color: 'var(--td-text-color-placeholder)', fontSize: 'var(--text-body-sm)' }}>
              {t('settings.trash.daysLeft').replace('{n}', String(daysLeft(item.expiresAt)))}
            </div>
          </div>
          <Button
            size="small"
            variant="outline"
            loading={busy === item.id}
            onClick={() => void restore(item.id)}
          >
            <RotateCcw size={14} className="mr-1" aria-hidden />
            {t('settings.trash.restore')}
          </Button>
        </div>
      ))}
    </div>
  );
}
