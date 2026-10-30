/**
 * 设置 → 关于与隐私
 *
 * 这一页承担四件事，缺一不可：
 *   1. 告诉用户「这是什么东西、什么版本」—— 开源项目的支持成本，一半来自
 *      用户报 issue 时说不清自己装的哪一版。
 *   2. 给出官方入口 —— 源码、反馈。没有这些，用户只能去搜索引擎找，
 *      很容易装到改包。
 *      （2026-10-30：官网入口整条移除，详见文件末尾 LINKS 处的说明。）
 *   3. 把隐私讲清楚。A141 之后**应用本身不收集任何信息**：遥测模块
 *      （原 electron/analytics.ts）已整体删除，主进程没有任何出站上报，
 *      也没有安装 ID。所以这里不再需要「会发送 / 绝不会发送」两栏和一个
 *      开关 —— 开关存在的意义是「允许你少收集一点」，而现在没有可关的东西。
 *
 *      2026-10-29（需求）删掉了原先那句陈述：
 *        「本应用没有统计、没有埋点、没有崩溃上报，也没有安装 ID。
 *          源码里不存在任何遥测模块，全部代码在 GitHub 公开，可自行核验。」
 *      删的理由是**后半句兑现不了**：当时本仓远端还是 private（见 MEMORY.md §0），
 *      用户照着点进去只会看到 404。给一个点不通的「可自行核验」，比不给更伤信任。
 *      仓库公开后这半句重新成立，届时可把整段恢复成「可自行核验」。
 *      前半句（没有统计 / 埋点 / 崩溃上报）仍然是真的，但它已经由标题
 *      「不收集任何信息」+ 下方两栏明细覆盖，不必再用一段话重复一遍。
 *      ⚠️ 别把这段话加回来 —— 除非仓库真的转为公开。
 *   4. 引导点星。点星对开源项目是零成本的支持，但**不能做成弹窗骚扰** ——
 *      放在关于页里，用户主动看到，愿意点就点。
 *
 * 为什么不再给「完整说明」外链：旧文案指向官网的 privacy.html，
 * 但该页是否存在从未核实过，而正文已经把该说的说完（数据在哪、
 * 什么会离开本机、源码在哪）。宁可少一个可能 404 的链接。
 */
import { useEffect, useState } from 'react';
import {
  Github,
  Star,
  ExternalLink,
  ShieldCheck,
  Check,
  Bug,
  Package,
} from 'lucide-react';
import appIcon from '../assets/app-icon.png';

const REPO_URL = 'https://github.com/catex-lab/opc-agent';
const ISSUE_URL = `${REPO_URL}/issues`;

interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
}

interface AboutBridge {
  appInfo?: () => Promise<AppInfo>;
}

function bridge(): AboutBridge | undefined {
  return (window as unknown as { opc?: AboutBridge }).opc;
}

/**
 * 「只存在本机」的清单。
 *
 * 刻意具体到目录/字段级 —— 「你的数据是安全的」这种话等于没说，
 * 用户真正想知道的是「我删掉哪个文件夹就等于删干净了」。
 */
const LOCAL_ONLY = [
  '会话记录与全部消息历史（data/chat.db）',
  '生成的图片缓存（data/images/）',
  'Agent 配置、模型厂商与凭据',
  '工作区路径、偏好设置与界面状态',
];

/**
 * 外部入口。
 *
 * 2026-10-30：官网那条**整条移除**（用户口径是「暂时移除代码与远端仓库里关于
 * 官网域名的任何内容，只保留在本地」）。恢复办法与原始片段记在
 * `.tmp-audit/domain-removed-2026-10-30.md`（本地文件，`.tmp-*` 已 gitignore）。
 * 注意 `verify:a141` 的「入口」断言从两条变一条 —— 条数变少不是挂了。
 */
const LINKS = [
  {
    key: 'github',
    href: REPO_URL,
    label: 'GitHub 开源仓库',
    hint: 'catex-lab/opc-agent · 源码与更新日志',
    Icon: Github,
  },
];

/**
 * 随安装包分发的第三方组件（直接依赖）。
 *
 * 为什么这一页必须有它：本项目自身是 MIT，但安装包里装的不止 `dependencies`。
 * MIT 与 Apache-2.0 都要求「分发副本时保留版权与许可声明」，而 electron-builder.yml
 * 为了减小包体把依赖里的 LICENSE 文件全排除了 —— 这条义务就落到了这里。
 *
 * ⚠️ 两类都要列，漏一类就等于漏了半张清单：
 *   1. `dependencies` —— 原样进 app.asar 的生产依赖树；
 *   2. 前端 devDependencies 里**被 Vite 内联进 dist** 的那些（react / tdesign /
 *      lucide / xterm / react-router）。它们写在 devDependencies 里，看起来
 *      「不进包」，但构建产物里就是它们的代码。
 * 之前只列了第 1 类，2026-10-29 审计时发现并补上（A149）。
 *
 * 只列直接依赖，不列 200+ 个传递依赖（那是 THIRD-PARTY-LICENSES.txt 的活）。
 * 不写版本号：版本随 package.json 漂移，写死必然过期；以清单文件为准。
 */
const THIRD_PARTY = [
  { name: 'Electron', license: 'MIT', holder: 'Electron contributors（运行时含 Chromium）' },
  { name: '@tencent-ai/agent-sdk', license: 'MIT', holder: 'Tencent' },
  { name: 'express', license: 'MIT', holder: 'TJ Holowaychuk 等贡献者' },
  { name: 'node-pty', license: 'MIT', holder: 'Christopher Jeffrey / Microsoft' },
  { name: 'uuid', license: 'MIT', holder: 'Robert Kieffer 等贡献者' },
  { name: 'typescript', license: 'Apache-2.0', holder: 'Microsoft Corp.' },
  // ↓ 前端打包（devDependencies，但代码在 dist 里）
  { name: 'react / react-dom', license: 'MIT', holder: 'Meta Platforms, Inc.' },
  { name: 'tdesign-react', license: 'MIT', holder: 'TDesign' },
  { name: '@tdesign-react/chat', license: 'MIT', holder: 'TDesign' },
  { name: 'lucide-react', license: 'ISC', holder: 'Lucide contributors' },
  { name: 'react-router-dom', license: 'MIT', holder: 'Remix Software' },
  { name: '@xterm/xterm', license: 'MIT', holder: 'xterm.js contributors' },
];

export default function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    // 浏览器里跑（无 preload）时接口不存在，页面降级成纯说明文字。
    // 即便存在也要过滤掉空返回：桥返回 undefined 时不能让 state 变成 undefined。
    void bridge()?.appInfo?.().then(v => { if (v) setInfo(v); }).catch(() => undefined);
  }, []);

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
          查看应用版本、隐私承诺与官方入口。
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

      {/* ── 隐私承诺 ─────────────────────────────────────────── */}
      <div
        className="rounded-xl p-4 sm:p-5"
        style={{
          backgroundColor: 'var(--tc-layer-2)',
          border: '1px solid var(--tc-edge-strong)',
        }}
        data-about-privacy
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} style={{ color: 'var(--td-text-color-primary)' }} />
          <h3 className="text-title font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            不收集任何信息
          </h3>
        </div>

        {/* 2026-10-29：这里原有一段「没有统计、没有埋点、没有崩溃上报、
            源码里不存在任何遥测模块，全部代码在 GitHub 公开，可自行核验」。
            当时删掉是因为仓库还是 private，「可自行核验」兑现不了。
            仓库公开后这半句重新成立，届时可把整段恢复成「可自行核验」。
            当前仍由「标题 + 两栏明细」把话说完整。 */}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            className="rounded-lg p-3"
            style={{ backgroundColor: 'var(--tc-layer-3)', border: '1px solid var(--tc-edge)' }}
          >
            <div className="mb-2 text-xs font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
              只存在本机，从不外发
            </div>
            <ul className="space-y-1.5">
              {LOCAL_ONLY.map(item => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-xs leading-5"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  <Check
                    size={13}
                    className="mt-0.5 shrink-0"
                    style={{ color: 'var(--td-success-color)' }}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div
            className="rounded-lg p-3"
            style={{ backgroundColor: 'var(--tc-layer-3)', border: '1px solid var(--tc-edge)' }}
          >
            <div className="mb-2 text-xs font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
              什么会离开本机
            </div>
            {/* 整句写成一行、不留换行：JSX 会把换行折叠成一个空格，
                于是「发送给 你自己配置的模型服务商 ，这是功能本身」——
                中文里凭空多出两格空白。标点必须紧贴相邻元素。 */}
            <p className="text-xs leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
              只有你发消息时的对话内容 —— 它会被发送给<span style={{ color: 'var(--td-text-color-primary)' }}>你自己配置的模型服务商</span>，这是功能本身，不是统计。
            </p>
            <p className="mt-2 text-xs leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
              应用不经过任何中转服务器，也没有自建后端。你点开的外链会交给系统浏览器打开。
            </p>
          </div>
        </div>

        {/* 2026-10-29：把「只存在本机」限定到本应用自身 —— 你接入的第三方 Agent
            （腾讯 WorkBuddy、Anthropic Claude Code 等）是各自厂商的产品，
            其自身行为（含各自的遥测/条款）不受本应用控制。
            这句是必要的：应用自身零遥测（A141），但依赖 @tencent-ai/agent-sdk
            的 CLI 内置腾讯内部上报端点（*.woa.com），不声明会被误解为
            「WorkBuddy 也不外发」。 */}
        <p className="mt-3 text-xs leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
          以上是本应用自身的承诺。你接入的第三方 Agent（如腾讯 WorkBuddy、Anthropic Claude Code 等）是各自厂商的产品，其自身行为不受本应用控制。
        </p>
      </div>

      {/* ── 官方入口 ─────────────────────────────────────────── */}
      <div>
        <h3 className="mb-2 text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
          官方入口
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LINKS.map(({ key, href, label, hint, Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center gap-3 rounded-xl p-3 transition-colors"
              style={{
                backgroundColor: 'var(--tc-layer-2)',
                border: '1px solid var(--tc-edge)',
                // 全局 a 有品牌色 + 下划线，这里必须显式压掉 ——
                // 否则卡片里的说明文字会变成一整片下划线
                textDecoration: 'none',
                color: 'inherit',
              }}
              data-about-link={key}
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
                  className="block truncate text-sm font-medium"
                  style={{ color: 'var(--td-text-color-primary)' }}
                >
                  {label}
                </span>
                <span
                  className="block truncate text-xs"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  {hint}
                </span>
              </span>
              <ExternalLink size={13} style={{ color: 'var(--td-text-color-placeholder)' }} />
            </a>
          ))}
        </div>
      </div>

      {/* ── 点星引导 ─────────────────────────────────────────── */}
      <div
        className="flex flex-col gap-4 rounded-xl p-4 sm:flex-row sm:items-center sm:p-5"
        style={{
          backgroundColor: 'var(--tc-layer-3)',
          border: '1px solid var(--tc-edge-strong)',
        }}
        data-about-star
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: 'var(--tc-solid)', color: 'var(--tc-on-brand)' }}
        >
          <Star size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
            觉得好用就给项目点个星
          </div>
          <div
            className="mt-0.5 text-xs leading-5"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            这个项目不收费、不投放广告、不收集数据，唯一需要的就是一点关注度。
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={ISSUE_URL}
            target="_blank"
            rel="noreferrer"
            className="tc-btn-secondary inline-flex items-center gap-1.5"
            style={{ textDecoration: 'none' }}
            data-about-feedback
          >
            <Bug size={14} />
            反馈问题
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="tc-btn-brand"
            style={{ textDecoration: 'none' }}
            data-about-star-cta
          >
            <Star size={14} />
            去 GitHub 点星
          </a>
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

      {/* ── 第三方许可 ───────────────────────────────────────── */}
      {/* 用原生 <details>：这里不需要状态，也不需要 TDesign 的折叠面板 ——
          多引一个组件只为了一次展开，成本比收益高。 */}
      <details
        className="rounded-xl p-4 sm:p-5"
        style={{ backgroundColor: 'var(--tc-layer-2)', border: '1px solid var(--tc-edge)' }}
        data-about-licenses
      >
        <summary
          className="cursor-pointer text-sm font-medium"
          style={{ color: 'var(--td-text-color-primary)' }}
        >
          <Package
            size={14}
            style={{
              color: 'var(--td-text-color-secondary)',
              verticalAlign: '-2px',
              marginRight: 6,
            }}
          />
          第三方许可
          <span
            className="ml-2 text-xs font-normal"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            随安装包分发的主要组件
          </span>
        </summary>

        <p className="mt-3 text-xs leading-5" style={{ color: 'var(--td-text-color-secondary)' }}>
          本项目自身以 MIT 协议开源。安装包里打进了下面这些第三方组件，它们各自适用自己的许可，
          <span style={{ color: 'var(--td-text-color-primary)' }}>不在本项目的 MIT 范围内</span>。
        </p>

        <ul className="mt-2 space-y-1.5">
          {THIRD_PARTY.map(item => (
            <li
              key={item.name}
              className="flex items-start gap-2 text-xs leading-5"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              <span
                className="shrink-0 rounded px-1.5"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  color: 'var(--td-text-color-placeholder)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {item.license}
              </span>
              <span className="min-w-0">
                <span style={{ color: 'var(--td-text-color-primary)' }}>{item.name}</span>
                <span style={{ color: 'var(--td-text-color-placeholder)' }}> · {item.holder}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* 不写死组件数量：依赖一变数字就过期。以清单文件为准。 */}
        <p className="mt-3 text-xs leading-5" style={{ color: 'var(--td-text-color-placeholder)' }}>
          含传递依赖的完整清单随源码发布，见仓库根目录的 THIRD-PARTY-LICENSES.txt；
          各组件的许可全文随其包内 LICENSE 文件分发。
        </p>
      </details>
    </div>
  );
}
