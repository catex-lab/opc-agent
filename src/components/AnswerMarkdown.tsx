import { ChatMarkdown } from '@tdesign-react/chat';
import { useSmoothText } from '../hooks/useSmoothText';
import { stripEmoji } from '../utils/plainText';

/**
 * 答案正文的 markdown 容器（方案 C：正文匀速揭示）。
 *
 * 单独成组件只为了一件事：`useSmoothText` 是 hook，而 `renderBlock` 是
 * ChatMessages 里的普通函数，不能在循环里调 hook。包一层之后，每个 text
 * 块各自持有自己的揭示游标 —— 一条消息里多段文本互不干扰。
 *
 * `data-revealed` / `data-answer-markdown` 是给验收脚本的钩子：Cherry 的
 * 渲染结果在组件内部，外部读不到，只能从外层属性判断「揭示到第几个字」。
 *
 * A149：emoji 在**交给揭示游标之前**去掉。顺序不能反 —— 先去后揭示，游标
 * 数的是净化后的字数（`data-revealed` 与屏幕上看到的字数一致）；反过来会
 * 出现「揭示到第 120 字，但净化后只剩 118 字」的错位，表现为末尾几个字
 * 永远显示不出来。`data-emoji-stripped` 是给闸门的钩子（有没有真的删掉过）。
 */
export function AnswerMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const plain = stripEmoji(text);
  const shown = useSmoothText(plain, streaming);
  return (
    <div
      className="chat-markdown min-w-0 max-w-full"
      data-answer-markdown
      data-answer-streaming={streaming ? '1' : '0'}
      data-revealed={shown.length}
      data-emoji-stripped={plain.length !== text.length ? '1' : '0'}
    >
      <ChatMarkdown content={shown} />
    </div>
  );
}

export default AnswerMarkdown;
