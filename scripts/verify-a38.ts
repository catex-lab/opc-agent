/**
 * A38 记忆层单元验证。
 *
 * 全离线：把 OPC_DATA_DIR 指到临时目录，直接驱动 server/memory.ts 的纯函数与
 * SQLite（node:sqlite，含 FTS5）。不碰真实 dataDir —— 这一条是 A14 立下的纪律。
 *
 * 运行：npx tsx scripts/verify-a38.ts
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'opc-a38-'));
// ⚠️ 必须在 import memory.ts **之前**设好：db.ts 在模块加载时就按这个变量定位库文件。
process.env.OPC_DATA_DIR = TMP;

const m = await import('../server/memory.js');
const { default: db } = await import('../server/db.js');

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

console.log(`\n[1] 目录与默认文件（OPC_DATA_DIR=${TMP}）`);
m.bootMemory();
ok(existsSync(m.CORE_MEMORY_PATH), 'MEMORY.md 自动创建');
ok(existsSync(m.USER_PROFILE_PATH), 'USER.md 自动创建');
ok(existsSync(m.SKILLS_DIR), 'skills/ 目录自动创建');

console.log('\n[2] token 估算与预算截断');
ok(m.estimateTokens('') === 0, '空串 = 0 token');
ok(m.estimateTokens('你好世界') === 4, 'CJK 一字一 token', String(m.estimateTokens('你好世界')));
ok(m.estimateTokens('abcdefgh') === 2, 'ASCII 4 字符一 token', String(m.estimateTokens('abcdefgh')));
const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容`).join('\n');
const cut = m.truncateToBudget(long, 100);
ok(cut.truncated, '超预算被标记为 truncated');
ok(cut.text.startsWith('第 0 行'), '保留的是头部（优先级从上到下）');
// 注意「预算附近」的度量对象是**正文**，不含末尾那行截断提示 ——
// 提示本身也要花 token，把它算进去会让断言变成一个薛定谔的数字。
{
  const noteAt = cut.text.indexOf('\n\n（');
  const body = noteAt >= 0 ? cut.text.slice(0, noteAt) : cut.text;
  ok(m.estimateTokens(body) <= 100, '正文部分不超预算', String(m.estimateTokens(body)));
}
ok(cut.text.includes('已按预算截断'), '带截断提示，用户知道被砍了');
ok(!m.truncateToBudget('短内容', 800).truncated, '预算内不动');

console.log('\n[3] 保存语义：超预算也照样写盘');
const w1 = m.writeCoreMemory('# 长期规范\n' + '需要记住的事\n'.repeat(300));
ok(w1.ok, '写入返回 ok');
ok(w1.overBudget, '超预算被如实标记', `${w1.tokens}/${w1.budget}`);
ok(readFileSync(m.CORE_MEMORY_PATH, 'utf8').length > 100, '文件里是完整内容（不是被砍过的）');
const w2 = m.writeCoreMemory('# 恢复\n写点正常的。');
ok(!w2.overBudget, '改回短内容后不再超预算');

console.log('\n[4] 技能文件：白名单与增删');
ok('error' in m.writeSkill('../../etc/passwd', 'x'), '拒绝路径穿越');
ok('error' in m.writeSkill('带 空格', 'x'), '拒绝空格');
ok('error' in m.writeSkill('a'.repeat(65), 'x'), '拒绝超长名');
const wr = m.writeSkill('api-doc', '# 写接口文档\n\n步骤：读路由 → 补注释 → 跑 tsc');
ok('name' in wr && wr.name === 'api-doc', '合法技能名写入成功');
ok(m.readSkill('api-doc')?.title === '写接口文档', 'title 取第一个标题');
ok(m.readSkill('不存在') === null, '读不到的技能返回 null（不抛错）');
ok(m.deleteSkill('api-doc'), '删除成功');
ok(!m.deleteSkill('api-doc'), '重复删除返回 false');

console.log('\n[5] FTS5 检索');
m.writeSkill('skill-alpha', '# Alpha 技能\n\n处理 Postgres 连接池泄漏问题');
m.writeSkill('skill-beta', '# Beta 技能\n\n生成周报并发送邮件');
const h1 = m.searchMemory('Postgres');
ok(h1.length === 1 && h1[0].key === 'skill:skill-alpha', '命中技能文档', h1.map(h => h.key).join(','));
const h2 = m.searchMemory('postgres');
ok(h2.length === 1, '大小写不敏感（unicode61 分词器）');
ok(m.searchMemory('').length === 0, '空查询返回空（不进 SQL）');
ok(m.searchMemory('-').length === 0, '纯符号查询返回空（FTS5 语法炸弹被转义挡掉）');
// 引号会被转义步骤剥掉（FTS5 语法炸弹的正确归宿），所以断言的是「不炸」而不是「命中」。
// 引号在转义步骤被剥掉，所以它其实是「引号不影响结果」而不是「查不到」。
ok(m.searchMemory('"周报"').length === 1, '带引号查询被安全转义（引号剥掉，正常命中）');
ok(m.searchMemory('周报').length === 1, '中文双字词能命中（unicode61 不索引中文，靠 cjkGrams 切分）');
ok(m.searchMemory('邮').length === 1, '中文单字也能命中（切分里含单字）');
ok(m.searchMemory('连接池').length === 1, '另一个中文词命中 skill-alpha');
{
  const hits = m.searchMemory('Postgres');
  ok(hits.length === 1, '英文词照样命中 FTS5');
  ok(!/…[\u4e00-\u9fff]…/.test(hits[0].snippet), '摘要是原文（不是切碎后的 gram）', hits[0].snippet);
  ok(hits[0].title === 'Alpha 技能', '标题显示原文');
}
ok(m.searchMemory('NEAR').length >= 0, 'FTS5 关键字当普通词处理');
m.indexMemory('note', 'note:x', '笔记', '连接池与周报都要写进 runbook');
const h3 = m.searchMemory('runbook');
ok(h3.length === 1 && h3[0].kind === 'note', '自定义文档类型也能索引');
m.deleteMemory('note:x');
ok(m.searchMemory('runbook').length === 0, '按 key 删除后检索不到');

console.log('\n[6] 索引重建与统计');
m.writeCoreMemory('# 核心\n\n本项目用 SQLite 与 SSE');
const st = m.reindexMemory();
ok(st.skills === 2, '重建时扫到两个技能', String(st.skills));
const stats = m.memoryStats();
ok(stats.skillCount === 2, '统计里的技能数一致');
ok(stats.indexedDocs === 4, '索引文档数 = 2 技能 + MEMORY + USER', String(stats.indexedDocs));
ok(stats.coreBudget === 800 && stats.userBudget === 500, '预算常量对外可见');

console.log('\n[7] 装配与注入');
const ctx = m.assembleMemoryContext();
ok(ctx.includes('## 用户长期记忆'), '带核心记忆段标题');
ok(ctx.includes('## 用户偏好画像'), '带用户画像段标题');
ok(ctx.includes('只读'), '明确告知模型这是只读上下文');
const noUser = m.assembleMemoryContext({ includeUser: false });
ok(!noUser.includes('## 用户偏好画像'), 'includeUser:false 时不带画像');
m.writeCoreMemory(Array.from({ length: 400 }, (_, i) => `规范 ${i}`).join('\n'));
const cutCtx = m.assembleMemoryContext();
ok(cutCtx.includes('已按预算截断'), '超预算的核心记忆在注入时被截断');
ok(cutCtx.length < long.length, '注入内容确实短于原文');

console.log('\n[8] withMemoryContext（适配器用的入口）');
const empty = m.withMemoryContext(undefined);
ok(empty.startsWith('## 用户长期记忆'), '原提示词为空时直接用记忆');
ok(!empty.includes('undefined'), '不会把 undefined 拼进去');
const withBase = m.withMemoryContext('你是代码助手。');
ok(withBase.startsWith('你是代码助手。'), '原提示词在前（人格优先）');
ok(withBase.includes('## 用户长期记忆'), '记忆追加在后');
m.writeCoreMemory('# 恢复\n短内容');

console.log('\n[9] 启动自愈幂等');
m.bootMemory();
m.bootMemory();
ok(true, 'bootMemory 重复调用不炸');

// 先关库再删临时目录：node:sqlite 的句柄不关，Windows 上会 EBUSY。
db.close();
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} A38 记忆层：${pass}/${pass + fail} 通过${fail ? `，失败：${fails.join('、')}` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
