/**
 * A132 权限审批浮层：纯函数与源码契约验证（全脱机，不起服务、不碰数据库）。
 *
 * 存在的理由：审批这件事的承诺全在「用户点下去之后发生了什么」。
 * 原来前端 POST 完不看响应就清槽位 —— 服务端返 404「已超时」时，
 * 用户看到的和实际发生的完全相反。本脚本把这类「看到 ≠ 发生」钉死。
 *
 * 运行：npx tsx scripts/verify-a132-permission-dock.ts
 */
import { readFileSync } from 'node:fs';
import {
  classifyPermissionAck,
  pickOptionByKind,
  remainingMs,
  formatCountdown,
  sortPendingPermissions,
} from '../shared/permissions.js';
import type { PermissionOption } from '../shared/permissions.js';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

function eq(actual: unknown, expected: unknown, label: string) {
  checks.total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function section(title: string) {
  console.log(`\n— ${title}`);
}

const OPT = (id: string, kind: PermissionOption['kind'], label: string): PermissionOption =>
  ({ id, kind, label });

section('[1] classifyPermissionAck：答复送达 ≠ 答复生效');
eq(classifyPermissionAck(200, { success: true }), { kind: 'settled' }, '200 算已兑现');
eq(classifyPermissionAck(404, { error: '权限请求不存在或已超时' }), { kind: 'stale' }, '404 算已过期，不许当成功');
eq(classifyPermissionAck(400, { error: '行为不合法："maybe"' }),
  { kind: 'rejected', error: '行为不合法："maybe"' }, '400 带出服务端原文，不静默纠正');
eq(classifyPermissionAck(0, null), { kind: 'rejected', error: '网络中断，答复未送达' }, '传输失败要说没送达，不能说已过期');
eq(classifyPermissionAck(500, 'not json'), { kind: 'rejected', error: 'HTTP 500' }, '拿不到 error 字段时退回状态码');

section('[2] pickOptionByKind：快捷键不许替用户做决定');
const FOUR = [OPT('reject_once', 'reject_once', '拒绝'), OPT('reject_always', 'reject_always', '本会话始终拒绝'),
  OPT('allow_once', 'allow_once', '允许'), OPT('allow_always', 'allow_always', '本会话始终允许')];
eq(pickOptionByKind(FOUR, 'allow')?.id, 'allow_once', '四档里 ↵ 命中第一个 allow_*');
eq(pickOptionByKind([OPT('o1', 'allow_always', '始终允许')], 'allow')?.id, 'o1',
  'ACP 那种只有 always 档的也能命中');
eq(pickOptionByKind([OPT('r1', 'reject_once', '拒绝')], 'allow'), undefined,
  '没有允许档时 ↵ 什么都不选（不兜底成 deny）');
eq(pickOptionByKind([], 'reject'), undefined, '空目录时 Del 也不发');

section('[3] remainingMs / formatCountdown：缺省就是缺省，不伪造倒计时');
eq(remainingMs(undefined, 1_000), null, 'ACP 没有 expiresAt → null，UI 画「无超时」');
eq(remainingMs(60_000, 1_000), 59_000, '有值时给真实剩余');
eq(remainingMs(1_000, 5_000), 0, '过期不出现负数');
eq(formatCountdown(277_000), '4:37', '4 分 37 秒');
eq(formatCountdown(5_000), '0:05', '秒补零');
eq(formatCountdown(0), '0:00', '归零');
eq(formatCountdown(600_000), '10:00', '整十分钟不写成 0:10');

section('[4] sortPendingPermissions：当前会话优先，组内先来先批');
const mk = (id: string, sessionId: string, receivedAt: number) => ({ requestId: id, sessionId, receivedAt });
const q = [mk('b', 'S2', 20), mk('a', 'S1', 10), mk('c', 'S2', 30)];
eq(sortPendingPermissions(q, 'S2').map(x => x.requestId), ['b', 'c', 'a'], 'S2 的两条按到达序在前，S1 殿后');
eq(sortPendingPermissions(q, null).map(x => x.requestId), ['a', 'b', 'c'], '没有当前会话时纯按到达序');
eq(sortPendingPermissions([], 'S1'), [], '空队列不炸');

section('[5] 源码契约：expiresAt 只能是「有兜底的适配器才有」');
const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
for (const f of ['../server/agents/adapters/sdk.ts', '../server/agents/adapters/cli.ts']) {
  const s = src(f);
  ok(/type: 'permission_request'[\s\S]{0,900}?expiresAt: Date\.now\(\) \+ PERMISSION_TIMEOUT/.test(s),
    `${f.split('/').pop()} 入队时带 expiresAt`);
}
// 反向探针：ACP 没有超时兜底，给它塞一个 expiresAt 就是在撒谎
const acp = src('../server/agents/adapters/acp.ts');
ok(!/type: 'permission_request'[\s\S]{0,900}?expiresAt/.test(acp), 'ACP 不入队 expiresAt（它真没有超时）');

// 投影器必须逐字段透传，否则适配器带得再对，前端也收不到（链路断在中间）。
// 这条是「闸门打到最外层的可观测量」：验的是「前端能不能收到」，不是「服务端有没有带」。
const projector = src('../server/agents/projector.ts');
ok(/type: 'permission_request'[\s\S]{0,900}?expiresAt: ev\.expiresAt/.test(projector),
  '投影器把 expiresAt 透传给前端（缺了它倒计时永远是假的）');

section('[6] permissionStore：队列、归属、送达判定');
const store = await import('../src/permissions/permissionStore.js');
const req = (requestId: string, sessionId: string) => ({
  requestId, toolUseId: 't', toolName: 'Bash', input: { command: 'ls' }, sessionId, timestamp: Date.now(),
});
// 注入假 fetch：调用方按顺序给状态码与响应体
const calls: { url: string; body: any }[] = [];
const stubFetch = (status: number, body: unknown) => {
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status, json: async () => body };
  };
};

store.__resetForTests();
stubFetch(200, { success: true });
store.push(req('r1', 'S1'), 'single', 1);
store.push(req('r2', 'S2'), 'single', 2);
eq(store.getSnapshot().items.map(i => i.request.requestId), ['r1', 'r2'], '两条并存（旧实现是第二条顶掉第一条）');
store.push(req('r1', 'S1'), 'single', 3);
eq(store.getSnapshot().items.length, 2, '同一 requestId 重复 push 幂等');
eq(store.countFor('S2'), 1, '按 sessionId 记账');

await store.answer('r2', OPT('allow_always', 'allow_always', '本会话始终允许'));
eq(calls[0].body, { requestId: 'r2', behavior: 'allow', optionId: 'allow_always' }, '带 optionId，适配器才能精确回选');
eq(store.getSnapshot().items.map(i => i.request.requestId), ['r1'], '200 才摘除');
eq(store.getSnapshot().recent.map(r => r.requestId), ['r2'], '进「最近决定」');

stubFetch(404, { error: '权限请求不存在或已超时' });
await store.answer('r1', OPT('allow_once', 'allow_once', '允许'));
eq(store.getSnapshot().items.find(i => i.request.requestId === 'r1')?.state, 'stale',
  '404 时**不摘除**，标 stale 让用户看得见「这条没生效」');

stubFetch(400, { error: '行为不合法："maybe"' });
store.push(req('r3', 'S1'), 'single', 4);
await store.answer('r3', OPT('allow_once', 'allow_once', '允许'));
eq(store.getSnapshot().items.find(i => i.request.requestId === 'r3')?.error, '行为不合法："maybe"',
  '400 带出服务端原文（前端构造错了 body 是 bug，不许静默吞）');

store.push(req('r4', 'S1'), 'single', 5);
store.markSessionEnded('S1');
eq(store.getSnapshot().items.map(i => i.request.requestId), ['r1', 'r3'],
  '收尾只清该会话的 pending：r4 被清，stale 的 r1 与 failed 的 r3 留着（前者 1.5s 自清、后者是 bug 现场）');
eq(store.getSnapshot().items.filter(i => i.request.sessionId === 'S1' && i.state === 'pending').length, 0,
  'S1 不再留僵尸 pending 卡');

section('[7] 源码契约：槽位真的换掉了，不是两套并存');
const uc = src('../src/hooks/useChat.ts');
const ugc = src('../src/hooks/useGroupChat.ts');
ok(!/useState<PermissionRequest \| null>/.test(uc), 'useChat 不再自持单值 state');
ok(!/useState<PermissionRequest \| null>/.test(ugc), 'useGroupChat 同上（两份重复翻译已合并）');
ok(/permissionStore/.test(uc) && /permissionStore/.test(ugc), '两条流都接进同一个 store');
const cm = src('../src/components/ChatMessages.tsx');
ok(!/<InlinePermissionCard/.test(cm), '审批卡不再渲染在消息流末尾');
ok(!/permissionRequest/.test(cm), 'ChatMessages 连 props 都不收这个字段（三层透传已删）');
const app = src('../src/App.tsx');
ok(/<PermissionDock/.test(app), 'Dock 挂在 App 层（不随会话卸载）');
// 反向探针：旧兜底不许被删——allow/deny 是协议下限
ok(/FALLBACK_OPTIONS/.test(src('../src/components/PermissionCard.tsx')), 'PermissionCard 仍用两档兜底');
// 「答复只有一个出口」：两条流都不许再自己 fetch /api/permission-response
ok(!/api\/permission-response/.test(uc), 'useChat 不再自己发答复（唯一出口是 store.answer）');
ok(!/api\/permission-response/.test(ugc), 'useGroupChat 同上');
// 本轮结束必须清 pending：服务端已按 cancelled 兑现，留着就是永远批不掉的僵尸卡。
// 窗口写 300 字符而不是紧邻：分支里允许带解释注释（注释正是「为什么」的载体，
// 不该为了迁就正则而删掉）。
ok(/case 'run_end':[\s\S]{0,300}?markSessionEnded\(realSessionId\)/.test(uc), 'useChat 在 run_end 收尾时摘 pending');
ok(/case 'error':[\s\S]{0,300}?markSessionEnded\(realSessionId\)/.test(uc), 'useChat 在 error 收尾时摘 pending');
ok(/case 'done':[\s\S]{0,400}?markSessionEnded\(opts\.currentSessionId/.test(ugc), 'useGroupChat 在流结束（done）时摘 pending');
// 反向探针：群聊的 error 是单条 run 级别的，清了会把同会话另一条仍在等授权的卡抹掉
ok(!/case 'error':[\s\S]{0,300}?markSessionEnded/.test(ugc), 'useGroupChat 的 error 分支不清队列（单 run 报错不牵连别人）');

section('[8] 桌面壳：通知只提醒，不批准');
const main = src('../electron/main.ts');
ok(/ipcMain\.on\('opc:permission-notify'/.test(main), '主进程有权限通知处理器');
// 红线：通知里带 buttons = 脱离应用、没看清完整命令就能点「允许」= 免密授权
ok(!/new Notification\([\s\S]{0,400}?buttons/.test(main), '通知**不带 buttons**（免密批准是红线）');
ok(/flashFrame\(true\)/.test(main), '未聚焦时闪任务栏');
ok(/isFocused\(\)/.test(main), '前台时不再弹系统横幅（只弹 Dock）');
const pre = src('../electron/preload.cjs');
ok(/notifyPermission/.test(pre) && /onPermissionFocus/.test(pre), 'preload 双向桥都在');
ok(!/ipcRenderer\.(invoke|send)\('opc:permission-response/.test(pre), '答复不走桌面壳（仍留在应用内）');
const storeSrc = src('../src/permissions/permissionStore.ts');
// 顶层不许碰 window：store 会被脱机脚本直接 import，静态引用 desktopNotify 会当场炸
ok(/import\('\.\/desktopNotify'\)/.test(storeSrc), '通知走动态 import（顶层不碰 window）');
ok(!/^import .*desktopNotify/m.test(storeSrc), '没有把 desktopNotify 写成静态 import');
const notifySrc = src('../src/permissions/desktopNotify.ts');
ok(/typeof window === 'undefined'/.test(notifySrc),
  'notifyDesktop 用 typeof window 兜底（Node 里直接写 window 是 ReferenceError，不是 undefined）');
ok(/setSessionTitleResolver/.test(storeSrc) && /setSessionTitleResolver/.test(src('../src/App.tsx')),
  '通知标题由 App 注册解析器给出（不把 UUID 写进通知）');

section('[9] 会话列表角标：订阅必须真的建立');
const cl = src('../src/components/ConversationList.tsx');
// 这条**只能**在源码层钉。浏览器层钉不住：`sendMessage()` 之后紧接一次切会话，
// `currentSessionId` 变化本身就触发重渲染，`countFor()` 顺势拿到新值 —— 于是
// 「订阅被删掉」与「订阅正常」在打靶里长得一模一样（2026-10-27 反向探针实测：
// 删掉这一行，打靶 [2] 仍然全绿）。真正的回归现场是「不切会话、只来一条请求」，
// 那种情况下没有订阅就永久停在 0。
ok(/usePermissionSnapshot\(\)/.test(cl),
  '会话列表调用了 usePermissionSnapshot()（只调 countFor 不会重渲染，角标永久停在旧值）');
ok(/countFor\(session\.id\)/.test(cl), '角标按会话 id 计数');
ok(/data-permission-waiting=\{session\.id\}/.test(cl), '角标带 data-permission-waiting 锚点（打靶按会话定位）');
ok(/data-conversation-item=\{session\.id\}/.test(cl), '会话项带稳定锚点（不靠列表序号选，排序一变就指错）');

// ── 汇总 ──
console.log('');if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n结果：${checks.total - failures.length}/${checks.total} 通过`);
  process.exit(1);
}
console.log(`结果：${checks.total}/${checks.total} 通过`);
