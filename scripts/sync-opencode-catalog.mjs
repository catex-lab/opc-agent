/**
 * 生成 OpenCode Zen 模型目录的离线兜底快照。
 *
 * 数据源：models.dev 官方目录（https://models.dev/api.json），这也是 OpenCode
 * 自身拉取模型清单的来源。运行时 modelCatalog.ts 会联网刷新并覆盖本快照，
 * 本文件只在「联网失败 / 首次启动」时作为兜底，保证列表绝不空。
 *
 * 运行：node scripts/sync-opencode-catalog.mjs
 *   - 默认读 .tmp/models-dev.json（scripts/verify-* 已缓存过）；
 *   - 缺省时实时 fetch，带 12s 超时。
 *
 * 生成产物：server/agents/opencodeCatalogSnapshot.ts
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER = 'opencode';
const CATALOG_URL = 'https://models.dev/api.json';
const OUT = join(__dirname, '..', 'server', 'agents', 'opencodeCatalogSnapshot.ts');
const CACHE = join(__dirname, '..', '.tmp', 'models-dev.json');

async function loadCatalog() {
  try {
    const raw = readFileSync(CACHE, 'utf8');
    const c = JSON.parse(raw);
    if (c?.[PROVIDER]?.models) {
      console.log('使用缓存 .tmp/models-dev.json');
      return c;
    }
  } catch {
    // 没有缓存，往下走实时拉取
  }
  console.log('实时拉取', CATALOG_URL);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const MODALITY_ORDER = ['text', 'image', 'video', 'audio', 'pdf'];
const MODALITY_LABEL = {
  text: '文本', image: '图像', video: '视频', audio: '音频', pdf: 'PDF',
};

function fmtContext(n) {
  if (!n) return '?';
  if (n >= 1048576) return `${Math.round(n / 1048576)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const catalog = await loadCatalog();
const models = catalog[PROVIDER]?.models ?? {};
const ids = Object.keys(models).sort((a, b) => a.localeCompare(b));

let total = 0, free = 0;
const lines = [];
for (const id of ids) {
  const m = models[id];
  const inC = Number(m.cost?.input ?? 0);
  const outC = Number(m.cost?.output ?? 0);
  const isFree = inC === 0 && outC === 0;
  const mods = (m.modalities?.input ?? [])
    .filter((x) => MODALITY_ORDER.includes(x))
    .sort((a, b) => MODALITY_ORDER.indexOf(a) - MODALITY_ORDER.indexOf(b))
    .map((x) => MODALITY_LABEL[x] ?? x);
  const reason = m.reasoning ? '支持推理' : null;
  const parts = [];
  parts.push(isFree ? '免费' : `$${inC}/${outC}/M`);
  parts.push(`上下文 ${fmtContext(m.limit?.context ?? 0)}`);
  if (mods.length) parts.push(mods.join('/'));
  if (reason) parts.push(reason);
  const desc = parts.join(' · ');
  total++;
  if (isFree) free++;
  const raw = {
    name: m.name ?? id,
    cost: { input: inC, output: outC },
    limit: { context: m.limit?.context ?? 0 },
    modalities: { input: m.modalities?.input ?? [] },
    reasoning: !!m.reasoning,
    description: desc,
  };
  lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(raw)},`);
}

const header = `// 由 scripts/sync-opencode-catalog.mjs 生成 —— 请勿手改。
// 数据源：models.dev 官方目录（OpenCode Zen 网关，即 https://opencode.ai/inference/openai/v1）。
// 这是「离线兜底」快照；运行时 modelCatalog.ts 会联网刷新并覆盖。
// 重新生成：node scripts/sync-opencode-catalog.mjs
// 统计：共 ${total} 个模型，其中免费 ${free} 个（生成于 ${new Date().toISOString().slice(0, 10)}）。

/** 单条原始模型（与 models.dev 的 opencode 节点字段对齐） */
export interface RawOpenCodeModel {
  name: string;
  cost: { input: number; output: number };
  limit: { context: number };
  modalities: { input: string[] };
  reasoning: boolean;
  description: string;
}

export const OPENCODE_CATALOG_SNAPSHOT: Record<string, RawOpenCodeModel> = {
`;
writeFileSync(OUT, header + '\n' + lines.join('\n') + '\n};\n', 'utf8');
console.log(`已写入 ${OUT} —— 共 ${total} 个（免费 ${free} 个）。`);
