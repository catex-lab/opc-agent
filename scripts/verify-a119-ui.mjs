/**
 * A119 验证：项目深链 + 项目任务面板 + 空会话换 Agent。
 *
 * ## 为什么真起服务端
 *
 * 这一版的三件事全都**跨了前后端**：
 *   - 深链要后端 SPA 兜底（`/projects/:id` 直接刷新得能回 index.html）
 *   - 任务面板的每一次点击都要真的落库（project_tasks 表 + 四个路由）
 *   - 换 Agent 要真的改到 `sessions.agent_id`
 *
 * 用 `ctx.route` 把 /api 全拦成夹具的话，这三处全变成我写的假数据，
 * 测的只是「我以为它长这样」。所以这里真起 `tsx server/index.ts`，
 * 用独立的 `OPC_DATA_DIR` 临时目录，绝不碰真实 data/chat.db。
 *
 * ## 覆盖范围
 *
 *   [1] 纯函数层   —— 先跑 verify-a119-probe.ts（IDE 启动器守卫正反例）
 *   [2] Trae 定义  —— 名册里 Trae 必须是「未安装」而不是「就绪」
 *                     （改了 bin 只留 traecli 的直接后果）
 *   [3] 深链直达   —— goto /projects/:id 直接落在详情，nav 也是项目态
 *   [4] 深链刷新   —— reload 后仍停在同一个项目（这条是本轮的主要诉求）
 *   [5] 深链无项目 —— /projects 只开列表，右侧是「选一个项目」
 *   [6] 任务增删改 —— 回车新增 → 点状态循环 todo→doing→done → 删除
 *   [7] 任务落库   —— 直接查 API 对账，不信界面
 *   [8] 非法状态   —— PATCH 一个不存在的 status 必须 400（不许静默纠正）
 *   [9] 空会话回填 —— 打开一条空会话，新建页高亮的必须是会话自己的 Agent
 *  [10] 换 Agent   —— 点另一张卡片，会话的 agent_id 真的变了（不是假控件）
 *
 * 运行：node scripts/verify-a119-ui.mjs（需先 npm run build）
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
/**
 * 每次跑用**独立**的临时目录。
 *
 * 原先固定 `.tmp/a119-e2e` 并在开头 rmSync 清一遍，本机踩到了：这台机器的
 * 删除被内核过滤驱动转成「进回收站」，而 `NODE_OPTIONS` 里的 safe-delete
 * 垫片会先拦一道，目录被上一个进程占着时直接抛错，脚本还没开始跑就崩了。
 * 换目录名之后既不需要删除，也不会撞上残留的锁。
 */
const TMP = path.join(ROOT, '.tmp', `a119-e2e-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const WS = path.join(TMP, 'ws');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitReady(base, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let log = '';
  child.stdout?.on('data', d => (log += String(d)));
  child.stderr?.on('data', d => (log += String(d)));
  while (Date.now() < deadline) {
    if (child.exitCode != null) return { ready: false, log };
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) return { ready: true, log };
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ready: false, log };
}

async function startServer(port) {
  const child = spawn('npx tsx server/index.ts', {
    cwd: ROOT,
    shell: true,
    windowsHide: true,
    // NODE_OPTIONS 必须清空：本机有 safe-delete 垫片，会把子进程的 fs 调用
    // 重定向去回收站二进制（见项目记忆里的打包坑）。
    env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { ready, log } = await waitReady(`http://127.0.0.1:${port}`, child);
  return { child, ready, log };
}

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

/**
 * 只探一个 Agent。
 *
 * 两个「看起来能用、其实不能用」的写法都试过了，记在这里免得下次再踩：
 *
 *   ✗ `GET /api/agents?refresh=1` —— 全量重探，14 个 Agent 挨个真跑一遍
 *     （每个最多 8 秒版本超时 + 后端可达性检查），实测几分钟都回不来，
 *     脚本看起来像卡死。
 *   ✗ `GET /api/agents` 轮询到状态不再是 unknown —— 服务端的后台探测是
 *     限并发的队列，Trae 排在最后，前面那些慢的一跑就是几十秒起步。
 *
 * 正解是 `GET /api/agents/:id?probe=1`：只探这一个。Trae 现在 bin 里只剩
 * `traecli`，PATH 里没有 → 走「找不到命令」分支，不 spawn 任何子进程，
 * 几十毫秒就出结论。
 */
async function probeOne(base, id) {
  const j = await json(await fetch(`${base}/api/agents/${id}?probe=1`));
  return j.agent ?? null;
}

async function main() {
  // 目录名带时间戳，正常不存在；建出来即可（不删旧的，理由见 TMP 的注释）
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });

  console.log('\nA119 项目深链 / 任务面板 / 空会话换 Agent');

  // ── [1] 纯函数层 ────────────────────────────────────────────────
  {
    const r = spawnSync('npx', ['tsx', 'scripts/verify-a119-probe.ts'], {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    ok(r.status === 0, '[1] 纯函数层：IDE 启动器守卫正反例全绿', out.trim().split('\n').pop());
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startServer(port);
  if (!server.ready) {
    ok(false, '服务端启动并就绪', server.log.slice(-600));
    killTree(server.child);
    return;
  }
  ok(true, '服务端启动并就绪', `:${port}`);

  const cleanup = () => {
    killTree(server?.child);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  let browser;
  try {
    // ── [2] Trae 必须是「未安装」─────────────────────────────────
    {
      const trae = await probeOne(base, 'trae');
      ok(!!trae, '[2] 名册里有 Trae');
      ok(
        trae?.status?.availability === 'not-installed',
        '[2] Trae 判为未安装（bin 只留 traecli，不再把 IDE 启动器当 CLI）',
        trae?.status?.availability
      );
      // 判定必须落在「找不到 traecli」上，而不是别的分支凑巧给了同一个状态
      ok(
        /traecli/.test(trae?.status?.message ?? ''),
        '[2] 未安装原因指向 traecli',
        (trae?.status?.message ?? '').slice(0, 80)
      );
    }

    // 造一个项目（用真实目录，后端会校验目录存在）
    const created = await json(
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: WS, name: 'A119 测试项目' }),
      })
    );
    const projectId = created.project?.id;
    ok(!!projectId, '[2] 建好一个测试项目', projectId);
    if (!projectId) return;

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // ── [3] 深链直达 ─────────────────────────────────────────────
    {
      await page.goto(`${base}/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-project-detail="${projectId}"]`, { timeout: 20000 });
      ok(true, '[3] /projects/:id 直达详情');
      ok(
        new URL(page.url()).pathname === `/projects/${projectId}`,
        '[3] 地址栏没有被改回去',
        new URL(page.url()).pathname
      );
      const navActive = await page.getAttribute('nav button[aria-label="项目"]', 'aria-current');
      ok(navActive === 'page', '[3] 导航栏「项目」是选中态', String(navActive));
    }

    // ── [4] 刷新仍停在同一个项目（本轮主要诉求）──────────────────
    {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-project-detail="${projectId}"]`, { timeout: 20000 });
      ok(true, '[4] 刷新后仍停在项目详情（不再掉回聊天视图）');
      ok(
        new URL(page.url()).pathname === `/projects/${projectId}`,
        '[4] 刷新后 URL 未变',
        new URL(page.url()).pathname
      );
    }

    // ── [6] 任务面板：新增 ───────────────────────────────────────
    {
      await page.waitForSelector('[data-project-task-input]');
      // 空面板时应有明确空态，而不是一块空白
      ok(
        await page.locator('[data-project-task-empty]').isVisible(),
        '[6] 初始为空态文案'
      );
      const input = page.locator('[data-project-task-input]');
      await input.fill('把任务面板接上');
      await input.press('Enter');
      await page.waitForSelector('[data-project-task-row]', { timeout: 10000 });
      ok(
        (await page.locator('[data-project-task-row]').count()) === 1,
        '[6] 回车新增一条任务'
      );
      ok(
        (await page.getAttribute('[data-project-task-row]', 'data-task-status')) === 'todo',
        '[6] 新任务默认是待办'
      );
      ok(
        (await page.textContent('[data-project-task-title]')) === '把任务面板接上',
        '[6] 标题原样落库',
        await page.textContent('[data-project-task-title]')
      );
      ok(
        (await page.textContent('[data-project-task-progress]'))?.includes('0/1'),
        '[6] 进度显示 0/1',
        await page.textContent('[data-project-task-progress]')
      );
    }

    // ── [6] 状态循环 todo → doing → done ────────────────────────
    {
      const toggle = page.locator('[data-project-task-toggle]');
      await toggle.click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-project-task-row]')?.getAttribute('data-task-status') ===
          'doing',
        null,
        { timeout: 10000 }
      );
      ok(true, '[6] 点一下 → 进行中');

      await toggle.click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-project-task-row]')?.getAttribute('data-task-status') ===
          'done',
        null,
        { timeout: 10000 }
      );
      ok(true, '[6] 再点一下 → 已完成');
      ok(
        (await page.textContent('[data-project-task-progress]'))?.includes('1/1'),
        '[6] 进度跟着变成 1/1',
        await page.textContent('[data-project-task-progress]')
      );

      await toggle.click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-project-task-row]')?.getAttribute('data-task-status') ===
          'todo',
        null,
        { timeout: 10000 }
      );
      ok(true, '[6] 第三下回到待办（三档循环闭合）');
    }

    // ── [7] 直接查 API 对账 ─────────────────────────────────────
    {
      const list = await json(await fetch(`${base}/api/projects/${projectId}/tasks`));
      ok((list.tasks ?? []).length === 1, '[7] API 里确实有一条任务');
      ok(list.tasks?.[0]?.status === 'todo', '[7] API 里的状态与界面一致', list.tasks?.[0]?.status);

      // 排序口径：未完成在前、完成沉底
      const second = await json(
        await fetch(`${base}/api/projects/${projectId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '第二条' }),
        })
      );
      await json(
        await fetch(`${base}/api/tasks/${second.task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        })
      );
      const ordered = await json(await fetch(`${base}/api/projects/${projectId}/tasks`));
      ok(
        ordered.tasks?.[0]?.status !== 'done' && ordered.tasks?.[1]?.status === 'done',
        '[7] 已完成的任务沉底（SQL 排序生效，不靠前端二次排）',
        (ordered.tasks ?? []).map(t => t.status).join(',')
      );

      // ── [8] 非法状态必须 400 ──────────────────────────────────
      const bad = await fetch(`${base}/api/tasks/${second.task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'finished' }),
      });
      ok(bad.status === 400, '[8] 非法 status 被拒绝（不静默改成 todo）', `HTTP ${bad.status}`);
      const still = await json(await fetch(`${base}/api/projects/${projectId}/tasks`));
      ok(
        still.tasks?.find(t => t.id === second.task.id)?.status === 'done',
        '[8] 被拒绝后原状态没被改动'
      );
    }

    // ── [6] 删除 ────────────────────────────────────────────────
    {
      const row = page.locator('[data-project-task-row]').first();
      await row.hover();
      await row.locator('[data-project-task-delete]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-project-task-row]').length === 1,
        null,
        { timeout: 10000 }
      );
      ok(true, '[6] 删除一条后列表剩 1 条');
      // 清掉剩下那条，回到空态
      const last = page.locator('[data-project-task-row]').first();
      await last.hover();
      await last.locator('[data-project-task-delete]').click();
      await page.waitForSelector('[data-project-task-empty]', { timeout: 10000 });
      ok(true, '[6] 全删光后回到空态');
    }

    // ── [5] /projects 只开列表 ──────────────────────────────────
    {
      await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-project-detail-empty]', { timeout: 20000 });
      ok(true, '[5] /projects 打开列表栏、右侧是「选一个项目」');
      ok(
        (await page.locator('[data-project-detail]').count()) === 0,
        '[5] 没有误开任何项目的详情'
      );
      // 点列表里的项目卡片 → 应该写进 URL
      await page.locator('[data-project-row]').first().click();
      await page.waitForSelector(`[data-project-detail="${projectId}"]`, { timeout: 20000 });
      ok(
        new URL(page.url()).pathname === `/projects/${projectId}`,
        '[5] 点卡片后 URL 变成 /projects/:id',
        new URL(page.url()).pathname
      );
    }

    // ── [9][10] 空会话：回填 + 换 Agent ─────────────────────────
    {
      const agents = await json(await fetch(`${base}/api/agents`));
      const ids = (agents.agents ?? []).map(a => a.id);
      ok(ids.length >= 2, '[9] 名册里至少两个 Agent 可供切换', ids.slice(0, 3).join(','));
      const [first, secondAgent] = ids;

      const made = await json(
        await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '新对话', agentId: first }),
        })
      );
      const sid = made.session?.id;
      ok(!!sid, '[9] 造出一条空会话', `${sid} / ${first}`);

      await page.goto(`${base}/chat/${sid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-agent="${first}"]`, { timeout: 20000 });
      ok(
        (await page.getAttribute(`[data-agent="${first}"]`, 'aria-pressed')) === 'true',
        '[9] 新建页高亮的就是会话自己的 Agent（不再是写死的 default）',
        first
      );

      // 换 Agent：点另一张卡片
      await page.locator(`[data-agent="${secondAgent}"]`).click();
      await page.waitForFunction(
        id => document.querySelector(`[data-agent="${id}"]`)?.getAttribute('aria-pressed') === 'true',
        secondAgent,
        { timeout: 10000 }
      );
      ok(true, '[10] 点另一张卡片后高亮切过去了', secondAgent);

      const after = await json(await fetch(`${base}/api/sessions/${sid}`));
      ok(
        after.session?.agent_id === secondAgent,
        '[10] 会话的 agent_id 真的改了（不是只改界面的假控件）',
        after.session?.agent_id
      );

      // 刷新一次：改完的 Agent 要能挺过重载
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-agent="${secondAgent}"]`, { timeout: 20000 });
      ok(
        (await page.getAttribute(`[data-agent="${secondAgent}"]`, 'aria-pressed')) === 'true',
        '[10] 刷新后仍是换过的 Agent'
      );
    }
  } catch (err) {
    ok(false, '脚本执行未抛错', String(err && err.message ? err.message : err).slice(0, 300));
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    /**
     * 必须在这里就把服务端子进程杀掉，不能只靠 `process.on('exit', cleanup)`。
     *
     * 那个 handler 只在进程真的退出时才跑，而服务端子进程活着时它的 stdout/stderr
     * 管道是本进程的活动句柄 —— **父进程等子进程死、子进程等父进程退出**，
     * 两边都不肯先动，脚本打完「全部通过」就永远不返回（2026-10-26 把它挂进
     * `verify:ui` 后整条链吊死在这里，日志停在 16:03 一行都不再动）。
     * 结果本身是对的，只是进程不肯结束 —— 这种「绿了但不退出」最难查，
     * 因为看起来像是在跑最后一个慢用例。
     */
    killTree(server?.child);
  }

  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}：${pass + fail} 项`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
