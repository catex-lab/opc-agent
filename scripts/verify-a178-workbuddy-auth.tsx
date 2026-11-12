/**
 * A178：WorkBuddy 鉴权状态语义闸门。
 *
 * 目标（对应真机截图的三处矛盾）：
 * 1. initialize 超时不能被显示成「未登录」；
 * 2. 未登录 / 凭据无效 / 探测超时 / 探测失败 四态文案互不混淆；
 * 3. 「重新检测」必须走单 Agent 探测；
 * 4. 「可填 API Key」的能力位与真实入口同源，不能两处硬编码互相打脸。
 *
 * 不联网、不起 CLI：SDK 的超时/重试用分类函数 + 源码契约断言覆盖；
 * UI 用 react-dom/server 渲染真实组件。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentDetailSections } from '../src/components/AgentDetailSections';
import { agentStatusViewOf, type RegisteredAgent } from '../src/types';

const gateDataDir = path.join(os.tmpdir(), 'opc-a178-gate');
process.env.OPC_DATA_DIR = gateDataDir;

const { classifySdkProbeFailure, isInitializeTimeout } = await import(
  '../server/agents/adapters/sdk.js'
);
const { findDef } = await import('../server/agents/definitions.js');
const { credentialSpecOf, getCredential, listCredentials } = await import(
  '../server/agent-credentials.js'
);

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

function agentWith(status: RegisteredAgent['status'], extra: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'workbuddy',
    name: 'WorkBuddy',
    kind: 'sdk',
    capabilities: ['chat'],
    eventCapabilities: [],
    skills: [],
    familyPeers: [],
    install: { method: 'key', requires: 'none', note: '', checkedAt: '' },
    status,
    installHint: '',
    ...extra,
  } as RegisteredAgent;
}

function render(agent: RegisteredAgent): string {
  return renderToStaticMarkup(
    createElement(AgentDetailSections, { agent, onReprobe: () => {} } as any)
  );
}

async function main() {
  console.log('A178 WorkBuddy 鉴权语义闸门\n');

  console.log('1) SDK 探测失败分类：initialize 超时 ≠ 未登录');

  await check('Request timeout: initialize → timeout', () => {
    assert.equal(classifySdkProbeFailure('Request timeout: initialize'), 'timeout');
    assert.equal(isInitializeTimeout('Request timeout: initialize'), true);
  });

  await check('显式 initialize 超时描述 → timeout', () => {
    assert.equal(isInitializeTimeout('initialize timed out'), true);
    assert.equal(classifySdkProbeFailure('Request timeout: initialize (60000ms)'), 'timeout');
  });

  await check('401 / invalid key / token expired → credential-invalid', () => {
    for (const msg of [
      '401 Unauthorized',
      '403 Forbidden',
      'invalid api key',
      'token expired',
      '凭据无效',
    ]) {
      assert.equal(classifySdkProbeFailure(msg), 'credential-invalid', msg);
    }
  });

  await check('其它异常 → probe-failed', () => {
    assert.equal(classifySdkProbeFailure('EACCES: permission denied'), 'probe-failed');
    assert.equal(classifySdkProbeFailure('boom'), 'probe-failed');
  });

  await check('SDK 适配器源码：initialize 超时自动重试一次，且登录等待被压到 8 秒', () => {
    const src = readFileSync(path.join(process.cwd(), 'server/agents/adapters/sdk.ts'), 'utf8');
    assert.match(src, /const SDK_LOGIN_WAIT_MS = 8_000/);
    assert.match(src, /timeout:\s*SDK_LOGIN_WAIT_MS/);
    assert.match(src, /isInitializeTimeout\(firstMessage\)/, '必须只对 initialize 超时重试');
    assert.equal(
      (src.match(/authenticateOnce\(\)/g) || []).length >= 2,
      true,
      '必须有第二次 authenticateOnce 调用（重试一次）'
    );
    assert.ok(!src.includes('鉴权检查失败'), '旧文案「鉴权检查失败」不得再出现');
  });

  console.log('2) 四态文案：超时不得显示成未登录');

  await check('probeState=timeout 时状态词是「探测超时」', () => {
    const view = agentStatusViewOf(agentWith({
      availability: 'unknown',
      installed: true,
      message: 'Request timeout: initialize',
      probeState: 'timeout',
      probedAt: '',
    }));
    assert.equal(view.label, '探测超时');
    assert.notEqual(view.label, '未登录');
  });

  await check('四个状态词互不相同', () => {
    const login = agentStatusViewOf(agentWith({
      availability: 'needs-auth',
      installed: true,
      message: '未登录',
      probedAt: '',
    })).label;
    const invalid = agentStatusViewOf(agentWith({
      availability: 'needs-auth',
      installed: true,
      message: '凭据无效',
      probeState: 'credential-invalid',
      probedAt: '',
    })).label;
    const timeout = agentStatusViewOf(agentWith({
      availability: 'unknown',
      installed: true,
      message: 'Request timeout: initialize',
      probeState: 'timeout',
      probedAt: '',
    })).label;
    const probeFailed = agentStatusViewOf(agentWith({
      availability: 'needs-auth',
      installed: true,
      message: '探测失败',
      probeState: 'probe-failed',
      probedAt: '',
    })).label;
    assert.deepEqual(new Set([login, invalid, timeout, probeFailed]).size, 4);
  });

  await check('详情页状态行同时显示状态词与原始消息（超时不会被消息盖成未登录）', () => {
    const html = render(agentWith({
      availability: 'unknown',
      installed: true,
      message: '鉴权检查失败: Request timeout: initialize',
      probeState: 'timeout',
      probedAt: '',
    }));
    assert.match(html, /探测超时 · 鉴权检查失败: Request timeout: initialize/);
    assert.ok(!/>未登录</.test(html), '超时态不得出现「未登录」状态词');
  });

  console.log('3) 重新检测走单 Agent 探测');

  await check('详情页 / 安装卡 / hook / 路由四段都只传一个 agentId', () => {
    const root = process.cwd();
    const sections = readFileSync(path.join(root, 'src/components/AgentDetailSections.tsx'), 'utf8');
    const card = readFileSync(path.join(root, 'src/components/InstallCard.tsx'), 'utf8');
    const hook = readFileSync(path.join(root, 'src/hooks/useAgentRegistry.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/agentProbe.ts'), 'utf8');
    const server = readFileSync(path.join(root, 'server/index.ts'), 'utf8');

    assert.match(sections, /onReprobe\(agent\.id\)/, '详情页重新探测必须带当前 agentId');
    assert.match(card, /onReprobe\?\.\(agent\.id\)/, '安装卡重新检测必须带当前 agentId');
    // 单探测的 HTTP 调用落在协调器里（hook 只把 agentId 透传过去）
    assert.match(client, /\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}\/probe/);
    assert.match(hook, /singleProbeRunner\(agentId\)/);
    assert.ok(
      !/const probeOne[\s\S]{0,200}\/api\/agents\/probe/.test(hook),
      'probeOne 不得走全量探测接口'
    );
    assert.match(server, /app\.post\("\/api\/agents\/:agentId\/probe"/);
    assert.ok(!sections.includes('onClick={onReprobe}'), '不得再出现无参的全量探测按钮');
  });

  console.log('4) 文案与能力同源：应用内可填 Key 的能力位 = 真实入口');

  await check('WorkBuddy 定义了 credential，且 keyEnv 与 SDK 探测读的环境变量一致', () => {
    const def = findDef('workbuddy');
    assert.ok(def, '找不到 workbuddy 定义');
    assert.deepEqual(def!.credential?.keyEnv, ['CODEBUDDY_API_KEY']);
    const sdk = readFileSync(path.join(process.cwd(), 'server/agents/adapters/sdk.ts'), 'utf8');
    assert.match(sdk, /process\.env\.CODEBUDDY_API_KEY/, '探测与凭据必须是同一个环境变量');
    assert.ok(credentialSpecOf('workbuddy'), '凭据规格必须可被服务端查到');
    assert.ok(
      listCredentials().some(v => v.agentId === 'workbuddy'),
      'WorkBuddy 必须出现在「可应用内配置凭据」列表里'
    );
    assert.ok(getCredential('workbuddy'), '凭据视图不能为空，否则编辑器会显示「不支持」');
  });

  await check('「获取」区文案不再承诺不存在的能力，并写明真实登录路径', () => {
    const def = findDef('workbuddy');
    const hint = def!.descriptor.installHint ?? '';
    const note = def!.descriptor.install?.note ?? '';
    assert.match(hint, /~\/\.workbuddy/);
    assert.match(hint, /CODEBUDDY_API_KEY/);
    assert.match(note, /~\/\.workbuddy/, '「获取」区（install.note）必须写明真实登录态路径');
    assert.match(note, /CODEBUDDY_API_KEY/, '「获取」区必须写明 Key 的真实字段名');
    assert.ok(!/在应用内登录/.test(hint + note), '不得再写「在应用内登录」这种空话');
    assert.equal(typeof hint, 'string');
    const descriptors = readFileSync(path.join(process.cwd(), 'server/agents/definitions.ts'), 'utf8');
    assert.ok(!descriptors.includes('在应用内登录 WorkBuddy 账号即可'), '旧文案必须删除');
    assert.match(descriptors, /先在 WorkBuddy 桌面客户端登录/);
  });

  await check('凭据编辑器入口与能力位使用同一份服务端数据', () => {
    const editor = readFileSync(path.join(process.cwd(), 'src/components/AgentCredentialEditor.tsx'), 'utf8');
    assert.match(editor, /fetch\('\/api\/agent-credentials'\)/);
    /* 文案已经迁进 i18n（A28 之后设置页统一走 t()），源码里不再有中文字面量。
       钉「组件真的引用这个键」+「键在中文资源里真的有这句」两件事，而不是
       钉实现字面量：只钉前者时把整个键删掉也能绿，只钉后者时组件不引用也绿。 */
    assert.match(editor, /settings\.credential\.noInAppEntry/,
      '不支持时的兜底文案由组件通过 i18n 键引用（用于真正不支持的 Agent）');
    const zh = readFileSync(path.join(process.cwd(), 'src/i18n/zh.ts'), 'utf8');
    assert.match(zh, /'settings\.credential\.noInAppEntry':\s*'该 Agent 不支持应用内填写凭据/,
      '中文资源里该兜底文案必须仍然存在');
    const sections = readFileSync(path.join(process.cwd(), 'src/components/AgentDetailSections.tsx'), 'utf8');
    assert.match(sections, /data-agent-credential-inline/);
    assert.match(sections, /isKeyOnly/);
  });

  console.log(`\nA178 结果：通过 ${passed}，失败 ${failed}`);
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
