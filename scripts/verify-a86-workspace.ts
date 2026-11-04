/**
 * A86 验证：工作区面板的「看起来是假的」那一组修复。
 *
 * 覆盖四件事，每件都对应一条用户原话：
 *
 *   1. **输入网址打不开** —— 浮层哨兵把预览视图永久判成「被盖住」。
 *      行为断言在 `verify:a78-browser` 的 [A2] 组（纯函数 + 假元素），
 *      这里只守「判定不再依赖 getClientRects 一条」的源码契约。
 *   2. **md 只能用外部程序看** —— 新增 `/api/fs/read` 与 `/api/fs/raw`。
 *      这一半必须真起服务、真读文件：containment、1 MB 上限、二进制识别、
 *      图片直出，四条都是运行时行为，源码断言证明不了。
 *   3. **选错目录无法剔除** —— `PATCH cwd:""` → `null`，之后 `/api/fs/list`
 *      必须回 409 `no-cwd`（而不是退回进程目录）。
 *   4. **没有新建工作区** —— 建目录在主进程（`opc:create-workspace`），
 *      这里守契约：不许给 `server/fs.ts` 开写接口。
 *   5. **UTF-16 / BOM 误判 binary** —— PowerShell `>` 重导出（默认 UTF-16LE
 *      带 BOM）的 txt/md 前 8 KB 全是 0x00，旧 NUL 粗判把它们挡在预览外。
 *      现在按 BOM + NUL 奇偶分布先认编码再解码。
 *   6. **md 超 256 KB 静默降级** —— 退回纯文本必须有显式说明
 *      （`data-markdown-plain-fallback`），不是悄无声息换成等宽字体。
 *   7. **html 没有安全预览**（A172）—— 用 `sandbox=""` 的 iframe + srcDoc，
 *      srcDoc 注入 `default-src 'none'` 的 CSP、剥掉 meta refresh、加
 *      `<base target="_blank">`。断言要证明：不执行脚本、不联网、不跳转，
 *      且「预览 / 源码」切换偏好会被记住。
 *
 * 运行：npx tsx scripts/verify-a86-workspace.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail && !cond ? `  [${detail}]` : ''}`);
}

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ── [A] 源码契约 ─────────────────────────────────────────────────────── */

function checkContracts() {
  const fsSrc = read('server/fs.ts');
  ok(fsSrc.includes('export function readFileInside'), '契约：fs.ts 导出 readFileInside');
  ok(fsSrc.includes('MAX_TEXT_BYTES'), '契约：文本预览有大小上限');
  ok(/export const MAX_TEXT_BYTES/.test(fsSrc) && /export const MAX_IMAGE_BYTES/.test(fsSrc), '契约：文本/图片阈值是导出常量（集中、可引）');
  ok(/looksBinary|\\0/.test(fsSrc), '契约：二进制按 NUL 粗判');
  // UTF-16 修正：先认编码再判二进制，NUL 粗判只管 UTF-8 路径
  ok(fsSrc.includes('function detectEncoding'), '契约：fs.ts 有编码判定（UTF-16 不被 NUL 粗判误杀）');
  ok(fsSrc.includes("'utf16le'") && fsSrc.includes("'utf16be'"), '契约：UTF-16 LE/BE 都在判定结果里');
  ok(fsSrc.includes('0xFEFF'), '契约：UTF-8 BOM（\\uFEFF）会被剥掉');
  ok(fsSrc.includes('function decodeText'), '契约：按判定出的编码解码');
  // 只读定位不能破：这条是整个面板的安全边界
  ok(!/export function (write|remove|mkdir)/.test(fsSrc), '契约：fs.ts 仍然没有写/删/建目录');

  const idx = read('server/index.ts');
  ok(idx.includes('"/api/fs/read"'), '契约：注册 GET /api/fs/read');
  ok(idx.includes('"/api/fs/raw"'), '契约：注册 GET /api/fs/raw');
  ok(/kind !== "image"[\s\S]{0,80}415/.test(idx), '契约：/api/fs/raw 只放行图片（其余 415）');

  const panel = read('src/components/WorkspacePanel.tsx');
  ok(panel.includes('data-file-preview'), '契约：面板内有预览层');
  ok(panel.includes('/api/fs/read'), '契约：预览走 /api/fs/read');
  ok(/onClick=\{\(\) => \(isDir \? setRel\(entry\.path\) : void openPreview\(entry\)\)\}/.test(panel), '契约：单击 = 预览');
  ok(/onDoubleClick=\{/.test(panel), '契约：双击 = 用系统程序打开');
  ok(panel.includes('只渲染前'), '契约：超长文件如实说明只渲染前 N 行');
  ok(!panel.includes('<textarea'), '契约：预览层不是编辑器（没有 textarea）');
  // A87：md 复用聊天那套渲染器，不另引一套；且必须**动态** import ——
  // 静态引入会把 cherry-markdown 拖进入口 chunk（实测 892 KB → 4.15 MB）。
  ok(panel.includes("import('@tdesign-react/chat')"), '契约：md 复用 TDesign ChatMarkdown（动态 import）');
  ok(panel.includes('lazy('), '契约：ChatMarkdown 走 lazy（不拖首屏）');
  ok(panel.includes('<ChatMarkdown content='), '契约：预览层真的用 ChatMarkdown 渲染');
  ok(panel.includes('data-markdown-preview'), '契约：富文本预览有标记（便于验证与排查）');
  ok(panel.includes('MAX_MARKDOWN_BYTES'), '契约：超大 md 退回纯文本（有阈值）');
  ok(/export const MAX_PREVIEW_LINES/.test(panel) && /export const MAX_MARKDOWN_BYTES/.test(panel), '契约：面板两个渲染阈值是导出常量（集中、可引）');
  // md 超限退回纯文本时必须有一句显式说明，不是静默换成等宽字体
  ok(panel.includes('data-markdown-plain-fallback'), '契约：md 超限退回纯文本有显式说明标记');
  // A172：html 沙箱预览的三条硬边界（沙箱、CSP、剥 meta refresh）
  ok(panel.includes('buildSafeHtmlDocument'), '契约：html 预览走 buildSafeHtmlDocument（统一注入点）');
  ok(panel.includes("default-src 'none'"), '契约：srcDoc 注入 default-src none 的 CSP');
  ok(panel.includes("style-src 'unsafe-inline'"), '契约：CSP 只放行内联样式');
  ok(panel.includes('sandbox=""'), '契约：iframe sandbox 为空（不给任何能力）');
  ok(!/sandbox=\{[^}]*'allow-/.test(panel), '契约：sandbox 没有 allow-* 令牌');
  ok(panel.includes('http-equiv') && /refresh/i.test(panel), '契约：源文件里的 meta refresh 会被剥掉');
  ok(panel.includes('<base target="_blank">'), '契约：注入 base target=_blank 防接管');
  ok(panel.includes('referrerPolicy="no-referrer"'), '契约：iframe 不带 Referer');
  ok(/export const MAX_HTML_PREVIEW_BYTES = 1024 \* 1024/.test(panel), '契约：html 预览上限与文本阈值同口径（1 MB）');
  ok(panel.includes('data-html-view-toggle'), '契约：html 有预览/源码切换控件');
  ok(panel.includes('opc.workspace-html-view'), '契约：切换偏好落到 localStorage（同一套 key）');
  ok(panel.includes('data-html-preview-iframe'), '契约：沙箱 iframe 有标记（便于验证与排查）');
  ok(panel.includes('data-html-oversize-fallback'), '契约：html 超限退回源码时有显式说明');
  ok(/'\.\(md\|markdown\)\$/.test(panel) || panel.includes('\\.(md|markdown)$'), '契约：只对 md/markdown 走富文本（mdx 不认）');

  const badge = read('src/components/WorkspaceBadge.tsx');
  ok(badge.includes('data-workspace-clear'), '契约：徽标面板有「移除工作目录」');
  ok(badge.includes('data-workspace-create'), '契约：徽标面板有「新建工作区」');
  ok(/onChange\(''\)/.test(badge), '契约：移除走既有链路（onChange 空串）');
  ok(badge.includes('createWorkspace'), '契约：新建走 createWorkspace');

  const preload = read('electron/preload.cjs');
  ok(preload.includes("ipcRenderer.invoke('opc:create-workspace')"), '契约：preload 暴露 createWorkspace');

  const main = read('electron/main.ts');
  ok(main.includes("ipcMain.handle('opc:create-workspace'"), '契约：main 注册 opc:create-workspace');
  ok(/properties: \['openDirectory', 'createDirectory'\]/.test(main), '契约：借系统对话框的 createDirectory（不自己造 UI）');
  ok(main.includes('mkdirSync(target)'), '契约：建目录在主进程');

  const cdp = read('electron/cdp.ts');
  ok(cdp.includes('function isAppTarget'), '契约：CDP 排除逻辑抽成 isAppTarget（A86）');
  // 只认代码里的过滤写法：注释里引用旧写法（解释为什么改）是允许的 ——
  // 拿 `t.url === u` 做否定断言会被那段注释判成永假（A78 也踩过一次）。
  ok(cdp.includes('pages.filter(t => !isAppTarget(t.url))'), '契约：target 过滤改走 isAppTarget（不再精确相等）');

  const term = read('electron/terminal.ts');
  ok(term.includes('private generation = 0'), '契约：终端有代次计数');
  ok(/gen !== this\.generation/.test(term), '契约：旧进程回调按代次丢弃');
}

/* ── [B] 真服务行为 ───────────────────────────────────────────────────── */

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base: string, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await SLEEP(300);
  }
  return false;
}

/** 1×1 的 PNG（最小合法图），用来验图片直出 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Node 没有 utf16be 编码器：先按 LE 编码再两两交换字节（与 fs.ts 解码互逆）。 */
function toUtf16be(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.allocUnsafe(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

async function runServerChecks() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a86-data-'));
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a86-proj-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-a86-out-'));
  const MARK = `opc-a86-marker-${Date.now()}`;

  fs.writeFileSync(
    path.join(projDir, 'README.md'),
    `# 标题\n\n${MARK}\n\n## 小节\n\n- 第一项\n- 第二项\n\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`,
    'utf8'
  );
  fs.mkdirSync(path.join(projDir, 'src'));
  fs.writeFileSync(path.join(projDir, 'src', 'app.ts'), 'export const answer = 42;\n', 'utf8');
  fs.writeFileSync(path.join(projDir, 'img.png'), PNG_1X1);
  fs.writeFileSync(path.join(projDir, 'bin.dat'), Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(projDir, 'big.txt'), 'a'.repeat(1024 * 1024 + 10), 'utf8');
  // UTF-16 / BOM 系列：模拟 PowerShell `>` 重导出与各编辑器产物
  fs.writeFileSync(
    path.join(projDir, 'u16le.txt'),
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`u16le ${MARK} 中文\n`, 'utf16le')])
  );
  fs.writeFileSync(
    path.join(projDir, 'u16be.txt'),
    Buffer.concat([Buffer.from([0xFE, 0xFF]), toUtf16be(`u16be ${MARK} 中文\n`)])
  );
  // 无 BOM 的 UTF-16LE：靠 NUL 奇偶分布认（ASCII 占多数才有分布可言）
  fs.writeFileSync(path.join(projDir, 'u16nobom.txt'), Buffer.from(`u16 no bom ${MARK} `.repeat(8) + '\n', 'utf16le'));
  fs.writeFileSync(
    path.join(projDir, 'u8bom.md'),
    Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(`# 标题\n\n${MARK}\n`, 'utf8')])
  );
  // 超过 md 富渲染阈值（256 KB）但不到文本上限（1 MB）的大 md
  fs.writeFileSync(path.join(projDir, 'big-md.md'), `# 大文件\n\n${'x'.repeat(300 * 1024)}\n`, 'utf8');
  // A172：html 沙箱预览夹具 —— 同时带脚本、meta refresh、外链图片与外链锚点，
  // 用来证明「不执行脚本 / 不联网 / 不跳转」三条边界真的生效。
  fs.writeFileSync(
    path.join(projDir, 'preview.html'),
    `<!doctype html>
<html>
<head><title>preview</title><style>.title{color:#c00}</style></head>
<body>
<h1 class="title">HTML 沙箱 ${MARK}</h1>
<p>正文可见</p>
<a href="https://example.com/never">外链</a>
<img src="https://example.com/never.png" alt="never" />
<meta http-equiv="refresh" content="0;url=https://example.com/never" />
<script>
  window.__opcScriptRan = true;
  document.body.setAttribute('data-script-ran', '1');
</script>
</body>
</html>
`,
    'utf8'
  );
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside', 'utf8');

  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPC_DATA_DIR: dataDir,
    PORT: String(port),
  };
  // 这些会让子进程跑成别的东西 / 走代理，和服务无关
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    delete env[key];
  }

  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'server/index.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += String(d)));
  child.stderr.on('data', d => (log += String(d)));

  const base = `http://127.0.0.1:${port}`;
  try {
    const up = await waitForServer(base);
    ok(up, '服务：临时库 + 临时端口起来了', up ? '' : log.slice(-600));
    if (!up) return;

    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'A86 验证', agentId: null, cwd: projDir }),
      })
    ).json();
    const sid = created?.session?.id ?? created?.id;
    ok(typeof sid === 'string' && !!sid, '服务：建会话并绑定临时项目目录', JSON.stringify(created).slice(0, 200));
    if (!sid) return;

    const qs = (p: string) => `sessionId=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`;

    // ① 文本
    const md = await (await fetch(`${base}/api/fs/read?${qs('README.md')}`)).json();
    ok(md?.kind === 'text', '预览：md 被识别为文本', JSON.stringify(md).slice(0, 160));
    ok(String(md?.content ?? '').includes(MARK), '预览：内容真的是那个文件');
    ok(Number(md?.lines) >= 3, '预览：行数已给出', String(md?.lines));

    // ② 图片：JSON 只给 URL，字节走 raw
    const img = await (await fetch(`${base}/api/fs/read?${qs('img.png')}`)).json();
    ok(img?.kind === 'image' && String(img?.url ?? '').includes('/api/fs/raw'), '预览：图片给的是 raw URL', JSON.stringify(img).slice(0, 160));
    const raw = await fetch(`${base}${img?.url ?? ''}`);
    ok(raw.status === 200, '预览：/api/fs/raw 返回 200', String(raw.status));
    ok((raw.headers.get('content-type') ?? '').includes('image/png'), '预览：图片 Content-Type 正确', raw.headers.get('content-type') ?? '');

    // ③ 二进制
    const bin = await (await fetch(`${base}/api/fs/read?${qs('bin.dat')}`)).json();
    ok(bin?.kind === 'binary', '预览：二进制不被当文本渲染', JSON.stringify(bin).slice(0, 160));

    // ④ 超大文件：明确 too-large，不截一半
    const big = await (await fetch(`${base}/api/fs/read?${qs('big.txt')}`)).json();
    ok(big?.kind === 'too-large', '预览：超大文件报 too-large（不截断）', JSON.stringify(big).slice(0, 160));

    // ④.5 UTF-16 / BOM：不再被 NUL 粗判误杀，且按对应端序解码
    const u16le = await (await fetch(`${base}/api/fs/read?${qs('u16le.txt')}`)).json();
    ok(u16le?.kind === 'text', '预览：UTF-16LE（BOM）判为文本', JSON.stringify(u16le).slice(0, 160));
    ok(String(u16le?.content ?? '').includes(`u16le ${MARK} 中文`), '预览：UTF-16LE 解码后内容可读（含中文）', String(u16le?.content ?? '').slice(0, 60));
    const u16be = await (await fetch(`${base}/api/fs/read?${qs('u16be.txt')}`)).json();
    ok(u16be?.kind === 'text' && String(u16be?.content ?? '').includes(`u16be ${MARK} 中文`), '预览：UTF-16BE（BOM）判为文本且解码正确', JSON.stringify(u16be).slice(0, 160));
    const u16nobom = await (await fetch(`${base}/api/fs/read?${qs('u16nobom.txt')}`)).json();
    ok(u16nobom?.kind === 'text' && String(u16nobom?.content ?? '').includes(MARK), '预览：无 BOM 的 UTF-16（NUL 奇偶分布）判为文本', JSON.stringify(u16nobom).slice(0, 160));
    const u8bom = await (await fetch(`${base}/api/fs/read?${qs('u8bom.md')}`)).json();
    ok(u8bom?.kind === 'text', '预览：UTF-8 BOM 文件判为文本', JSON.stringify(u8bom).slice(0, 160));
    ok(!String(u8bom?.content ?? '').startsWith(String.fromCharCode(0xFEFF)), '预览：UTF-8 BOM 被剥掉（首字符不是 U+FEFF）', String(u8bom?.content ?? '').slice(0, 20));
    // ④.6 大 md（256 KB < size < 1 MB）：kind 仍是 text —— 富渲染降级在前端判断
    const bigMd = await (await fetch(`${base}/api/fs/read?${qs('big-md.md')}`)).json();
    ok(bigMd?.kind === 'text' && Number(bigMd?.size) > 256 * 1024, '预览：>256KB 的 md 仍返回 text（富渲染降级由前端提示）', JSON.stringify(bigMd).slice(0, 160));

    // ④.7 A172：html 也走 text 通道（沙箱渲染完全在前端，服务端不用改）
    const html = await (await fetch(`${base}/api/fs/read?${qs('preview.html')}`)).json();
    ok(html?.kind === 'text' && String(html?.content ?? '').includes(MARK), '预览：html 返回 text 且内容完整（供沙箱渲染）', JSON.stringify(html).slice(0, 160));

    // ⑤ containment：跳出去必须被拒
    const esc = await fetch(`${base}/api/fs/read?${qs('../secret.txt')}`);
    ok(esc.status === 400 || esc.status === 403, '预览：../ 逃逸被拒', String(esc.status));

    // ⑥ 移除工作目录 → 面板必须明确说「没绑定」，而不是退回进程目录
    const patched = await fetch(`${base}/api/sessions/${sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '' }),
    });
    ok(patched.ok, '工作区：移除绑定（cwd:""）成功', String(patched.status));
    const listAfter = await fetch(`${base}/api/fs/list?sessionId=${encodeURIComponent(sid)}&path=`);
    const bodyAfter = await listAfter.json().catch(() => ({}));
    ok(listAfter.status === 409 && bodyAfter?.code === 'no-cwd', '工作区：移除后列表返回 409 no-cwd', `${listAfter.status} ${JSON.stringify(bodyAfter).slice(0, 120)}`);

    // ⑦ 不存在的目录不许落库
    const bad = await fetch(`${base}/api/sessions/${sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: path.join(projDir, 'nope-xyz') }),
    });
    ok(bad.status === 400, '工作区：绑定不存在的目录被拒（400）', String(bad.status));

    // ⑧ 真 Chrome UI（服务还在，直接打它托管的前端产物）
    //    先重新绑回项目目录 —— ⑥ 刚把绑定清掉了
    await fetch(`${base}/api/sessions/${sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: projDir }),
    });
    console.log('[C] 真 Chrome UI 行为');
    await runUiChecks(base, sid, MARK);
  } catch (e) {
    ok(false, '服务：验证过程抛错', e instanceof Error ? e.message : String(e));
  } finally {
    try {
      child.kill();
    } catch {
      /* 已退 */
    }
    for (const dir of [dataDir, projDir, outsideDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上可能还被持着，交给系统回收 */
      }
    }
  }
}

/**
 * [C] 真 Chrome 里的 UI 行为（A87）。
 *
 * 这一组防的是「接口通了但界面没接上」—— `[A]` 只证明源码里有这个字符串，
 * `[B]` 只证明 HTTP 能返回内容。真正要证明的是：点一个 md，**面板里出现的是
 * 富文本（h1 / 表格），而不是一坨等宽文本**；点一个 .ts，走的仍是带行号的
 * 纯文本（别把源码也丢进 markdown 解析器）。
 *
 * 富文本渲染在 Shadow DOM 里，所以断言要读 `shadowRoot.innerHTML` ——
 * 外层 `document.querySelector('h1')` 永远是 0（A27 的教训）。
 */
async function runUiChecks(base: string, sid: string, mark: string) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    ok(false, 'UI：dist 未构建（先 npm run build）');
    return;
  }
  fs.mkdirSync(path.join(root, '.render-check'), { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  try {
    await page.goto(`${base}/chat/${sid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('nav') !== null, { timeout: 40_000 });
    await SLEEP(1200);

    const expand = page.locator('[data-workspace-toggle="expand"]');
    if (await expand.count()) await expand.first().click();
    await page.waitForSelector('[role="tablist"]', { timeout: 15_000 });
    await page.getByRole('tab', { name: '文件' }).click();
    await SLEEP(600);

    // ① md → 富文本
    await page.getByRole('button', { name: /README\.md/ }).first().click();
    await page.waitForSelector('[data-markdown-preview]', { timeout: 10_000 });
    // A87：ChatMarkdown 是动态 chunk，首次渲染要等它下载完 ——
    // 等 shadow 里真的出现内容，不用固定 sleep 猜。
    await page.waitForFunction(
      () => {
        const host = document.querySelector('[data-markdown-preview] t-chat-md-content');
        return !!host?.shadowRoot?.innerHTML;
      },
      { timeout: 20_000 }
    );
    await SLEEP(300);
    const shadow = await page.evaluate(() => {
      const host = document.querySelector('[data-markdown-preview] t-chat-md-content');
      return host?.shadowRoot?.innerHTML ?? '';
    });
    ok(shadow.length > 0, 'UI：md 预览渲染进了 ChatMarkdown 的 shadow DOM', `${shadow.length} 字符`);
    ok(/<h1[\s>]/i.test(shadow), 'UI：标题被渲染成 <h1>（不是字面量 "# 标题"）');
    ok(/<table[\s>]/i.test(shadow), 'UI：GFM 表格被渲染（remark-gfm 等价能力）');
    ok(/<ul[\s>]/i.test(shadow) || /<li[\s>]/i.test(shadow), 'UI：列表被渲染');
    await page.screenshot({ path: '.render-check/a87-preview-markdown.png' });

    // ② .ts → 带行号的纯文本，不能进 markdown 解析
    await page.locator('[data-file-preview-close]').click();
    await SLEEP(300);
    await page.getByRole('button', { name: 'src' }).first().click();
    await SLEEP(500);
    await page.getByRole('button', { name: /app\.ts/ }).first().click();
    await page.waitForSelector('[data-file-preview]', { timeout: 10_000 });
    await SLEEP(400);
    const isMd = await page.locator('[data-markdown-preview]').count();
    ok(isMd === 0, 'UI：源码文件不走 markdown 渲染（仍是纯文本）');
    const pre = await page.locator('[data-file-preview] pre').count();
    ok(pre >= 2, 'UI：纯文本预览有两列 <pre>（行号 + 正文）', String(pre));
    await page.screenshot({ path: '.render-check/a87-preview-source.png' });

    // ③ 大 md（>256 KB）→ 纯文本 + 顶部显式降级说明，不走富渲染。
    //    ② 刚进了 src/ 子目录，先点面包屑根按钮回到项目根（临时目录名带
    //    opc-a86-proj- 前缀，正好能当定位串）。
    await page.locator('[data-file-preview-close]').click();
    await SLEEP(300);
    await page.getByRole('button', { name: /opc-a86-proj-/ }).first().click();
    await SLEEP(500);
    await page.getByRole('button', { name: /big-md\.md/ }).first().click();
    await page.waitForSelector('[data-markdown-plain-fallback]', { timeout: 10_000 });
    const bigMdRich = await page.locator('[data-markdown-preview]').count();
    ok(bigMdRich === 0, 'UI：>256KB 的 md 不走富渲染（无 data-markdown-preview）');
    const fallbackText = await page.locator('[data-markdown-plain-fallback]').innerText();
    ok(/纯文本/.test(fallbackText), 'UI：降级说明可见（按纯文本显示）', fallbackText.slice(0, 60));
    await page.screenshot({ path: '.render-check/a87-preview-bigmd-fallback.png' });

    // ④ UTF-16LE（PowerShell 重导出形态）→ 面板里真的显示出文字
    await page.locator('[data-file-preview-close]').click();
    await SLEEP(300);
    await page.getByRole('button', { name: /u16le\.txt/ }).first().click();
    await page.waitForSelector('[data-file-preview] pre', { timeout: 10_000 });
    await SLEEP(300);
    const u16Text = await page.locator('[data-file-preview] pre').last().innerText();
    ok(u16Text.includes(mark), 'UI：UTF-16LE 文件内容真的显示在预览里', u16Text.slice(0, 60));

    // ⑤ A172 html 沙箱预览 —— 默认预览、可切源码、偏好会记住
    await page.locator('[data-file-preview-close]').click();
    await SLEEP(300);
    await page.getByRole('button', { name: /preview\.html/ }).first().click();
    await page.waitForSelector('[data-html-view-toggle]', { timeout: 10_000 });
    await page.waitForSelector('[data-html-preview-iframe]', { timeout: 10_000 });
    ok(true, 'UI：html 有「预览 / 源码」切换控件');
    const toggle = page.locator('[data-html-view-toggle]');
    const previewPressed = await toggle.getByRole('button', { name: '预览' }).getAttribute('aria-pressed');
    ok(previewPressed === 'true', 'UI：html 默认走预览（预览按钮 aria-pressed=true）', String(previewPressed));
    const sandbox = await page.locator('[data-html-preview-iframe]').getAttribute('sandbox');
    ok(sandbox !== null && !/allow-scripts|allow-same-origin|allow-/.test(sandbox), 'UI：iframe sandbox 未给 allow-*（尤其 allow-scripts / allow-same-origin）', String(sandbox));
    const srcDoc = (await page.locator('[data-html-preview-iframe]').getAttribute('srcdoc')) ?? '';
    ok(srcDoc.includes("default-src 'none'"), 'UI：srcDoc 含 default-src none 的 CSP');
    ok(srcDoc.includes("style-src 'unsafe-inline'"), 'UI：srcDoc 的 CSP 只放行内联样式');
    ok(srcDoc.includes('<base target="_blank">'), 'UI：srcDoc 注入 base target=_blank');
    ok(!/http-equiv\s*=\s*"?refresh/i.test(srcDoc), 'UI：源文件的 meta refresh 已被剥掉');
    await page.screenshot({ path: '.render-check/a172-html-preview.png' });

    // 沙箱内：文字能看到（srcDoc 真的渲染），但脚本没执行、外链没加载
    // srcdoc 文档由浏览器异步建立，给它一个短暂的落定窗口，避免读在 frame 创建前
    let frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith('about:srcdoc'));
    for (let i = 0; !frame && i < 20; i += 1) {
      await page.waitForTimeout(200);
      frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith('about:srcdoc'));
    }
    ok(!!frame, 'UI：srcdoc iframe 真的建了独立文档');
    if (frame) {
      const ran = await frame.evaluate(() => (window as unknown as { __opcScriptRan?: boolean }).__opcScriptRan === true);
      ok(ran === false, 'UI：沙箱内脚本没有执行（window.__opcScriptRan 未置位）');
      const bodyText = await frame.locator('body').innerText();
      ok(bodyText.includes(mark), 'UI：沙箱内正文真的渲染出来（不执行脚本也能看）', bodyText.slice(0, 60));
    }

    // 切到源码 → 带行号纯文本、不再有 iframe；偏好写进 localStorage
    await toggle.getByRole('button', { name: '源码' }).click();
    await page.waitForSelector('[data-html-source-pane]', { timeout: 10_000 });
    const iframeAfter = await page.locator('[data-html-preview-iframe]').count();
    ok(iframeAfter === 0, 'UI：切到源码后 iframe 消失（不再沙箱渲染）', String(iframeAfter));
    const preAfter = await page.locator('[data-file-preview] pre').count();
    ok(preAfter >= 2, 'UI：切到源码后是带行号的纯文本（两列 pre）', String(preAfter));
    const storedView = await page.evaluate(() => localStorage.getItem('opc.workspace-html-view'));
    ok(storedView === 'source', 'UI：切换偏好落到 localStorage（opc.workspace-html-view=source）', String(storedView));
    await page.screenshot({ path: '.render-check/a172-html-source.png' });

    // 关掉再打开同一文件：仍停在源码（记住切换态）
    await page.locator('[data-file-preview-close]').click();
    await SLEEP(300);
    await page.getByRole('button', { name: /preview\.html/ }).first().click();
    await page.waitForSelector('[data-html-source-pane]', { timeout: 10_000 });
    const rememberedIframe = await page.locator('[data-html-preview-iframe]').count();
    ok(rememberedIframe === 0, 'UI：二次打开同一 html 仍记住源码视图', String(rememberedIframe));

    ok(pageErrors.length === 0, 'UI：页面零错误', pageErrors.slice(0, 2).join(' | '));
  } catch (e) {
    ok(false, 'UI：验证过程抛错', e instanceof Error ? e.message : String(e));
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('[A] 源码契约');
  checkContracts();

  console.log('[B] 真服务行为（临时库 + 临时目录）');
  await runServerChecks();

  const passed = checks.total - failures.length;
  console.log(`\n工作区修复（A86）断言：${passed}/${checks.total} 通过`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ 预览 / 解绑 / 新建工作区 / CDP 排除 均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
