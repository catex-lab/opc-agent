import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, ExternalLink, Folder, FolderPlus, RotateCcw, X } from 'lucide-react';
import { MENU_ITEM_CLASS } from './menuItem';
import { pickDirectory, revealInFolder, dirName, hasNativeDialogs, createWorkspace } from '../workspace';

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
 * 「当前在哪儿干活」是**每时每刻都需要知道**的状态，不是一个月调一次的
 * 偏好 —— 放进设置页等于让人每次都得翻抽屉。同类工具也都把工作区上下文
 * 常驻在界面上（命令行横幅、IDE 的面板组），正是这个道理。
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
  /** 新建工作区 / 移除目录的结果提示。这个面板没有别的地方能说话 */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDetailsElement>(null);

  /**
   * A120：用户可以从「最近目录」里移除某一项（点右侧 ×）。
   *
   * A131：这条偏好改存服务端（`POST /api/recent-directories/dismiss`）。原先存
   * localStorage，而打包态每次启动都换一个系统分配的空闲端口 —— 端口即源，
   * 换源之后清单读不回来，用户看到的正是「点掉过，下次打开又全回来了」。
   * 列表本身已由服务端剔除忽略项，这里只留一个条数用来决定「全部恢复」出不出。
   */
  const [dismissed, setDismissed] = useState(0);

  const hasCwd = !!cwd;
  const label = hasCwd ? dirName(cwd!) : '默认目录';

  /** 拉一次最近目录。打开面板时拉、恢复之后也拉 —— 两处共用同一份口径 */
  const loadRecent = useCallback(async () => {
    try {
      const r = await fetch('/api/recent-directories');
      const j = (r.ok ? await r.json() : {}) as {
        directories?: string[];
        dismissedCount?: number;
      };
      setRecent(Array.isArray(j.directories) ? j.directories : []);
      setDismissed(typeof j.dismissedCount === 'number' ? j.dismissedCount : 0);
    } catch {
      // 拉不到不弹错：最近目录是便利功能，不是必需品。静默留空，
      // 「切换目录」这条路与它无关，照样能用。
      setRecent([]);
    }
    setRecentLoaded(true);
  }, []);

  const handleRemoveRecent = async (dir: string) => {
    // 先就地摘掉再发请求：× 点下去那一行就该消失，不该等一个网络往返。
    // 服务端同时按归一化路径记，所以 `C:\A` 与 `c:/a` 是一次忽略，不是两次。
    setRecent(prev => prev.filter(d => d !== dir));
    setDismissed(n => n + 1);
    setNotice('已忽略，下次打开也不会再出现');
    try {
      await fetch('/api/recent-directories/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
    } catch {
      setNotice('这次没存住，下次打开它可能还在');
    }
  };

  const handleRestoreAll = async () => {
    try {
      const r = await fetch('/api/recent-directories/restore', { method: 'POST' });
      const j = (r.ok ? await r.json() : {}) as { restored?: number };
      setNotice(j.restored ? `已恢复 ${j.restored} 个目录` : '没有需要恢复的目录');
    } catch {
      setNotice('恢复失败，目录仍被忽略');
    }
    await loadRecent();
  };

  // 最近目录：**打开时**才拉。徽标每次渲染都在，挂载就拉会让每个带会话的
  // 页面都多发一个用不上的请求；而「打开面板」正说明用户此刻想换目录。
  useEffect(() => {
    if (!open || recentLoaded) return;
    void loadRecent();
  }, [open, recentLoaded, loadRecent]);

  /**
   * 点面板以外的地方收起。
   *
   * ## 为什么监听 `pointerdown` 而不是 `click`（A118 反馈）
   *
   * 原话：「切换新工作区后，我点击输入框，工作区弹窗没有关闭」。
   *
   * 根因不在这个面板，在**输入框**：TDesign 的 `<t-chat-sender>` 是 shadow
   * DOM，它在内部把 `mousedown` / `click` 吃掉了 —— 实测点它的 textarea 时，
   * document 上只收到 `pointerdown` / `focusin` / `pointerup`，**没有 click、
   * 连 mousedown 都没有**（浏览器因为 mousedown 被 preventDefault 而不生成
   * click）。所以「点空白处关闭」在输入框这个最常点的地方完全失效，
   * 而点消息区、点列表栏都是好的 —— 这种「大部分地方正常」最容易漏测。
   *
   * `pointerdown` 能穿出 shadow（实测），而且它比 click 更早：按下即收，
   * 手感也更接近原生下拉。判断仍用 `contains`，点面板内部不受影响。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (el?.open && !el.contains(e.target as Node)) {
        el.open = false;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const handlePick = async () => {
    const picked = await pickDirectory();
    // null = 取消或不支持，两种都保持原值（不支持的说明写在面板里）
    if (!picked || picked === cwd) return;
    setNotice(null);
    onChange(picked);
  };

  /**
   * A86：新建工作区。
   *
   * 反馈「选错了目录没法回头，也没法开一个新的」—— 这里补的就是这两件。
   * 建目录落在主进程（见 `opc:create-workspace`），父目录必须用户亲手选；
   * 取消时什么都不做，**不**弹提示（取消是一次正常决定）。
   */
  const handleCreate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createWorkspace();
      if (!result) return;
      if (result.error) {
        setNotice(result.error);
        return;
      }
      if (result.path) {
        setNotice(`已新建：${dirName(result.path)}`);
        onChange(result.path);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * A86：移除工作目录（解绑，**不是删磁盘上的目录**）。
   *
   * 传空串走的是既有链路：`setSessionCwd(id, '')` → `PATCH cwd: null`。
   * 这条链路本来就在，只是没有入口 —— 用户选错目录之后只能再选一个对的，
   * 回不到「未绑定」。
   */
  const handleClear = () => {
    if (!hasCwd) return;
    setNotice('已移除绑定（磁盘上的目录没有动）');
    onChange('');
  };

  return (
    <details
      ref={rootRef}
      className="relative"
      data-workspace-badge
      onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      {/* A84（需求）：常态不再铺一块 `--tc-hover-chrome`。
          它是「当前工作目录」的状态徽标，不是一颗按下去会生效的按钮，
          常驻底色会让人误读成「这个已经开着」。现在只有**真的展开着**
          这个下拉时才给底色（选中回显态），其余时候靠 hover 浮现。 */}
      <summary
        className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg bg-transparent px-2 transition-colors hover:bg-[var(--tc-fill-hover)]"
        style={{
          /* A75 的教训：非展开态**不能**写 `backgroundColor: 'transparent'` ——
             内联样式优先级高于 Tailwind 的 hover:bg-[...]，会把上面那句悬停
             反馈整个压死（实测：鼠标划过一点都不变色）。只有展开时才写内联值。 */
          backgroundColor: open ? 'var(--tc-fill-selected)' : undefined,
          color: hasCwd ? 'var(--td-text-color-secondary)' : 'var(--td-text-color-placeholder)',
        }}
        title={hasCwd ? `工作目录：${cwd}` : '未指定工作目录，Agent 以后端进程目录为准'}
        aria-label="工作目录"
      >
        <FolderOpen size={14} />
        <span className="max-w-[160px] truncate text-secondary">{label}</span>
        <ChevronDown size={12} />
      </summary>

      {/* A86：这个面板会盖到右侧工作区上，而浏览器预览是**原生层、永远在
          DOM 之上**。不登记成浮层，下拉就会被一张网页糊住（点了没反应的
          经典形态）。`data-opc-overlay` 是浮层哨兵的约定标记。 */}
      <div
        className="tc-glass absolute right-0 top-full z-30 mt-1 w-[300px] overflow-hidden rounded-xl py-1 shadow-popup"
        data-workspace-panel
        data-opc-overlay
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
        {/* A86：新建工作区。只在有原生对话框的环境里出现 —— 浏览器开发态点了
            也没法建目录，摆出来就是假控件。 */}
        {hasNativeDialogs() && (
          <button
            type="button"
            onClick={() => void handleCreate()}
            className={MENU_ITEM_CLASS}
            style={{
              color: 'var(--td-text-color-primary)',
              opacity: busy ? 0.6 : 1,
              cursor: busy ? 'default' : 'pointer',
            }}
            disabled={busy}
            title="选一个位置，在里面新建一个空文件夹并绑定到当前会话"
            data-workspace-create
          >
            <FolderPlus size={14} />
            {busy ? '正在新建…' : '新建工作区'}
          </button>
        )}
        {/* A86：移除绑定。移除的是**会话与目录的关系**，不是磁盘上的文件。 */}
        <button
          type="button"
          onClick={handleClear}
          className={MENU_ITEM_CLASS}
          style={{
            color: 'var(--td-text-color-primary)',
            opacity: hasCwd ? 1 : 0.5,
            cursor: hasCwd ? 'pointer' : 'default',
          }}
          disabled={!hasCwd}
          title={hasCwd ? '解除这个会话与当前目录的绑定（不删除磁盘上的文件）' : '当前没有绑定目录'}
          data-workspace-clear
        >
          <X size={14} />
          移除工作目录
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

        {notice && (
          <p
            className="mx-3 my-1 text-caption"
            style={{ color: 'var(--td-text-color-secondary)' }}
            data-workspace-notice
          >
            {notice}
          </p>
        )}

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

        {/* 一条都没忽略过时不占位；但「只剩已忽略项」时这一节仍要出现，
            否则「全部恢复」没有出口，被点掉的目录就永久回不来了。 */}
        {(recent.length > 0 || dismissed > 0) && (
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
                    className={`${MENU_ITEM_CLASS} group`}
                    style={{
                      color: active ? 'var(--td-text-color-primary)' : 'var(--td-text-color-secondary)',
                      /* 选中回显态：这是「当前目录」那一行，允许有底色 */
                      backgroundColor: active ? 'var(--tc-fill-selected)' : undefined,
                    }}
                    title={dir}
                    data-workspace-recent
                  >
                    <Folder size={14} style={{ color: active ? 'var(--td-brand-color)' : undefined }} />
                    <span className="truncate">{dirName(dir)}</span>
                    <span
                      className="ml-auto truncate font-mono text-caption"
                      style={{ color: 'var(--td-text-color-placeholder)', maxWidth: 100 }}
                    >
                      {dir}
                    </span>
                    {!active && (
                      <span
                        className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--tc-hover-chrome)]"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                        onClick={e => {
                          e.stopPropagation();
                          void handleRemoveRecent(dir);
                        }}
                        title="从最近目录中移除"
                      >
                        <X size={12} />
                      </span>
                    )}
                  </button>
                );
            })}
            {dismissed > 0 && (
              <button
                type="button"
                onClick={() => void handleRestoreAll()}
                className={`${MENU_ITEM_CLASS} text-caption`}
                style={{ color: 'var(--td-text-color-placeholder)' }}
                title="把点过 × 的目录全部放回列表"
                data-workspace-restore
              >
                <RotateCcw size={12} />
                已忽略 {dismissed} 个 · 全部恢复
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
