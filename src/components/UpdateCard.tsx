/**
 * 设置 → 关于与隐私 → 更新。
 *
 * ## 状态机就是界面的全部
 *
 * 渲染层不做任何版本/哈希判断，只把主进程给的 `phase` 画出来：
 *   idle → checking → latest / available → downloading → ready / error
 * 这里的每个分支都与 `electron/updater/index.ts` 的 `UpdateState` 一一对应；
 * 多写一个「看起来在下载」的本地状态，就会和主进程的真实状态分叉。
 *
 * ## 文案约定
 *
 * - **风险类常驻**：只替换代码层、不碰 data/、校验失败就不装 —— 这些是
 *   用户必须事先知道的后果，不塞进提示浮层。
 * - **口径类收起**：为什么不做安装包更新，是解释而不是风险，放 InfoHint。
 *
 * 浏览器开发态没有 preload 桥，整块降级成「仅在桌面版可用」，
 * 不渲染任何假状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Download, RefreshCw, RotateCcw, X } from 'lucide-react';
import type { UpdateState } from '../../shared/update';
import { UPDATE_RELEASES_PAGE } from '../../shared/update';
import { InfoHint } from './InfoHint';
import { parseUpdateNotes, type NotesInline } from '../utils/updateNotes';

/** 行内片段：加粗 / 行内代码 / 纯文本 —— 只生成元素，不拼 HTML */
function renderInlines(inlines: NotesInline[]): ReactNode[] {
  return inlines.map((t, i) => {
    if (t.kind === 'bold') return <strong key={i}>{t.text}</strong>;
    if (t.kind === 'code') return <code key={i}>{t.text}</code>;
    return <span key={i}>{t.text}</span>;
  });
}

/**
 * Release 说明渲染：Markdown 按标题 / 列表 / 段落分块，行内处理加粗与代码。
 * 之前直接 `pre-wrap` 输出原文，用户看到的是 `## 修复`、`\*\*加粗\*\*`。
 */
function UpdateNotes({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseUpdateNotes(markdown), [markdown]);
  return (
    <div className="tc-update-notes" data-update-notes>
      {blocks.map((block, i) => {
        const children = renderInlines(block.inlines);
        if (block.kind === 'heading') {
          const level = Math.min(block.level, 3);
          return (
            <p key={i} className={`tc-update-notes-h tc-update-notes-h${level}`}>
              {children}
            </p>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <p key={i} className="tc-update-notes-li">
              {children}
            </p>
          );
        }
        return (
          <p key={i} className="tc-update-notes-p">
            {children}
          </p>
        );
      })}
    </div>
  );
}

/**
 * 更新内容弹层。
 *
 * 2026-11-04（用户确认）：Release 说明默认**不再铺在更新区**——它曾经能占
 * 大半屏，把版本与更新动作挤到一边。现在收进「查看更新内容」入口，点开
 * 才是约 480px 宽的滚动弹层。关闭口径与 InfoHint/设置弹层一致：
 * portal 到 body、Esc 关闭、点外关闭、打开时焦点进弹层、关闭后还原到触发器。
 */
function UpdateNotesDialog({
  markdown,
  onClose,
}: {
  markdown: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 捕获阶段拦下：设置弹层也监听 Esc，不拦住会连设置一起关掉。
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // 只读弹层只有一个可聚焦控件，Tab 不把焦点漏到背景。
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="tc-update-notes-scrim"
      data-update-notes-overlay
      onMouseDown={e => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="更新内容"
        className="tc-update-notes-dialog"
        data-update-notes-dialog
      >
        <div className="tc-update-notes-dialog-head">
          <span className="tc-update-notes-dialog-title">更新内容</span>
          <button
            ref={closeRef}
            type="button"
            className="tc-update-notes-close"
            aria-label="关闭更新内容"
            onClick={onClose}
            data-update-notes-close
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
        <UpdateNotes markdown={markdown} />
      </div>
    </div>,
    document.body,
  );
}

interface UpdateBridge {
  update?: {
    getState: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    download: () => Promise<UpdateState>;
    quitAndInstall: () => Promise<{ ok: boolean; error?: string }>;
    dismiss: () => Promise<UpdateState>;
    onStateChange: (cb: (state: UpdateState) => void) => () => void;
  };
}

function bridge(): UpdateBridge | undefined {
  return (window as unknown as { opc?: UpdateBridge }).opc;
}

const INITIAL: UpdateState = {
  phase: 'idle',
  currentVersion: '—',
  supported: false,
};

/** 体积按 MB 显示；小于 0.1MB 时保留一位小数，避免显示成 0 MB */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function UpdateCard() {
  const api = useMemo(() => bridge()?.update, []);
  const [state, setState] = useState<UpdateState>(INITIAL);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 「查看更新内容」弹层：默认关闭，说明正文因此不占版面 */
  const [notesOpen, setNotesOpen] = useState(false);
  const closeNotes = useCallback(() => setNotesOpen(false), []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api
      .getState()
      .then(s => {
        if (alive && s) setState(s);
      })
      .catch(() => undefined);
    const off = api.onStateChange(s => {
      if (alive && s) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const check = () => {
    if (!api) return;
    void run(() => api.check());
  };

  const download = () => {
    if (!api) return;
    void run(() => api.download());
  };

  const install = () => {
    if (!api) return;
    void run(async () => {
      const r = await api.quitAndInstall();
      if (!r?.ok) setActionError(r?.error ?? '无法开始安装');
    });
  };

  /** 只对交接类错误出现：清掉提示与状态文件，用户自己确认「我知道了」 */
  const dismiss = () => {
    if (!api) return;
    void run(() => api.dismiss());
  };

  const { phase, release, progress, error } = state;
  const checking = phase === 'checking';
  const downloading = phase === 'downloading';

  return (
    <div className="tc-about-zone" data-update-section>
      <div className="tc-about-eyebrow">
        <RefreshCw />
        更新
        <InfoHint
          label="更新方式说明"
          text="本项目没有代码签名证书，NSIS 安装包每次都会触发 UAC / SmartScreen 警告。所以常规更新只替换代码层 resources/app.asar；只有 Electron 运行时也变了，才会提示下载完整安装包。"
        />
      </div>

      <div className="tc-update-head">
        <div className="tc-update-version">
          <span className="tc-update-label">当前版本</span>
          <span className="tc-about-ver">v{state.currentVersion}</span>
          {state.checkedAt && phase !== 'checking' ? (
            <span className="tc-update-checked">上次检查 {formatTime(state.checkedAt)}</span>
          ) : null}
        </div>

        {state.supported ? (
          <div className="tc-update-actions">
            {phase === 'ready' ? (
              <button type="button" className="tc-btn-brand" onClick={install} disabled={busy}>
                <RotateCcw size={14} />
                退出并重启
              </button>
            ) : phase === 'available' && release && !release.requiresFull ? (
              <button type="button" className="tc-btn-brand" onClick={download}>
                <Download size={14} />
                下载更新
              </button>
            ) : (
              <button
                type="button"
                className="tc-btn-secondary"
                onClick={check}
                disabled={checking || downloading}
                data-update-check
              >
                <RefreshCw size={14} className={checking ? 'tc-update-spin' : undefined} />
                {checking ? '检查中…' : '检查更新'}
              </button>
            )}
          </div>
        ) : null}
      </div>

      {!state.supported ? (
        <p className="tc-update-note">应用内更新只在安装后的桌面版可用；当前是浏览器开发态。</p>
      ) : (
        <>
          <div className="tc-update-status" data-update-phase={phase}>
            {phase === 'idle' && <span className="tc-update-text">尚未检查更新</span>}

            {checking && (
              <span className="tc-update-text tc-update-text--busy">
                <RefreshCw className="tc-update-spin" size={14} />
                正在检查更新…
              </span>
            )}

            {phase === 'latest' && (
              <span className="tc-update-text">
                <Check size={14} />
                已是最新版本
              </span>
            )}

            {phase === 'available' && release && (
              <div className="tc-update-available">
                <div className="tc-update-text">
                  <Download size={14} />
                  发现新版本 <b>v{release.version}</b>
                  <span className="tc-update-dim">
                    {release.requiresFull
                      ? `完整包 ${formatSize(release.fullSize)}`
                      : `代码层 ${formatSize(release.size)}`}
                  </span>
                </div>
                {release.notes ? (
                  <button
                    type="button"
                    className="tc-update-notes-toggle"
                    onClick={() => setNotesOpen(true)}
                    data-update-notes-toggle
                  >
                    查看更新内容
                  </button>
                ) : null}
                {release.requiresFull ? (
                  <div className="tc-update-incompatible">
                    <p className="tc-update-note">
                      本机 Electron 运行时与发布版本不一致，不能只替换代码层。请下载完整包覆盖安装；
                      你的 data/ 与设置会保留。
                    </p>
                    <a
                      href={release.fullUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="tc-btn-secondary"
                      data-update-full-link
                    >
                      <Download size={14} />
                      下载完整包
                    </a>
                  </div>
                ) : null}
              </div>
            )}

            {downloading && (
              <div className="tc-update-progress" data-update-progress>
                <div className="tc-update-text">
                  <Download size={14} />
                  正在下载 {`${progress?.percent ?? 0}%`}
                  <span className="tc-update-dim">
                    {formatSize(progress?.received ?? 0)} / {formatSize(progress?.total ?? 0)}
                  </span>
                </div>
                <div className="tc-update-bar">
                  <span style={{ width: `${progress?.percent ?? 0}%` }} />
                </div>
              </div>
            )}

            {phase === 'ready' && (
              <div className="tc-update-ready">
                <span className="tc-update-text">
                  <RotateCcw size={14} />
                  v{state.stagedVersion ?? release?.version ?? ''} 已下载，重启后生效
                </span>
                <p className="tc-update-note">
                  退出时会替换 resources/app.asar；新版本若启动失败，会自动恢复旧版本。
                </p>
              </div>
            )}

            {/* 有错误就画出来，不跟着 phase 走：上一次交接失败的提示要在
                「发现新版本」旁边常驻，直到用户重试成功或点「忽略」。 */}
            {error && (
              state.legacyManualUpdate ? (
                // 旧版客户端内置旧公钥，验签必然失败 —— 这不是网络问题，
                // 也不该让它伪装成普通错误。只给一句结论 + 一个动作。
                <div className="tc-update-error" data-update-error data-update-legacy>
                  <span className="tc-update-text">
                    <AlertCircle size={14} />
                    此版本需手动更新一次
                  </span>
                  <a
                    href={error.manualUrl || UPDATE_RELEASES_PAGE}
                    target="_blank"
                    rel="noreferrer"
                    className="tc-update-link"
                    data-update-legacy-link
                  >
                    下载完整安装包
                  </a>
                </div>
              ) : (
                <div className="tc-update-error" data-update-error>
                  <span className="tc-update-text">
                    <AlertCircle size={14} />
                    {error.message}
                  </span>
                  <a
                    href={error.manualUrl || UPDATE_RELEASES_PAGE}
                    target="_blank"
                    rel="noreferrer"
                    className="tc-update-link"
                    data-update-manual-link
                  >
                    手动下载
                  </a>
                  {error.code === 'apply-failed' || error.code === 'rollback' ? (
                    <button
                      type="button"
                      className="tc-update-link tc-update-dismiss"
                      onClick={dismiss}
                      disabled={busy}
                      data-update-dismiss
                    >
                      忽略
                    </button>
                  ) : null}
                </div>
              )
            )}
          </div>

          {actionError ? <p className="tc-update-note tc-update-note--error">{actionError}</p> : null}

          {/* 风险常驻：这些后果不该藏在浮层里 */}
          <p className="tc-update-note tc-update-risk">
            更新只替换代码层的 <code>app.asar</code>，不会触碰 data/ 里的会话、图片与设置。
            清单验签、sha512 与体积校验任何一项不通过都会拒绝安装。
          </p>
        </>
      )}

      {/* 说明正文只在弹层里出现；portal 到 body，不参与这块的版式 */}
      {notesOpen && release?.notes ? (
        <UpdateNotesDialog markdown={release.notes} onClose={closeNotes} />
      ) : null}
    </div>
  );
}

export default UpdateCard;
