/**
 * A124：按钮规范闸门（先当探针用）。
 *
 * ## 为什么需要它
 *
 * 用户一轮点了五处「按钮大小、填充不一致」。查下来根因很具体：
 * `.tc-btn-brand` / `.tc-btn-secondary` 这两个类**只管颜色和状态，不管几何** ——
 * 高度、内边距、字号全靠每个站点自己写 Tailwind（`px-3 py-1.5 text-xs`、
 * `px-6 py-2 text-body`…），于是同一个类在不同弹窗里长得不一样。
 * 另一批按钮是 TDesign 的 `<Button>`（默认 34 高、`size="small"` 28 高），
 * 又是一种尺寸。三套方言同时存在。
 *
 * ## 两种模式
 *
 *   node scripts/verify-a124-button-spec.mjs --dump   # 打实测表（定档之前用）
 *   node scripts/verify-a124-button-spec.mjs          # 断言全部落在同一档（修完之后用）
 *
 * 需要先用 `npm run build`（脚本托管 dist，全离线：`/api/**` 用夹具喂）。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DUMP = process.argv.includes('--dump');
/**
 * 主题：亮暗各跑一遍（`--dark` 跑深色）。
 *
 * 本轮改动同时动了主按钮的品牌色豁免与玻璃态下限，而深色下品牌色是
 * **浅灰实心 + 深色字**（与浅色正好反色）—— 只测浅色等于没测另一半。
 * 主题走 localStorage 的 theme 键，所以用 addInitScript 在应用读之前写进去。
 *
 * 用命令行参数而不是环境变量：npm 脚本在 Windows 上走 cmd，
 * `OPC_THEME=dark node …` 那种前缀写法根本不认。
 */
const THEME = process.argv.includes('--dark') ? 'dark' : 'light';

/**
 * 统一档。三个数都不是拍的，是**实测出来的多数派**：
 * 32 高 / 15 水平内边距 / 14 字号 = TDesign 默认中档按钮的实际渲染值，
 * 也是全站最新那批按钮（自定义 Agent 的取消/创建、权限门禁的添加规则/保存）
 * 已经在用的尺寸 —— 收敛到它，组件库一处都不用改，只删各站点自定的内边距。
 */
const SPEC = {
  height: 32,
  padX: 15,
  fontSize: 14,
  /** 允许 ±1px：border 与合成会让实测有 1px 抖动 */
  tol: 1,
};

/**
 * 用户点名的那些「动作按钮」。
 *
 * 只断言这一组，而不是"页面上所有 button"：同一屏里还有三种不同角色的可点元素
 * —— 图标按钮（关闭 ×）、预设芯片（DeepSeek / 智谱 GLM 那排）、行内文字按钮
 * （记忆页每行的「打开 / 删除」）。它们本来就该比动作按钮轻一档，
 * 把它们一起按 32/15/14 钉死，等于把「层次」钉成「一律」。
 * 芯片那一档另有一条「同一组内部必须彼此一致」的断言兜着。
 */
const ACTION_LABELS = [
  // A137：「创建」是已删除的「自定义 Agent 弹窗」里的按钮，换成自建厂商表单的
  // 「测试连接」（A129 之后自建厂商的入口就搬到这里了）。
  //
  // ⚠️ 「添加」**故意不收**：它站在 `Input size="small"`（24px）右边、与输入框同高，
  //    属于**字段级**操作，不是表单提交类的动作按钮。原来把它和「保存」并列是分类错误 ——
  //    真按 32px 渲染，它会比旁边输入框高一头，反而更难看。
  '取消', '完成', '保存', '检索', '添加规则', '测试连接',
  '复制命令', '已复制', '打开项目页', '打开下载页', '打开安装页',
  '填写 API Key', '重新检测',
  // A137：分区级入口，展开后才变成表单。它一直是 24，从来没被收进清单；
  // 第二批把它升到 32（与「添加厂商」「创建 Agent」同档），现在按动作按钮管。
  '配置环境变量',
  // A137 第三批：模型清单分区唯一的操作，同为分区级动作，已升 32。
  '刷新模型清单',
];

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`);
  }
}

function resolveChrome() {
  const system = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(system)) return system;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs
    .existsSync(root)
    ? fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function serve(port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(DIST, url === '/' ? 'index.html' : url);
    if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': mime(file) });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // SPA 兜底
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DIST, 'index.html')));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

function mime(f) {
  if (f.endsWith('.js')) return 'text/javascript';
  if (f.endsWith('.css')) return 'text/css';
  if (f.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

/** 把某个容器里的所有按钮量一遍：几何 + 填充 + 图标是否垂直居中 */
async function measureIn(page, rootSel, label) {
  const out = await page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return { missing: true, rows: [] };
    const measure = el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const icon = el.querySelector('svg');
      let iconDelta = null;
      if (icon) {
        const ir = icon.getBoundingClientRect();
        // 图标中心与按钮中心的差：>1px 就是肉眼可见的「没居中」
        iconDelta = Math.round(((ir.y + ir.height / 2) - (r.y + r.height / 2)) * 10) / 10;
      }
      return {
        text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 14),
        h: Math.round(r.height),
        padL: Math.round(parseFloat(cs.paddingLeft)),
        padR: Math.round(parseFloat(cs.paddingRight)),
        fs: parseFloat(cs.fontSize),
        bg: cs.backgroundColor,
        fg: cs.color,
        // 主按钮的判据取类名，不取文字：同一个「保存」在记忆页是次档、
        // 在权限门禁是主档，按文字分类一定会分错
        primary: /tc-btn-brand|t-button--theme-primary/.test(String(el.className || '')),
        /**
         * 禁用态必须单独记一笔。
         *
         * 第一版没记，于是「完成」（未选成员时是禁用的）被判成
         * 「主按钮对比度只有 1.2:1」—— 看着像真 bug，其实是禁用态本来就该发虚
         * （`--td-bg-color-component-disabled` + `--td-text-color-disabled`）。
         * 把禁用态混进对比度断言，只会逼人把阈值调松，从而漏掉真问题。
         */
        dis: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        border: `${cs.borderTopWidth} ${cs.borderStyle}`,
        iconDelta,
      };
    };
    const els = Array.from(root.querySelectorAll('button, .t-button')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return { missing: false, rows: els.map(measure) };
  }, rootSel);

  if (out.missing) {
    console.log(`\n### ${label} —— 容器没找到（${rootSel}）`);
    return [];
  }
  console.log(`\n### ${label}  ${rootSel}`);
  console.log('  文字            高  左/右内边距  字号  图标偏移  底色 / 描边 / 前景   ← 主=实心品牌档，(禁)=禁用态');
  for (const r of out.rows) {
    console.log(
      `  ${String(r.text).padEnd(12)} ${String(r.h).padStart(3)}  ${String(r.padL).padStart(4)}/${String(r.padR).padStart(4)}  ${String(r.fs).padStart(4)}  ${String(r.iconDelta ?? '—').padStart(7)}    ${r.bg} ${r.border} ${r.fg}${r.primary ? ' 主' : ''}${r.dis ? ' (禁)' : ''}`
    );
  }
  return out.rows;
}

/** 弹窗关闭按钮的落点（距弹窗顶 / 距弹窗右）。认锚点，不猜图标 */
async function closeBtnOffset(page, rootSel) {
  return page.evaluate(sel => {
    const dlg = document.querySelector(sel);
    if (!dlg) return null;
    const btn = dlg.querySelector('[data-dialog-close], [aria-label="关闭"]');
    if (!btn) return null;
    const d = dlg.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      top: Math.round(b.y - d.y),
      right: Math.round(d.right - b.right),
      w: Math.round(b.width),
      h: Math.round(b.height),
    };
  }, rootSel);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('\n  ⚠️ 没有 dist/index.html —— 先跑 npm run build\n');
    process.exit(1);
  }
  const exe = resolveChrome();
  if (!exe) {
    console.log('\n  ⚠️ 找不到 Chrome/Chromium\n');
    process.exit(1);
  }
  const port = 4300 + (Date.now() % 400);
  const server = await serve(port);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(t => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      /* 隐私模式下 localStorage 可能不可写，不因此放弃整轮 */
    }
  }, THEME);

  // 全离线：/api 一律喂夹具，脚本不依赖真实后端
  await page.route('**/api/**', route => {
    const url = route.request().url();
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    /**
     * A137：登录配置分区缺的两条接口。
     *
     * 这两条是用真服务端把「设置 → 登录配置 → 添加厂商」走一遍、记录所有 /api 请求
     * 查出来的（`.tmp/api-scan.mjs`）：真实后端会返回 `credentials` / `agents`，
     * 而本夹具兜底 `{}`，于是 `credentials.map` 直接 undefined 崩掉整页。
     * 只补这两条，登录分区就能正常渲染出 6 颗预设芯片。
     *
     * ⚠️ `/api/agents/custom` 必须排在 `/api/agents` 前面 —— 它也会被
     *    `/api/agents(\/|$)/` 命中，排后面就永远走不到（且返回全量 agents，语义也错）。
     */
    if (/\/api\/agents\/custom/.test(url)) return send({ agents: [] });
    /**
     * A137 第三批：凭据折叠区（`AgentCredentialSettings`）要**展开**才看得到
     * 里面的 2 个 Input 和「保存/清除」。原来这里返回空数组，那一整块
     * 从来没渲染过 —— 又是一次「样本没收齐」。给一条已配置的条目，
     * `baseUrlEnv` 也带上，否则第二个 Input 仍然不渲染。
     */
    if (/\/api\/agent-credentials/.test(url)) {
      return send({
        credentials: [
          {
            agentId: 'claude',
            name: 'Claude Code',
            keyEnvs: ['ANTHROPIC_API_KEY'],
            baseUrlEnv: 'ANTHROPIC_BASE_URL',
            masked: 'sk-ant-••••7f2a',
            fromEnv: false,
            configured: true,
            hint: '留空则沿用环境变量里的值',
          },
        ],
      });
    }
    if (/\/api\/agents(\/|$)/.test(url) && !/probe/.test(url)) {
      return send({
        /**
         * 四条 install 各占一种 method（npm / script / installer / key）。
         *
         * 第一版夹具没带 install 字段，于是那四条全落进「本应用未收录入口」，
         * 用户圈出来的那五颗按钮（复制命令 / 打开项目页 / 打开安装页 / 打开下载页 /
         * 填写 API Key）**一颗都没被量到** —— 而闸门照样报 16/16。
         * 这是典型的「样本没收齐就宣布通过」，所以四种方式各铺一条。
         */
        agents: [
          { id: 'workbuddy', name: 'WorkBuddy', status: { availability: 'ready' }, capabilities: ['chat', 'code', 'tools'], kind: 'sdk' },
          {
            id: 'claude', name: 'Claude Code', status: { availability: 'needs-setup', message: '原生二进制损坏' },
            capabilities: ['chat', 'code'], kind: 'cli',
            install: { method: 'npm', command: 'npm i -g @anthropic-ai/claude-code', url: 'https://github.com/anthropics/claude-code', requires: 'node', checkedAt: new Date().toISOString() },
          },
          {
            id: 'trae', name: 'Trae', status: { availability: 'not-installed' }, capabilities: ['chat'], kind: 'cli',
            install: { method: 'installer', url: 'https://www.trae.ai/', requires: 'none', checkedAt: new Date().toISOString() },
          },
          {
            id: 'doubao', name: '豆包', status: { availability: 'needs-auth' }, capabilities: ['chat'], kind: 'http',
            install: { method: 'key', requires: 'none', checkedAt: new Date().toISOString() },
          },
          {
            // 刻意用 not-installed：「获取 Agent」只列待处理的条目，
            // 上一版把这条标成 ready，它整张卡被 isPending() 过滤掉，
            // 「打开安装页」这颗按钮因此一颗都没量到，而闸门仍然全绿。
            id: 'opencode', name: 'OpenCode', status: { availability: 'not-installed' }, capabilities: ['chat', 'code'], kind: 'cli',
            install: { method: 'script', command: 'curl -fsSL https://opencode.ai/install | bash', url: 'https://opencode.ai/', requires: 'powershell', checkedAt: new Date().toISOString() },
          },
        ],
      });
    }
    if (/\/api\/memory/.test(url)) {
      // A137 第三批：给一条技能，否则「编辑」进不去，编辑器里的
      // 「取消/保存技能」永远不渲染 —— 又是一处「量不到还说量到了」。
      return send({
        core: '# 核心记忆\n\n- 用户偏好简体中文',
        user: '# 用户画像\n\n- 在做 OPC Agent',
        skills: [{ name: 'demo-skill', tokens: 128 }],
        budget: { used: 320, limit: 800 },
      });
    }
    if (/\/api\/permission-rules/.test(url)) return send({ rules: [] });
    if (/\/api\/sessions/.test(url)) return send({ sessions: [] });
    if (/\/api\/models/.test(url)) return send({ models: [] });
    /**
     * A137：登录配置分区会 GET /api/check-login。夹具原来兜底 `{}`，
     * 于是 `envVars` 等字段全变成 undefined，整页白成「界面出错了」。
     *
     * ⚠️ 这个坑差点被误判成产品 bug：a124 报的是「脚本自身异常」，
     *    看起来像页面坏了。是起真服务端跑了一遍才分清 —— 真实数据下
     *    登录配置渲染完全正常（1 个 panel、零崩溃），所以是**夹具缺口**。
     *    判据：夹具缺接口 ⇒ 只有该脚本崩；产品真坏 ⇒ 真服务端也崩。
     */
    if (/\/api\/check-login/.test(url)) {
      return send({ isLoggedIn: false, envConfigured: false, cliConfigured: false, envVars: {} });
    }
    return send({});
  });

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const SHOTDIR = path.join(ROOT, '.render-check', 'a124', THEME);
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const shot = async name => {
    await page.screenshot({ path: path.join(SHOTDIR, name + '.png') });
    console.log('      截图 → .render-check/a124/' + name + '.png');
  };

  const groups = [];

  // 1) 设置弹窗 → 登录配置（含「添加厂商」表单，6 颗预设芯片就在里面）
  //
  // A137：这里原来点的是通讯录「+」里的「自定义 Agent」弹窗。A129 把自建厂商收进
  // 设置页之后那个弹窗**不存在了**，于是本脚本从第一组就 getByText 超时崩掉 ——
  // 后面 5 组、21 项按钮规格断言整整一个版本都没跑过。
  // ⚠️ 这类红最难发现：它不出现在断言列表里，报的是「脚本自身异常」，
  //    而 `verify:ui` 用 && 串联，只会看到链在第 59 条断掉。
  // 现在改到登录配置（自建厂商的新家）：先切分区，再展开「添加厂商」表单。
  await page.locator('[aria-label="设置"]').first().click();
  await page.waitForTimeout(700);
  await page.locator('[data-settings-section="login"]').first().click();
  await page.waitForTimeout(900);
  const addVendor = page.getByRole('button', { name: /添加厂商/ }).first();
  if (await addVendor.count()) {
    await addVendor.click();
    await page.waitForTimeout(900);
  }
  groups.push(['① 设置 · 登录配置（添加厂商表单展开）', await measureIn(page, '[data-settings-panel="login"]', '登录配置')]);
  await shot('01-settings-login');

  /**
   * ①b 环境变量配置表单（默认收起，`showEnvConfig` 初值 false）。
   *
   * A137 第二批改的就是这里：4 个字段从 24 升 32，连带「保存/取消」也升 32。
   * 上一版闸门从来没展开过它 —— 那两颗按钮**一次都没被量到**，而 ACTION_LABELS
   * 里明明有「保存」「取消」（由权限门禁和发起群聊兜着），所以"每颗都量到了"
   * 一直是假绿。这就是「样本没收齐就宣布通过」，比断言写错更难查。
   */
  const envToggle = page.getByRole('button', { name: '配置环境变量', exact: true }).first();
  if (await envToggle.count()) {
    await envToggle.click();
    await page.waitForTimeout(700);
  }
  groups.push(['①b 设置 · 登录配置（环境变量表单展开）', await measureIn(page, '[data-settings-panel="login"]', '登录配置 · 环境变量')]);
  await shot('01b-settings-env');

  /**
   * A134 硬规矩：**会被裁掉的内容区必须给「还有更多」的信号**。
   *
   * 源码级已经断言过「类挂上了」，但那只证明 `tc-scroll-fade` 在 JSX 里；
   * 挡不住 `useOverflowY` 没算出溢出（元素晚挂、观察器没触发）——
   * 那种失效下类在、规则在、界面照样硬切。所以这里量**运行时**。
   *
   * ⚠️ 配一条肯定式（下面「夹具把内容撑到溢出」）：否则 overflow<=2 时
   *    第一条恒真，等于什么都没测。
   */
  const envPanelFade = await page.evaluate(() => {
    const panel = document.querySelector('[data-settings-panel="login"]');
    const box = panel && panel.parentElement;
    if (!box) return null;
    return {
      overflow: box.scrollHeight - box.clientHeight,
      fade: box.getAttribute('data-fade'),
      hasClass: String(box.className).includes('tc-scroll-fade'),
    };
  });

  /**
   * ①c 凭据折叠区展开态（`AgentCredentialSettings`）。
   *
   * A137 第三批把这里的 2 个 Input + 「保存/清除」从 24 升到 32。
   * 之前夹具的 credentials 是空数组，这一整块**从来没渲染过**。
   */
  const credToggle = page.locator('[data-credential-toggle="claude"]').first();
  if (await credToggle.count()) {
    await credToggle.click();
    await page.waitForTimeout(700);
  }
  groups.push(['①c 设置 · 登录配置（凭据折叠展开）', await measureIn(page, '[data-settings-panel="login"]', '登录配置 · 凭据')]);
  await shot('01c-settings-credential');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 2) 通讯录 → 「+」→ 发起群聊（第 ① 组在设置弹窗里，先回通讯录）
  await page.locator('[aria-label="通讯录"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('[aria-label="添加"]').first().click();
  await page.waitForTimeout(400);
  await page.getByText('发起群聊', { exact: true }).first().click();
  await page.waitForTimeout(700);
  /**
   * 先勾一个成员再量。
   *
   * 「完成」在未选成员时是 `disabled`，而禁用态按设计就该发虚
   * （`--td-bg-color-component-disabled` + 灰字）。不勾就量的话，
   * 主按钮样本里会混进一颗天生低对比度的按钮，断言只能靠跳过禁用态来自圆其说。
   */
  await page.locator('[data-new-group-agent="workbuddy"]').first().click();
  await page.waitForTimeout(400);
  groups.push(['② 发起群聊弹窗（已勾 1 名成员）', await measureIn(page, '[data-new-group-dialog]', '发起群聊')]);
  await shot('02-new-group');
  // 关闭键落点（距弹窗顶 / 距右）：原来挂在「自定义 Agent 弹窗」上，
  // 那个弹窗没了之后就没测过。挪到这个真实存在的弹窗上。
  const groupClose = await closeBtnOffset(page, '[data-new-group-dialog]');
  console.log(`\n  发起群聊关闭按钮落点：${JSON.stringify(groupClose)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 3) 获取 Agent
  await page.locator('[aria-label="添加"]').first().click();
  await page.waitForTimeout(400);
  await page.getByText('获取 Agent', { exact: true }).first().click();
  await page.waitForTimeout(900);
  groups.push(['③ 获取 Agent 弹窗', await measureIn(page, '[data-get-agents-overlay] [role="dialog"], [data-get-agents-overlay] .tc-dialog', '获取 Agent')]);

  /**
   * A130（用户决定：弹窗固定在应用窗口内，不许移动）—— 反向探针。
   *
   * 光看「把手属性摘了没有」不够：属性摘了但事件还挂着，界面照样能拖；
   * 反过来事件摘了但 transform 被别处写死，面板也会不在正中。
   * 所以在卡头上按真实指针序列拖 120×80，再量三件事：
   *   把手不存在 / 拖完 transform 仍为空且盒子一帧未动 / 面板确实还在正中。
   */
  await shot('03-get-agents');
  const dragResult = await (async () => {
    const panel = page.locator('[data-get-agents]');
    const handles = await page.locator('[data-get-agents-overlay] [data-dialog-handle]').count();
    const before = await panel.boundingBox();
    const beforeTransform = await panel.evaluate(el => el.style.transform);
    const head = await page.locator('[data-get-agents-overlay] [role="dialog"] > div').first().boundingBox();
    if (head) {
      await page.mouse.move(head.x + 60, head.y + 12);
      await page.mouse.down();
      await page.mouse.move(head.x + 180, head.y + 92, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(150);
    const after = await panel.boundingBox();
    const afterTransform = await panel.evaluate(el => el.style.transform);
    const vp = page.viewportSize();
    return {
      handles,
      transform: afterTransform,
      // 拖完面板相对拖之前挪了多少像素；0 = 纹丝不动
      drifted: before && after ? Math.round(Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y))) : -1,
      // 面板中心离视口中心多远；≈0 = 真的固定居中，不是「停在别处」
      centerOff: after && vp
        ? Math.round(Math.max(
            Math.abs(after.x + after.width / 2 - vp.width / 2),
            Math.abs(after.y + after.height / 2 - vp.height / 2),
          ))
        : -1,
      transformChanged: !!beforeTransform || !!afterTransform,
    };
  })();
  console.log(`\n  获取 Agent 固定性：${JSON.stringify(dragResult)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 3b) Agent 资料页：头像上不该再有状态点，但下方那行文字状态必须在
  let detail = { opened: false, why: '' };
  {
    const row = page.locator('[data-agent-row="workbuddy"]').first();
    const rowCount = await page.locator('[data-agent-row]').count();
    if (rowCount === 0) {
      detail.why = '通讯录里一个行都没有（夹具没给 agents？）';
    } else {
      await row.click();
      try {
        await page.waitForSelector('[data-agent-detail-page], [data-agent-detail-overlay]', { timeout: 5000 });
        detail = { ...detail, opened: true };
      } catch {
        detail = {
          ...detail,
          opened: false,
          why: `有 ${rowCount} 行，点了没出弹窗；当前可见文本片段：` +
            (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 90))),
        };
      }
    }
    if (detail.opened) {
      const inner = await page.evaluate(() => {
        const dlg =
          document.querySelector('[data-agent-detail-page]') ||
          document.querySelector('[data-agent-detail-overlay] [role="dialog"]') ||
          document.querySelector('[data-agent-detail-overlay]');
        return {
          dotsInDialog: dlg ? dlg.querySelectorAll('[data-status-dot]').length : -1,
          hasTextStatus: /在线|未登录|缺 Key|需修复|未安装/.test(dlg ? dlg.innerText : ''),
        };
      });
      detail = { ...detail, ...inner };
    }
  }
  console.log(`  资料页：${JSON.stringify(detail)}`);
  if (detail.opened) await shot('06-detail-page');
  groups.push(['③b Agent 资料页', await measureIn(page, '[data-agent-detail-page], [data-agent-detail-overlay]', '资料页')]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 4) 设置 → 记忆 / 权限门禁
  await page.locator('[aria-label="设置"]').first().click();
  await page.waitForTimeout(700);
  /**
   * 设置弹窗的关闭键落点是 A114/A116 定过的基准（距右 12 / 距顶 16）。
   * 自定义 Agent 那颗要和它**对得上**，所以这里量的是同一个口径，
   * 而不是把某个数抄进断言里。
   */
  const settingsClose = await page.evaluate(() => {
    const btn = document.querySelector('[data-settings-close]');
    const dlg = btn?.closest('.tc-dialog') || btn?.parentElement?.parentElement;
    if (!btn || !dlg) return null;
    const d = dlg.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return { top: Math.round(b.y - d.y), right: Math.round(d.right - b.right) };
  });
  console.log(`\n  设置弹窗关闭键落点（基准）：${JSON.stringify(settingsClose)}`);

  /**
   * A130：设置弹窗同样不许拖 —— 它正是用户截图里被窗口左边缘切成半截文字那一块。
   * 它的居中基准是「标题栏下方那一行」而不是整个视口，所以这里只量
   * 「拖了动不动」，位置交给上面那条关闭键落点断言兜。
   */
  const settingsDrag = await (async () => {
    const panel = page.locator('[data-settings-panel]').first();
    const handles = await page.locator('[data-settings-panel] header [data-dialog-handle]').count();
    const before = await panel.boundingBox();
    const beforeTransform = await panel.evaluate(el => el.style.transform);
    const head = await panel.locator('header').first().boundingBox();
    if (head) {
      await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
      await page.mouse.down();
      await page.mouse.move(head.x + head.width / 2 - 260, head.y + head.height / 2 + 120, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(150);
    const after = await panel.boundingBox();
    const afterTransform = await panel.evaluate(el => el.style.transform);
    return {
      handles,
      transform: afterTransform,
      drifted: before && after ? Math.round(Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y))) : -1,
      transformChanged: !!beforeTransform || !!afterTransform,
    };
  })();
  console.log(`\n  设置弹窗固定性：${JSON.stringify(settingsDrag)}`);

  await page.locator('[data-settings-section="memory"]').first().click();
  await page.waitForTimeout(600);
  groups.push(['④ 设置 · 记忆', await measureIn(page, '[data-settings-panel="memory"]', '记忆')]);
  await shot('04-settings-memory');

  /**
   * ④b 技能编辑器展开态。
   *
   * A137 第三批把编辑器底部「取消/保存技能」从 24 升到 32（提交档跟 Textarea 走），
   * 而列表行内「编辑/删除」留 24。同一面板里两档是**故意的**，
   * 但只有把编辑器打开，这两档才会同时出现在量测里。
   */
  const skillEdit = page
    .locator('[data-settings-panel="memory"]')
    .getByRole('button', { name: '编辑', exact: true })
    .first();
  if (await skillEdit.count()) {
    await skillEdit.click();
    await page.waitForTimeout(700);
  }
  groups.push(['④b 设置 · 记忆（技能编辑器展开）', await measureIn(page, '[data-settings-panel="memory"]', '记忆 · 技能编辑器')]);
  await shot('04b-settings-memory-editor');

  /**
   * 「点了有反馈」：编辑器的**提交键**必须整颗落在面板可视区里。
   *
   * 实测过的坏状态：点行尾那颗 24 的「编辑」，编辑器渲染在折叠线以下，
   * 屏幕上唯一的变化是底边多出一行渐隐的小字 —— 看起来像没反应。
   *
   * ⚠️ 第一版判据是「编辑器顶边在可视区内」，**反向探针当场判它是假绿**：
   *    停用滚动后实测 `顶边距面板顶 619px / 面板高 637px` —— 只露 18px 的边，
   *    断言照样绿。判据必须落在「用户能不能看到那颗要按的按钮」上。
   */
  const editorReveal = await page.evaluate(() => {
    const panel = document.querySelector('[data-settings-panel="memory"]');
    const box = panel && panel.parentElement;
    const editor = document.querySelector('[data-memory-editor]');
    if (!box || !editor) return { found: !!editor, hasPanel: !!box };
    const b = box.getBoundingClientRect();
    const e = editor.getBoundingClientRect();
    const btns = editor.querySelectorAll('button');
    const last = btns[btns.length - 1];
    const lb = last ? last.getBoundingClientRect() : null;
    return {
      found: true,
      hasPanel: true,
      editorTop: Math.round(e.top - b.top),
      editorH: Math.round(e.height),
      boxH: Math.round(b.height),
      commitInside: !!lb && lb.top >= b.top - 1 && lb.bottom <= b.bottom + 1,
      commitBottomGap: lb ? Math.round(b.bottom - lb.bottom) : null,
      // 诊断：滚到哪了、还能不能继续滚
      scrollTop: Math.round(box.scrollTop),
      scrollH: box.scrollHeight,
      clientH: box.clientHeight,
      maxScroll: box.scrollHeight - box.clientHeight,
    };
  });

  await page.locator('[data-settings-section="permission"]').first().click();
  await page.waitForTimeout(600);
  groups.push(['⑤ 设置 · 权限门禁', await measureIn(page, '[data-settings-panel="permission"]', '权限门禁')]);
  await shot('05-settings-permission');

  /**
   * ⑥ 模型清单。A137 第三批把「刷新模型清单」从 24 升到 32（分区级动作）。
   * 这个面板此前**一次都没被打开过** —— 它一直挂着欠账却没人看见。
   */
  await page.locator('[data-settings-section="models"]').first().click();
  await page.waitForTimeout(700);
  groups.push(['⑥ 设置 · 模型清单', await measureIn(page, '[data-settings-panel="models"]', '模型清单')]);
  await shot('07-settings-models');

  // ── 断言 / 汇总 ──
  const all = groups.flatMap(([, rows]) => rows);
  const actions = all.filter(r => ACTION_LABELS.some(l => r.text === l || r.text.startsWith(l)));
  const chips = all.filter(r => /DeepSeek|GLM|SiliconFlow|Ollama/.test(r.text));

  if (DUMP) {
    const hs = [...new Set(actions.map(r => r.h))].sort((a, b) => a - b);
    const pxs = [...new Set(actions.map(r => `${r.padL}/${r.padR}`))];
    const fss = [...new Set(actions.map(r => r.fs))];
    console.log(`\n【动作按钮实测离散度】高度 ${hs.join('/')} 档；内边距 ${pxs.join(' ')}；字号 ${fss.join('/')}；共 ${actions.length} 颗`);
    console.log(`目标统一档：高 ${SPEC.height} / 水平内边距 ${SPEC.padX} / 字号 ${SPEC.fontSize}`);
  } else {
    const off = r =>
      Math.abs(r.h - SPEC.height) > SPEC.tol ||
      Math.abs(r.padL - SPEC.padX) > SPEC.tol ||
      Math.abs(r.padR - SPEC.padX) > SPEC.tol ||
      Math.abs(r.fs - SPEC.fontSize) > 0.6;
    const bad = actions.filter(off);
    ok(actions.length >= 10, '量到了足够多的动作按钮（少于 10 颗说明夹具没把该开的弹窗开出来 —— 这条不放松）', `${actions.length} 颗`);
    /**
     * 用户点名的每一颗都必须真的被量到。
     *
     * 上一版夹具漏了 install 元数据，那五颗按钮一颗都没渲染，闸门照样 16/16 ——
     * 「样本没收齐就宣布通过」比断言写错更难查，所以这里按名字逐颗点名。
     */
    const seen = new Set(actions.map(r => r.text));
    const REQUIRED = [
      // A137：「创建」随「自定义 Agent 弹窗」一起消失了，换成自建厂商表单的「测试连接」。
      // **不是放宽** —— 清单仍然逐颗点名，只是点的是现存的按钮。
      // 「添加」不在此列（字段级按钮，见 ACTION_LABELS 上方说明）。
      '取消', '测试连接', '完成', '保存', '检索', '添加规则',
      '复制命令', '打开项目页', '打开安装页', '打开下载页', '填写 API Key', '重新检测',
      // A137 第三批：这三个只在**展开态**才存在，是这次新开的样本。
      // 点名它们，才能防止「分组加了但面板没真展开」那种假绿。
      '保存技能', '刷新模型清单', '配置环境变量',
    ];
    const missing = REQUIRED.filter(l => !seen.has(l));
    ok(missing.length === 0, '用户点名的每一颗都真的量到了', missing.length ? `缺：${missing.join(' ')}` : `${REQUIRED.length} 颗齐`);

    // ── 溢出信号（A134 硬规矩）──
    ok(!!envPanelFade && envPanelFade.hasClass, '登录配置滚动区挂了 tc-scroll-fade',
      envPanelFade ? '' : '没找到 [data-settings-panel] 的父容器');
    ok(!!envPanelFade && envPanelFade.overflow > 2, '夹具把登录配置撑到真的溢出了（否则下一条是空断言）',
      envPanelFade ? `溢出 ${envPanelFade.overflow}px` : '');
    ok(!!envPanelFade && (envPanelFade.overflow <= 2 || envPanelFade.fade === '1'),
      '溢出时给了「还有更多」的信号（data-fade=1）',
      envPanelFade ? `溢出 ${envPanelFade.overflow}px，data-fade=${envPanelFade.fade}` : '');

    // ── 「点了有反馈」──
    ok(!!editorReveal.found, '技能编辑器真的打开了（否则下一条是空断言）',
      editorReveal.found ? '已打开' : editorReveal.hasPanel ? '夹具没给 skills，或行内「编辑」没点到' : '记忆面板没找到');
    ok(!!editorReveal.commitInside, '点「编辑」后编辑器的提交键整颗可见（点了要有反馈）',
      editorReveal.found
        ? `编辑器顶边距面板顶 ${editorReveal.editorTop}px、高 ${editorReveal.editorH}px，` +
          `面板高 ${editorReveal.boxH}px；提交键下沿距面板底 ${editorReveal.commitBottomGap}px；` +
          `scrollTop ${editorReveal.scrollTop} / 最大 ${editorReveal.maxScroll}` +
          `（scrollH ${editorReveal.scrollH} / clientH ${editorReveal.clientH}）`
        : '');
    ok(bad.length === 0, `动作按钮全部落在同一档（高 ${SPEC.height} / 内边距 ${SPEC.padX} / 字号 ${SPEC.fontSize}）`,
      bad.slice(0, 8).map(r => `${r.text}=${r.h}h/${r.padL}p/${r.fs}f`).join(' '));

    // 图标垂直居中：用户点名「添加规则的 + 没上下居中」，实测原来是 -3px
    const offIcon = actions.filter(r => r.iconDelta !== null && Math.abs(r.iconDelta) > 1);
    ok(offIcon.length === 0, '带图标的动作按钮里图标垂直居中（偏移 ≤ 1px）',
      offIcon.slice(0, 5).map(r => `${r.text}=${r.iconDelta}px`).join(' '));

    /**
     * 主 / 次按钮的「填充」必须分得开。
     *
     * 有一条把 base 档按钮整体中性化的规则（带 important），历史上是为了躲开
     * 腾讯默认的蓝按钮；但它连 theme=primary 一起压平了 —— 实测「创建」和
     * 「取消」底色都是 rgb(245,245,245)，主操作完全没有主次。
     * 只断言尺寸与内边距**查不出这个**，所以这里直接比底色与底/字对比度。
     */
    const lum = c => {
      const v = (String(c).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (v.length < 3) return 0;
      const f = x => (x <= 15 ? x / 255 / 12.92 : Math.pow((x / 255 + 0.055) / 1.055, 2.4));
      return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
    };
    const primaries = actions.filter(r => r.primary && !r.dis);
    const disabledPrimary = actions.filter(r => r.primary && r.dis);
    const seconds = actions.filter(r => !r.primary && !r.dis);
    ok(primaries.length >= 2 && seconds.length >= 3, '主按钮与次按钮都量到了（不然下面两条是空断言）', `主 ${primaries.length} / 次 ${seconds.length}`);
    const sameAsSecondary = primaries.filter(p => seconds.some(q => q.bg === p.bg));
    ok(sameAsSecondary.length === 0, '主按钮底色与次按钮不同（主操作要看得出是主操作）',
      sameAsSecondary.map(r => `${r.text}=${r.bg}`).join(' '));
    const weak = primaries.filter(p => {
      const a = lum(p.bg);
      const b = lum(p.fg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5;
    });
    ok(weak.length === 0, '可点的 主按钮 底/字 对比度 ≥ 4.5:1（禁用态另算，见下）',
      weak.map(r => `${r.text} ${r.bg}/${r.fg}`).join(' '));
    ok(
      disabledPrimary.length === 0 ||
        disabledPrimary.every(r => r.bg === disabledPrimary[0].bg),
      '禁用态主按钮彼此同色（发虚要发得一致）',
      disabledPrimary.map(r => `${r.text}=${r.bg}`).join(' ')
    );
    const blue = primaries.filter(p => {
      const v = (String(p.bg).match(/[\d.]+/g) ?? []).map(Number);
      return v.length >= 3 && v[2] > v[0] + 30 && v[2] > v[1] + 10;
    });
    ok(blue.length === 0, '主按钮没有蓝色（本项目的品牌色是近黑，不是腾讯蓝）',
      blue.map(r => `${r.text}=${r.bg}`).join(' '));

    // 预设芯片是另一档，但同一组内部必须彼此一致（不能三颗三种尺寸）
    const chipHs = [...new Set(chips.map(r => r.h))];
    ok(chips.length >= 3 && chipHs.length === 1, '常用平台芯片自成一档且组内一致',
      `${chips.length} 颗，高度 ${chipHs.join('/')}`);

    // A130：弹窗固定，不许拖动 —— 三条一起断，缺一条就是「假固定」
    ok(dragResult.handles === 0, '弹窗卡头上没有拖拽把手', `data-dialog-handle = ${dragResult.handles}`);
    ok(
      dragResult.drifted === 0 && !dragResult.transformChanged,
      '真鼠标拖 120×80 后弹窗纹丝不动',
      JSON.stringify(dragResult).slice(0, 110)
    );
    ok(
      dragResult.centerOff >= 0 && dragResult.centerOff <= 8,
      '拖完之后弹窗仍停在视口正中',
      `中心偏移 ${dragResult.centerOff}px`
    );
    ok(
      settingsDrag.handles === 0 && settingsDrag.drifted === 0 && !settingsDrag.transformChanged,
      '设置弹窗拖不动（A130 固定）',
      JSON.stringify(settingsDrag).slice(0, 110)
    );

    /**
     * 关闭键落点：直接钉 A114/A116 定的基准（距顶 12 / 距右 16）。
     *
     * A137：原来这条是「自定义 Agent 弹窗 vs 设置弹窗，两者相差 ≤2px」。
     * 那个弹窗没了之后改成比「获取 Agent」，实测 45/461 —— 不是落点不同，
     * 而是它的关闭键根本不在右上角（overlay 结构与 .tc-dialog 不同），取样就取错了。
     *
     * 顺手把这条**变强**了：原来两个弹窗互相比，两个一起漂到 20/30 也会绿；
     * 现在钉绝对值，谁漂谁红。基准值来自 settingsClose 的既有实测。
     */
    ok(
      settingsClose && Math.abs(settingsClose.top - 12) <= 2 && Math.abs(settingsClose.right - 16) <= 2,
      '弹窗关闭键落在基准位置（距顶 12 / 距右 16）',
      settingsClose ? `${settingsClose.top}/${settingsClose.right}` : '没量到'
    );

    ok(detail.opened, '资料页能打开（否则下面两条是空断言）');
    ok(detail.opened && detail.dotsInDialog === 0, '资料页头像右下角不再有状态点', `实测 ${detail.dotsInDialog} 颗`);
    ok(detail.opened && detail.hasTextStatus, '文字状态行仍在（去掉点不能把信息一起去掉）');

    // 源码契约：几何只允许在 index.css 一处定义
    const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
    ok(
      /--tc-btn-height: 32px/.test(css) && /\.tc-btn-brand,\s*\n\.tc-btn-secondary \{/.test(css),
      '[契约] 按钮几何收在 index.css 一处（令牌 + 两个类共用）'
    );
    const offenders = [];
    for (const f of ['src/components/InstallCard.tsx', 'src/components/NewGroupDialog.tsx', 'src/components/GetAgentsDialog.tsx', 'src/components/ConfirmDialog.tsx', 'src/components/RemarkDialog.tsx', 'src/components/AgentDetailPanel.tsx', 'src/App.tsx']) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const hits = s.match(/tc-btn-(brand|secondary)[^"]*px-[^\s"]*/g) ?? [];
      if (hits.length) offenders.push(`${f}:${hits.length}`);
    }
    ok(offenders.length === 0, '[契约] 没有站点再自带 Tailwind 内边距（就是这条制造了五处不一致）', offenders.join(' '));

    /**
     * A130 源码契约：整个 src/ 里不许再有拖拽接线。
     * 逐个弹窗做浏览器冒烟要开三遍夹具，而这条一次覆盖全部弹窗 ——
     * 上面两条「拖不动」是行为证据，这条是防止第四个弹窗悄悄接回去。
     */
    const walk = (dir, acc = []) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, acc);
        else if (/\.(ts|tsx)$/.test(e.name)) acc.push(rel);
      }
      return acc;
    };
    const wired = [];
    for (const f of walk('src')) {
      if (f.endsWith('hooks/useDraggableDialog.ts')) continue;
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const hits = s.match(/useDraggableDialog|data-dialog-handle/g) ?? [];
      if (hits.length) wired.push(`${f}:${hits.length}`);
    }
    ok(wired.length === 0, '[契约] src 里没有任何弹窗再接拖拽', wired.join(' '));
  }

  await browser.close();
  server.close();
  if (!DUMP) {
    console.log(`\n${failures.length ? '❌' : '✅'} A124 按钮规范（${THEME === 'dark' ? '深色' : '浅色'}）：${pass}/${pass + fail} 通过`);
    for (const f of failures) console.log(`   · ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch(err => {
  console.error('A124 脚本自身异常：', err);
  process.exit(1);
});
