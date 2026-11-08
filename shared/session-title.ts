/**
 * 会话「自动标题」的哨兵值。
 *
 * 新会话至今仍以中文文案 `新对话` 作为数据值写入会话记录。`App.tsx` 曾经
 * 直接比较这个字面量来决定「切换 Agent 时要不要顺手改标题」—— 这属于把
 * 中文文案当逻辑用：真把默认标题翻成英文，判断就会失效，用户改过的标题
 * 会被自动覆盖。
 *
 * 这里把哨兵收成一处：写入方（服务端默认值、前端新会话）与判断方都引用
 * 常量。**注意**：值本身仍是中文，这是数据兼容选择；显示层若要做 i18n，
 * 应判断 `isAutoSessionTitle()` 后渲染翻译后的文案，而不是改这个常量。
 */
export const AUTO_SESSION_TITLE = '新对话';

export function isAutoSessionTitle(title: string | null | undefined): boolean {
  return !title || title === AUTO_SESSION_TITLE;
}
