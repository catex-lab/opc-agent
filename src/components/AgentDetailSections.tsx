import type { ReactNode } from 'react';
import { InstallCard } from './InstallCard';
import {
  AVAILABILITY_META,
  CAPABILITY_META,
  EVENT_CAPABILITY_META,
  EVENT_CAPABILITY_ORDER,
  REGION_META,
  SURFACE_META,
  availabilityLabelOf,
  type RegisteredAgent,
} from '../types';

/**
 * Agent 资料的信息区块 —— 资料页（AgentDetailPanel）与详情弹窗
 * （AgentDetailModal）共用同一份。
 *
 * ## 为什么抽出来
 *
 * 「这个 Agent 能干什么、为什么连不上」是同一个问题，只是两个入口：
 * 通讯录里点开是一整页，聊天里点「⋯ → Agent 详情」是一层弹窗。
 * 如果各写一份，两处的字段迟早会漂移 —— 弹窗里少一行「上次错误」，
 * 或者资料页多一个「接入说明」，用户就会觉得「同一个 Agent 怎么两个说法」。
 *
 * 所以这里只定义**内容**（有哪些字段、按什么顺序、怎么排版），
 * 容器（整页 / 弹窗）、头部（大头像 / 紧凑行）、底部操作留给调用方。
 */
export function AgentDetailSections({
  agent,
  onSelectAgent,
  onReprobe,
  onOpenCredential,
}: {
  agent: RegisteredAgent;
  /**
   * 装完之后重新探测。**可选** —— 弹窗里不给这个回调（那里是「看一眼就走」，
   * 重新探测会整页刷新，用户会失去当前位置）。
   */
  onReprobe?: () => void;
  /** 跳设置页对应凭据行（`method:'key'` 的条目用） */
  onOpenCredential?: (agentId: string) => void;
  /**
   * 点同族条目跳过去。**可选** —— 通讯录资料页能跳（`App` 直接换 `detailAgentId`），
   * 聊天里的详情弹窗跳不了（换了 Agent 就脱离了当前会话的上下文）。
   * 不传就只渲染纯文本，不假装可点。
   */
  onSelectAgent?: (agentId: string) => void;
}) {
  const capabilities = agent.capabilities
    .map(cap => ({ key: cap, meta: CAPABILITY_META[cap] }))
    .filter((c): c is { key: typeof c.key; meta: NonNullable<typeof c.meta> } => !!c.meta);

  // ── 身份（A68）──
  const surfaceLabel = agent.surface ? SURFACE_META[agent.surface]?.label : undefined;
  const regionMeta = agent.region ? REGION_META[agent.region] : undefined;
  /**
   * 区域文案的优先级：**后端下发的 `regionName`（厂商官方口径）** > 通用兜底。
   *
   * 「名称显示以官方为准」就落在这个优先级上：腾讯叫「国内版」、Kimi 叫「中国站」，
   * 我们不自创统一叫法去覆盖它们；只有后端没给（老夹具）时才退回通用说法。
   */
  const regionText = agent.regionName
    ? regionMeta?.badge
      ? `${agent.regionName}（${regionMeta.badge}）`
      : agent.regionName
    : regionMeta?.label;
  /**
   * 什么时候显示「获取」卡片（A71）。
   *
   * 分两类，因为**缺的东西不一样**：
   *
   * - `method:'key'`（豆包 / Kimi / WorkBuddy）：这类由本应用直接发 HTTP 或走内置 SDK，
   *   机器上什么都不用装，缺的只是一份凭据 —— 它的状态就是 `needs-auth`。
   *   所以这一类恰好在 `needs-auth` 时出现。
   * - 其余（npm / script / installer）：只有「机器上没有（`not-installed`）」或
   *   「装了但起不来（`needs-setup`，npm 占位脚本的典型症状）」时才出现。
   *   **`needs-auth` 时绝不出现** —— 那时工具已经装好了，只差登录，
   *   给下载按钮会让用户去重装一个本来没坏的东西，越修越乱。
   *
   * 这条不对称的边界由 `verify:header-contacts` 的两个反例断言守着：
   * 一个 CLI 类条目在 `needs-auth` 下不许出现下载按钮；
   * 一个 `key` 类条目在 `needs-auth` 下**必须**出现「填写 API Key」。
   */
  const isKeyOnly = agent.install?.method === 'key';
  const showInstallCard = isKeyOnly
    ? agent.status.availability === 'needs-auth'
    : agent.status.availability === 'not-installed' ||
      agent.status.availability === 'needs-setup';

  const hasIdentity = Boolean(
    agent.familyName ||
      surfaceLabel ||
      regionText ||
      agent.authScopeName ||
      (agent.endpointHosts && agent.endpointHosts.length > 0) ||
      (agent.localSiblings && agent.localSiblings.length > 0) ||
      agent.lastRequest
  );
  /**
   * 同族关系 —— 资料页最值钱的一句话。
   *
   * 用户看到名册里两个 Kimi 时的真实疑问不是「它们叫什么」，而是
   * 「是不是一回事、额度算谁的」。答案只能来自**对方**的 `authScope`：
   * 相同 = 共用账号（额度同池），不同 = 额度不互通。
   *
   * 名字做成可点（`data-family-jump`）：同族两条本来就容易让人以为「少了一个」，
   * 能直接跳过去比读一句「与某某同族」有用。跳不了时（弹窗）退回纯文本，
   * **不做看起来能点其实没反应的假控件**。
   */
  const peers = agent.familyPeers ?? [];
  const sameScopePeers = peers.filter(p => p.authScope && p.authScope === agent.authScope);
  const otherScopePeers = peers.filter(p => !p.authScope || p.authScope !== agent.authScope);

  const peerNames = (list: typeof peers) =>
    list.map((p, i) => (
      <span key={p.id}>
        {i > 0 && '、'}
        {onSelectAgent ? (
          <button
            type="button"
            data-family-jump={p.id}
            onClick={() => onSelectAgent(p.id)}
            className="underline decoration-dotted underline-offset-2"
            style={{ color: 'var(--td-brand-color)' }}
          >
            {p.name}
          </button>
        ) : (
          p.name
        )}
      </span>
    ));

  const relationship: ReactNode =
    peers.length === 0 ? null : (
      <>
        {sameScopePeers.length > 0 && (
          <>
            与 {peerNames(sameScopePeers)} 共用同一账号（额度同池），区别在产品形态或代际
          </>
        )}
        {sameScopePeers.length > 0 && otherScopePeers.length > 0 && '；'}
        {otherScopePeers.length > 0 && (
          <>与 {peerNames(otherScopePeers)} 属同一厂商，但账号与额度不互通</>
        )}
      </>
    );

  return (
    <>
      {/* 基本信息 */}
      <section className="mt-6 first:mt-0">
        <h3 className="tc-section-title mb-2">基本信息</h3>
        <div
          className="tc-detail-rows overflow-hidden rounded-xl"
          style={{ backgroundColor: 'var(--td-bg-color-container)' }}
        >
          <DetailRow
            label="状态"
            // 没上报 message 时退回可用性标签 —— 标签文案只有
            // availabilityLabelOf 一个来源，不在这里再抄一份
            value={agent.status.message || availabilityLabelOf(agent)}
          />
          {/* 需要登录时给一个一键入口。
              地址由探测以结构化字段给出，不从文案里抠 URL；
              target=_blank 会被主进程的 setWindowOpenHandler 转交
              系统浏览器打开（不在应用内开新窗口）。 */}
          {agent.status.availability === 'needs-auth' && agent.status.authUrl && (
            <div className="px-4 py-3">
              <button
                type="button"
                className="tc-btn-brand"
                onClick={() => window.open(agent.status.authUrl, '_blank', 'noopener')}
              >
                去登录 {agent.name}
              </button>
            </div>
          )}
          <DetailRow
            label="版本"
            value={agent.status.version ? `v${agent.status.version}` : '未上报'}
          />
          <DetailRow label="接入方式" value={kindLabel(agent.kind)} />
          {agent.installHint && !showInstallCard && (
            <DetailRow label="接入说明" value={agent.installHint} />
          )}
          {/* A71：没装（或装了起不来）时，把「接入说明」这句散文升级成「获取」卡片。
              为什么只在这两个状态下出现：`needs-auth` 是"已经装好了、只差登录"，
              这时候给下载按钮会把用户引去重装一个本来就没坏的东西 —— 越修越乱。
              `ready` 更不用说。这条边界由 verify:header-contacts 的反例断言守着。 */}
          {showInstallCard && (
            <div
              className="border-t"
              style={{ borderColor: 'var(--td-component-stroke)' }}
              data-agent-install
            >
              <div
                className="px-4 pt-3 text-[12px]"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                获取
              </div>
              <InstallCard
                agent={agent}
                onReprobe={onReprobe}
                onOpenCredential={onOpenCredential}
              />
            </div>
          )}
        </div>
      </section>

      {/* 身份（A68）：把「这是哪个产品、哪个区、算谁的额度」一次说清。
          没有这些字段时整块不出现 —— 老后端 / 老夹具下不显示「未知」，
          宁可不显示，也不摆一行查不到的值。 */}
      {hasIdentity && (
        <section className="mt-6" data-agent-identity>
          <h3 className="tc-section-title mb-2">身份</h3>
          <div
            className="tc-detail-rows overflow-hidden rounded-xl"
            style={{ backgroundColor: 'var(--td-bg-color-container)' }}
          >
            {agent.familyName && <DetailRow label="产品族" value={agent.familyName} />}
            {surfaceLabel && <DetailRow label="产品形态" value={surfaceLabel} />}
            {regionText && <DetailRow label="区域" value={regionText} />}
            {agent.authScopeName && <DetailRow label="账号体系" value={agent.authScopeName} />}
            {/* 端点用 mono：主机名是给人核对用的，等宽字体才不会把 l/1/O/0 看混 */}
            {agent.endpointHosts && agent.endpointHosts.length > 0 && (
              <DetailRow label="请求端点" value={agent.endpointHosts.join(' · ')} mono />
            )}
            {relationship && <DetailRow label="同族关系" value={relationship} />}
            {/* A69：上次实际请求走的账号体系（目前只有 zcode）。
                措辞必须是「上次请求」而不是「当前连接」—— 数据来自使用记录，
                zcode 的当前 provider 存在加密字段里读不出来。来源写在同一格里，
                免得有人把它当成实时状态。 */}
            {agent.lastRequest && (
              <DetailRow
                label="上次请求"
                value={
                  <>
                    {agent.lastRequest.accountLabel} · {agent.lastRequest.model}
                    <span
                      className="mt-0.5 block text-[12px] leading-relaxed"
                      style={{ color: 'var(--td-text-color-placeholder)' }}
                    >
                      {formatAgo(agent.lastRequest.at)} · 来源 {agent.lastRequest.source}
                    </span>
                  </>
                }
              />
            )}
            {/* A69：同厂、但没接入的另一个版本（PLAN §6 P2「存在性提示」）。
                这一段存在的意义是「别装作没看见」：用户机器上装着 ~/.qoder-cn 或
                ~/.workbuddy-ai 时，名册只有一个条目会让人以为「不支持」，甚至
                「现在这条就是国际版」。所以只陈述探测到的事实 + 为什么没接。
                **不放接入按钮** —— 真接入要先有第二份凭据，按一下就能完成的是假控件。 */}
            {agent.localSiblings && agent.localSiblings.length > 0 && (
              <div className="px-4 py-3" data-local-siblings>
                <div
                  className="w-[76px] shrink-0 text-body"
                  style={{ color: 'var(--td-text-color-placeholder)' }}
                >
                  其他版本
                </div>
                <div className="mt-1 flex flex-col gap-2">
                  {agent.localSiblings.map(s => (
                    <div
                      key={s.id}
                      data-local-sibling={s.id}
                      className="rounded-lg px-3 py-2"
                      style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
                    >
                      <div className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                        {s.name} · {s.regionName}
                      </div>
                      <div
                        className="mt-0.5 break-all font-mono text-[12px]"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        {s.detectedPath}
                      </div>
                      <div
                        className="mt-1 text-[12px] leading-relaxed"
                        style={{ color: 'var(--td-text-color-secondary)' }}
                      >
                        {s.evidence}
                      </div>
                      {s.blockedBy && (
                        <div
                          className="mt-1 text-[12px] leading-relaxed"
                          style={{ color: 'var(--td-warning-color)' }}
                          data-sibling-blocked
                        >
                          未接入：{s.blockedBy}
                        </div>
                      )}
                      {/* blockedBy 与 nextStep 是**互补**的两层信息：前者说缺什么，
                          后者说条件满足后怎么走。所以两个都渲染 —— 早期写成
                          `!s.blockedBy && s.nextStep` 会把「要另备凭据 + 备好后怎么做」
                          这后半句吞掉，用户只能看到问题看不到出路。 */}
                      {s.nextStep && (
                        <div
                          className="mt-1 text-[12px] leading-relaxed"
                          style={{ color: 'var(--td-brand-color)' }}
                          data-sibling-next-step
                        >
                          {s.blockedBy ? '条件满足后' : '要接入'}：{s.nextStep}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 擅长领域 */}
      {capabilities.length > 0 && (
        <section className="mt-6">
          <h3 className="tc-section-title mb-2">擅长领域</h3>
          <div className="flex flex-wrap gap-2">
            {capabilities.map(({ key, meta: cm }) => (
              <span
                key={key}
                className="rounded-md px-2 py-1 text-secondary"
                style={{ backgroundColor: `${cm.color}18`, color: cm.color }}
              >
                {cm.label}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 过程能力（A111）──
          为什么要单独一块：聊天里「过程区是空的」有两种完全不同的原因 ——
          这个 Agent 这一轮确实没调工具，或者它压根报不了工具调用。
          以前两者在界面上长得一模一样，用户只能猜。这里把清单摊开：
          支持的高亮，不支持的置灰并写「不支持」。

          `undefined`（后端没声明）时整块不渲染 —— 那是「不知道」，
          不该被画成「不支持」。只有空数组才是明确的「一条都没有」。 */}
      {agent.eventCapabilities && (
        <section className="mt-6" data-agent-event-capabilities>
          <h3 className="tc-section-title mb-2">过程能力</h3>
          <div className="flex flex-wrap gap-2">
            {EVENT_CAPABILITY_ORDER.map(key => {
              const meta = EVENT_CAPABILITY_META[key];
              const supported = agent.eventCapabilities!.includes(key);
              return (
                <span
                  key={key}
                  title={meta.hint}
                  data-event-capability={key}
                  data-supported={supported ? '1' : '0'}
                  className="rounded-md px-2 py-1"
                  style={
                    supported
                      ? {
                          backgroundColor: 'color-mix(in srgb, var(--td-brand-color) 12%, transparent)',
                          color: 'var(--td-brand-color)',
                        }
                      : {
                          // 不支持的一律走 placeholder 色 + 虚线边：视觉上明显是「没有」，
                          // 而不是「有但很淡」
                          border: '1px dashed var(--td-component-stroke)',
                          color: 'var(--td-text-color-placeholder)',
                        }
                  }
                >
                  {meta.label}
                  {!supported && '（不支持）'}
                </span>
              );
            })}
          </div>
          {agent.eventCapabilities.length === 0 && (
            <p className="mt-2 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
              这个 Agent 只返回最终回答，不暴露执行过程。
            </p>
          )}
        </section>
      )}

      {/* 结构化技能（参考 A2A AgentSkill）：展示可承接的具体任务及其数据形式。 */}
      {(agent.skills?.length ?? 0) > 0 && (
        <section className="mt-6" data-agent-skills>
          <h3 className="tc-section-title mb-2">可承接的任务</h3>
          <div className="tc-detail-rows overflow-hidden rounded-xl" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
            {agent.skills!.map(skill => (
              <div key={skill.id} className="px-4 py-3" data-agent-skill={skill.id}>
                <div className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>{skill.name}</div>
                <div className="mt-1 text-body leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>{skill.description}</div>
                {skill.tags && skill.tags.length > 0 && (
                  <div className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>关键词：{skill.tags.join(' · ')}</div>
                )}
                {((skill.inputModes?.length ?? 0) > 0 || (skill.outputModes?.length ?? 0) > 0) && (
                  <div className="mt-1 text-caption" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    {skill.inputModes?.length ? `输入 ${skill.inputModes.join(', ')}` : ''}
                    {skill.inputModes?.length && skill.outputModes?.length ? ' · ' : ''}
                    {skill.outputModes?.length ? `输出 ${skill.outputModes.join(', ')}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 介绍 */}
      {agent.description && (
        <section className="mt-6">
          <h3 className="tc-section-title mb-2">介绍</h3>
          <p
            className="rounded-xl px-4 py-3 text-body leading-relaxed"
            style={{
              backgroundColor: 'var(--td-bg-color-container)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            {agent.description}
          </p>
        </section>
      )}

      {/* 技术信息：路径与错误只在存在时才出现，没有就不占位 */}
      {(agent.status.binaryPath || agent.status.lastError) && (
        <section className="mt-6">
          <h3 className="tc-section-title mb-2">技术信息</h3>
          <div
            className="tc-detail-rows overflow-hidden rounded-xl"
            style={{ backgroundColor: 'var(--td-bg-color-container)' }}
          >
            {agent.status.binaryPath && (
              <DetailRow label="可执行文件" value={agent.status.binaryPath} mono />
            )}
            {agent.status.lastError && (
              <DetailRow label="上次错误" value={agent.status.lastError} error />
            )}
          </div>
        </section>
      )}
    </>
  );
}

/** 「标签 + 值」一行。资料页与弹窗共用，宽度与内边距只在这里定义一次。 */
export function DetailRow({
  label,
  value,
  mono,
  error,
}: {
  label: string;
  /** 允许 ReactNode：同族关系里要把对方名字渲染成可点的按钮（A68） */
  value: ReactNode;
  mono?: boolean;
  error?: boolean;
}) {
  return (
    <div className="flex gap-3 px-4 py-3">
      <span
        className="w-[76px] shrink-0 text-body"
        style={{ color: 'var(--td-text-color-placeholder)' }}
      >
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 text-body leading-relaxed ${mono ? 'break-all font-mono' : 'break-words'}`}
        style={{
          color: error ? 'var(--td-error-color)' : 'var(--td-text-color-primary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** 接入形态的人话表述。原始 kind 是 sdk/cli/acp 这种实现细节，用户看不懂。 */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'sdk':
      return 'SDK 接入';
    case 'cli':
      return 'CLI 子进程';
    case 'acp':
      return 'ACP 协议';
    default:
      return '未接入';
  }
}

/**
 * 「多久以前」的人话表述（A69）。
 *
 * 为什么不用 `toLocaleString()`：资料页这一行要回答的是「这份证据有多新」，
 * 「2026-10-22 10:19:47」需要用户自己做减法；「3 分钟前」不用。
 * 超过一天的退回日期，因为「37 天前」这种说法对判断新鲜度已经没有帮助了。
 */
function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
