-- ============================================================
-- SHADOW OS v2 — Migration 006: Knowledge Foundation
-- Sprint 6: Read-only Knowledge Layer
--
-- Purpose:
--   Gives the forward-declared `knowledge_artifacts` table (created in
--   migration 001, 0 producers until now) its first producer — the
--   KnowledgeManager — and adds the supporting structures the Knowledge
--   Layer needs:
--
--     knowledge_artifacts  (extended) — versioned, immutable learned
--        intelligence. This migration ADDS provenance columns
--        (run_id, build_id, config_hash) + a source measurement window so
--        that every artifact is reproducible from the exact code + config +
--        research window that produced it. The core columns (value, checksum,
--        version, superseded_at, migration_from, training_events, confidence)
--        already exist from migration 001.
--
--     knowledge_snapshots  (new) — a point-in-time manifest of every ACTIVE
--        artifact version + checksum. A knowledge "save point" for
--        reproducibility and rollback verification. dedupe_key = the manifest
--        checksum, so re-snapshotting an unchanged active set is a no-op
--        (restarts never spam the time series).
--
-- Binding constraints (mission + Sacred Constraint):
--   • The Knowledge Layer is READ-ONLY with respect to live/shadow/risk. It
--     only READS the Shadow LAB tables + events + existing PG tables and
--     WRITES its own knowledge_* tables. Nothing here feeds back into a live
--     or shadow decision.
--   • Purely additive. Every statement is IF NOT EXISTS / ADD COLUMN IF NOT
--     EXISTS — idempotent, safe to run multiple times. No existing table,
--     column, or row is altered destructively, dropped, or truncated.
--   • knowledge_artifacts has 0 rows before this producer exists, so adding
--     columns is side-effect free.
--
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ── Step 1: provenance + source-window columns on knowledge_artifacts ──────
-- Nullable (no backfill needed — 0 pre-existing rows). KnowledgeManager always
-- populates them on insert. Kept as real columns (not inside `value`) so that
-- `value` stays pure content — the checksum is computed over content ONLY, so
-- a new boot (new run_id) never mints a spurious new artifact version.

ALTER TABLE knowledge_artifacts ADD COLUMN IF NOT EXISTS run_id             TEXT;
ALTER TABLE knowledge_artifacts ADD COLUMN IF NOT EXISTS build_id           TEXT;
ALTER TABLE knowledge_artifacts ADD COLUMN IF NOT EXISTS config_hash        TEXT;
ALTER TABLE knowledge_artifacts ADD COLUMN IF NOT EXISTS source_window_from TEXT;
ALTER TABLE knowledge_artifacts ADD COLUMN IF NOT EXISTS source_window_to   TEXT;

CREATE INDEX IF NOT EXISTS idx_ka_config_hash ON knowledge_artifacts (config_hash);
CREATE INDEX IF NOT EXISTS idx_ka_domain      ON knowledge_artifacts (domain);
CREATE INDEX IF NOT EXISTS idx_ka_created_at  ON knowledge_artifacts (created_at DESC);

-- ── Step 2: knowledge_snapshots ────────────────────────────────────────────
-- Point-in-time manifest of the ACTIVE knowledge set. Append-first time series:
-- one row per distinct active set (dedupe_key = manifest_checksum). Never
-- mutated, never deleted.

CREATE TABLE IF NOT EXISTS knowledge_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  artifact_count    INTEGER     NOT NULL DEFAULT 0,       -- number of active artifacts captured
  total_bytes       BIGINT      NOT NULL DEFAULT 0,       -- sum of byte_size across the manifest
  manifest          JSONB       NOT NULL DEFAULT '{}',    -- [{domain,artifact,version,checksum,id,byte_size}]
  manifest_checksum TEXT        NOT NULL,                 -- sha256 over the canonical manifest content
  -- provenance (binding)
  run_id            TEXT        NOT NULL,
  build_id          TEXT        NOT NULL,
  config_hash       TEXT        NOT NULL,
  dedupe_key        TEXT        NOT NULL,                 -- = manifest_checksum (idempotent restarts)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ks_dedupe      ON knowledge_snapshots (dedupe_key);
CREATE INDEX IF NOT EXISTS        idx_ks_created_at  ON knowledge_snapshots (created_at DESC);
CREATE INDEX IF NOT EXISTS        idx_ks_config_hash ON knowledge_snapshots (config_hash);

-- ── End of migration 006 ───────────────────────────────────────────────────
