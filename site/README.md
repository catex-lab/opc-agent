# 官网与统计 —— 部署说明

零成本方案：Cloudflare Pages（站点）+ Workers（接口）+ D1（数据库）+ R2（安装包镜像，可选）+ GitHub Releases（官方源）。

```
site/
├── index.html            落地页
├── privacy.html          隐私说明（应用内「关于与隐私」与它保持一致）
├── stats.html            数据看板（?key= 保护）
├── assets/
│   ├── config.js         ← 改这里：仓库名、Worker 地址
│   ├── app.js            版本信息 / 下载链接 / 更新日志
│   ├── style.css
│   └── icon.png, screenshot-*.png
└── worker/
    ├── wrangler.toml     ← 改这里：D1 id、密钥、域名
    ├── schema.sql        D1 表结构
    └── src/index.js      下载中转 + 看板查询（埋点接口保留，当前无客户端上报）
```

---

## 0. 上线前必须改的配置

| 文件 | 改什么 |
|------|--------|
| `site/assets/config.js` | 确认正式 GitHub 仓库后填写 `repo`（`owner/repo`）；部署 Worker 后把 `apiBase` 填成 `https://github.com/catex-lab/opc-agent` |
| `site/worker/wrangler.toml` | `database_id`（D1 创建后返回）、`STATS_KEY`、`GITHUB_REPO`、`ALLOWED_ORIGIN`、`R2_PUBLIC_BASE` |
| `src/components/AboutPanel.tsx` | 顶部三个地址常量（`SITE_URL` / `REPO_URL` / `ISSUE_URL`），必须与 `config.js` 一致 |

> 正式 GitHub 仓库地址尚待提供。`repo` 为空时，下载 / GitHub 链接会禁用，不会跳到伪造仓库；更新日志会说明等待配置。取得真实仓库地址后再部署，页面即可启用相关链接。

---

## 1. 本地预览

```bash
cd site
python -m http.server 8099
# 打开 http://127.0.0.1:8099
```

此时没有 Worker 且 `repo` 为空，页面会显示仓库待配置提示，下载与 GitHub 链接保持禁用。这是 GitHub 地址尚未提供时的预期状态。填写真实 `repo` 后，即使没有 Worker，下载会直连真实 GitHub Releases。

首页与隐私说明页均支持中文 / English 切换；选择保存在浏览器本地并在页面间共享。访客无需注册登录。站点使用项目真实界面截图与轻量滚动动效，支持减少动态效果偏好。

---

## 2. 域名接入 Cloudflare

1. Cloudflare 面板 → 添加站点 → 输入域名 → 选 Free 套餐
2. 到域名注册商把 NS 改成 Cloudflare 给的两条
3. 等生效（通常几分钟到几小时），状态变成 Active

---

## 3. 部署站点（Pages）

1. Workers & Pages → 创建 → Pages → 连接到 Git
2. 选 `opc-agent` 仓库，构建配置填：
   - 框架预设：`None`
   - 构建命令：**留空**
   - 输出目录：`site`
3. 部署完成后得到 `xxx.pages.dev`，在 Custom domains 里绑 `catex-lab`

之后每次 push 到主分支会自动重新部署。

---

## 4. 创建 D1 数据库

```bash
cd site/worker
npx wrangler login
npx wrangler d1 create opc-stats
```

把输出的 `database_id` 填进 `wrangler.toml`，然后建表：

```bash
npx wrangler d1 execute opc-stats --remote --file=schema.sql
```

---

## 5. 部署 Worker

`wrangler.toml` 里的 `STATS_KEY` 已经生成好了，部署前需要填写：

- `database_id` —— 第 4 步 `d1 create` 返回的那串
- `GITHUB_REPO` —— 把 `OWNER` 换成你的 GitHub 用户名

`ALLOWED_ORIGIN` 已经是 `https://github.com/catex-lab/opc-agent`，不用改。

```bash
npx wrangler deploy
```

**路由不用手动配。** `wrangler.toml` 里的 `routes` 会在部署时自动挂上这四条：

```
catex-lab/api/*      → opc-agent-api
catex-lab/d/*        → opc-agent-api
catex-lab/github     → opc-agent-api
catex-lab/update/*   → opc-agent-api
```

> 同域方案：Worker 只接管这四个路径，其余请求照常落到 Pages。
> Worker 路由优先级高于 Pages 自定义域，所以 `/api/*` 不会打到静态站。
> 前提是 `catex-lab` 已在 Cloudflare 且状态 Active，否则 deploy 会报找不到 zone。

验证：

```bash
curl https://github.com/catex-lab/opc-agent/api/v1/health
# {"ok":true,"ts":...}
```

**确认 Worker 真的接管了路径**（而不是被 Pages 接走）：

```bash
curl -I https://github.com/catex-lab/opc-agent/d/win-x64
# 期望：302，Location 指向 GitHub Release 资产
# 如果是 404，说明路由没生效，检查 zone 状态与 routes 配置
```

---

## 6. R2 镜像（可选，国内加速）

不做也能用，只是下载全部走 GitHub，国内会慢。

1. R2 → 创建存储桶 `opc-agent-downloads`
2. 桶设置 → 公开访问 → 绑定自定义域，例如 `downloads.invalid`
3. 每次发版后把安装包传上去，目录结构必须是：

```
opc-agent-downloads/
└── v1.0.0/
    └── OPC Agent-1.0.0-x64-setup.exe    ← 文件名必须与 GitHub 资产完全一致
```

```bash
npx wrangler r2 object put "opc-agent-downloads/v1.0.0/OPC Agent-1.0.0-x64-setup.exe" \
  --file="release/OPC Agent-1.0.0-x64-setup.exe"
```

4. 把 `R2_PUBLIC_BASE` 填成 `https://downloads.invalid`，重新 `wrangler deploy`

Worker 会自动按「最新 Release 的 tag + 资产名」拼出 R2 地址。文件不存在时用户会拿到 404，所以**传完再改配置**。

---

## 7. 客户端上报（当前未启用）

**A141 已把客户端遥测模块（原 `electron/analytics.ts`）整体删除**，应用不发送任何统计。
Worker 侧的 `/api/v1/install`、`/api/v1/session/start`、`/api/v1/session/end` 接口仍在
（见 `worker/src/index.js`），只是**当前没有调用方** —— 看板里「独立安装用户 / DAU / 平均时长」
这几项会一直是空表，这是预期行为，不是配置错了。

如果要恢复上报，需要先重建客户端模块（含设置页开关与隐私页文案），再接上 Worker 地址。
**不要以为填个环境变量就生效** —— 旧文档里的 `OPC_TELEMETRY_URL` 现在没有任何消费者。

验证下载计数（这条与上报无关，仍然可用）：

```bash
cd site/worker
npx wrangler d1 execute opc-stats --remote --command "SELECT * FROM downloads ORDER BY at DESC LIMIT 5"
```

---

## 8. 看板

访问 `https://github.com/catex-lab/opc-agent/stats.html?key=你设置的STATS_KEY`。

密钥会存在 localStorage，下次不用再输。想换密钥就改 `wrangler.toml` 重新部署。

---

## 9. 发布新版本（日常流程）

```bash
cd ..
# 1. 改 package.json 的 version（语义化版本，必须递增）
# 2. 打包并发布到 GitHub Release
GH_TOKEN=你的token npm run electron:build -- --publish always
```

`electron-builder.yml` 里 `publish` 目前是 `null`（不发布），需要改成：

```yaml
publish:
  provider: github
  owner: 你的用户名
  repo: opc-agent
```

> 注意：原注释提到的坑依然成立 —— 只要环境变量里有 `GH_TOKEN`，electron-builder 就会尝试解析 github provider。改成显式配置后这个坑自动消失，但 `publish` 字段不能留空。

发布完成后：
- GitHub Release 里有 `latest.yml` + 安装包 → 客户端自动更新生效
- 站点更新日志会自动拉到新版本（缓存 10 分钟）
- 如果配了 R2，记得把新安装包也传上去

---

## 统计口径速查

> ⚠️ 下表除「总下载」外都依赖客户端上报，而客户端上报已在 A141 移除 —— 这些指标当前恒为空，
> 口径保留供将来恢复时参考。

| 指标 | 含义 | 来源 |
|------|------|------|
| 总下载 | 点过 `/d/*` 的次数 | `downloads` 表 |
| 独立安装用户 | 上报过 install 的不同安装 ID 数 | `installs` 表 |
| DAU / WAU / MAU | 当天/7天/30天有会话的去重用户 | `sessions` 表 |
| 人均活跃天数 | 每个安装 ID 的活跃天数平均值 | `sessions` 表 |
| 平均单次时长 | 有效会话的时长均值（排除 <5s 和 >24h） | `sessions` 表 |
| 下载→安装转化 | 独立安装 / 总下载 | 两表相除 |

**为什么没有"实时在线人数"**：实时在线需要秒级心跳，一个人一天 1440 次请求，免费额度 10 万/天只够 69 个用户。本方案用「启动开会话 + 退出补时长」，1000 用户每天约 6000 次写入，能撑到 5 万用户。

**异常退出的会话**（进程被强杀）`duration_sec` 为 NULL，会在时长统计里被排除，但仍计入活跃天数。

---

## 排错

| 现象 | 原因 |
|------|------|
| 站点更新日志一直转圈 | `config.js` 的 `repo` 不对，或 GitHub API 被限流（Worker 的 `/api/v1/release` 有缓存，配了 `apiBase` 就不受影响） |
| 下载 404 | `R2_PUBLIC_BASE` 配了但文件没传，或文件名与 GitHub 资产不一致 |
| 看板一直提示密钥错误 | `STATS_KEY` 含特殊字符被 URL 编码搞坏，换成纯 hex |
| D1 里没有会话数据 | **预期行为** —— 客户端上报已在 A141 移除，应用不发送统计。看板只剩「总下载」（`downloads` 表）有数据 |
| Worker 报 `no such table` | 建表时漏了 `--remote`，建到了本地库 |
