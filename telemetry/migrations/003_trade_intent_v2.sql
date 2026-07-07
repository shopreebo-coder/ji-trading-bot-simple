-- ============================================================
-- SHADOW OS v2 — Migration 003: Trade Intent V2
-- Sprint 2: Intent Foundation
--
-- Purpose:
--   Extends trade_intents with full Sprint 2 lifecycle columns.
--   Creates trade_intent_history for append-only audit trail.
--
-- Sacred constraint:
--   No row may be deleted. No history may be modified.
--   All DDL uses IF NOT EXISTS / safe DO blocks.
--   Table has 0 rows in production and is not used by any
--   production code — safe to extend without side effects.
--
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ── Step 1: Add Sprint 2 columns to trade_intents ─────────────────────────

ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS runtime_domain    TEXT             NOT NULL DEFAULT 'live';
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS engine_source     TEXT             NOT NULL DEFAULT 'system';
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS strategy_id       TEXT             NOT NULL DEFAULT 'default';
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS direction         TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS confidence        DOUBLE PRECISION;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS risk_score        DOUBLE PRECISION;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS position_size     DOUBLE PRECISION;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS stop_loss         DOUBLE PRECISION;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS take_profit       DOUBLE PRECISION;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS reasoning         TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW();
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS version           BIGINT           NOT NULL DEFAULT 0;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS metadata          JSONB            NOT NULL DEFAULT '{}';
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS validation_detail JSONB;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS execution_detail  JSONB;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS cancelled_reason  TEXT;

-- ── Step 2: Update status CHECK constraint ────────────────────────────────
-- Drop the existing status check (table has 0 rows — no risk of constraint violation).
-- Re-add with full Sprint 2 lifecycle values plus legacy values for compatibility.

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM   pg_constraint
  WHERE  conrelid = 'trade_intents'::regclass
    AND  contype  = 'c'
    AND  pg_get_constraintdef(oid) LIKE '%status%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE 'ALTER TABLE trade_intents DROP CONSTRAINT ' || quote_ident(v_constraint);
  END IF;
END
$$;

ALTER TABLE trade_intents
  ADD CONSTRAINT trade_intents_status_check
  CHECK (status IN (
    'PENDING', 'CONFIRMED', 'FAILED', 'RECONCILED',
    'CREATED', 'VALIDATED', 'APPROVED', 'EXECUTED',
    'REJECTED', 'CANCELLED', 'ARCHIVED'
  ));

-- ── Step 3: Direction CHECK constraint ───────────────────────────────────

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM   pg_constraint
  WHERE  conrelid = 'trade_intents'::regclass
    AND  contype  = 'c'
    AND  pg_get_constraintdef(oid) LIKE '%direction%';

  IF v_constraint IS NULL THEN
    ALTER TABLE trade_intents
      ADD CONSTRAINT trade_intents_direction_check
      CHECK (direction IN ('BUY', 'SELL', 'NONE') OR direction IS NULL);
  END IF;
END
$$;

-- ── Step 4: Additional indexes ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ti_runtime_domain  ON trade_intents (runtime_domain);
CREATE INDEX IF NOT EXISTS idx_ti_engine_source   ON trade_intents (engine_source);
CREATE INDEX IF NOT EXISTS idx_ti_created_at      ON trade_intents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ti_status_domain   ON trade_intents (status, runtime_domain);
CREATE INDEX IF NOT EXISTS idx_ti_signal_id       ON trade_intents (signal_id);

-- ── Step 5: Create trade_intent_history ──────────────────────────────────
-- Append-only audit trail of every intent state transition.
-- SACRED: no row in this table may ever be deleted.

CREATE TABLE IF NOT EXISTS trade_intent_history (
  id          BIGSERIAL    PRIMARY KEY,
  intent_id   BIGINT       NOT NULL REFERENCES trade_intents(id),
  from_status TEXT,
  to_status   TEXT         NOT NULL,
  version     BIGINT       NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  changed_by  TEXT         NOT NULL DEFAULT 'system',
  detail      JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tih_intent_id   ON trade_intent_history (intent_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tih_changed_at  ON trade_intent_history (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tih_to_status   ON trade_intent_history (to_status);
