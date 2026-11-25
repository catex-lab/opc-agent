/**
 * Agent 详情页状态文案 token 闸门（2026-11-25）。
 *
 * 背景：每个适配器原来把「结论 + 限制 + 文件时间」拼成一句 message，
 * 详情页原样显示 —— WorkBuddy 露出 keyblob 时间、ACP 露出「凭据未校验」，
 * 换个 Agent 又冒出新长句。改造后收成唯一出口 `src/agentStatusCopy.ts`：
 * 主行只有结论，解释性内容只在「没有真实检测结论」时作为次级提示出现。
 *
 * 覆盖：
 *   [1] 纯函数：statusSummary/statusDetail 优先；无新字段时按旧的 message 拆句，
 *       长解释不会渗进主行。
 *   [2] 真实检测通过（lastCanary.state === 'ok'）=> 探测期的未校验 / 文件时间一律收起。
 *   [3] 未做真实检测 => 状态词为「未验证」且次级提示为「仅供参考」，不冒充在线。
 *   [4] 各适配器都填了新字段：sdk / acp / http / registry（探测超时）/ claude / codex。
 *       —— 新 Agent 只要走这套契约，详情页就不会再各拼各的。
 *   [5] 详情页：状态行读 token 层、接入方式下面不再挂 installHint 灰色散文、
 *       状态词仍在第一位（A177/A178 的判据不能丢）。
 *
 * 反向探针（硬要求）：
 *   `node --import tsx scripts/verify-agent-status-copy.ts --probe no-summary`
 *   改走旧 message 直出（即退回改造前的行为），[1]/[2] 必须变红。
 *
 * 运行：`npm run verify:agent-status-copy`（已挂 verify:ui 链尾）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStatusCopy } from '../src/agentStatusCopy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = process.argv.includes('--probe')
  ? process.argv[process.argv.indexOf('--probe') + 1]
  : '';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, desc: string, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${desc}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(desc);
    console.log(`  ✗ ${desc}${detail ? ` —— ${detail}` : ''}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

type StatusLike = Parameters<typeof agentStatusCopy>[0]['status'];

function copyOf(status: StatusLike) {
  const agent = { kind: 'acp' as const, status };
  if (PROBE === 'no-summary') {
    // 反向探针：无视 token 字段，直接按旧行为把 message 当主行。
    return { primary: status.message ?? '', detail: undefined as string | undefined };
  }
  return agentStatusCopy(agent);
}

// ============= [1] 纯函数：结论 / 说明分层 =============
section('[1] 结论与说明必须分层');
{
  const c = copyOf({
    availability: 'ready',
    installed: true,
    message: '检测到本地登录态（未校验）：catex（keyblob 最后更新 2026-11-09 10:38）',
    statusSummary: '检测到本地登录态：catex',
    statusDetail: '未校验；keyblob 文件时间 2026-11-09 10:38（仅供参考）',
  });
  ok(c.primary === '未验证 · 检测到本地登录态：catex', '主行 = 状态词 + 结论', c.primary);
  ok(!/keyblob/.test(c.primary), '主行不许出现 keyblob 这类文件时间');
  ok(!!c.detail && /未校验/.test(c.detail), '文件时间/未校验降级到次级提示', c.detail ?? '(无)');
  ok(!!c.detail && /keyblob 文件时间/.test(c.detail), '文件时间只出现在次级提示里');

  const legacy = copyOf({
    availability: 'ready',
    installed: true,
    lastCanary: { state: 'ok', at: '2026-11-25T10:19:00.000Z' } as StatusLike['lastCanary'],
    message: '已通过环境变量配置凭据（未校验）',
  });
  ok(
    legacy.primary === '在线 · 已通过环境变量配置凭据',
    '没有新字段时按旧 message 拆句，结论仍干净',
    legacy.primary
  );
  ok(legacy.detail === undefined, '真实检测已通过 => 未校验提示收起', legacy.detail ?? '(已收起)');
}

// ============= [2] 真实检测通过后不再挂陈旧提示 =============
section('[2] 真实检测通过后不显示陈旧提示');
{
  const c = copyOf({
    availability: 'ready',
    installed: true,
    lastCanary: { state: 'ok', at: '2026-11-25T10:19:00.000Z' } as StatusLike['lastCanary'],
    message: 'ACP 握手成功（凭据未校验；会话创建未验证）：DeepSeek Harness v1.2.3',
    statusSummary: 'ACP 握手成功：DeepSeek Harness v1.2.3',
    statusDetail: '凭据未校验；会话创建未验证',
  });
  ok(c.primary === '在线 · ACP 握手成功：DeepSeek Harness v1.2.3', '主行只留结论', c.primary);
  ok(c.detail === undefined, '检测通过后「凭据未校验」不再冒充事实', c.detail ?? '(已收起)');

  // 失败态不能被实时状态掩盖：超时/未装这类结论必须原样出现。
  const timeout = copyOf({
    availability: 'unknown',
    installed: false,
    message: '探测超时：已等待 60 秒仍未返回',
    statusSummary: '探测超时',
    statusDetail: '已等待 60 秒仍未返回',
    probeState: 'timeout',
  });
  ok(/^探测超时/.test(timeout.primary), 'A177/A178：状态词仍在第一位', timeout.primary);
  ok(timeout.detail === '已等待 60 秒仍未返回', '等待秒数降到次级提示', timeout.detail ?? '(无)');
}

// ============= [3] 未做真实检测 => 未验证 + 最小提示 =============
section('[3] 未做真实检测时不许冒充在线');
{
  const c = copyOf({
    availability: 'ready',
    installed: true,
    message: '检测到本地登录态（未校验）',
    statusSummary: '检测到本地登录态',
    statusDetail: '未校验',
  });
  ok(/^未验证/.test(c.primary), '状态词降为「未验证」', c.primary);
  ok(!!c.detail && /仅供参考/.test(c.detail), '次级提示说明「仅供参考」', c.detail ?? '(无)');
}

// ============= [4] 各适配器都填 token 字段 =============
section('[4] 适配器侧统一填充 statusSummary / statusDetail');
{
  const files = [
    'server/agents/adapters/sdk.ts',
    'server/agents/adapters/acp.ts',
    'server/agents/adapters/http.ts',
    'server/agents/adapters/claude-sdk.ts',
    'server/agents/adapters/codex-sdk.ts',
    'server/agents/registry.ts',
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    ok(/statusSummary:/.test(src), `${rel} 填了 statusSummary`);
  }
  // 旧的拼接长句不许再回潮到 message（WorkBuddy 的 keyblob 括号是最典型的一处）。
  const sdk = readFileSync(path.join(ROOT, 'server/agents/adapters/sdk.ts'), 'utf8');
  ok(
    !/keyblob 最后更新 \$\{/.test(sdk) || /statusDetail/.test(sdk),
    'keyblob 时间走 statusDetail，不再拼进结论'
  );
}

// ============= [5] 详情页渲染契约 =============
section('[5] 详情页按 token 层渲染');
{
  const src = readFileSync(
    path.join(ROOT, 'src/components/AgentDetailSections.tsx'),
    'utf8'
  );
  ok(/agentStatusCopy\(agent\)/.test(src), '状态行走 agentStatusCopy 单出口');
  ok(/data-agent-status-detail/.test(src), '次级提示带稳定锚点（闸门可定位）');
  ok(
    !/agent\.installHint && !showInstallCard/.test(src),
    '接入方式下面不再挂 installHint 灰色散文'
  );
  ok(/data-agent-unverified/.test(src), '未验证状态带锚点（D1-1 判据可复用）');

  // 主行必须还是 statusCopy.primary，且状态词由 token 层保证在第一位。
  const statusRow = src.slice(src.indexOf('label="状态"'), src.indexOf('label="状态"') + 900);
  ok(/statusCopy\.primary/.test(statusRow), '状态主行取 primary');
}

console.log(
  `\n${failures.length === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failures.length} 失败`
);
if (failures.length) {
  console.log(failures.map(f => ` - ${f}`).join('\n'));
  process.exit(1);
}
