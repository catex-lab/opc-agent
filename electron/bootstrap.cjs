/**
 * Electron 入口（应用真正的 `main`）。
 *
 * 存在的唯一理由：**保证环境变量早于所有业务模块求值**。
 *
 * `server/db.ts` 在模块顶层就打开 SQLite 并读取 `OPC_DATA_DIR`，
 * 而 esbuild 把 `server/**` 静态打进 `main.cjs` 后，那些 `require` 排在
 * `main.cjs` 自身代码之前。也就是说，写在 `main.ts` 顶部的 `process.env.xxx = ...`
 * 是**来不及**的 —— 等它执行时数据库已经开在错误的位置了。
 *
 * 本文件是 `require` 链条的最外层，因此这里的赋值天然早于一切模块初始化。
 * 它必须保持 CJS（Electron 的入口解析对 `.cjs` 最省心），且**保持极简**：
 * 只做环境准备，不做任何业务逻辑。
 */
const electron = require('electron');

// 防呆：如果进程带着 `ELECTRON_RUN_AS_NODE=1` 启动，Electron 会退化成纯 Node，
// 此时 `require('electron')` 返回的是**二进制路径字符串**而不是 API 对象，
// 后面会炸出 `Cannot read properties of undefined (reading 'getPath')`，
// 完全看不出根因。这里提前给出可操作的提示。
// （本机的工具链环境确实会带这个变量，实测踩到过。）
if (typeof electron === 'string' || !electron.app) {
  console.error(
    '[Bootstrap] 检测到 ELECTRON_RUN_AS_NODE —— 当前进程不是真正的 Electron 主进程。\n' +
      '            请先清掉该环境变量再启动，例如：\n' +
      '              PowerShell:  $env:ELECTRON_RUN_AS_NODE=$null; npx electron .\n' +
      '              bash:        env -u ELECTRON_RUN_AS_NODE npx electron .'
  );
  process.exit(1);
}

const { app } = electron;
const path = require('node:path');

// `electron . --dev`：前端由 Vite 提供，后端仍跑在本进程里
// （对应 PLAN §3.5 的「同一个 Vite dev server + Express 跑在 Electron 主进程」）。
if (process.argv.includes('--dev')) {
  process.env.OPC_DEV_SERVER_URL =
    process.env.OPC_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  // 开发态复用仓库里的 data/，与浏览器开发共用同一份数据库，
  // 免得切来切去看到两个不同的会话列表。
  process.env.OPC_DATA_DIR =
    process.env.OPC_DATA_DIR || path.join(__dirname, '..', 'data');
}

// 把**整个 Chromium profile** 搬走（冒烟测试 / 多实例隔离用）。
//
// 只设 OPC_DATA_DIR 是不够的：它只重定向 SQLite，Chromium 自己的
// Preferences / Session Storage / blob_storage / DIPS 仍然写进真实的
// `app.getPath('userData')`。实测（设了 OPC_DATA_DIR 指向临时目录后启动 8s）：
//   chat.db        未变   ← 数据库确实隔离了
//   blob_storage   ★被写入 ← profile 没有隔离
// 也就是说「我以为隔离了，其实只隔离了一半」。
//
// 必须在这里（app ready 之前）setPath，ready 之后改不生效。
// 设了它之后 OPC_DATA_DIR 的默认值自动跟着走，所以只传这一个变量就够了。
if (process.env.OPC_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.OPC_USER_DATA_DIR));
}

// 打包后资源在只读 asar 里，数据库必须落到可写的用户数据目录。
// 开发态允许外部预先指定（electron:dev 会指到仓库的 data/，与浏览器开发共用一份库）。
process.env.OPC_DATA_DIR = process.env.OPC_DATA_DIR || app.getPath('userData');

// 前端产物位置：打包后在 asar 内的 dist/；开发态该目录不存在，
// server 会自动跳过静态托管，由 Vite 提供前端。
process.env.OPC_WEB_DIR = path.join(app.getAppPath(), 'dist');

// 由系统分配空闲端口，避免与用户已经跑着的开发服务器（3000）冲突。
// 真实端口由 main.ts 从 server.address() 读回。
if (process.env.PORT === undefined) process.env.PORT = '0';

console.log(`[Bootstrap] dataDir=${process.env.OPC_DATA_DIR}`);
console.log(`[Bootstrap] userData=${app.getPath('userData')}${process.env.OPC_USER_DATA_DIR ? ' (已重定向)' : ''}`);
console.log(`[Bootstrap] webDir =${process.env.OPC_WEB_DIR}`);
console.log(`[Bootstrap] port   =${process.env.PORT}${process.env.OPC_DEV_SERVER_URL ? ' (dev, 前端走 Vite)' : ''}`);

require('./main.cjs');
