import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from 'tdesign-react';
import { useTranslation, type MessageKey } from '../i18n';
import type { RegisteredAgent } from '../types';
import { api } from '../api';

/**
 * 登录代管终端（P2）。
 *
 * ## 交互模型
 *
 * 「打开登录」= 把**厂商自己的登录命令**拉起在一个可见会话里（PTY 优先）。
 * 用户在里面完成登录（浏览器跳转 / 选 Provider / 贴 Key），进程退出后
 * **服务端自动跑 canary 复检**——名册自己更新，这个对话框只负责展示与输入。
 *
 * ## 为什么输出是 <pre> 而不是 xterm
 *
 * 登录流九成是「读 URL → 浏览器操作 → 回车」，行式呈现足够；xterm 的完整
 * 终端仿真（颜色/光标）对这一步是超配。管道兜底版（无 TTY）时如实标注
 * 「交互菜单不可用」——不装作能点。
 */

interface LoginTerminalDialogProps {
  agent: RegisteredAgent;
  onClose: () => void;
}

interface LoginState {
  agentId: string | null;
  running: boolean;
  pty: boolean;
  startedAt: string | null;
  exitCode: number | null;
  output: string;
}

export function LoginTerminalDialog({ agent, onClose }: LoginTerminalDialogProps) {
  const { t } = useTranslation();
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(true);
  const [pty, setPty] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  const closedRef = useRef(false);

  const stop = useCallback(() => {
    void api.post('/api/agents/login-terminal/stop').catch(() => undefined);
  }, []);

  // 启动 + 轮询状态（输出/退出码）。退出后再多轮询几次，把「复检结论」收进来
  useEffect(() => {
    let cancelled = false;
    let afterExitPolls = 0;
    const tick = async () => {
      try {
        const r = await api.get('/api/agents/login-terminal/state');
        const s = (await r.json()) as LoginState;
        if (cancelled) return;
        setOutput(s.output ?? '');
        setPty(s.pty);
        setRunning(s.running);
        setExitCode(s.exitCode);
        if (!s.running) {
          afterExitPolls += 1;
          if (afterExitPolls > 12) return; // 复检结论已收（约 7s），停止轮询
        }
      } catch {
        /* 下轮再取 */
      }
      if (!cancelled) timer = setTimeout(tick, 600);
    };
    let timer = setTimeout(tick, 500);
    void api.post('/api/agents/login-terminal/start', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok && !cancelled) setError(String(d.error ?? '启动失败'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // 关对话框 = 明确停止登录（不做后台继续登录的隐式行为）
      if (!closedRef.current) stop();
    };
  }, [agent.id, stop]);

  // 输出自动滚底
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const send = () => {
    const line = input.trim();
    if (!line) return;
    void api.post('/api/agents/login-terminal/write', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: line }),
    }).catch(() => undefined);
    setInput('');
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'var(--tc-mask-soft)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) {
          closedRef.current = true;
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('login.terminal.title', { name: agent.name })}
        data-login-terminal
        className="tc-dialog flex max-h-[min(640px,100%)] w-[min(640px,100%)] flex-col overflow-hidden rounded-2xl"
      >
        <div
          className="flex h-[64px] shrink-0 items-center justify-between px-5"
          style={{ borderBottom: '1px solid var(--tc-divider)' }}
        >
          <div className="min-w-0">
            <h3 className="truncate text-body-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {t('login.terminal.title', { name: agent.name })}
            </h3>
            <p className="truncate text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {agent.login?.command} {agent.login?.note ?? ''}
              {pty ? '' : ` · ${t('login.terminal.pipe')}`}
            </p>
          </div>
          <Button
            variant="text"
            shape="circle"
            icon={<X />}
            onClick={() => {
              closedRef.current = true;
              onClose();
            }}
            aria-label={t('login.terminal.close')}
          />
        </div>

        <pre
          ref={preRef}
          data-login-terminal-output
          className="min-h-0 flex-1 overflow-y-auto px-5 py-3 font-mono text-caption whitespace-pre-wrap"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {output || t('login.terminal.starting')}
        </pre>

        {error && (
          <p className="px-5 pb-2 text-caption" style={{ color: 'var(--tc-status-danger)' }} data-login-terminal-error>
            {error}
          </p>
        )}
        {!running && exitCode !== null && (
          <p className="px-5 pb-2 text-caption" style={{ color: 'var(--tc-status-success)' }} data-login-terminal-exited>
            {t('login.terminal.exited', { code: String(exitCode) })}
          </p>
        )}

        <div
          className="flex h-[60px] shrink-0 items-center gap-2 px-5"
          style={{ borderTop: '1px solid var(--tc-divider)' }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') send();
            }}
            placeholder={t('login.terminal.input')}
            data-login-terminal-input
            disabled={!running}
            className="h-9 min-w-0 flex-1 rounded-lg px-3 font-mono text-body outline-none"
            style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-primary)' }}
          />
          <Button variant="outline" onClick={send} disabled={!running} data-login-terminal-send>
            {t('login.terminal.send')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              closedRef.current = true;
              onClose();
            }}
          >
            {t('login.terminal.close')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
