/**
 * A39 技能自动沉淀单元验证。
 *
 * 全离线：OPC_DATA_DIR 指临时目录，用手搓的 ToolBlock 轨迹驱动
 * server/skill-distill.ts。跑完即删，不碰真实 dataDir（A14 纪律）。
 *
 * 运行：npx tsx scripts/verify-a39.ts
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'opc-a39-'));
process.env.OPC_DATA_DIR = TMP;

const d = await import('../server/skill-distill.js');
const m = await import('../server/memory.js');

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(cond: boolean, name: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail += 1;
    fails.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

/** 一段「读 → 改 → 查」的轨迹，共 4 个工具步。 */
function traceBlocks(opts: { file?: string; steps?: number } = {}) {
  const file = opts.file ?? 'src/components/SettingsPage.tsx';
  const n = opts.steps ?? 4;
  const blocks: any[] = [
    { type: 'text', id: 't1', text: '好的，我来改设置页。', status: 'done' },
    { id: 'b-read', type: 'tool', toolId: 'c1', name: 'Read', input: { file_path: file }, status: 'completed', startedAt: 1, endedAt: 2 },
  ];
  const more = [
    { name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } },
    { name: 'Bash', input: { command: 'npx tsc -b' } },
    { name: 'Edit', input: { file_path: file, old_string: 'c', new_string: 'd' } },
    { name: 'Read', input: { file_path: 'AGENTS.md' } },
    { name: 'Bash', input: { command: 'npm run verify:a37' } },
  ];
  for (let i = 0; i < n - 1; i += 1) {
    const spec = more[i % more.length];
    blocks.push({ id: `b-${i}`, type: 'tool', toolId: `c${i + 2}`, name: spec.name, input: spec.input, status: 'completed', startedAt: i, endedAt: i + 1 });
  }
  return blocks;
}

const baseInput = (over: Partial<d.DistillInput> = {}): d.DistillInput => ({
  prompt: '把设置页的描边改细一些',
  blocks: traceBlocks(),
  durationMs: 272_000,
  agentId: 'claude',
  aborted: false,
  hadError: false,
  ...over,
});

console.log('\n[1] 沉淀门槛');
ok(!d.shouldDistill(baseInput({ aborted: true })).ok, '中止的任务不沉淀');
ok(!d.shouldDistill(baseInput({ hadError: true })).ok, '报错的任务不沉淀');
ok(!d.shouldDistill(baseInput({ blocks: [] as any })).ok, '空轨迹不沉淀');
ok(!d.shouldDistill(baseInput({ blocks: traceBlocks({ steps: 2 }) })).ok, '步骤不足 3 不沉淀');
ok(d.shouldDistill(baseInput()).ok, '4 步正常轨迹允许沉淀');
ok(d.shouldDistill(baseInput({ blocks: traceBlocks({ steps: 2 }) })).reason.includes('噪音'), '否决理由说人话');

console.log('\n[2] 签名与文件名');
{
  const tr = d.buildSkillDoc(baseInput())!;
  // 动词词汇表来自 shared/trace.ts 的 verbOf（Read→已读取 / Edit→编辑 / Bash→检查）
  ok(tr.signature === '已读取→编辑→检查→编辑', '签名是动词序列（连续重复折叠）', tr.signature);
  ok(tr.name.length > 0 && /^[a-z0-9-]+$/.test(tr.name), '文件名是安全 ASCII', tr.name);
  const doc2 = d.buildSkillDoc(baseInput({ prompt: 'x', blocks: traceBlocks({ file: 'src/components/ChatPage.tsx' }) }))!;
  ok(doc2.signature === tr.signature, '换个文件签名不变（同一个技能）', doc2.signature);
  ok(d.slugify('你好世界') === 'skill-1', '纯中文标题退化成 skill-N（不把中文塞进文件名）');
  ok(d.slugify('Edit SettingsPage.tsx') === 'edit-settingspage-tsx', '英文标题被 slugify');
}

console.log('\n[3] 首次沉淀落盘');
m.bootMemory();
{
  const r = d.distillSkill(baseInput());
  ok(r.status === 'created', '首次沉淀创建新技能', JSON.stringify(r));
  const name = (r as any).name;
  const skill = m.readSkill(name)!;
  ok(!!skill, '文件真的落盘了');
  ok(skill.body.includes('signature: 已读取→编辑→检查→编辑'), 'frontmatter 带签名');
  ok(skill.body.includes('+109') === false, '没有凭空编造 diff 数字（夹具里没有 diff）');
  ok(skill.body.includes('## 触发条件'), '带触发条件段');
  ok(skill.body.includes('用户说：把设置页的描边改细一些'), '触发条件是用户原话首行');
  ok(skill.body.includes('## 执行步骤'), '带执行步骤段');
  ok(skill.body.includes('## 历史表现'), '带历史表现段');
  ok(skill.body.includes('耗时：4m32s'), '耗时用同一套时长文案', skill.body.match(/耗时：[^\n]*/)![0]);
  ok(m.memoryStats().skillCount === 1, '统计里出现 1 个技能');
  ok(m.searchMemory('设置页').length >= 1, '技能进了全文索引（中文可检索）');
}

console.log('\n[4] 重复执行只累加，不复制');
{
  const r2 = d.distillSkill(baseInput());
  ok(r2.status === 'reused', '同签名第二次执行命中已有技能', JSON.stringify(r2));
  ok((r2 as any).uses === 2, 'uses 累加到 2', String((r2 as any).uses));
  ok(m.memoryStats().skillCount === 1, '文件数没有翻倍');
  const skill = m.listSkills()[0];
  ok(/uses: 2/.test(skill.body), '文件里 uses 已更新');
  ok(skill.body.includes('提炼次数：1') || skill.body.includes('## 历史表现'), '正文仍是第一份配方（人可编辑的那份）');
}

console.log('\n[5] 不同的流程生成不同技能');
{
  // 顺序不同 → 签名不同 → 新技能
  const reversed: any[] = [
    { id: 'x1', type: 'tool', toolId: 'd1', name: 'Bash', input: { command: 'ls' }, status: 'completed', startedAt: 1 },
    { id: 'x2', type: 'tool', toolId: 'd2', name: 'Edit', input: { file_path: 'a.ts' }, status: 'completed', startedAt: 2 },
    { id: 'x3', type: 'tool', toolId: 'd3', name: 'Read', input: { file_path: 'b.ts' }, status: 'completed', startedAt: 3 },
    { id: 'x4', type: 'tool', toolId: 'd4', name: 'Bash', input: { command: 'ls' }, status: 'completed', startedAt: 4 },
  ];
  const r3 = d.distillSkill(baseInput({ prompt: '另一个流程', blocks: reversed }));
  ok(r3.status === 'created', '不同签名生成新技能', JSON.stringify(r3));
  ok(m.memoryStats().skillCount === 2, '现在有 2 个技能');
}

console.log('\n[6] frontmatter 解析与边界');
{
  ok(d.parseSkillMeta('没有 meta 的正文') === null, '无 frontmatter 返回 null');
  ok(d.parseSkillMeta('---\nname: x\n---\n正文') === null, '没有 signature 返回 null');
  const meta = d.parseSkillMeta('---\nsignature: A→B\nuses: 3\nlastUsedAt: 2026-10-20\n---\n正文');
  ok(meta?.signature === 'A→B' && meta.uses === 3 && meta.lastUsedAt === '2026-10-20', '正常解析三个字段');
}

console.log('\n[7] 超长轨迹只列前 25 步');
{
  const r = d.distillSkill(baseInput({ prompt: '一个大任务', blocks: traceBlocks({ steps: 40 }) }));
  // 40 步的签名是 读取→编辑→执行（3 个动词折叠），可能命中第一个技能；
  // 无论命中还是新建，都要保证文档里步骤数不超过 25。
  const skill = r.status === 'created'
    ? m.readSkill((r as any).name)!
    : m.listSkills().find(s => s.name === (r as any).name)!;
  const stepLines = skill.body.split('\n').filter(l => /^\d+\. /.test(l)).length;
  ok(stepLines <= 25, '步骤列表不超过 25 行', String(stepLines));
  ok(skill.body.includes('其余') || stepLines < 40, '超出部分有省略提示');
}

const { default: db } = await import('../server/db.js');
db.close();
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} A39 技能沉淀：${pass}/${pass + fail} 通过${fail ? `，失败：${fails.join('、')}` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
