/**
 * A136：对话正文排版 —— 让「问题」和「答案」同档。
 *
 * ## 先认一条错（审查报告 P2-1）
 *
 * `UIUX-AUDIT.md` 写的是「对话正文 13px，1080 宽窗口读长回答偏紧」。
 * **实测不成立**：真 Chrome 里助手 markdown 段落的 computed style 是
 * `font-size: 14px / line-height: 24.5px`（`index.css` 的
 * `.chat-markdown ::part(md_p)`）。报告读到的 13px 是 `--text-body` 这个
 * **令牌值**，不是正文真正生效的值 —— 与 P1-1「三个按钮完全一样」同一类误读。
 *
 * ## 量出来真正的问题
 *
 * 用户气泡 **16px**（没有 font-size，吃的是 TDesign 默认值），助手正文 14px。
 * 一段话问出去比答回来还大 —— 整屏最响的是问题。层级在这里应该由
 * **对齐 + 底色**承担（右对齐深底 / 左对齐浅底），不是字号。
 *
 * ## 这一层盯什么
 *
 * 1. **两边同档**：用户气泡字号 === 助手正文段落字号（这条是核心断言）；
 * 2. **同档于令牌**：等于 `--text-body-lg` 的解析值，而不是某个写死的 px
 *    —— 将来整体调档，闸门跟着走，不会变成一条假红；
 * 3. **行高也一致**：字号一样但行高不同，读起来仍是两种节奏；
 * 4. **深浅两套都成立**：深色主题下字号不会因为某条主题规则而不同。
 *
 * 运行：node scripts/verify-a136-chat-type.mjs（需先 npm run build）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = join(process.cwd(), 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
};

// ── 夹具 ────────────────────────────────────────────────────────────────
const AGENTS = [
  {
    id: 'a1',
    name: 'WorkBuddy',
    vendor: 'v',
    kind: 'sdk',
    icon: 'workbuddy',
    color: '#0EC8A9',
    description: 'x',
    capabilities: ['chat'],
    status: { availability: 'ready', version: '1' },
  },
];
const MODELS = [{ modelId: 'm', name: 'Sonnet 4.5' }];
const now = Date.now();
const SESSIONS = [
  { id: 's1', title: '会话甲', agent_id: 'a1', model: 'm', created_at: new Date(now - 60000).toISOString() },
];
// 两段正文：一段用来量字号，一段让段落间距也能量出来
const ANSWER =
  '这是一段用来量排版的回答正文。中文长回答在窄窗口里能不能舒服地读，取决于字号、行高和每行字数三者一起。' +
  '如果字号偏小，即使行高再大，眼睛也要多花力气去分辨字形。\n\n' +
  '第二段：同样的话再说一遍，好让段落之间的间距也能量出来。';
const QUESTION = '这是一条用户消息，用来量用户气泡里的字。';
const MSGS = [
  {
    id: 's1-m1',
    role: 'user',
    session_id: 's1',
    created_at: new Date(now - 50000).toISOString(),
    content: QUESTION,
    model: 'm',
  },
  {
    id: 's1-m2',
    role: 'assistant',
    session_id: 's1',
    author_agent_id: 'a1',
    created_at: new Date(now - 40000).toISOString(),
    content: ANSWER,
    model: 'm',
  },
];

// ── 静态服务 ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  let file = join(DIST, url === '/' ? 'index.html' : url);
  let body;
  try {
    body = await readFile(file);
  } catch {
    file = join(DIST, 'index.html');
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/** 量一次：助手段落 + 用户气泡 + 令牌值 */
async function measure(dark) {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(d => {
    try {
      localStorage.setItem('theme', d ? 'dark' : 'light');
    } catch {
      /* 存储被禁：用默认主题 */
    }
  }, dark);
  await ctx.route('**/api/**', async route => {
    const url = route.request().url();
    const json = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/\/api\/agents(\/probe)?(\?|$)/.test(url)) return json({ agents: AGENTS });
    if (/\/api\/models/.test(url)) return json({ models: MODELS });
    if (/\/api\/user-profile/.test(url)) return json({ nickname: '', avatar: '' });
    if (/\/api\/check-login/.test(url)) return json({ isLoggedIn: true, method: 'env', apiKey: 'sk-****1234' });
    if (/\/api\/sessions\/[^/]+$/.test(url)) {
      const id = url.split('/').pop().split('?')[0];
      const s = SESSIONS.find(x => x.id === id);
      return json({ session: s, messages: s ? MSGS : [] });
    }
    if (/\/api\/sessions/.test(url)) return json({ sessions: SESSIONS });
    return json({});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/chat/s1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const out = await page.evaluate(() => {
    const styleOf = el => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fontSize: parseFloat(cs.fontSize),
        lineHeight: parseFloat(cs.lineHeight),
        width: Math.round(el.getBoundingClientRect().width),
        text: (el.textContent || '').trim().slice(0, 12),
      };
    };
    // 助手正文在 t-chat-md-content 的 shadow root 里，最多钻三层
    let para = null;
    for (const host of document.querySelectorAll('.chat-markdown t-chat-md-content, t-chat-md-content')) {
      let root = host.shadowRoot;
      for (let d = 0; root && d < 3; d++) {
        const p = root.querySelector('p');
        if (p) {
          para = styleOf(p);
          break;
        }
        const next = root.querySelector('*');
        root = next && next.shadowRoot;
      }
      if (para) break;
    }
    // 用户气泡：取 .tc-bubble-user 自身（文字直接是它的子文本节点）
    const bubble = document.querySelector('.tc-bubble-user');
    const root = document.documentElement;
    const token = getComputedStyle(root).getPropertyValue('--text-body-lg').trim();
    return {
      para,
      bubble: styleOf(bubble),
      bubbleText: bubble ? (bubble.textContent || '').trim().slice(0, 12) : '',
      token,
      dark: root.classList.contains('dark'),
    };
  });
  await ctx.close();
  return { ...out, errors };
}

console.log('\n[1] 浅色：助手正文与用户气泡同档');
const light = await measure(false);
ok(light.para !== null, '找到助手 markdown 段落（shadow DOM 钻得到）', light.para ? light.para.text : '没找到');
ok(light.bubble !== null, '找到用户气泡', light.bubbleText);
ok(light.errors.length === 0, '控制台无错误', light.errors.slice(0, 2).join(' | '));

if (light.para && light.bubble) {
  const tokenPx = parseFloat(light.token);
  ok(Number.isFinite(tokenPx) && tokenPx > 0, '--text-body-lg 能解析成 px', light.token);

  ok(
    light.bubble.fontSize === light.para.fontSize,
    '★ 用户气泡字号 === 助手正文字号（问题不该比答案大）',
    `气泡 ${light.bubble.fontSize}px / 正文 ${light.para.fontSize}px`
  );
  ok(
    light.para.fontSize === tokenPx,
    '助手正文 = --text-body-lg（不写死 px，改档位闸门跟着走）',
    `正文 ${light.para.fontSize}px / 令牌 ${tokenPx}px`
  );
  ok(
    light.bubble.fontSize === tokenPx,
    '用户气泡 = --text-body-lg',
    `气泡 ${light.bubble.fontSize}px / 令牌 ${tokenPx}px`
  );

  // 行高一致：字号一样但行高不同，读起来仍是两种节奏
  const paraRatio = light.para.lineHeight / light.para.fontSize;
  const bubbleRatio = light.bubble.lineHeight / light.bubble.fontSize;
  ok(
    Math.abs(paraRatio - bubbleRatio) < 0.02,
    '行高比一致（不会一边松一边紧）',
    `正文 ${paraRatio.toFixed(2)} / 气泡 ${bubbleRatio.toFixed(2)}`
  );

  // 每行字数：1080 宽窗口下段落 560–760px，14px 中文约 40–54 字/行
  ok(
    light.para.width >= 560 && light.para.width <= 780,
    '正文栏宽落在可读区间（不是被挤成一条窄缝）',
    `${light.para.width}px`
  );
}

console.log('\n[2] 深色：同一套字号');
const dark = await measure(true);
ok(dark.dark === true, '深色主题真的生效（不是断言跑在浅色上）');
if (light.para && dark.para && light.bubble && dark.bubble) {
  ok(dark.para.fontSize === light.para.fontSize, '深色正文与浅色同号', `${dark.para.fontSize}px`);
  ok(dark.bubble.fontSize === light.bubble.fontSize, '深色气泡与浅色同号', `${dark.bubble.fontSize}px`);
  ok(dark.bubble.fontSize === dark.para.fontSize, '★ 深色下两者仍同档');
}

console.log('\n[3] 源码契约：别把 16px 又从别处引回来');
{
  const raw = await readFile(join(process.cwd(), 'src/index.css'), 'utf-8');
  // ⚠️ 必须先剥注释再匹配。第一版没剥，`/::part(md_p)[\s\S]{0,240}line-height:var(...)/`
  // 命中的是 `.tc-bubble-assistant` 上方**注释里**那句「`::part(md_p)` 自己写了
  // 14px / var(--leading-loose)」—— 把真规则改回手写值，闸门照样 18/18 全绿。
  // 这是本项目第二次踩同一个坑（A134 那次是 `-webkit-mask-image` 的子串）。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const tsx = await readFile(join(process.cwd(), 'src/components/ChatMessages.tsx'), 'utf-8');

  // `^` 锚行首：玻璃态覆盖规则写作 `html[data-opc-glass='1'] .tc-bubble-user { }`，
  // 不带锚点会先命中它，于是「基础规则里有没有 font-size」永远测的是另一条。
  const bubbleRule = (css.match(/^\.tc-bubble-user\s*\{[^}]*\}/m) || [''])[0];
  const assistantRule = (css.match(/^\.tc-bubble-assistant\s*\{[^}]*\}/m) || [''])[0];
  // 正文那条是**多选择器块**（md_p, md_span, md_li, md_ul, md_ol 共用），
  // 所以按「md_p 后面紧跟逗号」定位，避免命中只写 margin 的那条
  const mdPBlock = (css.match(/^\.chat-markdown t-chat-md-content::part\(md_p\),[^}]*\}/m) || [''])[0];

  ok(/font-size:\s*var\(--text-body-lg\)/.test(bubbleRule), '.tc-bubble-user 字号走令牌');
  ok(
    /line-height:\s*var\(--leading-loose\)/.test(bubbleRule),
    '.tc-bubble-user 行高走 --leading-loose（与正文同源）'
  );
  ok(
    /font-size:\s*14px/.test(mdPBlock) && /line-height:\s*var\(--leading-loose\)/.test(mdPBlock),
    '★ 助手正文那块真的引用了 --leading-loose（不是注释里的字）',
    mdPBlock ? mdPBlock.replace(/\s+/g, ' ').slice(0, 90) : '没找到规则块'
  );
  ok(/--leading-loose:\s*1\.75/.test(css), '令牌 --leading-loose = 1.75（描述现实，不是 1.7）');
  // `leading-relaxed` 是 1.625，留着会和 CSS 规则抢同一个属性，谁赢看打包顺序
  ok(
    !/tc-bubble-user[^"']*leading-relaxed/.test(tsx),
    '气泡的 JSX 里没有 leading-relaxed（不两处写行高）'
  );
  ok(
    /font-size:\s*var\(--text-body-lg\)/.test(assistantRule),
    '.tc-bubble-assistant 也钉了字号（纯文本回答那一帧）'
  );
}

await browser.close();
server.close();

console.log(`\n${fail ? '✗' : '✓'} A136 对话正文排版：${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
