/**
 * 运行组件行（瘦身批次 2）。
 *
 * Codex / Claude 的平台二进制不再随安装包分发，缺组件时在 Agent 资料页给
 * 一个下载入口。刻意只做「状态 + 动作」两件事，不铺解释性文案：
 * 组件是什么、为什么要下载，属于详情页之外的产品说明，不塞进列表。
 *
 * 组件已就绪 / 该 Agent 没有对应组件时整行不渲染（返回 null），
 * 其余 Agent 的资料页布局与改动前完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useTranslation } from '../i18n';

interface VendorComponentStatus {
  id: 'codex' | 'claude';
  label: string;
  agentIds: string[];
  approxBytes: number;
  installed: boolean;
  state: 'installed' | 'missing' | 'downloading' | 'failed';
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  return `${Math.round(bytes / 1024 ** 2)}MB`;
}

export function VendorComponentRow({
  agentId,
  onInstalled,
}: {
  agentId: string;
  /** 下载完成后的回调（通常接「重新探测这个 Agent」，让状态从「未安装」变成真实结论） */
  onInstalled?: () => void;
}) {
  const { t } = useTranslation();
  const [component, setComponent] = useState<VendorComponentStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const aliveRef = useRef(true);
  /** 上一轮状态：用来识别 downloading → installed 的那一次跃迁 */
  const prevStateRef = useRef<VendorComponentStatus['state'] | null>(null);
  // 回调放进 ref：父组件多半传内联箭头函数，直接进 deps 会让 refresh 每次渲染都变，
  // 触发挂载 effect 重跑 → setState → 再渲染的循环。
  const onInstalledRef = useRef(onInstalled);
  useEffect(() => {
    onInstalledRef.current = onInstalled;
  }, [onInstalled]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/api/vendor-components');
      if (!res.ok) return;
      const data = (await res.json()) as { components?: VendorComponentStatus[] };
      const hit = (data.components ?? []).find(c => c.agentIds.includes(agentId)) ?? null;
      if (!aliveRef.current) return;
      const prevState = prevStateRef.current;
      setComponent(hit);
      prevStateRef.current = hit?.state ?? null;
      if (prevState === 'downloading' && hit?.installed) onInstalledRef.current?.();
    } catch {
      /* 服务端不可达时不渲染这一行，不制造假状态 */
    }
  }, [agentId]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  // 只有下载中才轮询：空闲时不产生任何请求
  useEffect(() => {
    if (component?.state !== 'downloading') return;
    const timer = setInterval(() => {
      void refresh();
    }, 800);
    return () => clearInterval(timer);
  }, [component?.state, refresh]);

  if (!component || component.installed) return null;

  const percent =
    component.totalBytes && component.totalBytes > 0
      ? Math.min(100, Math.round(((component.receivedBytes ?? 0) / component.totalBytes) * 100))
      : null;
  const size = formatSize(component.totalBytes || component.approxBytes);

  const start = () => {
    setStarting(true);
    void api
      .post(`/api/vendor-components/${component.id}/download`)
      .catch(() => undefined)
      .finally(() => {
        setStarting(false);
        void refresh();
      });
  };

  const cancel = () => {
    void api
      .post(`/api/vendor-components/${component.id}/cancel`)
      .catch(() => undefined)
      .finally(() => void refresh());
  };

  const stateText =
    component.state === 'downloading'
      ? t('vendor.downloading', { percent: percent ?? 0 })
      : component.state === 'failed'
        ? t('vendor.failed', { reason: component.error ?? '—' })
        : t('vendor.missing', { size });

  return (
    <div
      className="border-t px-4 py-3"
      style={{ borderColor: 'var(--tc-edge)' }}
      data-vendor-component={component.id}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
            {t('vendor.title')}
          </div>
          <div
            className="text-secondary break-words"
            style={{ color: 'var(--td-text-color-placeholder)' }}
            data-vendor-component-state={component.state}
          >
            {stateText}
          </div>
        </div>
        {component.state === 'downloading' ? (
          <button
            type="button"
            className="tc-btn-secondary shrink-0"
            onClick={cancel}
            data-vendor-component-cancel
          >
            {t('vendor.cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="tc-btn-secondary shrink-0"
            onClick={start}
            disabled={starting}
            aria-busy={starting}
            data-vendor-component-download
          >
            {starting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {component.state === 'failed' ? t('vendor.retry') : t('vendor.download')}
          </button>
        )}
      </div>
      {component.state === 'downloading' && (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          data-vendor-component-progress={percent ?? 'unknown'}
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${percent ?? 0}%`, backgroundColor: 'var(--td-brand-color)' }}
          />
        </div>
      )}
    </div>
  );
}
