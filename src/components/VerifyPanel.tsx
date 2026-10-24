/**
 * 验证状态条（A97）—— 挂在每条回答的底部，回答「这轮改动真的能跑吗」。
 *
 * ## 三态口径（这是整个功能的重点）
 *
 * | 状态 | 含义 | 触发条件 |
 * |---|---|---|
 * | 未验证 | 什么都没跑过 | 没有结果，或用户从没点过运行 |
 * | 已验证 | 跑过的都通过了 | 至少一条 pass，且没有 fail |
 * | 验证失败 | 至少一条没过 | 有 fail / timeout / error |
 *
 * **「未验证」必须是一个显式状态，不能因为没数据就不显示。** 用户看到
 * 一条回答底下什么都没有，会默认「应该没问题」；而实际上「没验证」和
 * 「验证通过」是两件事 —— 这正是这个功能要解决的核心问题。
 *
 * ## 为什么默认只勾 test / typecheck / lint
 *
 * `build` 动辄一两分钟，默认勾上会让「点一下看看」变成「等两分钟」。
 * 它仍然在列表里，只是默认不选 —— 用户想跑完整验证时自己勾。
 *
 * ## 为什么执行的是 commandId
 *
 * 后端会按 id 重新探测一遍，不接收命令字符串（见 server/index.ts 的说明）。
 * 所以这个组件只负责「选哪些」，不负责「跑什么」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Loader2, Play, XCircle } from 'lucide-react';
import type { VerificationRow, VerifyStatus } from '../hooks/useVerifications';

interface VerifyCommand {
  id: string;
  kind: 'test' | 'build' | 'lint' | 'typecheck';
  label: string;
  command: string;
  source: string;
  weight: 'fast' | 'medium' | 'slow';
}

interface DetectResult {
  cwd: string;
  projectTypes: string[];
  commands: VerifyCommand[];
  notes: string[];
}

interface RunResult {
  commandId: string;
  command: string;
  status: VerifyStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  hint?: string;
}

export interface VerifyPanelProps {
  sessionId: string;
  messageId: string;
  /** 会话绑定的工作目录；空 = 无法验证 */
  cwd?: string;
  /** 这条消息已有的验证结果（来自 /api/verify/results） */
  rows: VerificationRow[];
  /** 一轮跑完后刷新上层数据 */
  onUpdated?: () => void;
}

type Phase = 'idle' | 'running' | 'done';

/** 默认勾选：跳过 slow 档（build 动辄一两分钟） */
function defaultSelected(commands: VerifyCommand[]): Set<string> {
  const fast = commands.filter(c => c.weight !== 'slow').map(c => c.id);
  if (fast.length > 0) return new Set(fast);
  // 全是 slow 档时（例如项目只有 build 一条）至少勾一条。
  // 否则「运行验证」一打开就是灰的，用户看不出问题在哪 —— 而这时
  // 唯一可跑的就是那一条，勾上它不改变任何语义。
  return new Set(commands.slice(0, 1).map(c => c.id));
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

const STATUS_TEXT: Record<VerifyStatus, string> = {
  pass: '通过',
  fail: '失败',
  timeout: '超时',
  error: '无法执行',
};

export function VerifyPanel({ sessionId, messageId, cwd, rows, onUpdated }: VerifyPanelProps) {
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<Record<string, RunResult>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [tail, setTail] = useState('');
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 探测：只在有 cwd 时做，且只做一次
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/verify/commands?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) {
          if (!cancelled) setDetectError(`探测失败（HTTP ${res.status}）`);
          return;
        }
        const data = (await res.json()) as DetectResult;
        if (cancelled) return;
        setDetected(data);
        setSelected(defaultSelected(data.commands));
      } catch (err) {
        if (!cancelled) setDetectError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /** 落库结果 + 本次运行结果合并：本次优先（同 commandId 时） */
  const merged = useMemo(() => {
    const map = new Map<string, { status: VerifyStatus; durationMs: number | null; exitCode: number | null; output: string | null; label: string }>();
    for (const r of rows) {
      map.set(r.command_id, {
        status: r.status,
        durationMs: r.duration_ms,
        exitCode: r.exit_code,
        output: r.output,
        label: r.label || r.command,
      });
    }
    for (const [id, r] of Object.entries(live)) {
      map.set(id, {
        status: r.status,
        durationMs: r.durationMs,
        exitCode: r.exitCode,
        output: r.output,
        label: detected?.commands.find(c => c.id === id)?.label || r.command,
      });
    }
    return [...map.entries()];
  }, [rows, live, detected]);

  const overall: 'unverified' | 'running' | 'passed' | 'failed' = useMemo(() => {
    if (phase === 'running') return 'running';
    if (merged.length === 0) return 'unverified';
    return merged.some(([, v]) => v.status !== 'pass') ? 'failed' : 'passed';
  }, [phase, merged]);

  const run = useCallback(async () => {
    if (!cwd || selected.size === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setLive({});
    setTail('');
    setExpanded(true);

    try {
      const res = await fetch('/api/verify/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messageId,
          cwd,
          commandIds: [...selected],
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        setDetectError(`启动失败（HTTP ${res.status}）${text ? `：${text.slice(0, 120)}` : ''}`);
        setPhase('idle');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (evt.type === 'command_start') {
            setRunningId(String(evt.commandId));
            setTail('');
          } else if (evt.type === 'chunk') {
            setTail(t => (t + String(evt.text)).slice(-4000));
          } else if (evt.type === 'result') {
            const r = evt.result as RunResult;
            setLive(prev => ({ ...prev, [r.commandId]: r }));
            setRunningId(null);
          } else if (evt.type === 'error') {
            setDetectError(String(evt.message));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setDetectError((err as Error).message);
    } finally {
      abortRef.current = null;
      setPhase('done');
      setRunningId(null);
      onUpdated?.();
    }
  }, [cwd, selected, sessionId, messageId, onUpdated]);

  const cancel = () => abortRef.current?.abort();

  const commands = detected?.commands ?? [];
  const notes = detected?.notes ?? [];
  const canRun = !!cwd && commands.length > 0 && selected.size > 0 && phase !== 'running';

  const head =
    overall === 'running'
      ? { icon: Loader2, text: '验证中', color: 'var(--td-brand-color)', spin: true }
      : overall === 'passed'
        ? { icon: CheckCircle2, text: '已验证', color: 'var(--td-success-color)', spin: false }
        : overall === 'failed'
          ? { icon: XCircle, text: '验证失败', color: 'var(--td-error-color)', spin: false }
          : { icon: CircleDashed, text: '未验证', color: 'var(--td-text-color-placeholder)', spin: false };

  const Icon = head.icon;

  return (
    <div className="tc-verify" data-verify-status={overall} data-verify-message={messageId}>
      <button
        type="button"
        className="tc-verify-bar"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <Icon
          size={13}
          style={{ color: head.color, flexShrink: 0, animation: head.spin ? 'tc-spin 1s linear infinite' : undefined }}
        />
        <span className="tc-verify-title" style={{ color: head.color }}>
          {head.text}
        </span>
        {merged.length > 0 && (
          <span className="tc-verify-meta">
            {merged
              .map(([, v]) => `${v.label} ${STATUS_TEXT[v.status]}${v.durationMs ? ` ${fmtDuration(v.durationMs)}` : ''}`)
              .join(' · ')}
          </span>
        )}
        {merged.length === 0 && detected && commands.length > 0 && (
          <span className="tc-verify-meta">可跑 {commands.length} 项检查</span>
        )}
        {merged.length === 0 && detected && commands.length === 0 && (
          <span className="tc-verify-meta">没有识别到可执行的检查</span>
        )}
        {!cwd && <span className="tc-verify-meta">会话未绑定工作目录</span>}
        {expanded ? <ChevronDown size={13} className="tc-verify-chev" /> : <ChevronRight size={13} className="tc-verify-chev" />}
      </button>

      {expanded && (
        <div className="tc-verify-body">
          {detectError && <div className="tc-verify-note is-error">{detectError}</div>}

          {!cwd && <div className="tc-verify-note">在场景入口或会话设置里绑定工作目录后，这里会列出可执行的检查命令。</div>}

          {cwd && detected && commands.length === 0 && (
            <div className="tc-verify-note">
              {/* 探测器的 notes 里本来就带「没有识别到可自动执行的检查命令」这句，
                  再硬编码一遍会渲染成「……命令。没有识别到……命令」。有 notes 就用
                  notes，只在完全没话说时兜底。 */}
              {notes.length > 0 ? notes.join('；') : '没有识别到可自动执行的检查命令。'}
            </div>
          )}

          {commands.length > 0 && (
            <>
              <div className="tc-verify-cmds">
                {commands.map(c => (
                  <label key={c.id} className="tc-verify-cmd" data-verify-cmd={c.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      disabled={phase === 'running'}
                      onChange={e => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        });
                      }}
                    />
                    <span className="tc-verify-cmd-label">{c.label}</span>
                    <code className="tc-verify-cmd-code">{c.command}</code>
                    {c.weight === 'slow' && <span className="tc-verify-cmd-tag">较慢</span>}
                  </label>
                ))}
              </div>

              <div className="tc-verify-actions">
                {phase === 'running' ? (
                  <button type="button" className="tc-verify-btn" onClick={cancel}>
                    取消
                  </button>
                ) : (
                  <button type="button" className="tc-verify-btn is-primary" onClick={run} disabled={!canRun}>
                    <Play size={12} />
                    {merged.length > 0 ? '重跑验证' : '运行验证'}
                  </button>
                )}
                {notes.length > 0 && phase !== 'running' && (
                  <span className="tc-verify-notes">{notes.join('；')}</span>
                )}
              </div>
            </>
          )}

          {runningId && (
            <div className="tc-verify-running" data-verify-running={runningId}>
              <Loader2 size={12} style={{ animation: 'tc-spin 1s linear infinite' }} />
              <span>{commands.find(c => c.id === runningId)?.command ?? runningId}</span>
            </div>
          )}

          {tail && phase === 'running' && <pre className="tc-verify-tail">{tail.slice(-1200)}</pre>}

          {merged.length > 0 && (
            <div className="tc-verify-results">
              {merged.map(([id, v]) => (
                <div key={id} className="tc-verify-result" data-verify-result={v.status}>
                  <div className="tc-verify-result-head">
                    <span className="tc-verify-result-label">{v.label}</span>
                    <span className="tc-verify-result-status">{STATUS_TEXT[v.status]}</span>
                    {v.exitCode != null && <span className="tc-verify-result-code">退出码 {v.exitCode}</span>}
                    {v.durationMs != null && <span className="tc-verify-result-dur">{fmtDuration(v.durationMs)}</span>}
                  </div>
                  {v.output && <pre className="tc-verify-output">{v.output.slice(-3000)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
