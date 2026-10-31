import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { InstallCard } from './InstallCard';
import { AgentCredentialEditor } from './AgentCredentialEditor';
import {
  AVAILABILITY_META,
  CAPABILITY_META,
  EVENT_CAPABILITY_META,
  EVENT_CAPABILITY_ORDER,
  REGION_META,
  SURFACE_META,
  availabilityLabelOf,
  type AgentAccount,
  type RegisteredAgent,
} from '../types';

/**
 * Agent 资料的信息区块 —— 资料页（AgentDetailPanel）与详情弹窗
 * （AgentDetailModal）共用同一份。
 *
 * 之所以抽出来：「这个 Agent 能干什么、为什么连不上」是同一个问题，
 * 只是两个入口：通讯录里点开是一整页，聊天里点「⋯ → Agent 详情」是
 * 一层弹窗。如果各写一份，两处的字段迟早会漂移 —— 弹窗里少一行
 * 「上次错误」，或者资料页多一个「接入说明」，用户就会觉得
 * 「同一个 Agent 怎么两个说法」。
 *
 * 所以这里只定义**内容**（有哪些字段、按什么顺序、怎么排版），
 * 容器（整页 / 弹窗）、头部（大头像 / 紧凑行）、底部操作留给调用方。
 *
 * ## A115 排版刻度（反馈「文字、组件大小不统一」）
 *
 * 这一页原来同时存在四种「差不多大的小字」：`text-caption`(11)、
 * `text-secondary`(12)、裸 `text-[12px]`、以及 chip 上**一个字号类都没写**
 * （于是落到浏览器默认 16px，比旁边的能力 chip 大出一号）。同屏并排时
 * 就是原话里的「大小不一」。
 *
 * 现在整页只留三级字号，改字号只改这里：
 *
 *   区块标题   `tc-section-title`   15px / 600   —— 每个 section 的 h3
 *   行标签/值  `text-body`          13px         —— DetailRow 的两列
 *   次级说明   `text-secondary`     12px         —— 副行、路径、提示语、chip
 *
 *  chip 与 DetailRow 的标签列宽度也从「各写一份」收成两个常量，
 * 免得下次加一块又引入第四种内边距 / 第五种列宽。
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

  /**
   * 账号与权益（A152）。按需拉 `/api/agents/:id/account`，不塞进名册接口 ——
   * 这份数据要读每个 Agent 的凭据/配置文件，不该跟着 30 秒一次的名册刷新走。
   *
   * 拿不到（null）时整块不渲染：读不到 ≠ 没有账号，摆一行「未知」只会误导。
   */
  const account = useAgentAccount(agent.id);

  // A115：整页共用的排版刻度（理由见文件头）。值写成常量而不是散在 JSX 里，
  // 是为了让「加一块新内容」时直接抄这两个名字，不会再长出第四种规格。
  /** 信息行的左右内边距 —— 四个卡片容器、InstallCard、localSiblings 同一值 */
  const ROW_X = 'px-4';
  /** 信息行的上下内边距 */
  const ROW_Y = 'py-3';
  /** 标签列宽度：DetailRow 与 localSiblings 的手写标签共用，两列才对得齐 */
  const LABEL_W = 'w-[76px]';
  /** 卡片（装信息行的容器）与卡片内的子卡：相邻两档，不引入第三种圆角 */
  const CARD = 'rounded-xl';
  const CARD_INNER = 'rounded-lg';
  /** chip：能力 / 过程能力两种 chip 必须同规格，否则同屏并排会一大一小 */
  const CHIP = 'rounded-md px-2 py-1 text-secondary';

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
        <div className={`tc-detail-rows overflow-hidden ${CARD}`} style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
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
            <div className={`${ROW_X} ${ROW_Y}`}>
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
              /* A115 续：分区间的分隔线走 --tc-edge（4.5% 墨）——
                 「边界保险」档。安装卡有自己的底色，不需要 10% 的墨线。 */
              style={{ borderColor: 'var(--tc-edge)' }}
              data-agent-install
            >
              {/* A115：这个小标签原来写 `text-[12px]` —— 与旁边的 `text-secondary`
                  是同一个字号，却是两种写法；同屏出现第三种「差不多大的小字」
                  正是原话里的大小不统一。现在统一走 token。 */}
              <div className={`${ROW_X} pt-2.5 text-secondary`} style={{ color: 'var(--td-text-color-placeholder)' }}>
                获取
              </div>
              <InstallCard
                agent={agent}
                onReprobe={onReprobe}
                /* key 类 Agent：详情页就地展开凭据编辑器，不再弹去设置页。
                   不传 onOpenCredential，InstallCard 就不会画「填写 API Key」
                   跳转按钮 —— 编辑器自己就是入口。 */
                onOpenCredential={isKeyOnly ? undefined : onOpenCredential}
              />
            </div>
          )}

          {/* key 类 Agent：就地凭据配置（取 / 存 / 清 + 连通性 + 模型）。
              不论 availability 是什么都显示 —— 已配置时用户可能想换 Key 或
              测连通性，未配置时这就是唯一入口。编辑器与设置页「登录配置」
              是同一块代码、同一份数据。 */}
          {isKeyOnly && (
            <div
              className="border-t"
              style={{ borderColor: 'var(--tc-edge)' }}
              data-agent-credential-inline
            >
              <div
                className={`${ROW_X} pt-2.5 text-secondary`}
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                凭据配置
              </div>
              <div className={ROW_X}>
                <AgentCredentialEditor agentId={agent.id} onSaved={onReprobe} />
              </div>
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
          <div className={`tc-detail-rows overflow-hidden ${CARD}`} style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
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
                    {/* A115：`text-[12px]` → `text-secondary`（同一字号的唯一写法） */}
                    <span
                      className="mt-0.5 block text-secondary leading-relaxed"
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
              <div className={`${ROW_X} ${ROW_Y}`} data-local-siblings>
                {/* A115：标签列宽度与 DetailRow 共用 LABEL_W —— 这里原来自己写了
                    一份 `w-[76px]`，两份一旦漂移，「其他版本」四个字就和左边
                    各行的标签对不齐了。 */}
                <div className={`${LABEL_W} shrink-0 text-body`} style={{ color: 'var(--td-text-color-placeholder)' }}>
                  其他版本
                </div>
                <div className="mt-1 flex flex-col gap-2">
                  {agent.localSiblings.map(s => (
                    <div
                      key={s.id}
                      data-local-sibling={s.id}
                      className={`${CARD_INNER} px-3 py-2`}
                      style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
                    >
                      <div className="text-body" style={{ color: 'var(--td-text-color-primary)' }}>
                        {s.name} · {s.regionName}
                      </div>
                      <div
                        className="mt-0.5 break-all font-mono text-secondary"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        {s.detectedPath}
                      </div>
                      <div
                        className="mt-1 text-secondary leading-relaxed"
                        style={{ color: 'var(--td-text-color-secondary)' }}
                      >
                        {s.evidence}
                      </div>
                      {s.blockedBy && (
                        <div
                          className="mt-1 text-secondary leading-relaxed"
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
                          className="mt-1 text-secondary leading-relaxed"
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

      {/* 账号与权益（A152）──
          用户报的两件事：①「打开详情页不知道登录的是哪个账号」；
          ②「ZCode 领了 Start Plan，应用里看不到、也选不了」。

          这一块只做**读**：zcode 的账号是加密的（读不到就明说读不到），
          套餐状态是本地缓存（带时间戳，过期就标注），能不能在这里切由
          `modelSelectable` 说 —— 能切的才写「能切」，其余给「去哪儿切」。

          为什么放在「身份」后面：「这是哪个产品」读完，紧接着要回答的
          就是「算谁的账号、领了什么」。 */}
      {account && (
        <section className="mt-6" data-agent-account>
          <h3 className="tc-section-title mb-2">账号与权益</h3>
          <div
            className={`tc-detail-rows overflow-hidden ${CARD}`}
            style={{ backgroundColor: 'var(--td-bg-color-container)' }}
          >
            {account.identity && (
              <DetailRow
                label="当前登录"
                value={
                  account.identity.email || account.identity.name ? (
                    <>
                      {account.identity.name}
                      {account.identity.name && account.identity.email ? ' · ' : ''}
                      {/* 邮箱必须掩码：详情页是会被截图分享的地方 */}
                      {account.identity.email ? maskEmail(account.identity.email) : ''}
                      <span
                        className="mt-0.5 block text-secondary leading-relaxed"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        {[account.identity.planLabel, account.identity.source].filter(Boolean).join(' · ')}
                      </span>
                    </>
                  ) : (
                    <>
                      {account.identity.unavailableReason || '读不到账号信息'}
                      <span
                        className="mt-0.5 block text-secondary leading-relaxed"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        来源 {account.identity.source}
                      </span>
                    </>
                  )
                }
              />
            )}

            {/* 当前套餐：按 provider family 一行。这是回答「登录的是哪个账号」
                最接近事实的部分 —— 账号名读不到，但「选中了哪套订阅」读得到。 */}
            {account.currentSelection && account.currentSelection.length > 0 && (
              <DetailRow
                label="当前套餐"
                value={
                  <>
                    {account.currentSelection.map(s => (
                      <span key={s.family} className="block" data-account-selection={s.family}>
                        {s.familyLabel}：{s.kindLabel} → {s.providerName}
                        <span
                          className="mt-0.5 block text-secondary leading-relaxed"
                          style={{
                            color: s.effective ? 'var(--td-brand-color)' : 'var(--td-warning-color)',
                          }}
                        >
                          {s.effective ? '生效中' : `未生效 · ${s.detail || '状态未知'}`}
                        </span>
                      </span>
                    ))}
                  </>
                }
              />
            )}

            {/* 已领取权益：套餐 → 状态 → 含哪些模型 → 是否生效。
                这四个字段是「能不能用、为什么不能用」的全部证据。 */}
            {account.plans.length > 0 && (
              <div className={`${ROW_X} ${ROW_Y}`} data-agent-account-plans>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    已领取权益
                  </span>
                  {/* 缓存时间必须写在数据旁边，否则「未订阅」会被当成事实 */}
                  {account.checkedAt && (
                    <span
                      className="text-secondary"
                      data-account-checked-at
                      style={{
                        color: account.stale ? 'var(--td-warning-color)' : 'var(--td-text-color-placeholder)',
                      }}
                    >
                      数据 {formatAgo(account.checkedAt)}
                      {account.stale ? '（已过期，仅供参考）' : ''}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  {account.plans.map(plan => (
                    <div
                      key={plan.id}
                      data-agent-plan={plan.id}
                      data-plan-status={plan.status}
                      data-plan-effective={plan.effective ? '1' : '0'}
                      className={`${CARD_INNER} px-3 py-2`}
                      style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className="text-body font-medium"
                          style={{
                            color:
                              plan.status === 'active'
                                ? 'var(--td-text-color-primary)'
                                : 'var(--td-text-color-secondary)',
                          }}
                        >
                          {plan.name}
                        </span>
                        <span
                          className="text-secondary"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          {plan.detail || (plan.status === 'active' ? '可用' : '状态未知')}
                        </span>
                        {plan.effective && (
                          <span className="text-secondary" style={{ color: 'var(--td-brand-color)' }}>
                            生效中
                          </span>
                        )}
                        {/* 「已选」与「未生效」同时出现，正是用户报的那个状态 ——
                            必须两个词都写出来，只写一个都会掩盖另一半 */}
                        {plan.selected && !plan.effective && (
                          <span className="text-secondary" style={{ color: 'var(--td-warning-color)' }}>
                            已选，未生效
                          </span>
                        )}
                      </div>
                      {plan.models.length > 0 && (
                        <div
                          className="mt-1 text-secondary leading-relaxed"
                          style={{ color: 'var(--td-text-color-placeholder)' }}
                        >
                          含 {plan.models.join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {account.note && (
            <p
              className="mt-2 text-secondary leading-relaxed"
              data-account-note
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              {account.note}
            </p>
          )}
          <p
            className="mt-1 text-secondary leading-relaxed"
            data-account-model-note
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            {account.modelNote}
          </p>
          {account.switchHint && (
            <p
              className="mt-1 text-secondary leading-relaxed"
              data-account-switch-hint
              style={{ color: 'var(--td-brand-color)' }}
            >
              {account.switchHint}
            </p>
          )}
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
                className={CHIP}
                data-capability={key}
                /* A159：底色从同一个令牌算 —— CAPABILITY_META 的颜色是
                   `var(--tc-cap-*)`，不能再用 `${cm.color}18` 拼十六进制后缀。 */
                style={{
                  backgroundColor: `color-mix(in srgb, ${cm.color} 9%, transparent)`,
                  color: cm.color,
                }}
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
          不该被画成「不支持」。只有空数组才是明确的「一条都没有」。

          P2：清单之外再挂一行**观测事实**（最近一次 run 实际给出了什么）。
          声明是静态的、可能过期；这一行才是投影器数出来的。两者不一致时
          必须让用户看见 —— 「清单说有、实际一次没给」正是要消灭的那种谎。 */}
      {(agent.eventCapabilities || agent.observedCapabilities) && (() => {
        const declared = agent.eventCapabilities ?? [];
        const observedProfile = agent.observedCapabilities;
        const observed = observedProfile?.observed ?? [];
        const observedSet = new Set(observed);
        const undeclared = observed.filter(k => !declared.includes(k));
        return (
          <section className="mt-6" data-agent-event-capabilities>
            <h3 className="tc-section-title mb-2">过程能力</h3>
            <div className="flex flex-wrap gap-2">
              {EVENT_CAPABILITY_ORDER.map(key => {
                const meta = EVENT_CAPABILITY_META[key];
                const supported = declared.includes(key);
                return (
                  <span
                    key={key}
                    title={meta.hint}
                    data-event-capability={key}
                    data-supported={supported ? '1' : '0'}
                    /* 有观测记录时才写这个属性：没有记录 ≠ 观察到 0 项 */
                    data-observed={observedProfile ? (observedSet.has(key) ? '1' : '0') : undefined}
                    /* A115：这里原来**一个字号类都没写**，于是 chip 落到浏览器默认
                       字号（比旁边的能力 chip 大出一号）—— 同屏并排时「组件大小
                       不一」就是这么来的。现在与能力 chip 共用 CHIP。
                       虚线边用 `border` + `box-border` 之外的写法会改变 chip 的
                       实际尺寸（边框吃进 padding），所以不支持态补一层
                       `border border-transparent` 占位，两种态外框同宽。 */
                    className={`${CHIP} border border-transparent box-border`}
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
            {declared.length === 0 && !observedProfile && (
              <p className="mt-2 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
                这个 Agent 只返回最终回答，不暴露执行过程。
              </p>
            )}
            {observedProfile && (
              <p
                className="mt-2 text-secondary"
                data-observed-capabilities
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {observed.length > 0
                  ? `最近一次运行（${observedProfile.key.model ?? '默认模型'} · ${observedProfile.key.gateway}）实际给出：${observed
                      .map(k => EVENT_CAPABILITY_META[k].label)
                      .join('、')}`
                  : '最近一次运行只返回了最终回答 —— 上面这些过程能力一项都没出现。'}
                {undeclared.length > 0 &&
                  `；其中「${undeclared.map(k => EVENT_CAPABILITY_META[k].label).join('、')}」清单里没有声明`}
              </p>
            )}
          </section>
        );
      })()}

      {/* 结构化技能（参考 A2A AgentSkill）：展示可承接的具体任务及其数据形式。 */}
      {(agent.skills?.length ?? 0) > 0 && (
        <section className="mt-6" data-agent-skills>
          <h3 className="tc-section-title mb-2">可承接的任务</h3>
          <div className={`tc-detail-rows overflow-hidden ${CARD}`} style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
            {agent.skills!.map(skill => (
              <div key={skill.id} className={`${ROW_X} ${ROW_Y}`} data-agent-skill={skill.id}>
                <div className="text-body font-medium" style={{ color: 'var(--td-text-color-primary)' }}>{skill.name}</div>
                <div className="mt-1 text-body leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>{skill.description}</div>
                {skill.tags && skill.tags.length > 0 && (
                  <div className="mt-1 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>关键词：{skill.tags.join(' · ')}</div>
                )}
                {((skill.inputModes?.length ?? 0) > 0 || (skill.outputModes?.length ?? 0) > 0) && (
                  <div className="mt-1 text-secondary" style={{ color: 'var(--td-text-color-placeholder)' }}>
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
            className={`${CARD} ${ROW_X} ${ROW_Y} text-body leading-relaxed`}
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
          <div className={`tc-detail-rows overflow-hidden ${CARD}`} style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
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
    // A115：`px-4 py-3` 原来是这里和各处手写的第四份；现在只有这一份。
    // 上下 12px 与 chip 的 `py-1`(4px)×2 + 12px 行高 = 20px 形成 2:5 的节奏，
    // 一行读起来不会显得比 chip 重。
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

/**
 * 账号与权益的按需加载。
 *
 * 任何失败（后端 500 / 网络断）都当作「没有」—— 详情页是核心页面，
 * 不能因为一块附加信息拉取失败就弹错误条。拉不到就整块不渲染，
 * 用户看到的仍是完整的资料页。
 *
 * `agentId` 变了（同族跳转）要重新拉：两套账号数据完全不同。
 */
function useAgentAccount(agentId: string): AgentAccount | null {
  const [account, setAccount] = useState<AgentAccount | null>(null);
  useEffect(() => {
    let alive = true;
    setAccount(null);
    fetch(`/api/agents/${encodeURIComponent(agentId)}/account`)
      .then(res => (res.ok ? res.json() : null))
      .then((data: { account?: AgentAccount | null } | null) => {
        if (!alive) return;
        setAccount(data?.account ?? null);
      })
      .catch(() => {
        if (alive) setAccount(null);
      });
    return () => {
      alive = false;
    };
  }, [agentId]);
  return account;
}

/**
 * 邮箱掩码：`svipcatai@gmail.com` → `z***@gmail.com`。
 *
 * 详情页会被截图、会被贴进群里，完整邮箱没必要出现在界面上；
 * 但保留首字母与域名，用户仍然认得出是哪个账号。
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}
