import { Users } from 'lucide-react';
import { AVATAR_PRESETS, avatarPresetOf, initialOf } from '../userProfile';

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
  size = 36,
  className,
  title,
}: {
  nickname: string;
  avatar?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
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
        backgroundColor: preset?.color ?? 'var(--td-bg-color-secondarycontainer)',
        // 无预设时用文字色：深色主题下这颗圆是浅底的（--agent-logo-tile 一族），
        // 文字必须跟主题走，否则浅底上出现白字
        color: preset ? undefined : 'var(--td-text-color-secondary)',
        border: '1px solid var(--tc-edge)',
        userSelect: 'none',
      }}
      title={title ?? (nickname || '我')}
      aria-label={nickname || '我'}
      data-user-avatar={preset?.id ?? (nickname ? 'initial' : 'me')}
    >
      {glyph}
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
 * 群头像（A115）。
 *
 * 需求「为群聊增加更换头像的功能」。会话列表、群聊头部、群设置三处
 * 原先各写了一份「多人群」图标圆 —— 现在收成这一个组件，换头像只改
 * `sessionFlags.avatar` 一处，三处一起变。
 *
 * 兜底仍是那颗 `Users` 图标（没选头像时与改造前完全一致），
 * 所以「不换头像」不是一个降级状态。
 */
export function GroupAvatar({
  avatar,
  size = 42,
  className,
  title,
}: {
  /** 头像预设 id，空串 = 兜底图标 */
  avatar?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const preset = avatarPresetOf(avatar);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
        backgroundColor: preset?.color ?? 'var(--tc-surface-raised)',
        color: preset ? undefined : 'var(--td-text-color-secondary)',
        border: '1px solid var(--tc-edge)',
        userSelect: 'none',
      }}
      title={title}
      aria-hidden={!title ? true : undefined}
      aria-label={title}
      data-group-avatar={preset?.id ?? 'default'}
    >
      {preset ? preset.glyph : <Users size={Math.round(size * 0.45)} />}
    </span>
  );
}
