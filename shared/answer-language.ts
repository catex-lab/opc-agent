/**
 * 「回答语言」偏好 —— 前端、服务端共用的唯一一份枚举。
 *
 * 三档都是用户可见的真实行为：
 *   auto  不向模型注入任何指令，由模型跟随用户来信的语言（默认，等同旧行为）
 *   zh    始终用简体中文回答
 *   en    始终用英文回答
 *
 * ⚠️ 服务端偏好校验（`server/preferences.ts`）、注册表注入
 * （`server/agents/registry.ts`）与设置页（`src/components/SettingsPage.tsx`）
 * 必须用同一个判定。各写一份字面量联合，就会出现「前端能存进去、后端不认」
 * 或者「设置看着生效了、发出去却没指令」这种没有报错的静默分歧。
 *
 * 注意：这一项只决定 **Agent 回答正文** 的语言，不决定界面文案。
 * 界面 i18n 是另一条独立的线，本轮不做。
 */

export type AnswerLanguage = 'auto' | 'zh' | 'en';

/** 默认档：不注入任何指令，与加这个设置之前的行为逐字节一致 */
export const ANSWER_LANGUAGE_DEFAULT: AnswerLanguage = 'auto';

export function isAnswerLanguage(value: unknown): value is AnswerLanguage {
  return value === 'auto' || value === 'zh' || value === 'en';
}
