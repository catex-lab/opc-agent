/**
 * 「回答语言」偏好的前端入口（A209）。
 *
 * 读取顺序与其它界面偏好一致：注入 > localStorage > 默认（见 `src/prefs.ts`
 * 顶部注释）。这一项只在用户打开设置页时读一次，不需要首帧就位。
 *
 * 与「关闭窗口」一样只写服务端：真正消费这个值的是服务端的注册表
 * （`server/agents/registry.ts` → `server/answer-language.ts`），
 * 前端存一份镜像只是为了让 `npm run dev`（Vite 托管、拿不到注入）与
 * 既有闸门继续可用。
 */
import { bootPref, pushPrefs } from './prefs';
import {
  ANSWER_LANGUAGE_DEFAULT,
  isAnswerLanguage,
  type AnswerLanguage,
} from '../shared/answer-language';

export type { AnswerLanguage };
export { ANSWER_LANGUAGE_DEFAULT, isAnswerLanguage };

const KEY = 'opc.answer-language';

export function readAnswerLanguage(): AnswerLanguage {
  const injected = bootPref('answerLanguage');
  if (isAnswerLanguage(injected)) return injected;
  const raw = localStorage.getItem(KEY);
  return isAnswerLanguage(raw) ? raw : ANSWER_LANGUAGE_DEFAULT;
}

export function saveAnswerLanguage(language: AnswerLanguage): AnswerLanguage {
  localStorage.setItem(KEY, language);
  // 走既有偏好通道（PATCH /api/preferences），不新建任何存储机制
  pushPrefs({ answerLanguage: language });
  return language;
}
