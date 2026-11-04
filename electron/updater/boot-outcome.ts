/**
 * 启动时如何解释上一次退出留下的 `apply-state.json`。
 *
 * 这里刻意**不 import electron**：判定是纯函数，`verify:a176-update-swap`
 * 直接穷举，主进程只负责把结论画到界面上。
 *
 * 为什么需要版本比较：helper 失败时写入的失败记录会一直留在 temp 里。
 * 用户可能随后手动装了完整包、或重试成功了一次 —— 此时记录指向的版本
 * 已经不新于当前版本，再展示「上次更新没有装好」就是错误信息，而且这条
 * 记录会永久常驻。规则只有一条：
 *
 *   失败记录里的版本 ≤ 当前版本 → 已消解，不展示，连状态文件一起清掉。
 */

export type BootOutcomeKind =
  | 'none'
  /** pending / unconfirmed：交接还没结束，不能动任何文件 */
  | 'in-progress'
  /** 已成功或失败记录已被现实消解：静默清理，不打扰用户 */
  | 'resolved'
  /** 新版本启动失败并自动回滚 */
  | 'rolled-back'
  /** 交接 helper 失败（文件很可能根本没换） */
  | 'apply-failed';

export interface BootMarker {
  state?: string;
  version?: string;
  error?: string;
}

export interface BootOutcome {
  kind: BootOutcomeKind;
  /** 记录里的目标版本 */
  version?: string;
  /** 记录里的失败原因 */
  error?: string;
}

/**
 * 数字段比较：`1.0.10 > 1.0.9`（不能直接字符串比）。
 * 忽略 `v` 前缀与 `-` / `+` 之后的构建信息 —— 这里只比较发布版本。
 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map(part => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const x = core(a);
  const y = core(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 把标记 + 当前版本翻译成一个启动结论。
 *
 * `confirmed` 是上一次成功交接的痕迹（helper 可能没删干净）→ 直接清掉。
 * `failed` / `rolled-back` 只有在「当前版本已经追上（或越过）记录版本」
 * 时才算消解；记录里没有版本号时不敢替用户判断，照旧展示（用户可点忽略）。
 */
export function decideBootOutcome(marker: BootMarker | null, currentVersion: string): BootOutcome {
  if (!marker) return { kind: 'none' };
  const state = marker.state;
  // 文件在、却没有可识别状态（例如人工复位成 idle、或写了一半）：陈旧垃圾，
  // 不展示也不能留着 —— 否则同目录的 job / helper / `.bak` 会永远不清。
  if (!state) return { kind: 'resolved', version: marker.version };
  if (state === 'pending' || state === 'unconfirmed') return { kind: 'in-progress' };
  if (state === 'confirmed') return { kind: 'resolved', version: marker.version };
  if (state !== 'failed' && state !== 'rolled-back') {
    return { kind: 'resolved', version: marker.version };
  }

  const recorded = marker.version?.trim();
  if (recorded && compareVersions(currentVersion, recorded) >= 0) {
    return { kind: 'resolved', version: recorded };
  }
  return {
    kind: state === 'rolled-back' ? 'rolled-back' : 'apply-failed',
    version: recorded,
    error: marker.error,
  };
}

/**
 * 只有交接类错误才允许「忽略」。
 *
 * 网络、验签、哈希、不支持等错误重试一次就会重新出现，给忽略入口只会
 * 让用户误以为问题消失了；它们该做的是按提示重试或手动下载。
 */
export function isDismissableError(code?: string): boolean {
  return code === 'apply-failed' || code === 'rollback';
}
