import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, ExternalLink, Folder } from 'lucide-react';
import { MENU_ITEM_CLASS } from './menuItem';
import { pickDirectory, revealInFolder, dirName, hasNativeDialogs } from '../workspace';

interface WorkspaceBadgeProps {
  /** 当前会话的工作目录。undefined / 空 = 没指定，Agent 用后端进程目录 */
  cwd?: string;
  /**
   * 换成新的工作目录。传 `''` 表示清空（回到后端进程目录）。
   * 落库由调用方负责（useSessions.setSessionCwd），这里只上报意图。
   */
  onChange: (cwd: string) => void;
}

/**
 * A63 / 方案二：会话栏头的**工作区徽标 + 弹出面板**。
 *
 * ## 它解决的是什么问题
 *
 * 工作目录的链路本来是通的（sessions.cwd → CLI/SDK 的 cwd 参数），但交互层
 * 只有一个「新对话页的无校验文本框」：设完之后**不可见、不可改** —— 用户
 * 在会话里想不起 Agent 此刻在哪个目录下干活，换个目录要退出去删会话重来。
 *
 * 现在它常驻栏头：当前在哪个目录一眼可见，点一下就能换、能在资源管理器里
 * 打开、能从最近用过的目录里挑。
 *
 * ## 为什么徽标放栏头、不放设置页
 *
 * 依据（PLAN §11.24）：主流 IDE 的浏览器/SCM/终端三件套都带着工作区上下文，
 * 「当前在哪儿干活」
 * 是**每时每刻都需要知道**的状态，不是一个月调一次的偏好。放进设置页等于
 * 让人每次都得翻抽屉。
 *
 * ## 三颗操作各自的降级路径（不摆假控件）
 *
 * - 切换目录：Electron 里弹原生对话框；浏览器开发态没有原生能力，徽标面板
 *   里直接说明、并指向新对话页的手动输入框 —— 而不是放一个点了没反应的按钮。
 * - 在资源管理器中打开：Electron 里 reveal；浏览器里静默跳过（没有资源管理器）。
 * - 最近目录：来自 `GET /api/recent-directories`（口径 = sessions.cwd 里
 *   真在用过的）。空列表时不占位编造，面板就是没有那一节。
 *
 * ## 为什么用原生 details/summary
 *
 * 与会话头部「⋯」菜单、群聊编排模式选择同一手法：点外面自动收起，不用自己
 * 管 outside-click 的监听生命周期。details 自带的箭头标记用 `list-none` 去掉，
 * 箭头自己画（ChevronDown）—— summary 元素只承担点击热区。
 */
export function WorkspaceBadge({ cwd, onChange }: WorkspaceBadgeProps) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);
  const rootRef = useRef<HTMLDetailsElement>(null);

  const hasCwd = !!cwd;
  const label = hasCwd ? dirName(cwd!) : '默认目录';

  // 最近目录：**打开时**才拉。徽标每次渲染都在，挂载就拉会让每个带会话的
  // 页面都多发一个用不上的请求；而「打开面板」正说明用户此刻想换目录。
  useEffect(() => {
    if (!open || recentLoaded) return;
    let alive = true;
    fetch('/api/recent-directories')
      .then(r => (r.ok ? r.json() : { directories: [] }))
      .then((j: { directories?: string[] }) => {
        if (!alive) return;
        setRecent(Array.isArray(j.directories) ? j.directories : []);
        setRecentLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        // 拉不到不弹错：最近目录是便利功能，不是必需品。静默留空，
        // 「切换目录」这条路与它无关，照样能用。
        setRecent([]);
        setRecentLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [open, recentLoaded]);

  // details 不会自动在点击空白处收起（与 ChatHeader 的 ⋯ 同一手法）
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el?.open && !el.contains(e.target as Node)) {
        el.open = false;
        setOpen(false);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const handlePick = async () => {
    const picked = await pickDirectory();
    // null = 取消或不支持，两种都保持原值（不支持的说明写在面板里）
    if (!picked || picked === cwd) return;
    onChange(picked);
  };

  return (
    <details
      ref={rootRef}
      className="relative"
      data-workspace-badge
      onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 transition-colors"
        style={{
          backgroundColor: 'var(--tc-hover-chrome)',
          color: hasCwd ? 'var(--td-text-color-secondary)' : 'var(--td-text-color-placeholder)',
        }}
        title={hasCwd ? `工作目录：${cwd}` : '未指定工作目录，Agent 以后端进程目录为准'}
        aria-label="工作目录"
      >
        <FolderOpen size={14} />
        <span className="max-w-[160px] truncate text-secondary">{label}</span>
        <ChevronDown size={12} />
      </summary>

      <div
        className="tc-glass absolute right-0 top-full z-30 mt-1 w-[300px] overflow-hidden rounded-xl py-1 shadow-popup"
        data-workspace-panel
      >
        {/* 当前完整路径。mono 字体 + break-all：Windows 路径动辄上百字符，
            等宽字体才读得出层级；不可编辑 —— 改路径走「切换目录」或新对话页，
            这里只做展示（ editable 会让「展示态」与「编辑态」两套校验）。 */}
        <div
          className="border-b border-[var(--td-component-border)] px-3 pb-2 pt-1.5 font-mono text-caption"
          style={{ color: 'var(--td-text-color-secondary)', wordBreak: 'break-all' }}
          data-workspace-current-path
        >
          {hasCwd ? cwd : '未指定（使用后端进程目录）'}
        </div>

        <button
          type="button"
          onClick={() => void handlePick()}
          className={MENU_ITEM_CLASS}
          style={{ color: 'var(--td-text-color-primary)' }}
          data-workspace-switch
        >
          <Folder size={14} />
          切换目录
        </button>
        <button
          type="button"
          onClick={() => hasCwd && revealInFolder(cwd!)}
          className={MENU_ITEM_CLASS}
          style={{
            color: 'var(--td-text-color-primary)',
            opacity: hasCwd ? 1 : 0.5,
            cursor: hasCwd ? 'pointer' : 'default',
          }}
          disabled={!hasCwd}
          title={hasCwd ? '在资源管理器中打开并选中该目录' : '未指定工作目录'}
          data-workspace-reveal
        >
          <ExternalLink size={14} />
          在资源管理器中打开
        </button>

        {/* 浏览器开发态没有原生对话框。说明白，并指一条真能走的路 ——
            摆一个点了没反应的「切换目录」才是假控件。 */}
        {!hasNativeDialogs() && (
          <p
            className="mx-3 my-1 text-caption"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            当前环境没有系统目录对话框（浏览器开发态）。可在新对话页的「工作目录」
            输入框手动填写路径。
          </p>
        )}

        {recent.length > 0 && (
          <>
            <div className="my-1 h-px" style={{ backgroundColor: 'var(--td-component-border)' }} />
            <div
              className="px-3 pb-1 pt-0.5 text-caption"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              最近目录
            </div>
            {recent.map(dir => {
              const active = dir === cwd;
              return (
                <button
                  key={dir}
                  type="button"
                  onClick={() => {
                    if (!active) onChange(dir);
                  }}
                  className={MENU_ITEM_CLASS}
                  style={{
                    color: active ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
                    backgroundColor: active ? 'var(--tc-hover-chrome)' : undefined,
                  }}
                  title={dir}
                  data-workspace-recent
                >
                  <Folder size={14} style={{ color: active ? 'var(--td-brand-color)' : undefined }} />
                  <span className="truncate">{dirName(dir)}</span>
                  <span
                    className="ml-auto truncate font-mono text-caption"
                    style={{ color: 'var(--td-text-color-placeholder)', maxWidth: 130 }}
                  >
                    {dir}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </details>
  );
}
