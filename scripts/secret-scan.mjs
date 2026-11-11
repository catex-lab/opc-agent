#!/usr/bin/env node
/**
 * 提交前的密钥扫描。
 *
 * ## 为什么自己写而不用 GitHub 的 push protection
 *
 * 仓库是私有的，而仓库级 push protection 需要 GitHub Secret Protection
 * 许可证（前置订阅 Team / Enterprise）—— 免费计划的私有仓库根本没有那个
 * 开关。另外它是「按厂商模式库匹配」，我们真正踩过的坑是
 * `wrangler.toml` 里一把 48 位十六进制的 `STATS_KEY`，不属于任何厂商的
 * 标准格式，GitHub 认不出来。所以这里既有**模式规则**，也有
 * 「赋值给了名字像密钥的变量」这种**结构规则**。
 *
 * 而且它拦得更早：GitHub 在推送时拦，这个在提交时拦。上次那把密钥是
 * 本地提交进去的，如果在提交这一步就拦住，后面整套历史重写都不必发生。
 *
 * ## 用法
 *
 *   node scripts/secret-scan.mjs           # 扫暂存区（pre-commit 钩子用这个）
 *   node scripts/secret-scan.mjs --all     # 扫工作区全部受跟踪文件（排查用）
 *
 * 退出码：0 = 干净，1 = 命中，2 = 环境问题
 *
 * ## 误报怎么办
 *
 * 在命中的那一行加 `secret-scan:ignore`（任何注释风格都行）。
 * 之所以留这个口子：正则必然有误报，没有逃生口的钩子只会被 `--no-verify`
 * 整体绕过 —— 那样连真密钥也拦不住了。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const IGNORE_MARK = 'secret-scan:ignore';

/** 这些文件不扫：锁文件里的哈希会被长十六进制规则误伤，构建产物不是源码。 */
const SKIP_FILES = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /\.min\.(?:js|css)$/,
  /(^|\/)dist\//,
  /(^|\/)dist-electron\//,
  /(^|\/)node_modules\//,
  /(^|\/)release[^/]*\//,
];

/**
 * 占位符白名单。
 *
 * 不这么做的话，`STATS_KEY = "REPLACE_WITH_YOUR_STATS_KEY"` 这种**正确**
 * 写法会被拦 —— 而那正是我们希望大家都这么写的东西。
 */
const PLACEHOLDER =
  /^(?:REPLACE|YOUR|CHANGE|TODO|FIXME|xxx+|\*{3,}|<[^>]*>|\.{3}|example|dummy|placeholder|sample|redacted)/i;

const RULES = [
  {
    id: 'private-key',
    label: '私钥内容',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key',
    label: 'AWS Access Key ID',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: 'github-pat',
    label: 'GitHub fine-grained PAT',
    re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  },
  {
    // 注意别写成裸 `sk-`：`mask-image` 里就含 `sk-`（MEMORY 记过这个假阳性）。
    // 两个约束一起用：词边界 + 至少 20 位，`-webkit-mask-image` 两条都不满足。
    id: 'sk-key',
    label: 'sk- 风格密钥',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'conn-string',
    label: '连接串里带密码',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  },
  {
    /**
     * 结构规则：变量名像密钥 + 赋了一个像密钥的字面量。
     *
     * 这条专门对付「没有厂商前缀、但明显是密钥」的形态 ——
     * `STATS_KEY = "8c07df…（48 位十六进制）"` 就是这一类。
     * 光按「48 位十六进制」匹配会把 git SHA 和普通哈希全误伤，
     * 所以把「名字」当成必要条件。
     */
    id: 'assigned-secret',
    label: '把密钥直接写进赋值',
    re: /\b([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/,
    group: 2,
    accept: (m, line) => {
      const name = m[1];
      const value = m[2];

      // 名字必须真的像密钥。`key` / `token` / `secret` 这种**单词**在代码里
      // 到处都是（localStorage 键、React list key、项目记忆键、OAuth 字段），
      // 一律放过 —— 实测不排除的话，本仓库 16 处命中全是这类假阳性。
      if (/^(?:key|token|secret|password|passwd|pwd|value|id|name)$/i.test(name)) return false;
      if (!/(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i.test(name)) return false;

      if (PLACEHOLDER.test(value)) return false;
      // 从环境变量读的不是硬编码
      if (/process\.env|import\.meta\.env|os\.environ|getenv\(/i.test(line)) return false;
      // 模板串是拼出来的，不是字面量
      if (value.includes('${')) return false;
      // 小写标识符（带分隔符）：`opc.workspace-url`、`opc-agent-1a2b3c4d`、
      // `sk-test-…` 这类是键名/夹具，不是密钥。真密钥不会长成纯小写加分隔符。
      if (/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value)) return false;
      // 数字和字母都得有：纯字母多半是单词，纯数字多半是时间戳/ID
      if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;

      return true;
    },
  },
];

/**
 * `.env` 专用规则：普通代码里「变量名得像 KEY/SECRET」这条判据是为了压假阳性，
 * 但 `.env` 里每一行赋值本身就是凭据候选，`DB_HOST_PASSWORD` 和 `FOO` 都得扫。
 * 这类文件本该被 .gitignore 挡在库外；这条规则是防 `git add -f .env` 的兜底。
 */
const ENV_RULE = {
  id: 'env-assigned-secret',
  label: '.env 里的凭据赋值',
  re: /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/,
  group: 1,
  accept: (m, line) => {
    const value = String(m[1] ?? '').replace(/^["']|["']$/g, '').trim();
    if (value.length < 8 || PLACEHOLDER.test(value)) return false;
    // 布尔 / 端口 / 环境名 / 本地地址这类是配置，不是密钥
    if (/^(?:true|false|null|none|undefined|\d{1,6}|localhost|127\.0\.0\.1|utf-?8|development|production|test|debug|info)$/i.test(value)) return false;
    // 值来自另一个变量或模板插值，不是硬编码真值
    if (/\$\{|\$[A-Za-z_]|process\.env|import\.meta\.env|os\.environ/i.test(line)) return false;
    // 服务地址 / 连接串是配置不是密钥；带密码的连接串由上面的 conn-string 规则拦
    if (/^(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\//i.test(value)) return false;
    // 纯小写加分隔符的是键名 / 夹具，沿用结构规则里同一条排除
    if (/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value)) return false;
    return true;
  },
};

/** 示例文件是给人照着填的，不算凭据载体。 */
function isScannableEnvFile(relPath) {
  return /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(relPath)
    && !/\.(?:example|sample|template)$/i.test(relPath);
}

function mask(s) {
  if (s.length <= 10) return '*'.repeat(s.length);
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function scanText(text, relPath) {
  const hits = [];
  const rules = isScannableEnvFile(relPath) ? [...RULES, ENV_RULE] : RULES;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(IGNORE_MARK)) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.accept && !rule.accept(m, line)) continue;
      const raw = m[rule.group ?? 0];
      hits.push({ line: i + 1, rule, raw, source: line.trim() });
      break; // 一行只报一条，避免同一行刷屏
    }
  }
  return hits;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function trackedFiles() {
  const out = git(['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function main() {
  const all = process.argv.includes('--all');
  const files = all ? trackedFiles() : stagedFiles();

  const findings = [];
  // 读不到的文件不能当成「扫过了且干净」：攒起来，在结论里显式交代。
  const unscanned = [];
  for (const rel of files) {
    if (SKIP_FILES.some(re => re.test(rel))) continue;

    let buf;
    try {
      // 扫**暂存区内容**而不是工作区：`git add -p` 之后工作区与索引可能不一致，
      // 而真正要提交的是索引。
      buf = all ? readFileSync(rel) : git(['show', `:${rel}`]);
    } catch {
      unscanned.push(rel);
      continue;
    }

    if (looksBinary(buf)) continue;

    const hits = scanText(buf.toString('utf8'), rel);
    if (hits.length) findings.push({ file: rel, hits });
  }

  if (!findings.length) {
    // CI / 排查用的 --all 是硬闸门：有文件读不到就不能报「通过」。
    // 钩子模式仍不阻断提交（钩子环境坏了把人锁死更糟），但必须把话说出来。
    if (unscanned.length) {
      console.error(`\n⚠️  有 ${unscanned.length} 个文件没能读到，本次扫描不完整：`);
      for (const rel of unscanned) console.error(`  - ${rel}`);
      if (all) {
        console.error('✗ 全量扫描不允许带着未扫描文件判通过（退出码 2）\n');
        return 2;
      }
      console.error('  钩子模式不阻断提交，但请确认这些文件确实不含密钥。\n');
    }
    const scope = all ? '全部受跟踪文件' : '暂存区';
    console.log(`✓ 密钥扫描通过（${scope}，${files.length} 个文件${unscanned.length ? `，其中 ${unscanned.length} 个未扫到` : ''}）`);
    return 0;
  }

  const total = findings.reduce((n, f) => n + f.hits.length, 0);
  console.error(`\n✗ 发现 ${total} 处疑似密钥，已阻止提交\n`);
  for (const { file, hits } of findings) {
    console.error(`  ${file}`);
    for (const h of hits) {
      console.error(`    ${h.line}:${' '} [${h.rule.id}] ${h.rule.label}`);
      console.error(`            ${mask(h.raw)}`);
    }
    console.error('');
  }
  console.error('  确认是密钥：删掉它，改从环境变量读。');
  console.error('  确认是误报：在那一行加 `secret-scan:ignore` 再提交。');
  console.error('  急着提交：`git commit --no-verify`（但请先确认真的不是密钥）。\n');
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`✗ 密钥扫描自身出错：${err?.message || err}`);
  // 钩子模式：出错不阻断提交（钩子自身坏了不该让人提交不了代码），
  // 但必须说清楚这次没扫过。全量模式（CI 的 secret-scan --all）必须判红 ——
  // 那边没有「先提交再说」的余地，静默 exit 0 就是一条永久的假绿通道。
  if (process.argv.includes('--all')) {
    console.error('  全量扫描环境出错，判红（退出码 2）；CI 不允许「没扫过」算通过。');
    process.exit(2);
  }
  console.error('  这次提交没有经过扫描，请检查上面这条错误。');
  process.exit(0);
}
