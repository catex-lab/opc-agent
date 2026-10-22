/**
 * 模型目录验证脚本（A57）。
 *
 * 要守的是**用户报的那个 bug**：接入的 opencode 只显示 4 个写死的模型，
 * 官方菜单有几十个、还带「免费 / 付费」角标。所以这里不只测「函数算得对」，
 * 还要钉住三件容易再次漏掉的事：
 *
 *   1. **目录真的接进了调用链** —— 源码契约段直接读 registry / index / 前端，
 *      少一行接线就红。上一次的形态正是「目录模块写好了，但没人调用它」。
 *   2. **免费/付费不许猜** —— 价格字段缺失时必须不标角标，而不是默认「付费」。
 *   3. **动态模型必须能被路由采用** —— 否则菜单里能选、发出去被静默换成默认模型，
 *      那是一个看起来能用、实际没生效的假控件。
 *
 * 全离线：不打网络、不起 CLI 子进程、不碰真实数据库。
 * 运行：npx tsx scripts/verify-model-catalog.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseCliModelRefs,
  parseQoderModels,
  parseCodexModels,
  buildListOptions,
  isFreeModel,
  describeModel,
  buildModelOptions,
  mergeModelOptions,
  providerLabel,
  QODER_REASONING_LEVELS,
  type RawProviderModel,
} from '../server/agents/modelCatalog.js';
import { parseCredits, mapSdkModels } from '../server/agents/sdk-models.js';
import { OPENCODE_CATALOG_SNAPSHOT } from '../server/agents/opencodeCatalogSnapshot.js';
import { resolveModelForAgent, setCatalogModelLookup } from '../server/model-routing.js';
import { findDef } from '../server/agents/definitions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const failures: string[] = [];
const checks = { total: 0 };

function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── 1. CLI 输出解析：宁可少列，不可把报错当模型名 ─────────────────
{
  const stdout = [
    '\u001b[32mopencode/glm-5.3-flash-free\u001b[0m',
    '',
    '  zai/glm-4.7  ',
    'github-copilot/gpt-5.4',
    'Error: not logged in',
    'Reconnecting... waiting for network',
    'opencode/glm-5.3-flash-free', // 重复
    'no-slash-model',
    'trailing/',
    '/leading',
  ].join('\n');

  eq(
    parseCliModelRefs(stdout),
    [
      'opencode/glm-5.3-flash-free',
      'zai/glm-4.7',
      'github-copilot/gpt-5.4',
    ],
    '解析：只保留合法的 provider/model，去重、去色、丢掉报错行'
  );

  eq(parseCliModelRefs(''), [], '解析：空输出返回空数组');
  eq(
    parseCliModelRefs('opencode/a\nopencode/b'),
    ['opencode/a', 'opencode/b'],
    '解析：保持 CLI 给出的顺序'
  );
}

// ── 2. 免费 / 付费判定：拿不到价格就不标 ─────────────────────────
{
  eq(isFreeModel({ cost: { input: 0, output: 0 } }), true, '判定：input/output 都为 0 才算免费');
  eq(isFreeModel({ cost: { input: 0, output: 0.1 } }), false, '判定：只有 input 为 0 不算免费');
  eq(isFreeModel({ cost: { input: 0.6, output: 2.2 } }), false, '判定：有价格即付费');
  eq(isFreeModel({}), null, '判定：没有 cost 字段时返回 null（不猜）');
  eq(isFreeModel(undefined), null, '判定：条目缺失时返回 null（不猜）');

  const opts = buildModelOptions(
    ['x/unknown', 'x/free', 'x/paid'],
    {
      x: {
        free: { name: 'Free One', cost: { input: 0, output: 0 } },
        paid: { name: 'Paid One', cost: { input: 1, output: 2 } },
      },
    }
  );
  const unknown = opts.find(o => o.modelId === 'x/unknown');
  eq(unknown?.tag, undefined, '列表：元数据缺失的模型不标角标（而不是默认「付费」）');
  eq(unknown?.name, 'unknown', '列表：没有显示名时退回模型 id');
}

// ── 3. 第二行说明 ────────────────────────────────────────────────
{
  eq(
    describeModel({ cost: { input: 0, output: 0 }, limit: { context: 200000 }, modalities: { input: ['text'] }, reasoning: true }),
    '上下文 200K · 文本 · 支持推理',
    '说明：免费模型不带价格段（角标已写明免费）'
  );
  eq(
    describeModel({ cost: { input: 0.44819, output: 2.09153 }, limit: { context: 205000 } }),
    '$0.448/2.092/M · 上下文 205K',
    '说明：单价最多三位小数，不留一长串尾数'
  );
  eq(
    describeModel({ modalities: { input: ['pdf', 'image', 'text'] } }),
    '文本/图像/PDF',
    '说明：模态按固定顺序，不随数据顺序抖动'
  );
  eq(describeModel({}), undefined, '说明：什么元数据都没有时返回 undefined（不产出空串）');
}

// ── 4. 排序：provider 分组 + 免费在前 ────────────────────────────
{
  const providers: Record<string, Record<string, RawProviderModel>> = {
    zai: {
      'glm-4.7': { name: 'GLM-4.7', cost: { input: 0.6, output: 2.2 } },
      'glm-4.5-flash': { name: 'GLM-4.5 Flash', cost: { input: 0, output: 0 } },
    },
    opencode: {
      'glm-5.3-flash-free': { name: 'GLM-5.3-Flash Free', cost: { input: 0, output: 0 } },
      'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } },
    },
  };
  const opts = buildModelOptions(
    ['zai/glm-4.7', 'zai/glm-4.5-flash', 'opencode/glm-5.3-flash-free', 'opencode/big-pickle'],
    providers
  );
  eq(
    opts.map(o => o.modelId),
    ['opencode/big-pickle', 'opencode/glm-5.3-flash-free', 'zai/glm-4.5-flash', 'zai/glm-4.7'],
    '排序：OpenCode 组在前，组内免费在前，再按显示名'
  );
  eq(opts[0].providerName, 'OpenCode', '分组：provider 展示名');
  eq(providerLabel('github-copilot'), 'GitHub Copilot', '分组：常见 provider 的中文/官方展示名');
  eq(providerLabel('some-new-provider'), 'some-new-provider', '分组：不认识的 provider 用原始键，不编造名字');

  const deduped = buildModelOptions(['zai/glm-4.7', 'zai/glm-4.7'], providers);
  eq(deduped.length, 1, '排序：重复引用只保留一条');
}

// ── 5. 与静态白名单合并 ──────────────────────────────────────────
{
  const catalog = buildModelOptions(
    ['opencode/a', 'opencode/b'],
    { opencode: { a: { name: 'A' }, b: { name: 'B' } } }
  );
  eq(
    mergeModelOptions(['zai/glm-4.7', 'opencode/a'], catalog).map(m => m.modelId),
    ['zai/glm-4.7', 'opencode/a', 'opencode/b'],
    '合并：目录里没有的白名单项插到最前，其余保持目录顺序'
  );
  eq(
    mergeModelOptions(['opencode/a'], catalog).map(m => m.modelId),
    ['opencode/a', 'opencode/b'],
    '合并：白名单项已在目录里时不重复插入'
  );
}

// ── 6. 内置快照：断网兜底也不该是「4 个」 ────────────────────────
{
  const entries = Object.entries(OPENCODE_CATALOG_SNAPSHOT);
  ok(entries.length >= 100, '快照：应覆盖官方目录的全部模型', `实际 ${entries.length} 条`);
  const free = entries.filter(([, raw]) => isFreeModel(raw) === true);
  ok(free.length >= 30, '快照：应包含足够多的免费模型', `实际 ${free.length} 条`);

  const opts = buildModelOptions(
    entries.map(([id]) => `opencode/${id}`),
    { opencode: OPENCODE_CATALOG_SNAPSHOT }
  );
  ok(
    opts.every(o => o.tag === '免费' || o.tag === '付费'),
    '快照：每一条都能标出免费/付费（用户要的就是这个角标）'
  );
  ok(
    opts.every(o => !!o.description),
    '快照：每一条都有上下文/模态说明'
  );
  ok(
    opts.slice(0, free.length).every(o => o.tag === '免费'),
    '快照：免费模型排在付费模型前面'
  );
}

// ── 7. WorkBuddy（SDK）：raw 元数据 → 角标 / 说明 / 默认模型 ────────
{
  eq(parseCredits('x0.34 credits'), 0.34, 'SDK：倍率解析（带 credits 后缀）');
  eq(parseCredits('x0.00'), 0, 'SDK：倍率 0 视为免费');
  eq(parseCredits('x6.67'), 6.67, 'SDK：倍率无后缀也能解析');
  eq(parseCredits(''), null, 'SDK：空串 = 未标价（不猜）');
  eq(parseCredits(undefined), null, 'SDK：缺字段 = 未标价（不猜）');

  const { models, defaultModel } = mapSdkModels([
    {
      id: 'default-model', name: 'Auto', credits: '', isDefault: true,
      maxAllowedSize: 200000, descriptionZh: '优秀的编码模型，适合日常使用',
      supportsImages: true, supportsReasoning: false,
    },
    {
      id: 'hy3', name: 'Hy3', credits: 'x0.00', maxAllowedSize: 192000,
      descriptionZh: '混元思考模型', supportsReasoning: true,
    },
    {
      id: 'fast-model', name: 'Fast', credits: 'x0.34 credits', maxAllowedSize: 200000,
      descriptionZh: '响应快，适合简单任务',
    },
    { id: 'gone', name: 'Gone', credits: 'x1.00', disabled: true },
    { id: 'hy3', name: 'Hy3 重复', credits: 'x0.00' },
  ]);

  eq(defaultModel, 'default-model', 'SDK：默认模型取 isDefault，而不是平台常量');
  eq(
    models.map(m => m.modelId),
    ['default-model', 'hy3', 'fast-model'],
    'SDK：保持 SDK 顺序、去重、跳过 disabled'
  );
  eq(models[0].tag, undefined, 'SDK：credits 为空时不标角标（Auto 未标价）');
  eq(models[1].tag, '限时免费', 'SDK：credits 0 → 限时免费（对齐官方 "Free now"）');
  eq(models[2].tag, '付费', 'SDK：credits > 0 → 付费');
  eq(models[0].multiplier, undefined, 'SDK：未标价时没有倍率');
  eq(models[1].multiplier, '0.00x', 'SDK：倍率右对齐显示 0.00x（官方同款）');
  eq(models[2].multiplier, '0.34x', 'SDK：倍率右对齐显示 0.34x（不是美元）');
  eq(
    models[1].description,
    '混元思考模型 · 上下文 192K',
    'SDK：说明 = 中文简介 + 上下文（倍率单独右对齐，不再混进说明里）'
  );
  eq(models[0].name, 'Auto', 'SDK：显示名取 SDK 的 name');
  // 官方还有一档 "Pro Only"（如 GPT-6-Astra 6.67x）：SDK 的模型清单里**没有**
  // 任何套餐/权限字段（已逐条扫过 plan/tier/pro/access/locked），那是官方客户端
  // 按账号订阅状态贴的标。拿不到就不猜 —— 高倍率模型仍然只标「付费」。
  const high = mapSdkModels([{ id: 'gpt-6-astra', name: 'GPT-6-Astra', credits: 'x6.67' }]);
  eq(high.models[0].tag, '付费', 'SDK：高倍率模型仍标「付费」，不臆测成「Pro 专属」');
  eq(high.models[0].multiplier, '6.67x', 'SDK：高倍率也照实显示 6.67x');

  // 真实清单里有两条同名（`deepseek-v4.1-flash` 0.00x / `deepseek-v4.1-flash-sg` 0.03x），
  // 菜单里两行一样名字没法选。消歧只取 id 里**真实存在**的差异片段，不翻译、不推断。
  const dup = mapSdkModels([
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00' },
    { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', credits: 'x0.03' },
  ]);
  eq(dup.models[0].name, 'Deepseek-V4.1-Flash', 'SDK：重名时 id 无差异片段的那条保持原名');
  eq(dup.models[1].name, 'Deepseek-V4.1-Flash (sg)', 'SDK：重名用 id 差异片段消歧（不推断含义）');
  eq(dup.models[1].modelId, 'deepseek-v4.1-flash-sg', 'SDK：消歧只改显示名，modelId 原样');
  eq(dup.models[0].multiplier, '0.00x', 'SDK：消歧不影响倍率');
  const uniq = mapSdkModels([
    { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
    { id: 'fast-model', name: 'Fast', credits: 'x0.34' },
  ]);
  eq(uniq.models.map(m => m.name), ['Hy3', 'Fast'], 'SDK：不重名时显示名一个字都不动');
}

// ── 7b. Qoder / Codex：CLI 自己的枚举输出 ─────────────────────────
// 这两条是用户报「qoder 也是这种情况」之后补的。它们的共同点是：
// 有枚举命令，但**没有价格数据** → 只出清单与说明，不标免费/付费。
{
  // qoder `--list-models` 的真实输出（1.1.73 实测）
  const QODER_OUT = [
    'MODEL',
    'Qwen3.8-Flash',
    'DeepSeek-Flash',
    'sensenova-6.8-flash-lite (qoder-custom-efc0bc4d-c735-45db-b2a4-02…)',
    '',
  ].join('\n');

  const q = parseQoderModels(QODER_OUT);
  eq(q.map(m => m.id), [
    'Qwen3.8-Flash',
    'DeepSeek-Flash',
    'sensenova-6.8-flash-lite',
  ], 'Qoder：跳过表头 MODEL；自定义模型取括号前的名字（括号里是 provider，-m 不认）');
  eq(q[2].name, 'sensenova-6.8-flash-lite', 'Qoder：显示名 = 括号前的部分');
  eq(q[0].name, 'Qwen3.8-Flash', 'Qoder：裸名字直接当显示名');
  ok(
    !q.some(m => m.id.includes('qoder-custom')),
    'Qoder：绝不能把括号里的 provider id 当 modelId（实测 -m 会被静默换成 qfmodel）'
  );

  eq(
    parseQoderModels('error: not logged in\nModel is not available right now').length,
    0,
    'Qoder：带空格的报错文本不会被当成模型名'
  );
  eq(parseQoderModels('MODEL\n').length, 0, 'Qoder：只有表头 → 空列表');
  eq(
    parseQoderModels('Qwen3.8-Flash\nQwen3.8-Flash').length,
    1,
    'Qoder：重复行去重'
  );

  // codex `debug models` 的 JSON（截取真实条目，含一条 hide）
  const CODEX_JSON = JSON.stringify({
    models: [
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3, context_window: 272000, input_modalities: ['text', 'image'], description: 'Previous generation workhorse model.' },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, context_window: 272000, input_modalities: ['text', 'image'], description: 'Latest workhorse model.' },
      { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue', visibility: 'hide', priority: 11 },
    ],
  });
  const c = parseCodexModels(CODEX_JSON);
  eq(c.map(m => m.id), ['gpt-6.1-sol', 'gpt-6-sol'], 'Codex：只取 visibility=list，并按 priority 排序（不是字母序）');
  eq(
    c[0].description,
    '上下文 272K · 文本/图像 · Latest workhorse model.',
    'Codex：第二行 = 上下文 · 模态 · 官方描述（硬事实在前，弹层截断时先丢描述）'
  );
  eq(parseCodexModels('not json').length, 0, 'Codex：JSON 解析失败 → 空列表（不抛异常）');
  eq(parseCodexModels('{"models":[]}').length, 0, 'Codex：空目录 → 空列表');

  // 这两个源的列表拼装：保持来源顺序、不标角标
  const opts = buildListOptions(['b-model', 'a-model'], { 'b-model': { name: 'B', description: '说明' } });
  eq(opts.map(m => m.modelId), ['b-model', 'a-model'], '列表：保持来源顺序（那是它自己的推荐顺序）');
  eq(opts[0].name, 'B', '列表：显示名取 details');
  eq(opts[1].name, 'a-model', '列表：没有 details 时退回 id（不编造名字）');
  eq(opts[0].tag, undefined, '列表：没有价格数据 → 不标免费/付费');
  eq(opts[1].description, undefined, '列表：没有描述就不写第二行');
}

// ── 7c. 推理 / 思考强度档位（A62）─────────────────────────────────
// 输入形状全部取自实测：codex 的字段来自 `codex debug models` 的 JSON
// （本机 gpt-6-astra 有 6 档），qoder 的 8 个合法值来自 CLI 报错原文。
{
  // 1) codex：per-model 档位
  const withLevels = parseCodexModels(JSON.stringify({
    models: [{
      slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Quick answers with light reasoning.' },
        { effort: 'medium', description: 'Balances speed and depth.' },
        { effort: 'high', description: 'Deep reasoning for hard problems.' },
      ],
      default_reasoning_level: 'medium',
    }],
  }))[0];
  eq(withLevels.reasoning?.levels.map(l => l.value), ['low', 'medium', 'high'],
    'Codex：档位按 CLI 给的顺序透传，不排序（那是官方自己的顺序）');
  eq(withLevels.reasoning?.levels[1].label, '中',
    'Codex：中文标签来自官方文案表的同一套译法（低/中/高），不是我们翻译的');
  eq(withLevels.reasoning?.levels[0].description, 'Quick answers with light reasoning.',
    'Codex：官方对档位的说明原样带上');
  eq(withLevels.reasoning?.defaultLevel, 'medium', 'Codex：默认档取 CLI 自己声明的那个');

  // 没给档位的模型必须没有 reasoning —— 前端据此隐藏控件，绝不能有猜的值
  const noLevels = parseCodexModels(JSON.stringify({
    models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3 }],
  }))[0];
  eq(noLevels.reasoning, undefined,
    'Codex：模型没给 supported_reasoning_levels → reasoning 整个缺省（没有 = 不显示控件）');

  // 默认档声明了但不在 supported 列表里 → 宁可没有默认档，也不让前端预设一个
  // 「看起来设了、实际被 CLI 悄悄忽略」的值。
  const badDefault = parseCodexModels(JSON.stringify({
    models: [{
      slug: 'gpt-6-x', display_name: 'GPT-6-X', visibility: 'list', priority: 1,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      default_reasoning_level: 'ultra',
    }],
  }))[0];
  eq(badDefault.reasoning?.levels.map(l => l.value), ['low', 'high'],
    'Codex：default 与 supported 不一致时，档位表仍然只用 supported');
  eq(badDefault.reasoning?.defaultLevel, undefined,
    'Codex：声明的默认档不在 supported 里 → 不预设（假控件的另一种形态）');

  // 空 levels 数组与非法条目都不能产出一个空壳控件
  const emptyLevels = parseCodexModels(JSON.stringify({
    models: [{
      slug: 'gpt-6-y', display_name: 'GPT-6-Y', visibility: 'list', priority: 1,
      supported_reasoning_levels: [{ effort: '' }, null, { description: 'no effort' }],
      default_reasoning_level: 'low',
    }],
  }))[0];
  eq(emptyLevels.reasoning, undefined,
    'Codex：supported_reasoning_levels 里没有一条合法 effort → reasoning 缺省');

  // 未覆盖的 effort 值保留英文原文，不硬造中文
  const exotic = parseCodexModels(JSON.stringify({
    models: [{
      slug: 'gpt-6-z', display_name: 'GPT-6-Z', visibility: 'list', priority: 1,
      supported_reasoning_levels: [{ effort: 'banana' }],
    }],
  }))[0];
  eq(exotic.reasoning?.levels[0].label, 'banana',
    'Codex：没见过的 effort 值保留原文（编一个中文名比显示英文更糟）');

  // 2) qoder：全局一套 8 档，值域 = CLI 报错原文
  eq(QODER_REASONING_LEVELS.levels.map(l => l.value),
    ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    'Qoder：8 档合法值必须与 CLI 报错原文逐字一致（顺序也算）');
  eq(QODER_REASONING_LEVELS.defaultLevel, undefined,
    'Qoder：不设默认档（不传 --reasoning-effort 就是走 CLI 自己的默认）');
  eq(QODER_REASONING_LEVELS.levels.filter(l => !l.label).length, 0,
    'Qoder：每一档都要有展示名（空标签 = 下拉里出现一项空白）');
  // ultracode 在官方文案表里没有中文译名 → 保留原文；其余 7 档都该是官方中文标签
  eq(QODER_REASONING_LEVELS.levels.filter(l => l.value === l.label).map(l => l.value), ['ultracode'],
    'Qoder：只有官方没有译名的 ultracode 保留原文，其余必须用官方中文标签');
  eq(QODER_REASONING_LEVELS.levels.filter(l => l.value !== l.label).map(l => l.label),
    ['自动', '无', '低', '中', '高', '超高', '最大'],
    'Qoder：中文标签与官方文案表 modelSelector.runtimeLabel.* 逐字一致');

  // 3) 透传：buildListOptions 必须把 reasoning 带进 ModelOption
  const r = buildListOptions(['m-1'], {
    'm-1': { name: 'M-1', reasoning: { levels: [{ value: 'low', label: '低' }] } },
  });
  eq(r[0].reasoning?.levels.map(l => l.value), ['low'],
    '列表：reasoning 必须从 details 透传进 ModelOption（丢在这一环 = 前端永远没有控件）');
  eq(buildListOptions(['m-2'], {})[0].reasoning, undefined,
    '列表：details 没给档位 → ModelOption.reasoning 缺省');
}

// ── 8. 动态模型必须能被路由采用（否则就是假控件） ────────────────
{
  const oc = findDef('opencode')!;
  const dynamic = 'opencode/glm-5.3-flash-free';
  ok(!oc.models!.includes(dynamic), '路由前置：这个模型确实不在静态白名单里（否则本段没意义）');

  setCatalogModelLookup((agentId, modelId) => agentId === 'opencode' && modelId === dynamic);
  eq(
    resolveModelForAgent('opencode', dynamic),
    dynamic,
    '路由：目录里存在的模型应被采用（不能被静默换成默认模型）'
  );
  eq(
    resolveModelForAgent('opencode', 'gpt-5.4'),
    oc.defaultModel!,
    '路由：目录里也没有的模型仍然回退默认（不认识的照旧拦下）'
  );
  eq(
    resolveModelForAgent('opencode', 'claude-sonnet-4'),
    oc.defaultModel!,
    '路由：平台默认模型仍然被拦下（原修复不回退）'
  );

  // 目录未加载 / 查表未注册时 fail-closed：宁可回退默认，也不塞来路不明的模型
  setCatalogModelLookup(null);
  eq(
    resolveModelForAgent('opencode', dynamic),
    oc.defaultModel!,
    '路由：查表未注册时回退默认（fail-closed）'
  );

  // qoder / codex 没有静态白名单，模型名是裸的（`Qwen3.8-Flash` / `gpt-6-sol`）。
  // 这类 Agent 走「只拦平台默认模型」那条分支：请求值必须原样透传，
  // 不能被换成任何默认值 —— 否则菜单里选的模型等于没生效。
  eq(
    resolveModelForAgent('qoder', 'Qwen3.8-Flash'),
    'Qwen3.8-Flash',
    '路由：qoder 的裸模型名原样透传'
  );
  eq(
    resolveModelForAgent('codex', 'gpt-6-sol'),
    'gpt-6-sol',
    '路由：codex 的裸模型名原样透传'
  );
  eq(
    resolveModelForAgent('qoder', 'claude-sonnet-4'),
    undefined,
    '路由：qoder 仍然拦下平台默认模型（那是历史遗留的错值）'
  );
}

// ── 9. 源码契约：目录必须真的接在调用链上 ───────────────────────
{
  const registrySrc = read('server/agents/registry.ts');
  ok(
    registrySrc.includes('getModelsForAgent(') && registrySrc.includes('mergeModelOptions('),
    '接线：registry.modelsFor 必须合并动态目录（否则列表又只剩白名单 4 条）'
  );
  ok(
    /async\s+modelsFor\(/.test(registrySrc),
    '接线：modelsFor 必须是异步的（目录加载要等 CLI/网络）'
  );

  const indexSrc = read('server/index.ts');
  ok(
    indexSrc.includes('await registry.modelsFor('),
    '接线：/api/agents/:id/models 必须 await（漏了 await 会返回 Promise 序列化后的空对象）'
  );
  ok(
    indexSrc.includes('setCatalogModelLookup(isCatalogModel)'),
    '接线：启动时必须把目录查表注册进 model-routing'
  );
  ok(
    indexSrc.includes('ensureCatalogLoaded()'),
    '接线：启动时必须预热目录（否则首次打开菜单要等 2 秒 CLI）'
  );
  ok(
    indexSrc.includes('findDef(agentId)?.defaultModel ?? (await getDefaultModelForAgent(agentId))'),
    '接口：默认模型 = 定义表里的（opencode）优先，其次是 CLI 自己声明的（codex 的 config.toml）'
  );
  ok(
    (indexSrc.match(/invalidateCatalog\(\)/g) ?? []).length >= 2,
    '接线：保存/清除凭据后必须作废目录（否则填完 Key 要等 24 小时才看见新模型）'
  );

  const routingSrc = read('server/model-routing.ts');
  ok(
    routingSrc.includes('catalogLookup?.('),
    '接线：模型路由必须查动态目录'
  );

  const catalogSrc = read('server/agents/modelCatalog.ts');
  ok(
    catalogSrc.includes("from '../paths.js'") && !catalogSrc.includes("from '../db.js'"),
    '隔离：目录模块不得 import db.js（否则离线验证会顺带打开真实数据库）'
  );

  // 三条 CLI 枚举源必须都在表里，且形态各自正确 —— 少一条就等于那个 Agent
  // 又退回「模型由 Agent 决定」，用户看到的就是「模型不全」。
  ok(
    catalogSrc.includes("cli: { bin: 'opencode', args: ['models'] }"),
    '来源：opencode 必须用 `opencode models` 枚举'
  );
  ok(
    catalogSrc.includes("cli: { bin: 'qodercli', args: ['--list-models'] }") &&
      catalogSrc.includes("format: 'qoder'"),
    '来源：qoder 必须用 `qodercli --list-models`（隐藏命令，光看 --help 发现不了）'
  );
  ok(
    catalogSrc.includes("cli: { bin: 'codex', args: ['debug', 'models'] }") &&
      catalogSrc.includes("format: 'codex-json'"),
    '来源：codex 必须用 `codex debug models`（藏在 debug 子命令下）'
  );
  ok(
    catalogSrc.includes('extraDirs:') && catalogSrc.includes('%USERPROFILE%\\\\.qoder\\\\bin\\\\qodercli'),
    '来源：qodercli 不在 PATH 里，必须给额外搜索目录（否则服务器进程里枚举直接失败）'
  );
  ok(
    catalogSrc.includes("(src.format ?? 'provider-model') !== 'provider-model'"),
    '分派：非 provider-model 形态必须走 buildListOptions（不拿 models.dev 硬拼元数据）'
  );
  ok(
    catalogSrc.includes('version: CACHE_VERSION') && catalogSrc.includes('parsed.version !== CACHE_VERSION'),
    '缓存：结构版本必须参与读写校验（否则旧缓存会让菜单缺显示名）'
  );

  // A74 之后模型菜单从 ChatInput 里搬进了独立组件（弹窗要自己管宽度与回显），
  // 断言必须跟着走 —— 指着 ChatInput 的话这两条会**永远通过**（因为文件里
  // 根本没有那个字符串），等于守卫失效。这正是「借界面文案当标志物」的变种：
  // 不是文案变了，是宿主文件变了。
  const modelPopupSrc = read('src/components/ModelSelectPopup.tsx');
  ok(
    modelPopupSrc.includes('m.tag') && modelPopupSrc.includes('tagStyle'),
    'UI：模型菜单必须渲染免费/付费角标'
  );
  ok(
    modelPopupSrc.includes('m.providerName'),
    'UI：模型菜单第二行必须标出 provider（97 条没有分组控件，靠它分辨来源）'
  );

  const appSrc = read('src/App.tsx');
  ok(appSrc.includes('data.defaultModel'), 'UI：初始模型必须取后端给的 defaultModel，而不是列表第一条');

  // WorkBuddy（SDK）走的是另一条链路：/api/models。它必须用 raw 接口，
  // 否则 credits / 中文简介 / 上下文又会被丢掉 —— 这就是 A57 的第二处同类缺陷。
  ok(
    indexSrc.includes('getAvailableModelsRaw()'),
    'SDK：/api/models 必须用 getAvailableModelsRaw（thin 接口只有 modelId+name）'
  );
  ok(
    indexSrc.includes('mapSdkModels('),
    'SDK：raw 清单必须经 mapSdkModels 映射出角标与说明'
  );
  ok(
    indexSrc.includes('sdkDefaultModel'),
    'SDK：默认模型应取 SDK 的 isDefault，而不是平台常量 claude-sonnet-4'
  );
}

// ── 10. 源码契约：刷新入口（A59）────────────────────────────────
//
// 这一段的重点是「两套缓存都要作废」。只清 catalog 不清 cachedModels，
// 用户点完刷新会发现 opencode 变了、WorkBuddy 没变 —— 半截刷新比没有更糟。
{
  const catalogSrc = read('server/agents/modelCatalog.ts');
  ok(
    /export\s+function\s+getCatalogSummary/.test(catalogSrc),
    '刷新：必须导出 getCatalogSummary（设置页要知道各 Agent 枚举到几条）'
  );
  ok(
    catalogSrc.includes('if (!state) return { fetchedAt: 0, counts: {} }'),
    '刷新：目录未加载时概况必须如实返回空，不能触发枚举'
  );

  const indexSrc = read('server/index.ts');
  ok(
    /app\.get\("\/api\/model-catalog"/.test(indexSrc),
    '刷新：必须有 GET /api/model-catalog（读概况，不跑 CLI）'
  );
  ok(
    /app\.post\("\/api\/model-catalog\/refresh"/.test(indexSrc),
    '刷新：必须有 POST /api/model-catalog/refresh'
  );
  ok(
    /async function loadSdkModels\(/.test(indexSrc),
    '刷新：SDK 清单必须抽成 loadSdkModels，GET 与刷新共用同一条路径'
  );

  // 抓 refresh 处理体：从 POST 路由到下一个 app. 定义为止
  const refreshBody = indexSrc.slice(
    indexSrc.indexOf('app.post("/api/model-catalog/refresh"'),
    indexSrc.indexOf('app.post("/api/model-catalog/refresh"') + 1800
  );
  ok(refreshBody.includes('invalidateCatalog()'), '刷新：必须作废 catalog 磁盘+内存缓存');
  ok(refreshBody.includes('cachedModels = []'), '刷新：必须同时作废 SDK 清单缓存（否则 WorkBuddy 不刷新）');
  ok(refreshBody.includes('loadSdkModels(true)'), '刷新：SDK 清单必须以 force 重取');
  ok(refreshBody.includes('loadCatalog(true)'), '刷新：目录必须以 force 重枚举');
  ok(refreshBody.includes('tookMs'), '刷新：必须回报耗时（前端据此判断这是慢操作）');

  const settingsSrc = read('src/components/SettingsPage.tsx');
  ok(
    settingsSrc.includes("key: 'models'") && settingsSrc.includes('<ModelCatalogSettings'),
    '刷新：设置页必须有「模型清单」分区并挂上组件'
  );
  ok(
    settingsSrc.includes('onModelsRefreshed'),
    '刷新：设置页必须把刷新结果往上传（否则菜单不会重取）'
  );

  const panelSrc = read('src/components/ModelCatalogSettings.tsx');
  ok(
    panelSrc.includes("fetch('/api/model-catalog/refresh'") && panelSrc.includes("method: 'POST'"),
    '刷新：按钮必须真的 POST（长个按钮不算）'
  );
  ok(
    panelSrc.includes('workbuddy') && panelSrc.includes('workbuddyCount'),
    '刷新：两个接口的 WorkBuddy 字段名不同，必须都认（否则刷新后那行变「—」）'
  );
  ok(
    panelSrc.includes('data-model-catalog-refresh'),
    '刷新：按钮需要稳定的测试钩子'
  );

  const appSrc = read('src/App.tsx');
  ok(
    /\[currentAgentId, modelsEpoch\]/.test(appSrc),
    '刷新：模型列表 effect 必须依赖 modelsEpoch（否则刷完回到会话菜单还是旧的）'
  );
  ok(
    appSrc.includes('onModelsRefreshed') && appSrc.includes('fetchModels()'),
    '刷新：App 必须同时重取 SDK 清单（WorkBuddy 走 useModels 那份）'
  );
}

// ── 11. 源码契约：qoder 只补「实测路由通过」的模型（A61）──────────────────
//
// CLI 的 `--list-models` 只吐 Default + Custom（3 条），官方 IDE 选择器有 15 条。
// 补齐的准入标准必须是**实测 `-m <name>` 路由通过**，不是把 GUI 的表搬过来 ——
// 那张表里混着 CLI 明确不认的历史/预览条目，塞进去就是「点了就报错」的假控件。
{
  const catalogSrc = read('server/agents/modelCatalog.ts');
  const extraBlock = catalogSrc.slice(
    catalogSrc.indexOf('const QODER_VERIFIED_EXTRA'),
    catalogSrc.indexOf('function mergeQoderVerifiedExtras')
  );

  ok(
    /QODER_VERIFIED_EXTRA/.test(catalogSrc) && catalogSrc.includes('mergeQoderVerifiedExtras'),
    'qoder：必须存在「实测补充清单」常量与合并函数'
  );
  // 判定依据写在常量上方的注释里（后人要能复核这些名字为什么在名单里）
  const rationaleBlock = catalogSrc.slice(
    catalogSrc.indexOf('Qoder：CLI 只吐 3 条'),
    catalogSrc.indexOf('const QODER_VERIFIED_EXTRA')
  );
  ok(
    rationaleBlock.includes('You\'ve reached your credit usage limit'),
    'qoder：必须记录判定依据的原文（否则后人无法复核这些名字为什么在名单里）'
  );
  ok(
    rationaleBlock.includes('is not available right now') && rationaleBlock.includes('GLM-5.2'),
    'qoder：必须记录 CLI 明确不认的名字（防止有人顺手把全表补进来）'
  );
  ok(
    extraBlock.includes('Qwen3.8-Max') && extraBlock.includes('GLM-5.3'),
    'qoder：补充清单应包含两个已实测可路由的模型'
  );

  // 四个「CLI 明确不认」的名字绝不允许出现在补充清单里
  for (const bad of ['GLM-5.2', 'Qwen3.5-Plus', 'Qwen3.8-Max-Preview', 'Qwen3.7-Max']) {
    ok(
      !new RegExp(`id:\\s*'${bad}'`).test(extraBlock),
      `qoder：${bad} 实测不可路由，不许进补充清单（点了就是报错的假控件）`
    );
  }

  const qoderMerge = catalogSrc.slice(
    catalogSrc.indexOf('function mergeQoderVerifiedExtras'),
    catalogSrc.indexOf('function mergeQoderVerifiedExtras') + 700
  );
  ok(
    /entries\.some\(e => e\.id === extra\.id\)/.test(qoderMerge),
    'qoder：合并时必须去重（官方哪天自己吐了就会出现两条同名）'
  );
  ok(
    /entries\.push\(\{ \.\.\.extra \}\)/.test(qoderMerge),
    'qoder：补充项追加在尾部（CLI 给的三条是账号自己的，应排前面）'
  );

  // 合并必须只发生在**国际版 qoder** 分支里。写成「允许块体」而不是钉死一行代码：
  // qoder 分支现在还要顺手给全部条目挂档位（A62），代码形状早晚会变，
  // 断言该守的是「谁调、在哪调」，不是「调用的那一行长什么样」。
  //
  // A76 之后条件多了一个 `agentId === 'qoder'`：`qoder-cn` 用同一个解析器，
  // 但它是**独立账号体系**，那几个「实测路由通过」的结论是在国际版账号上得到的，
  // 搬到 CN 上就是编数据。所以这里同时守住「必须收窄到 agentId」。
  ok(
    /if \(format === 'qoder' && agentId === 'qoder'\) \{[\s\S]{0,200}?mergeQoderVerifiedExtras\(entries\);/.test(
      catalogSrc
    ),
    'qoder：合并只发生在国际版 qoder 分支（qoder-cn 是独立账号，不能搬实测结论）'
  );
  ok(
    !/format === 'codex-json'\)[\s\S]{0,160}?mergeQoderVerifiedExtras/.test(catalogSrc) &&
    !/format === 'provider-model'[\s\S]{0,160}?mergeQoderVerifiedExtras/.test(catalogSrc),
    'qoder：合并绝不能泄漏到 codex / opencode 分支'
  );
  ok(
    !/tag:|multiplier:/.test(catalogSrc.slice(catalogSrc.indexOf('const QODER_VERIFIED_EXTRA'), catalogSrc.indexOf('function mergeQoderVerifiedExtras'))),
    'qoder：补充模型不标价格/角标（倍率在私有 catalog-v7 里，拿不到就不猜）'
  );

  // 行为契约：常量挂着不调用等于没做。只数 refreshCatalog 体内的调用次数，
  // 不规定那一行的写法（同上）。
  const refreshBody = catalogSrc.slice(
    catalogSrc.indexOf('async function refreshCatalog'),
    catalogSrc.indexOf('export function loadCatalog')
  );
  ok(
    (refreshBody.match(/mergeQoderVerifiedExtras\(entries\)/g) ?? []).length === 1,
    'qoder：refreshCatalog 里必须真的调用合并函数（常量挂着不调用等于没做）'
  );
}

// ── 12. 源码契约：思考强度档位（A62）────────────────────────────
// 这一节盯三件事，都是用户明令的「不能造假」：
//   ① 档位只能来自官方（CLI 报错原文 / CLI JSON / 官方文案表），不能有我们编的值；
//   ② 拿不到档位的模型必须没有 `reasoning`（没有 = 前端不摆控件）；
//   ③ 前端只在模型真有档位表时渲染下拉 —— 摆一个传不下去的选择器就是假控件。
{
  // ① 值域与来源
  const catalogSrc = read('server/agents/modelCatalog.ts');
  ok(
    /QODER_REASONING_LEVELS[\s\S]{0,900}?ultracode/.test(catalogSrc),
    'A62：qoder 档位表必须含 ultracode（CLI 报错原文里的第 8 档，漏一个就是残缺表）'
  );
  ok(
    /default_reasoning_level/.test(catalogSrc) && /supported_reasoning_levels/.test(catalogSrc),
    'A62：codex 档位必须取自 CLI JSON 的官方字段，不是我们拍的'
  );
  ok(
    /levels\.some\(l => l\.value === declared\)/.test(catalogSrc),
    'A62：codex 默认档必须校验在 supported 列表内（否则前端预设一个不支持的档位）'
  );
  ok(
    /CODEX_REASONING_LABEL\[item\.effort\] \?\? item\.effort/.test(catalogSrc),
    'A62：没见过的 effort 值保留英文原文，不硬造中文'
  );

  // ② 没有档位 → 没有字段（而不是空数组 / 猜一个）
  ok(
    /return undefined;/.test(catalogSrc) && /levels\.length === 0\) return undefined/.test(catalogSrc),
    'A62：档位列表为空时必须返回 undefined（空数组会让前端摆一个空下拉）'
  );
  ok(
    /if \(!Array\.isArray\(m\.supported_reasoning_levels\)/.test(catalogSrc),
    'A62：模型没给 supported_reasoning_levels 时整个 reasoning 缺省'
  );
  ok(
    /e\.reasoning \?\?= qoderReasoning\(\)/.test(catalogSrc),
    'A62：qoder 分支必须给全部条目挂上全局档位表（用 ??= 让解析器优先）'
  );

  // ③ 前端的渲染纪律
  const chatInputSrc = read('src/components/ChatInput.tsx');
  ok(
    /reasoningOfSelectedModel/.test(chatInputSrc) && /reasoningLevels && \(/.test(chatInputSrc),
    'A62：ChatInput 的下拉必须挂在 reasoningLevels 上（没有档位表就不渲染）'
  );
  ok(
    /!isGroup && selectedModel/.test(chatInputSrc),
    'A62：群聊没有单一模型，不能摆档位下拉（每个成员的档位表不同）'
  );
  ok(
    /reasoningLevels\?\.find\(l => l\.value === reasoningEffort\)\?\.label \?\? null/.test(chatInputSrc),
    'A62：档位表里没有的已存值显示成「默认」，不谎报一个其实不在表里的档位'
  );

  const newChatSrc = read('src/components/NewChatView.tsx');
  ok(
    /reasoningLevels && onSetReasoning && \(/.test(newChatSrc),
    'A62：新对话页的档位区块同样只在有档位表 + 有回调时才渲染'
  );

  // 落库：列必须真实存在，否则前端存了也白存
  const dbSrc = read('server/db.ts');
  ok(
    /ensureColumn\('sessions', 'reasoning_effort', 'reasoning_effort TEXT'\)/.test(dbSrc),
    'A62：sessions.reasoning_effort 必须有迁移（老库不给迁移，档位刷新后就丢）'
  );
  ok(
    /reasoning_effort: bind\?/.test(dbSrc) || /bind\(session\.reasoning_effort\)/.test(dbSrc),
    'A62：createSession 必须把档位真的写进库'
  );
  ok(
    /updates\.reasoning_effort !== undefined/.test(dbSrc),
    'A62：updateSession 必须能改档位（null = 清空，与 undefined 不同语义）'
  );
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`模型目录断言：${checks.total - failures.length}/${checks.total} 通过`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 模型目录的解析 / 免费判定 / 排序 / 合并 / 路由 / 接线均符合预期');
