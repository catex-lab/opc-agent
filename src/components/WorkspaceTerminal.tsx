import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Power, TerminalSquare } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  getTerminalOutput,
  getTerminalState,
  hasTerminal,
  killTerminal,
  resizeTerminal,
  sendKeys,
  sendLine,
  startTerminal,
  subscribeTerminalData,
  subscribeTerminalState,
  type TerminalState,
} from '../terminalPanel';

/**
 * P4：工作区面板的「终端」标签。
 *
 * ## 两个通道，界面据此说话
 *
 * `state.pty` 为 true 是 **PTY 通道**：xterm.js 渲染，输入是原始键流，
 * vim / top / `python` REPL 都能跑。为 false 是**管道版兜底**（`node-pty`
 * 加载失败时的降级）：`<pre>` 显示纯文本，界面上常驻「管道版 · 无 TTY」。
 *
 * 那句常驻说明不是免责声明，是**使用说明** —— 摆一个看起来像终端、实际跑不了
 * vim 的东西却不讲，就是假控件。反过来，PTY 可用时也如实说，不冒充。
 *
 * ## 输出为什么要「历史 + 增量」两段拿
 *
 * 用户先敲几条命令，再切到文件标签看一眼，回来时不该看到一片空白。
 * 所以挂载时先读一次历史，再订阅增量。只订阅增量的话，切走再回来
 * 之前的内容就永久丢了。
 *
 * ## xterm 就绪前的那段缓冲
 *
 * xterm 是异步建起来的（要 IPC 读历史），这期间到达的输出不能丢、也不能
 * 重复。做法：就绪前的块进 `pending`，历史写完后立刻补写，然后才认增量。
 *
 * ## 重启不清屏
 *
 * 用户退出 shell 再启动，屏幕上保留上一场的滚动内容 —— 和真终端一致，
 * 也避免「清屏」与「新 shell 的开场白」抢顺序（两者都是异步推送，
 * 谁先到不确定，清了就可能把开场白擦掉）。边界由开场白那一行标出来。
 */

const IDLE: TerminalState = {
  running: false,
  cwd: null,
  shell: '',
  exitCode: null,
  pty: false,
  cols: 80,
  rows: 24,
};

/**
 * 去掉最常见的 CSI 转义序列。
 *
 * 管道版没有终端语义，颜色码对它是纯噪音：留着 `[32m` 这类字符，输出区就是
 * 一片乱码 —— 而用户没有任何办法知道那是颜色码而不是内容。
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** 从 CSS 变量读终端配色，让 xterm 跟着应用的深浅主题走。 */
function readTerminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--tc-surface-chrome', '#f5f5f5'),
    foreground: v('--td-text-color-primary', '#1f1f1f'),
    cursor: v('--td-text-color-primary', '#1f1f1f'),
    selectionBackground: v('--tc-hover-chrome', '#e0e0e0'),
  };
}

interface WorkspaceTerminalProps {
  /** 会话绑定的工作目录。null = 未绑定，面板给指引而不是乱起一个 shell */
  cwd?: string | null;
}

export function WorkspaceTerminal({ cwd }: WorkspaceTerminalProps) {
  const available = hasTerminal();
  const [state, setState] = useState<TerminalState>(IDLE);
  const [output, setOutput] = useState('');
  const [line, setLine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  /** 最新状态的镜像：数据订阅只挂一次，不能靠闭包里的旧 state */
  const stateRef = useRef(state);
  stateRef.current = state;

  /** xterm 实例与就绪标记。`ready` 之前到达的输出进 `pending`。 */
  const termRef = useRef<Terminal | null>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef('');

  // 状态：先拉一次当前态，再订阅变化
  useEffect(() => {
    if (!available) return;
    void getTerminalState().then(s => s && setState(s));
    return subscribeTerminalState(setState);
  }, [available]);

  // 输出：历史一段 + 增量一段。PTY 模式下走 xterm，管道版走 <pre>。
  useEffect(() => {
    if (!available) return;
    return subscribeTerminalData(chunk => {
      const term = termRef.current;
      if (readyRef.current && term) {
        term.write(chunk);
      } else if (stateRef.current.pty) {
        pendingRef.current += chunk;
      } else {
        setOutput(prev => prev + chunk);
      }
    });
  }, [available]);

  // 管道版：自动滚动到底部。终端不看最新输出就没有意义
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  // 进来自动起一个 shell。用户点「终端」标签就是要敲命令的，
  // 再让他点一次「启动」是多一下不必要的确认。
  //
  // 但**只自动起一次**：用户敲 `exit` 或点电源键之后不该又被拉起来 ——
  // 那会让电源键变成一个点了没反应的按钮（正是本项目一直在防的那类假控件）。
  // 那种情况下给一个显式的「启动」按钮，让用户自己决定。
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!available || !cwd || booted) return;
    let cancelled = false;
    void startTerminal(cwd).then(res => {
      if (cancelled) return;
      if (res.ok) setBooted(true);
      else setError(res.error ?? '启动失败');
    });
    return () => {
      cancelled = true;
    };
  }, [available, cwd, booted]);

  /**
   * PTY 通道：建 xterm、接键流、跟住容器尺寸。
   *
   * 依赖里**没有** `state.running`：shell 退出时不能把 xterm 拆掉，
   * 否则最后一块屏幕（含退出码那行）跟着消失。重启也不拆 —— 见文件头注释。
   */
  useEffect(() => {
    if (!available || !state.pty) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'var(--font-mono)',
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* 容器还没布局好（宽度为 0）时 fit 会抛；ResizeObserver 会再调一次 */
    }
    termRef.current = term;

    const sub = term.onData(data => sendKeys(data));

    // 历史先写，再补就绪前的缓冲，然后才认增量 —— 顺序不能反
    void getTerminalOutput().then(history => {
      if (termRef.current !== term) return; // 期间被卸载/重建了
      if (history) term.write(history);
      if (pendingRef.current) {
        term.write(pendingRef.current);
        pendingRef.current = '';
      }
      readyRef.current = true;
      void resizeTerminal(term.cols, term.rows);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void resizeTerminal(term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      sub.dispose();
      readyRef.current = false;
      termRef.current = null;
      pendingRef.current = '';
      term.dispose();
    };
  }, [available, state.pty]);

  const submit = () => {
    const cmd = line.trim();
    if (!cmd || !state.running) return;
    sendLine(cmd);
    // 管道版自己回显：cmd 的 stdin 是管道时它不回显，不补这一行用户看不见
    // 自己敲了什么。PTY 通道**不补** —— 那边的回显是真的终端回显，补了就是两遍。
    if (!state.pty) {
      setOutput(prev => `${prev}${state.cwd ?? ''}> ${cmd}\r\n`);
    }
    setLine('');
  };

  const prettyOutput = useMemo(() => stripAnsi(output), [output]);

  if (!available) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ color: 'var(--td-text-color-secondary)' }}
      >
        <TerminalSquare size={22} style={{ color: 'var(--td-text-color-placeholder)' }} />
        <p className="text-body">终端只在桌面端可用</p>
        <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          它由主进程 spawn 的 shell 承载，浏览器里没有等价物
        </p>
      </div>
    );
  }

  if (!cwd) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ color: 'var(--td-text-color-secondary)' }}
      >
        <TerminalSquare size={22} style={{ color: 'var(--td-text-color-placeholder)' }} />
        <p className="text-body">这个会话还没绑工作目录</p>
        <p className="text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
          终端的 cwd 只能来自会话工作目录，不会退回应用自己的安装目录
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 状态行：跑着没有、用的什么 shell、哪个通道 */}
      <div
        className="flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-caption"
        style={{
          borderBottom: '1px solid var(--tc-hairline)',
          color: 'var(--td-text-color-placeholder)',
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: state.running ? '#1D9E75' : '#999999' }}
        />
        <span className="truncate">
          {state.running
            ? `${state.shell} 运行中`
            : state.exitCode === null
              ? '未启动'
              : `已退出（${state.exitCode}）`}
        </span>
        {/* 通道标识：能跑交互式程序就说能跑，不能就说不能 */}
        <span className="ml-auto shrink-0">{state.pty ? 'PTY · 交互式可用' : '管道版 · 无 TTY'}</span>
        {!state.running && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              void startTerminal(cwd).then(res => {
                if (res.ok) setBooted(true);
                else setError(res.error ?? '启动失败');
              });
            }}
            title="启动 shell"
            aria-label="启动 shell"
            className="flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <Power size={12} />
            启动
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (termRef.current) termRef.current.clear();
            else setOutput('');
          }}
          title="清空输出"
          aria-label="清空输出"
          className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          <Eraser size={12} />
        </button>
        {state.running && (
          <button
            type="button"
            onClick={() => void killTerminal()}
            title="结束 shell"
            aria-label="结束 shell"
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--tc-hover-chrome)]"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            <Power size={12} />
          </button>
        )}
      </div>

      {error && (
        <div
          className="shrink-0 px-3 py-1.5 text-caption"
          style={{ color: 'var(--td-text-color-secondary)', backgroundColor: 'var(--tc-hover-chrome)' }}
        >
          {error}
        </div>
      )}

      {/* PTY 通道：xterm 自己就是输入与输出。没有下面的输入行 ——
          摆一个只能发一整行、方向键和 Ctrl+C 全过不去的输入框，那才是假控件。 */}
      {state.pty ? (
        <div
          ref={hostRef}
          data-terminal-host
          className="min-h-0 flex-1 overflow-hidden px-1.5 py-1"
          style={{ backgroundColor: 'var(--tc-surface-chrome)' }}
        />
      ) : (
        <>
          <pre
            ref={preRef}
            className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-caption"
            style={{
              backgroundColor: 'var(--tc-surface-chrome)',
              color: 'var(--td-text-color-primary)',
              fontFamily: 'var(--font-mono)',
              margin: 0,
            }}
          >
            {prettyOutput}
          </pre>

          {/* 管道版输入行 */}
          <div
            className="flex h-8 shrink-0 items-center gap-1.5 px-2"
            style={{ borderTop: '1px solid var(--tc-hairline)' }}
          >
            <span className="shrink-0 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              $
            </span>
            <input
              value={line}
              onChange={e => setLine(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={!state.running}
              placeholder={state.running ? '输入命令，回车执行' : 'shell 未运行'}
              aria-label="终端输入"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-caption outline-none disabled:opacity-50"
              style={{
                color: 'var(--td-text-color-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
