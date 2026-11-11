import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { AVATAR_PRESETS, avatarPresetOf, initialOf } from '../userProfile';
import { AgentAvatar } from './AgentAvatar';
import type { RegisteredAgent } from '../types';

/**
 * 用户头像 —— 设置页、群设置、会话列表三处共用。
 *
 * ## 为什么不用 AgentAvatar
 *
 * AgentAvatar 是给注册表里的 Agent 用的：它带 availability 状态点、
 * 要按 agentId 反查备注、还认 agent.icon 这套图标键。用户没有这些 ——
 * 用户不在注册表里，也没有「在线状态」。硬套会让这个组件背着一堆
 * 永远为 undefined 的分支。
 *
 * ## 兜底顺序
 *
 * 预设（emoji + 底色）> 昵称首字 > 「我」。
 * 没有昵称也没有选头像时显示「我」而不是「?」—— 「?」读起来像加载失败。
 */
export function UserAvatar({
  nickname,
  avatar,
  image,
  size = 36,
  className,
  title,
}: {
  nickname: string;
  avatar?: string;
  /**
   * A160：上传的图片头像。优先级 图片 > 预设 > 昵称首字 > 「我」。
   * 图片是覆盖层 —— 移除后自动回到之前选的预设，不会变成空白。
   */
  image?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const customSrc = image?.trim();
  const preset = avatarPresetOf(avatar);
  const glyph = preset?.glyph ?? (nickname ? initialOf(nickname) : '我');
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.52),
        lineHeight: 1,
        overflow: customSrc ? 'hidden' : undefined,
        backgroundColor: customSrc
          ? 'var(--agent-logo-tile)'
          : preset?.color ?? 'var(--td-bg-color-secondarycontainer)',
        // 无预设时用文字色：深色主题下这颗圆是浅底的（--agent-logo-tile 一族），
        // 文字必须跟主题走，否则浅底上出现白字
        color: preset && !customSrc ? undefined : 'var(--td-text-color-secondary)',
        border: '1px solid var(--tc-edge)',
        userSelect: 'none',
      }}
      title={title ?? (nickname || '我')}
      aria-label={nickname || '我'}
      data-user-avatar={customSrc ? 'image' : preset?.id ?? (nickname ? 'initial' : 'me')}
    >
      {customSrc ? (
        <img
          src={customSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-user-avatar-image
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        glyph
      )}
    </span>
  );
}

/** 供选择器用的平铺格子。选中态用一圈实线边 + 对勾，不靠底色 ——
 *  12 个格子并排时底色选中会让整片花掉 */
export function AvatarPickerGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-6 gap-2" data-avatar-picker>
      {AVATAR_PRESETS.map(p => {
        const active = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            title={p.label}
            aria-label={p.label}
            aria-pressed={active}
            data-avatar-option={p.id}
            onClick={() => onChange(p.id)}
            className="flex items-center justify-center rounded-full transition-transform hover:scale-105"
            style={{
              width: 40,
              height: 40,
              fontSize: 21,
              lineHeight: 1,
              backgroundColor: p.color,
              border: active ? '2px solid var(--td-brand-color)' : '1px solid var(--tc-edge)',
              outline: 'none',
            }}
          >
            {p.glyph}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 群头像（A115；2026-11-12 起支持自定义图片与成员拼贴默认头像）。
 *
 * 需求「为群聊增加更换头像的功能」。会话列表、群聊头部、群设置三处
 * 原先各写了一份「多人群」图标圆 —— 现在收成这一个组件，换头像只改
 * `sessionFlags.avatar` 一处，三处一起变。
 *
 * ## 渲染优先级（2026-11-12 批准稿）
 *
 *   自定义上传图片 > 预设 emoji > **成员拼贴（新默认）** > `Users` 图标
 *
 * 拼贴取成员列表**前 4 位**（按建群时的 agentIds 顺序，不额外排序），
 * 每格用 `AgentAvatar` 渲染（状态点不渲染 —— 42px 塞 4 颗状态点会花掉，
 * 这是批准稿明确的取舍）。`members` 没传或为空时兜底仍是那颗 `Users`
 * 图标（与改造前完全一致），所以「没拉到成员」不是一个降级状态，
 * 不传 members 的调用点零回归。
 */
export interface GroupAvatarMember {
  id: string;
  name: string;
  /** 内置 logo 键（AGENT_LOGOS 的键），对应 RegisteredAgent.icon */
  icon?: string;
  /** 用户上传的 logo URL（`/api/avatars/<file>`），对应 RegisteredAgent.logoUrl */
  src?: string;
  /** 品牌色（无 logo 时的首字母底色兜底） */
  color?: string;
}

/** 拼贴布局按人数定档。areas 里每个字母对应第几位成员的格子 */
const COLLAGE_AREAS: Record<2 | 3 | 4, string> = {
  // 3 人：左大右二（左格跨两行，右列上下各一格）
  3: '"a b" "a c"',
  // 2 人：上下均分 —— 一列两行（列数要跟着收成 1 列，见 gridStyle）
  2: '"a" "b"',
  // 4 人：2×2 均分
  4: '"a b" "c d"',
};

export function GroupAvatar({
  avatar,
  image,
  members,
  size = 42,
  className,
  title,
  onMemberClick,
}: {
  /** 头像预设 id，空串 = 落到拼贴 / 兜底图标 */
  avatar?: string;
  /**
   * 自定义上传图片的 URL（`/api/avatars/<file>`），最高优先。
   * 图片是覆盖层：移除后自动回到预设 / 拼贴。图片加载失败（比如文件
   * 已被服务端回收）同样落回下一优先级，不让用户看到一颗空圆。
   */
  image?: string;
  /** 群成员（调用方按 session.agentIds 从注册表映射）；取前 4 位做拼贴 */
  members?: GroupAvatarMember[];
  size?: number;
  className?: string;
  title?: string;
  /**
   * 点某个成员格子。只有群聊头部传（点开头像看详情）；列表里的格子
   * 不传 —— 会话行 / 通讯录行本身就是 button，格子再套一层 button
   * 是非法嵌套。
   */
  onMemberClick?: (memberId: string) => void;
}) {
  const preset = avatarPresetOf(avatar);
  const customSrc = image?.trim() ?? '';
  // 图片 404 时落回下一优先级。key 是 URL：换图时把「坏图」状态一起重置
  const [imageBroken, setImageBroken] = useState(false);
  useEffect(() => setImageBroken(false), [customSrc]);

  const showImage = !!customSrc && !imageBroken;
  const collage = !showImage && !preset && members && members.length > 0 ? members.slice(0, 4) : null;

  // 拼贴格子里 AgentAvatar 的边长。外圈 1px 描边 + 格间 1px 间隙都吃掉直径：
  //   1 人独占 = 内容盒（size − 2×边框）；≥2 人 = （内容盒 − 间隙）/ 2。
  // 3 人左格是 19.5×41 的竖长格、2 人是 41×19.5 的横长格 —— AgentAvatar
  // 只出正方形圆，格子用 flex 居中兜住，长边露出的底衬就是格子的
  // --tc-surface-chrome，与效果稿「contain 居中 + 浅底衬」同一观感。
  const cellSize =
    collage && collage.length > 1 ? (size - 3) / 2 : Math.max(0, size - 2);

  const cell = (m: GroupAvatarMember, i: number) => {
    // 1 人时独占整颗圆（自动放置，不引用具名 area）
    const area =
      collage && collage.length === 4
        ? ['a', 'b', 'c', 'd'][i]
        : collage && collage.length > 1
          ? ['a', 'b', 'c'][i]
          : undefined;
    return (
      <div
        key={m.id}
        data-group-avatar-cell={m.id}
        style={{
          gridArea: area,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          backgroundColor: 'var(--tc-surface-chrome)',
        }}
      >
        {onMemberClick ? (
          <button
            type="button"
            onClick={() => onMemberClick(m.id)}
            // 群聊头部的成员位标记：与旧的成员堆叠共用同一个锚点，
            // 「点头像看该成员详情」的手势不变（p7 闸门按它点）
            data-member-avatar={m.id}
            title={m.name}
            aria-label={`查看 ${m.name} 的详情`}
            className="flex items-center justify-center rounded-full"
          >
            <AgentAvatar
              id={m.id}
              name={m.name}
              icon={m.icon}
              src={m.src}
              color={m.color}
              size={cellSize}
              showStatus={false}
            />
          </button>
        ) : (
          <AgentAvatar
            id={m.id}
            name={m.name}
            icon={m.icon}
            src={m.src}
            color={m.color}
            size={cellSize}
            showStatus={false}
          />
        )}
      </div>
    );
  };

  const outer = `inline-flex shrink-0 items-center justify-center rounded-full ${className ?? ''}`;

  // ── ① 自定义图片：整圆 cover 铺满 ──
  if (showImage) {
    return (
      <span
        className={outer}
        style={{
          width: size,
          height: size,
          overflow: 'hidden',
          backgroundColor: 'var(--agent-logo-tile)',
          border: '1px solid var(--tc-edge)',
          userSelect: 'none',
        }}
        title={title}
        aria-hidden={!title ? true : undefined}
        aria-label={title}
        data-group-avatar="image"
      >
        <img
          src={customSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-group-avatar-image
          onError={() => setImageBroken(true)}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </span>
    );
  }

  // ── ② 预设 emoji：A115 原样 ──
  if (preset) {
    return (
      <span
        className={outer}
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.5),
          lineHeight: 1,
          backgroundColor: preset.color,
          border: '1px solid var(--tc-edge)',
          userSelect: 'none',
        }}
        title={title}
        aria-hidden={!title ? true : undefined}
        aria-label={title}
        data-group-avatar={preset.id}
      >
        {preset.glyph}
      </span>
    );
  }

  // ── ③ 成员拼贴：新默认。圆形裁切 + 1px 格隙 + --tc-edge 外圈 ──
  if (collage) {
    const n = collage.length;
    return (
      <span
        className={`shrink-0 rounded-full ${className ?? ''}`}
        style={{
          width: size,
          height: size,
          display: 'grid',
          // 2 人是上下两行（一列），1 人独占，3/4 人两列
          gridTemplateColumns: n >= 3 ? '1fr 1fr' : '1fr',
          gridTemplateRows: n === 1 ? '1fr' : '1fr 1fr',
          ...(n > 1 ? { gridTemplateAreas: COLLAGE_AREAS[n as 2 | 3 | 4] } : {}),
          gap: 1,
          overflow: 'hidden',
          // 格隙与格子底衬之间要分得出界线：容器底走内容面（效果稿的 --content），
          // 1px 格隙就是它透出来的细线
          backgroundColor: 'var(--tc-surface-content)',
          border: '1px solid var(--tc-edge)',
          userSelect: 'none',
        }}
        title={title}
        aria-hidden={!title ? true : undefined}
        aria-label={title}
        data-group-avatar="collage"
        data-group-avatar-collage=""
      >
        {collage.map((m, i) => cell(m, i))}
      </span>
    );
  }

  // ── ④ 兜底：Users 图标（没选头像且没有成员时与改造前完全一致）──
  return (
    <span
      className={outer}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
        backgroundColor: 'var(--tc-surface-raised)',
        color: 'var(--td-text-color-secondary)',
        border: '1px solid var(--tc-edge)',
        userSelect: 'none',
      }}
      title={title}
      aria-hidden={!title ? true : undefined}
      aria-label={title}
      data-group-avatar="default"
    >
      <Users size={Math.round(size * 0.45)} />
    </span>
  );
}

/**
 * 把会话的 agentIds 映射成 GroupAvatar 的 members。
 *
 * 只收**注册表里还存在**的 Agent（与群聊成员栏同一口径）—— 已下线的
 * Agent 没有名字也没有 logo，拼进拼贴只会留一个「?」格；全部下线时
 * GroupAvatar 自然落回 Users 兜底图标。
 */
export function groupAvatarMembersOf(
  agentIds: ReadonlyArray<string> | undefined,
  getAgent: (id: string | undefined) => RegisteredAgent | undefined
): GroupAvatarMember[] {
  return (agentIds ?? []).flatMap(id => {
    const agent = getAgent(id);
    return agent
      ? [{ id: agent.id, name: agent.name, icon: agent.icon, src: agent.logoUrl, color: agent.color }]
      : [];
  });
}
