/**
 * 回答语言指令的组装（服务端唯一入口）。
 *
 * ## 为什么指令在服务端生成，而不是让每个适配器自己写
 *
 * 「自动 / 中文 / 英文」是一个产品决策。文案散在五个适配器里，改一个字
 * 就要改五处，而且必然有一处漏掉 —— 表现是「同一个设置，走 SDK 生效、
 * 走 CLI 不生效」，用户只会觉得这个开关是坏的。所以：
 *
 *   · `server/agents/registry.ts` 是**唯一决策点**（一次读取偏好，写进
 *     `SendContext.answerLanguage`）；
 *   · 本文件是**唯一的指令文案来源**；
 *   · 各适配器只负责把这一行拼到自己的提示词里（SDK 的 systemPrompt、
 *     CLI 的 prompt 前缀、ACP 的合并提示）。
 *
 * ## 「自动」档必须零副作用
 *
 * `auto` 时两个函数都**原样返回入参**：不改写、不 trim、不加空行。
 * 这样「自动」和加这个设置之前的字节完全一致 —— 不是「看起来一样」，
 * 是拼出来的字符串一模一样。
 */

import { loadPrefs } from './preferences.js';
import {
  ANSWER_LANGUAGE_DEFAULT,
  isAnswerLanguage,
  type AnswerLanguage,
} from '../shared/answer-language.js';

/** 当前生效的回答语言（偏好文件里没写过 = 自动） */
export function loadAnswerLanguage(): AnswerLanguage {
  const value = loadPrefs().answerLanguage;
  return isAnswerLanguage(value) ? value : ANSWER_LANGUAGE_DEFAULT;
}

/**
 * 给模型的指令原文。`auto` 返回 null（不注入）。
 *
 * 用英文写：这些对象（Codex / Claude Code / Gemini / opencode / 各类 SDK）
 * 的系统提示与 harness 都是英文，英文指令与它们同语种，模型跟随率更稳。
 * 中文档位额外写明「简体」，避免模型自作主张输出繁体。
 */
export function answerLanguageInstruction(lang: AnswerLanguage | undefined): string | null {
  switch (lang) {
    case 'zh':
      return 'Response language: Always respond in Simplified Chinese (简体中文), including explanations, notes and all communication, even if the user writes in another language.';
    case 'en':
      return 'Response language: Always respond in English, including explanations, notes and all communication, even if the user writes in another language.';
    default:
      return null;
  }
}

/**
 * 把指令追加到系统提示词末尾（不覆盖原文）。
 *
 * 位置放在**最末**，而不是开头：systemPrompt 里可能已经有用户人设（场景模板）
 * 与项目记忆，它们是用户显式选过的内容，不该被我们自己的一句话顶到后面去。
 * 追加一行、用 `---` 隔开，读起来是独立的一段。
 */
export function withAnswerLanguage(
  systemPrompt: string,
  lang: AnswerLanguage | undefined
): string;
export function withAnswerLanguage(
  systemPrompt: string | undefined,
  lang: AnswerLanguage | undefined
): string | undefined;
export function withAnswerLanguage(
  systemPrompt: string | undefined,
  lang: AnswerLanguage | undefined
): string | undefined {
  const line = answerLanguageInstruction(lang);
  // 自动档：**逐字节原样返回**（包括 undefined 与首尾空白）
  if (!line) return systemPrompt;
  const base = (systemPrompt ?? '').trimEnd();
  return base ? `${base}\n\n---\n${line}` : `---\n${line}`;
}

/**
 * 给 CLI 适配器的 prompt 前缀。
 *
 * CLI 不读 `systemPrompt`（见 `server/agents/adapters/cli.ts` 的说明），
 * 只能把指令并进本轮用户消息。自动档返回**原 prompt**，不加一个字节。
 */
export function withAnswerLanguagePrefix(
  prompt: string,
  lang: AnswerLanguage | undefined
): string {
  const line = answerLanguageInstruction(lang);
  return line ? `${line}\n\n${prompt}` : prompt;
}
