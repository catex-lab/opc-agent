/**
 * 闸门：「从 Agent 列表移除内置 Agent（可恢复）」。
 *
 * 覆盖两层：
 *   1. 存储层 `server/agents/hiddenAgents.ts` 的读写往返、容错、非法 id 拒绝；
 *   2. 契约层：名册接口真的分出了 `hiddenAgents`，UI 真的挂了恢复入口。
 *
 * 运行：`npm run verify:hidden-agents`（tsx，无需起服务）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-hidden-agents-'));
process.env.OPC_DATA_DIR = dataDir;

const storePath = path.join(dataDir, 'hidden-agents.json');
let failed = 0;

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

try {
  // env 必须在 import 之前设置：dataDirPath 是模块加载时求值的
  const mod = await import('../server/agents/hiddenAgents.js');

  console.log('[1] 存储往返');
  ok(mod.loadHiddenAgentIds().length === 0, '初始为空');
  ok(mod.hideBuiltinAgent('doubao') === true, 'hideBuiltinAgent(doubao) 成功');
  ok(mod.loadHiddenAgentIds().includes('doubao'), '内存/磁盘读回 doubao');
  ok(fs.existsSync(storePath), 'hidden-agents.json 已落盘');

  console.log('[2] 幂等');
  ok(mod.hideBuiltinAgent('doubao') === true, '重复 hide 返回成功');
  ok(mod.loadHiddenAgentIds().length === 1, '重复 hide 不产生重复项');

  console.log('[3] 恢复');
  ok(mod.showBuiltinAgent('doubao') === true, 'showBuiltinAgent(doubao) 成功');
  ok(mod.loadHiddenAgentIds().length === 0, '恢复后列表为空');
  ok(mod.showBuiltinAgent('doubao') === true, '重复 show 幂等');
  ok(mod.isBuiltinAgentHidden('doubao') === false, 'isBuiltinAgentHidden 为 false');

  console.log('[4] 拒绝自建 id');
  ok(mod.hideBuiltinAgent('custom-abc') === false, 'custom-* 被拒绝');
  ok(mod.hideBuiltinAgent('customcli-abc') === false, 'customcli-* 被拒绝');
  ok(mod.loadHiddenAgentIds().length === 0, '非法 id 未写入');

  console.log('[5] 坏文件容错');
  fs.writeFileSync(
    storePath,
    JSON.stringify(['doubao', 'doubao', 'BAD ID', 'custom-x', 123]),
    'utf-8'
  );
  const loaded = mod.loadHiddenAgentIds();
  ok(
    loaded.length === 1 && loaded[0] === 'doubao',
    '只保留合法且去重的内置 id',
    JSON.stringify(loaded)
  );

  console.log('[6] 契约：接口与 UI');
  const root = process.cwd();
  const roster = fs.readFileSync(
    path.join(root, 'server/routes/agent-roster.ts'),
    'utf-8'
  );
  ok(roster.includes('hiddenAgents'), '名册接口下发 hiddenAgents');
  ok(/\/api\/agents\/:agentId\/hide/.test(roster), '有 hide 路由');
  ok(/\/api\/agents\/:agentId\/show/.test(roster), '有 show 路由');

  const contacts = fs.readFileSync(
    path.join(root, 'src/components/ContactsPanel.tsx'),
    'utf-8'
  );
  ok(contacts.includes('contacts.hideAgent'), '列表右键菜单有「从列表移除」');
  // 空名册不是死胡同：与「全部隐藏」共用获取弹窗，给用户一个能点的出口。
  const noAgentsAt = contacts.indexOf("t('contacts.noAgents')");
  const emptyBranch = noAgentsAt >= 0 ? contacts.slice(noAgentsAt, noAgentsAt + 700) : '';
  ok(/contacts\.noAgentsDesc/.test(emptyBranch)
    && /t\('contacts\.getAgents'\)/.test(emptyBranch)
    && /setGetAgentsOpen\(true\)/.test(emptyBranch),
  '空名册有说明和「获取 Agent」行动出口（不是死胡同）');

  const getAgents = fs.readFileSync(
    path.join(root, 'src/components/GetAgentsDialog.tsx'),
    'utf-8'
  );
  ok(getAgents.includes('data-get-agents-restore'), '获取弹窗有「重新添加」入口');
  ok(getAgents.includes('已从列表移除'), '获取弹窗有「已从列表移除」分组');
} catch (err) {
  failed += 1;
  console.error('闸门执行异常:', (err as Error)?.stack || err);
} finally {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
