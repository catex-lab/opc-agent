import { useMemo } from 'react';
import { ChatMarkdown } from '@tdesign-react/chat';
import { useSmoothText } from '../hooks/useSmoothText';
import { stripEmoji } from '../utils/plainText';
import { chartOf, planAnswer } from '../answer/renderPlan';
import { AnswerChartCard, AnswerCodeCard, AnswerEvidence, AnswerLinkCards, AnswerTableCard } from './AnswerCards';

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
 * 永远显示不出来。`data-emoji-stripped` 是给闸门的钩子（有没有真的删过）。
 *
 * A174：内容分级渲染。`planAnswer()` 把正文切成 `md` / `links` /
 * `evidence` / `table` / `coderef` 五种片段，`md` 片段**照旧**交给
 * ChatMarkdown —— 这里没有引入任何新的 markdown 解析器，只是在段落边界上
 * 把本来就自成一块的内容换成更紧凑的卡片。切分是纯函数，随揭示游标逐帧
 * 重算（代价是 O(字数)，与 Cherry 自己每帧重渲染相比可以忽略）。
 *
 * 表格只有「两列标签+数值、≥3 行、全非负」时才升级成图表卡，其余一律
 * 表格卡；图卡里也保留「查看表格」的回退路径。
 */
export function AnswerMarkdown({
  text,
  streaming,
  cwd,
  at,
}: {
  text: string;
  streaming: boolean;
  /** 会话工作目录：代码改动卡要靠它把相对路径补成绝对路径 */
  cwd?: string | null;
  /** 消息时间（证据块摘要里的「时间」），没有就不显示 */
  at?: string;
}) {
  const plain = stripEmoji(text);
  const shown = useSmoothText(plain, streaming);
  const segments = useMemo(() => planAnswer(shown, { streaming }), [shown, streaming]);
  return (
    <div
      className="chat-markdown min-w-0 max-w-full"
      data-answer-markdown
      data-answer-streaming={streaming ? '1' : '0'}
      data-revealed={shown.length}
      data-emoji-stripped={plain.length !== text.length ? '1' : '0'}
      data-answer-segments={segments.length}
    >
      {segments.map((seg, idx) => {
        switch (seg.kind) {
          case 'links':
            return <AnswerLinkCards key={idx} items={seg.items} />;
          case 'evidence':
            return (
              <AnswerEvidence
                key={idx}
                command={seg.command}
                output={seg.output}
                lines={seg.lines}
                at={at}
              />
            );
          case 'table': {
            const chart = chartOf(seg);
            return chart ? (
              <AnswerChartCard key={idx} table={seg} chart={chart} />
            ) : (
              <AnswerTableCard key={idx} table={seg} />
            );
          }
          case 'coderef':
            return (
              <AnswerCodeCard
                key={idx}
                path={seg.path}
                from={seg.from}
                to={seg.to}
                added={seg.added}
                removed={seg.removed}
                note={seg.note}
                cwd={cwd}
              />
            );
          default:
            return <ChatMarkdown key={idx} content={seg.text} />;
        }
      })}
    </div>
  );
}

export default AnswerMarkdown;
