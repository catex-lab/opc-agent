/**
 * 浮层菜单项的统一外形（A50）。
 *
 * ## 为什么要有这个文件
 *
 * 反馈：会话栏「+」菜单里悬停/选中的那一行是**直角**，把浮层的圆角啃掉
 * 了 —— 高亮块从圆角处溢出来，看起来像一块方角贴纸盖在圆角卡片上。
 *
 * 根因不是某一个菜单写错，而是「圆角只写在浮层容器上，菜单项各写一份
 * `w-full px-3 py-2`」：子元素铺满容器宽度，容器的圆角自然被它盖住。这个
 * 写法在 7 个浮层里各抄了一遍（会话栏「+」/ 通讯录「+」/ 聊天头部「⋯」/
 * 群头部「编排」/ 成员栏「邀请」/ 输入区「附件」/ 右键菜单）。
 *
 * ## 修法（两条，缺一不可）
 *
 * 1. 菜单项**自己带圆角**（`rounded-lg`）并左右各留 4px（`mx-1`）。几何上
 *    它就不可能溢出：容器 r=12、项 r=8、内缩 4px，项的四角严格落在容器的
 *    弧线内（项角圆心 (12,12)、半径 8；容器弧圆心 (12,12)、半径 12）。
 * 2. 浮层容器加 `overflow-hidden` 兜底：将来有人往里塞一个铺满宽度的子元素
 *    （分隔线、说明块），也会被容器裁成圆角，而不是捅出来。
 *
 * ## 两个坑
 *
 * - **不要再写 `w-full`**：`w-full` + `mx-1` = 宽度 100% 再加 8px，反而溢出。
 *   块级元素（`flex` / `block`）的 `width: auto` 本来就是「填满剩余宽度」，
 *   去掉 `w-full` 正好等于「容器宽 − 8px」。
 * - **内边距要减 4px**：`px-3` → `px-2`、`px-2.5` → `px-1.5`。这样「图标左缘
 *   到容器边」仍是原来的 12px / 10px，文字不会整体右移。
 *
 * ## ⚠️ A74 更正：上面「width:auto 就会填满」是错的
 *
 * 实测（Playwright 量面板与行宽）：`<button>` 即使 `display:flex`，`width:auto`
 * 也**按内容收缩**，不是填满容器。于是 168px 宽的「+」菜单里悬停高亮只有 90px
 * （贴着文字），右边空出 74px；184px 的附件菜单里高亮 136px，右边空 43px。
 * 用户看到的就是「鼠标滑过去只有文字被填充」。
 *
 * 修法：显式写 `calc(100% - 8px)` —— 8px 就是左右各 4px 的 `mx-1`。
 * 既填满整行，又不会像 `w-full` 那样溢出 8px 把容器圆角啃掉。
 * 三条常量都补上，改一处全部菜单生效（7 个浮层共用）。
 * ────────────────────────────────────────────────────────────────────── */

/**
 * 标准菜单项：一行「图标 + 文字」，行高 34px。
 * 用在 160 / 168 / 280 宽这类菜单（会话栏「+」、通讯录「+」、聊天头部「⋯」、
 * 群头部「编排」）。
 */
export const MENU_ITEM_CLASS =
  'mx-1 flex w-[calc(100%_-_8px)] items-center gap-2 rounded-lg px-2 py-2 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]';

/**
 * 紧凑菜单项：行高 30px，用在密集列表里
 * （输入区「附件」184 宽、成员栏「邀请」204 宽）。
 */
export const MENU_ITEM_SM_CLASS =
  'mx-1 flex w-[calc(100%_-_8px)] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]';

/**
 * 纯文字菜单项：没有图标，只有一行字，行高 34px
 * （聊天头部「Agent 详情 / 删除会话」）。
 */
export const MENU_ITEM_TEXT_CLASS =
  'mx-1 block w-[calc(100%_-_8px)] rounded-lg px-2 py-2 text-left text-body transition-colors hover:bg-[var(--tc-hover-chrome)]';

/**
 * 浮层容器的「裁切兜底」。与上面三条一起用 —— 单独加它只能把高亮裁成
 * 「贴着边的直角」，看起来仍是方的；单独给菜单项加圆角则挡不住将来新增的
 * 铺满宽度子元素。
 */
export const MENU_PANEL_CLIP = 'overflow-hidden';
