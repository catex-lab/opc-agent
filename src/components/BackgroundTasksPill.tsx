/**
 * 后台任务胶囊（A36）。
 *
 * 参考图左下角那颗「1 个后台任务运行中」：它不是装饰，而是**唯一**能告诉
 * 用户「你切走了，但那边还在跑」的入口。在此之前，切到别的会话后原来那轮
 * 是死是活，界面上没有任何痕迹 —— 用户只能靠「等它自己冒出来」来猜。
 *
 * 两个来源合并成一个数：
 *   · `tasks`     —— RunHub 里还在跑的 run（别的会话）
 *   · `lingering` —— 本轮已结束、但工具调用没收到完成事件的那些（见 trace.ts）
 * 后者在「用户中止」和「适配器漏发 tool_result」两种情况下都会出现，
 * 它和前者一样，都是「有东西没结束」，放在一起说才不会让人以为漏了。
 *
 * 只在**当前会话**的消息列表底部出现一次。每条消息都挂一颗的话，
 * 同一个数字会在屏幕上重复十遍。
 */

import type { BackgroundTask } from '../hooks/useBackgroundTasks';

export function BackgroundTasksPill({
  tasks,
  lingering = 0,
  onOpen,
}: {
  tasks: BackgroundTask[];
  /** 本轮未收到完成事件的工具调用数 */
  lingering?: number;
  /** 点击跳到那个还在跑的会话 */
  onOpen?: (sessionId: string) => void;
}) {
  const total = tasks.length + lingering;
  if (total <= 0) return null;

  const target = tasks.find(t => t.sessionId);
  const clickable = !!(target?.sessionId && onOpen);

  return (
    <div className="tc-bg-tasks-wrap">
      <button
        type="button"
        className="tc-bg-tasks"
        data-bg-tasks={total}
        data-bg-tasks-runs={tasks.length}
        data-bg-tasks-lingering={lingering}
        onClick={clickable ? () => onOpen!(target!.sessionId!) : undefined}
        disabled={!clickable}
        title={
          [
            tasks.length ? `${tasks.length} 个会话仍在生成` : '',
            lingering ? `${lingering} 个工具调用未收到完成事件` : '',
          ]
            .filter(Boolean)
            .join('\n') || undefined
        }
      >
        <span className="tc-live-dot" aria-hidden="true">
          <span className="tc-live-core" style={{ backgroundColor: 'var(--td-brand-color)' }} />
          <span className="tc-live-ring" style={{ borderColor: 'var(--td-brand-color)' }} />
        </span>
        <span>{total} 个后台任务运行中</span>
        {clickable && <span className="tc-bg-tasks-go">查看</span>}
      </button>
    </div>
  );
}

export default BackgroundTasksPill;
