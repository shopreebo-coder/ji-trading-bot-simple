-- ============================================================
-- SHADOW OS v2 — Migration 005: Shadow LAB Foundation
-- Sprint 5: Research-only measurement layer
--
-- Purpose:
--   Creates the four RESEARCH tables that turn the existing
--   event-sourced Shadow LAB stream into a queryable, reproducible
--   measurement layer:
--
--     shadow_signals             — one row per observed signal
--     shadow_engine_evals        — one row per (signal, engine) evaluation
--     shadow_outcomes            — one row per resolved signal (realized P/L)
--     shadow_expectancy_snapshots— periodic expectancy aggregates (time series)
--
--   These tables NEVER feed back into live trading. They are a
--   read/measure layer only — populated by ShadowLabManager, which
--   reconciles the append-only `events` stream (trade_open,
--   lab_shadow_a/b/c/d, trade_close) into structured research rows.
--
-- Provenance (binding):
--   EVERY research row carries run_id + build_id + config_hash so that
--   every recorded measurement is reproducible from the exact code +
--   configuration that produced it. dedupe_key makes every write
--   idempotent (append-first, no-duplicate gate).
--
-- Sacred constraint:
--   Purely additive. All DDL uses IF NOT EXISTS — idempotent, safe to
--   run multiple times. No existing table, column, or row is altered,
--   dropped, or truncated. No row here may be deleted.
-- ============================================================

-- ── Step 1: shadow_signals ────────────────────────────────────────────────
-- One row per signal the Shadow LAB observed (sourced from trade_open).
-- `features` keeps the full raw signal for forward-compatible research;
-- promoted scalar columns exist for fast filtering/grouping.

CREATE TABLE IF NOT EXISTS shadow_signals (
  id                BIGSERIAL        PRIMARY KEY,
  signal_id         TEXT             NOT NULL,
  symbol            TEXT,
  session           TEXT,
  side              TEXT,
  fingerprint       TEXT,
  entry_gate        TEXT,
  pass_count        INTEGER,
  spread            DOUBLE PRECISION,
  atr_pips          DOUBLE PRECISION,
  ema_distance      DOUBLE PRECISION,
  candle_strength   DOUBLE PRECISION,
  trend_bucket      TEXT,
  volatility_bucket TEXT,
  spread_bucket     TEXT,
  live_would_trade  BOOLEAN          NOT NULL DEFAULT TRUE,   -- observed from a live trade_open
  features          JSONB            NOT NULL DEFAULT '{}',   -- full raw signal (extensible)
  source_ts         TEXT,                                     -- ISO ts of the source event
  source_event_id   BIGINT,                                   -- events.id of the source row
  -- provenance (binding)
  run_id            TEXT             NOT NULL,
  build_id          TEXT             NOT NULL,
  config_hash       TEXT             NOT NULL,
  dedupe_key        TEXT             NOT NULL,                 -- idempotency: one row per signal
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_dedupe       ON shadow_signals (dedupe_key);
CREATE INDEX IF NOT EXISTS        idx_ss_signal_id    ON shadow_signals (signal_id);
CREATE INDEX IF NOT EXISTS        idx_ss_symbol       ON shadow_signals (symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS        idx_ss_config_hash  ON shadow_signals (config_hash);
CREATE INDEX IF NOT EXISTS        idx_ss_created_at   ON shadow_signals (created_at DESC);

-- ── Step 2: shadow_engine_evals ───────────────────────────────────────────
-- One row per engine evaluation of a signal (engine_id ∈ A,B,C,D).
-- `eval` keeps the full engine output; promoted columns cover the common
-- research dimensions (decision / score / confidence / market_state / winrate).

CREATE TABLE IF NOT EXISTS shadow_engine_evals (
  id                  BIGSERIAL        PRIMARY KEY,
  signal_id           TEXT             NOT NULL,
  engine_id           TEXT             NOT NULL,               -- 'A' | 'B' | 'C' | 'D'
  engine_version      TEXT             NOT NULL DEFAULT 'unknown',
  would_trade         BOOLEAN,                                 -- engine decision (nullable = abstain)
  score               DOUBLE PRECISION,                        -- A score / D metaVoteScore (when applicable)
  confidence          TEXT,                                    -- LOW | MEDIUM | HIGH (engine-reported)
  market_state        TEXT,                                    -- Engine B
  historical_winrate  DOUBLE PRECISION,                        -- Engine C
  eval                JSONB            NOT NULL DEFAULT '{}',   -- full engine output (extensible)
  source_ts           TEXT,
  source_event_id     BIGINT,
  -- provenance (binding)
  run_id              TEXT             NOT NULL,
  build_id            TEXT             NOT NULL,
  config_hash         TEXT             NOT NULL,
  dedupe_key          TEXT             NOT NULL,               -- idempotency: one row per (signal, engine)
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_see_dedupe      ON shadow_engine_evals (dedupe_key);
CREATE INDEX IF NOT EXISTS        idx_see_signal_id   ON shadow_engine_evals (signal_id);
CREATE INDEX IF NOT EXISTS        idx_see_engine      ON shadow_engine_evals (engine_id);
CREATE INDEX IF NOT EXISTS        idx_see_config_hash ON shadow_engine_evals (config_hash);
CREATE INDEX IF NOT EXISTS        idx_see_created_at  ON shadow_engine_evals (created_at DESC);

-- ── Step 3: shadow_outcomes ───────────────────────────────────────────────
-- One row per resolved signal (sourced from trade_close). Realized P/L in pips.

CREATE TABLE IF NOT EXISTS shadow_outcomes (
  id                 BIGSERIAL        PRIMARY KEY,
  signal_id          TEXT             NOT NULL,
  symbol             TEXT,
  profit_pips        DOUBLE PRECISION,                         -- realized live P/L (pips)
  mfe                DOUBLE PRECISION,                         -- max favourable excursion
  mae                DOUBLE PRECISION,                         -- max adverse excursion
  duration_min       DOUBLE PRECISION,
  profit_given_back  DOUBLE PRECISION,
  outcome            JSONB            NOT NULL DEFAULT '{}',   -- full close event (extensible)
  source_ts          TEXT,
  source_event_id    BIGINT,
  -- provenance (binding)
  run_id             TEXT             NOT NULL,
  build_id           TEXT             NOT NULL,
  config_hash        TEXT             NOT NULL,
  dedupe_key         TEXT             NOT NULL,                -- idempotency: one row per resolved signal
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_so_dedupe       ON shadow_outcomes (dedupe_key);
CREATE INDEX IF NOT EXISTS        idx_so_signal_id    ON shadow_outcomes (signal_id);
CREATE INDEX IF NOT EXISTS        idx_so_config_hash  ON shadow_outcomes (config_hash);
CREATE INDEX IF NOT EXISTS        idx_so_created_at   ON shadow_outcomes (created_at DESC);

-- ── Step 4: shadow_expectancy_snapshots ───────────────────────────────────
-- Periodic expectancy aggregates. Append-first time series: one row per
-- distinct (config_hash, scope, resolved_trades) so re-computation with the
-- same data is a no-op, while each newly resolved trade yields a new point.
-- confidence_level is auto-computed from sample_count (LOW<30, MEDIUM 30–100,
-- HIGH>100) by ShadowLabManager and stored here for reproducibility.

CREATE TABLE IF NOT EXISTS shadow_expectancy_snapshots (
  id                 BIGSERIAL        PRIMARY KEY,
  scope              TEXT             NOT NULL DEFAULT 'ALL',  -- 'ALL' | symbol | engine scope
  sample_count       INTEGER          NOT NULL DEFAULT 0,      -- signals considered
  resolved_trades    INTEGER          NOT NULL DEFAULT 0,      -- signals with a recorded outcome
  wins               INTEGER          NOT NULL DEFAULT 0,
  losses             INTEGER          NOT NULL DEFAULT 0,
  total_profit_pips  DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross_profit_pips  DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross_loss_pips    DOUBLE PRECISION NOT NULL DEFAULT 0,      -- absolute value of losing pips
  expectancy_pips    DOUBLE PRECISION,                         -- total_profit_pips / resolved_trades
  profit_factor      DOUBLE PRECISION,                         -- gross_profit / gross_loss (null if no losses)
  confidence_level   TEXT             NOT NULL DEFAULT 'LOW',  -- LOW | MEDIUM | HIGH (from sample_count)
  window_from        TEXT,
  window_to          TEXT,
  detail             JSONB            NOT NULL DEFAULT '{}',   -- extensible breakdown
  -- provenance (binding)
  run_id             TEXT             NOT NULL,
  build_id           TEXT             NOT NULL,
  config_hash        TEXT             NOT NULL,
  dedupe_key         TEXT             NOT NULL,                -- idempotency: (config_hash, scope, resolved_trades)
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ses_dedupe      ON shadow_expectancy_snapshots (dedupe_key);
CREATE INDEX IF NOT EXISTS        idx_ses_scope       ON shadow_expectancy_snapshots (scope, created_at DESC);
CREATE INDEX IF NOT EXISTS        idx_ses_config_hash ON shadow_expectancy_snapshots (config_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS        idx_ses_created_at  ON shadow_expectancy_snapshots (created_at DESC);

-- ── End of migration 005 ──────────────────────────────────────────────────
