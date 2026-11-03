/**
 * 检索用的轻量向量层（P3）。
 *
 * ## 为什么不是神经网络 embedding
 *
 * P3 要求「embedding 混合检索」，但明确禁止擅自加依赖或联网调模型。这里用
 * **纯本地字符 n-gram 哈希投影**：把文本的 2/3-gram 用 FNV-1a 哈希到固定维度，
 * 带符号累加后 L2 归一化。它没有语义推理能力，但对中文近义改写、标点/空白
 * 差异、同会话的重复表述有稳定的相似度，正好补 FTS5 trigram 的召回盲区，
 * 且零依赖、零网络、零模型文件。
 *
 * 未来接真模型不需要改检索层：`kb_vectors.provider` 里记的是 provider id，
 * 换 provider 后旧向量自动不被使用，回填后自然升级。
 *
 * ## 降级
 *
 * `OPC_KB_VECTOR=off` 或索引库里没有当前 provider 的向量时，
 * `searchKnowledge` 只走 BM25/LIKE，返回结构与 P2 完全一致。
 */

/** 检索层用到的响应扩展字段；由 `search.ts` 直接使用，这里只做类型声明。 */
export interface KbRetrievalMeta {
  /** 'bm25' = 纯词法（含降级），'hybrid' = 词法 + 向量 RRF 融合 */
  retrieval: 'bm25' | 'hybrid';
  /** 进入融合的向量候选数（0 表示本次没有向量召回） */
  vectorCandidates: number;
  /** 近似去重合并掉的条数 */
  dedupedCount: number;
}

/** 向量层开关（排障/对比用）；缺省开启，`off` 时完全退化到 BM25。 */
export const KB_VECTOR_ENV = 'OPC_KB_VECTOR';

/**
 * 当前 provider 的标识；写进 `kb_vectors.provider`，用于灰度切换。
 *
 * ## 决策（2026-11-04，已与产品确认）：暂时维持 `local-ngram-v1`
 *
 * 不换真模型的理由：
 *   - 约束是「不加依赖、不联网、不下载模型文件」，而语义模型三者至少占一样；
 *   - 现有召回盲区主要来自中文近义改写，字符 2/3-gram 已能覆盖标点/空白差异、
 *     同一内容的重复表述，先补 FTS5 trigram 的召回面足够；
 *   - 128 维向量约 512B/片，5 万片约 25MB，索引与查询开销都可控。
 *
 * 触发重新评估的条件（满足任意一条再考虑换本地小模型，仍不走外部 API）：
 *   - 真实使用中出现「BM25 命中数为 0 且 hybrid 新增候选也为 0」的同义查询，
 *     且人工核对确认该内容确实存在于库中（可先用 `retrieval='hybrid'` 与
 *     `vectorCandidates=0` 的日志筛样本）；
 *   - 用户明确反馈「换个说法搜不到」，且样本量足以形成评测集；
 *   - 需要跨语言或长文档语义匹配，字符 n-gram 结构上做不到。
 *
 * 切换方式：换 provider id 并回填即可，`kb_vectors.provider` 隔离新旧向量，
 * 检索层无需改动；旧 provider 的向量在回填完成前继续可用（灰度）。
 */
export const KB_VECTOR_PROVIDER_ID = 'local-ngram-v1';

/** 维度：128 × 4B ≈ 512B/片，5 万片约 25MB，体积可控。 */
export const KB_VECTOR_DIM = 128;

/** 单条文本参与向量化的最大字符数；超出部分截断，避免超长正文拖慢索引。 */
const MAX_EMBED_CHARS = 4000;

/**
 * 向量召回的最低余弦；低于它的候选不进入融合。
 *
 * 0.3 是实测校准值：哈希投影对完全无关的中文文本也会因常用字/词共享
 * 产生 0.15–0.25 的噪声底，0.3 能把噪声挡在融合之外。
 */
export const KB_VECTOR_MIN_SIMILARITY = 0.3;

/** 单次查询最多扫描多少条允许范围内的切片（近似召回），防止库大时查询失控。 */
export const KB_VECTOR_SCAN_LIMIT = 4000;

export function isVectorLayerEnabled(): boolean {
  return process.env[KB_VECTOR_ENV] !== 'off';
}

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // FNV-1a 32-bit
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 去掉空白/标点/符号，只保留文字与数字；避免标点差异造成假不相似。 */
function normalizedText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, MAX_EMBED_CHARS);
}

/**
 * 文本 → L2 归一化向量。
 *
 * 2-gram 与 3-gram 都投；短文本（<2 字）退化为整串单桶。
 */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(KB_VECTOR_DIM);
  const plain = normalizedText(text);
  if (!plain) return vec;

  const grams: string[] = [];
  const chars = Array.from(plain);
  if (chars.length < 2) {
    grams.push(plain);
  } else {
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= chars.length; i += 1) {
        grams.push(chars.slice(i, i + n).join(''));
      }
    }
  }

  for (const gram of grams) {
    const bucket = fnv1a(gram) % KB_VECTOR_DIM;
    const sign = fnv1a(gram, 0x9e3779b9) & 1 ? 1 : -1;
    vec[bucket] += sign;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i]! / norm;
  }
  return vec;
}

/** Float32Array → SQLite BLOB。 */
export function serializeVector(vec: Float32Array): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** SQLite BLOB → Float32Array；长度不符时返回 null（视为无向量）。 */
export function deserializeVector(blob: unknown, dim: number): Float32Array | null {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as Uint8Array);
  if (buf.byteLength !== dim * 4) return null;
  const out = new Float32Array(dim);
  const view = new Float32Array(buf.buffer, buf.byteOffset, dim);
  out.set(view);
  return out;
}

/** 两个 L2 归一化向量的余弦（点积），范围 [-1, 1]。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** 检索层用到的响应扩展字段；集中在这里，避免调用方各自猜类型。 */
export interface KbRetrievalMeta {
  /** 'bm25' = 纯词法（含降级），'hybrid' = 词法 + 向量 RRF 融合 */
  retrieval: 'bm25' | 'hybrid';
  /** 进入融合的向量候选数（0 表示本次没有向量召回） */
  vectorCandidates: number;
  /** 近似去重合并掉的条数 */
  dedupedCount: number;
}
