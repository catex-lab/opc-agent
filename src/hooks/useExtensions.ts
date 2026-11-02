import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExtensionDriftApplyResult,
  ExtensionDriftReport,
  ExtensionImportReport,
  ExtensionListItem,
  ExtensionNormalizePreview,
  ExtensionSourceRef,
  ExtensionStats,
  ExtensionTargetSpec,
  ExtensionTargetState,
} from '../types';

/**
 * 扩展库（Agent 技能 + MCP 服务）的数据 hook。
 *
 * ## 为什么拉取时机是「首次切到扩展栏」而不是启动即拉
 *
 * `GET /api/extensions` 只是读自己的 sqlite，本身很便宜；但**导入**
 * （`POST /api/extensions/import`）要扫 15 个 Agent 目录、读上百个
 * SKILL.md、再算一遍指纹 —— 那是磁盘 IO。启动时白跑一次纯浪费，
 * 而且用户可能整场都不会打开这一栏。
 *
 * 所以分两件事：进栏拉列表（便宜，每次都拉）、用户点「导入」才扫盘（贵）。
 * 「每次都拉」而不是「只拉一次」的理由与项目栏相同：这个列表会在别处变
 * （用户在自己的客户端里装了新技能、删了某个 MCP），只拉一次的话
 * 切回来看到的是一份没有线索说明它过期的旧快照。
 *
 * ## 只读，永不写用户目录
 *
 * 这个 hook 里所有请求都指向 `/api/extensions`。后端那侧只写 `data/chat.db`，
 * 不碰任何 `~/.<agent>/` —— 用户明确的硬约束，见 PLAN-EXTENSIONS.md §2.1。
 */
export function useExtensions() {
  const [items, setItems] = useState<ExtensionListItem[]>([]);
  const [stats, setStats] = useState<ExtensionStats | null>(null);
  /** 15 个 Agent 的完整清单（含没有技能目录的），详情页的能力矩阵按它渲染 */
  const [targets, setTargets] = useState<ExtensionTargetSpec[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * 「列表真的拉过一轮了」。
   *
   * 判据不能用 `items.length > 0`：一个扩展都没导入的干净环境里，列表
   * 合法地是空数组 —— 拿长度判会把「深链指向一条不存在的扩展」和
   * 「还没拉过」混成一件事（A151 踩过两次，见 TRAPS §16.4）。
   */
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次导入的报告。给面板底部那一行摘要用，不进持久层 */
  const [lastReport, setLastReport] = useState<ExtensionImportReport | null>(null);

  /**
   * 防乱序：两个触发点（进栏 effect、导入/编辑后的重拉）可能并发。
   * 只认最后一次发起的那一个，否则先发的慢请求落地会覆盖后发的快请求
   * —— A162 在项目列表上踩过同一个坑（`fetchTasks` 两个触发点乱序）。
   */
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/extensions');
      const data = await res.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      const body = data as {
        items?: ExtensionListItem[];
        stats?: ExtensionStats;
        targets?: ExtensionTargetSpec[];
      };
      setItems(Array.isArray(body.items) ? body.items : []);
      setStats(body.stats ?? null);
      setTargets(Array.isArray(body.targets) ? body.targets : []);
      setLoaded(true);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError((e as Error).message || '读取扩展失败');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  /**
   * 全量导入：扫所有 Agent 目录，按 §7.1 判定表决定 added/updated/conflict。
   *
   * 返回报告而不是只 setState —— 调用方要拿它弹一句「新增 3、更新 1、
   * 2 条有冲突」。返回值也可能是 null（网络失败），调用方要判空。
   */
  const runImport = useCallback(async (): Promise<ExtensionImportReport | null> => {
    setImporting(true);
    setError(null);
    try {
      const res = await fetch('/api/extensions/import', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      const report = data as ExtensionImportReport;
      setLastReport(report);
      await load();
      return report;
    } catch (e) {
      setError((e as Error).message || '导入失败');
      return null;
    } finally {
      setImporting(false);
    }
  }, [load]);

  /**
   * 删除 **OPC 的副本**。源文件一律不动 —— 这句话也印在详情页的危险区里，
   * 因为「删除」这个词在这一栏里天然会被读成「把我磁盘上那份也删了」。
   */
  const remove = useCallback(
    async (kind: string, name: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
          { method: 'DELETE' }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        }
        await load();
        return true;
      } catch (e) {
        setError((e as Error).message || '删除失败');
        return false;
      }
    },
    [load]
  );

  /** 首次挂载不拉 —— 由「切到扩展栏」的 effect 触发（见文件头） */
  const ensureLoaded = useCallback(() => {
    void load();
  }, [load]);

  return {
    items,
    stats,
    targets,
    loading,
    loaded,
    importing,
    error,
    lastReport,
    load,
    runImport,
    remove,
    ensureLoaded,
  };
}

/**
 * 单个扩展的详情（正文 + 来源 + 能力矩阵）。
 *
 * 单独一个 hook 而不是复用列表里那份：列表给的是摘要，正文可能几十 KB，
 * 23 条一起塞进首屏响应是纯浪费。详情按需拉，切换条目时重拉。
 *
 * `name` 为 null 时不发请求，也把 data 清空 —— 否则从 A 切到「没选中」
 * 时右侧会挂着 A 的正文。
 */
export function useExtensionDetail(kind: string | null, name: string | null) {
  const [item, setItem] = useState<ExtensionListItem | null>(null);
  const [targets, setTargets] = useState<ExtensionTargetState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!kind || !name) {
      setItem(null);
      setTargets([]);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`
      );
      const data = await res.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      const body = data as {
        item?: ExtensionListItem;
        sources?: ExtensionSourceRef[];
        targets?: ExtensionTargetState[];
      };
      if (body.item) {
        const sources = body.sources ?? [];
        setItem({ ...body.item, sources, sourceCount: sources.length });
        setTargets(Array.isArray(body.targets) ? body.targets : []);
      } else {
        setItem(null);
        setTargets([]);
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError((e as Error).message || '读取详情失败');
      setItem(null);
      setTargets([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [kind, name]);

  useEffect(() => {
    void load();
  }, [load]);

  return { item, targets, loading, error, reload: load };
}

/**
 * 归一化（A166 / P1）：预览 → 逐条接受 → 回滚。
 *
 * ## 为什么「预览」和「应用」是两个动作
 *
 * PLAN-EXTENSIONS.md §8.3 的硬要求：归一化**不自动应用**，必须给人看 diff。
 * 所以这里 `load()` 只拿 diff（纯读），`apply()` 才写库，而且
 * `accepted` 是 hit 的下标数组 —— 用户勾哪条就只改哪条。
 *
 * ## 为什么 apply / revert 之后要调用方自己 reload 详情
 *
 * 正文变了，详情里那份 `item.body` 就旧了。这个 hook 不持有 detail 的 state
 * （两个 hook 各自独立拉），所以只能返回 `true` 让调用方 `reload()` ——
 * 偷偷在内部再 fetch 一次详情会让「谁最后落地」变成竞态
 * （A162 在项目列表上踩过：两个触发点乱序，先发的慢请求覆盖后发的）。
 */
export function useExtensionNormalize(kind: string | null, name: string | null) {
  const [preview, setPreview] = useState<ExtensionNormalizePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!kind || !name || kind !== 'skill') {
      setPreview(null);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/normalize`
      );
      const data = await res.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        /* 409 = 「这条没有正文可归一化」（被拦截 / 空正文）。这不是错误弹窗的料，
           界面上显示成一句说明即可 —— 所以把 error 置空，只留 preview=null。 */
        setPreview(null);
        if (res.status !== 409) {
          throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        }
        return;
      }
      setPreview(data as ExtensionNormalizePreview);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError((e as Error).message || '生成归一化预览失败');
      setPreview(null);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [kind, name]);

  const apply = useCallback(
    async (accepted?: number[]): Promise<boolean> => {
      if (!kind || !name) return false;
      setApplying(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/normalize`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(accepted ? { accepted } : {}),
          }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        await load();
        return true;
      } catch (e) {
        setError((e as Error).message || '应用归一化失败');
        return false;
      } finally {
        setApplying(false);
      }
    },
    [kind, name, load]
  );

  const revert = useCallback(async (): Promise<boolean> => {
    if (!kind || !name) return false;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/extensions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/revert-normalize`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message || '回滚失败');
      return false;
    } finally {
      setApplying(false);
    }
  }, [kind, name, load]);

  useEffect(() => {
    void load();
  }, [load]);

  return { preview, loading, applying, error, reload: load, apply, revert };
}

/**
 * 差异检测（A168 / P4）：本机源文件与 OPC 库现在差了什么。
 *
 * ## 为什么轮询放在这里、而不是服务端定时器
 *
 * 扫描一次 = 读 54 个 `SKILL.md` + 9 个 MCP 配置文件，几十毫秒。桌面应用
 * 大部分时间没人看「扩展」这一栏，挂一个常驻 `setInterval` 就是让磁盘
 * 每分钟醒一次去算一个没人看的结果。
 *
 * 所以：**面板挂载时才开始轮询，切走就停**（`ExtensionPanel` 只在
 * `nav === 'extensions'` 时渲染，见 App.tsx）。这也顺带满足了「定期扫描」——
 * 用户在看这一栏的时候，60 秒一次。
 *
 * ## 为什么轮询那次不置 `loading`
 *
 * 首次拉取要显示「正在检查」，但每 60 秒把徽章闪成 loading 是噪音：
 * 用户会以为「它一直在忙」。轮询走静默路径，失败也不清空上一次的结果 ——
 * 一次网络抖动不该让「有 3 处变化」的提示突然消失。
 */
export function useExtensionDrift() {
  const [report, setReport] = useState<ExtensionDriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 与 `useExtensions` 同一个理由：两个触发点（首拉 + 轮询）会并发，只认最后发起的那一个 */
  const seqRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/extensions/drift');
      const data = await res.json().catch(() => ({}));
      if (seq !== seqRef.current) return;
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      setReport(data as ExtensionDriftReport);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      // 静默轮询失败不覆盖上一次结果，只在非静默时报错
      if (!silent) setError((e as Error).message || '检查变化失败');
    } finally {
      if (!silent && seq === seqRef.current) setLoading(false);
    }
  }, []);

  /**
   * 应用若干条差异。返回逐条结果（`conflict` 表示**没有覆盖**本地修改）。
   * 响应里带新的报告，直接替换 —— 避免「应用成功但徽章还挂着」。
   *
   * ⚠️ 替换前**必须先作废在飞的轮询**（`seqRef.current += 1`）：
   * 60s 轮询与「点应用」是两个独立触发点，某次轮询可能在应用**之前**发出、
   * 之后才落地，它手里那份是应用前的快照 —— 直接 `setReport` 会把刚刷新的
   * 报告盖回去，表现正是「应用成功了，徽章还挂着」。这与 A162 修的
   * 「两个触发点 GET 乱序落地」是同一类缺陷（自增序号，最后发起者胜）。
   */
  const apply = useCallback(
    async (
      entries: Array<{ kind: string; name: string }>
    ): Promise<ExtensionDriftApplyResult[] | null> => {
      if (entries.length === 0) return null;
      setApplying(true);
      setError(null);
      try {
        const res = await fetch('/api/extensions/drift/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        const body = data as { results?: ExtensionDriftApplyResult[]; report?: ExtensionDriftReport };
        if (body.report) {
          seqRef.current += 1; // 作废在飞的轮询，否则它落地时会把这份新报告盖回旧快照
          setReport(body.report);
        }
        return Array.isArray(body.results) ? body.results : [];
      } catch (e) {
        setError((e as Error).message || '应用变化失败');
        return null;
      } finally {
        setApplying(false);
      }
    },
    []
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { report, loading, applying, error, reload: load, apply };
}
