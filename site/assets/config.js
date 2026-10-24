// 站点配置 —— 上线前只需要改这个文件
window.OPC_CONFIG = {
  // 站点标题与描述
  siteName: 'OPC Agent',
  tagline: '把本机的每个 Agent，变成通讯录里的联系人',
  description: '本机多 Agent 团队协作桌面应用。把 WorkBuddy、Codex、Gemini、Claude Code 等本机 Agent 当作联系人，支持私聊与群聊分派任务。',

  // GitHub 仓库（格式 owner/repo）。为空时下载与 GitHub 链接会保持禁用，
  // 不展示虚构地址；拿到正式仓库名后在此填写。
  repo: 'catex-lab/opc-agent',

  // 统计与下载中转的 Worker 基地址（同域方案，Worker 挂在主域路径上）。
  //
  //   ''                        → 不经过中转：下载按钮直连 GitHub，没有下载计数
  //   'https://github.com/catex-lab/opc-agent'    → Worker 已部署：/d/* 记一条再 302，/api/* 提供版本与看板
  //
  // ⚠️ 部署完 Worker 后必须把这一行改成 'https://github.com/catex-lab/opc-agent'，否则下载不计数、
  //    站点也拿不到 Worker 缓存的版本信息（会退回直连 GitHub API，可能被限流）。
  apiBase: '',

  // 下载中转路径（apiBase 非空时才生效）
  downloadPath: '/d/win-x64',

  // 安装包信息兜底：拉不到 GitHub Release 时显示这些
  fallback: {
    version: '1.0.0',
    publishedAt: '',
    sizeText: '',
    winUrl: '',
  },

  // 埋点上报开关（影响客户端，此处仅作文档说明）
  telemetry: true,
};
