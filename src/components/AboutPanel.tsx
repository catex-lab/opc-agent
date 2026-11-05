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
 *      ⚠️ 别把这段话加回来 —— 除非仓库真的转为公开。
 *   4. 引导点星。点星对开源项目是零成本的支持，但**不能做成弹窗骚扰** ——
 *      放在关于页里，用户主动看到，愿意点就点。
 *
 * 为什么不再给「完整说明」外链：旧文案指向官网的 privacy.html，
 * 但该页是否存在从未核实过，而正文已经把该说的说完（数据在哪、
 * 什么会离开本机、源码在哪）。宁可少一个可能 404 的链接。
 *
 * ── 2026-10-30 重设计（单栏统一卡片）─────────────────────────────────
 * 用户反馈：居中的大身份牌位 + 下方左对齐的隐私/入口/许可三段放在同一页
 * 节奏不一致，像六块同级面板。改成「一页文档」：
 *   · 顶部退化成一条左对齐的细身份条（小 Logo + 名称 + 版本 + 定位句，
 *     右侧构建信息），不再居中、不再有大留白；
 *   · 隐私 = 眉标 + 一句陈述 + 三段式块（只存在本机 / 离开本机 / 第三方 Agent），
 *     废掉 dt/dd 对账表，三段都用「小标题 + 内容」的同一结构；
 *   · 点星引导从身份条中拆出，作为独立一区（data-about-star 挂在这张卡上）；
 *   · 入口 = 列表行（整行可点，hover 换底）；
 *   · 页脚 = 法务小字 + 两列许可清单。
 * 结构变了，但 `data-about-*` 这几个锚点（privacy / link / star / feedback /
 * licenses）**一个都没动** —— verify:a141 靠它们定位，重构时别顺手删。
 */
import { useEffect, useState } from 'react';
import {
  Github,
  Star,
  ShieldCheck,
  MessageSquare,
  ChevronRight,
  ChevronDown,
  Package,
  ExternalLink,
} from 'lucide-react';
import appIcon from '../assets/app-icon.png';
import UpdateCard from './UpdateCard';

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
 * 隐私声明的三条合规文案。
 *
 * 用户确认（2026-11-04）：这三条必须**始终可见**，每张卡一行标题 + 一句说明；
 * 不许收进 ⓘ 图标，也不许折叠成可展开区 —— 它们是这一页的合规底线。
 * 标题与正文都保持一句话，避免把「不收集」说成一段需要读完的长文。
 */
const PRIVACY = [
  {
    title: '不收集任何信息',
    body: '没有遥测、埋点、崩溃上报，也没有安装 ID；全部数据只存在本机。',
  },
  {
    title: '只会发给你自己配置的模型服务商',
    body: '只有你发消息时的对话内容会离开本机，不经过任何中转服务器。',
  },
  {
    title: '永久免费且无广告',
    body: '不收费、不投放广告，也没有付费墙；点星是唯一的外部支持入口。',
  },
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
  { name: '@tencent-ai/agent-sdk', license: 'MIT', holder: 'Tencent（含内嵌 CodeBuddy CLI）' },
  // 内嵌子包，2026-10-31 起随安装包分发（+约 109MB）。它自述「许可见 README.md」
  // 而 README 没随包发布 —— 页面上如实写「条款缺失」，不替它编一个许可。
  { name: '@tencent-ai/codebuddy-code', license: '条款缺失', holder: 'Tencent · 内嵌于 agent-sdk/cli' },
  // 2026-10-31：三个 SDK 通道接入后，随包分发的直接依赖多了三项。
  // Claude 那条是**专有许可**，不是 MIT/Apache —— 页面上必须写清楚，
  // 否则读者会以为安装包里全是宽松许可。
  { name: '@anthropic-ai/claude-agent-sdk', license: '专有（非开源）', holder: 'Anthropic PBC · © All rights reserved（含 claude.exe）' },
  { name: '@openai/codex-sdk', license: 'Apache-2.0', holder: 'OpenAI（含平台二进制）' },
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
    <div>
      {/* ── 顶部版本条（单行）────────────────────────────────────
          用户确认（2026-11-04）：整块压成一行 —— 名称与版本为主色，
          Electron / Node / 平台走次级字色，图标保留。原来「名称一行、
          定位句一行、构建信息另起一行靠右」的三行头会把更新区挤下去。 */}
      <header className="tc-about-topbar" data-about-version-line>
        <div className="tc-about-tile tc-about-tile--sm">
          <img src={appIcon} alt="" />
        </div>
        <span className="tc-about-name">{info?.name || 'OPC Agent'}</span>
        <span className="tc-about-ver">v{info?.version || '—'}</span>
        <span className="tc-about-build" data-about-runtime>{buildLine}</span>
      </header>

      {/* ── 更新 ──────────────────────────────────────────────────
          放在身份条之后：用户来这一页最常问「我这是不是最新版」。
          检查/下载/重启的状态机与主进程一致（见 UpdateCard 顶部说明）。 */}
      <UpdateCard />

      {/* ── 隐私：三张常驻条目卡 ──────────────────────────────────
          用户确认（2026-11-04）：合规文案必须一眼可见，做成三张条目卡
          （一行标题 + 一句说明），始终展开；不装进 ⓘ、不做页签、不加开关。 */}
      <div className="tc-about-zone" data-about-privacy>
        <div className="tc-about-eyebrow">
          <ShieldCheck />
          隐私
        </div>
        <div className="tc-about-privacy-cards">
          {PRIVACY.map(item => (
            <section className="tc-about-privacy-card" data-about-privacy-card key={item.title}>
              <h4 className="tc-about-privacy-card-title">{item.title}</h4>
              <p className="tc-about-privacy-card-body">{item.body}</p>
            </section>
          ))}
        </div>
      </div>

      {/* ── 点星引导卡 ──────────────────────────────────────────
          从 hero 中拆出，作为独立一区。`data-about-star` 挂在这张卡上
          （verify:a141 按这个锚点读「点个星」+「不收费/不收集」文案，
          以及内部的 `data-about-star-cta` 按钮）。 */}
      <div className="tc-about-zone tc-about-star-zone" data-about-star>
        <div className="tc-about-eyebrow">
          <Star aria-hidden="true" />
          支持
        </div>
        {/* 一句话、不折行（不插 <br>）：两句话是同一段注脚，断在中间会让
            第二句读起来像另一条独立声明。宽度不够时按容器自然换行。 */}
        <p className="tc-about-quiet">
          本项目不收费、不投放广告、也不收集数据。如果它帮到了你，<b>点个星</b>就是最实际的支持。
        </p>
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

      {/* ── 官方入口：列表行 ───────────────────────────────────── */}
      <div className="tc-about-zone">
        <div className="tc-about-eyebrow">
          <ExternalLink aria-hidden="true" />
          官方入口
        </div>
        <div className="tc-about-rows">
          {LINKS.map(({ key, href, label, hint, Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="tc-about-row"
              data-about-link={key}
            >
              <Icon className="tc-about-row-lead" />
              <span className="tc-about-row-label">{label}</span>
              <span className="tc-about-row-meta">{hint}</span>
              <ChevronRight className="tc-about-row-go" />
            </a>
          ))}

          <a
            href={ISSUE_URL}
            target="_blank"
            rel="noreferrer"
            className="tc-about-row"
            data-about-feedback
          >
            <MessageSquare className="tc-about-row-lead" />
            <span className="tc-about-row-label">反馈问题</span>
            <span className="tc-about-row-meta">Issues · 附上版本号会更快定位</span>
            <ChevronRight className="tc-about-row-go" />
          </a>
        </div>
      </div>

      {/* ── 页脚：法务小字 + 许可清单 ──────────────────────────── */}
      <div className="tc-about-zone">
        <p className="tc-about-legal">
          本项目以 <b>MIT</b> 协议开源。OPC Agent 是独立第三方工具，与 WorkBuddy、Codex、Gemini、Claude Code 等产品无隶属关系，相关名称与商标归各自所有者；使用第三方 Agent 时，你的调用仍受对应服务商条款约束。
        </p>

        {/* 用原生 <details>：这里不需要状态，也不需要 TDesign 的折叠面板 ——
            多引一个组件只为了一次展开，成本比收益高。 */}
        <details className="tc-about-lic" open data-about-licenses>
          <summary>
            <Package />
            第三方许可
            <span className="tc-about-count">{THIRD_PARTY.length} 个组件</span>
            <span className="tc-about-caret">
              <ChevronDown />
            </span>
          </summary>

          <div className="tc-about-lic-grid">
            {THIRD_PARTY.map(item => (
              <div key={item.name} className="tc-about-lic-item">
                <span className="tc-about-lic-name">{item.name}</span>
                <span className="tc-about-lic-tag">{item.license}</span>
              </div>
            ))}
          </div>

          {/* 不写死组件数量：依赖一变数字就过期。以清单文件为准。 */}
          <p className="tc-about-lic-note">
            这些组件不在本项目的 MIT 范围内，各自适用自己的许可。含传递依赖的完整清单见仓库根目录 THIRD-PARTY-LICENSES.txt。
          </p>
        </details>
      </div>
    </div>
  );
}
