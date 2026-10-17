import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  },
  build: {
    /**
     * 原先全站打成单 chunk，产物 3.9 MB。
     *
     * 三个实际问题：
     *   1. V8 解析一个 3.9 MB 的脚本是几百毫秒的阻塞，首屏白屏时间被拉长；
     *   2. 改一行业务代码，整个 vendor 的 hash 就变，缓存全部失效；
     *   3. Rollup 每次构建都警告 chunk > 500 kB。
     *
     * 真正的解法不是「把 vendor 切碎」，而是**让首屏不需要的东西别进首屏**：
     * 消息渲染链（chat 组件 + cherry-markdown + mermaid + katex）约 2 MB，
     * 只在真的看消息时才用得到。配合 App.tsx 里对 ChatPage 的懒加载，
     * 这部分才被真正推迟。
     *
     * 注意：打包态 Electron 是通过 `http://127.0.0.1:<port>` 托管 dist 的
     * （见 electron/main.ts），不是 file:// —— 所以多 chunk 的 ES module
     * 加载不会被 CORS 拦。这一点是分包能成立的前提，别改成 loadFile。
     */
    rollupOptions: {
      output: {
        /**
         * 只把 React 运行时单独拆出来，其余全部交给 Rollup 自动决定。
         *
         * 为什么不再硬分 vendor-tdesign / vendor-chat / vendor-misc：
         * 试过按库名硬分，结果 `vendor-chat` 与 `vendor-misc` **互相 import**
         * （tdesign 的 web-components 系和 chat 系共享 babel runtime / lodash
         * 等模块），Rollup 明确警告 `Circular chunk`。循环一旦形成，两个
         * chunk 只能一起加载 —— 分包不但没省流量，反而把本可懒加载的
         * cherry-markdown（1.4 MB）也钉死在首屏。
         *
         * 自动拆分的优势正在这里：它知道哪些模块是共享的、哪些是某个
         * 动态 import 独占的，会自己算归属，不会造出环。
         *
         * React 单独拆是安全的 —— 它是依赖树的叶子，只被引用、不引用别人。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const p = id.replace(/\\/g, '/');
          if (
            p.includes('/react-dom/') ||
            p.includes('/react/') ||
            p.includes('/scheduler/') ||
            p.includes('react-router')
          ) {
            return 'vendor-react';
          }
          return undefined;
        }
      }
    },
    // 单个 vendor 仍在 500 kB 量级是合理的（tdesign 本身就大），
    // 把阈值提到 700 kB，避免真出问题时被噪音淹没
    chunkSizeWarningLimit: 700
  }
});
