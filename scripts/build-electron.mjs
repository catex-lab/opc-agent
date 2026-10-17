/**
 * Electron 侧构建：把「主进程 + 整个 Express 服务端」打成一个 CJS 文件。
 *
 * 为什么用 esbuild 而不是 tsc：
 *   服务端是 ESM（`import './env.js'` 这种带扩展名的相对导入），而 Electron
 *   入口用 CJS 最省心（`"type": "module"` 的包里有 `.cjs` 就一定是 CJS）。
 *   esbuild 顺手把 `server/**` 一起内联，产出单文件，省掉一堆相对路径问题。
 *
 * `packages: 'external'` 是关键：所有裸模块（express / uuid /
 * @tencent-ai/agent-sdk …）保持运行时 require，由 electron-builder 随
 * `node_modules` 一起分发。**不能**把它们打进 bundle ——
 * `@tencent-ai/agent-sdk` 要用 `path.resolve(__dirname, '../../cli/bin/codebuddy')`
 * 定位自己包内的 CLI，一旦被打包，那个相对路径就指向不存在的地方了。
 */

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT_DIR = 'dist-electron';

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await build({
  entryPoints: ['electron/main.ts'],
  outfile: `${OUT_DIR}/main.cjs`,
  bundle: true,
  platform: 'node',
  // Electron 44 内置 Node 24.21，这里取 node22 更保守，兼容更低版本 Electron
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

// 入口本身保持手写：它必须在任何模块初始化之前设好环境变量（详见文件头注释），
// 所以不能参与打包，直接原样拷过去。
await cp('electron/bootstrap.cjs', `${OUT_DIR}/bootstrap.cjs`);

// preload 同样保持手写：它跑在沙箱化的渲染进程里，只做 IPC 转发。
// 不拷的话 BrowserWindow 的 `preload` 路径会指向 asar 内不存在的文件，
// Electron 直接拒绝创建窗口（报 "Unable to load preload script"），
// 而且是**启动即崩**，不会静默降级。
await cp('electron/preload.cjs', `${OUT_DIR}/preload.cjs`);

/**
 * 窗口图标要拷一份到 dist-electron/。
 *
 * 不能直接从 build/icon.png 读：`build/` 是 electron-builder 的 buildResources
 * 目录，它**只用于构建期**（生成 exe 图标、安装包图标），不会被复制进 app.asar。
 * 主进程在打包态去读 app.asar/build/icon.png 会拿到不存在的路径，
 * BrowserWindow 的 icon 静默失效（不报错，只是回退成默认图标）。
 *
 * dist-electron/** 是被打进 asar 的，放在这里两种形态都能读到同一个相对路径。
 */
try {
  await cp('build/icon.png', `${OUT_DIR}/icon.png`);
} catch {
  console.warn('⚠ 未找到 build/icon.png，跳过窗口图标（先运行 scripts/make-icons.py）');
}

console.log(`✓ ${OUT_DIR}/main.cjs + bootstrap.cjs + preload.cjs 构建完成`);
