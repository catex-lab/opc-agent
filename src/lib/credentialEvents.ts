/**
 * 凭据 / 环境变量变更事件总线（#16）。
 *
 * ## 修的是哪一截断掉的线
 *
 * 服务端在 `saveCredential` / `clearCredential` / `/api/env` / 模型目录刷新时
 * 已经统一 `invalidateAllModelCaches()`，但前端的 `useModels.fetchModels()` 只在
 * 挂载时跑一次，`useAgentAccount()` 只依赖 agentId。结果就是：**缓存清了，界面
 * 还挂着旧模型清单和旧账号卡**，直到手动刷新或重开页面。用户因此认定
 * 「配置改了没生效」。
 *
 * 这里补的是那条通知线：任何「可能改变 Agent 可见状态」的写动作发一个事件，
 * 各消费方自己重拉自己的那份数据。事件不带数据 —— 拉什么、怎么合并由消费方
 * 决定，避免总线变成第二份真相。
 *
 * ## 为什么同 tick 合并
 *
 * 一次「保存凭据」会同时在两三处发事件（编辑器本地、父级 `onSaved`、设置页
 * provider 变更）。若逐条直发，`/api/models` 会被连打三次。所以这里按
 * `kind + agentId` 合并，微任务里发一批；**全局事件吸收同类的定向事件**，
 * 订阅方看到的是「有一次变更」，而不是「有三次」。
 */

export type CredentialChangeKind = 'credentials' | 'env' | 'profiles';

export interface CredentialChange {
  kind: CredentialChangeKind;
  /** 定向到某个 Agent；undefined = 全局（env / 模型目录） */
  agentId?: string;
}

type Listener = (event: CredentialChange) => void;

const listeners = new Set<Listener>();
let pending: CredentialChange[] = [];
let scheduled = false;

/** 一批里同类事件去重；有全局事件时同类的定向事件被吸收。 */
export function mergeCredentialChanges(batch: CredentialChange[]): CredentialChange[] {
  const out: CredentialChange[] = [];
  for (const e of batch) {
    const dup = out.find(x => x.kind === e.kind && x.agentId === e.agentId);
    if (!dup) out.push({ ...e });
  }
  for (const kind of ['credentials', 'env', 'profiles'] as const) {
    const global = out.find(e => e.kind === kind && e.agentId === undefined);
    if (!global) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].kind === kind && out[i].agentId !== undefined) out.splice(i, 1);
    }
  }
  return out;
}

function flush(): void {
  scheduled = false;
  const batch = mergeCredentialChanges(pending);
  pending = [];
  for (const event of batch) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 一个订阅者抛错不该挡住其它订阅者刷新
      }
    }
  }
}

function emit(event: CredentialChange): void {
  pending.push(event);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

/** 订阅，返回取消订阅函数（组件卸载时一定要调）。 */
export function subscribeCredentialChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 保存 / 清除 / 切换凭据后发；不带 agentId 表示所有 Agent 都可能变了。 */
export function emitCredentialsChanged(agentId?: string): void {
  emit({ kind: 'credentials', ...(agentId ? { agentId } : {}) });
}

/** 环境变量保存后发（服务端会清全部模型缓存，所以这是全局事件）。 */
export function emitEnvChanged(): void {
  emit({ kind: 'env' });
}

/** 账号 profile 增删改后发（#15）。 */
export function emitProfilesChanged(agentId?: string): void {
  emit({ kind: 'profiles', ...(agentId ? { agentId } : {}) });
}
