import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Power, TerminalSquare } from 'lucide-react';
import {
  getTerminalOutput,
  getTerminalState,
  hasTerminal,
  killTerminal,
  sendLine,
  startTerminal,
  subscribeTerminalData,
  subscribeTerminalState,
  type TerminalState,
} from '../terminalPanel';

/**
 * P4：工作区面板的「终端」标签 —— **管道版**。
 *
 * ## 为什么界面上常驻一句「管道版：无 TTY」
 *
 * 这一版用 `child_process.spawn` 起一个持久 shell，没有 PTY。后果很具体：
 * vim / top / less / 带 Y-n 提示的安装器拿不到 TTY，行为不可预期；也没有
 * 窗口尺寸与光标寻址。所以那句说明不是免责声明，是**使用说明** ——
 * 摆一个看起来像终端、实际跑不了 vim 的东西却不讲，就是假控件。
 *
 * ## 输出为什么要「历史 + 增量」两段拿
 *
 * 用户先敲几条命令，再切到文件标签看一眼，回来时不该看到一片空白。
 * 所以挂载时先读一次历史，再订阅增量。只订阅增量的话，切走再回来
 * 之前的内容就永久丢了。
 *
 * ## 为什么自己回显输入行
 *
 * cmd.exe 的 stdin 是管道时**不回显**（它没有终端可回显）。不回显的话，
 * 用户敲的命令在输出里看不见，对话感全无。所以这里在发送时自己补一行
 * `cwd> 命令` —— 与真终端里看到的形态一致。
 */

const IDLE: TerminalState = {
  running: false,
  cwd: null,
  shell: '',
  exitCode: null,
  pty: false,
};

/**
 * 去掉最常见的 CSI 转义序列。
 *
 * 非 TTY 下大多数程序会自动关掉颜色，但总有漏的（或者用户 export 了
 * FORCE_COLOR）。留着 `[32m` 这类字符，输出区就是一片乱码 —— 而用户
 * 没有任何办法知道那是颜色码而不是内容。
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
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
  const outputRef = useRef<HTMLPreElement>(null);

  // 状态：先拉一次当前态，再订阅变化
  useEffect(() => {
    if (!available) return;
    void getTerminalState().then(s => s && setState(s));
    return subscribeTerminalState(setState);
  }, [available]);

  // 输出：历史一段 + 增量一段
  useEffect(() => {
    if (!available) return;
    void getTerminalOutput().then(text => setOutput(text));
    return subscribeTerminalData(chunk => setOutput(prev => prev + chunk));
  }, [available]);

  // 自动滚动到底部：终端不看最新输出就没有意义
  useEffect(() => {
    const el = outputRef.current;
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

  const submit = () => {
    const cmd = line.trim();
    if (!cmd || !state.running) return;
    sendLine(cmd);
    // 自己回显：管道下的 cmd 不回显，不补这一行用户看不见自己敲了什么
    setOutput(prev => `${prev}${state.cwd ?? ''}> ${cmd}\r\n`);
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
      {/* 状态行：跑着没有、用的什么 shell、退出码 */}
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
        <span className="ml-auto shrink-0">管道版 · 无 TTY</span>
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
          onClick={() => setOutput('')}
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

      <pre
        ref={outputRef}
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

      {/* 输入行 */}
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
    </div>
  );
}
