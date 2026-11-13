/**
 * A217 闸门：SDK 发送路径的「冷启动恢复 / 零产出令牌作废 / 自定义模型降级」。
 *
 * ## 钉的是什么
 *
 * 2026-11-13 真机事故的第二、三段：自定义模型首轮 120s 零模型请求，A214
 * 护栏杀进程后，用户每次重发都冷启动新 CLI，稳定卡满 60s
 * `Request timeout: initialize`；换回内置 `hy4free` 也一样。原因是 A178 的
 * initialize 补偿只写在 `probe()` 里，发送路径完全没有；而 A214 只做
 * `dropEntry()`，半空 `sdk_session_id` 还留在库里，下一轮拿空转录去 resume。
 *
 * 修法分三层，本闸门逐层钉住：
 *   1. 纯函数：错误分类优先级、唯一安全重试窗口、两类恢复决策、如实告知；
 *   2. 接线：sdk.ts 的四个失败出口都过 `recoverOrReport()`、两条路径都挂
 *      `fallbackModel`、护栏超时走 `terminateStalledEntry()` 完整回收；
 *   3. 会话状态：零产出时发 `init.invalidateResumeToken` 控制事件，
 *      /api/chat 只清「本轮写过」的令牌，群聊路径跳过控制事件。
 *
 * ## 为什么必须有反向探针
 *
 * 这三条都是「改对了不会报错、改漏了也不会报错」的类型。尤其「服务端清令牌」
 * 少了之后，界面当下完全正常，只有**下一条消息**才炸 —— 单看任何一帧都是绿的。
 * 所以三个探针分别退回「不重试 / 不清令牌 / 不挂兜底模型」，要求对应判据真红、
 * 其余判据保持原值。
 *
 * 运行：
 *   npx tsx scripts/verify-a217-turn-recovery.ts
 *   npx tsx scripts/verify-a217-turn-recovery.ts --probe=no-retry
 *   npx tsx scripts/verify-a217-turn-recovery.ts --probe=no-invalidate
 *   npx tsx scripts/verify-a217-turn-recovery.ts --probe=no-fallback
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_TURN_RECOVERY_ATTEMPTS,
  classifySdkFailure,
  failureAdvice,
  isCustomModelId,
  planTurnRecovery,
  resolveFallbackModel,
} from '../server/agents/adapters/turnRecovery.js';
import { firstTokenTimeoutMessage } from '../server/agents/adapters/firstTokenGuard.js';
import { SDK_DEFAULT_MODEL } from '../server/model-routing.js';

const ARGS = process.argv.slice(2);
const PROBE = ARGS.find(a => a.startsWith('--probe='))?.slice(8) ?? null;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, name: string, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}
function eq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}
function group(title: string) { console.log(`\n── ${title} ──`); }

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 源码契约专用：剥块注释/行注释，避免注释里的字面量造成假绿 */
function stripComments(s: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of s.replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; out.push(''); continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; out.push(''); continue; }
    if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }
    const cut = raw.indexOf('//');
    out.push(cut >= 0 ? raw.slice(0, cut) : raw);
  }
  return out.join('\n');
}
const code = (rel: string) => stripComments(read(rel));
const hasLine = (src: string, re: RegExp) => src.split('\n').some(l => re.test(l));

// ═══════════════════════ [1] 错误分类 ═══════════════════════
group('1. 错误分类：控制层超时必须先于泛化 timeout');
{
  eq(classifySdkFailure('Request timeout: initialize'), 'initialize-timeout',
    '★ 真机错误文本 → initialize 冷启动超时');
  eq(classifySdkFailure('initialize 握手超时'), 'initialize-timeout', '中文 initialize 超时');
  eq(classifySdkFailure(firstTokenTimeoutMessage(120_000)), 'first-token-timeout',
    '★ A214 护栏文案 → 首字超时（不被 network 的 /超时/ 吃掉）');
  eq(classifySdkFailure('first_token timeout'), 'first-token-timeout', '英文首字超时');
  eq(classifySdkFailure('401 Unauthorized'), 'auth', '401 → 认证');
  eq(classifySdkFailure('custom_model_auth failed'), 'auth', '自定义模型凭据失效');
  eq(classifySdkFailure('429 rate limit / 额度不足'), 'quota', '限流 → 额度');
  eq(classifySdkFailure('errors_info.category=empty_model_response'), 'empty-model-response', '空响应');
  eq(classifySdkFailure('model_service unavailable'), 'model-service', '模型服务异常');
  eq(classifySdkFailure('ECONNRESET / 网络不可达'), 'network', '网络');
  eq(classifySdkFailure('cancelled by user'), 'cancelled', '取消');
  eq(classifySdkFailure('some weird internal panic'), 'other', '未识别 → other');
  // 否定式配肯定式：whole-function 恒返回 'other' 也会让上面几条变红，
  // 但下面这条会一起红 —— 证明分类不是「一律兜底」。
  ok(classifySdkFailure('Request timeout: initialize') !== 'other' &&
     classifySdkFailure('ECONNRESET') !== 'other',
    '肯定式：至少两类真的被识别（不是恒 other）');
  ok(failureAdvice('auth').includes('登录') && failureAdvice('other') === '',
    '建议只对识别出的类别给，other 不硬凑文案');
  ok(!failureAdvice('initialize-timeout').includes('已自动重建'),
    '★ initialize 建议不撒谎：report 路径下并没有真的重建过');
}

// ═══════════════════════ [2] 自定义模型 / 兜底 ═══════════════════════
group('2. 自定义模型识别与兜底模型');
{
  ok(isCustomModelId('custom-local:sensenova-6.8-flash-lite'),
    '★ 官方 SDK 的 custom-local: 前缀被认出（真机模型）');
  ok(isCustomModelId('custom:foo'), '兼容 custom: 前缀');
  ok(!isCustomModelId('hy4free') && !isCustomModelId('default-model') && !isCustomModelId(''),
    '内置模型 / 空值不算自定义模型');
  eq(resolveFallbackModel('custom-local:foo'), SDK_DEFAULT_MODEL,
    '★ 兜底用 SDK 自己声明的 Auto 别名，不硬编码具体型号');
  delete process.env.OPC_SDK_FALLBACK_MODEL;
  eq(resolveFallbackModel('hy4free'), SDK_DEFAULT_MODEL, '内置模型也有兜底值');
  eq(resolveFallbackModel(SDK_DEFAULT_MODEL), undefined,
    '★ 兜底 === 主模型时返回 undefined（SDK 会抛「不能相同」）');
  process.env.OPC_SDK_FALLBACK_MODEL = 'off';
  eq(resolveFallbackModel('custom-local:foo'), undefined, '★ off 可禁用降级');
  process.env.OPC_SDK_FALLBACK_MODEL = 'claude-sonnet';
  eq(resolveFallbackModel('custom-local:foo'), 'claude-sonnet', '环境覆盖生效');
  delete process.env.OPC_SDK_FALLBACK_MODEL;
  eq(resolveFallbackModel('custom-local:foo'), SDK_DEFAULT_MODEL, '删掉覆盖后回落默认');
}

// ═══════════════════════ [3] 恢复决策 ═══════════════════════
group('3. 唯一安全重试窗口');
{
  eq(MAX_TURN_RECOVERY_ATTEMPTS, 1, '★ 最多自动恢复一次');
  const base = { firstTokenSeen: false, attempt: 0, hasCli: true, guardSeconds: 120 };

  const init = planTurnRecovery({ ...base, category: 'initialize-timeout', model: 'hy4free' });
  eq(init.action, 'retry-same-model', '★ initialize 超时 → 同模型重建 CLI');
  eq(init.model, 'hy4free', '不换模型：问题在握手，与选哪个模型无关');

  const custom = planTurnRecovery({
    ...base, category: 'first-token-timeout', model: 'custom-local:sensenova-6.8-flash-lite',
    fallbackModel: SDK_DEFAULT_MODEL,
  });
  eq(custom.action, 'retry-fallback-model', '★ 自定义模型首字超时 → 换内置兜底重建');
  eq(custom.model, SDK_DEFAULT_MODEL, '重试用内置模型');
  ok(custom.notice?.includes('已自动改用内置模型') && custom.notice?.includes('120 秒'),
    '★ 降级必须如实告知（含等待时长），不静默切模型');
  ok(custom.notice?.includes('不会重复执行指令'), '告知「本轮零产出、不会重复执行」');

  const builtin = planTurnRecovery({
    ...base, category: 'first-token-timeout', model: 'hy4free', fallbackModel: SDK_DEFAULT_MODEL,
  });
  eq(builtin.action, 'report', '★ 内置模型首字超时不自动重试（不再白等 120s）');

  eq(planTurnRecovery({ ...base, category: 'auth' }).action, 'report', '认证失败不重试');
  eq(planTurnRecovery({ ...base, category: 'network' }).action, 'report', '普通网络错不重试');
  eq(planTurnRecovery({ ...base, category: 'cancelled' }).action, 'report', '取消不重试');

  // 四条硬规矩
  eq(planTurnRecovery({
    ...base, firstTokenSeen: true, category: 'initialize-timeout', model: 'hy4free',
  }).action, 'report', '★ 已产出内容 ⇒ 永不重放（防双重副作用）');
  eq(planTurnRecovery({
    ...base, attempt: 1, category: 'initialize-timeout', model: 'hy4free',
  }).action, 'report', '★ 已恢复过一次 ⇒ 不再重试（防死循环）');
  eq(planTurnRecovery({
    ...base, hasCli: false, category: 'initialize-timeout', model: 'hy4free',
  }).action, 'report', '★ 没有 CLI ⇒ 不重试');
  eq(planTurnRecovery({
    ...base, category: 'first-token-timeout', model: 'custom-local:foo',
    fallbackModel: undefined,
  }).action, 'report', '没有兜底模型 ⇒ 不重试（不能静默用同一个模型）');
  eq(planTurnRecovery({
    ...base, category: 'first-token-timeout', model: 'custom-local:foo',
    fallbackModel: 'custom-local:foo',
  }).action, 'report', '兜底与主模型相同 ⇒ 不重试');
}

group('4. 真机事故的完整决策序列');
{
  // 第 1 轮：自定义模型首字超时 → 自动降级
  const first = planTurnRecovery({
    category: classifySdkFailure(firstTokenTimeoutMessage(120_000)),
    firstTokenSeen: false, attempt: 0, hasCli: true,
    model: 'custom-local:sensenova-6.8-flash-lite',
    fallbackModel: resolveFallbackModel('custom-local:sensenova-6.8-flash-lite'),
    guardSeconds: 120,
  });
  eq(first.action, 'retry-fallback-model', '第 1 次失败：降级到内置模型');
  // 第 2 轮：重试仍卡 initialize → 如实报错，不再有第 3 轮
  const second = planTurnRecovery({
    category: classifySdkFailure('Request timeout: initialize'),
    firstTokenSeen: false, attempt: 1, hasCli: true,
    model: first.model, fallbackModel: resolveFallbackModel(first.model),
  });
  eq(second.action, 'report', '★ 第 2 次失败：收敛成报错，不会无限冷启动');
  ok(second.advice.length > 0, '报错时给出可执行建议');
  // 换一条时间线：内置模型第一次就卡 initialize → 同模型重试一次
  const alt = planTurnRecovery({
    category: classifySdkFailure('Request timeout: initialize'),
    firstTokenSeen: false, attempt: 0, hasCli: true, model: 'hy4free',
  });
  eq(alt.action, 'retry-same-model', '★ 真机 05:27 的 initialize 失败有自动补偿');
}

// ═══════════════════════ [5] 源码契约 ═══════════════════════
group('5. 源码契约（剥注释 + 锚行首）');
/**
 * 全部判据收在一个函数里，反向探针用**同一套**判据对坏源码求值：
 * 被针对的那条必须红，其余必须原样 —— 否则「探针跑绿了」可能只是判据全恒绿。
 */
function srcContract(sdk: string, types: string, chat: string, runner: string) {
  return {
    import: hasLine(sdk, /from '\.\/turnRecovery\.js';/),
    classify: hasLine(sdk, /const category = classifySdkFailure\(message\);/),
    decision: hasLine(sdk, /const plan = planTurnRecovery\(\{/),
    recoveryCalls: (sdk.match(/await this\.recoverOrReport\(/g) ?? []).length === 5,
    retryBounded: hasLine(sdk, /attempt \+ 1/),
    attemptParam: (sdk.match(/attempt = 0/g) ?? []).length === 2,
    zeroWindow: (sdk.match(/let firstTokenSeen = false;/g) ?? []).length === 2,
    seenAfterDisarm: (sdk.match(/guard\.disarm\(\);\s*\n\s*firstTokenSeen = true;/g) ?? []).length === 2,
    terminate: (sdk.match(/this\.terminateStalledEntry\(/g) ?? []).length === 2,
    fallback: (sdk.match(/\.\.\.\(fallback \? \{ fallbackModel: fallback \} : \{\}\)/g) ?? []).length === 2,
    customOnly: hasLine(sdk, /isCustomModelId\(ctx\.model\) \? resolveFallbackModel\(ctx\.model\) : undefined/),
    notice: hasLine(sdk, /if \(plan\.notice\) queue\.push\(\{ type: 'note', text: plan\.notice, level: 'warn' \}\);/),
    invalidateEvent: hasLine(types, /invalidateResumeToken\?: boolean;/),
    invalidatePush: hasLine(sdk, /invalidateResumeToken: true,/),
    chatHandler: hasLine(chat, /if \(ev\.type === 'init' && ev\.invalidateResumeToken\) \{/),
    onlyThisTurn: /ev\.type === 'init' && ev\.invalidateResumeToken[\s\S]{0,320}if \(newResumeToken\)/.test(chat),
    chatClear: /ev\.type === 'init' && ev\.invalidateResumeToken[\s\S]{0,420}db\.updateSession\(session\.id, \{ sdk_session_id: null \}\)/.test(chat),
    chatContinue: /ev\.type === 'init' && ev\.invalidateResumeToken[\s\S]{0,420}\n\s*continue;/.test(chat),
    runnerSkip: hasLine(runner, /if \(ev\.type === 'init' && ev\.invalidateResumeToken\) continue;/),
  };
}
type Contract = ReturnType<typeof srcContract>;
const SRC = code('server/agents/adapters/sdk.ts');
const TYPES = code('server/agents/types.ts');
const CHAT = code('server/index.ts');
const RUNNER = code('server/turn-runner.ts');
const good = srcContract(SRC, TYPES, CHAT, RUNNER);
{
  const labels: Record<keyof Contract, string> = {
    import: 'sdk.ts 引入 turnRecovery 决策层',
    classify: '失败出口先分类',
    decision: '由纯函数给恢复决策（不在适配器里另写一套）',
    recoveryCalls: '★ 五个失败出口（池 send/首事件/catch + one-shot 超时/catch）都过恢复层',
    retryBounded: '★ 递归带 attempt+1（有界）',
    attemptParam: '池路径与 one-shot 路径各带 attempt 参数',
    zeroWindow: '两条路径都跟踪 firstTokenSeen',
    seenAfterDisarm: '★ 撤护栏的那一刻才标记「已有产出」',
    terminate: '★ 护栏超时走 interrupt + 归还 iterator + drop 的完整回收',
    fallback: '★ 两条路径都给 SDK 挂 --fallback-model',
    customOnly: '兜底只对自定义模型挂',
    notice: '★ 降级说明走 note，不冒充助手正文',
    invalidateEvent: 'AgentEvent.init 声明作废控制位',
    invalidatePush: '★ 零产出时适配器真的发作废事件',
    chatHandler: '/api/chat 认这个控制事件',
    onlyThisTurn: '★ 只清本轮写下的令牌（不误删上一轮上下文）',
    chatClear: '★ 服务端真的把半空 sdk_session_id 清成 NULL',
    chatContinue: '控制事件不进投影器',
    runnerSkip: '群聊/工作流路径跳过控制事件',
  };
  for (const k of Object.keys(good) as Array<keyof Contract>) ok(good[k], labels[k]);
  // 否定式配肯定式：如果 srcContract 恒 true，上面全绿但下面这条会红
  ok(Object.values(good).every(Boolean) && !srcContract('', '', '', '').recoveryCalls,
    '肯定式：空源码下判据确实会红（不是恒绿摆设）');
}

// ═══════════════════════ [6] 反向探针 ═══════════════════════
group('6. 反向探针');
if (PROBE) {
  const bad = (() => {
    switch (PROBE) {
      case 'no-retry':
        // 退回 A214 原样：四个失败出口直接报错，没有恢复层调用
        return srcContract(
          SRC.replace(/await this\.recoverOrReport\(/g, 'await this.reportOnlyStub('),
          TYPES, CHAT, RUNNER
        );
      case 'no-invalidate':
        // 退回「杀进程但留着半空令牌」：服务端不清库
        return srcContract(
          SRC, TYPES,
          CHAT.replace(/db\.updateSession\(session\.id, \{ sdk_session_id: null \}\);/g, 'void 0;'),
          RUNNER
        );
      case 'no-fallback':
        // 退回「没有 SDK 兜底模型」
        return srcContract(
          SRC.replace(/\.\.\.\(fallback \? \{ fallbackModel: fallback \} : \{\}\),/g, ''),
          TYPES, CHAT, RUNNER
        );
      default:
        console.log(`  ✗ 未知探针 ${PROBE}`);
        process.exit(2);
    }
  })();
  const target: Record<string, keyof Contract> = {
    'no-retry': 'recoveryCalls',
    'no-invalidate': 'chatClear',
    'no-fallback': 'fallback',
  };
  const hit = target[PROBE];
  ok(!bad[hit], `反向探针(${PROBE})：被针对的判据「${hit}」真的变红`);
  const others = (Object.keys(good) as Array<keyof Contract>).filter(k => k !== hit);
  ok(others.every(k => bad[k] === good[k]),
    `反向探针(${PROBE})：其余判据仍为原值（退化是局部的）`);
  ok(Object.values(bad).some(v => !v), `反向探针(${PROBE})：坏版本整体不是全绿`);
  // 探针本身反向计分：坏版本被判红才算探针有效
  if (failures.length === 0) console.log(`  ✓ 探针 ${PROBE} 有效`);
} else {
  console.log('  （未启用探针；可用 --probe=no-retry / no-invalidate / no-fallback）');
}

// ═══════════════════════ 汇总 ═══════════════════════
console.log(
  `\n${failures.length ? '✗' : '✓'} A217 SDK 轮次恢复：${pass}/${pass + fail} 通过` +
    `${PROBE ? `（探针 ${PROBE}）` : ''}`
);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
