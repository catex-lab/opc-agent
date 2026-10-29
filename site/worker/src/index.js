/**
 * OPC Agent — 下载中转 + 看板查询 Worker
 *
 * ⚠️ 客户端埋点接口（/api/v1/install、/api/v1/session/start、/api/v1/session/end）
 *    仍然保留，但 **A141 已把客户端遥测模块整体删除**，目前没有调用方。
 *    因此 installs / sessions 两张表会一直是空的，看板里对应的指标恒为 0。
 *    要恢复上报，先重建客户端模块（含设置开关与隐私页文案），不要只加环境变量。
 *
 * 设计原则：
 *   1. 埋点接口永不阻塞客户端 —— 任何异常都返回 200，客户端 fire-and-forget。
 *   2. 写入量是免费额度的命门 —— 所以只做「启动开 session / 退出补时长」，
 *      不做秒级心跳。1000 用户每天约 6000 行写入，D1 免费额度 10 万行/天。
 *   3. 只存聚合需要的东西 —— 不存原始 IP、不存完整 UA、不存聊天内容。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 实例级简易限流。Worker 重启即清空，够挡住误刷，不是安全边界。
const rateBuckets = new Map();

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

/** 埋点类接口：无论成败都回 200，避免客户端因上报失败而报错 */
function ack(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 4096) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (e) {
    return null;
  }
}

function limited(key, max) {
  const hour = Math.floor(Date.now() / 3600000);
  const bucket = key + ':' + hour;
  const n = (rateBuckets.get(bucket) || 0) + 1;
  rateBuckets.set(bucket, n);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return n > max;
}

function utcDay(ts) {
  return new Date(ts || Date.now()).toISOString().slice(0, 10);
}

function refererHost(request) {
  const ref = request.headers.get('referer');
  if (!ref) return null;
  try {
    return new URL(ref).host.slice(0, 100);
  } catch (e) {
    return null;
  }
}

// ── GitHub Release：带 Cache API 缓存，避免打爆 API 限额 ──────────────
async function getLatestRelease(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://opc-cache.internal/release/' + env.GITHUB_REPO);

  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return await hit.json(); } catch (e) { /* 缓存坏了就重新拉 */ }
  }

  const res = await fetch('https://api.github.com/repos/' + env.GITHUB_REPO + '/releases?per_page=5', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'opc-agent-site',
    },
  });
  if (!res.ok) return null;

  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;

  const top = list[0];
  const exe = (top.assets || []).filter((a) => /\.exe$/i.test(a.name));
  const setup = exe.filter((a) => /setup/i.test(a.name))[0] || exe[0] || null;

  const data = {
    latest: {
      tag: top.tag_name || '',
      version: (top.tag_name || '').replace(/^v/, ''),
      publishedAt: top.published_at || '',
      sizeBytes: setup ? setup.size : 0,
      assetName: setup ? setup.name : '',
      assetUrl: setup ? setup.browser_download_url : '',
    },
    releases: list.map((r) => ({
      tag: r.tag_name || '',
      name: r.name || r.tag_name || '',
      publishedAt: r.published_at || '',
    })),
  };

  const payload = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });
  ctx.waitUntil(cache.put(cacheKey, payload.clone()));
  return data;
}

// ── 下载中转：记一条，再 302 到真实地址 ──────────────────────────────
async function handleDownload(request, env, ctx, target) {
  const url = new URL(request.url);
  const forceChannel = url.searchParams.get('ch');
  const release = await getLatestRelease(env, ctx);
  if (!release || !release.latest.assetUrl) {
    return Response.redirect('https://github.com/' + env.GITHUB_REPO + '/releases/latest', 302);
  }

  const { assetUrl, assetName, tag } = release.latest;
  const useR2 = !!env.R2_PUBLIC_BASE && forceChannel !== 'gh';
  const dest = useR2
    ? env.R2_PUBLIC_BASE.replace(/\/$/, '') + '/' + encodeURIComponent(tag) + '/' + encodeURIComponent(assetName)
    : assetUrl;

  const now = Date.now();
  ctx.waitUntil(
    env.DB.prepare(
      'INSERT INTO downloads (ts, channel, version, country, referer) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(
        now,
        useR2 ? 'r2' : 'github',
        release.latest.version,
        (request.cf && request.cf.country) || null,
        refererHost(request)
      )
      .run()
      .catch(() => {})
  );

  return new Response(null, {
    status: 302,
    headers: { Location: dest, 'Cache-Control': 'no-store' },
  });
}

// ── 看板聚合查询 ────────────────────────────────────────────────────
async function handleStats(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.STATS_KEY || key !== env.STATS_KEY) {
    return json({ error: 'unauthorized' }, 401, env);
  }

  const now = Date.now();
  const day = 86400000;
  const today = utcDay(now);
  const d7 = utcDay(now - 7 * day);
  const d30 = utcDay(now - 30 * day);

  const stmts = [
    env.DB.prepare('SELECT COUNT(*) AS c FROM downloads'),
    env.DB.prepare('SELECT COUNT(*) AS c FROM installs'),
    env.DB.prepare('SELECT COUNT(*) AS c FROM downloads WHERE ts >= ?').bind(now - day),
    env.DB.prepare('SELECT COUNT(*) AS c FROM downloads WHERE ts >= ?').bind(now - 7 * day),
    env.DB.prepare('SELECT COUNT(*) AS c FROM downloads WHERE ts >= ?').bind(now - 30 * day),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS c FROM sessions WHERE day = ?').bind(today),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS c FROM sessions WHERE day >= ?').bind(d7),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS c FROM sessions WHERE day >= ?').bind(d30),
    env.DB.prepare(
      'SELECT AVG(c) AS v FROM (SELECT install_id, COUNT(DISTINCT day) AS c FROM sessions GROUP BY install_id)'
    ),
    env.DB.prepare(
      'SELECT AVG(duration_sec) AS v FROM sessions WHERE duration_sec > 5 AND duration_sec < 86400'
    ),
    env.DB.prepare(
      'SELECT app_version AS k, COUNT(DISTINCT install_id) AS c FROM sessions WHERE app_version IS NOT NULL GROUP BY app_version ORDER BY c DESC LIMIT 6'
    ),
    env.DB.prepare('SELECT channel AS k, COUNT(*) AS c FROM downloads GROUP BY channel ORDER BY c DESC'),
    env.DB.prepare(
      'SELECT day AS k, COUNT(DISTINCT install_id) AS c FROM sessions WHERE day >= ? GROUP BY day ORDER BY day'
    ).bind(d14(now)),
  ];

  let r;
  try {
    r = await env.DB.batch(stmts);
  } catch (e) {
    return json({ error: 'db_error', message: String(e && e.message) }, 500, env);
  }

  const one = (i) => (r[i].results && r[i].results[0]) || {};

  return json({
    generatedAt: now,
    totals: {
      downloads: one(0).c || 0,
      installs: one(1).c || 0,
      downloadsToday: one(2).c || 0,
      downloads7d: one(3).c || 0,
      downloads30d: one(4).c || 0,
    },
    active: {
      dau: one(5).c || 0,
      wau: one(6).c || 0,
      mau: one(7).c || 0,
      avgActiveDays: Math.round((one(8).v || 0) * 10) / 10,
      avgSessionSec: Math.round(one(9).v || 0),
    },
    byVersion: r[10].results || [],
    byChannel: r[11].results || [],
    trend: r[12].results || [],
  }, 200, env);
}

function d14(now) {
  return utcDay(now - 14 * 86400000);
}

// ── 路由 ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // 下载中转
    if (path.startsWith('/d/')) {
      return handleDownload(request, env, ctx, path.slice(3));
    }

    // GitHub 直达
    if (path === '/github') {
      return Response.redirect('https://github.com/' + env.GITHUB_REPO + '/releases/latest', 302);
    }

    // 更新清单反代：让 electron-updater 不必直连 GitHub
    if (path === '/update/latest.yml') {
      return Response.redirect(
        'https://github.com/' + env.GITHUB_REPO + '/releases/latest/download/latest.yml',
        302
      );
    }

    // 最新版本信息（站点用，带缓存）
    if (path === '/api/v1/release' && method === 'GET') {
      const data = await getLatestRelease(env, ctx);
      return data ? json(data, 200, env) : json({ error: 'unavailable' }, 503, env);
    }

    // 看板数据
    if (path === '/api/v1/stats' && method === 'GET') {
      return handleStats(request, env);
    }

    // 首次启动上报：upsert 设备
    if (path === '/api/v1/install' && method === 'POST') {
      const body = await readBody(request);
      if (!body || !UUID_RE.test(body.install_id || '')) return ack(env);
      if (limited('i:' + body.install_id, 10)) return ack(env);

      const now = Date.now();
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO installs (install_id, first_seen, last_seen, app_version, os, arch)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(install_id) DO UPDATE SET
             last_seen = excluded.last_seen,
             app_version = excluded.app_version`
        )
          .bind(
            body.install_id,
            now,
            now,
            str(body.app_version, 32),
            str(body.os, 32),
            str(body.arch, 16)
          )
          .run()
          .catch(() => {})
      );
      return ack(env);
    }

    // 会话开始
    if (path === '/api/v1/session/start' && method === 'POST') {
      const body = await readBody(request);
      if (!body || !UUID_RE.test(body.install_id || '')) return ack(env);
      if (!body.session_id || String(body.session_id).length > 64) return ack(env);
      if (limited('s:' + body.install_id, 10)) return ack(env);

      const now = Date.now();
      const day = DAY_RE.test(body.day || '') ? body.day : utcDay(now);
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT OR IGNORE INTO sessions (session_id, install_id, started_at, app_version, day)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            String(body.session_id).slice(0, 64),
            body.install_id,
            now,
            str(body.app_version, 32),
            day
          )
          .run()
          .catch(() => {})
      );
      return ack(env);
    }

    // 会话结束：回填时长
    if (path === '/api/v1/session/end' && method === 'POST') {
      const body = await readBody(request);
      if (!body || !body.session_id) return ack(env);
      const sec = Math.max(0, Math.min(Number(body.duration_sec) || 0, 86400));

      ctx.waitUntil(
        env.DB.prepare('UPDATE sessions SET ended_at = ?, duration_sec = ? WHERE session_id = ?')
          .bind(Date.now(), sec, String(body.session_id).slice(0, 64))
          .run()
          .catch(() => {})
      );
      return ack(env);
    }

    if (path === '/api/v1/health') {
      return json({ ok: true, ts: Date.now() }, 200, env);
    }

    return json({ error: 'not_found' }, 404, env);
  },
};

function str(v, max) {
  if (v == null) return null;
  return String(v).slice(0, max);
}
