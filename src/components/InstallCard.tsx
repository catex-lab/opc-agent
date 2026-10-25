import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import type { RegisteredAgent } from '../types';

/**
 * 「获取」卡片（A71）。
 *
 * ## 这个组件解决的问题
 *
 * 安装包里**没有任何 CLI**（打包产物 `resources/` 只有 app.asar 与 elevate.exe），
 * 所以新用户看到的是 14 条里约 11 条「未安装」。原来这种情况只有一行「接入说明」，
 * 内容是散文：`npm i -g @openai/codex，然后 codex login`。用户不知道该把哪半截
 * 粘到终端、哪半截是装完之后的事，更不知道本机有没有 Node。
 *
 * ## 三条不许破的规矩
 *
 * 1. **按 `method` 出按钮，不猜文案**。14 条里有 5 种获取方式，一个"下载"按钮
 *    会对其中 10 条说假话（豆包根本不用装）。
 * 2. **只复制，不代跑**。`irm … | iex` 是从网络取一段代码直接执行，脚本内容厂商
 *    随时会改，我们无法审计、无法固定版本。做一次就等于把「以后上游任何一次被投毒」
 *    直接转成用户机器上的执行。所以这里只有「复制命令」，没有「立即安装」。
 * 3. **不画假控件**。核实不到官方页的条目（zcode / hermes）不渲染任何按钮，
 *    只写说明 —— 画一个点下去 404 的按钮比不画更糟。
 *
 * ## 为什么「复制」和「展示」用同一个变量
 *
 * `command` 只读一次，既渲染进 `<code>` 又传给 `copyText()`。若分成两处
 * （比如展示时加个 `npm i -g ` 前缀、复制时用另一份），迟早会漂移成
 * 「屏幕上是一条命令、剪贴板里是另一条」—— 这种 bug 用户几乎不可能发现。
 */

interface InstallCardProps {
  agent: RegisteredAgent;
  /** 装完之后重新探测（`POST /api/agents/probe`） */
  onReprobe?: () => void;
  /** 跳设置页对应凭据行（`method:'key'` 用） */
  onOpenCredential?: (agentId: string) => void;
  /** 清单页里用：不画外层标题 */
  bare?: boolean;
}

/** 各 method 的一句「这是什么」。刻意写清"要你自己动手"，不写"一键安装" */
const METHOD_LINE: Record<string, string> = {
  npm: '用 npm 全局安装（需要本机已有 Node.js）',
  script: '官方提供的 PowerShell 安装脚本，需要在终端里自己运行',
  installer: '桌面端安装器，没有命令行安装方式',
  key: '不需要安装，缺的是凭据',
  unknown: '本应用没有收录可核实的安装入口',
};

async function copyText(text: string): Promise<boolean> {
  // 优先用异步剪贴板 API（Electron 与 127.0.0.1 都算安全上下文）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底 —— 权限被拒时 execCommand 往往还能用
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '-1000px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const done = document.execCommand('copy');
    document.body.removeChild(el);
    return done;
  } catch {
    return false;
  }
}

export function InstallCard({ agent, onReprobe, onOpenCredential, bare }: InstallCardProps) {
  const install = agent.install;
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    if (!install?.command) return;
    const done = await copyText(install.command);
    if (!done) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [install?.command]);

  const open = useCallback((url: string) => {
    // target=_blank 会被主进程的 setWindowOpenHandler 转交系统浏览器，
    // 不在应用内开新窗口（与「去登录」按钮同一条通道）
    window.open(url, '_blank', 'noopener');
  }, []);

  // 没有结构化元数据的老数据：退回纯文字，绝不凭正则猜"这句是不是命令"
  if (!install) {
    return agent.installHint ? (
      <div className="px-4 py-3 text-body" style={{ color: 'var(--td-text-color-secondary)' }} data-install-card="none">
        {agent.installHint}
      </div>
    ) : null;
  }

  const method = install.method;
  const env = agent.installEnv;
  // 环境不满足时说清"这条命令会失败"，而不是等用户复制完撞墙
  const envWarn =
    method === 'npm' && env?.node && env.node.ok === false
      ? '本机 PATH 里没有 Node.js —— 这条命令会失败，先装 Node.js（nodejs.org）再回来'
      : method === 'script' && env?.powershell && env.powershell.ok === false
        ? '本机没有找到 PowerShell —— 这条命令需要在 PowerShell 里运行'
        : null;

  return (
    <div className="px-4 py-3" data-install-card data-install-method={method}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
            {METHOD_LINE[method] ?? '获取方式未收录'}
          </div>
          {install.note && (
            <div
              className="mt-1 text-secondary leading-relaxed"
              style={{ color: 'var(--td-text-color-secondary)' }}
              data-install-note
            >
              {install.note}
            </div>
          )}
        </div>
      </div>

      {install.command && (
        <div
          className="mt-2 select-all overflow-hidden rounded-lg px-2.5 py-1.5"
          style={{
            backgroundColor: 'var(--tc-surface-sunken, rgba(0,0,0,0.04))',
            // A115 续：命令条是「嵌进去」的内容块，描边走 --tc-edge
            // （4.5% 墨）—— 它有 sunken 底色把自己和周围分开，
            // 不再需要 10% 的墨线。
            border: '1px solid var(--tc-edge)',
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            // A115：原来这里是裸 `fontSize: 12`，与旁边正文的 13px 差一档但
            // 没有任何令牌说明为什么。取 --text-secondary，与「次级说明」
            // 同一档 —— 命令块确实是次级信息，字号小一档是对的，只是要有出处。
            fontSize: 'var(--text-secondary)',
            lineHeight: 1.6,
            color: 'var(--td-text-color-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
          data-install-command
        >
          {install.command}
        </div>
      )}

      {envWarn && (
        <div
          className="mt-2 text-secondary leading-relaxed"
          style={{ color: 'var(--td-warning-color, #B26A00)' }}
          data-install-env-warn
        >
          {envWarn}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 主按钮按 method 走：npm 复制命令，script/installer 打开官网，key 填凭据 */}
        {method === 'npm' && install.command && (
          <button
            type="button"
            className="tc-btn-brand px-3 py-1.5 text-secondary"
            onClick={onCopy}
            data-install-copy
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制命令'}
          </button>
        )}

        {(method === 'script' || method === 'installer') && install.url && (
          <button
            type="button"
            className="tc-btn-brand px-3 py-1.5 text-secondary"
            onClick={() => open(install.url!)}
            data-install-open
          >
            <ExternalLink size={14} />
            {method === 'script' ? '打开安装页' : '打开下载页'}
          </button>
        )}

        {method === 'script' && install.command && (
          <button
            type="button"
            className="tc-btn-secondary px-3 py-1.5 text-secondary"
            onClick={onCopy}
            data-install-copy
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制命令'}
          </button>
        )}

        {method === 'npm' && install.url && (
          <button
            type="button"
            className="tc-btn-secondary px-3 py-1.5 text-secondary"
            onClick={() => open(install.url!)}
            data-install-open
          >
            <ExternalLink size={14} />
            打开项目页
          </button>
        )}

        {method === 'key' && onOpenCredential && (
          <button
            type="button"
            className="tc-btn-brand px-3 py-1.5 text-secondary"
            onClick={() => onOpenCredential(agent.id)}
            data-install-open-settings
          >
            <KeyRound size={14} />
            填写 API Key
          </button>
        )}

        {/* 装完/填完之后的统一动作。不放"安装完成"这类话 —— 我们不知道装没装成 */}
        {onReprobe && (
          <button
            type="button"
            className="ml-auto flex items-center gap-1 px-2 py-1.5 text-secondary"
            style={{ color: 'var(--td-text-color-secondary)' }}
            onClick={onReprobe}
            data-install-reprobe
          >
            <RefreshCw size={14} />
            重新检测
          </button>
        )}
      </div>

      {!bare && install.checkedAt && (
        // 核实日期是给"这条链接还新不新"用的，不是装饰。放在角落里不打扰人。
        <div
          className="mt-2 text-caption"
          style={{ color: 'var(--td-text-color-placeholder)' }}
          data-install-checked
        >
          安装来源核实于 {install.checkedAt}
        </div>
      )}
    </div>
  );
}
