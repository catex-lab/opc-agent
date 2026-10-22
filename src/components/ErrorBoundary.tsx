import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误兜底（P6）。
 *
 * ## 为什么需要它
 *
 * 渲染期抛错（读了一段坏数据的 `.map`、某个组件在特定状态下踩空）
 * 会**整棵树卸载** —— 用户看到的是彻底的白屏，控制台之外没有任何线索，
 * 也不知道该做什么。错误边界把「白屏」换成「一句话 + 一个能点的按钮」。
 *
 * ## 边界画在哪
 *
 * 只包应用根部一层。不给每个页面各包一个：真正的渲染崩溃大多来自
 * 共享状态（会话数据、Agent 注册表），局部边界救了页面也救不回数据，
 * 反而把「哪儿炸的」拆成一堆小报告。根边界 + 完整堆栈足够定位，
 * 用户要做的也只有一件事：重新加载。
 *
 * ## 抓不到什么
 *
 * 错误边界**不捕获**事件回调里的抛错、异步 Promise、以及 SSR 阶段的错。
 * 那些仍会进 console.error（componentDidCatch 也会被调用一次），
 * 所以这个边界不是「让错误消失」，是「让用户有路可走」。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 堆栈对定位是刚需，必须留在控制台
    console.error('[ErrorBoundary] 渲染崩溃:', error);
    console.error('[ErrorBoundary] 组件栈:', info.componentStack);
  }

  private handleReload = (): void => {
    // 比 location.reload() 更稳：绕过可能被破坏的内存态，重新走一遍启动
    window.location.href = window.location.origin + '/';
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="flex items-center justify-center min-h-screen p-6"
        style={{ backgroundColor: 'var(--td-bg-color-page)' }}
      >
        <div
          className="max-w-lg w-full rounded-xl p-6"
          style={{
            backgroundColor: 'var(--td-bg-color-container)',
            border: '1px solid var(--td-component-stroke)',
          }}
        >
          <h1
            className="text-lg font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            界面出错了
          </h1>
          <p
            className="text-sm mb-4 leading-relaxed"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            应用在渲染时遇到问题，已停止显示。你的会话数据不会因此丢失
            （都存在本地数据库里）——重新加载通常就能恢复。
          </p>

          <button
            type="button"
            onClick={this.handleReload}
            className="px-4 py-2 rounded-lg text-sm font-medium mb-4"
            style={{
              backgroundColor: 'var(--td-brand-color)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>

          {/* 错误详情默认折叠：普通用户不需要看，但报问题时这就是全部线索 */}
          <details>
            <summary
              className="text-xs cursor-pointer select-none"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              错误详情（反馈问题时请附上）
            </summary>
            <pre
              className="mt-2 p-3 rounded-lg text-xs overflow-auto max-h-48"
              style={{
                backgroundColor: 'var(--td-bg-color-component)',
                color: 'var(--td-text-color-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {error.name}: {error.message}
              {'\n'}
              {error.stack}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
