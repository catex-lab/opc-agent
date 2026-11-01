import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExtensionImportReport,
  ExtensionListItem,
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
