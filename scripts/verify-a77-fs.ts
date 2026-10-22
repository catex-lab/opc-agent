/**
 * A77 验证：工作区文件面板 —— 只读边界与 containment。
 *
 * 这个功能的全部风险都集中在两件事上，脚本也只钉这两件：
 *
 *   1. **路径必须锁在会话 cwd 里**。`..`、绝对路径、盘符相对路径、
 *      指向外部的符号链接，四种逃逸一个都不能过。逃过去就意味着
 *      面板能列出整个文件系统。
 *   2. **只读**。组件里不许出现写请求（POST/PUT/DELETE）。
 *
 * 其余部分（排序、截断、错误文案）是体验问题，挂不了安全；
 * 只对会被用户看见的「挂了也看不出来」的几条做断言。
 *
 * 运行时部分全部用临时目录，不碰真实数据。
 * 源码契约部分读文件断言：`server/index.ts` 一 import 就会 app.listen +
 * 跑 Agent 探测，验证脚本不能那么干（与 verify-workspace.ts 同一理由）。
 *
 * 运行：npx tsx scripts/verify-a77-fs.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures: string[] = [];
let skips = 0;
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
function skip(label: string, why: string) {
  checks.total++;
  skips++;
  console.log(`  ⊘ 跳过：${label}（${why}）`);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

async function main() {
  const { listDir, resolveInside, MAX_ENTRIES } = await import('../server/fs.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-fs-'));
  const root = path.join(tmp, 'project');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'readme', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'a2.ts'), 'a', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'a10.ts'), 'b', 'utf8');

  // ============ 1. resolveInside：正常相对路径 ============
  {
    const atRoot = resolveInside(root, '');
    ok('abs' in atRoot && !('error' in atRoot), '解析：空串 → 根目录');
    const inSrc = resolveInside(root, 'src');
    ok('abs' in inSrc && !('error' in inSrc), '解析：单段目录名');
    eq(
      'abs' in inSrc && !('error' in inSrc) ? inSrc.abs : '',
      fs.realpathSync(path.join(root, 'src')),
      '解析：解析结果指向真实目录'
    );
    const mixed = resolveInside(root, 'src\\index.ts');
    ok('abs' in mixed && !('error' in mixed), '解析：接受反斜杠输入');
  }

  // ============ 2. resolveInside：四种逃逸 ============
  {
    eq(resolveInside(root, '../').error, 'escape', '逃逸：纯上跳 → escape');
    eq(resolveInside(root, '../../etc/passwd').error, 'escape', '逃逸：上跳 + 绝对路径 → escape');
    eq(resolveInside(root, '..\\..\\..\\Windows\\System32').error, 'escape', '逃逸：反斜杠上跳 → escape');

    // 绝对路径：三种写法都要拒。`C:foo` 这种盘符相对路径尤其要单独测 ——
    // path.resolve(root, 'C:foo') 在 Windows 上会直接返回 C:foo，看起来像被接住了。
    eq(resolveInside(root, '/etc/passwd').error, 'escape', '逃逸：POSIX 绝对路径 → escape');
    if (process.platform === 'win32') {
      eq(resolveInside(root, 'C:\\Windows\\System32').error, 'escape', '逃逸：Windows 绝对路径 → escape');
      eq(resolveInside(root, 'C:foo').error, 'escape', '逃逸：盘符相对路径 → escape');
      eq(resolveInside(root, '\\\\server\\share\\x').error, 'escape', '逃逸：UNC 路径 → escape');
    } else {
      skip('Windows 专有逃逸用例', '非 Windows');
    }

    // 根目录本身不存在 → no-root（不是 escape：用户可能删了目录，要说清楚是哪儿的问题）
    eq(resolveInside(path.join(tmp, 'no-such'), 'src').error, 'no-root', '边界：根目录不存在 → no-root');
  }

  // ============ 3. 符号链接 ============
  {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');

    // 目录链接：Windows 上必须用 junction（symlink 需要管理员）
    let linkDir: string | null = null;
    try {
      const linkPath = path.join(root, 'linked-dir');
      try {
        fs.symlinkSync(outside, linkPath, 'junction');
      } catch {
        fs.symlinkSync(outside, linkPath, 'dir');
      }
      linkDir = linkPath;
    } catch (e) {
      skip('符号链接逃逸用例', `当前账户无创建链接权限：${(e as Error).message}`);
    }

    if (linkDir) {
      eq(resolveInside(root, 'linked-dir').error, 'escape', '逃逸：指向外部的目录链接 → escape');
      eq(resolveInside(root, 'linked-dir/secret.txt').error, 'escape', '逃逸：经外部链接进入文件 → escape');

      // listDir 同样不能把它列出来
      const list = listDir(root, '');
      ok(!('error' in list), '链接：根目录可列');
      if (!('error' in list)) {
        eq(
          list.entries.some(e => e.name === 'linked-dir'),
          false,
          '链接：指到外部的目录链接不出现在条目里'
        );
      }
    }

    // 断链：不展示，且报 not-found（而不是显示成一个点不动的条目）
    try {
      const broken = path.join(root, 'broken');
      try {
        fs.symlinkSync(path.join(tmp, 'nowhere'), broken, 'junction');
      } catch {
        fs.symlinkSync(path.join(tmp, 'nowhere'), broken, 'file');
      }
      const list = listDir(root, '');
      if (!('error' in list)) {
        eq(
          list.entries.some(e => e.name === 'broken'),
          false,
          '链接：断链不出现在条目里'
        );
      }
      eq(resolveInside(root, 'broken').error, 'not-found', '链接：断链 → not-found');
    } catch (e) {
      skip('断链用例', `当前账户无创建链接权限：${(e as Error).message}`);
    }
  }

  // ============ 4. listDir：排序、隐藏项、截断 ============
  {
    const list = listDir(root, 'src');
    ok(!('error' in list), '列表：src 可列');
    if (!('error' in list)) {
      eq(
        list.entries.map(e => e.name),
        ['a2.ts', 'a10.ts', 'index.ts'],
        '列表：文件按 numeric 排序（a2 在 a10 前，不是字典序）'
      );
      eq(
        list.path,
        'src',
        '列表：返回的相对路径与请求一致'
      );
    }

    const rootList = listDir(root, '');
    ok(!('error' in rootList), '列表：根目录可列');
    if (!('error' in rootList)) {
      eq(
        rootList.entries.map(e => e.name),
        ['node_modules', 'src', '.gitignore', 'README.md'],
        '列表：目录在前、文件在后；隐藏文件不隐藏（.gitignore 要看得到）'
      );
      eq(rootList.truncated, false, '列表：未超上限时 truncated 为 false');
      ok(rootList.entries[0].type === 'dir', '列表：条目带 type');
      // size 只挂在文件上：目录不报 size，否则「3.2 KB 的目录」这种假数字会出现在界面上
      const firstFile = rootList.entries.find(e => e.type === 'file');
      ok(typeof firstFile?.size === 'number', '列表：文件带 size');
      eq(
        rootList.entries.filter(e => e.type === 'dir').every(e => e.size === undefined),
        true,
        '列表：目录不带 size'
      );
    }

    // 单层超过上限：truncated 必须置 true，且只返回 MAX_ENTRIES 条
    const crowd = path.join(tmp, 'crowd');
    fs.mkdirSync(crowd);
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      fs.writeFileSync(path.join(crowd, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const crowdList = listDir(crowd, '');
    if (!('error' in crowdList)) {
      eq(crowdList.entries.length, MAX_ENTRIES, '截断：只返回 MAX_ENTRIES 条');
      eq(crowdList.truncated, true, '截断：超上限时 truncated 为 true');
    }

    // 指到文件 → not-dir（不是把文件当目录列）
    eq(listDir(root, 'README.md').error, 'not-dir', '边界：路径指向文件 → not-dir');
    // 不存在 → not-found
    eq(listDir(root, 'nope').error, 'not-found', '边界：不存在 → not-found');
  }

  // ============ 5. 源码契约 ============
  {
    // —— 5a. 路由：根来自服务端，不来自请求 ——
    const srv = read('server/index.ts');
    ok(srv.includes('app.get("/api/fs/list"'), '契约：GET /api/fs/list 存在');
    ok(
      /import\s*\{\s*FS_ERROR_TEXT,\s*listDir/.test(srv) || /import\s*\{\s*listDir/.test(srv),
      '契约：路由从 server/fs.js 引入实现'
    );

    const idx = srv.indexOf('app.get("/api/fs/list"');
    const body = srv.slice(idx, srv.indexOf('app.get("/api/', idx + 10));
    ok(body.includes('db.getSession(sessionId)'), '契约：根目录来自会话记录（不是请求参数）');
    ok(body.includes('session.cwd'), '契约：用 session.cwd 当根');
    ok(body.includes('"no-cwd"'), '契约：没绑工作目录时返回 no-cwd（不退回进程目录）');
    ok(body.includes('listDir(session.cwd, rel)'), '契约：相对路径交给 listDir 做 containment');
    ok(!/path\.join\(session\.cwd\s*,/.test(body), '契约：路由不自己拼路径（拼路径的统一入口只有 fs.ts）');
    ok(!body.includes('fs.readdirSync'), '契约：路由不直接碰文件系统（读写都在 fs.ts）');

    // —— 5b. Electron：打开文件走原生能力，且只认绝对路径 ——
    const preload = read('electron/preload.cjs');
    ok(preload.includes('openPath(path)'), '契约：preload 暴露 openPath');
    ok(preload.includes("ipcRenderer.invoke('opc:open-path', path)"), '契约：openPath 走 opc:open-path 通道');

    const main = read('electron/main.ts');
    ok(main.includes("ipcMain.handle('opc:open-path'"), '契约：main 注册 opc:open-path');
    ok(main.includes('await shell.openPath(p)'), '契约：用 shell.openPath 交给系统默认程序');
    ok(main.includes("if (!isAbsolute(p)) return '只接受绝对路径'"), '契约：只接受绝对路径（相对路径按进程 cwd 解析会打开到别处）');
    ok(/import \{[^}]*isAbsolute[^}]*\} from 'node:path'/.test(main), '契约：main.ts 引入了 isAbsolute');

    // —— 5c. 前端：开关有、面板按条件渲染、组件只读 ——
    const panel = read('src/components/WorkspacePanel.tsx');
    ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(panel), '契约：面板组件只发 GET（没有任何写请求）');
    ok(!panel.includes('/api/fs/delete') && !panel.includes('/api/fs/write'), '契约：面板不调用任何写接口');
    ok(panel.includes('/api/fs/list'), '契约：面板只读 /api/fs/list');
    ok(panel.includes('bridge?.openPath'), '契约：点文件走原生 openPath');
    ok(panel.includes('浏览器开发态'), '契约：没有原生能力时说明白（不假装能打开）');
    ok(panel.includes('这个会话还没绑定工作目录'), '契约：没绑 cwd 时给出指引');

    const app = read('src/App.tsx');
    ok(app.includes('const showWorkspace ='), '契约：App.tsx 计算 showWorkspace');
    const showWs = app.slice(app.indexOf('const showWorkspace ='), app.indexOf('const showWorkspace =') + 300);
    ok(showWs.includes("currentSession.kind !== 'group'"), '契约：群聊不渲染工作区（成员 cwd 各不相同）');
    ok(showWs.includes('!compact'), '契约：窄屏单栏模式不渲染（300px 会挤垮聊天区）');
    ok(app.includes('<WorkspacePanel'), '契约：App.tsx 挂载 WorkspacePanel');
    ok(app.includes('onToggleWorkspace={compact ? undefined : toggleWorkspace}'), '契约：窄屏不传开关（不摆假按钮）');

    const header = read('src/components/ChatHeader.tsx');
    ok(header.includes('onToggleWorkspace?: () => void'), '契约：ChatHeader 接收开关回调');
    ok(header.includes('{onToggleWorkspace && ('), '契约：不传回调就不渲染按钮');
    ok(header.includes('aria-pressed={!!workspaceOpen}'), '契约：开关有可访问状态');
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  // ============ 汇总 ============
  const passed = checks.total - failures.length;
  console.log(`工作区文件面板（A77）断言：${passed}/${checks.total} 通过${skips ? `（跳过 ${skips}）` : ''}`);
  if (failures.length) {
    console.log('\n✗ 失败项：');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('✓ containment / 只读 / 原生接线 / 渲染条件均符合预期');
}

main().catch(e => {
  console.error('验证脚本自身出错:', e);
  process.exit(1);
});
