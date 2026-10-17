/**
 * 生图 provider 验证（P4-4）。
 *
 * 全离线：**不发起任何真实网络请求**。
 *   - provider 的 `generate()` 接受注入的 `fetchImpl`，所有 HTTP 交互都用假
 *     fetch 断言「发了什么 / 怎么解析 / 错误怎么归类」
 *   - 图片下载同理（`cacheImage` 也接受注入 fetch）
 *   - 数据库部分走临时 `OPC_DATA_DIR`，真实 `data/chat.db` 零接触
 *
 * 覆盖：
 *   [A] provider 契约 + 前后端常量一致性（防漂移）
 *   [B] status()：有/无密钥 → ready / needs-auth
 *   [C] generate()：请求构造、响应解析、7 类错误映射
 *   [D] image-store：文件名白名单、目录穿越防护、下载落盘、内容哈希去重、失败降级
 *   [E] DB：messages.images 列的迁移 + 写入 + 读回 + 更新
 *
 * 运行：npx tsx scripts/verify-image.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CogViewProvider,
  ImageGenerationError,
  getImageProvider,
  listImageProviders,
  imageProvidersStatus,
  resolveCogViewApiKey,
  IMAGE_SIZES as SERVER_SIZES,
  IMAGE_SIZE_LABELS as SERVER_SIZE_LABELS,
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '../server/agents/adapters/image.js';
import { cacheImage, imageFilePath, isSafeImageFile } from '../server/image-store.js';
import {
  IMAGE_SIZES as CLIENT_SIZES,
  IMAGE_SIZE_LABELS as CLIENT_SIZE_LABELS,
  IMAGE_MODELS as CLIENT_MODELS,
  DEFAULT_IMAGE_SIZE as CLIENT_DEFAULT_SIZE,
  DEFAULT_IMAGE_MODEL as CLIENT_DEFAULT_MODEL,
} from '../src/imageOptions.js';

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

/** 断言一个 async 调用抛出 ImageGenerationError 且 kind 符合预期 */
async function expectImageError(
  fn: () => Promise<unknown>,
  kind: ImageGenerationError['kind'],
  label: string,
  messageIncludes?: string
) {
  try {
    await fn();
    checks.total++;
    failures.push(`${label} —— 期望抛出 ImageGenerationError(${kind})，但没有抛`);
  } catch (err) {
    checks.total++;
    const e = err as ImageGenerationError;
    if (!(e instanceof ImageGenerationError)) {
      failures.push(`${label} —— 抛出的不是 ImageGenerationError：${(e as Error)?.name} ${(e as Error)?.message}`);
      return;
    }
    if (e.kind !== kind) {
      failures.push(`${label} —— kind 不符：实际 ${e.kind}，期望 ${kind}（${e.message}）`);
      return;
    }
    if (messageIncludes && !e.message.includes(messageIncludes)) {
      failures.push(`${label} —— 文案未包含「${messageIncludes}」：${e.message}`);
    }
  }
}

// ============= 假 fetch 工具 =============

interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  throwErr?: Error;
}

/** 造一个 fetch 替身；同时把每次调用记录下来供断言 */
function makeFakeFetch(reply: FakeReply | ((url: string, init?: RequestInit) => FakeReply)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = typeof reply === 'function' ? reply(String(url), init) : reply;
    if (r.throwErr) throw r.throwErr;
    const body = r.text !== undefined ? r.text : JSON.stringify(r.json ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 1x1 透明 PNG，用于验证下载落盘（真实字节，能过内容哈希） */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 保存/恢复密钥环境变量，避免污染同一进程里的后续断言 */
function withEnv(keys: string[], values: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = values[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function main() {
  const provider = new CogViewProvider();

  // ============= [A] 契约 + 前后端常量一致性 =============
  console.log('\n[A] provider 契约与常量一致性');
  eq(provider.id, 'cogview', 'provider id');
  eq(typeof provider.name, 'string', 'provider name 是字符串');
  ok(provider.name.length > 0, 'provider name 非空');
  ok(provider.models.includes(provider.defaultModel), 'defaultModel 在 models 列表内');
  eq(provider.defaultModel, 'cogview-3-flash', '默认模型为实测免费可用的 cogview-3-flash');
  ok(SERVER_SIZES.length > 0, '服务端声明了尺寸');
  ok((SERVER_SIZES as readonly string[]).includes(DEFAULT_IMAGE_SIZE), 'DEFAULT_IMAGE_SIZE 在尺寸列表内');
  // `auto` 实测被上游以 1214 拒绝，不该出现在候选里
  ok(!(SERVER_SIZES as readonly string[]).includes('auto'), '尺寸列表不含被上游拒绝的 auto');

  eq(
    [...CLIENT_SIZES].sort(),
    [...SERVER_SIZES].sort(),
    '前后端尺寸列表一致（漂移会被这条抓住）'
  );
  eq(
    Object.keys(CLIENT_SIZE_LABELS).sort(),
    [...SERVER_SIZES].sort(),
    '前后端尺寸文案的键集合一致'
  );
  for (const s of SERVER_SIZES) {
    eq(CLIENT_SIZE_LABELS[s], SERVER_SIZE_LABELS[s], `尺寸 ${s} 的文案一致`);
  }
  eq(CLIENT_DEFAULT_SIZE, DEFAULT_IMAGE_SIZE, '前后端默认尺寸一致');
  eq(CLIENT_DEFAULT_MODEL, provider.defaultModel, '前后端默认生图模型一致');
  for (const m of CLIENT_MODELS) {
    ok(provider.models.includes(m.id), `前端模型 ${m.id} 在 provider 声明中`);
  }

  eq(listImageProviders().length, 1, '当前注册 1 个生图 provider');
  ok(getImageProvider('cogview') !== undefined, 'getImageProvider 按 id 命中');
  ok(getImageProvider() !== undefined, 'getImageProvider 不传参取默认');
  ok(getImageProvider('__nope__') === undefined, 'getImageProvider 未知 id 返回 undefined');
  const statusList = imageProvidersStatus();
  eq(statusList[0]?.id, 'cogview', 'imageProvidersStatus 首项是 cogview');
  ok(Array.isArray(statusList[0]?.sizes), 'imageProvidersStatus 带出 sizes');

  // ============= [B] status() =============
  console.log('\n[B] status() 的密钥判定');
  withEnv(['ZHIPU_API_KEY', 'GLM_API_KEY'], { ZHIPU_API_KEY: undefined, GLM_API_KEY: undefined }, () => {
    eq(resolveCogViewApiKey(), undefined, '两个密钥都未设时 resolve 返回 undefined');
    const st = provider.status();
    eq(st.availability, 'needs-auth', '无密钥 → needs-auth');
    ok(
      !!st.message && st.message.includes('ZHIPU_API_KEY'),
      '修复指引里点名了 ZHIPU_API_KEY',
      st.message
    );
  });
  withEnv(['ZHIPU_API_KEY', 'GLM_API_KEY'], { ZHIPU_API_KEY: 'k-zhipu', GLM_API_KEY: undefined }, () => {
    eq(resolveCogViewApiKey(), 'k-zhipu', 'ZHIPU_API_KEY 优先');
    eq(provider.status().availability, 'ready', '有 ZHIPU 密钥 → ready');
  });
  withEnv(['ZHIPU_API_KEY', 'GLM_API_KEY'], { ZHIPU_API_KEY: undefined, GLM_API_KEY: 'k-glm' }, () => {
    eq(resolveCogViewApiKey(), 'k-glm', '回落到 GLM_API_KEY');
    eq(provider.status().availability, 'ready', '有 GLM 密钥 → ready');
  });
  withEnv(['ZHIPU_API_KEY', 'GLM_API_KEY'], { ZHIPU_API_KEY: '   ', GLM_API_KEY: undefined }, () => {
    eq(resolveCogViewApiKey(), undefined, '空白密钥视为未配置');
    eq(provider.status().availability, 'needs-auth', '空白密钥 → needs-auth');
  });

  // ============= [C] generate() =============
  console.log('\n[C] generate() 的请求构造与错误映射');
  const KEY = 'test-key-abc';
  const env = { ZHIPU_API_KEY: KEY, GLM_API_KEY: undefined };

  await withEnvAsync(['ZHIPU_API_KEY', 'GLM_API_KEY'], env, async () => {
    // C1 成功
    {
      const { impl, calls } = makeFakeFetch({
        json: { created: 1, data: [{ url: 'https://example.com/a.png' }], request_id: 'r1' },
      });
      const out = await provider.generate(
        { prompt: '一只橘猫', model: 'cogview-3-flash', size: '1344x768', requestId: 'r1' },
        impl
      );
      eq(out.url, 'https://example.com/a.png', '成功：解析出 data[0].url');
      eq(out.model, 'cogview-3-flash', '成功：回带 model');
      eq(out.size, '1344x768', '成功：回带 size');
      eq(out.provider, 'cogview', '成功：回带 provider');
      eq(out.prompt, '一只橘猫', '成功：回带 prompt（去掉首尾空白）');

      eq(calls.length, 1, '成功：只发了一次请求');
      eq(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/images/generations', '请求地址');
      eq(calls[0].init?.method, 'POST', '请求方法为 POST');
      const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
      eq(headers.Authorization, `Bearer ${KEY}`, 'Authorization 头带 Bearer 密钥');
      eq(headers['Content-Type'], 'application/json', 'Content-Type 为 JSON');
      const body = JSON.parse(String(calls[0].init?.body));
      eq(body.model, 'cogview-3-flash', '请求体带 model');
      eq(body.prompt, '一只橘猫', '请求体带 prompt');
      eq(body.size, '1344x768', '请求体带 size');
      eq(body.request_id, 'r1', '请求体带 request_id');
    }

    // C2 省略 model / size → 取默认
    {
      const { impl, calls } = makeFakeFetch({ json: { data: [{ url: 'https://example.com/b.png' }] } });
      const out = await provider.generate({ prompt: 'cat' }, impl);
      const body = JSON.parse(String(calls[0].init?.body));
      eq(body.model, provider.defaultModel, '省略 model → 用默认模型');
      eq(body.size, DEFAULT_IMAGE_SIZE, '省略 size → 用默认尺寸');
      eq(out.size, DEFAULT_IMAGE_SIZE, '省略 size → 回带默认尺寸');
      ok(!('request_id' in body), '未传 requestId 时不带 request_id 字段');
    }

    // C3 非法 size → 回落到默认（不让上游 1214 打挂整次调用）
    {
      const { impl, calls } = makeFakeFetch({ json: { data: [{ url: 'https://example.com/c.png' }] } });
      await provider.generate({ prompt: 'cat', size: 'auto' as ImageSize }, impl);
      eq(JSON.parse(String(calls[0].init?.body)).size, DEFAULT_IMAGE_SIZE, '非法 size → 回落默认');
    }

    // C4 上游业务错误 1113（余额）
    await expectImageError(
      () =>
        provider.generate(
          { prompt: 'cat', model: 'cogview-4' },
          makeFakeFetch({ json: { error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } } }).impl
        ),
      'balance',
      '上游 1113 → balance 错误',
      'cogview-3-flash'
    );
    {
      // 文案不该出现「。。」（上游自带句号 + 我们拼接）
      const { impl } = makeFakeFetch({
        json: { error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } },
      });
      try {
        await provider.generate({ prompt: 'cat' }, impl);
        ok(false, '1113 应抛错');
      } catch (err) {
        const m = (err as Error).message;
        ok(!m.includes('。。'), '余额文案不出现重复句号', m);
        ok(m.includes('余额不足'), '余额文案保留了上游原因');
      }
    }

    // C5 上游业务错误 1214（参数）
    await expectImageError(
      () =>
        provider.generate(
          { prompt: 'cat' },
          makeFakeFetch({ json: { error: { code: '1214', message: 'size参数不合法' } } }).impl
        ),
      'invalid',
      '上游 1214 → invalid 错误',
      'size参数不合法'
    );

    // C6 HTTP 401（无 error 体）
    await expectImageError(
      () => provider.generate({ prompt: 'cat' }, makeFakeFetch({ status: 401, json: {} }).impl),
      'auth',
      'HTTP 401 → auth 错误',
      '401'
    );

    // C7 HTTP 500 + 非 JSON 体
    await expectImageError(
      () =>
        provider.generate(
          { prompt: 'cat' },
          makeFakeFetch({ status: 500, text: '<html>gateway error</html>', contentType: 'text/html' }).impl
        ),
      'upstream',
      'HTTP 500 → upstream 错误',
      '500'
    );

    // C8 网络层异常
    await expectImageError(
      () =>
        provider.generate(
          { prompt: 'cat' },
          makeFakeFetch({ throwErr: new Error('connect ECONNREFUSED') }).impl
        ),
      'network',
      '网络异常 → network 错误',
      'ECONNREFUSED'
    );

    // C9 空 prompt
    await expectImageError(
      () => provider.generate({ prompt: '   ' }, makeFakeFetch({ json: {} }).impl),
      'invalid',
      '空 prompt → invalid 错误',
      '不能为空'
    );

    // C10 响应缺 data[0].url
    await expectImageError(
      () => provider.generate({ prompt: 'cat' }, makeFakeFetch({ json: { created: 1, data: [] } }).impl),
      'upstream',
      '缺 data[0].url → upstream 错误',
      'data[0].url'
    );

    // C11 无密钥
    await withEnvAsync(
      ['ZHIPU_API_KEY', 'GLM_API_KEY'],
      { ZHIPU_API_KEY: undefined, GLM_API_KEY: undefined },
      async () => {
        await expectImageError(
          () => provider.generate({ prompt: 'cat' }, makeFakeFetch({ json: {} }).impl),
          'auth',
          '无密钥 → auth 错误',
          'ZHIPU_API_KEY'
        );
      }
    );
  });

  // ============= [D] image-store =============
  console.log('\n[D] 图片本地缓存');
  const HASH = 'a'.repeat(32);
  ok(isSafeImageFile(`${HASH}.png`), '接受 32 位十六进制 + .png');
  ok(isSafeImageFile(`${HASH}.jpg`), '接受 .jpg');
  ok(isSafeImageFile(`${HASH}.webp`), '接受 .webp');
  ok(!isSafeImageFile('short.png'), '拒绝过短的哈希名');
  ok(!isSafeImageFile(`${HASH}.svg`), '拒绝未在白名单的扩展名 .svg');
  ok(!isSafeImageFile(`${HASH}.png/../../x`), '拒绝带路径片段的名字');
  ok(!isSafeImageFile('../secret.png'), '拒绝 ../ 开头');
  ok(!isSafeImageFile(''), '拒绝空名字');
  ok(!isSafeImageFile(`${'a'.repeat(70)}.png`), '拒绝超过 64 位的名字');

  {
    const dir = path.join(os.tmpdir(), `opc-imgstore-${Date.now()}`);
    ok(
      imageFilePath(dir, `${HASH}.png`).endsWith(`${HASH}.png`),
      '合法名字能解析出路径'
    );
    let threw = false;
    try {
      imageFilePath(dir, '../evil.png');
    } catch {
      threw = true;
    }
    ok(threw, 'imageFilePath 对非法名字抛错（目录穿越在进 fs 前被挡）');
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-imgstore-'));
    // 二进制响应不能用上面那个字符串版假 fetch（会把字节损坏），
    // 这里直接构造真正的 Response 承载 PNG 字节
    const pngFetch = (async () =>
      new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;

    // D1 正常下载
    const cached = await cacheImage('https://example.com/a.png', dir, pngFetch);
    ok(!!cached, '正常下载：返回落盘信息');
    ok(!!cached && /^[a-f0-9]{32}\.png$/.test(cached.file), '落盘文件名是内容哈希 + .png', cached?.file);
    ok(!!cached && cached.bytes === PNG_BYTES.byteLength, '落盘字节数与源一致');
    const onDisk = fs.readdirSync(dir);
    eq(onDisk.length, 1, '目录里恰好一个文件（无临时文件残留）');
    ok(
      fs.readFileSync(path.join(dir, onDisk[0])).equals(PNG_BYTES),
      '落盘内容与源字节完全一致'
    );

    // D2 重复缓存同一张图 → 不产生副本
    const again = await cacheImage('https://example.com/a.png', dir, pngFetch);
    eq(again?.file, cached?.file, '重复下载同一张图 → 命中同一文件名');
    eq(fs.readdirSync(dir).length, 1, '重复下载不产生第二个文件');

    // D3 HTTP 失败 → null（降级保留远端 URL，而不是让整次生图失败）
    const bad = await cacheImage(
      'https://example.com/b.png',
      dir,
      (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    );
    eq(bad, null, 'HTTP 500 → 返回 null（调用方降级）');

    // D4 非图片 content-type → null
    const wrongType = await cacheImage(
      'https://example.com/c',
      dir,
      (async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch
    );
    eq(wrongType, null, 'text/html 响应 → 返回 null');

    // D5 空 body → null
    const empty = await cacheImage(
      'https://example.com/d.png',
      dir,
      (async () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })) as unknown as typeof fetch
    );
    eq(empty, null, '空响应体 → 返回 null');

    // D6 fetch 抛异常 → null（不把异常抛给生图主流程）
    const threw = await cacheImage(
      'https://example.com/e.png',
      dir,
      (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch
    );
    eq(threw, null, 'fetch 抛异常 → 返回 null');

    eq(fs.readdirSync(dir).length, 1, '失败路径不留下任何文件');

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // ============= [E] DB：messages.images =============
  console.log('\n[E] messages.images 落库 / 读回 / 迁移');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-verify-image-db-'));

  // 造一个「老结构」的库：messages 表没有 images 列
  {
    const seed = new DatabaseSync(path.join(tmpDir, 'chat.db'));
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_id TEXT,
        sdk_session_id TEXT,
        kind TEXT NOT NULL DEFAULT 'direct',
        agent_ids TEXT,
        orchestration TEXT,
        cwd TEXT,
        scenario_id TEXT,
        system_prompt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        author_agent_id TEXT,
        created_at TEXT NOT NULL,
        tool_calls TEXT
      );
    `);
    const t = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO sessions (id, title, model, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('s-legacy', '老会话', 'm', 'hermes', t, t);
    seed
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('m-legacy', 's-legacy', 'assistant', '老消息', t);
    seed.close();
  }

  // 必须在 import 之前设好，db.ts 在模块加载时就打开库并跑迁移
  process.env.OPC_DATA_DIR = tmpDir;
  const db = await import('../server/db.js');

  // E1 迁移：老行读出的 images 为 null，不炸
  const legacyMsgs = db.getMessagesBySession('s-legacy');
  eq(legacyMsgs.length, 1, '迁移后老消息仍可读出');
  eq(legacyMsgs[0]?.images ?? null, null, '老消息 images 迁移后为 NULL');
  ok('images' in legacyMsgs[0], 'SELECT * 带出 images 列');

  // E2 写入 images 并读回
  const t2 = new Date().toISOString();
  db.createSession({
    id: 's-img',
    title: '生图会话',
    model: 'cogview-3-flash',
    agent_id: 'hermes',
    sdk_session_id: null,
    kind: 'direct',
    agent_ids: null,
    orchestration: null,
    cwd: null,
    scenario_id: 'image',
    system_prompt: null,
    created_at: t2,
    updated_at: t2,
  });
  const blocks = [
    {
      url: '/api/images/deadbeef.png',
      sourceUrl: 'https://example.com/x.png',
      prompt: '一只橘猫',
      size: '1024x1024',
      model: 'cogview-3-flash',
      provider: 'cogview',
      alt: '一只橘猫',
    },
  ];
  db.createMessage({
    id: 'msg-img',
    session_id: 's-img',
    role: 'assistant',
    content: '',
    model: 'cogview-3-flash',
    author_agent_id: 'hermes',
    created_at: t2,
    tool_calls: null,
    images: JSON.stringify(blocks),
  });
  const got = db.getMessagesBySession('s-img').find(m => m.id === 'msg-img');
  eq(JSON.parse(String(got?.images)), blocks, 'images JSON 原样读回');

  // E3 不传 images → NULL（纯文本消息不受影响）
  db.createMessage({
    id: 'msg-plain',
    session_id: 's-img',
    role: 'user',
    content: '一只橘猫',
    model: null,
    author_agent_id: null,
    created_at: t2,
    tool_calls: null,
  });
  eq(
    db.getMessagesBySession('s-img').find(m => m.id === 'msg-plain')?.images ?? null,
    null,
    '不传 images → 落 NULL'
  );

  // E4 updateMessage 可改 images
  db.updateMessage('msg-img', { images: JSON.stringify([{ ...blocks[0], size: '768x1344' }]) });
  eq(
    JSON.parse(String(db.getMessagesBySession('s-img').find(m => m.id === 'msg-img')?.images))[0].size,
    '768x1344',
    'updateMessage 可改 images'
  );

  // E5 images 目录跟随 OPC_DATA_DIR
  ok(
    db.imagesDir.startsWith(tmpDir),
    'imagesDir 跟随 OPC_DATA_DIR（与数据库同源）',
    db.imagesDir
  );

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上连接仍打开时可能删不掉，忽略 */
  }
}

/** withEnv 的异步版 */
async function withEnvAsync(
  keys: string[],
  values: Record<string, string | undefined>,
  fn: () => Promise<void>
) {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = values[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(
        `\n✗ 生图 provider 断言：${checks.total - failures.length}/${checks.total} 通过，${failures.length} 条失败`
      );
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\n生图 provider 断言：${checks.total}/${checks.total} 通过`);
    console.log('✓ 契约、常量一致性、错误映射、图片缓存与 images 落库均符合预期');
  })
  .catch(err => {
    console.error('验证脚本异常:', err);
    process.exit(1);
  });
