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
  ok(/looksBinary|\\0/.test(fsSrc), '契约：二进制按 NUL 粗判');
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
    await runUiChecks(base, sid);
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
async function runUiChecks(base: string, sid: string) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    ok(false, 'UI：dist 未构建（先 npm run build）');
    return;
  }
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
