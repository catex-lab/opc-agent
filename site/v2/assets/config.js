/* OPC Agent 官网 v2 配置 —— 上线前只需要改这个文件。
   与旧版 site/assets/config.js 字段对齐，方便日后合并。 */
window.OPC_SITE = {
  // GitHub 仓库（owner/repo）
  repo: 'catex-lab/opc-agent',

  // 下载中转 Worker 的基地址（同域方案）。
  //   '' → 下载按钮先指向 GitHub Releases 页（首个 Release 发布后即为真实下载入口）
  //   'https://github.com/catex-lab/opc-agent' → Worker 已部署：/d/* 记一条匿名计数再 302
  apiBase: '',
  downloadPath: { setup: '/d/win-setup', portable: '/d/win-portable' },

  // 兜底的安装包信息（GitHub API 拉不到时展示）
  version: 'v1.0.0',
  sizeText: '安装版 ≈ 144 MB',
  dateText: '2026-10',
  artifacts: {
    setup: 'OPC Agent-1.0.0-x64-setup.exe',
    portable: 'OPC Agent-1.0.0-x64-portable.exe',
  },
};
