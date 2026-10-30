/**
 * A149 验证：答案正文的排版净化（`stripEmoji`）。
 *
 * 为什么单独写：这个函数的失败模式是**静默的两种**——
 *   · 少删：模型吐的 📰 直接出现在正文里（用户报的就是这个）；
 *   · 多删：把代码块里的 `"✅"` 也吃掉，用户复制出去编译不过。
 * 两条都不会让构建或类型检查响一声。所以断言必须成对：**该删的删掉、
 * 不该删的一个字都不许动**。
 *
 * 跑法：npx tsx scripts/verify-a149-plain-text.ts
 */
import { stripEmoji } from '../src/utils/plainText.js';

let pass = 0;
let fail = 0;
function say(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`);
  }
}

function eq(name: string, input: string, want: string): void {
  const got = stripEmoji(input);
  say(name, got === want, got === want ? '' : `得到 ${JSON.stringify(got)} / 期望 ${JSON.stringify(want)}`);
}

console.log('[A149] stripEmoji');

/* ── 该删的 ─────────────────────────────────────────────────────── */

// 1. 用户截图里那一条：段首 emoji + 空格 + 标题
eq('1-1 段首 emoji 连同空格一起删', '📰 最新官方发布（OpenAI News 博客）', '最新官方发布（OpenAI News 博客）');

// 2. 句中 emoji：只吃后面的空格，不吃前面的 —— 否则英文会粘成一个词
eq('1-2 句中 emoji 只删自己与尾随空格', '这是 📰重要 消息', '这是 重要 消息');

// 3. 组合序列：国旗 / ZWJ 组合 / 肤色修饰符，各自算**一个**整体
eq('1-3 国旗、ZWJ 组合、肤色修饰符都算整体', '国旗 🇨🇳 组合 👨‍💻 肤色 👍🏽 结束', '国旗 组合 肤色 结束');

// 4. 键帽：基础字符是 ASCII，必须靠单独的形状匹配，不能连数字一起删
eq('1-4 键帽序列（数字+VS16+U+20E3）', '键帽 1️⃣ 结束', '键帽 结束');

// 5. 连续多个
eq('1-5 连续 emoji 全部删净', '😊😊😊', '');

// 6. 表情 + 变体选择符（U+FE0F）
eq('1-6 带 U+FE0F 的 emoji', '注意⚠️安全', '注意安全');

/* ── 不该删的 ───────────────────────────────────────────────────── */

// 7. 标点：这些**不是** Extended_Pictographic，本来就不该被匹配
eq('2-1 排版符号原样保留', 'A → B · C ± D ✓ ✗ ★ ①', 'A → B · C ± D ✓ ✗ ★ ①');

// 8. 版权/商标：它们是 Extended_Pictographic，靠白名单放行
eq('2-2 © ® ™ 放行', '© 2026 OPC Agent · 商标 ™ 与 ®', '© 2026 OPC Agent · 商标 ™ 与 ®');

// 9. 行内 code：命令行参数里的 ✅ 是参数，删掉就改了命令
eq('2-3 行内 code 一字不动', '执行 `tool --ok "✅"` 即可', '执行 `tool --ok "✅"` 即可');

// 10. 围栏代码块：整段不动（含换行与缩进）
const fence = '```js\nconst mark = "🔍"; // 📰\n```';
eq('2-4 围栏代码块一字不动', fence, fence);

// 11. 代码块之外的 emoji 仍然要删 —— 证明 2-4 不是「整篇都跳过」
eq(
  '2-5 代码块外仍删（否定式配肯定式）',
  '📰 说明\n```js\nconst mark = "🔍";\n```\n😊 结束',
  '说明\n```js\nconst mark = "🔍";\n```\n结束'
);

// 12. 空串与无 emoji 文本：幂等，不引入任何变化
eq('3-1 普通文本原样返回', '普通一行，没有任何表情。', '普通一行，没有任何表情。');
say('3-2 空串安全', stripEmoji('') === '');

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
