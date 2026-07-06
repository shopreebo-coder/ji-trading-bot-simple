-- ═══════════════════════════════════════════════════════════════════
-- SHADOW OS v2 — Schema Migration 001
-- Sprint 0: Foundation
-- ═══════════════════════════════════════════════════════════════════
--
-- SAFETY CONTRACT:
--   All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
--   This script is IDEMPOTENT — safe to run multiple times.
--   It NEVER modifies, drops, or truncates existing tables.
--   The three existing tables (events, shadowm_trades, shadowm_timeline)
--   are included here only to ensure indexes are present; they are not
--   recreated if they already exist.
--
-- GOLDEN RULE:
--   No deployment, restart, or migration step may ever destroy the
--   accumulated trading knowledge of the system.
-- ═══════════════════════════════════════════════════════════════════

-- ── EXISTING TABLES (indexes only added if missing) ──────────────────

CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL   PRIMARY KEY,
  ts      TEXT        NOT NULL,
  bot_id  TEXT,
  type    TEXT        NOT NULL,
  symbol  TEXT,
  data    JSONB
);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_id ON events (type, id DESC);

CREATE TABLE IF NOT EXISTS shadowm_trades (
  id            BIGSERIAL   PRIMARY KEY,
  signal_id     TEXT        UNIQUE NOT NULL,
  symbol        TEXT,
  side          TEXT,
  entry_time    TEXT,
  exit_time     TEXT,
  best_strategy TEXT,
  profit_live   DOUBLE PRECISION,
  profit_saved  DOUBLE PRECISION,
  mfe           DOUBLE PRECISION,
  mae           DOUBLE PRECISION,
  data          JSONB
);
CREATE INDEX IF NOT EXISTS idx_smt_signal_id  ON shadowm_trades (signal_id);
CREATE INDEX IF NOT EXISTS idx_smt_exit_time  ON shadowm_trades (exit_time);

CREATE TABLE IF NOT EXISTS shadowm_timeline (
  id        BIGSERIAL PRIMARY KEY,
  signal_id TEXT      NOT NULL,
  ts        TEXT      NOT NULL,
  pips      DOUBLE PRECISION,
  mfe       DOUBLE PRECISION,
  mae       DOUBLE PRECISION,
  minutes   DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_smt_signal ON shadowm_timeline (signal_id);

-- ── ARCH-B: runtime_domains ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runtime_domains (
  domain      TEXT        PRIMARY KEY,
  version     BIGINT      NOT NULL DEFAULT 0,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER     NOT NULL DEFAULT 1
);

-- ── ARCH-B: trade_intents ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trade_intents (
  id              BIGSERIAL   PRIMARY KEY,
  signal_id       TEXT        NOT NULL,
  intent_type     TEXT        NOT NULL CHECK (intent_type IN ('OPEN','CLOSE','MODIFY')),
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','CONFIRMED','FAILED','RECONCILED')),
  oanda_order_id  TEXT,
  symbol          TEXT        NOT NULL,
  side            TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  UNIQUE (signal_id, intent_type)
);
CREATE INDEX IF NOT EXISTS idx_ti_pending ON trade_intents (status) WHERE status = 'PENDING';

-- ── SHADOW OS v2: memory_entries ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_entries (
  id           BIGSERIAL   PRIMARY KEY,
  namespace    TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  value        JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  access_count BIGINT      NOT NULL DEFAULT 0,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  UNIQUE (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_mem_ns       ON memory_entries (namespace);
CREATE INDEX IF NOT EXISTS idx_mem_expires  ON memory_entries (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_tags     ON memory_entries USING GIN (tags);

-- ── SHADOW OS v2: knowledge_artifacts ───────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_artifacts (
  id              BIGSERIAL   PRIMARY KEY,
  domain          TEXT        NOT NULL,
  artifact        TEXT        NOT NULL,
  version         BIGINT      NOT NULL,
  value           JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ,
  checksum        TEXT        NOT NULL,
  byte_size       INTEGER,
  training_events INTEGER,
  confidence      DOUBLE PRECISION,
  migration_from  BIGINT      REFERENCES knowledge_artifacts(id),
  notes           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_active
  ON knowledge_artifacts (domain, artifact) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ka_history
  ON knowledge_artifacts (domain, artifact, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_checksum
  ON knowledge_artifacts (domain, artifact, checksum);

-- ── SHADOW OS v2: event_idempotency ─────────────────────────────────

CREATE TABLE IF NOT EXISTS event_idempotency (
  key        TEXT        PRIMARY KEY,
  event_id   BIGINT      REFERENCES events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eidem_created ON event_idempotency (created_at);

-- ── SHADOW OS v2: consistency_log ────────────────────────────────────

CREATE TABLE IF NOT EXISTS consistency_log (
  id            BIGSERIAL   PRIMARY KEY,
  check_id      TEXT        NOT NULL,
  severity      TEXT        NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  domain        TEXT,
  description   TEXT        NOT NULL,
  detail        JSONB,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  auto_repaired BOOLEAN     NOT NULL DEFAULT FALSE,
  repair_detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_clog_open ON consistency_log (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clog_sev  ON consistency_log (severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_clog_chk  ON consistency_log (check_id, detected_at DESC);

-- ── SHADOW OS v2: system_snapshots ───────────────────────────────────

CREATE TABLE IF NOT EXISTS system_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_type      TEXT        NOT NULL,
  runtime_summary   JSONB       NOT NULL,
  memory_summary    JSONB       NOT NULL,
  knowledge_summary JSONB       NOT NULL,
  system_status     TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_created ON system_snapshots (created_at DESC);

-- ── Bootstrap runtime_domains (10 domain rows) ───────────────────────
-- ON CONFLICT DO NOTHING: safe to run on a database that already has
-- these rows. Existing rows are never overwritten.

INSERT INTO runtime_domains (domain, version, value, schema_ver) VALUES
  ('live',
   0,
   '{"dailyTrades":0,"openTrades":{},"date":"","sequence":0}',
   1),
  ('shadowA',
   0,
   '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}',
   1),
  ('shadowB',
   0,
   '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}',
   1),
  ('shadowC',
   0,
   '{"datasetVersion":0,"datasetSize":0,"lastTrainTs":"","nearestK":5,"accuracy":0}',
   1),
  ('shadowD',
   0,
   '{"weightsVersion":0,"lastTrainTs":"","conditionCount":0,"topConditions":[],"confidence":0}',
   1),
  ('shadowM',
   0,
   '{"lastId":0,"active":{},"knownSids":[],"pollCount":0,"lastPollTs":""}',
   1),
  ('exitLab',
   0,
   '{"strategiesLoaded":[],"bestStrategy":"","strategyVersions":{},"evaluationsThisSession":0}',
   1),
  ('telemetry',
   0,
   '{"lastEventId":0,"eventCount":0,"errorCount":0,"lastErrorTs":"","dbBackend":""}',
   1),
  ('scheduler',
   0,
   '{"nextCycleTs":"","lastCycleTs":"","cycleCount":0,"shadowLabInterval":30000,"botPid":null}',
   1),
  ('meta',
   0,
   '{"systemVersion":"v40.1","schemaVersion":1,"bootCount":0,"uptimeStart":"","lastCleanShutdown":"","status":"HALTED"}',
   1)
ON CONFLICT (domain) DO NOTHING;

-- ── End of migration 001 ─────────────────────────────────────────────
