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
  Check,
  MessageSquare,
  ChevronRight,
  ChevronDown,
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
      {/* ── 顶部身份条 ────────────────────────────────────────────
          退化成一条左对齐的细条：小 logo + 名称 + 版本 + 一句话定位，
          右侧是构建信息。不再居中、不再有大留白 —— 与下方各分区共用
          同一套左对齐节奏，整页读起来像一份文档而不是六个同级面板。 */}
      <header className="tc-about-topbar">
        <div className="tc-about-topbar-id">
          <div className="tc-about-tile tc-about-tile--sm">
            <img src={appIcon} alt="" />
          </div>
          <div className="tc-about-topbar-text">
            <div className="tc-about-name-row">
              <span className="tc-about-name">{info?.name || 'OPC Agent'}</span>
              <span className="tc-about-ver">v{info?.version || '—'}</span>
            </div>
            <p className="tc-about-tagline">把本机的各种 Agent，当作通讯录里的联系人。</p>
          </div>
        </div>
        <p className="tc-about-build">{buildLine}</p>
      </header>

      {/* ── 隐私：陈述句 + 三段式 ─────────────────────────────────
          废掉 dt/dd 对账表：三段（只存在本机 / 离开本机 / 第三方 Agent）
          都用同一种「小标题 + 内容」的块结构，与入口、许可两区的卡片
          节奏一致。 */}
      <div className="tc-about-zone" data-about-privacy>
        <div className="tc-about-eyebrow">
          <ShieldCheck />
          隐私
        </div>
        <div className="tc-about-statement">不收集任何信息</div>

        <div className="tc-about-blocks">
          <section className="tc-about-block">
            <h4 className="tc-about-block-label">只存在本机</h4>
            <ul className="tc-about-keep">
              {LOCAL_ONLY.map(item => (
                <li key={item}>
                  <Check />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="tc-about-block">
            <h4 className="tc-about-block-label">离开本机</h4>
            {/* 整句写成一行、不留换行：JSX 会把换行折叠成一个空格，
                于是「发送给 你自己配置的模型服务商 ，这是功能本身」——
                中文里凭空多出两格空白。标点必须紧贴相邻元素。 */}
            <p className="tc-about-block-body">
              只有你发消息时的对话内容，它会被发送给你<strong>自己配置的模型服务商</strong>，这是功能本身，不是收集。
              <span className="tc-about-dim">
                应用不经过任何中转服务器，也没有自建后端；你点开的外链交给系统浏览器打开。
              </span>
            </p>
          </section>

          {/* 2026-10-29：把「只存在本机」限定到本应用自身 —— 你接入的第三方 Agent
              （腾讯 WorkBuddy、Anthropic Claude Code 等）是各自厂商的产品，
              其自身行为（含各自的遥测/条款）不受本应用控制。
              这句是必要的：应用自身零遥测（A141），但部分 Agent 的 CLI 自带
              厂商侧的上报端点，不声明会被误解为「WorkBuddy 也不外发」。 */}
          <section className="tc-about-block">
            <h4 className="tc-about-block-label">第三方 Agent</h4>
            <p className="tc-about-block-body tc-about-dim">
              以上是本应用自身的承诺。你接入的第三方 Agent（如腾讯 WorkBuddy、Anthropic Claude Code 等）是各自厂商的产品，其自身行为不受本应用控制。
            </p>
          </section>
        </div>
      </div>

      {/* ── 点星引导卡 ──────────────────────────────────────────
          从 hero 中拆出，作为独立一区。`data-about-star` 挂在这张卡上
          （verify:a141 按这个锚点读「点个星」+「不收费/不收集」文案，
          以及内部的 `data-about-star-cta` 按钮）。 */}
      <div className="tc-about-zone tc-about-star-zone" data-about-star>
        <div className="tc-about-eyebrow">支持</div>
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
        <div className="tc-about-eyebrow">官方入口</div>
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
