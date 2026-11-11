/**
 * 反向探针 runner（2026-11-12 变体 A）。
 *
 * 对源码做**临时突变**，跑闸门看它真变红，然后原样恢复（内存原文逐字节比对自证）。
 * 四条：
 *   P1 删授权查表   → 弹卡回归（授权命中也照常弹卡）必须判红
 *   P2 删高危门禁前置（把查表挪到门禁之前）→ rm -rf 自动放行必须判红
 *   P3 删 persist 落库（路由不再写 addGrant）必须判红
 *   P4 删范围选择器条件渲染（选择器无条件渲染，CLI 也画）必须判红
 *
 * 退出码：0 = 探针成功（闸门真红了且源码已原样恢复）；1 = 探针失败。
 *
 * 用法：node scripts/probe-permission-scope.mjs <P1|P2|P3|P4> -- <gate 命令...>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const probe = args[0];
const gateCmd = args.slice(sep + 1);
if (!probe || sep === -1 || gateCmd.length === 0) {
  console.error('用法: node scripts/probe-permission-scope.mjs <P1|P2|P3|P4> -- <gate 命令...>');
  process.exit(1);
}

const TARGET = {
  P1: 'server/agents/adapters/sdkApproval.ts',
  P2: 'server/agents/adapters/sdkApproval.ts',
  P3: 'server/index.ts',
  P4: 'src/components/PermissionCard.tsx',
}[probe];

const GRANT_BLOCK = `    if (agentId && hasAgentGrant(agentId, toolName)) {
      console.log(\`[SDK] 持久授权命中，自动放行: \${agentId} · \${toolName}\`);
      queue.push({
        type: 'note',
        text: \`权限：已授权范围自动放行（\${agentId} · \${toolName}）\`,
        level: 'info',
      });
      return { behavior: 'allow', updatedInput: input };
    }

`;

const mutations = {
  P1: src => {
    if (!src.includes(GRANT_BLOCK)) throw new Error('P1：找不到持久授权块，突变没生效');
    return src.replace(GRANT_BLOCK, '    // probe-P1: grant check removed\n\n');
  },
  P2: src => {
    if (!src.includes(GRANT_BLOCK)) throw new Error('P2：找不到持久授权块，突变没生效');
    const moved = src.replace(GRANT_BLOCK, '');
    // 把查表挪到 A40 门禁**之前**（「门禁前置被删」的等价突变：
    // 授权命中时高危载荷不再经过 evaluateToolCall）
    const anchor = '    // ---- A40 权限门禁（规则匹配 + Bash 分类器 + 路径越界）----';
    if (!moved.includes(anchor)) throw new Error('P2：找不到门禁锚点');
    return moved.replace(anchor, `    // probe-P2: grant check moved BEFORE the gate\n\n${GRANT_BLOCK}${anchor}`);
  },
  P3: src => {
    const needle = 'persisted = addGrant(meta.agentId, meta.toolName);';
    if (!src.includes(needle)) throw new Error('P3：找不到 addGrant 落库行');
    return src.replace(needle, 'persisted = false; /* probe-P3: persist dropped */');
  },
  P4: src => {
    const needle = 'const scopeSelectable = Boolean(allowOnce && allowAlways);';
    if (!src.includes(needle)) throw new Error('P4：找不到条件渲染判据');
    return src.replace(needle, 'const scopeSelectable = true; /* probe-P4: unconditional */');
  },
};

const original = readFileSync(TARGET, 'utf8');
let restored = false;
try {
  writeFileSync(TARGET, mutations[probe](original));
  const res = spawnSync(gateCmd[0], gateCmd.slice(1), { stdio: 'inherit', shell: true });
  // 闸门红（非 0 退出）= 探针成功；闸门仍绿 = 探针失败
  process.exitCode = res.status === 0 ? 1 : 0;
  console.log(`[probe ${probe}] 闸门退出码 ${res.status} → ${res.status === 0 ? '探针失败（闸门没红）' : '探针成功（闸门判红）'}`);
} catch (err) {
  console.error(`[probe ${probe}] 突变失败：${err.message}`);
  process.exitCode = 1;
} finally {
  writeFileSync(TARGET, original);
  restored = readFileSync(TARGET, 'utf8') === original;
  console.log(`[probe ${probe}] 源码恢复校验：${restored ? 'OK（逐字节一致）' : 'MISMATCH —— 必须人工检查！'}`);
  if (!restored) process.exitCode = 1;
}
