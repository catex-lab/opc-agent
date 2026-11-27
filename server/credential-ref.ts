/**
 * 模型路由的凭据引用查询：**只回布尔，绝不回传 Key**。
 *
 * 单独拆成没有副作用的小模块，是因为调用方横跨服务端适配器和纯离线闸门：
 * 一旦从 `agent-credentials.ts` 导入，后者的 import 链会拉起 DB，
 * 离线闸门就会顺手打开用户真实的 `data/chat.db`（已有老坑）。
 *
 * `credentialRef` 在设置页里的语义就是环境变量名（如 `SENSENOVA_API_KEY`）：
 * 用户自己 export 的，与在设置页保存后被 `loadAgentCredentials()` 注入的，
 * 最终都落在 `process.env` 里。这里只看非空、不读值、不打印、不缓存 ——
 * 凭据刷新后下一次发送就能立刻看到，不会拿旧快照误判。
 *
 * 之前生产调用点没传这个函数，凭据闸因 fail-closed 把带 `credentialRef`
 * 的自定义路由全部拒掉（能登记、能在菜单选中，一发送就报错）。
 */
export function hasCredentialRef(ref: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return false;
  return (process.env[ref] ?? '').trim().length > 0;
}
