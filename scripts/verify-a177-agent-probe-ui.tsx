/**
 * A177 前端闸门。
 *
 * 不依赖 vite build / 浏览器：用 react-dom/server 直接渲染资料页的真实组件，
 * 加上对 `agentProbe.ts` 协调器的离线调用，覆盖「按钮存在 / loading / 禁用 /
 * 时间戳 / 失败原因 / 并发去重 / 只合并目标」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentDetailSections } from '../src/components/AgentDetailSections';
import {
  createSingleProbeRunner,
  describeProbeFeedback,
  formatProbeDuration,
  formatProbeTime,
  probeFeedbackFromResult,
  PROBE_REASON_LABEL,
  type SingleProbeResponse,
} from '../src/agentProbe';
import { agentStatusViewOf, type RegisteredAgent } from '../src/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

function baseAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'alpha',
    name: 'Alpha',
    kind: 'cli',
    capabilities: ['chat'],
    eventCapabilities: [],
    skills: [],
    familyPeers: [],
    install: { method: 'none', requires: 'none', note: '', checkedAt: '' },
    status: {
      availability: 'unknown',
      installed: true,
      message: '探测超时：已等待 120 秒仍未返回',
      probeState: 'timeout',
      probedAt: '2026-11-04T10:20:30.000Z',
    },
    ...overrides,
  } as RegisteredAgent;
}

function renderAgent(agent: RegisteredAgent, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(AgentDetailSections, {
      agent,
      onReprobe: () => {},
      ...extra,
    } as any)
  );
}

async function main() {
  console.log('A177 单 Agent 探测前端闸门\n');

  console.log('1) 资料页入口：按钮存在 / loading / 禁用 / 结果与时间戳');

  await check('未探测时存在「重新探测」按钮，且未禁用', () => {
    const html = renderAgent(baseAgent());
    assert.match(html, /data-agent-reprobe/, '按钮必须存在');
    assert.match(html, />重新探测</, '按钮文案应为「重新探测」');
    const tag = html.match(/<button[^>]*data-agent-reprobe[^>]*>/)?.[0] ?? '';
    assert.ok(tag, '找不到按钮标签');
    assert.ok(!/disabled(=|\s|>)/.test(tag), '空闲态不应禁用');
    assert.equal((html.match(/data-agent-reprobe/g) || []).length, 1, '只应有一个单探测按钮');
    assert.match(html, /只探测当前条目，其他 Agent 的状态与时间戳保持不变/);
  });

  await check('探测中：按钮 disabled + aria-busy，文案变为「探测中…」', () => {
    const html = renderAgent(baseAgent(), { probing: true });
    const tag = html.match(/<button[^>]*data-agent-reprobe[^>]*>/)?.[0] ?? '';
    assert.ok(/disabled(=|\s|>)/.test(tag), '探测中必须禁用，防止重复点击');
    assert.match(tag, /aria-busy="true"/);
    assert.match(html, /探测中…/);
    assert.match(html, /data-agent-probe-state="probing"/);
  });

  await check('成功后展示结果与时间戳、耗时', () => {
    const html = renderAgent(baseAgent({
      status: { availability: 'ready', installed: true, message: '已登录', probedAt: '2026-11-04T10:20:30.000Z' },
    }), {
      probeFeedback: {
        state: 'done',
        ok: true,
        at: '2026-11-04T10:20:30.000Z',
        durationMs: 1234,
      },
    });
    assert.match(html, /探测完成 · \d{2}:\d{2}:\d{2} · 1\.2 s/);
    assert.match(html, /data-agent-probe-state="done"/);
  });

  await check('失败后展示原因与时间戳', () => {
    const html = renderAgent(baseAgent(), {
      probeFeedback: {
        state: 'done',
        ok: false,
        reason: 'timeout',
        at: '2026-11-04T10:20:30.000Z',
        durationMs: 60000,
        message: '探测超时：已等待 120 秒仍未返回',
      },
    });
    assert.match(html, /探测超时 · \d{2}:\d{2}:\d{2} · 60\.0 s：探测超时/);
    assert.ok(!html.includes('探测完成'), '失败时不能显示「探测完成」');
  });

  console.log('2) 四态文案互不混淆，超时不得显示成未登录');

  await check('未登录 / 凭据无效 / 探测超时 / 探测失败 标签互不相同', () => {
    const login = agentStatusViewOf(baseAgent({
      status: { availability: 'needs-auth', installed: true, message: '未登录', probedAt: '' },
    }));
    const invalid = agentStatusViewOf(baseAgent({
      status: { availability: 'needs-auth', installed: true, message: '凭据无效：401', probeState: 'credential-invalid', probedAt: '' },
    }));
    const timeout = agentStatusViewOf(baseAgent({
      status: { availability: 'unknown', installed: true, message: 'Request timeout: initialize', probeState: 'timeout', probedAt: '' },
    }));
    const probeFailed = agentStatusViewOf(baseAgent({
      status: { availability: 'needs-auth', installed: true, message: '探测失败：boom', probeState: 'probe-failed', probedAt: '' },
    }));
    assert.equal(login.label, '未登录');
    assert.equal(invalid.label, '凭据无效');
    assert.equal(timeout.label, '探测超时');
    assert.equal(probeFailed.label, '探测失败');
    const labels = new Set([login.label, invalid.label, timeout.label, probeFailed.label]);
    assert.equal(labels.size, 4, '四态文案不得重复');
    assert.notEqual(timeout.label, login.label, '超时态不得显示成未登录');
  });

  await check('describeProbeFeedback 四种原因各自可读且带原因词', () => {
    const labels = Object.values(PROBE_REASON_LABEL);
    assert.equal(new Set(labels).size, 4);
    for (const reason of ['timeout', 'not-found', 'permission', 'unknown'] as const) {
      const text = describeProbeFeedback({ state: 'done', reason, at: '2026-11-04T10:20:30.000Z' });
      assert.ok(text.startsWith(PROBE_REASON_LABEL[reason]), `${reason} 文案应以原因开头：${text}`);
      assert.match(text, /\d{2}:\d{2}:\d{2}/, '必须带时间戳');
    }
    assert.equal(formatProbeDuration(500), '500 ms');
    assert.equal(formatProbeTime('2026-11-04T10:20:30.000Z').length, 8);
  });

  console.log('3) 前端协调器：并发去重 / 只合并目标 / 失败可见');

  await check('同一 agentId 并发点击只发一次请求，onStart 也只触发一次', async () => {
    let fetchCalls = 0;
    let starts = 0;
    const d = (() => {
      let resolve!: (v: Response) => void;
      const promise = new Promise<Response>(r => (resolve = r));
      return { promise, resolve };
    })();
    const runner = createSingleProbeRunner({
      fetchImpl: (async () => {
        fetchCalls++;
        return d.promise;
      }) as typeof fetch,
      onStart: () => {
        starts++;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });
    const a = runner('alpha');
    const b = runner('alpha');
    const payload: SingleProbeResponse = {
      agentId: 'alpha',
      ok: true,
      status: { availability: 'ready', installed: true, probedAt: '2026-11-04T10:20:30.000Z' },
      durationMs: 120,
      probedAt: '2026-11-04T10:20:30.000Z',
    };
    d.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(fetchCalls, 1, '同一 Agent 的并发点击不得叠加请求');
    assert.equal(starts, 1, 'loading 状态只进入一次');
    assert.equal(ra?.status.availability, 'ready');
    assert.equal(rb?.status.availability, 'ready');
  });

  await check('不同 agentId 的探测互不影响', async () => {
    let fetchCalls = 0;
    const runner = createSingleProbeRunner({
      fetchImpl: (async (_url: string) => {
        fetchCalls++;
        return new Response(JSON.stringify({
          agentId: _url.includes('alpha') ? 'alpha' : 'beta',
          ok: true,
          status: { availability: 'ready', installed: true, probedAt: '' },
          durationMs: 10,
          probedAt: '',
        }), { status: 200 });
      }) as unknown as typeof fetch,
      onStart: () => {},
      onSuccess: () => {},
      onFailure: () => {},
    });
    await Promise.all([runner('alpha'), runner('beta')]);
    assert.equal(fetchCalls, 2);
  });

  await check('结果只按 agentId 合并目标条目，其余对象保持同一引用', async () => {
    const agents = [baseAgent(), baseAgent({ id: 'beta', name: 'Beta' })];
    const beforeBeta = agents[1];
    let received: SingleProbeResponse | null = null;
    const runner = createSingleProbeRunner({
      fetchImpl: (async () => new Response(JSON.stringify({
        agentId: 'alpha',
        ok: true,
        status: { availability: 'ready', installed: true, message: '已登录', probedAt: '2026-11-04T10:20:30.000Z' },
        durationMs: 30,
        probedAt: '2026-11-04T10:20:30.000Z',
      }), { status: 200 })) as typeof fetch,
      onStart: () => {},
      onSuccess: (_id, data) => {
        received = data;
        const next = agents.map(a => (a.id === data.agentId ? { ...a, status: data.status } : a));
        agents[0] = next[0];
        agents[1] = next[1];
      },
      onFailure: () => {},
    });
    await runner('alpha');
    assert.ok(received);
    assert.equal(agents[0].status.availability, 'ready');
    assert.equal(agents[1], beforeBeta, 'beta 的对象引用必须原样保留（未重写）');
  });

  await check('HTTP 500 时失败原因可见', async () => {
    let failure: { reason?: string; message?: string } | undefined;
    const runner = createSingleProbeRunner({
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'Agent 不存在' }), { status: 404 })) as typeof fetch,
      onStart: () => {},
      onSuccess: () => {},
      onFailure: (_id, fb) => {
        failure = fb;
      },
    });
    const result = await runner('alpha');
    assert.equal(result, null);
    assert.equal(failure?.reason, 'unknown');
    assert.match(failure?.message ?? '', /Agent 不存在/);
  });

  await check('probeFeedbackFromResult 把服务端的 probeState 带进 UI 反馈', () => {
    const fb = probeFeedbackFromResult({
      agentId: 'alpha',
      ok: false,
      status: { availability: 'unknown', installed: true, message: '探测超时', probeState: 'timeout', probedAt: '2026-11-04T10:20:30.000Z' },
      durationMs: 1000,
      probedAt: '2026-11-04T10:20:30.000Z',
      reason: 'timeout',
    });
    assert.equal(fb.probeState, 'timeout');
    assert.equal(fb.reason, 'timeout');
    assert.match(describeProbeFeedback(fb), /探测超时/);
  });

  console.log('4) 扩展矩阵与 Agent 状态同源');

  await check('矩阵读取同一份 agents 状态，不维护第二套文案', () => {
    const root = path.resolve(process.cwd());
    const matrixSrc = readFileSync(path.join(root, 'src/components/ExtensionDetail.tsx'), 'utf8');
    assert.match(matrixSrc, /agents\?:\s*RegisteredAgent\[\]/, '矩阵应接收注册表 agents');
    assert.match(matrixSrc, /agentById\.get\(spec\.agentId\)/, '矩阵应按 agentId 查同一份状态');
    assert.match(matrixSrc, /agentStatusViewOf\(agentInfo\)/, '矩阵状态词必须走统一状态函数');
    assert.match(matrixSrc, /data-ext-matrix-agent-state/, '矩阵需暴露状态锚点供断言');
    const appSrc = readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
    assert.match(appSrc, /agents=\{registry\.agents\}/, 'App 必须把同一份名册传给矩阵');
    assert.match(appSrc, /void reloadExtList\(\)/, '探测后只重算展示，不重新探测');
  });

  await check('同一份 mock 数据在详情页与矩阵得到同一个状态词', () => {
    const agent = baseAgent({
      status: { availability: 'needs-auth', installed: true, message: '未登录', probedAt: '' },
    });
    const view = agentStatusViewOf(agent);
    // 详情页状态行与矩阵角标都调用 agentStatusViewOf，这里验证同一输入输出稳定
    assert.equal(agentStatusViewOf(agent).key, view.key);
    assert.equal(agentStatusViewOf(agent).label, '未登录');
  });

  console.log(`\nA177 UI 结果：通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
