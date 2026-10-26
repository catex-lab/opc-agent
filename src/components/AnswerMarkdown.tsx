import { ChatMarkdown } from '@tdesign-react/chat';
import { useSmoothText } from '../hooks/useSmoothText';

/**
 * 答案正文的 markdown 容器（方案 C：正文匀速揭示）。
 *
 * 单独成组件只为了一件事：`useSmoothText` 是 hook，而 `renderBlock` 是
 * ChatMessages 里的普通函数，不能在循环里调 hook。包一层之后，每个 text
 * 块各自持有自己的揭示游标 —— 一条消息里多段文本互不干扰。
 *
 * `data-revealed` / `data-answer-markdown` 是给验收脚本的钩子：Cherry 的
 * 渲染结果在组件内部，外部读不到，只能从外层属性判断「揭示到第几个字」。
 */
export function AnswerMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  return (
    <div
      className="chat-markdown min-w-0 max-w-full"
      data-answer-markdown
      data-answer-streaming={streaming ? '1' : '0'}
      data-revealed={shown.length}
    >
      <ChatMarkdown content={shown} />
    </div>
  );
}

export default AnswerMarkdown;
