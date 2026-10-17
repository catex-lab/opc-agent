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

console.log(`✓ ${OUT_DIR}/main.cjs + bootstrap.cjs 构建完成`);
