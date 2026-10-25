/**
 * A114「用户自建 Agent」真实服务端 e2e。
 *
 * ## 为什么必须真起服务端
 *
 * 这条链跨了四处状态：**custom-agents.json**（定义落盘）、
 * **agent-credentials.json**（Key 落盘 + 注入 process.env）、**registry**
 * （内存里的 Provider）和**http 适配器**（真的发一次请求）。夹具层把
 * /api/** 全拦掉，等于把这四处都换成我写的假数据 —— 那测的只是
 * 「我以为它长这样」。所以这里真起服务端、真读真写临时 data 目录。
 *
 * ## 为什么还要一个假 OpenAI 端点
 *
 * 「能调通模型」是这条功能的终点，但验证脚本不能依赖外网。所以本地起一个
 * 只认 POST /v1/chat/completions 的小服务端，按 OpenAI 的 SSE 形状回一段
 * 固定文本。它同时证明了 URL 拼装（`${baseUrl}/chat/completions`）、
 * 请求头里的 Key、以及 SSE 解析三段都是对的。
 *
 * 运行：node scripts/verify-a114-custom-agent.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', 'a114-e2e');
const DATA = path.join(TMP, 'data');
const REPLY = '自建端点回复：链路通了';

let total = 0;
const failures = [];
function ok(cond, label, detail) {
  total++;
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
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

/** 假 OpenAI 兼容端点：只回一段 SSE 文本 */
function startMockLlm() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ auth: req.headers['authorization'] ?? '', body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = o => `data: ${JSON.stringify(o)}\n\n`;
      res.write(chunk({ choices: [{ delta: { content: REPLY } }] }));
      res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ srv, base: `http://127.0.0.1:${port}/v1`, port, seen });
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

async function waitReady(base, child, timeoutMs = 60000) {
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

const j = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const mock = await startMockLlm();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA114 自建 Agent e2e（服务端 :${port}，假模型 :${mock.port}）`);

  let server = await startServer(port);
  if (!server.ready) {
    ok(false, '服务端启动并就绪', server.log.slice(-500));
    return;
  }
  ok(true, '服务端启动并就绪');

  const cleanup = () => {
    killTree(server?.child);
    try {
      mock.srv.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  try {
    // ── 1. 创建 ────────────────────────────────────────────────
    const created = await (
      await fetch(`${base}/api/agents/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '我的 DeepSeek',
          baseUrl: mock.base,
          model: 'deepseek-chat',
          apiKey: 'sk-test-1234567890',
        }),
      })
    ).json();
    const id = created?.agent?.id ?? '';
    ok(!!id && id.startsWith('custom-'), '创建成功并返回 custom- 前缀 id', id);
    ok(created?.agent?.custom === true, '返回的 Agent 带 custom 标记');
    ok(created?.agent?.status?.availability === 'ready', '创建后探测即为 ready（Key 已注入进程环境）',
      created?.agent?.status?.availability + ' / ' + created?.agent?.status?.message);

    // ── 2. 名册里看得见 ────────────────────────────────────────
    const list = await j(await fetch(`${base}/api/agents`));
    const mine = (list.agents ?? []).find(a => a.id === id);
    ok(!!mine, 'GET /api/agents 里含这条自建 Agent');
    ok(mine?.kind === 'http', '接入方式是 http（复用豆包/Kimi 同一条适配器）', mine?.kind);
    ok((mine?.capabilities ?? []).join() === 'chat,write', '只标 chat/write，不谎称能跑工具',
      (mine?.capabilities ?? []).join());
    ok(Array.isArray(mine?.eventCapabilities) && mine.eventCapabilities.length === 0,
      '过程能力为空数组（不是 undefined）');

    // ── 3. 定义列表不泄密 ──────────────────────────────────────
    const defs = await j(await fetch(`${base}/api/agents/custom`));
    const raw = JSON.stringify(defs);
    ok(!raw.includes('sk-test-1234567890'), 'GET /api/agents/custom 不回传 Key');
    ok((defs.agents ?? []).some(a => a.id === id && a.model === 'deepseek-chat'),
      '定义里有模型名');

    // ── 4. 模型清单 ────────────────────────────────────────────
    const models = await j(await fetch(`${base}/api/agents/${id}/models`));
    ok((models.models ?? []).some(m => m.modelId === 'deepseek-chat'),
      '模型清单返回用户填的那一个', JSON.stringify(models.models));

    // ── 5. 真的能对话 ──────────────────────────────────────────
    const session = await j(
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'a114', agentId: id }),
      })
    );
    const sid = session?.session?.id ?? session?.id ?? '';
    ok(!!sid, '能用自建 Agent 建会话', sid);

    const sse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, agentId: id, message: '你好' }),
    });
    const sseText = await sse.text();
    ok(sseText.includes(REPLY), '对话链路通：假端点的回复出现在 SSE 流里',
      sseText.includes(REPLY) ? '' : sseText.slice(0, 300));
    ok(mock.seen.length === 1 && mock.seen[0].auth.includes('sk-test-1234567890'),
      '请求带上了 Authorization: Bearer <Key>', mock.seen[0]?.auth);
    ok(mock.seen[0]?.body?.includes('deepseek-chat'), '请求体带上了模型名');

    // ── 6. 校验失败路径 ────────────────────────────────────────
    const badUrl = await fetch(`${base}/api/agents/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '坏地址', baseUrl: '不是-url', model: 'm', apiKey: 'k' }),
    });
    ok(badUrl.status === 400, '坏 URL 返回 400', String(badUrl.status));
    for (const [field, body] of [
      ['名称', { baseUrl: mock.base, model: 'm', apiKey: 'k' }],
      ['模型名', { name: 'n', baseUrl: mock.base, apiKey: 'k' }],
      ['API Key', { name: 'n', baseUrl: mock.base, model: 'm' }],
    ]) {
      const r = await fetch(`${base}/api/agents/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      ok(r.status === 400, `缺${field}返回 400`, String(r.status));
    }
    const longName = await fetch(`${base}/api/agents/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '名'.repeat(21), baseUrl: mock.base, model: 'm', apiKey: 'k' }),
    });
    ok(longName.status === 400, '超长名称返回 400', String(longName.status));

    // ── 7. 不能删内置条目 ──────────────────────────────────────
    const builtin = await fetch(`${base}/api/agents/custom/workbuddy`, { method: 'DELETE' });
    ok(builtin.status === 400, '删内置 id 返回 400（只能删自建）', String(builtin.status));

    // ── 8. 删除 ────────────────────────────────────────────────
    const del = await j(await fetch(`${base}/api/agents/custom/${id}`, { method: 'DELETE' }));
    ok(del.ok === true, '删除返回 ok');
    const afterDel = await j(await fetch(`${base}/api/agents`));
    ok(!(afterDel.agents ?? []).some(a => a.id === id), '删完后名册里没有它了');
    const chatAfterDel = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, agentId: id, message: '还在吗' }),
    });
    ok(chatAfterDel.status === 404, '删完再对话返回 404', String(chatAfterDel.status));
    const delAgain = await fetch(`${base}/api/agents/custom/${id}`, { method: 'DELETE' });
    ok(delAgain.status === 404, '重复删除返回 404（幂等）', String(delAgain.status));

    // ── 9. 重启后仍在（最关键的启动顺序）──────────────────────
    // 必须用**另一条**自建 Agent 来验：上面刚把第一条删了，拿它断言等于
    // 「删掉的东西重启后还在」，那是测试自己的顺序错误。
    //
    // registerCustomDefs() 必须跑在 loadAgentCredentials() 之前，否则重启后
    // 冷启动那轮探测找不到自建 Agent 的变量名，会把它判成「缺 Key」。
    const rebootSpec = {
      name: '重启存活',
      baseUrl: mock.base,
      model: 'reboot-model',
      apiKey: 'sk-reboot-0987654321',
    };
    const made = await j(
      await fetch(`${base}/api/agents/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rebootSpec),
      })
    );
    const rebootId = made?.agent?.id ?? '';
    ok(!!rebootId, '为重启验证另建一条', rebootId);

    killTree(server.child);
    await new Promise(r => setTimeout(r, 1200));
    server = await startServer(port);
    if (!server.ready) {
      ok(false, '重启后服务端就绪', server.log.slice(-400));
    } else {
      ok(true, '重启后服务端就绪');
      const reboot = await j(await fetch(`${base}/api/agents`));
      const back = (reboot.agents ?? []).find(a => a.id === rebootId);
      ok(!!back, '重启后自建 Agent 回到名册');
      // 冷启动时 `/api/agents` 按**当前缓存**返回，探测在后台跑。而
      // `probeAll` 的并发上限是 3、内置 ACP 握手要 20 秒以上，自建 Agent
      // 排在队列最后 —— 纯等后台探测这条断言会跑好几分钟。所以主动触发一次
      // 全量强制探测：如果启动时 Key 没注进进程环境，这里探出来就是
      // needs-auth；是 ready 才证明 registerCustomDefs() 确实跑在了
      // loadAgentCredentials() 之前。
      await fetch(`${base}/api/agents/probe`, { method: 'POST' });
      const after = await j(await fetch(`${base}/api/agents`));
      const probed = (after.agents ?? []).find(a => a.id === rebootId);
      ok(probed?.status?.availability === 'ready', '重启后 Key 仍认得（启动注入顺序正确）',
        probed?.status?.availability + ' / ' + probed?.status?.message);
      const defsAfter = await j(await fetch(`${base}/api/agents/custom`));
      ok((defsAfter.agents ?? []).some(a => a.id === rebootId && a.name === '重启存活'),
        '重启后定义也还在（落盘读得回来）');
    }
  } finally {
    cleanup();
  }

  console.log(`\n${failures.length ? '❌' : '✓'} A114：${total - failures.length}/${total} 通过`);
  if (failures.length) {
    for (const f of failures) console.log('   - ' + f);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('A114 脚本异常：', err);
  process.exitCode = 1;
});
