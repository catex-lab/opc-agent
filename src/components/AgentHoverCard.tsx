import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IdCard, Info } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { useAgentRemarks } from '../agentRemarks';
import {
  AVAILABILITY_META,
  CAPABILITY_META,
  availabilityLabelOf,
  type RegisteredAgent,
} from '../types';

/**
 * 头像悬停名片：鼠标移到头像上，就地弹出这个 Agent 的资料卡。
 *
 * ## 为什么要做
 *
 * 通讯录行按 A15 精简成「头像 + 名字」之后，厂商、能力、版本、接入方式
 * 全被收进了二级资料页。这让列表更干净，但「这个 Agent 到底是什么」变成了
 * 一次跳转的成本 —— 而用户扫列表时经常只是想确认一下，不想离开当前页。
 * 悬停名片正好补这个空档：**看一眼就够的信息不该要求点击**。
 *
 * ## 几个必须处理好的细节
 *
 * 1. **延迟出现**（240ms）。鼠标划过列表是常事，立刻弹卡会让整屏乱闪。
 * 2. **移入卡片不消失**。卡片里有「查看资料」按钮，鼠标从头像移到按钮上
 *    的途中会离开锚点 —— 所以要留 160ms 的宽限期，并在卡片上重新接管 hover。
 * 3. **视口翻转**。默认出现在头像右侧；右边放不下就翻到左侧，上下越界就贴边。
 *    卡片高度取决于内容（说明文字长短不一），所以先渲染再量、量完纠正，
 *    用 layout effect 保证在绘制前完成，用户看不到「先弹歪再跳回来」。
 * 4. **滚动即关**。滚动后卡片与头像会错位，重新定位不如直接收起 —— 用户
 *    一动滚轮，注意力本来就已经不在这一行上了。
 *
 * 卡片挂在 body 上（portal）：列表容器有 `overflow-y-auto`，留在里面会被裁掉。
 */

const CARD_WIDTH = 300;
const SHOW_DELAY = 240;
const HIDE_DELAY = 160;
const EDGE = 8;

const KIND_LABEL: Record<RegisteredAgent['kind'], string> = {
  sdk: 'CodeBuddy SDK',
  cli: 'CLI 子进程',
  acp: 'ACP 协议',
  // http 一直是漏的（AgentKind 联合里没它，所以类型检查从不报）。
  // 后果是豆包 / Kimi 开放平台的名片上「接入方式」那一行是空的 ——
  // 而它们恰好是最需要说清「没有本地进程、只是一次 HTTP 调用」的两条。
  http: 'HTTP 直连',
  mock: '模拟通道',
};

interface AgentHoverCardProps {
  agent: RegisteredAgent;
  /** 传入才显示「查看资料」按钮 */
  onViewDetail?: () => void;
  /** 触发区（通常是头像） */
  children: ReactNode;
}

export function AgentHoverCard({ agent, onViewDetail, children }: AgentHoverCardProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 备注（本地别名）：标题显示备注，原名补一行，见下方渲染处的说明 */
  const remarks = useAgentRemarks();
  const remark = remarks[agent.id] ?? '';

  const clearTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const scheduleHide = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY);
  }, []);

  const scheduleShow = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (open) return;
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 先给一个「右侧偏上」的粗位置，精确位置等渲染后由 layout effect 纠正
      setPos({ left: r.right + 12, top: r.top - EDGE });
      setOpen(true);
    }, SHOW_DELAY);
  }, [open]);

  // 渲染后按真实尺寸纠正位置（视口翻转）
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;

    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();

    let left = a.right + 12;
    if (left + c.width > window.innerWidth - EDGE) left = a.left - c.width - 12;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - c.width - EDGE));

    let top = a.top - EDGE;
    top = Math.max(EDGE, Math.min(top, window.innerHeight - c.height - EDGE));

    setPos({ left, top });
  }, [open]);

  // 滚动 / 改窗口尺寸 / Esc：收起
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 卸载时清掉计时器，避免「组件没了还 setState」
  useEffect(() => clearTimers, []);

  const meta = AVAILABILITY_META[agent.status.availability];

  return (
    <span
      ref={anchorRef}
      className="inline-flex shrink-0"
      onMouseEnter={scheduleShow}
      onMouseLeave={scheduleHide}
      // 键盘用户：聚焦到触发区也能看卡片（Tab 到行内按钮时触发）
      onFocus={scheduleShow}
      onBlur={scheduleHide}
      /**
       * 右键时立刻收起名片。
       *
       * 列表行的右键菜单就挂在这一行上，而名片是「悬停」触发的 ——
       * 右键点头像时两者会同时出现，看上去像**弹了两个窗**（实测：
       * `[role=menu]` 1 个 + `[role=tooltip]` 1 个，名片正好盖住菜单）。
       *
       * 这里**不能** `stopPropagation`：行上的 contextmenu 还要靠冒泡
       * 打开菜单，拦下来就变成「右键没反应」。
       */
      onContextMenu={() => {
        clearTimers();
        setOpen(false);
      }}
    >
      {children}

      {open &&
        createPortal(
          <div
            ref={cardRef}
            role="tooltip"
            aria-label={`${agent.name} 的资料卡`}
            className="tc-glass tc-pop-in fixed z-50 rounded-xl p-4"
            style={{
              width: CARD_WIDTH,
              left: pos.left,
              top: pos.top,
            }}
            onMouseEnter={scheduleShow}
            onMouseLeave={scheduleHide}
          >
            {/* 卡头：大头像 + 名字 + 在线状态 */}
            <div className="flex items-start gap-3">
              <AgentAvatar
                id={agent.id}
                name={agent.name}
                icon={agent.icon}
                color={agent.color}
                size={56}
                availability={agent.status.availability}
              />
              <div className="min-w-0 flex-1 pt-0.5">
                <div
                  className="truncate text-title font-semibold"
                  style={{ color: 'var(--td-text-color-primary)' }}
                >
                  {remark || agent.name}
                </div>
                {/* 有备注时把原名补在后面：名片是「确认这是谁」的地方，
                    只显示备注会让用户想不起它本来的名字（通讯录里按原名找）。 */}
                {remark && (
                  <div
                    className="mt-0.5 truncate text-caption"
                    style={{ color: 'var(--td-text-color-placeholder)' }}
                  >
                    原名 {agent.name}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.dot }}
                  />
                  <span className="text-secondary" style={{ color: meta.color }}>
                    {availabilityLabelOf(agent)}
                  </span>
                  {agent.status.version && (
                    <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      v{agent.status.version}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {[agent.vendor, KIND_LABEL[agent.kind]].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>

            {/* 擅长领域 */}
            {agent.capabilities.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  擅长
                </span>
                {agent.capabilities.map(cap => {
                  const cm = CAPABILITY_META[cap];
                  if (!cm) return null;
                  return (
                    <span
                      key={cap}
                      className="rounded px-1.5 py-[1px] text-caption"
                      style={{ backgroundColor: `${cm.color}14`, color: cm.color }}
                    >
                      {cm.label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* 说明：最多 3 行，长描述不撑爆卡片 */}
            {agent.description && (
              <p
                className="mt-2.5 text-secondary"
                style={{
                  color: 'var(--td-text-color-secondary)',
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {agent.description}
              </p>
            )}

            {/* 非在线状态才显示原因 —— 在线时再写一句「握手成功」是噪音 */}
            {agent.status.availability !== 'ready' && agent.status.message && (
              <p className="mt-2 flex items-start gap-1 text-caption" style={{ color: meta.color }}>
                <Info size={12} className="mt-[2px] shrink-0" />
                <span className="min-w-0">{agent.status.message}</span>
              </p>
            )}

            {onViewDetail && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onViewDetail();
                }}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-secondary font-medium transition-colors"
                style={{
                  backgroundColor: 'var(--td-brand-color-light)',
                  color: 'var(--td-brand-color)',
                }}
              >
                <IdCard size={13} />
                查看资料
              </button>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}
