/**
 * A63 验证：工作区（Workspace）方案二 —— 会话栏头徽标 + 弹出面板的全链路。
 *
 * 覆盖四件**不看代码就很容易搞错**的事：
 *
 *   1. `validateDirectory` 的三种结局 —— 只对「确定不存在」说不；
 *      stat 抛别的错（权限 / 网络盘）必须放过，否则误杀能用的会话。
 *   2. `getRecentDirectories` 的口径 —— 「用过才算」：同一目录被多个会话
 *      引用只出一条、按最近一次活跃倒序、NULL/空串不算、LIMIT 生效。
 *   3. 生效顺序 —— /api/chat 的 cwd 必须 `请求体 > 会话里存的值 > 进程目录`。
 *      少了中间那一级，就是「会话里改了工作区却不生效」的 bug。
 *   4. 原生能力接线 —— preload 暴露的两颗函数与 main.ts 的两个 handler
 *      必须一一对应；前端三处入口（徽标面板 / 新对话页 / useSessions）
 *      必须真的接在会话状态上，而不是各写一份。
 *
 * 运行时部分用独立临时库（`OPC_DATA_DIR`）—— `server/db.ts` 在 import 时
 * 就会打开数据库并跑迁移，直接 import 会动到 `data/chat.db` 真实用户数据。
 * 源码契约部分读文件断言：import `server/index.ts` 会连带 `app.listen` +
 * Agent 探测，验证脚本不能那么干。
 *
 * 运行：npx tsx scripts/verify-workspace.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
const checks = { total: 0 };

function ok(cond: boolean, label: string, detail?: string) {
  checks.total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}
function eq<T>(actual: T, expected: T, label: string) {
  checks.total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n      实际: ${JSON.stringify(actual)}\n      期望: ${JSON.stringify(expected)}`);
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

async function main() {
  // ============ 1. validateDirectory 的三种结局 ============
  {
    const { validateDirectory } = await import('../server/workspaceDir.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-ws-'));

    eq(validateDirectory(tmp), 'ok', '校验：真实目录 → ok');

    const missing = path.join(tmp, 'no-such-dir');
    eq(validateDirectory(missing), 'not-found', '校验：不存在的目录 → not-found');

    // 存在但是个文件：对「工作目录」而言就是坏的
    const aFile = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(aFile, 'x', 'utf8');
    eq(validateDirectory(aFile), 'not-found', '校验：路径指向文件 → not-found（文件不能当工作目录）');

    // 未知错误（不是 ENOENT）必须放过：查不明白不能硬拦。
    // 用一个超长路径触发 ENAMETOOLONG 来造这个场景（Windows 上最稳）。
    const tooLong = path.join(tmp, 'x'.repeat(5000));
    const verdict = validateDirectory(tooLong);
    ok(
      verdict === 'unknown' || verdict === 'not-found',
      '校验：非 ENOENT 的错误不误判为 ok',
      `实际: ${verdict}`
    );
    ok(
      verdict !== 'ok',
      '校验：超长路径不被当成可用目录',
      `实际: ${verdict}`
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ============ 2. getRecentDirectories 的口径 ============
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-wsdb-'));
    process.env.OPC_DATA_DIR = tmp;
    const db = await import('../server/db.js');

    const mk = (id: string, cwd: string | null, updatedAt: string) => ({
      id,
      title: id,
      model: 'm',
      agent_id: 'a',
      sdk_session_id: null,
      kind: 'direct' as const,
      agent_ids: null,
      orchestration: null,
      cwd,
      reasoning_effort: null,
      scenario_id: null,
      system_prompt: null,
      pinned: 0,
      created_at: updatedAt,
      updated_at: updatedAt,
    });

    // 三个目录、四个会话：dir-b 被两个会话引用（应只出一条，取最近时间），
    // dir-a 之后被所有会话放弃（cwd 清空，应消失），另有一个 cwd=NULL 的老会话。
    db.createSession(mk('s1', 'C:\\ws\\dir-a', '2026-10-20T10:00:00.000Z'));
    db.createSession(mk('s2', 'C:\\ws\\dir-b', '2026-10-20T11:00:00.000Z'));
    db.createSession(mk('s3', null, '2026-10-20T12:00:00.000Z'));
    db.createSession(mk('s4', 'C:\\ws\\dir-b', '2026-10-21T09:00:00.000Z'));
    db.createSession(mk('s5', 'C:\\ws\\dir-c', '2026-10-19T09:00:00.000Z'));

    eq(
      db.getRecentDirectories(),
      ['C:\\ws\\dir-b', 'C:\\ws\\dir-a', 'C:\\ws\\dir-c'],
      '口径：按目录的最近一次活跃倒序；被多会话引用的目录只出一条'
    );

    // LIMIT 生效
    eq(db.getRecentDirectories(2), ['C:\\ws\\dir-b', 'C:\\ws\\dir-a'], '口径：LIMIT 生效');

    // 放弃的目录消失：s1 是 dir-a 的唯一引用
    db.updateSession('s1', { cwd: null });
    eq(
      db.getRecentDirectories().includes('C:\\ws\\dir-a'),
      false,
      '口径：最后一个引用该目录的会话清空 cwd 后，它从最近列表消失'
    );

    // 空串不算数（PATCH 的 `cwd: ''` → 存 null，但库里历史行可能有空串）
    db.createSession(mk('s6', '', '2026-10-21T10:00:00.000Z'));
    eq(db.getRecentDirectories().includes(''), false, '口径：空串 cwd 不进最近列表');

    // 没有任何目录时返回空数组（不抛）
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      db.updateSession(id, { cwd: null });
    }
    eq(db.getRecentDirectories(), [], '口径：全空时返回空数组');

    // 收尾：sqlite 连接仍开着（db.ts 不导出 close），Windows 上临时库
    // 大概率删不掉 —— 与 verify-session-persist 同一处理：尽力而为，
    // 删不掉就留给系统临时目录回收，绝不让清理失败变成验证失败。
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.OPC_DATA_DIR;
  }

  // ============ 3. 源码契约：接线必须真的存在 ============
  {
    // —— 3a. Electron 原生能力：preload 与 main 一一对应 ——
    const preload = read('electron/preload.cjs');
    ok(preload.includes("pickDirectory()"), '契约：preload 暴露 pickDirectory');
    ok(preload.includes("ipcRenderer.invoke('opc:pick-directory')"), '契约：pickDirectory 走 opc:pick-directory 通道');
    ok(preload.includes('revealInFolder(path)'), '契约：preload 暴露 revealInFolder');
    ok(preload.includes("ipcRenderer.invoke('opc:reveal-in-folder', path)"), '契约：revealInFolder 走 opc:reveal-in-folder 通道');

    const main = read('electron/main.ts');
    ok(main.includes("ipcMain.handle('opc:pick-directory'"), '契约：main 注册 opc:pick-directory');
    ok(main.includes('dialog.showOpenDialog'), '契约：选目录用原生 dialog.showOpenDialog');
    ok(main.includes("properties: ['openDirectory']"), '契约：对话框只能选目录（不能选文件）');
    ok(main.includes("ipcMain.handle('opc:reveal-in-folder'"), '契约：main 注册 opc:reveal-in-folder');
    ok(main.includes('shell.showItemInFolder'), '契约：reveal 用 shell.showItemInFolder');
    ok(/import \{[^}]*dialog[^}]*\} from 'electron'/.test(main), '契约：main.ts  import 了 dialog');

    // —— 3b. 后端：三个写入口同一把尺子 + 生效顺序 ——
    const srv = read('server/index.ts');
    // 引号无关：index.ts 用的是双引号，别把断言钉死在一种引号风格上
    ok(/import\s*\{\s*validateDirectory\s*\}\s*from\s*["']\.\/workspaceDir\.js["']/.test(srv), '契约：server 从 workspaceDir 引入校验');

    // PATCH /api/sessions/:id：非空 cwd 先校验，400 说人话
    const patchIdx = srv.indexOf('app.patch("/api/sessions/:sessionId"');
    const patchBody = srv.slice(patchIdx, srv.indexOf('app.delete("/api/sessions/:sessionId"'));
    ok(patchBody.includes("validateDirectory(cwd) === 'not-found'"), '契约：PATCH 会话校验工作目录');
    ok(patchBody.includes('工作目录不存在'), '契约：PATCH 校验失败的报错说人话（不是裸 ENOENT）');

    // POST /api/sessions：同一把尺子
    const postIdx = srv.indexOf('app.post("/api/sessions"');
    const postBody = srv.slice(postIdx, patchIdx);
    ok(postBody.includes("validateDirectory(cwd) === 'not-found'"), '契约：建会话同样校验工作目录');

    // POST /api/chat：开流之前校验 + 生效顺序
    const chatIdx = srv.indexOf('app.post("/api/chat"');
    const chatBody = srv.slice(chatIdx, srv.indexOf('app.post("/api/group-chat"'));
    ok(chatBody.includes("validateDirectory(cwd) === 'not-found'"), '契约：/api/chat 在建会话/起流之前校验');
    ok(
      chatBody.includes('cwd: cwd || session.cwd || process.cwd()'),
      '契约：生效顺序 = 请求体 > 会话里存的值 > 后端进程目录（少了中间级就是改了不生效）'
    );

    // 最近目录端点
    ok(srv.includes('app.get("/api/recent-directories"'), '契约：GET /api/recent-directories 存在');
    ok(srv.includes('db.getRecentDirectories()'), '契约：端点从 db.getRecentDirectories 取数');

    // db 口径
    const dbSrc = read('server/db.ts');
    ok(dbSrc.includes('export function getRecentDirectories'), '契约：db 导出 getRecentDirectories');
    ok(dbSrc.includes('GROUP BY cwd') && dbSrc.includes('MAX(updated_at)'), '契约：按目录分组、取最近一次活跃（不是行的 updated_at）');

    // —— 3c. 前端：徽标接在会话状态上 ——
    const chatHeader = read('src/components/ChatHeader.tsx');
    ok(chatHeader.includes("import { WorkspaceBadge }"), '契约：ChatHeader 引入 WorkspaceBadge');
    ok(chatHeader.includes('onCwdChange?: (cwd: string) => void'), '契约：ChatHeader 接收 onCwdChange');
    ok(chatHeader.includes('{onCwdChange && <WorkspaceBadge'), '契约：传了 onCwdChange 才渲染徽标（不传不摆）');

    const appSrc = read('src/App.tsx');
    ok(appSrc.includes('cwd={currentSession.cwd}'), '契约：App.tsx 把会话 cwd 传给栏头');
    ok(appSrc.includes('onCwdChange={cwd => void setSessionCwd(currentSession.id, cwd)}'), '契约：App.tsx 把换目录接到 setSessionCwd');

    const sessionsSrc = read('src/hooks/useSessions.ts');
    ok(sessionsSrc.includes('const setSessionCwd = useCallback'), '契约：useSessions 提供 setSessionCwd');
    ok(sessionsSrc.includes('setSessionCwd,'), '契约：setSessionCwd 被导出（hook 返回值里）');
    ok(sessionsSrc.includes("body: JSON.stringify({ cwd: value || null })"), '契约：setSessionCwd 走 PATCH（空串 = 清空）');
    // 乐观改 + 失败回滚：与 setSessionReasoningEffort 同构，缺一条就是静默失败
    ok(
      /setSessionCwd[\s\S]*?setSessions\(p => p\.map\(s => \(s\.id === sessionId \? \{ \.\.\.s, cwd: value \|\| undefined \} : s\)\)\)/.test(sessionsSrc),
      '契约：setSessionCwd 先乐观改本地'
    );
    ok(
      /setSessionCwd[\s\S]*?setSessions\(p => p\.map\(s => \(s\.id === sessionId \? \{ \.\.\.s, cwd: prev \} : s\)\)\)/.test(sessionsSrc),
      '契约：setSessionCwd 失败回滚（不静默失败）'
    );

    const wsSrc = read('src/workspace.ts');
    ok(wsSrc.includes('export async function pickDirectory'), '契约：workspace.ts 导出 pickDirectory');
    ok(wsSrc.includes('export function revealInFolder'), '契约：workspace.ts 导出 revealInFolder');
    ok(wsSrc.includes('export function hasNativeDialogs'), '契约：workspace.ts 导出 hasNativeDialogs');
    ok(wsSrc.includes('export function dirName'), '契约：workspace.ts 导出 dirName');

    const badgeSrc = read('src/components/WorkspaceBadge.tsx');
    ok(badgeSrc.includes("fetch('/api/recent-directories')"), '契约：徽标面板拉最近目录');
    ok(badgeSrc.includes('切换目录'), '契约：面板有「切换目录」');
    ok(badgeSrc.includes('在资源管理器中打开'), '契约：面板有「在资源管理器中打开」');
    ok(badgeSrc.includes('最近目录'), '契约：面板有「最近目录」一节');
    ok(badgeSrc.includes('hasNativeDialogs()'), '契约：没有原生对话框时面板说明白（不摆死按钮）');
    ok(badgeSrc.includes('disabled={!hasCwd}'), '契约：没设工作目录时 reveal 按钮禁用（不摆死按钮）');

    const newChatSrc = read('src/components/NewChatView.tsx');
    ok(newChatSrc.includes('hasNativeDialogs()'), '契约：新对话页的选择目录按钮按原生能力条件渲染');
    ok(newChatSrc.includes('pickDirectory()'), '契约：新对话页的按钮走同一颗原生对话框');
  }

  // ============ 汇总 ============
  console.log(`工作区（A63）断言：${checks.total - failures.length}/${checks.total} 通过`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ 校验三结局 / 最近目录口径 / 生效顺序 / 原生接线均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
