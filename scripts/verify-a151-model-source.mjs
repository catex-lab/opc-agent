/**
 * A151：模型清单「来源与可切换性」的验收闸门。
 *
 * 要钉的是用户报的那三句话：
 *   ① 「zcode / qoder 等好几个 Agent 都是『模型由 Agent 决定』」——
 *      有些是真的没有清单，有些是**我们没接**（cursor 官方一直有
 *      `cursor-agent models`，实测 270 条）；
 *   ② 「zcode 为什么不显示 z.ai 和 Start Plan 这些套餐」——
 *      它把清单写在 `~/.zcode/v2/*.json` 里，只是没人读；
 *   ③ 「qoder 家族也没展示完整」—— 官方清单 ≠ CLI 清单 ≠ 真能路由，
 *      这一条本轮只做诊断，不在本闸门范围内。
 *
 * 所以本脚本钉三件事：
 *   [2] 接口层：cursor 真的被枚举进目录；zcode 真的从配置读出来了，
 *       并且 `selectable: false` 必须原样透出（否则就是「点了不生效」的假控件）；
 *   [3] UI 层：只读清单打开后**行不可点**、底部是解释而不是「添加模型」、
 *       并且标出「当前」用的是哪一条；
 *   [4][5] 可用性标定（P2）：判 invalid 的模型必须从菜单里消失、判 routed 的
 *       必须留下并去掉「未验证」角标、没标过的标「未验证」；界面上点一条
 *       「未验证」的，必须先打一次标定接口，通过才写进会话。
 *
 * 运行：npx tsx scripts/verify-a151-model-source.mjs（需先 npm run build）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', `a151-model-${Date.now()}`);
const DATA = path.join(TMP, 'data');
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

const json = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

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

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`\n[1] 起服务端 :${port}`);
const child = spawn('npx tsx server/index.ts', {
  cwd: ROOT,
  shell: true,
  windowsHide: true,
  env: { ...process.env, PORT: String(port), OPC_DATA_DIR: DATA, NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const { ready, log } = await waitReady(base, child);
ok(ready, '[1] 服务端起来了');
if (!ready) {
  console.log(log.slice(-1500));
  killTree(child);
  console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
  process.exit(1);
}

let browser;
try {
  // ============= [2] 接口层 =============
  console.log('\n[2] 接口层：来源与可切换性');
  const cursor = await json(await fetch(`${base}/api/agents/cursor/models`));
  ok(Array.isArray(cursor.models) && cursor.models.length > 50, '[2] cursor 枚举出真模型（不再是空）',
    `${cursor.models?.length ?? 0} 条`);
  ok(cursor.source === 'catalog', '[2] cursor 的来源是 catalog', String(cursor.source));
  ok(cursor.selectable === true, '[2] cursor 可选（能真的传下去）');
  ok(typeof cursor.defaultModel === 'string' && cursor.defaultModel.length > 0,
    '[2] cursor 给出 CLI 自己声明的默认模型', String(cursor.defaultModel));
  // 肯定式配套：名字不能只是 id 的复制，否则解析器把 `id - 显示名` 只吃了一半
  ok((cursor.models ?? []).some(m => m.name && m.name !== m.modelId),
    '[2] cursor 的显示名与 id 不同（说明 `id - 显示名` 真被拆开了）');

  const zcode = await json(await fetch(`${base}/api/agents/zcode/models`));
  ok(Array.isArray(zcode.models) && zcode.models.length > 0, '[2] zcode 从自己的配置里读出了清单',
    `${zcode.models?.length ?? 0} 条`);
  ok(zcode.source === 'agent-config', '[2] zcode 的来源是 agent-config', String(zcode.source));
  ok(zcode.selectable === false, '[2] zcode 的清单是只读的（selectable:false）');
  ok(typeof zcode.note === 'string' && zcode.note.includes('不支持命令行切换'),
    '[2] zcode 给出「为什么不能在这里切」的说明', String(zcode.note ?? '').slice(0, 24));
  // 用户原话里的那两类条目必须真的出现：套餐 + 自定义 provider 的模型名
  ok((zcode.models ?? []).some(m => /Coding Plan|Start Plan/i.test(m.name)),
    '[2] 套餐条目在（z.ai / Start Plan 这类）',
    (zcode.models ?? []).map(m => m.name).filter(n => /Plan/.test(n)).join(' / '));
  ok((zcode.models ?? []).some(m => /自定义 provider/.test(m.description ?? '')),
    '[2] 自定义 provider 的真实模型名在');

  // 对照：既没目录也没配置文件时，必须维持 unknown（不许假装有清单）。
  //
  // ⚠️ 这里原来用的是 gemini。P3 之后 gemini 归到 `manual`（它接受 --model，
  // 只是没有枚举命令），这条就红了 —— 红的是**断言的前提**，不是代码：
  // 该断言要守的是「不许编一份清单出来」，所以换一个真的既不接受 model
  // 也没有 cli 通道的 Agent（doubao）来对照，判据仍是「列表为空 + 不假装有来源」。
  const doubao = await json(await fetch(`${base}/api/agents/doubao/models`));
  ok(doubao.source === 'unknown' && (doubao.models ?? []).length === 0,
    '[2] 既无目录也无配置的 Agent 维持 unknown（不编清单）',
    `${doubao.source}/${doubao.models?.length ?? 0}`);

  // ============= [4] 接口层：标定结果真的改变菜单 =============
  //
  // 为什么这一段要往 `data/model-availability.json` 里**直接写**标定结果，
  // 而不是真打一次：一条标定要真起一次 CLI（qoder 冷态 8-20s）、真花 token，
  // 十几条就是十几分钟。闸门里只能验「拿到这个结论之后菜单怎么变」，
  // 判定本身在 `verify:model-catalog` 第 9 段用纯函数钉。
  // 真实的**写入路径**在下面用 doubao 验（http 通道没有 CLI，不发调用）。
  console.log('\n[4] 接口层：qoder「未验证」与标定过滤');
  const q0 = await json(await fetch(`${base}/api/agents/qoder/models`));
  const unv0 = Array.isArray(q0.unverified) ? q0.unverified : [];
  ok(unv0.length >= 3, '[4] qoder 把「官方有、CLI 没列」的模型标成未验证',
    `${unv0.length} 条（本机 ~/.qoder/.auth/dynamic-texts.json）`);
  ok(q0.selectable === true, '[4] 未验证 ≠ 不可选（qoder 仍可选）');
  ok((q0.models ?? []).filter(m => m.verified === false).length === unv0.length,
    '[4] unverified 名单与 verified:false 的行数一致（两个口径不许分叉）');

  const invalidId = unv0[0];
  const routedId = unv0[1];
  const clickId = unv0[2];
  const availFile = path.join(DATA, 'model-availability.json');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    availFile,
    JSON.stringify({
      version: 1,
      agents: {
        qoder: {
          [invalidId]: {
            verdict: 'invalid',
            at: Date.now(),
            evidence: `Model "${invalidId}" is not available right now; using "qfmodel" instead.`,
          },
          [routedId]: {
            verdict: 'routed',
            at: Date.now(),
            evidence: "You've reached your credit usage limit",
          },
        },
      },
    }),
    'utf8'
  );

  const q1 = await json(await fetch(`${base}/api/agents/qoder/models`));
  ok(!(q1.models ?? []).some(m => m.modelId === invalidId),
    '[4] 判 invalid 的模型不进菜单（放上去就是点了被静默替换的假控件）', invalidId);
  ok((q1.models ?? []).some(m => m.modelId === routedId && m.verified === true),
    '[4] 判 routed 的模型留在菜单里且 verified:true（名字有效、只是没额度）', routedId);
  ok((q1.unverified ?? []).length === unv0.length - 2,
    '[4] unverified 名单少了两条', `${(q1.unverified ?? []).length} / ${unv0.length}`);

  // 真实写路径：POST 标定。用 doubao（kind: http，没有 cli 通道）——
  // 它会立刻返回 unknown，**不发任何网络请求、不起任何子进程**。
  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  ok((await post(`${base}/api/agents/nope/models/probe`, { models: ['x'] })).status === 404,
    '[4] 未知 Agent 标定返回 404');
  ok((await post(`${base}/api/agents/qoder/models/probe`, {
    models: Array.from({ length: 9 }, (_, i) => `m${i}`),
  })).status === 400, '[4] 一次超过 8 条直接 400（一条最长 60s，再多用户等不住）');
  const noCli = await json(await post(`${base}/api/agents/doubao/models/probe`, {
    models: ['probe-check'],
  }));
  ok(noCli.results?.['probe-check']?.verdict === 'unknown',
    '[4] 没有 CLI 通道的 Agent 判 unknown（不猜成可用）',
    String(noCli.results?.['probe-check']?.evidence ?? ''));
  const after = JSON.parse(fs.readFileSync(availFile, 'utf8'));
  ok(after.agents?.doubao?.['probe-check']?.verdict === 'unknown',
    '[4] 标定结果真的落库了（刷新/重启后还在）');
  ok(after.agents?.qoder?.[invalidId]?.verdict === 'invalid',
    '[4] 写别的 Agent 的结果不会冲掉已有记录（merge 不是覆盖）');

  // ============= [3] UI：只读清单真的点不动 =============
  console.log('\n[3] UI：zcode 的只读模型浮层');
  const created = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'zcode', title: 'A151 只读清单' }),
    })
  );
  const sessionId = created.session?.id;
  ok(!!sessionId, '[3] 建会话成功', String(sessionId));

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto(`${base}/chat/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const trigger = page.locator('[data-model-trigger]');
  ok((await trigger.count()) === 1, '[3] 模型触发器存在（只读清单也要能打开看）');
  const triggerText = (await trigger.innerText().catch(() => '')).trim();
  ok(triggerText.includes('模型由 Agent 决定'), '[3] 触发器上不写模型名（写了就等于说「现在用的是它」）',
    triggerText);

  await trigger.click();
  await page.waitForTimeout(400);
  const popup = page.locator('[data-model-popup]');
  ok((await popup.count()) === 1, '[3] 浮层打开了');

  const rows = page.locator('[data-model-row]');
  const rowCount = await rows.count();
  ok(rowCount >= 10, '[3] 清单真的渲染出来了', `${rowCount} 行`);

  const readonlyRows = await page.locator('[data-model-row][data-model-readonly="1"]').count();
  ok(readonlyRows === rowCount, '[3] 每一行都标了只读', `${readonlyRows}/${rowCount}`);

  const addBtn = await page.locator('[data-model-popup-add]').count();
  ok(addBtn === 0, '[3] 底部没有「添加模型」（它指向枚举刷新，对配置清单没意义）');
  const note = (await page.locator('[data-model-popup-note]').innerText().catch(() => '')).trim();
  ok(note.includes('不能切换') || note.includes('不支持'), '[3] 底部是解释文案', note.slice(0, 30));

  // 点一行：浮层必须还在、触发器文字不变 —— 只读行的 onClick 是 undefined。
  //
  // ⚠️ 这里**不能用 locator.click()**：行上挂了 `aria-disabled`，Playwright 的
  // 可操作性检查会一直等「element is not enabled」直到超时（上一版就卡在这）。
  // 也不用 force:true（那等于绕过真实命中测试，证明不了什么）。
  // 正确做法是用**真实鼠标坐标**打过去 —— 命中测试照跑，事件照发，
  // 如果真绑了 onClick 就会生效。这正是要验证的「点了没反应」。
  const firstRow = rows.first();
  const firstId = await firstRow.getAttribute('data-model-id');
  ok((await firstRow.getAttribute('aria-disabled')) === 'true', '[3] 只读行标了 aria-disabled（读屏器也知道点不动）');
  const box = await firstRow.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  ok((await popup.count()) === 1, '[3] 点只读行不会关掉浮层（没有「选中」这个动作）');
  ok((await trigger.innerText()).trim() === triggerText, '[3] 点只读行不会改触发器上的文字');

  // 「当前」标记：只读清单里必须有一条被标成当前，且它就是后端给的那条
  const currentRows = page.locator('[data-model-current="1"]');
  ok((await currentRows.count()) === 1, '[3] 恰好一条被标成「当前」');
  const currentId = (await currentRows.first().getAttribute('data-model-id')) ?? '';
  ok(currentId === String(zcode.defaultModel), '[3] 「当前」那条 = 后端给的最近使用模型',
    `${currentId} vs ${zcode.defaultModel}`);
  ok(!!firstId && currentId.length > 0, '[3] 行 id 非空（否则上面几条是假绿）');

  ok(pageErrors.length === 0, '[3] 没有未捕获异常', pageErrors.slice(0, 2).join(' | '));

  // ============= [5] UI：点「未验证」的模型必须先标定 =============
  //
  // 闸门这里**不打真的标定**（真起一次 CLI + 真花 token，8-20s 一条），
  // 用 route 夹具替掉响应，只验前端这条链：
  //   点中一行 → 恰好打一次、打的是这一条 → 按结论决定「选中」还是「贴原话」。
  // 后端判定在 `verify:model-catalog` 第 9 段用纯函数钉，写入路径在 [4] 用
  // doubao（无 CLI 通道）验，三层各管一段。
  console.log('\n[5] UI：qoder 点未验证的模型要先标定');
  const qCreated = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'qoder', title: 'A151 标定' }),
    })
  );
  const qSid = qCreated.session?.id;
  ok(!!qSid, '[5] 建 qoder 会话成功', String(qSid));

  const page2 = await ctx.newPage();
  const page2Errors = [];
  page2.on('pageerror', e => page2Errors.push(e.message));

  const probeCalls = [];
  let probeMode = 'invalid';
  await page2.route('**/models/probe', async route => {
    const req = route.request();
    let body = {};
    try {
      body = JSON.parse(req.postData() || '{}');
    } catch {
      /* 非 JSON 就当空 */
    }
    probeCalls.push(body);
    const id = body?.models?.[0];
    // 慢一点：给「验证中…」一个能被看见的窗口。真实标定 8-20s，这里 600ms
    await new Promise(r => setTimeout(r, 600));
    const rec =
      probeMode === 'ok'
        ? { verdict: 'ok', at: Date.now(), evidence: 'OK' }
        : {
            verdict: 'invalid',
            at: Date.now(),
            evidence: `Model "${id}" is not available right now; using "qfmodel" instead.`,
          };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: { [id]: rec }, probed: 1 }),
    });
  });

  await page2.goto(`${base}/chat/${qSid}`, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(2500);

  const qTrigger = page2.locator('[data-model-trigger]');
  ok((await qTrigger.count()) === 1, '[5] qoder 的模型触发器存在（有清单就可选）');
  const qBefore = (await qTrigger.innerText()).trim();
  /* 肯定式：触发器上本来就该有一个真模型名。否则「标定失败后文字不变」
     在「本来就是空白」时也成立 —— 又是两边都 0 的假绿。 */
  ok(qBefore.length > 0 && qBefore !== '选择模型', '[5] 打开前触发器上已有真模型名', qBefore);
  await qTrigger.click();
  await page2.waitForTimeout(400);
  ok((await page2.locator('[data-model-popup]').count()) === 1, '[5] 浮层打开');

  const badgeCount = await page2.locator('[data-model-unverified]').count();
  /* 肯定式先钉一条：下面那条「数量相等」在**两边都是 0** 时也成立 ——
     整块未验证态被删掉时会假绿。这是本项目踩过的坑（TRAPS §4）。 */
  ok(badgeCount > 0, '[5] 至少有一条带「未验证」角标（否则下面那条相等断言会假绿）');
  ok(badgeCount === (q1.unverified ?? []).length,
    '[5] 每一条未验证的模型都带「未验证」角标', `${badgeCount} / ${(q1.unverified ?? []).length}`);
  ok((await page2.locator('[data-model-probe-hint]').count()) === 1,
    '[5] 浮层先说明「点了会跑一次 CLI」（不写这句，无响应会被当成卡死）');
  ok((await page2.locator('[data-model-popup-add]').count()) === 1,
    '[5] qoder 不是只读清单，底部仍是「添加模型」');

  const sel = id => `[data-model-id="${String(id).replace(/"/g, '\\"')}"]`;
  const target = page2.locator(sel(clickId));
  ok((await target.count()) === 1, '[5] 目标行存在（未验证那条）', clickId);
  const clickRow = async loc => {
    const b = await loc.boundingBox();
    await page2.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };

  await clickRow(target);
  await page2.waitForTimeout(200);
  const badge = (await target.locator('[data-model-unverified]').innerText().catch(() => '')).trim();
  ok(badge.includes('验证中'), '[5] 标定期间角标变「验证中…」（用户知道在等什么）', badge);
  await page2.waitForTimeout(900);

  ok(probeCalls.length === 1, '[5] 恰好打了一次标定接口', `${probeCalls.length} 次`);
  ok(JSON.stringify(probeCalls[0]?.models) === JSON.stringify([clickId]),
    '[5] 标定的是**点中的那一条**', JSON.stringify(probeCalls[0]?.models));
  const verifyErr = (await page2.locator('[data-model-verify-error]').innerText().catch(() => '')).trim();
  ok(verifyErr.includes('not available right now'),
    '[5] 失败时贴 CLI 原话（不是我们改写的「不可用」）', verifyErr.slice(0, 60));
  ok((await page2.locator('[data-model-popup]').count()) === 1,
    '[5] 标定失败浮层不关（用户要能换一条再试）');
  ok((await qTrigger.innerText()).trim() === qBefore, '[5] 标定失败不改会话里的模型');

  // 第二次：同一条，这次判 ok —— 必须真的选中并关掉浮层
  probeMode = 'ok';
  await clickRow(target);
  await page2.waitForTimeout(1000);
  ok(probeCalls.length === 2, '[5] 再点一次会重新标（上次的失败不缓存成「不可用」）',
    `${probeCalls.length} 次`);
  ok((await page2.locator('[data-model-popup]').count()) === 0, '[5] 通过后浮层关掉');
  ok((await qTrigger.innerText()).trim() === clickId, '[5] 触发器上写的就是这条模型',
    (await qTrigger.innerText()).trim());

  // 已标定过的行（verified:true）再点**不许**再打标定 —— 选一次花一次 token 是错的
  await qTrigger.click();
  await page2.waitForTimeout(400);
  await clickRow(page2.locator(sel(routedId)));
  await page2.waitForTimeout(600);
  ok(probeCalls.length === 2, '[5] 已标定过的行不再打标定接口', `${probeCalls.length} 次`);
  ok((await page2.locator('[data-model-popup]').count()) === 0, '[5] 已标定过的行点了直接选中');
  ok((await qTrigger.innerText()).trim() === routedId, '[5] 换成了那条已标定的模型',
    (await qTrigger.innerText()).trim());

  ok(page2Errors.length === 0, '[5] 没有未捕获异常', page2Errors.slice(0, 2).join(' | '));

  // ============= [6] 手动填模型名（P3） =============
  //
  // 「有 --model、但没有枚举命令」的 Agent，界面原来写的是「模型由 Agent 决定」——
  // 那是假话：应用明明能把模型名传下去，只是不知道有哪些可选。
  // 这一段钉三件事：① 谁该进这一档（判据是 buildArgs 自己，不是手写表）；
  // ② 谁**不**该进（没有 cli 通道的，填了也传不下去）；
  // ③ 三种标定结论的处置必须分开：ok/routed 选中、invalid 拦住、unknown 交用户。
  console.log('\n[6] 手动填模型名：没有清单但接受 --model 的那些');
  const MANUAL_EXPECT = ['gemini', 'claude', 'pi', 'antigravity', 'kimicli'];
  for (const id of MANUAL_EXPECT) {
    const r = await json(await fetch(`${base}/api/agents/${id}/models`));
    ok(r.source === 'manual' && r.manual === true && r.selectable === true,
      `[6] ${id} 走手动模式（接受 --model 但没有枚举命令）`, `${r.source}/${r.manual}`);
    ok(Array.isArray(r.models) && r.models.length === 0,
      `[6] ${id} 的清单是空的（不许编一份出来）`);
  }
  // 反面对照①：没有 cli 通道的 Agent 绝不能给输入框 —— 填了也传不下去
  for (const id of ['doubao', 'hermes', 'kimicode']) {
    const r = await json(await fetch(`${base}/api/agents/${id}/models`));
    ok(r.source === 'unknown' && !r.manual,
      `[6] ${id} 没有 cli 通道 ⇒ 不给手动输入框`, `${r.source}/${r.models?.length ?? 0} 条`);
  }
  // 反面对照②：能枚举 / 能读配置的不许退化成手动
  const cursor2 = await json(await fetch(`${base}/api/agents/cursor/models`));
  ok(cursor2.source === 'catalog' && !cursor2.manual, '[6] 能枚举的 Agent 不走手动模式', cursor2.source);
  const zcode2 = await json(await fetch(`${base}/api/agents/zcode/models`));
  ok(zcode2.source === 'agent-config' && !zcode2.manual, '[6] 能读配置的 Agent 不走手动模式', zcode2.source);

  const gCreated = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'gemini', title: 'A151 手动模型' }),
    })
  );
  const gSid = gCreated.session?.id;
  ok(!!gSid, '[6] 建 gemini 会话成功', String(gSid));

  const page3 = await ctx.newPage();
  const page3Errors = [];
  page3.on('pageerror', e => page3Errors.push(e.message));

  const manualCalls = [];
  let manualProbe = 'invalid';
  await page3.route('**/models/probe', async route => {
    let body = {};
    try {
      body = JSON.parse(route.request().postData() || '{}');
    } catch {
      /* 非 JSON 就当空 */
    }
    manualCalls.push(body);
    const id = body?.models?.[0];
    await new Promise(r => setTimeout(r, 300));
    const rec =
      manualProbe === 'unknown'
        ? { verdict: 'unknown', at: Date.now(), evidence: '超时（CLI 无响应）' }
        : {
            verdict: 'invalid',
            at: Date.now(),
            evidence: `Model "${id}" is not available right now; using "default" instead.`,
          };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: { [id]: rec }, probed: 1 }),
    });
  });

  await page3.goto(`${base}/chat/${gSid}`, { waitUntil: 'domcontentloaded' });
  await page3.waitForTimeout(2500);

  const gTrigger = page3.locator('[data-model-trigger]');
  ok((await gTrigger.count()) === 1, '[6] 手动模式下也有模型芯片（原来这里没有芯片）');
  ok((await gTrigger.innerText()).trim() === '手动指定模型', '[6] 芯片上写「手动指定模型」',
    (await gTrigger.innerText()).trim());

  await gTrigger.click();
  await page3.waitForTimeout(400);
  ok((await page3.locator('[data-model-popup][data-model-popup-manual="1"]').count()) === 1,
    '[6] 浮层是手动模式');
  ok((await page3.locator('[data-model-manual-input]').count()) === 1, '[6] 有输入框');
  ok((await page3.locator('[data-model-row]').count()) === 0, '[6] 没有假列表');
  ok((await page3.locator('[data-model-popup-add]').count()) === 0,
    '[6] 没有「添加模型」（这类 Agent 永远枚举不出东西，刷新也是空）');
  const manualNote = (await page3.locator('[data-model-popup-note]').innerText().catch(() => '')).trim();
  ok(manualNote.length > 0, '[6] 底部有解释文案', manualNote.slice(0, 30));

  const mInput = page3.locator('[data-model-manual-input]');
  await mInput.fill('gemini-2.5-pro');
  await page3.locator('[data-model-manual-confirm]').click();
  await page3.waitForTimeout(700);
  ok(manualCalls.length === 1 &&
     JSON.stringify(manualCalls[0]?.models) === JSON.stringify(['gemini-2.5-pro']),
    '[6] 确认时把填的名字原样送去标定', JSON.stringify(manualCalls[0]?.models));
  const msg1 = (await page3.locator('[data-model-manual-msg]').innerText().catch(() => '')).trim();
  ok(msg1.includes('not available right now'), '[6] CLI 说没这个名字时贴原话', msg1.slice(0, 50));
  ok((await page3.locator('[data-model-manual-force]').count()) === 0,
    '[6] invalid 时不给「仍然使用」（那等于放行一个假控件）');
  ok((await gTrigger.innerText()).trim() === '手动指定模型', '[6] invalid 不写进会话');

  // 第二次：CLI 没给出可判读的回应 → 允许用户自己拍板
  manualProbe = 'unknown';
  await page3.locator('[data-model-manual-confirm]').click();
  await page3.waitForTimeout(700);
  ok((await page3.locator('[data-model-manual-force]').count()) === 1,
    '[6] unknown 时给「仍然使用」（否则 claude 这类本机缺二进制的永远填不进去）');
  const msg2 = (await page3.locator('[data-model-manual-msg]').innerText().catch(() => '')).trim();
  ok(msg2.includes('超时'), '[6] unknown 的提示与 invalid 分开报', msg2.slice(0, 40));
  await page3.locator('[data-model-manual-force]').click();
  await page3.waitForTimeout(500);
  ok((await page3.locator('[data-model-popup]').count()) === 0, '[6] 「仍然使用」后浮层关掉');
  ok((await gTrigger.innerText()).trim() === 'gemini-2.5-pro', '[6] 芯片上写的就是填的名字',
    (await gTrigger.innerText()).trim());

  // 再打开：输入框要带出当前值（否则用户看不到现在用的是哪个）
  await gTrigger.click();
  await page3.waitForTimeout(400);
  ok((await page3.locator('[data-model-manual-input]').inputValue()) === 'gemini-2.5-pro',
    '[6] 再打开时输入框带出当前值');
  ok(page3Errors.length === 0, '[6] 没有未捕获异常', page3Errors.slice(0, 2).join(' | '));

  /* ============= [7] A161 回归：SDK 类 Agent 的平台清单必须**能切** =============
   *
   * 症状（用户报的「workbuddy 不能切换模型了」）：WorkBuddy 改走 SDK 后，
   * `/api/agents/workbuddy/models` 回 `unknown` + 空列表（SDK 不枚举），
   * 而真正的清单来自平台目录 `/api/models`。前端把「它自己没有清单」误当成
   * 「模型不可切换」，于是 26 条能选的模型被渲染成只读清单 —— 点了没反应。
   *
   * 判据必须落在**能不能点**上，不是「列表有没有内容」：
   *   · 每行不许带 `data-model-readonly="1"`（只读行才是那个假控件）；
   *   · 底部必须有「添加模型」（只读时它才消失）；
   *   · 点一行必须真的选中并关掉浮层（只读行点了浮层不动）。
   * 这三条与 [3] 的 zcode 只读断言正好互为反例：同一份前端，两种结论。 */
  console.log('\n[7] WorkBuddy：平台模型清单可切换（A161）');
  const wbCreated = await json(
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'workbuddy', title: 'A161 平台清单可切' }),
    })
  );
  const wbSid = wbCreated.session?.id;
  ok(!!wbSid, '[7] 建 workbuddy 会话成功', String(wbSid));

  // 先证明前提成立：Agent 级接口确实是「unknown + 空列表」，
  // 否则下面几条可能只是因为「它有清单」而绿，跟本次修复无关。
  const wbModels = await json(await fetch(`${base}/api/agents/workbuddy/models`));
  ok(wbModels.source === 'unknown' && (wbModels.models ?? []).length === 0,
    '[7] 前提：Agent 级清单是 unknown + 空（修复针对的正是这一格）',
    `${wbModels.source} / ${(wbModels.models ?? []).length} 条`);

  const page4 = await ctx.newPage();
  const page4Errors = [];
  page4.on('pageerror', e => page4Errors.push(e.message));
  await page4.goto(`${base}/chat/${wbSid}`, { waitUntil: 'domcontentloaded' });
  await page4.waitForTimeout(2500);

  const wbTrigger = page4.locator('[data-model-trigger]');
  /* 新建的会话页要先挂载输入区，2.5s 固定等待在冷启动时不够（第一版就红在
     这一条，而下面 click() 因为会自动重试反而成功 —— 断言比动作更严格，
     顺序错了就会得到「动作过了、断言没过」的假红）。这里显式等挂载。 */
  const wbTriggerShown = await wbTrigger
    .first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  ok(wbTriggerShown && (await wbTrigger.count()) === 1, '[7] 模型触发器存在');
  await wbTrigger.click();
  await page4.waitForTimeout(400);

  const wbPopup = page4.locator('[data-model-popup]');
  ok((await wbPopup.count()) === 1, '[7] 浮层打开了');

  const wbRows = page4.locator('[data-model-row]');
  const wbRowCount = await wbRows.count();
  ok(wbRowCount >= 1, '[7] 平台清单渲染出来了', `${wbRowCount} 行`);

  const wbReadonlyRows = await page4.locator('[data-model-row][data-model-readonly="1"]').count();
  ok(wbReadonlyRows === 0, '★ [7] 没有一行是只读的（只读＝点了没反应的假控件）',
    `${wbReadonlyRows}/${wbRowCount}`);

  ok((await page4.locator('[data-model-popup-add]').count()) === 1,
    '★ [7] 底部有「添加模型」（只读清单才把它换成解释文案）');
  ok((await page4.locator('[data-model-popup-note]').count()) === 0,
    '★ [7] 底部不是「只能读取，不能切换」那句');

  // 点一行：能选的清单点了就该选中并关浮层（只读清单点了浮层不动）
  const wbFirst = wbRows.first();
  const wbBox = await wbFirst.boundingBox();
  if (wbBox) await page4.mouse.click(wbBox.x + wbBox.width / 2, wbBox.y + wbBox.height / 2);
  await page4.waitForTimeout(400);
  ok((await wbPopup.count()) === 0, '★ [7] 点一行后浮层关闭（说明真的选中了）');
  ok(page4Errors.length === 0, '[7] 没有未捕获异常', page4Errors.slice(0, 2).join(' | '));
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(child);
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
if (fail) {
  console.log('✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
