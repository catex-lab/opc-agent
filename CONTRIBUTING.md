# 参与贡献

本仓库目前**不接收外部 Pull Request**。

原因很直接：维护带宽有限，接了 PR 就要承诺评审、回复和后续维护。做不到还不如不接 ——
一个挂着「欢迎 PR」却几个月不看的仓库，比明说「暂不接受」更浪费你的时间。

## 你可以做的事

### 报告问题

- **功能异常 / 崩溃**：开 issue，附上
  - 版本号（应用内 `设置 → 关于与隐私` 能看到）
  - 操作系统与架构
  - 能稳定复现的最小步骤
  - 相关的错误信息或截图
- **安全问题**：**不要开公开 issue**，走 [SECURITY.md](./SECURITY.md) 里的私密报告通道。

### 提建议

开 issue 讲清楚「你想解决什么问题」比直接给方案更有用 —— 场景描述清楚了，实现方式往往有好几种。

### 自己改

[MIT 许可](./LICENSE) 允许你 fork、修改、自用甚至商用，**不需要征求任何人同意**。
改完留给自己用完全没问题，这也是这个项目选 MIT 的原因。

### 如果你确实改了、并且想合并回来

先在 issue 里说明改动意图，等维护者确认方向后再提 PR。未经沟通直接提的 PR 很可能被关闭 ——
不是不欢迎，而是避免双方白费功夫。

真到了提 PR 那一步，请：

- **一个 PR 只做一件事**。混着改的 PR 没法评审。
- **说清「改了什么」和「为什么这么改」**。后者更重要。
- **跑过对应的验证**：界面相关跑 `npm run verify:ui`，其它看 `package.json` 里对应的
  `verify:*` 脚本。验证纪律见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 开发环境

构建、跑测试、打包的完整说明在 [DEVELOPMENT.md](./DEVELOPMENT.md)。界面相关的约定
（颜色、字号、间距、控件）在 [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)，动手前建议先看。

clone 之后建议先装一次提交钩子：

```bash
npm run hooks:install
```

它会在每次提交前扫描暂存区，拦住疑似密钥。仓库是私有的，GitHub 的 push protection
需要付费许可证，所以这一层放在本地。误报就在那一行加 `secret-scan:ignore`，
确实要跳过用 `git commit --no-verify`。规则与验收见 `scripts/secret-scan.mjs`
和 `npm run verify:hooks`。
