/**
 * 数据目录推导（**无副作用**）。
 *
 * 为什么单独拆出来：这些路径原先只定义在 `db.ts` 里，而 `db.ts` 在
 * **模块加载时**就会打开 SQLite、建表、开 WAL —— 任何只想读一下
 * `data/` 路径的模块（例如模型目录缓存、凭据文件）一旦 import 它，
 * 就会顺带把真实用户库打开。验证脚本尤其不能有这种副作用：
 * `verify:routing` 之类的离线脚本一旦 import 到 `db.ts`，
 * 就会在真实 `data/chat.db` 上留下一次连接与建表。
 *
 * 所以路径推导单独放这里，`db.ts` 再 re-export 保持既有 import 不变。
 */
import path from 'path';

/**
 * 数据目录。
 *
 * 打包进 Electron 后，应用资源位于只读的 asar 里，不能再把数据库写在
 * 源码树旁边 —— 所以优先取 `OPC_DATA_DIR`（主进程会把它指向
 * `app.getPath('userData')`）。取不到时回落到「当前工作目录下的 data/」，
 * 开发态 `npm run dev` 的 cwd 就是仓库根目录，行为与改造前一致。
 *
 * 这里刻意**不用** `import.meta.url` / `__dirname`：打包时服务端会被
 * esbuild 打成 CJS，`import.meta` 在 CJS 输出里没有对应语义，
 * 而 `__dirname` 会随产物位置漂移（dist-electron/server 的上一级是
 * dist-electron，不是仓库根）。cwd + 环境变量是唯一稳定的选择。
 */
export const dataDirPath = process.env.OPC_DATA_DIR
  ? path.resolve(process.env.OPC_DATA_DIR)
  : path.join(process.cwd(), 'data');

/**
 * 生成图片的本地缓存目录（P4-4）。
 *
 * 放在数据库同级的 `images/` 下，随 `OPC_DATA_DIR` 一起走 —— 打包后
 * 就是 userData，卸载/迁移应用时和数据库一起搬，不会出现「库在、图没了」。
 */
export const imagesDir = path.join(dataDirPath, 'images');
