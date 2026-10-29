/* OPC Agent 官网 v2 中英文案字典 + 切换逻辑（自包含）
 *
 * 约定（与旧版 site/assets/i18n.js 对齐）：
 *   - 键名用点号分组，与 index.html 里的 data-i18n 一一对应
 *   - data-i18n        → 替换 textContent（纯文本）
 *     data-i18n-html   → 替换 innerHTML（仅限本地静态文案，允许 <code>/<a>/<p>；
 *                        不要把任何来自 URL 或接口的内容拼进来）
 *     data-i18n-attr   → "attr:key;attr2:key2"，替换属性（alt / aria-label）
 *   - 英文按母语习惯写，不做逐字直译
 *   - 由 app.js 动态渲染的文案（演示剧本、版本大小、更新日志兜底）
 *     不打 data-i18n，由 app.js 监听 opc:langchange 自行重绘
 */
window.OPC_I18N = {
  zh: {
    'meta.title': 'OPC Agent — 单聊、拉群、派活儿',
    'meta.description': 'OPC Agent 是一款本机多 Agent 团队协作的桌面应用：把 WorkBuddy、Codex、Gemini、Claude Code 等装进通讯录，一对一单聊，或拉群分派任务。',

    'announce': '🎉 OPC Agent 开放下载 — 把本机的 AI Agent 变成一支团队',
    'nav.features': '特性', 'nav.screens': '界面', 'nav.modes': '编排模式',
    'nav.start': '快速开始', 'nav.changelog': '更新日志', 'nav.faq': 'FAQ',
    'nav.download': '免费下载',

    'hero.title': '单聊、拉群、派活儿。',
    'hero.sub': 'OPC Agent 把本机装过的 AI Agent 变成通讯录里的联系人：WorkBuddy、Codex、Gemini、Claude Code —— 装了什么就有什么，一对一深聊，或者拉个群把任务分下去。',
    'hero.cta': '下载 Windows 版',
    'hero.cta2': '在 GitHub 查看',
    'hero.note': '适用于 Windows 10 / 11（x64）· 免费 · 无需注册账号',
    'chips.more': '…持续接入中',

    'demo.aria': 'OPC Agent 界面演示：多个 Agent 在群里协作完成任务',
    'demo.search': '搜索会话',
    'demo.prev1': '已汇总：子任务 4/4 完成',
    'demo.groupName': '五子棋分享筹备群',
    'demo.prev2': 'Codex：测试全部通过 ✓',
    'demo.none': '还没有消息',
    'demo.none2': '还没有消息',
    'demo.yesterday': '昨天',
    'demo.prev3': '大纲第三稿已写好',
    'demo.members': '5 人 · 4 在线',
    'demo.today': '今天',
    'demo.caption': '▲ 演示：拉一个群，@ 谁、谁干活 —— 主控 Agent 自动分派、追踪与汇总',

    'ver.local': '数据全在本机',
    'ver.size': '安装版 ≈ 144 MB',
    'ver.sizePrefix': '安装版 ≈ ',

    'features.title': '一个人，带一支不眠的团队',
    'features.sub': '不用记每个 CLI 的参数，也不用再开十几个终端窗口。Agent 不是配置项，是联系人。',
    'f1.title': 'Agent 通讯录',
    'f1.desc': '自动发现本机已安装的 Agent，头像、在线状态、未读红点一应俱全。装了什么就有什么，不需要手动登记。',
    'f2.title': '多 Agent 群聊',
    'f2.desc': '把多个 Agent 拉进同一个群：同屏对话、横向对比、互相接力。五种编排模式决定谁先说、谁接手。',
    'f3.title': '工作区面板',
    'f3.desc': '内置真 PTY 终端、浏览器与文件树：Agent 改了哪个文件、跑了哪条命令，当场可见，不用切窗口。',
    'f4.title': '权限门禁',
    'f4.desc': '危险命令默认拦截，文件写入与命令执行可设为逐次确认。四档权限模式逐档落地，从不虚标。',
    'f5.title': '会画图的联系人',
    'f5.desc': '生图 Provider 同样挂在通讯录里。生成的图片自动落盘缓存，历史消息里的图永远不会裂开。',
    'f6.title': '本地优先',
    'f6.desc': '会话、图片、配置全部存在本机 SQLite。没有云端账号，删掉数据目录就是彻底删掉。',

    'screens.title': '左边是谁，右边是它正在干什么',
    'screens.sub': '消息列表、对话区、工作区面板 —— 和你熟悉的 IM 一个布局，不需要重新学习。',
    'screens.shotAlt': 'OPC Agent 主界面：左侧是 Agent 会话列表，右侧是带工具调用过程的对话区',
    'screens.shotAltContacts': 'Agent 通讯录：自动列出本机已安装的 Agent，带头像与在线状态',
    'screens.capChat': '对话 — Agent 的读取、执行、搜索过程折叠成一行，点开就是全部细节',
    'screens.capContacts': '通讯录 — 本机装了什么就出现什么，未登录的如实标注',
    'screens.capWorkspace': '工作区 — 左边聊着，右边文件树实时更新',

    'modes.title': '五种编排，五种用法',
    'modes.sub': '群聊不只是「大家轮流说」。同一句话，用不同的编排发出去，得到的是完全不同的协作形态。',
    'modes.default': '默认',
    'm1.title': '分派',
    'm1.desc': '主控 Agent 读任务、判断该谁做、派发并汇总结果。你说一句话，剩下的它来安排。',
    'm2.title': '广播',
    'm2.desc': '群内所有 Agent 各自独立作答，同屏横向对比。选模型、比风格，一眼定稿。',
    'm3.title': '接力',
    'm3.desc': '串行流水线，前者的输出是后者的输入：Codex 写码 → Gemini 审查 → Claude 写文档。',
    'm4.title': '辩论',
    'm4.desc': '指定正反方，多轮交替交锋，最后收敛成结论。技术选型吵不出结果？让它们吵给你看。',
    'm5.title': '指定',
    'm5.desc': '@ 谁、谁唤醒。只想麻烦某一位的时候，别惊动整个群。',
    'flow.me': '我', 'flow.lead': '主控', 'flow.summary': '汇总',
    'flow.code': '写码', 'flow.review': '审查', 'flow.docs': '文档',
    'flow.pro': '正方', 'flow.con': '反方', 'flow.verdict': '结论',

    'start.title': '三步跑起来',
    'start.calloutTitle': '使用前提',
    'start.calloutBody': 'OPC Agent 不内置模型，它负责把你本机已有的 Agent 组织起来。请先在终端登录至少一个 Agent CLI（推荐 <code>codebuddy login</code>）。没有凭据时应用能装能开，但发消息会提示未授权 —— 这是设计如此，不是安装失败。',
    's1.title': '下载并安装',
    's1.desc': '安装包未做代码签名，首次运行会弹 SmartScreen 提示，处理方式见 FAQ。',
    's2.title': '登录你的 Agent',
    's2.desc': '在终端里登录一次，OPC Agent 会自动复用这份凭据。',
    's3.title': '启动，拉群，派活',
    's3.desc': '左侧通讯录自动列出可用的 Agent。单聊，或者拉个群选一种编排模式，把任务发出去。',

    'dl.title': '下载 OPC Agent',
    'dl.current': '当前版本',
    'dl.free': '免费',
    'dl.setup': '安装版',
    'dl.rec': '推荐',
    'dl.setupDesc': 'NSIS 安装向导，可选安装目录，自动创建快捷方式；支持后续自动更新，卸载时保留聊天记录。',
    'dl.portable': '便携版',
    'dl.portableDesc': '单文件免安装，U 盘可用。不支持自动更新，升级需手动下载替换。',
    'dl.foot': '历史版本与校验文件见 <a data-releases href="https://github.com/catex-lab/opc-agent/releases" target="_blank" rel="noopener">GitHub Releases</a>。下载链接经由本站中转（<span class="mono">/d/*</span>）做匿名计数，不留个人身份信息。',

    'changelog.title': '最近发布的版本',
    'changelog.more': '查看全部版本 →',
    'changelog.empty': '更新日志将在首个版本发布到 GitHub Releases 后自动出现在这里。',

    'faq.title': '你可能想先知道这些',
    'q1.q': 'Windows 提示「已保护你的电脑」，怎么办？',
    'q1.a': '<p>这是 SmartScreen 对未签名程序的默认提示 —— 个人代码签名证书一年数千元，本项目没有购买。点击「更多信息 → 仍要运行」即可；也可以右键安装包 → 属性 → 勾选「解除锁定」。</p>',
    'q2.q': '为什么装完了发消息没反应？',
    'q2.a': '<p>OPC Agent 不内置模型，它调用的是你本机已装好并登录的 Agent。先在终端执行 <code>codebuddy login</code>（或配置对应 Agent 的 API Key），再重启应用。通讯录是空的，说明本机没有检测到任何 Agent CLI。</p>',
    'q3.q': '安装版和便携版有什么区别？',
    'q3.a': '<p>功能完全一致。安装版（<code>-setup.exe</code>）支持自动更新与快捷方式，卸载时可选保留数据；便携版（<code>-portable.exe</code>）免安装、可放 U 盘，但不自动更新。</p>',
    'q4.q': '我的聊天内容会被上传吗？',
    'q4.a': '<p>不会。会话记录、生成图片、Agent 配置都保存在本机数据目录，不上传任何服务器。</p><p>当前公开构建没有配置统计端点，也不会发送使用统计 —— 代码里不存在遥测模块。详见<a href="../privacy.html">隐私说明</a>。</p>',
    'q5.q': '支持 macOS 或 Linux 吗？',
    'q5.a': '<p>目前只发布 Windows x64 安装包。代码本身是跨平台的 Electron 应用，可以自行构建（<code>npm install</code> 后 <code>npm run electron:build</code>），但没有官方产物，也未做完整验证。</p>',
    'q6.q': '「待接入」状态的联系人是什么意思？',
    'q6.a': '<p>通讯录按本机实际探测结果如实展示：没装、装了没登录、或该 Agent 暂无可用的无头调用方式，都会标出来并给出下一步指引。我们坚持「点得动的按钮才给点」。</p>',

    'cta.title': '现在，拉第一个群。',
    'cta.sub': '无需注册 OPC 账号。应用在本机运行，调用你选择的 Agent 服务。',
    'cta.button': '下载 Windows 版',

    'footer.tag': '把本机的 AI Agent，变成一支团队。',
    'footer.source': '源码', 'footer.download': '下载', 'footer.issues': '反馈问题',
    'footer.privacy': '隐私说明', 'footer.faq': 'FAQ',
    'footer.legal': '© 2026 OPC Agent · OPC Agent 是独立第三方工具，与 WorkBuddy、Codex、Gemini、Claude Code 等产品无隶属关系，相关名称与商标归各自所有者。',
  },

  en: {
    'meta.title': 'OPC Agent — Chat. Group. Delegate.',
    'meta.description': 'OPC Agent is a local-first desktop app for multi-agent teamwork: WorkBuddy, Codex, Gemini, Claude Code and friends become contacts. Chat one-on-one, or start a group and dispatch the work.',

    'announce': '🎉 OPC Agent is out — turn your local AI agents into a team',
    'nav.features': 'Features', 'nav.screens': 'Screens', 'nav.modes': 'Orchestration',
    'nav.start': 'Quick start', 'nav.changelog': 'Changelog', 'nav.faq': 'FAQ',
    'nav.download': 'Download',

    'hero.title': 'Chat. Group. Delegate.',
    'hero.sub': 'OPC Agent turns the AI agents already on your machine into contacts: WorkBuddy, Codex, Gemini, Claude Code — whatever is installed shows up. Chat one-on-one, or start a group and hand out tasks.',
    'hero.cta': 'Download for Windows',
    'hero.cta2': 'View on GitHub',
    'hero.note': 'Windows 10 / 11 (x64) · Free · No account required',
    'chips.more': '…more coming',

    'demo.aria': 'OPC Agent interface demo: several agents collaborating in a group chat',
    'demo.search': 'Search chats',
    'demo.prev1': 'Wrapped up: 4/4 subtasks done',
    'demo.groupName': 'Gomoku Launch Prep',
    'demo.prev2': 'Codex: all tests pass ✓',
    'demo.none': 'No messages yet',
    'demo.none2': 'No messages yet',
    'demo.yesterday': 'Yesterday',
    'demo.prev3': 'Third draft of the outline is ready',
    'demo.members': '5 members · 4 online',
    'demo.today': 'Today',
    'demo.caption': '▲ Demo: start a group and @ whoever should work — the lead agent dispatches, tracks and summarizes',

    'ver.local': 'All data stays local',
    'ver.size': 'Setup ≈ 144 MB',
    'ver.sizePrefix': 'Setup ≈ ',

    'features.title': 'One person, a team that never sleeps',
    'features.sub': 'No CLI flags to memorize, no dozen terminal windows. Agents aren’t config entries — they’re contacts.',
    'f1.title': 'Agent directory',
    'f1.desc': 'Discovers the agents already installed on your machine — avatars, presence, unread badges and all. Nothing to register by hand.',
    'f2.title': 'Multi-agent group chat',
    'f2.desc': 'Pull several agents into one group: side-by-side conversation, comparison, hand-offs. Five orchestration modes decide who speaks first and who takes over.',
    'f3.title': 'Workspace panels',
    'f3.desc': 'A real PTY terminal, browser and file tree built in: which file an agent touched, which command it ran — visible on the spot, no window switching.',
    'f4.title': 'Permission gates',
    'f4.desc': 'Dangerous commands are blocked by default; file writes and shell runs can require confirmation every time. Four permission levels, all actually enforced.',
    'f5.title': 'Contacts that draw',
    'f5.desc': 'Image-generation providers live in the same directory. Generated images are cached to disk, so they never break in your history.',
    'f6.title': 'Local-first',
    'f6.desc': 'Conversations, images and config all live in a local SQLite database. No cloud account — delete the data directory and it’s gone.',

    'screens.title': 'Who’s on the left, what it’s doing on the right',
    'screens.sub': 'Session list, conversation, workspace panels — the IM layout you already know. Nothing to relearn.',
    'screens.shotAlt': 'OPC Agent main window: agent session list on the left, conversation with tool-call details on the right',
    'screens.shotAltContacts': 'Agent directory: every agent installed on your machine, with avatars and live status',
    'screens.capChat': 'Conversation — reads, runs and searches collapse into one line; expand for the full detail',
    'screens.capContacts': 'Directory — whatever is installed shows up here; unsigned-in agents are labeled honestly',
    'screens.capWorkspace': 'Workspace — chat on the left while the file tree updates on the right',

    'modes.title': 'Five modes, five ways to work',
    'modes.sub': 'A group chat isn’t just “everyone takes turns”. The same sentence, sent with a different orchestration, produces a completely different shape of teamwork.',
    'modes.default': 'Default',
    'm1.title': 'Dispatch',
    'm1.desc': 'The lead agent reads the task, decides who does what, dispatches and summarizes. You say one sentence; it arranges the rest.',
    'm2.title': 'Broadcast',
    'm2.desc': 'Every agent in the group answers independently, side by side. Compare models and styles, pick a winner at a glance.',
    'm3.title': 'Relay',
    'm3.desc': 'A serial pipeline where each output feeds the next: Codex writes code → Gemini reviews → Claude documents.',
    'm4.title': 'Debate',
    'm4.desc': 'Assign a pro and a con side, let them clash for rounds, then converge on a verdict. Can’t decide a tech choice? Let them argue it out for you.',
    'm5.title': 'Mention',
    'm5.desc': '@ someone and only they wake up. When you just need one of them, don’t disturb the whole room.',
    'flow.me': 'Me', 'flow.lead': 'Lead', 'flow.summary': 'Summary',
    'flow.code': 'Code', 'flow.review': 'Review', 'flow.docs': 'Docs',
    'flow.pro': 'Pro', 'flow.con': 'Con', 'flow.verdict': 'Verdict',

    'start.title': 'Up and running in three steps',
    'start.calloutTitle': 'Prerequisites',
    'start.calloutBody': 'OPC Agent ships no model of its own — it organizes the agents you already have. Sign in to at least one agent CLI in a terminal first (<code>codebuddy login</code> recommended). Without credentials the app installs and launches fine, but sending a message reports unauthorized — that’s by design, not a broken install.',
    's1.title': 'Download and install',
    's1.desc': 'The build isn’t code-signed, so SmartScreen will warn you once — see the FAQ for the fix.',
    's2.title': 'Sign in to your agent',
    's2.desc': 'Log in once from a terminal. OPC Agent reuses those credentials.',
    's3.title': 'Launch, group up, delegate',
    's3.desc': 'The directory fills with available agents automatically. Chat one-on-one, or start a group, pick an orchestration mode and send the task.',

    'dl.title': 'Download OPC Agent',
    'dl.current': 'Current version',
    'dl.free': 'Free',
    'dl.setup': 'Installer',
    'dl.rec': 'Recommended',
    'dl.setupDesc': 'NSIS setup wizard with a chooseable install directory and shortcuts; supports auto-update and keeps your chat history on uninstall.',
    'dl.portable': 'Portable',
    'dl.portableDesc': 'One file, no install, USB-stick friendly. No auto-update — replace it manually to upgrade.',
    'dl.foot': 'Archived versions and checksums live on <a data-releases href="https://github.com/catex-lab/opc-agent/releases" target="_blank" rel="noopener">GitHub Releases</a>. Download links go through this site’s redirect (<span class="mono">/d/*</span>) for anonymous counting — no personal information attached.',

    'changelog.title': 'Recent releases',
    'changelog.more': 'View all releases →',
    'changelog.empty': 'Release notes will appear here automatically once the first version ships to GitHub Releases.',

    'faq.title': 'Things worth knowing first',
    'q1.q': 'Windows says “protected your PC” — what now?',
    'q1.a': '<p>That’s SmartScreen reacting to an unsigned binary — a personal code-signing certificate costs thousands per year, which this project doesn’t pay for. Click <strong>More info → Run anyway</strong>; or right-click the installer → Properties → tick <strong>Unblock</strong>.</p>',
    'q2.q': 'Installed it, but sending a message does nothing?',
    'q2.a': '<p>OPC Agent ships no model — it drives agents already installed and signed in on your machine. Run <code>codebuddy login</code> in a terminal (or set the matching API key), then restart the app. An empty directory means no agent CLI was detected at all.</p>',
    'q3.q': 'Installer vs portable — what’s the difference?',
    'q3.a': '<p>Features are identical. The installer (<code>-setup.exe</code>) adds auto-update and shortcuts and can keep your data on uninstall; the portable build (<code>-portable.exe</code>) needs no install and fits on a USB stick, but doesn’t auto-update.</p>',
    'q4.q': 'Is my conversation uploaded anywhere?',
    'q4.a': '<p>No. Conversations, generated images and agent config stay in the local data directory and are never uploaded.</p><p>The current public build has no telemetry endpoint configured and sends no usage analytics — there is no telemetry module in the code. See the <a href="../privacy.html">privacy notice</a>.</p>',
    'q5.q': 'Is macOS or Linux supported?',
    'q5.a': '<p>Only Windows x64 builds are published. The codebase is a cross-platform Electron app you can build yourself (<code>npm install</code>, then <code>npm run electron:build</code>), but there are no official artifacts and no full verification.</p>',
    'q6.q': 'What does the “pending” status on a contact mean?',
    'q6.a': '<p>The directory reflects what probing actually found: not installed, installed but not signed in, or no headless mode available — each labeled honestly with next-step guidance. We stand by “if the button looks clickable, it works”.</p>',

    'cta.title': 'Now, start your first group.',
    'cta.sub': 'No OPC account required. The app runs locally and calls the agent services you choose.',
    'cta.button': 'Download for Windows',

    'footer.tag': 'Turn your local AI agents into a team.',
    'footer.source': 'Source', 'footer.download': 'Download', 'footer.issues': 'Issues',
    'footer.privacy': 'Privacy', 'footer.faq': 'FAQ',
    'footer.legal': '© 2026 OPC Agent · OPC Agent is an independent third-party tool, not affiliated with WorkBuddy, Codex, Gemini, Claude Code or their owners. Names and trademarks belong to their respective holders.',
  },
};

/* ─────────────── 应用逻辑 ─────────────── */
window.OPC_I18N_API = (function () {
  'use strict';
  var DICT = window.OPC_I18N;
  var STORE_KEY = 'opc-lang';

  function initial() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) { /* 隐私模式等场景读不到 localStorage，静默回退 */ }
    var nav = (navigator.language || 'zh').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var lang = initial();

  function t(key) {
    var v = DICT[lang] && DICT[lang][key];
    if (v == null) v = DICT.zh[key];   // 缺键回退中文，保证不出现空文案
    return v == null ? key : v;
  }

  function apply() {
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));

    var htmlEls = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlEls.length; j++) htmlEls[j].innerHTML = t(htmlEls[j].getAttribute('data-i18n-html'));

    var attrEls = document.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < attrEls.length; k++) {
      var pairs = attrEls[k].getAttribute('data-i18n-attr').split(';');
      for (var m = 0; m < pairs.length; m++) {
        var seg = pairs[m].split(':');
        if (seg.length === 2 && seg[0].trim() && seg[1].trim()) {
          attrEls[k].setAttribute(seg[0].trim(), t(seg[1].trim()));
        }
      }
    }

    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('meta.title');
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', t('meta.description'));

    var btns = document.querySelectorAll('.lang [data-lang]');
    for (var n = 0; n < btns.length; n++) {
      btns[n].setAttribute('aria-pressed', btns[n].getAttribute('data-lang') === lang ? 'true' : 'false');
    }
  }

  function set(next) {
    if (next !== 'zh' && next !== 'en') return;
    if (next === lang) return;
    lang = next;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* 同上，静默 */ }
    apply();
    // 通知 app.js 重绘动态内容（演示剧本、版本大小、更新日志兜底）
    document.dispatchEvent(new CustomEvent('opc:langchange', { detail: { lang: lang } }));
  }

  var btns = document.querySelectorAll('.lang [data-lang]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () { set(this.getAttribute('data-lang')); });
  }

  apply();

  return { lang: function () { return lang; }, t: t, apply: apply, set: set };
})();
