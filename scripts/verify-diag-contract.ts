/**
 * P0 诊断分类学契约闸门（shared/diagnostics，接入架构收敛方案 2026-11-14）。
 *
 * 四层：
 *   [U] 离线单元 —— classifyErrorMessage 样本（含「429 先于 401」的既定顺序）、
 *       availabilityToDiagnostic 七档映射、auth missing/expired 上下文细分、
 *       toAgentInfo 派生（运行期事实优先于探测）
 *   [C] 完整性 —— 九类每类都有 zh/en 文案键；除 ok 外每类必须有动作；
 *       recovery.ts 与 shared 的文本归类口径必须同分类（镜像防漂移）
 *   [S] 源码契约 —— recordError 接线、toAgentInfo 派生、前端类型再导出
 *   [P] 反向探针 —— 内存变异源码，断言契约变红（--probe=...）
 *
 * 运行：npx tsx scripts/verify-diag-contract.ts [--probe=no-order|no-action|no-wiring]
 */

// 必须第一个 import：临时数据目录，db 链不碰真实 data/
import './lib/temp-data-dir.js';

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const probe = (() => {
  const eq = process.argv.find(a => a.startsWith('--probe='));
  if (eq) return eq.slice('--probe='.length);
  const i = process.argv.indexOf('--probe');
  return i >= 0 ? process.argv[i + 1] : null;
})();

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    if (!probe) console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

// ── 源文件缓存（探针模式下按变异后的文本判定）─────────────────────
const sourceCache = new Map<string, string>();
function repoSource(rel: string, mutate?: (src: string) => string): string {
  const key = mutate ? `${rel}::probe` : rel;
  if (!sourceCache.has(key)) {
    let src = fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
    if (mutate) src = mutate(src);
    sourceCache.set(key, src);
  }
  return sourceCache.get(key)!;
}

const MUTATIONS: Record<string, { file: string; apply: (src: string) => string }> = {
  // 坏形态①：quota/auth 判定顺序被对调——限流时 CLI 也会打印 401，
  // 先判 auth 会把用户引去重登一个额度用尽的账号（recovery.ts 踩过的坑）
  'no-order': {
    file: 'shared/diagnostics.ts',
    apply: src =>
      src.replace(
        `  if (QUOTA_RE.test(text)) return 'quota';\n  if (AUTH_RE.test(text)) return 'auth_expired';`,
        `  if (AUTH_RE.test(text)) return 'auth_expired';\n  if (QUOTA_RE.test(text)) return 'quota';`
      ),
  },
  // 坏形态②：auth_expired 的动作被抹掉——契约完整性必须抓住「有类无动作」
  'no-action': {
    file: 'shared/diagnostics.ts',
    apply: src =>
      src.replace(
        "auth_expired: { labelKey: 'diag.auth_expired.label', action: 'open_login' },",
        "auth_expired: { labelKey: 'diag.auth_expired.label', action: null },"
      ),
  },
  // 坏形态③：recordError 不再写 lastDiagnostic——运行期事实被探测覆盖回去
  'no-wiring': {
    file: 'server/agents/registry.ts',
    apply: src => src.replace(/lastDiagnostic: \{[^}]*\},/, ''),
  },
};

function contracts(mutate?: (src: string, file: string) => string): void {
  const S = (rel: string) => repoSource(rel, mutate ? (src) => mutate(src, rel) : undefined);

  if (!probe || probe === 'no-wiring') {
    check('recordError 必须归类进契约（lastDiagnostic + classifyErrorMessage）', () => {
      const src = S('server/agents/registry.ts');
      assert.ok(src.includes('classifyErrorMessage'), 'recordError 未调用分类器');
      assert.match(src, /lastDiagnostic: \{/, 'recordError 未写入 lastDiagnostic');
      assert.ok(src.includes('authDiagnosticFor'), 'auth 的 missing/expired 细分缺失');
    });
    check('toAgentInfo 必须派生 diagnostic（运行期优先于探测）', () => {
      const src = S('server/agents/types.ts');
      assert.match(src, /status\.lastDiagnostic \?\?/, 'toAgentInfo 未优先消费运行期事实');
      assert.ok(src.includes('availabilityToDiagnostic'), '探测侧映射未接线');
    });
    check('前后端可用性联合类型必须同源于 shared（不许手抄镜像）', () => {
      for (const f of ['server/agents/types.ts', 'src/types.ts']) {
        const src = S(f);
        assert.ok(
          !/\| 'needs-auth'/.test(src),
          `${f} 仍在手抄 AgentAvailability 联合（应改为 re-export ProbeAvailability）`
        );
      }
    });
  }
  if (!probe || probe === 'no-order') {
    check('归类顺序：quota 必须先于 auth（限流时 CLI 也会打印 401）', () => {
      const src = S('shared/diagnostics.ts');
      const seg = src.slice(src.indexOf('export function classifyErrorMessage'));
      const qi = seg.indexOf("return 'quota'");
      const ai = seg.indexOf("return 'auth_expired'");
      assert.ok(qi >= 0 && ai > qi, `quota(idx=${qi}) 必须先于 auth_expired(idx=${ai})`);
    });
  }
  if (!probe || probe === 'no-action') {
    check('契约完整性：九类各有 zh/en 文案键，除 ok 外必须有动作', () => {
      const diag = S('shared/diagnostics.ts');
      const classes = [...diag.matchAll(/(\w+): \{ labelKey: '(diag\.[\w.]+)', action: (.+?) \}/g)];
      assert.ok(classes.length >= 9, `分类元数据不足（${classes.length}）`);
      const zh = S('src/i18n/zh.ts');
      const en = S('src/i18n/en.ts');
      for (const [, cls, labelKey, actionRaw] of classes) {
        assert.ok(zh.includes(`'${labelKey}':`), `zh 缺 ${labelKey}`);
        assert.ok(en.includes(`'${labelKey}':`), `en 缺 ${labelKey}`);
        if (cls !== 'ok') {
          assert.ok(!actionRaw.includes('null'), `${cls} 缺动作（有类无动作 = 有病无药）`);
        }
      }
      // i18n 的动作文案也要齐
      for (const action of ['open_login', 'open_install', 'switch_model', 'check_network', 'view_details']) {
        assert.ok(zh.includes(`'diag.action.${action}':`), `zh 缺动作文案 ${action}`);
        assert.ok(en.includes(`'diag.action.${action}':`), `en 缺动作文案 ${action}`);
      }
    });
    check('文本归类口径必须与 recovery.ts 同分类（镜像防漂移）', () => {
      // 同一组样本，两侧口径必须给出同类的判定（映射关系：auth→auth 系，
      // quota→quota，not-installed→not_installed，network→network，unknown→unknown）
      const samples: Array<[string, string]> = [
        ['429 Too Many Requests', 'quota'],
        ['401 Unauthorized', 'auth_expired'],
        ['ENOENT: command not found', 'not_installed'],
        ['ECONNREFUSED 127.0.0.1:443', 'network'],
        ['宇宙射线导致未知错误', 'unknown'],
      ];
      const rec = S('server/agents/recovery.ts');
      const shared = S('shared/diagnostics.ts');
      for (const [text, expect] of samples) {
        // recovery 侧：kind 集合较小（auth 不分 missing/expired），auth 系统称
        const expectKind = expect === 'auth_expired' ? 'auth' : expect;
        assert.ok(
          shared.includes(expect) || expect === 'unknown',
          `shared 侧缺 ${expect} 分类`
        );
        // 镜像断言：两侧正则表对样本的命中必须一致（逐正则测，不 import）
        const reOf = (src: string, name: string) => {
          const m = src.match(new RegExp(`const ${name}_RE =\\s*\\/(.+?)\\/i;`, 's'));
          assert.ok(m, `缺 ${name}_RE`);
          return new RegExp(m![1], 'i');
        };
        for (const name of ['QUOTA', 'AUTH', 'MISSING', 'NETWORK']) {
          const a = reOf(rec, name).test(text);
          const b = reOf(shared, name).test(text);
          assert.equal(a, b, `样本「${text}」在 ${name}_RE 上两侧口径不一致`);
        }
        void expectKind;
      }
    });
  }
}

async function units(): Promise<void> {
  if (probe) return;
  console.log('\n[U] 离线单元');
  const { classifyErrorMessage, availabilityToDiagnostic, authDiagnosticFor, DIAGNOSTIC_CLASSES } =
    await import('../shared/diagnostics.js');

  check('classify：五类样本', () => {
    assert.equal(classifyErrorMessage('429 Too Many Requests'), 'quota');
    assert.equal(classifyErrorMessage('凭据失效，请重新登录'), 'auth_expired');
    assert.equal(classifyErrorMessage('spawn git ENOENT'), 'not_installed');
    assert.equal(classifyErrorMessage('ECONNREFUSED, connect ECONNREFUSED'), 'network');
    assert.equal(classifyErrorMessage('月球背面导致失败'), 'unknown');
  });

  check('classify：429 先于 401（限流时 CLI 也会打印 unauthorized）', () => {
    assert.equal(classifyErrorMessage('429 unauthorized, rate limited'), 'quota');
  });

  check('availability 七档映射', () => {
    assert.equal(availabilityToDiagnostic('ready'), 'ok');
    assert.equal(availabilityToDiagnostic('needs-auth'), 'auth_missing');
    assert.equal(availabilityToDiagnostic('needs-setup'), 'binary_broken');
    assert.equal(availabilityToDiagnostic('unsupported'), 'binary_broken');
    assert.equal(availabilityToDiagnostic('unreachable'), 'network');
    assert.equal(availabilityToDiagnostic('not-installed'), 'not_installed');
    assert.equal(availabilityToDiagnostic('unknown'), 'unknown');
  });

  check('auth 细分：上下文定 missing/expired，不猜文本', () => {
    assert.equal(authDiagnosticFor(true), 'auth_expired');
    assert.equal(authDiagnosticFor(false), 'auth_missing');
  });

  check('分类是全集：任意文本都有归类（总覆盖率）', () => {
    for (const text of ['', 'x', '错误', JSON.stringify({ a: 1 })]) {
      assert.ok((DIAGNOSTIC_CLASSES as readonly string[]).includes(classifyErrorMessage(text)));
    }
  });

  console.log('\n[F] toAgentInfo 派生（运行期事实优先于探测）');
  const { toAgentInfo } = await import('../server/agents/types.js');
  const baseDescriptor = {
    id: 't',
    name: 'T',
    kind: 'cli' as const,
    capabilities: ['chat' as const],
  };
  check('探测 ready → ok；not-installed → not_installed', () => {
    const okInfo = toAgentInfo(baseDescriptor, {
      availability: 'ready',
      installed: true,
      probedAt: '2026-11-14T00:00:00Z',
    });
    assert.equal(okInfo.diagnostic.class, 'ok');
    assert.equal(okInfo.diagnostic.source, 'probe');
    const niInfo = toAgentInfo(baseDescriptor, {
      availability: 'not-installed',
      installed: false,
      probedAt: '2026-11-14T00:00:00Z',
    });
    assert.equal(niInfo.diagnostic.class, 'not_installed');
  });
  check('运行期 401（prev ready）→ auth_expired 压过探测的 ready', () => {
    const info = toAgentInfo(baseDescriptor, {
      availability: 'ready',
      installed: true,
      probedAt: '2026-11-14T00:00:00Z',
      lastDiagnostic: {
        class: 'auth_expired',
        at: '2026-11-14T01:00:00Z',
        detail: '401 Unauthorized',
        source: 'runtime',
      },
    });
    assert.equal(info.diagnostic.class, 'auth_expired');
    assert.equal(info.diagnostic.source, 'runtime');
  });
}

async function run(): Promise<void> {
  console.log(probe ? `P0 诊断契约闸门（探针模式：${probe}）` : 'P0 诊断分类学契约闸门');
  const mutation = probe ? MUTATIONS[probe] : undefined;
  if (probe && !mutation) {
    console.error(`未知探针：${probe}（可用：${Object.keys(MUTATIONS).join(' / ')}）`);
    process.exit(2);
  }
  contracts(mutation ? (src, file) => (file === mutation.file ? mutation.apply(src) : src) : undefined);
  await units();
  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (probe) {
    if (fail === 0) {
      console.error(`探针失败：变异（${probe}）后闸门仍然全绿——探针无效`);
      process.exit(1);
    }
    console.log(`探针有效：变异后 ${fail} 条变红（按预期）`);
    process.exit(0);
  }
  if (fail > 0) process.exit(1);
}

void run();
