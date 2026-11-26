/**
 * 设置页分区清单：**契约清单** + **源码派生**，两者互相校验。
 *
 * ## 为什么不能只用派生（这是我踩过的坑）
 *
 * 第一版就是「完全从源码派生期望值」，结果反向探针**失效**：把产品代码里的
 * 「最近删除」删掉后，派生的期望值也跟着变成 8，于是 `navCount === 8` 恒成立，
 * 两个闸门又双叒全绿 —— 断言变成了「导航等于它自己」的同义反复。
 *
 * 教训是通用的一条：**期望值不能与被测对象同源**。同源就必然同进同退，
 * 测不出「被测对象被改坏了」。
 *
 * ## 所以这里保留两份
 *
 * - `EXPECTED_SECTIONS`：**契约清单**，手写、代表「用户应当看到什么」。产品代码
 *   删了某个分区，这份清单不变 ⇒ 闸门红，人必须显式决定「是不是真的要下线这个分区」。
 * - `sectionKeys()`：从 `SettingsPage.tsx` 派生，用来抓「手抄漂移」——加分区只改
 *   产品代码时，`contractDrift()` 会告诉闸门「契约清单落后了」，从而提示补清单。
 *
 * 两份的差异本身就是信息：派生的更新 ⇒ 有人加了分区（补契约）；
 * 契约里还有、派生里没了 ⇒ 有人删了分区（闸门必须红，人来拍板）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 契约清单：设置页**应当**有的分区，按界面显示顺序。
 *
 * 加分区时在这里补一行（这是唯一「手写」的地方，且是刻意的：删/加分区必须经人确认）。
 * 历史：A38/A40 → 5 项；A60 加 model → 6；A95 加 about → 7；A115 加 profile → 8；
 *       B1（2026-11-26）加 trash → 9。
 */
export const EXPECTED_SECTIONS = [
  { key: 'profile', label: '我的资料' },
  { key: 'memory', label: '记忆' },
  { key: 'permission', label: '权限门禁' },
  { key: 'appearance', label: '外观' },
  { key: 'login', label: '登录配置' },
  { key: 'models', label: '模型清单' },
  { key: 'agents', label: '自定义助手' },
  { key: 'trash', label: '最近删除' },
  { key: 'about', label: '关于与隐私' },
];

/**
 * 读 `SettingsPage.tsx` 里 `SETTINGS_SECTIONS` 数组的分区 key，按源码顺序。
 * 只认 `key: 'xxx'` 这种字面量形态（数组里每一项都这么写）。
 */
export function sectionKeys() {
  const file = path.join(root, 'src/components/SettingsPage.tsx');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const SETTINGS_SECTIONS');
  if (start === -1) throw new Error('[settings-sections] 找不到 SETTINGS_SECTIONS 定义，闸门无法派生分区清单');
  const rest = src.slice(start);
  const endMatch = /\n\];/.exec(rest);
  if (!endMatch) throw new Error('[settings-sections] SETTINGS_SECTIONS 数组没有正常收尾，闸门无法派生分区清单');
  const body = rest.slice(0, endMatch.index);
  const keys = [...body.matchAll(/key:\s*'([a-zA-Z0-9_-]+)'/g)].map(m => m[1]);
  if (keys.length === 0) throw new Error('[settings-sections] SETTINGS_SECTIONS 里没解析出任何 key，拒绝返回空清单');
  if (new Set(keys).size !== keys.length) throw new Error(`[settings-sections] 分区 key 有重复：${keys.join(',')}`);
  return keys;
}

/**
 * 契约清单与源码的差异。返回 `{ added, removed }`：
 *   · `added`   = 源码有、契约没有 ⇒ 有人加了分区，请补 `EXPECTED_SECTIONS`；
 *   · `removed` = 契约有、源码没有 ⇒ 有人删了分区，闸门必须红（人来拍板是否真下线）。
 */
export function contractDrift() {
  const actual = sectionKeys();
  const contract = EXPECTED_SECTIONS.map(s => s.key);
  return {
    added: actual.filter(k => !contract.includes(k)),
    removed: contract.filter(k => !actual.includes(k)),
  };
}

/** 分区 label（中文显示名），从 `zh.ts` 的 `settings.section.<key>` 读。 */
export function sectionLabels() {
  const file = path.join(root, 'src/i18n/zh.ts');
  const src = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const { key } of EXPECTED_SECTIONS) {
    const re = new RegExp(`'settings\\.section\\.${key}'\\s*:\\s*'([^']*)'`);
    const m = re.exec(src);
    // 契约里列了、i18n 里没有 ⇒ 产品代码漏了整个键，必须暴露而不是静默跳过
    if (!m) throw new Error(`[settings-sections] zh.ts 缺 'settings.section.${key}'，分区「${key}」没有中文标签`);
    out[key] = m[1];
  }
  return out;
}

/** `[{ key, label }]` 顺序表（来自契约清单），闸门直接用这个比较导航。 */
export function orderedLabels() {
  return EXPECTED_SECTIONS.map(({ key }) => ({ key, label: sectionLabels()[key] }));
}
