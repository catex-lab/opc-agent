import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { APP_CONFIG } from './config';
import { ErrorBoundary } from './components/ErrorBoundary';
import 'tdesign-react/esm/style/index.js';
/**
 * chat 组件的样式必须在**首屏**就位，但只能引 CSS、不能引 JS 入口。
 *
 * 踩过的两个坑：
 *   1. 从 App.tsx 引 `@tdesign-react/chat/es/style/index.js` —— 那是副作用
 *      导入，Rollup 会转成对整个 vendor-chat chunk 的 import，首屏被迫
 *      加载 517 kB 的 chat 组件和 1.4 MB 的 cherry-markdown。
 *   2. 干脆把它挪进懒加载的 ChatPage —— 首屏是干净了，但这份 CSS 里带着
 *      TDesign 的 `:root` 变量定义，ChatPage 加载时**后注入**，反过来把
 *      我们在 index.css 里的品牌色/底色/语义色全盖掉了
 *      （verify:tokens 从 15/15 掉到 8/15 就是这么来的）。
 *
 * 所以：直接引 CSS 文件，放在 TDesign 之后、index.css 之前。
 * 这样既只多 17 kB 样式，又保证我们的覆盖仍然最后生效。
 */
import '@tdesign/web-components-chat/style/index.css';
import './index.css';
import { applyUiPrefs } from './uiPrefs';

// 设置页面标题
document.title = APP_CONFIG.name;

/**
 * 窗口级玻璃（应用本体透出桌面）。
 *
 * 材质由 Electron 主进程画在窗口**背后**（Windows 11 的 acrylic），
 * CSS 只负责把表面调成半透明。但浏览器开发态没有这层材质 —— body 一透明
 * 就露出浏览器自己的白底/黑底，看着像界面坏了。所以主进程确认材质可用时，
 * 才在加载地址上带 `?glass=1`，这里据此给 <html> 打标记；没有标记时
 * `index.css` 里的表面色**一个都不变**（打靶脚本断言的是实色）。
 */
if (new URLSearchParams(window.location.search).has('glass')) {
  document.documentElement.dataset.opcGlass = '1';
}

/**
 * 外观偏好（界面透明度 / 左侧栏宽度）必须在**首帧之前**写到 <html> 上，
 * 否则启动时会先按默认值画一遍再跳过去 —— 表现为「界面先实色一下」「列表栏
 * 先窄后宽」。所以放在 createRoot 之前，见 src/uiPrefs.ts。
 */
applyUiPrefs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/*
        A115（反馈）：「切换会话时选中的列表上下回跳、新会话内容屏闪」。

        ⚠️ `useTransitions={false}` 是这一条的**根因修复**，不要当无关紧要的
        参数删掉。React Router v7 的 BrowserRouter 默认把路由状态更新包在
        `React.startTransition` 里（见 node_modules/react-router 的
        `setState`：useTransitions !== false 时走 startTransition）。
        startTransition 是**低优先级**更新，于是 `navigate()` 之后：

          帧1（紧急）  currentSessionId = 新会话 ✓， 但路由 state 还是旧 URL
                       → App 的「从 URL 同步 sessionId」effect 发现
                         urlSessionId(旧) !== currentSessionId(新)
                       → setCurrentSessionId(旧)   ← 选中被弹回上一行
          帧2（过渡提交）路由 state = 新 URL, currentSessionId = 旧
                       → 同一个 effect 又把它推回新会话
          帧3          两边一致，才稳下来

        用户看到的就是「选中框在新旧两行之间来回跳」+ 消息区在
        「旧消息 / 骨架 / 新消息」之间连换三次（屏闪）。

        关掉 transition 后，路由 state 与 setCurrentSessionId 在同一个
        事件处理器里被 React 一起批处理，一帧到位，effect 不再有机会
        看到「URL 旧、state 新」的中间态。对这个应用来说路由本来就是
        本地状态的一面镜子，没有需要被 transition 降优先级的大页面切换。
      */}
      <BrowserRouter useTransitions={false}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
