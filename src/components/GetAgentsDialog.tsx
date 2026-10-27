import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, X } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { InstallCard } from './InstallCard';
import { AVAILABILITY_META, availabilityLabelOf, type InstallMethod, type RegisteredAgent } from '../types';

/**
 * 「获取 Agent」清单页（A71）。
 *
 * ## 为什么需要一个清单页，而不是只在资料页做单条按钮
 *
 * 用户的问题是「**新用户装完本应用**，本地扫不到内置的 Agent」。这个场景的特征是
 * **几乎全空**：14 条里 11 条 `not-installed`。这时候让用户逐条点进资料页、
 * 每条找一次按钮，是把一件"一次性的事"拆成十一次。
 *
 * 所以这里是主入口，资料页的卡片是同一个组件的单条形态。
 *
 * ## 分组为什么按 method 而不是按厂商
 *
 * 用户此刻要做的动作只有 5 种（复制命令 / 打开安装页 / 打开下载页 / 填 Key /
 * 什么都做不了）。按厂商分会变成"14 个标题各一行"，用户还是要逐行读；
 * 按动作分，他可以直接跳到"我能做的那种"。
 *
 * ## 这里没有任何"一键安装"
 *
 * 只有复制与跳转。理由写在 InstallCard 顶部：`irm | iex` 是从网络取一段代码
 * 直接执行，我们无法审计、无法固定版本。装完点「重新检测」，状态立刻更新
 * （`POST /api/agents/probe`）。
 */

interface GetAgentsDialogProps {
  open: boolean;
  agents: RegisteredAgent[];
  onClose: () => void;
  onReprobe?: () => void;
  onOpenCredential?: (agentId: string) => void;
  /** 点名字看完整资料（可选；清单页里点了会先关掉自己） */
  onViewDetail?: (agentId: string) => void;
}

/** 分组顺序 = 用户此刻最可能动手的顺序 */
const GROUP_ORDER: InstallMethod[] = ['npm', 'script', 'installer', 'key', 'unknown'];

const GROUP_TITLE: Record<InstallMethod, string> = {
  npm: '用 npm 安装',
  script: '官方安装脚本',
  installer: '桌面端安装器',
  key: '填凭据即可',
  unknown: '本应用未收录入口',
};

/** 一句话说清这一组要做什么 —— 放在组标题右边，灰字 */
const GROUP_HINT: Record<InstallMethod, string> = {
  npm: '需要本机有 Node.js',
  script: '在终端里自己运行',
  installer: '去官网下载',
  key: '不需要安装',
  unknown: '只能手动处理',
};

/**
 * 进清单的判定（A71）。
 *
 * `method:'key'` 的条目是**特例**：它们由本应用直接发 HTTP 或走内置 SDK，
 * 机器上不用装任何东西，缺凭据时状态是 `needs-auth` —— 如果按"只有未安装才进清单"
 * 判断，豆包 / Kimi / WorkBuddy 永远不会出现在这个清单里，而它们恰恰是新用户
 * 最先要处理的三条（不填 Key 一条都用不了）。
 *
 * 其余条目仍然是「没装 / 装了起不来」才进 —— 已经装好只差登录的 CLI 不进来，
 * 否则用户会被引去重装一个没坏的东西。
 */
export function isInstallable(agent: RegisteredAgent): boolean {
  const a = agent.status.availability;
  if (agent.install?.method === 'key') {
    return a === 'needs-auth' || a === 'not-installed' || a === 'needs-setup';
  }
  return a === 'not-installed' || a === 'needs-setup';
}

export function GetAgentsDialog({
  open,
  agents,
  onClose,
  onReprobe,
  onOpenCredential,
  onViewDetail,
}: GetAgentsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const pending = useMemo(() => agents.filter(isInstallable), [agents]);
  const readyCount = agents.filter(a => a.status.availability === 'ready').length;

  const groups = useMemo(() => {
    const byMethod = new Map<InstallMethod, RegisteredAgent[]>();
    for (const a of pending) {
      // 没有 install 元数据的老数据归到 unknown：它会退回纯文字说明，
      // 而不是消失 —— 消失会让用户以为"这条不支持"，那是另一种假话。
      const m: InstallMethod = a.install?.method ?? 'unknown';
      const list = byMethod.get(m) ?? [];
      list.push(a);
      byMethod.set(m, list);
    }
    return GROUP_ORDER.filter(m => (byMethod.get(m)?.length ?? 0) > 0).map(m => ({
      method: m,
      items: byMethod.get(m)!,
    }));
  }, [pending]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-get-agents-overlay
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-get-agents-title"
        className="tc-dialog tc-pop-in flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-2xl"
        data-get-agents
      >
        <div
          className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <div className="min-w-0 flex-1">
            <h2
              id="tc-get-agents-title"
              className="text-title-lg font-semibold"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              获取 Agent
            </h2>
            <p
              className="mt-1 text-secondary"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              这些命令行工具不在安装包里，需要装到你的机器上
            </p>
          </div>
          <span
            className="shrink-0 pt-1 text-secondary"
            style={{ color: 'var(--td-text-color-placeholder)' }}
            data-get-agents-count
          >
            已就绪 {readyCount} / {agents.length}
          </span>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="关闭"
            data-dialog-close
            className="tc-icon-btn shrink-0"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <div
              className="px-5 py-10 text-center text-secondary"
              style={{ color: 'var(--td-text-color-secondary)' }}
              data-get-agents-empty
            >
              全部就绪，没有需要获取的条目
            </div>
          ) : (
            groups.map(g => (
              <section key={g.method} data-get-agents-group={g.method}>
                <div
                  className="sticky top-0 z-10 flex items-baseline gap-2 px-5 py-2 text-[12px]"
                  style={{
                    backgroundColor: 'var(--tc-surface-raised, transparent)',
                    color: 'var(--td-text-color-placeholder)',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <span style={{ color: 'var(--td-text-color-secondary)', fontWeight: 500 }}>
                    {GROUP_TITLE[g.method]}
                  </span>
                  <span>{g.items.length} 条</span>
                  <span>· {GROUP_HINT[g.method]}</span>
                </div>
                {g.items.map(a => {
                  const meta = AVAILABILITY_META[a.status.availability];
                  return (
                    <div
                      key={a.id}
                      className="mx-5 mb-2 overflow-hidden rounded-xl"
                      style={{
                        backgroundColor: 'var(--tc-surface-raised)',
                        // A115 续：安装卡描边 --tc-edge（4.5% 墨）—— 弹窗里
                        // 的内容卡，靠 raised 底色分层，描边只兜底。
                        border: '1px solid var(--tc-edge)',
                      }}
                      data-get-agents-row={a.id}
                    >
                      <div className="flex items-center gap-2.5 px-4 pt-3">
                        <AgentAvatar
                          id={a.id}
                          name={a.name}
                          icon={a.icon}
                          color={a.color}
                          availability={a.status.availability}
                          size={28}
                        />
                        {onViewDetail ? (
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onViewDetail(a.id);
                            }}
                            className="min-w-0 flex-1 truncate text-left text-body"
                            style={{ color: 'var(--td-text-color-primary)' }}
                            data-get-agents-open={a.id}
                          >
                            {a.name}
                          </button>
                        ) : (
                          <span
                            className="min-w-0 flex-1 truncate text-body"
                            style={{ color: 'var(--td-text-color-primary)' }}
                          >
                            {a.name}
                          </span>
                        )}
                        <span
                          className="shrink-0 text-[11px]"
                          style={{ color: meta.color }}
                        >
                          {availabilityLabelOf(a)}
                        </span>
                      </div>
                      <InstallCard
                        agent={a}
                        bare
                        onReprobe={onReprobe}
                        onOpenCredential={onOpenCredential}
                      />
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <div
          className="flex shrink-0 items-center gap-3 px-5 py-3"
          style={{ borderTop: '1px solid var(--tc-divider)' }}
        >
          <span
            className="min-w-0 flex-1 text-[12px]"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            装完点重新检测，状态立刻更新，不用重启应用
          </span>
          {onReprobe && (
            <button
              type="button"
              className="tc-btn-secondary"
              onClick={onReprobe}
              data-get-agents-reprobe
            >
              <RefreshCw size={12} />
              重新检测
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
