/**
 * 把 `OPC_DATA_DIR` 指到一个临时目录 —— **必须是脚本的第一个 import**。
 *
 * 为什么需要它：验证脚本本身不碰数据库，但它们会 `import` 适配器，而
 * `adapters/sdk.ts → server/memory.ts → server/db.ts` 这条链**一 import 就开库**
 * （`new DatabaseSync` + WAL + 建表）。于是跑一次离线断言，用户真实的
 * `data/chat.db` 就被打开了 —— 虽然不写行，但会建 `-wal`/`-shm`，
 * 和正在运行的实例抢文件锁。
 *
 * ESM 的模块求值顺序与 import 声明顺序一致，所以只要本模块排在所有
 * `../server/**` 之前，db.ts 读到的就是临时目录。
 *
 * 退出时自动清理（Windows 上连接可能没释放，删不掉就忽略）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-'));
process.env.OPC_DATA_DIR = dir;

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 SQLite 连接可能未释放，忽略 */
  }
});

console.log(`[verify] 使用临时数据目录：${dir}（不触碰真实 data/）`);
