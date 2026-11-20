import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChatMarkdown } from '@tdesign-react/chat';
import { useSmoothText } from '../hooks/useSmoothText';
import { stripEmoji } from '../utils/plainText';
import { useTranslation } from '../i18n';
import { chartOf, planAnswer, type AnswerSegment } from '../answer/renderPlan';
import { AnswerChartCard, AnswerCodeCard, AnswerEvidence, AnswerLinkCards, AnswerTableCard } from './AnswerCards';

/**
 * A3：给每个片段一个**内容稳定**的 key。
 *
 * 原来用数组下标。正文是流式增长的前缀，`planAnswer` 会在中途把一段 md
 * 拆成 md + 表格卡 + md —— 一旦在中间插入片段，后面所有下标平移，已渲染
 * 的 Cherry 正文会整体换 key 重新挂载，表现为一次明显闪动。
 *
 * md 片段用「第几个 md」而不是文本 hash：markdown 文本每 32ms 就变长一次，
 * hash 会每帧变，等于把重挂载写进每一帧。md 的顺序在流式中只会在尾部追加，
 * 因此序号是稳定的；非 md 片段（表格/证据/链接/代码卡）由内容派生，
 * 内容不变 key 就不变。
 */
function segmentKeys(segments: AnswerSegment[]): string[] {
  let mdCount = 0;
  const used = new Map<string, number>();
  return segments.map(seg => {
    let base: string;
    switch (seg.kind) {
      case 'md':
        base = `md:${mdCount++}`;
        break;
      case 'links':
        base = `links:${seg.items[0]?.url ?? ''}`;
        break;
      case 'evidence':
        base = `evidence:${seg.command.slice(0, 32)}`;
        break;
      case 'table':
        base = `table:${seg.header.join('|').slice(0, 48)}`;
        break;
      case 'coderef':
        base = `coderef:${seg.path}:${seg.from}`;
        break;
      default:
        base = 'seg';
    }
    // 同一条命令/同一个表头可能合法地出现两次，补序号避免 key 冲突
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  });
}

/** 复制成功后临时替换的勾图标：尺寸/描边与 cherryCodeIcon.ts 的复制图标同档 */
const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
  'stroke-linejoin="round" style="display:block"><path d="m4 12 5 5L20 6"/></svg>';

/**
 * 把正文末段的段落下边距归零。
 *
 * 为什么必须注入 `<style>` 而不是在 index.css 里写 `::part(md_p):last-child`：
 * Cherry 给 `p / pre / blockquote / table` 的规则是 `margin: 0 0 16px`，而
 * `::part()` 之后接 `:last-child` 在 Chromium 里**不匹配**（实测末段仍是 16px），
 * 只能进影子根内部加一条规则。样式元素挂在 shadowRoot 上而不是 Cherry 的
 * 渲染容器里 —— 流式每帧都会重写容器 innerHTML，挂在里面会被一起冲掉。
 */
const FLUSH_TAIL_CSS = `
p:last-child,
ul:last-child,
ol:last-child,
pre:last-child,
table:last-child,
blockquote:last-child,
h1:last-child,
h2:last-child,
h3:last-child,
h4:last-child,
h5:last-child,
h6:last-child,
div[data-type='codeBlock']:last-child {
  margin-bottom: 0 !important;
}
`;

/**
 * 代码块外层 wrapper（div[data-type=codeBlock]）的 16px 下边距归一。
 *
 * Cherry 影子样式给 wrapper `margin-bottom: var(--spacing-lg)`（16px），而应用
 * 侧 `::part(md_pre)` 只命中内部 pre（12px）——wrapper 是 inline-block 形成
 * BFC，两段不折叠，每个代码块底部实际 12+16=28px，段落只有 0.6em（≈8.4px），
 * 代码块前后「行距明显大一档」（2026-11-20 用户反馈的行距不一致主因之一）。
 * app 侧没有能只命中 codeBlock wrapper 的 ::part 选择器（part 按标签名加），
 * 所以同样走影子根注入；幂等标记与 FLUSH_TAIL 的通道独立（后者随末段增删）。
 */
const CODEBLOCK_MARGIN_CSS = `div[data-type='codeBlock'] { margin-bottom: 0 !important; }`;

/**
 * 单个 markdown 片段的外壳。
 *
 * 两件事都要求「拿到影子根」，所以合在这里做：
 *   1. 末段不留白 —— 见 FLUSH_TAIL_CSS；
 *   2. 代码块复制回显 —— Cherry 的复制按钮在 shadow DOM 里，它自己的反馈是
 *      把字体图标从 copy 换成 ok，而这套字体从未加载，点完屏幕毫无变化。
 *      这里在捕获阶段监听宿主影子根上的 click：命中复制按钮后用**同一段代码
 *      文本**写一次剪贴板来判断成败（Cherry 自己也会写一次，内容完全一致，
 *      不会改掉复制出去的内容），成功就把图标换成勾、并在按钮左侧浮出气泡。
 *
 * 监听挂在 shadowRoot 上而不是按钮上：Cherry 的按钮是**hover 时重建**的，
 * 挂在按钮上的监听下一次 hover 就丢了；影子根的生命周期跟着宿主走，稳定得多。
 */
function MarkdownSegment({ text, flushTail }: { text: string; flushTail: boolean }) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ top: number; right: number; ok: boolean } | null>(null);
  const flashTimer = useRef<number | null>(null);
  /** 还原被临时换成勾的图标；连点两次时先还原再存新值，避免把勾当成原图标 */
  const iconUndo = useRef<(() => void) | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const bound = new WeakSet<ShadowRoot>();
    const roots: Array<{ sr: ShadowRoot; handler: (event: Event) => void }> = [];

    const clearIcon = () => {
      if (iconUndo.current) {
        iconUndo.current();
        iconUndo.current = null;
      }
    };

    /**
     * 取这次点击对应代码块的 `pre`。
     *
     * 不能直接 `btn.closest('[data-type="codeBlock"]')`：Cherry 把工具条容器
     * 挂在**预览区之外**（`previewerDom.after(...)`），按钮在 DOM 上并不属于
     * 那个代码块。这里改成按几何位置找 —— 工具条正覆盖在代码块右上角，
     * 包含按钮中心点的那个代码块就是它要复制的那一块。
     */
    const preOf = (btn: Element, sr: ShadowRoot): HTMLElement | null => {
      const direct = btn.closest('[data-type="codeBlock"]')?.querySelector('pre');
      if (direct) return direct;
      const r = btn.getBoundingClientRect();
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      sr.querySelectorAll('[data-type="codeBlock"]').forEach(el => {
        const blockRect = el.getBoundingClientRect();
        const inside =
          r.left >= blockRect.left - 1 &&
          r.right <= blockRect.right + 1 &&
          r.top >= blockRect.top - 1 &&
          r.bottom <= blockRect.bottom + 1;
        const dist = inside
          ? 0
          : Math.abs(r.top - blockRect.top) + Math.abs(blockRect.right - r.right);
        if (dist < bestDist) {
          bestDist = dist;
          best = el.querySelector('pre');
        }
      });
      return best;
    };

    const onClick = (event: Event, sr: ShadowRoot) => {
      const target = event.target as Element | null;
      const btn = target?.closest?.('.cherry-copy-code-block');
      if (!btn) return;

      // Cherry 复制的是 `pre.innerText`；用同一份文本判断成败，复制结果不变
      const code = preOf(btn, sr)?.innerText ?? '';
      const btnRect = btn.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();

      const show = (ok: boolean) => {
        if (!box.isConnected) return;
        if (flashTimer.current) window.clearTimeout(flashTimer.current);
        setFlash({
          top: Math.max(0, btnRect.top - boxRect.top + 2),
          right: Math.max(0, boxRect.right - btnRect.left + 4),
          ok,
        });
        flashTimer.current = window.setTimeout(() => {
          setFlash(null);
          clearIcon();
          flashTimer.current = null;
        }, 1600);
      };

      clearIcon();
      // 非安全上下文（如 file://）里 clipboard 可能整个不存在，按失败处理
      if (!code || !navigator.clipboard) {
        show(false);
        return;
      }
      navigator.clipboard
        .writeText(code)
        .then(() => {
          const icon = btn.querySelector('.tc-cherry-copy-icon');
          if (icon) {
            const prev = icon.innerHTML;
            icon.innerHTML = CHECK_SVG;
            iconUndo.current = () => {
              if (icon.isConnected) icon.innerHTML = prev;
            };
          }
          show(true);
        })
        .catch(() => show(false));
    };

    const attach = (sr: ShadowRoot) => {
      if (bound.has(sr)) return;
      bound.add(sr);
      const handler = (event: Event) => onClick(event, sr);
      roots.push({ sr, handler });
      sr.addEventListener('click', handler, true);
      if (!sr.querySelector('style[data-tc-md-margin]')) {
        const marginStyle = document.createElement('style');
        marginStyle.setAttribute('data-tc-md-margin', '1');
        marginStyle.textContent = CODEBLOCK_MARGIN_CSS;
        sr.appendChild(marginStyle);
      }
      if (flushTail && !sr.querySelector('style[data-tc-md-flush]')) {
        const style = document.createElement('style');
        style.setAttribute('data-tc-md-flush', '1');
        style.textContent = FLUSH_TAIL_CSS;
        sr.appendChild(style);
      }
    };

    const scan = () => {
      box.querySelectorAll('t-chat-md-content').forEach(host => {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) attach(sr);
      });
    };

    scan();
    // 宿主节点可能晚一帧才升级出影子根，持续盯着子树的增删
    const mo = new MutationObserver(scan);
    mo.observe(box, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      roots.forEach(({ sr, handler }) => sr.removeEventListener('click', handler, true));
      // flushTail 由真变假（后面又排上了表格卡等片段）时，末段留白要还回去
      box.querySelectorAll('t-chat-md-content').forEach(host => {
        host.shadowRoot?.querySelector('style[data-tc-md-flush]')?.remove();
      });
      if (flashTimer.current) {
        window.clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
      clearIcon();
    };
  }, [flushTail]);

  return (
    <div ref={boxRef} className="relative min-w-0 max-w-full">
      <ChatMarkdown content={text} />
      {flash && (
        <span
          className="tc-copy-flash"
          data-copy-flash={flash.ok ? 'ok' : 'fail'}
          style={{ top: flash.top, right: flash.right }}
        >
          {flash.ok ? `✓ ${t('chat.copy.done')}` : t('chat.copy.failedClipboard')}
        </span>
      )}
    </div>
  );
}

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
/**
 * 流式态：把正文尾部「未闭合且体内还没有内容」的围栏从**渲染文本**里剪掉。
 *
 * Cherry 的流式管线会把未闭合围栏自动闭合渲染 —— 揭示停在「```bash」而代码
 * 体还没到时，正文和光标之间会出现一个空的代码块面板（padding+边框+margin
 * ≈ 60px，深色底与气泡同色），看起来就是正文中段一大块空白（2026-11-20
 * 用户反馈的行距不一致主因）。文本本体不动：下一个 delta 让围栏体有了首行
 * 内容后自然恢复显示。
 */
function trimTrailingEmptyFence(text: string): string {
  const fences = [...text.matchAll(/^[ \t]{0,3}(?:```+|~~~+)/gm)];
  if (fences.length % 2 === 0) return text; // 围栏都闭合（或成对）
  const last = fences[fences.length - 1];
  const lineEnd = text.indexOf('\n', last.index);
  const body = lineEnd === -1 ? '' : text.slice(lineEnd + 1);
  if (/^\s*$/.test(body)) return text.slice(0, last.index); // 围栏体还是空的
  return text;
}

function AnswerMarkdownImpl({
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
  const { shown, settling } = useSmoothText(plain, streaming);
  // 收尾追赶期间仍按「流式」规划分段：正文还没揭示完，不能提前把
  // 未闭合的表格/列表当成已收尾的结构（否则会闪一下卡片再变回去）
  const planStreaming = streaming || settling;
  const segments = useMemo(
    () => planAnswer(planStreaming ? trimTrailingEmptyFence(shown) : shown, { streaming: planStreaming }),
    [shown, planStreaming]
  );
  const keys = useMemo(() => segmentKeys(segments), [segments]);
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
        const key = keys[idx];
        switch (seg.kind) {
          case 'links':
            return <AnswerLinkCards key={key} items={seg.items} />;
          case 'evidence':
            return (
              <AnswerEvidence
                key={key}
                command={seg.command}
                output={seg.output}
                lines={seg.lines}
                at={at}
              />
            );
          case 'table': {
            const chart = chartOf(seg);
            return chart ? (
              <AnswerChartCard key={key} table={seg} chart={chart} />
            ) : (
              <AnswerTableCard key={key} table={seg} />
            );
          }
          case 'coderef':
            return (
              <AnswerCodeCard
                key={key}
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
            return (
              <MarkdownSegment
                key={key}
                text={seg.text}
                /* 只有整条回答的**最后一段**才吃掉末段留白：中间片段后面还跟着
                   表格卡 / 证据卡，保留 16px 才有可能读的块间距。 */
                flushTail={idx === segments.length - 1}
              />
            );
        }
      })}
    </div>
  );
}

/**
 * A3：memo 化。
 *
 * 同一轮里已结束的正文块，props（text/streaming/cwd/at）不会再变；不 memo
 * 的话，父级每帧重渲染都会让 `stripEmoji → useSmoothText → planAnswer →
 * Cherry` 整条链路重新走一遍 —— 这正是历史消息拖慢流式的原因之一。
 */
export const AnswerMarkdown = memo(AnswerMarkdownImpl);


export default AnswerMarkdown;
