/**
 * Agent 详情页状态文案的统一出口（状态 token）。
 *
 * 以前每个适配器把「结论 + 限制 + 文件时间」拼成一句 message，详情页原样显示，
 * 于是 WorkBuddy 显示 keyblob 时间、ACP 显示握手限制，换个 Agent 又冒出新长句。
 * 这里收成唯一契约：
 *   - 主行只放结论（label + summary）
 *   - 解释性内容只在「没有真实检测结论」时作为最小提示出现
 *   - 新 Agent 即使只写了旧 message，也会在这里被拆句，长解释不会渗进主行
 */
import { availabilityLabelOf, type AgentKind, type AgentStatus } from './types';

function splitLegacy(message?: string): { summary: string; detail?: string } {
  if (!message) return { summary: '' };
  const cut = message.search(/[（(：:。]/);
  if (cut < 0) return { summary: message.trim() };
  const summary = message.slice(0, cut).trim();
  const detail = message
    .slice(cut)
    .replace(/^[（(：:。\s]+/, '')
    .replace(/[）)]\s*[：:]?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { summary, detail: detail || undefined };
}

export function agentStatusCopy(agent: {
  kind: AgentKind;
  status: AgentStatus;
}): { primary: string; detail?: string } {
  const status = agent.status;
  const unverified = status.availability === 'ready' && !status.lastCanary;
  const label = unverified ? '未验证' : availabilityLabelOf(agent);
  const legacy = splitLegacy(status.message);
  const summary = (status.statusSummary ?? legacy.summary).trim();

  // 真实检测通过 => 探测期的「未校验 / 文件时间」一律不再是事实，统一收起。
  const canaryOk = status.lastCanary?.state === 'ok';
  let detail = canaryOk ? undefined : status.statusDetail ?? legacy.detail;
  if (unverified) detail = detail ? `${detail} · 还没做过真实检测，仅供参考` : '还没做过真实检测，状态仅供参考';

  const primary =
    label && summary && !summary.includes(label)
      ? `${label} · ${summary}`
      : summary || label;

  return { primary, detail: detail ? detail.trim() : undefined };
}
