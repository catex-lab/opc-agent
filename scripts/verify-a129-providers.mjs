/**
 * A129「自定义模型厂商」真实服务端 e2e。
 *
 * ## 这条链为什么必须真起服务端
 *
 * 它跨五处状态：custom-agents.json（定义）、agent-credentials.json（Key）、
 * registry（实例与状态）、http 适配器（真发请求）、以及按模型拼 URL 的那条
 * 规则（Gemini 的模型名在路径里）。夹具层全拦掉，测的就只是「我以为它长这样」。
 *
 * ## 假上游要覆盖的形态
 *
 *   - OpenAI：GET /v1/models、POST /v1/chat/completions（SSE）
 *   - Anthropic：POST /v1/messages（SSE）
 *   - Gemini：GET /v1beta/models、POST /v1beta/models/<id>:generateContent
 *     与 :streamGenerateContent?alt=sse
 *   - 非流式兜底：/plain/v1/chat/completions 无视 stream:true，回一整段 JSON
 *   - 错误：/authfail/** 回 401；模型名 nope 回 404（复现用户那个
 *     「model route not found」）
 *
 * 运行：node scripts/verify-a129-providers.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', 'a129-e2e');
const DATA = path.join(TMP, 'data');
const REPLY = '假上游回复：链路通了';
const PLAIN_REPLY = '非流式整段回复';

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

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 假上游：三种方言 + 401/404 两个错误路径 + 非 SSE 兜底 */
function startMock() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const auth =
        req.headers['authorization'] ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? '';
      seen.push({ method: req.method, url: req.url, auth, body, headers: req.headers });
      const u = new URL(req.url, 'http://mock');
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        /* 非 JSON 请求体不关心 */
      }

      if (u.pathname.startsWith('/authfail/')) {
        return json(res, 401, { error: { message: 'invalid api key' } });
      }

      if (req.method === 'GET' && u.pathname === '/v1/models') {
        return json(res, 200, { data: [{ id: 'mock-chat-1' }, { id: 'mock-chat-2' }] });
      }
      if (req.method === 'GET' && u.pathname === '/v1beta/models') {
        return json(res, 200, {
          models: [{ name: 'models/gemini-mock' }, { name: 'models/gemini-mock-2' }],
        });
      }
      if (req.method === 'GET' && u.pathname.endsWith('/models')) {
        // 模拟「不提供清单」的网关
        return json(res, 404, { error: { message: 'not found' } });
      }

      if (req.method === 'POST' && u.pathname === '/plain/v1/chat/completions') {
        // 无视 stream:true，回整段 JSON
        return json(res, 200, { choices: [{ message: { content: PLAIN_REPLY } }] });
      }

      if (req.method === 'POST' && (u.pathname === '/v1/chat/completions' || u.pathname === '/v1/messages')) {
        if (parsed.model === 'nope') {
          return json(res, 404, { error: { message: 'model route not found' } });
        }
      }

      if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
        return sse(res, [
          { choices: [{ delta: { content: REPLY } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      }

      if (req.method === 'POST' && u.pathname === '/v1/messages') {
        return sse(res, [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: REPLY } },
          { type: 'message_stop' },
        ]);
      }

      if (req.method === 'POST' && /^\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname)) {
        return json(res, 200, { candidates: [{ content: { parts: [{ text: REPLY }] } }] });
      }
      if (req.method === 'POST' && /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(u.pathname)) {
        return sse(res, [{ candidates: [{ content: { parts: [{ text: REPLY }] } }] }]);
      }

      json(res, 404, { error: { message: `no route for ${req.method} ${u.pathname}` } });
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ srv, port, origin: `http://127.0.0.1:${port}`, base: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // 同步等 taskkill 收工：异步 spawn 时旧进程可能还占着端口，
    // 新进程 bind 失败，而 waitReady 会被**旧服务端**应答成 ready ——
    // 于是后面所有断言都打在旧进程上（自建条目只在启动时注册）。
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/** 等端口真的没人应答（旧进程退出），避免新进程 bind 失败后误判 ready */
async function waitPortFree(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return true;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
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

const j = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 建会话 + 跑一次对话，返回 SSE 全文与假上游记录 */
async function chat(base, agentId, model, message = '你好') {
  const session = await j(await post(`${base}/api/sessions`, { title: 'a128', agentId }));
  const sid = session?.session?.id ?? session?.id ?? '';
  const res = await post(`${base}/api/chat`, { sessionId: sid, agentId, message, model });
  return { sid, text: await res.text(), status: res.status };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const mock = await startMock();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nA129 自定义厂商 e2e（服务端 :${port}，假上游 :${mock.port}）`);

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
    // ── 1. 拉模型清单（保存之前）──────────────────────────────
    const listed = await j(
      await post(`${base}/api/agents/custom/models`, {
        baseUrl: mock.base,
        dialect: 'openai',
        apiKey: 'sk-test',
      })
    );
    ok(listed.ok === true && (listed.models ?? []).length === 2, '拉取模型清单：拿到 2 个',
      JSON.stringify(listed.models));
    ok((listed.models ?? []).includes('mock-chat-1'), '清单里含 mock-chat-1');

    const noList = await j(
      await post(`${base}/api/agents/custom/models`, {
        baseUrl: `${mock.origin}/plain/v1`,
        dialect: 'openai',
        apiKey: 'sk-test',
      })
    );
    ok(noList.ok === true && (noList.models ?? []).length === 0,
      '不提供 /models 的网关：ok 且空清单（不当成错误）', JSON.stringify(noList));

    // ── 2. 连通性测试：通、404、401 ───────────────────────────
    const pass = await j(
      await post(`${base}/api/agents/custom/test`, {
        baseUrl: mock.base,
        dialect: 'openai',
        apiKey: 'sk-test',
        model: 'mock-chat-1',
      })
    );
    ok(pass.ok === true, '测试连接：通过', JSON.stringify(pass.steps?.map(s => s.step)));
    ok(pass.chatUrl === `${mock.base}/chat/completions`, '回显的对话地址正确', pass.chatUrl);
    ok(pass.steps?.find(s => s.step === 'chat')?.ok === true, '对话步骤也通过');

    const notFound = await j(
      await post(`${base}/api/agents/custom/test`, {
        baseUrl: mock.base,
        dialect: 'openai',
        apiKey: 'sk-test',
        model: 'nope',
      })
    );
    const nfDetail = notFound.steps?.find(s => s.step === 'chat')?.detail ?? '';
    ok(notFound.ok === false, '测试连接：模型不存在时失败');
    ok(/404/.test(nfDetail) && /model route not found/.test(nfDetail),
      '404 转成人话并带上游原文', nfDetail);

    const badKey = await j(
      await post(`${base}/api/agents/custom/test`, {
        baseUrl: `${mock.origin}/authfail/v1`,
        dialect: 'openai',
        apiKey: 'bad',
        model: 'mock-chat-1',
      })
    );
    const bkDetail = badKey.steps?.find(s => s.step === 'models')?.detail ?? '';
    ok(badKey.ok === false, '测试连接：Key 错误时失败');
    ok(/API Key 无效/.test(bkDetail), '401 转成人话', bkDetail);

    const noKey = await fetch(`${base}/api/agents/custom/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: mock.base, dialect: 'openai', model: 'mock-chat-1' }),
    });
    ok(noKey.status === 400, '测试连接不给 Key 返回 400', String(noKey.status));

    // ── 3. 创建多模型厂商 ─────────────────────────────────────
    const created = await j(
      await post(`${base}/api/agents/custom`, {
        name: 'OpenAI 假厂',
        baseUrl: mock.base,
        dialect: 'openai',
        models: ['mock-chat-1', 'mock-chat-2'],
        apiKey: 'sk-live-1234567890',
      })
    );
    const id = created?.agent?.id ?? '';
    ok(!!id && id.startsWith('custom-'), '创建成功并返回 custom- 前缀 id', id);
    ok(created?.agent?.status?.availability === 'ready', '创建后探测即为 ready（Key 已注入进程环境）',
      created?.agent?.status?.availability + ' / ' + created?.agent?.status?.message);
    const createdModels = await j(await fetch(`${base}/api/agents/${id}/models`));
    ok((createdModels.models ?? []).length === 2, '创建后可用模型为 2 个',
      JSON.stringify((createdModels.models ?? []).map(m => m.modelId)));

    const defs = await j(await fetch(`${base}/api/agents/custom`));
    const raw = JSON.stringify(defs);
    ok(!raw.includes('sk-live-1234567890'), '定义列表不回传 Key');
    const mineDef = (defs.agents ?? []).find(a => a.id === id);
    ok(mineDef?.dialect === 'openai', '定义里存了上游格式', mineDef?.dialect);
    ok((mineDef?.models ?? []).join() === 'mock-chat-1,mock-chat-2', '定义里存了模型清单',
      JSON.stringify(mineDef?.models));

    // ── 4. 模型清单与切换 ─────────────────────────────────────
    const modelList = await j(await fetch(`${base}/api/agents/${id}/models`));
    const ids = (modelList.models ?? []).map(m => m.modelId);
    ok(ids.includes('mock-chat-1') && ids.includes('mock-chat-2'), '模型接口返回两个模型', JSON.stringify(ids));

    mock.seen.length = 0;
    const second = await chat(base, id, 'mock-chat-2');
    ok(second.text.includes(REPLY), '对话链路通（OpenAI SSE）');
    const secondReq = mock.seen.find(s => s.url.endsWith('/v1/chat/completions'));
    ok(secondReq?.body?.includes('"mock-chat-2"'), '切到第二个模型时请求体带的是它',
      secondReq?.body?.slice(0, 120));
    ok(secondReq?.auth?.includes('sk-live-1234567890'), '带上了 Bearer Key');

    // ── 5. 编辑：改名称与模型，Key 不动 ───────────────────────
    const patched = await j(
      await fetch(`${base}/api/agents/custom/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '改名后的厂',
          baseUrl: mock.base,
          dialect: 'openai',
          models: ['mock-chat-1'],
        }),
      })
    );
    ok(patched?.agent?.name === '改名后的厂', 'PATCH 改名生效', patched?.agent?.name);
    const patchedDef = (await j(await fetch(`${base}/api/agents/custom`))).agents?.find(a => a.id === id);
    ok((patchedDef?.models ?? []).join() === 'mock-chat-1', 'PATCH 模型清单生效',
      JSON.stringify(patchedDef?.models));
    ok(patched?.agent?.status?.availability === 'ready', 'PATCH 后仍是 ready（Key 没被清掉）',
      patched?.agent?.status?.availability);

    mock.seen.length = 0;
    const afterPatch = await chat(base, id, 'mock-chat-1');
    ok(afterPatch.text.includes(REPLY), '编辑后对话仍然通（Key 保留）');

    // ── 6. Anthropic 方言 ─────────────────────────────────────
    const anth = await j(
      await post(`${base}/api/agents/custom`, {
        name: 'Anthropic 假厂',
        baseUrl: mock.base,
        dialect: 'anthropic',
        models: ['claude-mock'],
        apiKey: 'sk-ant-test',
      })
    );
    const anthId = anth?.agent?.id ?? '';
    ok(!!anthId, '创建 Anthropic 方言厂商', anthId);
    mock.seen.length = 0;
    const anthChat = await chat(base, anthId, 'claude-mock');
    const anthReq = mock.seen.find(s => s.url.endsWith('/v1/messages'));
    ok(anthChat.text.includes(REPLY), 'Anthropic SSE 解析正确');
    ok(anthReq?.auth === 'sk-ant-test', 'Anthropic 用 x-api-key 鉴权', anthReq?.auth);
    ok(anthReq?.headers?.['anthropic-version'] === '2023-06-01', '带上 anthropic-version');

    // ── 7. Gemini 方言：模型名在路径里 ────────────────────────
    const gem = await j(
      await post(`${base}/api/agents/custom`, {
        name: 'Gemini 假厂',
        baseUrl: `${mock.origin}/v1beta`,
        dialect: 'gemini',
        models: ['gemini-mock', 'gemini-mock-2'],
        apiKey: 'g-key-test',
      })
    );
    const gemId = gem?.agent?.id ?? '';
    ok(!!gemId, '创建 Gemini 方言厂商', gemId);

    mock.seen.length = 0;
    const gemChat = await chat(base, gemId, 'gemini-mock-2');
    const gemReq = mock.seen.find(s => s.url.includes(':streamGenerateContent'));
    ok(gemChat.text.includes(REPLY), 'Gemini SSE 解析正确');
    ok(
      gemReq?.url?.includes('/v1beta/models/gemini-mock-2:streamGenerateContent') &&
        gemReq?.url?.includes('alt=sse'),
      '切换模型后 URL 跟着换（模型名在路径里）',
      gemReq?.url
    );
    ok(gemReq?.auth === 'g-key-test', 'Gemini 用 x-goog-api-key 鉴权', gemReq?.auth);

    const gemTest = await j(
      await post(`${base}/api/agents/custom/test`, {
        baseUrl: `${mock.origin}/v1beta`,
        dialect: 'gemini',
        apiKey: 'g-key-test',
        model: 'gemini-mock',
      })
    );
    ok(gemTest.ok === true, 'Gemini 测试连接通过');
    ok(gemTest.chatUrl?.endsWith(':generateContent'), '测试用非流式 generateContent', gemTest.chatUrl);

    // ── 8. 非 SSE 响应兜底 ────────────────────────────────────
    const plain = await j(
      await post(`${base}/api/agents/custom`, {
        name: '非流式假厂',
        baseUrl: `${mock.origin}/plain/v1`,
        dialect: 'openai',
        models: ['plain-model'],
        apiKey: 'sk-plain',
      })
    );
    const plainId = plain?.agent?.id ?? '';
    ok(!!plainId, '创建非流式厂商', plainId);
    const plainChat = await chat(base, plainId, 'plain-model');
    ok(plainChat.text.includes(PLAIN_REPLY), '上游无视 stream 回整段 JSON 时也能显示',
      plainChat.text.slice(0, 160));

    // ── 9. 地址归一化 ─────────────────────────────────────────
    const normalized = await j(
      await post(`${base}/api/agents/custom`, {
        name: '完整端点',
        baseUrl: `${mock.base}/chat/completions`,
        dialect: 'openai',
        models: ['mock-chat-1'],
        apiKey: 'sk-norm',
      })
    );
    const normId = normalized?.agent?.id ?? '';
    const normDef = (await j(await fetch(`${base}/api/agents/custom`))).agents?.find(a => a.id === normId);
    ok(normDef?.baseUrl === mock.base, '填完整端点会被剥到版本号那一层', normDef?.baseUrl);

    // ── 10. 凭据列表不再包含自建厂商 ──────────────────────────
    const creds = await j(await fetch(`${base}/api/agent-credentials`));
    ok(
      !(creds.credentials ?? []).some(c => String(c.agentId).startsWith('custom-')),
      '方式三的凭据列表里没有自建厂商（Key 归厂商编辑器管）'
    );

    // ── 11. 删除 ──────────────────────────────────────────────
    const del = await j(await fetch(`${base}/api/agents/custom/${id}`, { method: 'DELETE' }));
    ok(del.ok === true, '删除返回 ok');
    const chatAfterDel = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: second.sid, agentId: id, message: '还在吗' }),
    });
    ok(chatAfterDel.status === 404, '删完再对话返回 404', String(chatAfterDel.status));

    // ── 12. 旧数据迁移 + 重启注入顺序 ─────────────────────────
    // 写回 A114 的单模型格式（`model` 而不是 `models[]`），并配套一份 Key。
    // 重启后应能读出来、能继续对话 —— 升级不该让用户的厂商凭空消失。
    killTree(server.child);
    const freed = await waitPortFree(base);
    ok(freed, '旧服务端已退出（端口释放）');
    fs.writeFileSync(
      path.join(DATA, 'custom-agents.json'),
      JSON.stringify(
        [
          {
            id: 'custom-legacy01',
            name: '旧版厂商',
            baseUrl: mock.base,
            model: 'mock-chat-1',
            createdAt: Date.now(),
          },
        ],
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(DATA, 'agent-credentials.json'),
      JSON.stringify({ 'custom-legacy01': { key: 'sk-legacy-key' } }, null, 2)
    );

    server = await startServer(port);
    if (!server.ready) {
      ok(false, '重启后服务端就绪', server.log.slice(-400));
    } else {
      ok(true, '重启后服务端就绪');
      const legacy = await j(await fetch(`${base}/api/agents/custom`));
      const entry = (legacy.agents ?? []).find(a => a.id === 'custom-legacy01');
      ok(!!entry, '旧版单模型记录被读出来');
      ok((entry?.models ?? []).join() === 'mock-chat-1', '旧 `model` 迁成 `models[]`', JSON.stringify(entry?.models));
      ok(entry?.dialect === 'openai', '旧记录补上默认方言');

      // 冷启动探测在后台排队。只重探这一条：全量 probeAll 会去拉起十几个
      // CLI、跑几分钟，而这里要验证的只有「自建条目的 Key 有没有注入」。
      await fetch(`${base}/api/agents/custom-legacy01?probe=1`);
      const after = await j(await fetch(`${base}/api/agents`));
      const probed = (after.agents ?? []).find(a => a.id === 'custom-legacy01');
      ok(probed?.status?.availability === 'ready', '重启后 Key 仍认得（启动注入顺序正确）',
        probed?.status?.availability + ' / ' + probed?.status?.message);

      const legacyChat = await chat(base, 'custom-legacy01', 'mock-chat-1', '迁移后还在吗');
      ok(legacyChat.text.includes(REPLY), '迁移后的厂商能继续对话');
    }
  } finally {
    cleanup();
  }

  console.log(`\n${failures.length ? '❌' : '✓'} A129：${total - failures.length}/${total} 通过`);
  if (failures.length) {
    for (const f of failures) console.log('   - ' + f);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('A129 脚本异常：', err);
  process.exitCode = 1;
});
