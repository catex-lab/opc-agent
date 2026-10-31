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

// ── CodeBuddy CLI 探测（2026-10-30）────────────────────────────────
// @tencent-ai/agent-sdk 内嵌的 CLI（cli/）因许可声明缺失，已从安装包排除。
// SDK 本体 lib/（MIT）保留，但运行时 spawn CLI 需要本机已有 codebuddy。
// 这里在业务模块加载前探测并注入 CODEBUDDY_CODE_PATH，让 SDK 直接走本机
// 已安装的副本，而不是去找那个已经不存在的内置路径。
(function () {
  const fs = require('node:fs');
  const { execSync } = require('node:child_process');

  // 用户已显式指定，不再探测
  if (process.env.CODEBUDDY_CODE_PATH && fs.existsSync(process.env.CODEBUDDY_CODE_PATH)) {
    process.env.OPC_CODEBUDDY_CLI = process.env.CODEBUDDY_CODE_PATH;
    console.log(`[Bootstrap] codebuddy=${process.env.CODEBUDDY_CODE_PATH}（用户指定）`);
    return;
  }

  /** 安装包里随 SDK 一起分发的 CLI（asarUnpack 到 app.asar.unpacked） */
  function fromBundle() {
    // 只认 asar.unpacked 下的真实路径：asar 内的路径 spawn 不了，
    // 而且 CLI 自己还要 spawn 同目录的 vendor 可执行文件，__dirname 必须是真目录。
    const p = path.join(
      path.dirname(app.getAppPath()),
      'app.asar.unpacked',
      'node_modules',
      '@tencent-ai',
      'agent-sdk',
      'cli',
      'bin',
      'codebuddy'
    );
    return fs.existsSync(p) ? p : null;
  }

  /** 找 PATH 中的 codebuddy */
  function fromPath() {
    try {
      const isWin = process.platform === 'win32';
      const found = execSync(isWin ? 'where codebuddy' : 'which codebuddy', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 3000,
      })
        .trim()
        .split(/\r?\n/)[0];
      if (!found) return null;

      // Windows 上 npm 全局安装会产生 .cmd 垫片；SDK 的 ProcessTransport
      // 只认 .exe（directExecute）或 node 脚本（走 runtime.command）。
      // 如果找到 .cmd，尝试在同目录或 npm 包结构里找真实入口。
      if (isWin && found.toLowerCase().endsWith('.cmd')) {
        const dir = path.dirname(found);
        const exe = path.join(dir, 'codebuddy.exe');
        if (fs.existsSync(exe)) return exe;
        // npm 全局包结构：codebuddy.cmd 旁就是 node_modules/@tencent-ai/codebuddy-code
        const js = path.join(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'dist', 'codebuddy-headless.js');
        if (fs.existsSync(js)) return js;
        return null;
      }

      return fs.existsSync(found) ? found : null;
    } catch {
      return null;
    }
  }

  /** 常见独立安装位置兜底 */
  function fromCommon() {
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA;
      if (!base) return null;
      const candidates = [
        path.join(base, 'Programs', 'codebuddy', 'bin', 'codebuddy.exe'),
        path.join(base, 'codebuddy', 'bin', 'codebuddy.exe'),
      ];
      for (const p of candidates) if (fs.existsSync(p)) return p;
    }
    if (process.platform === 'darwin') {
      const p = '/usr/local/bin/codebuddy';
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const codebuddyPath = fromBundle() || fromPath() || fromCommon();
  if (codebuddyPath) {
    process.env.CODEBUDDY_CODE_PATH = codebuddyPath;
    process.env.OPC_CODEBUDDY_CLI = codebuddyPath;
    console.log(`[Bootstrap] codebuddy=${codebuddyPath}`);
  } else {
    console.log('[Bootstrap] codebuddy 未检测到 —— WorkBuddy 需要自行安装 CodeBuddy CLI');
  }
})();

console.log(`[Bootstrap] dataDir=${process.env.OPC_DATA_DIR}`);
console.log(`[Bootstrap] userData=${app.getPath('userData')}${process.env.OPC_USER_DATA_DIR ? ' (已重定向)' : ''}`);
console.log(`[Bootstrap] webDir =${process.env.OPC_WEB_DIR}`);
console.log(`[Bootstrap] port   =${process.env.PORT}${process.env.OPC_DEV_SERVER_URL ? ' (dev, 前端走 Vite)' : ''}`);

require('./main.cjs');
