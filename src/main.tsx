import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { APP_CONFIG } from './config';
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

// 设置页面标题
document.title = APP_CONFIG.name;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
