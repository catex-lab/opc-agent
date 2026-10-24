#!/usr/bin/env node
/**
 * 上线前配置自检
 *
 * 目的：把「哪些占位符还没填」变成一条命令的输出，而不是靠人肉 grep。
 * 这套配置散在 6 个文件里（站点 JS、Worker TOML、Electron 主进程、React 组件），
 * 漏一处的后果不对称 —— 漏 apiBase 只是没统计，漏 REPO_URL 是应用内链接
 * 指向别人的仓库，用户点「问题反馈」会跑到陌生人那里去。
 *
 * 用法：node site/check-config.mjs
 * 退出码：0 = 全部就绪；1 = 还有占位符
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOMAIN = 'catex-lab';

/** @type {Array<{file: string, label: string, test: (s: string) => boolean, hint: string}>} */
const CHECKS = [
  {
    file: 'site/assets/config.js',
    label: '站点：GitHub 仓库名已填',
    test: (s) => !/repo:\s*'OWNER\//.test(s),
    hint: "把 repo 的 OWNER 换成你的 GitHub 用户名",
  },
  {
    file: 'site/assets/config.js',
    label: '站点：Worker 地址已启用（下载计数依赖它）',
    test: (s) => /apiBase:\s*'https?:\/\/[^']+'/.test(s),
    hint: `部署 Worker 后把 apiBase 改成 'https://${DOMAIN}'`,
  },
  {
    file: 'site/worker/wrangler.toml',
    label: 'Worker：D1 database_id 已填',
    test: (s) => !/database_id\s*=\s*"REPLACE_WITH_YOUR_DATABASE_ID"/.test(s),
    hint: '运行 wrangler d1 create opc-stats，把返回的 id 填进去',
  },
  {
    file: 'site/worker/wrangler.toml',
    label: 'Worker：GITHUB_REPO 已填',
    test: (s) => !/GITHUB_REPO\s*=\s*"OWNER\//.test(s),
    hint: '把 GITHUB_REPO 的 OWNER 换成你的 GitHub 用户名',
  },
  {
    file: 'site/worker/wrangler.toml',
    label: 'Worker：看板密钥已设置',
    test: (s) => !/STATS_KEY\s*=\s*"REPLACE/.test(s),
    hint: 'STATS_KEY 换成随机长字符串（openssl rand -hex 24）',
  },
  {
    file: 'src/components/AboutPanel.tsx',
    label: '应用内：仓库地址已填',
    test: (s) => !/github\.com\/OWNER\//.test(s),
    hint: 'AboutPanel.tsx 顶部的 REPO_URL 还是占位符，用户点「问题反馈」会跳到别人的仓库',
  },
  {
    file: 'electron/analytics.ts',
    label: '客户端：统计端点已启用',
    test: (s) => /TELEMETRY_ENDPOINT = process\.env\.OPC_TELEMETRY_URL \|\| 'https?:\/\//.test(s),
    hint: `发布带统计的版本前，把 TELEMETRY_ENDPOINT 改成 'https://${DOMAIN}'（留空 = 完全不上报）`,
  },
];

const CONSISTENCY = [
  'site/index.html',
  'site/privacy.html',
  'site/assets/config.js',
  'site/worker/wrangler.toml',
  'src/components/AboutPanel.tsx',
];

let failed = 0;

console.log('\n上线前配置自检\n' + '─'.repeat(58));

for (const check of CHECKS) {
  let src = '';
  try {
    src = readFileSync(join(ROOT, check.file), 'utf8');
  } catch {
    console.log(`  ?  ${check.label}  —— 读不到 ${check.file}`);
    failed++;
    continue;
  }
  const ok = check.test(src);
  console.log(`  ${ok ? '✓' : '✗'}  ${check.label}`);
  if (!ok) {
    console.log(`     → ${check.hint}`);
    failed++;
  }
}

console.log('─'.repeat(58) + '\n域名一致性\n' + '─'.repeat(58));

for (const file of CONSISTENCY) {
  let src = '';
  try {
    src = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  const stale = /opc\.example\.com|example\.com/.test(src);
  const hasDomain = src.includes(DOMAIN);
  if (stale) {
    console.log(`  ✗  ${file} —— 仍有 example.com 残留`);
    failed++;
  } else if (!hasDomain) {
    // HTML 页面里的外链由 assets/app.js 按 config.repo 注入，本来就不该硬编码域名
    console.log(`  -  ${file} —— 外链由 app.js 注入，无需硬编码`);
  } else {
    console.log(`  ✓  ${file}`);
  }
}

console.log('\n' + '─'.repeat(58));
if (failed === 0) {
  console.log('全部就绪，可以部署。\n');
  process.exit(0);
} else {
  console.log(`还有 ${failed} 项待处理。\n`);
  process.exit(1);
}
