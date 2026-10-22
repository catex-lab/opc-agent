/**
 * 会话栏（ConversationList）与通讯录栏（ContactsPanel）**共用**的栏头尺寸。
 *
 * ## 为什么要有这个文件
 *
 * 两栏是同一个位置上的两块内容，用户来回切换时，栏头必须像「同一根」——
 * 只要有一处不一样，切换就会有明显的跳动感。2026-10-20 用户反馈的原话是
 * 「切换时明显感觉到搜索框和加号的大小、位置、颜色不一致」。
 *
 * 当时的实际差异（实测量出来的，不是猜的）：
 *   · 搜索行内边距：会话栏 `py-2`、通讯录 `pt-3` → 搜索框顶边差 **4px**；
 *   · 加号图标：会话栏 17px、通讯录 16px → 切换时加号「胖了一圈」。
 *
 * 颜色（`--tc-surface-raised` / `--td-text-color-secondary`）本来就一致，
 * 不一致的是写死在两处的类名。所以这里只收拢「几何」这一份真源：
 * 两栏都从本文件取类名与图标尺寸，**不要再各写一份**。
 *
 * 注意：搜索胶囊在两个栏里都是 `flex-1`（占满除加号外的宽度），
 * 而两栏的宽度又都取 `--tc-sidebar-width`，所以宽度天然一致。
 */
export const SEARCH_PILL_CLASS = 'flex h-9 flex-1 items-center gap-2 rounded-full px-3';

/** 加号圆钮。颜色由调用方按状态内联（多选态要变品牌色），几何在这里统一 */
export const ROUND_ADD_CLASS =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors';
/** 搜索图标尺寸（lucide 的 size 属性） */
export const SEARCH_ICON_SIZE = 14;

/** 加号 / 关闭图标的尺寸。两栏必须同值，否则切栏时图标会「胖瘦跳一下」 */
export const ADD_ICON_SIZE = 17;

/** 搜索行的外框内边距：上 8 下 8，与另一栏的 `<header className="py-2">` 对齐 */
export const SEARCH_ROW_CLASS = 'flex items-center gap-2 px-3 py-2';
