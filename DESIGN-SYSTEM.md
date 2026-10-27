# DESIGN-SYSTEM.md — 设计系统唯一真源

> 建立于 2026-10-27（A133）。配套闸门：`npm run verify:uiux-tokens`。
>
> **使用规则只有一条**：改任何页面前先查这里。查得到就照抄类名，查不到就先回来加一条
> 并说明为什么现有档位不够 —— **不要就地新造一个值**。
> 用户提的要求原话是「避免每改一个页面就出现一套新的颜色、字号和控件样式」，
> 这份文档 + 那道闸门就是这句话的落地。

---

## 1. 颜色

### 1.1 表面（四档，按 ΔL\* 逐档推导，不要引入第五档）

| 令牌 | 浅色 | 深色 | 用在哪 |
|---|---|---|---|
| `--tc-surface-rail` | `#ececec` | `#232323` | 导航条（最外层框架） |
| `--tc-surface-chrome` | `#f5f5f5` | `#1b1b1b` | 列表栏、框架面 |
| `--tc-surface-content` | `#ffffff` | `#121212` | 主内容区、会话头部 |
| `--tc-surface-aside` | `#f7f7f5` | `#1c1d1f` | 右侧工作区（文件/浏览器/终端） |
| `--tc-surface-raised` | `#ffffff` | `#262626` | 浮在框架面上的控件 |

浅色方向：**越亮越靠后**。深色方向：**越亮越靠前**。两个主题不能共用一组数值。

### 1.2 文字（三级，只用这三档）

| 令牌 | 浅色 | 深色 | 用在哪 |
|---|---|---|---|
| `--td-text-color-primary` | `#171717` | `#fafafa` | 正文、标题、列表主文字 |
| `--td-text-color-secondary` | `#737373` | `#a3a3a3` | 辅助说明、时间、路径、预览 |
| `--td-text-color-placeholder` | `#a3a3a3` | `#737373` | 输入占位符（**只用于占位**） |
| `--td-text-color-disabled` | `#d4d4d4` | `#525252` | 禁用态 |

> ⚠️ `placeholder` 在白底上约 2.5:1，**不要**拿它当「次要文字」用。次要文字是
> `secondary`（4.7:1，达标）。这是本项目最容易犯的一处降级。

### 1.3 品牌与语义

| 令牌 | 浅色 | 深色 | 说明 |
|---|---|---|---|
| `--td-brand-color` | `#1f1f1f` | `#e5e5e5` | **石墨黑**，不是蓝。用户 2026-10-27 再次确认维持 |
| `--tc-on-brand` | `#ffffff` | `#171717` | 品牌底上的文字（必须反向配对） |
| `--td-success-color` | `#2ba471` | 同值 | 成功 / 在线 |
| `--td-warning-color` | `#ed7b2f` | 同值 | 待处理 / 需登录 |
| `--td-error-color` | `#e34d59` | 同值 | 错误 / 危险操作 |

`verify:tokens` 有一条**遍历性断言：全 DOM 不许出现任何蓝色渲染色**。换强调色要先过用户。

### 1.4 边线与填充（强度是算出来的，不要逐个调）

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--tc-edge` | `rgb(0 0 0/.045)` | `rgb(255 255 255/.055)` | 卡片/输入的「边界保险」，只在面与面同色时兜底 |
| `--tc-edge-strong` | `rgb(0 0 0/.07)` | `rgb(255 255 255/.085)` | 聚焦态、可交互卡片 hover |
| `--td-component-stroke` | `rgb(0 0 0/.07)` | `rgb(255 255 255/.085)` | 全部控件轮廓的唯一真值（30+ 处引用） |
| `--tc-rule` | `rgb(0 0 0/.18)` | `rgb(255 255 255/.2)` | 思考过程的左引用线 |
| `--tc-divider` | `transparent` | `transparent` | **板块分割线一律不画**（A25 用户要求） |
| `--tc-fill-hover` | `rgb(0 0 0/.06)` | `rgb(255 255 255/.07)` | 列表行 hover |
| `--tc-fill-selected` | `rgb(0 0 0/.12)` | `rgb(229 229 229/.12)` | 选中态（导航、列表、下拉共用一个） |
| `--tc-fill-pressed` | `rgb(0 0 0/.18)` | `rgb(255 255 255/.18)` | 瞬时按下（**只给按下用**） |
| `--tc-mask-soft` | `rgba(0,0,0,.34)` | 同值 | 模态弹窗遮罩（唯一一档） |

> `verify:surface` 规定：非品牌色的可见边线 alpha **必须 ≤ 0.21**。超了就是「第二套分割线」。

### 1.5 浮层底

| 令牌 | 用途 |
|---|---|
| `--tc-overlay-surface` | 应用内浮层底（含 `--opc-overlay-alpha`，下限 0.9） |
| `--tc-overlay-surface-strong` | 需要更实的一档 |
| `--tc-glass-bg` / `--tc-glass-border` | 玻璃三件套，配 `.tc-glass` / `.tc-dialog` |

`verify:overlay` 要求有效 alpha ≥ 0.88。**不要假设 `backdrop-filter` 生效**（A27 教训）。

---

## 2. 字号（8 档，不要新增第九档）

| 令牌 | 值 | Tailwind 类 | 旧别名 | 用在哪 |
|---|---|---|---|---|
| `--text-caption` | 11px | `text-caption` | — | 角标、极小的元信息 |
| `--text-secondary` | 12px | `text-secondary` | `text-xs` | 辅助说明、时间戳、路径 |
| `--text-body` | 13px | `text-body` | `text-sm` | 正文、列表项 |
| `--text-body-lg` | 14px | `text-body-lg` | `text-base` | 正文放大、按钮文字 |
| `--text-title` | 15px | `text-title` | `text-lg` | 区块小标题 |
| `--text-title-lg` | 16px | `text-title-lg` | — | 区块标题、窄栏页头 |
| `--text-page` | 17px | `text-page` | — | 页面标题（`PanelHeader` 主区） |
| `--text-display` | 22px | `text-display` | — | **仅**空态大标题（新对话页欢迎语） |

行高三档：`--leading-tight` 1.4（标题）· `--leading-normal` 1.5（正文）· `--leading-loose` 1.7（长文）。

**旧别名（`text-xs/sm/base/lg`）已全部重绑到令牌**，写它们不会出错，但新代码请用语义名。
`text-xl` 及以上**没有**接令牌（仍是 Tailwind 默认 20/24/30px），闸门会判红。

### 字重

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--tc-fw-body` | 400 | **350** |
| `--tc-fw-bold` | 700 | **600** |

深色降一档不是审美偏好，是 halation（亮字在黑底上发胖）的补偿，有实测断言。

---

## 3. 间距与圆角

**8pt 网格**：`--space-1` 4 / `--space-2` 8 / `--space-3` 12 / `--space-4` 16 / `--space-5` 20 / `--space-6` 24。

| 圆角令牌 | 值 | Tailwind | 用在哪 |
|---|---|---|---|
| `--td-radius-small` | 4px | `rounded-sm` | 小徽章、窗口图标 |
| `--td-radius-default` | 6px | `rounded` / `rounded-md` | 按钮、输入框 |
| `--td-radius-medium` | 8px | `rounded-lg` | 卡片（默认） |
| `--td-radius-large` | 12px | `rounded-xl` | 有内容厚度的卡片、弹窗 |
| `--td-radius-extraLarge` | 16px | `rounded-2xl` | 大弹窗 |

---

## 4. 控件清单（每个控件只有一个入口）

**这张表是「不要每页一套控件」的核心。** 要一个新控件样式，先在这里加一行。

| 控件 | 唯一入口 | 几何 / 状态 |
|---|---|---|
| 主按钮 | `.tc-btn-brand` | 高 32 / 横向内边距 15 / 字号 14，品牌色实心 + `--tc-on-brand` |
| 次按钮 | `.tc-btn-secondary` | 与主按钮同几何，只换底色 |
| 图标按钮 | `.tc-icon-btn` / `.tc-icon-btn--filled` | 方/圆小按钮，hover 走 `--tc-fill-hover` |
| 窗口按钮 | `.tc-caption-btn` | 标题栏最小化/最大化/关闭，`data-danger="1"` 走红 |
| 输入框 | `.tc-input` | 常态 `--tc-edge`，聚焦只加 `--tc-focus-shadow`，**不加粗不变色** |
| 卡片 | `.tc-card` / `.tc-card--lg` / `.tc-card--interactive` | 8 / 12px 圆角；交互靠「抬起来」不靠描色 |
| 列表行 | `.tc-list-item` + `.is-active` | hover `--tc-fill-hover`，选中 `--tc-fill-selected` |
| 模态弹窗 | `.tc-dialog` | 玻璃底 + 双 inset 线；遮罩配 `--tc-mask-soft` |
| 应用内浮层 | `.tc-glass` | 下拉、悬停名片、提示条 |
| 彩色图标块 | `.tc-tile` | 40×40，色由内联 `--tile` 传入 |
| 品牌标签 | `.tc-chip-brand` | 小胶囊标签 |
| 区块标题 | `.tc-section-title` | 设置页各分区标题 |
| 提示文字 | `.tc-hint` | 表单下方的说明 |
| 滑块 | `.tc-range` / `.tc-range--flat` | 透明度滑条（flat = 不画圆点） |
| 卡片栅格 | `.tc-cards` | 自适应展开 |
| 可滚动内容区 | `.tc-scroll-fade` + `useOverflowY` | 溢出时底边渐隐（`--tc-fade-h: 26px`），留白与渐隐同高 |

### 可滚动内容区硬规矩（A134）

**任何会被容器裁切的内容区，都必须给出「还有更多」的信号。** 理由不是审美：
Windows 的 Chrome 用 overlay 滚动条，**静止时完全不画**。用户看到的不是「可以
往下滚」，而是一行被硬切在字中间的文字 —— 读起来像渲染坏了。

- 挂 `.tc-scroll-fade` 类 + `data-fade={overflowing ? '1' : undefined}`，
  溢出判定用 `useOverflowY()`（ResizeObserver + MutationObserver 双观察，
  内容晚到 / 容器改高都算得出来）。
- **只在真的溢出时挂**。装得下时把最后一行淡掉，等于在没有更多的地方说
  「还有更多」，是另一种假话。
- `padding-bottom` 必须**引用同一个 `--tc-fade-h`**：滚到底时被淡掉的是这段
  留白，不是最后一张卡的内容。三处各写一个数字，改一处就不对齐。
- 用 `mask-image` 淡出，**不要**盖一层渐变 div —— 弹窗是半透明玻璃面
  （`--tc-glass-bg` + backdrop-filter），渐变层要跟它配平颜色，浅色/深色/
  玻璃态各是一套值，迟早对不上。mask 是把自己淡成透明，露出来是什么颜色
  它根本不需要知道。
- 现有使用者：获取 Agent 弹窗、轨迹面板（`.tc-trace-scroll`）。

### 「全局动作不要伪装成行级动作」（A134）

获取 Agent 清单页原来每张卡都有一颗「重新检测」+ 底栏一颗 = 一屏 5 颗按钮打
同一个 `POST /api/agents/probe`（全量重探）。它画在卡上会让人以为「只重测这
一条」，同时用第三颗同色按钮稀释掉「复制命令」的主次。

- 清单页（`InstallCard` 的 `bare` 形态）**不画**，动作收进常驻底栏（`shrink-0`，永远可见）。
- 资料页（非 bare，没有底栏）**必须画**。
- 判断入口只有一处：`const canReprobe = !!onReprobe && !bare;`。

### 按钮硬规矩（A124，用户拍板）

- **几何只在 `index.css` 一处定义**：`--tc-btn-height: 32px` / `--tc-btn-pad-x: 15px` / `--tc-btn-font: var(--text-body-lg)`。
- 站点**不许**再写 `px-*/py-*/text-*` 调按钮尺寸。要另一档就加语义令牌。
- 用户 2026-10-27 再次确认：**32 单档，不引入 36px 常规档**。
- 闸门 `verify:a124-button-spec`（21 项 × 亮暗两遍）钉住尺寸、图标居中、主次底色不同、对比度、无蓝色、关闭键落点。

### 弹窗硬规矩

- 模态弹窗**固定在窗口内、不许拖拽**（A130 用户拍板）。全应用只有一个 `BrowserWindow`，
  浮层是页面内的 `absolute inset-0`，本来也出不了视口。
- 关闭键统一落点：**距顶 12 / 距右 16**。
- 非模态常驻浮层（如 A132 的权限审批 Dock）落右下角、同样不可拖拽 —— A130 的豁免只覆盖这一类。

---

## 5. 状态（每个交互组件按需支持，不要全都画）

| 状态 | 表达方式 |
|---|---|
| 默认 | 令牌原值 |
| 悬停 | `--tc-fill-hover`（框架面）/ `--tc-layer-3`（卡片） |
| 按下 | `--tc-fill-pressed`（**唯一使用者**） |
| 选中 | `--tc-fill-selected` + 可选 3px 品牌色竖条 |
| 键盘焦点 | `:focus-visible` 轮廓；输入框走 `--tc-focus-shadow` |
| 禁用 | `--td-text-color-disabled` + `--td-bg-color-component-disabled`，**不降透明度** |
| 加载 | 骨架 / 转圈，不要用「假装有内容」的占位 |

> 写 UI 断言时：**先读 `el.disabled` 分状态再判对比度**。禁用态本就该发虚，
> 混进去只会逼人把阈值调松（A124 教训）。

---

## 6. 禁止写法（`verify:uiux-tokens` 会红）

| 禁止 | 改成 |
|---|---|
| `text-[13.5px]` | 8 档里的语义类 |
| `text-xl` / `text-2xl` / `text-3xl`… | `text-page`(17) 或 `text-display`(22) |
| `bg-[#3a3a3a]` / `text-[#fff]` / `border-[#000]` | `var(--tc-*)` / `var(--td-*)` |
| `fontSize: 12`（内联裸数字） | `fontSize: 'var(--text-secondary)'` |
| 内联 `backgroundColor` 盖 `.tc-glass` | 删掉内联，让类决定（`ContactsPanel` 踩过） |
| 板块之间的分割线 | 不画（`--tc-divider` 是 transparent） |

**白名单**（值必须是数字的场景，文件级放行）：`AgentAvatar` / `UserAvatar`（字号按头像直径算）、
`WorkspaceTerminal`（xterm 的 `fontSize` 只吃 number）。

---

## 7. 改令牌的流程

1. 先确认现有 8 档 / 4 档真的不够，写清为什么；
2. 改 `index.css` 的定义（浅色 + 深色**两处**）；
3. 若新增档位，同步改 `tailwind.config.js` 与 `scripts/verify-uiux-tokens.mjs` 的 `EXPECTED`；
4. 跑 `npm run verify:uiux-tokens`（会断言令牌值与映射关系）；
5. 跑受影响的设计闸门：`verify:tokens` / `verify:surface` / `verify:overlay` / `verify:a124-button-spec`；
6. 玻璃态（`html[data-opc-glass='1']`）若涉及表面色，**四处必须一起换**，漏一处那块就成唯一的不透明块。

---

## 8. 已知的既有不一致（逐页实施时顺手处理）

| 位置 | 现象 | 优先级 | 状态 |
|---|---|---|---|
| 通讯录列表 | 3 个 Agent 只有绿点无文字，Gemini 有「未登录」橙字 | P0 | ✅ A134 已修 |
| 获取 Agent 弹窗 | ~~三个按钮样式完全相同，无主次~~ | P1 | ✅ **A134 更正：不成立**。从 A71 起就是 brand 实心 / secondary 描边两档，报告误读了「已复制」态的小截图。真正的毛病是「同一个全局动作一屏出现 5 次」，已按「全局动作不伪装成行级动作」处理 |
| 获取 Agent 弹窗 | ~~第 4 组卡片被弹窗底边裁掉一半~~ | P1 | ✅ A134 已修。实测被切的是**分组标题**（露 16.73/34px），根因是内容溢出却无「还有更多」信号；改为溢出时底边渐隐 |
| 设置弹窗 | 右侧约 150px 纯空白；无「已保存」反馈 | P1 | 待办 |
| 会话列表选中态 | 3px 近黑竖条 + 极淡底，用户文档建议避免「过强黑色边条」 | P2 | 待办 |
| 图标 | lucide 37 文件 / tdesign-icons 9 文件 / 自绘 4 组件，三套并存 | P1 | 待办 |
| 主题偏好 | 存 localStorage，打包态换端口会丢（A131 实测） | P0 | 待办 |

> 逐页实施的顺序与理由见 `UIUX-AUDIT.md` §6。
