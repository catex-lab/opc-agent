-- OPC Agent 统计库表结构
-- 用法：npx wrangler d1 execute opc-stats --remote --file=schema.sql

-- ── 下载事件：由网站 /d/* 中转产生 ─────────────────────────────────
CREATE TABLE IF NOT EXISTS downloads (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,          -- unix 毫秒
  channel   TEXT    NOT NULL,          -- 'r2' | 'github'
  version   TEXT,
  country   TEXT,                      -- Cloudflare 提供的国家码，不存原始 IP
  referer   TEXT                       -- 只存来源站 host，不存完整 URL
);
CREATE INDEX IF NOT EXISTS idx_dl_ts ON downloads(ts);

-- ── 设备：客户端首次启动上报，一个安装一份 ─────────────────────────
CREATE TABLE IF NOT EXISTS installs (
  install_id  TEXT PRIMARY KEY,        -- 客户端生成的 UUIDv4
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  app_version TEXT,
  os          TEXT,
  arch        TEXT
);
CREATE INDEX IF NOT EXISTS idx_inst_first ON installs(first_seen);

-- ── 会话：一次启动一条，退出时回填时长 ─────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_sec INTEGER,
  app_version  TEXT,
  day          TEXT NOT NULL           -- 'YYYY-MM-DD'，客户端按本地时区算好
);
CREATE INDEX IF NOT EXISTS idx_sess_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_sess_install ON sessions(install_id, day);
