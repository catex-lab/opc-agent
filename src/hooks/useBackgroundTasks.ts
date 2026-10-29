/**
 * 后台任务轮询（A36）。
 *
 * 「后台任务」= 还在跑、但用户已经不在那个会话里的 Agent 轮次。
 * 数据源是 `GET /api/runs/active`（RunHub 里没结束的那些 run）。
 *
 * ## 为什么是轮询而不是 SSE
 *
 * 这是**全局**状态，而 SSE 是「一轮一条流」—— 想用事件推，就得再开一条
 * 全局广播通道，还要处理它自己的断线重连。而它的时效性要求很低：
 * 用户需要知道的是「还有东西在跑」，晚 5 秒完全无所谓。
 * 用 5 秒轮询换掉一整套推送基础设施，是这笔交易里明显划算的一边。
 *
 * 页面不可见时跳过请求（`document.hidden`）：后台标签页每 5 秒打一次
 * 接口，在只有本地服务的场景下纯属浪费。
 *
 * ## 例外：用户主动停止之后不能等 5 秒
 *
 * 「晚 5 秒无所谓」只对**别的会话自己开始跑**成立。用户刚点完停止、马上
 * 切到另一个会话时，他要的是「停掉了」这个确认 —— 此时还挂着一颗
 * 「1 个后台任务运行中」，他会认为停止没生效（实测反馈就是这样）。
 * 所以停止后由 `notifyRunsChanged()` 立刻补拉一次，不等轮询。
 */

import { useEffect, useState } from 'react';

export interface BackgroundTask {
  runId: string;
  sessionId?: string;
  agentId?: string;
  startedAt: number;
}

const POLL_MS = 5000;

/** 停止一轮之后广播：让所有挂着本 hook 的地方立即重拉 */
const RUNS_CHANGED_EVENT = 'opc:runs-changed';

export function notifyRunsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
}

export function useBackgroundTasks(currentSessionId?: string | null): BackgroundTask[] {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const qs = currentSessionId ? `?exclude=${encodeURIComponent(currentSessionId)}` : '';
        const res = await fetch(`/api/runs/active${qs}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { runs?: BackgroundTask[] };
        if (alive) setTasks(Array.isArray(data?.runs) ? data.runs : []);
      } catch {
        // 接口不可达（旧版后端 / 离线探针）时**清空**而不是保留旧值：
        // 留着一个不再更新的数字，比不显示更容易误导。
        if (alive) setTasks([]);
      }
    };

    /**
     * 停止后的立即重拉。
     *
     * 拉两次而不是一次：`stop` 请求是 fire-and-forget（界面要立刻收，
     * 不能被一次网络往返拖住），服务端收到后还要收尾落库才发 `run_end`。
     * 所以立刻拉那次很可能仍拿到「还没结束」的快照 —— 600ms 后这次才是准的。
     * 两次都是幂等的只读请求，代价可以忽略。
     */
    const onChanged = () => {
      void tick();
      setTimeout(() => {
        if (alive) void tick();
      }, 600);
    };

    void tick();
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener(RUNS_CHANGED_EVENT, onChanged);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(RUNS_CHANGED_EVENT, onChanged);
    };
  }, [currentSessionId]);

  return tasks;
}
