/**
 * 设置 → 关于与隐私
 *
 * 这一页承担三件事，缺一不可：
 *   1. 告诉用户「这是什么东西、什么版本」—— 开源项目的支持成本，一半来自
 *      用户报 issue 时说不清自己装的哪一版。
 *   2. 给出官方入口 —— 官网、源码、反馈。没有这些，用户只能去搜索引擎找，
 *      很容易装到改包。
 *   3. 把「收集什么」摊开讲，并给一个真的能关的开关。匿名统计虽然不含
 *      可识别信息，但知情权不该靠"反正不敏感"来省略。
 *
 * 官网已确认；GitHub 仓库地址待用户提供后再加入，避免显示失效占位链接。
 */
import { useEffect, useState } from 'react';
import { Switch } from 'tdesign-react';
import {
  Globe,
  ExternalLink,
  ShieldCheck,
  Check,
  X,
} from 'lucide-react';
import appIcon from '../assets/app-icon.png';

const SITE_URL = 'https://github.com/catex-lab/opc-agent';

interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
}

interface AnalyticsState {
  available: boolean;
  enabled: boolean;
  sessionActive: boolean;
}

interface AboutBridge {
  appInfo?: () => Promise<AppInfo>;
  analyticsState?: () => Promise<AnalyticsState>;
  setAnalytics?: (enabled: boolean) => Promise<AnalyticsState>;
}

function bridge(): AboutBridge | undefined {
  return (window as unknown as { opc?: AboutBridge }).opc;
}

const LINKS = [
  { href: SITE_URL, label: 'OPC Agent 官网', hint: '项目介绍、下载与隐私说明', Icon: Globe },
];

/** 收集 / 不收集两栏。文案刻意具体到字段名，含糊的"相关数据"等于没说。 */
const COLLECTED = ['随机生成的安装 ID', '启动时间与使用时长', '应用版本、操作系统、架构'];
const NOT_COLLECTED = ['聊天内容与模型输出', '文件路径与工作区内容', 'Agent 凭据与 API Key', 'IP 地址与设备指纹不会作为统计字段上报'];

export default function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [state, setState] = useState<AnalyticsState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const b = bridge();
    // 浏览器里跑（无 preload）时两个接口都不存在，页面降级成纯说明文字。
    // 即便存在也要过滤掉空返回：桥返回 undefined 时不能让 state 变成 undefined。
    void b?.appInfo?.().then(v => { if (v) setInfo(v); }).catch(() => undefined);
    void b?.analyticsState?.().then(v => { if (v) setState(v); }).catch(() => undefined);
  }, []);

  const toggle = async (next: boolean) => {
    const b = bridge();
    if (!b?.setAnalytics || busy) return;
    setBusy(true);
    try {
      const updated = await b.setAnalytics(next);
      if (updated) setState(updated);
    } finally {
      setBusy(false);
    }
  };

  const buildLine = info
    ? `Electron ${info.electron} · Node ${info.node} · ${info.platform} ${info.arch}`
    : '正在读取构建信息…';

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          关于与隐私
        </h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          查看应用版本、官网入口和匿名统计的实际范围。
        </p>
      </div>

      {/* ── 应用信息 ─────────────────────────────────────────── */}
      <div
        className="flex items-start gap-4 rounded-xl p-4 sm:p-5"
        style={{
          backgroundColor: 'var(--tc-layer-2)',
          border: '1px solid var(--tc-edge)',
        }}
      >
        <img src={appIcon} alt="" className="h-14 w-14 shrink-0 rounded-xl" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-lg font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              {info?.name || 'OPC Agent'}
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: 'var(--td-bg-color-component)',
                color: 'var(--td-text-color-secondary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              v{info?.version || '—'}
            </span>
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            本机多 Agent 团队协作桌面应用 —— 把本机的各类 Agent 当作通讯录里的联系人
          </p>
          <p className="mt-2 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {buildLine}
          </p>
        </div>
      </div>

      {/* ── 官方入口 ─────────────────────────────────────────── */}
      <div>
        <h3 className="mb-2 text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          官方入口
        </h3>
        <div className="grid grid-cols-1 gap-2">
          {LINKS.map(({ href, label, hint, Icon }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center gap-3 rounded-xl p-3"
              style={{
                backgroundColor: 'var(--tc-layer-2)',
                border: '1px solid var(--tc-edge)',
                // 全局 a 有品牌色 + 下划线，这里必须显式压掉 ——
                // 否则卡片里的说明文字会变成一整片蓝色下划线
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  color: 'var(--td-text-color-secondary)',
                }}
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block text-sm font-medium"
                  style={{ color: 'var(--td-text-color-primary)' }}
                >
                  {label}
                </span>
                <span className="block truncate text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  {hint}
                </span>
              </span>
              <ExternalLink size={13} style={{ color: 'var(--td-text-color-placeholder)' }} />
            </a>
          ))}
        </div>
      </div>

      {/* ── 隐私 ─────────────────────────────────────────────── */}
      <div
        className="rounded-xl p-4 sm:p-5"
        style={{
          backgroundColor: 'var(--tc-layer-2)',
          border: '1px solid var(--tc-edge)',
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: 'var(--td-brand-color)' }} />
          <h3 className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            匿名使用统计
          </h3>
        </div>

        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>
            会话记录、生成图片和 Agent 配置保存在本机。仅在构建版本配置了统计端点且开关开启时，
            应用才会上报下列匿名使用统计；统计请求不包含聊天内容或本地文件信息。
          <a
            href={`${SITE_URL}/privacy.html`}
            target="_blank"
            rel="noreferrer"
            className="ml-1"
            style={{ color: 'var(--td-brand-color)', textDecoration: 'none' }}
          >
            完整说明
          </a>
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
              会发送
            </div>
            <ul className="space-y-1.5">
              {COLLECTED.map(item => (
                <li key={item} className="flex items-start gap-2 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                  <Check size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--td-success-color)' }} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
              绝不会发送
            </div>
            <ul className="space-y-1.5">
              {NOT_COLLECTED.map(item => (
                <li key={item} className="flex items-start gap-2 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                  <X size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--td-error-color)' }} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className="mt-5 flex items-center justify-between gap-4 border-t pt-4"
          style={{ borderColor: 'var(--td-component-border)' }}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
              允许发送匿名统计
            </div>
          <div className="mt-0.5 text-xs leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {/* 用 !state 而不是 state === null：桥返回异常值（undefined）时
                  也必须落到「读取中」分支，不能直接读 .available 崩掉整页 */}
              {!state
                ? '正在读取当前状态…'
                : !state.available
                  ? '此版本未配置统计端点，不会发送任何数据。'
                  : state.enabled
                    ? state.sessionActive
                      ? '已开启，本次使用正在被记录。关闭后立即停止。'
                      : '已开启，下次启动开始记录。'
                    : '已关闭，不会发送任何数据。'}
            </div>
          </div>
          <Switch
            value={!!state?.enabled}
            disabled={!state?.available || busy}
            onChange={v => void toggle(!!v)}
            aria-label="匿名使用统计开关"
          />
        </div>
      </div>

      {/* ── 协议与声明 ───────────────────────────────────────── */}
      <div className="space-y-1.5 text-xs leading-relaxed" style={{ color: 'var(--td-text-color-placeholder)' }}>
        <p>
          本项目以 <span style={{ color: 'var(--td-text-color-secondary)' }}>MIT</span> 协议开源。
        </p>
        <p>
          OPC Agent 是独立第三方工具，与 WorkBuddy、Codex、Gemini、Claude Code 等产品无隶属关系，
          相关名称与商标归各自所有者。使用第三方 Agent 时，你的调用仍受对应服务商条款约束。
        </p>
      </div>
    </div>
  );
}
