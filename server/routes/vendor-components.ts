/**
 * 厂商运行组件（Codex / Claude）按需下载 API（瘦身批次 2）。
 *
 * 与名册分开：组件是否就绪是**机器状态**，不是 Agent 的登录/可用状态；
 * 混进 `/api/agents` 会让名册轮询顺带做文件探测，也让「未登录」与
 * 「组件未下载」两种原因挤在同一个字段里。
 *
 * 路由参数只接受白名单 id，拒绝任何自由字符串（防路径拼接）。
 */
import type { Express } from 'express';
import {
  cancelVendorComponentDownload,
  isVendorComponentId,
  listVendorComponentStatuses,
  startVendorComponentDownload,
  vendorComponentStatus,
} from '../agents/vendorComponents.js';

export function registerVendorComponentRoutes(app: Express): void {
  /** 全部组件的安装/下载状态。界面轮询这一个接口拿进度。 */
  app.get('/api/vendor-components', (_req, res) => {
    res.json({ components: listVendorComponentStatuses() });
  });

  /** 开始下载。同步受理，实际下载在后台跑。 */
  app.post('/api/vendor-components/:id/download', (req, res) => {
    const id = req.params.id;
    if (!isVendorComponentId(id)) return res.status(400).json({ error: '未知的组件' });
    const result = startVendorComponentDownload(id);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true, component: vendorComponentStatus(id) });
  });

  /** 取消下载。没有进行中的任务时返回 409，让界面如实提示。 */
  app.post('/api/vendor-components/:id/cancel', (req, res) => {
    const id = req.params.id;
    if (!isVendorComponentId(id)) return res.status(400).json({ error: '未知的组件' });
    if (!cancelVendorComponentDownload(id)) {
      return res.status(409).json({ error: '没有正在进行的下载' });
    }
    res.json({ ok: true, component: vendorComponentStatus(id) });
  });
}
