-- ═══════════════════════════════════════════════════════════════════
-- SHADOW OS v2 — Schema Migration 002
-- Sprint 1: Runtime Awakening — Per-Domain Version History
-- ═══════════════════════════════════════════════════════════════════
--
-- SAFETY CONTRACT:
--   All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
--   This script is IDEMPOTENT — safe to run multiple times.
--   It NEVER modifies, drops, or truncates any existing table.
--
-- ADDS:
--   runtime_domain_history — immutable audit log of every mutation
--   to runtime_domains, enabling per-domain rollback to any version.
--
-- GOLDEN RULE:
--   No deployment, restart, or migration step may ever destroy the
--   accumulated trading knowledge of the system.
-- ═══════════════════════════════════════════════════════════════════

-- ── runtime_domain_history ───────────────────────────────────────────────
--
-- Immutable. Every UPDATE/PATCH/CAS/ROLLBACK/RESTORE to runtime_domains
-- appends a row here (inside the same transaction).
-- This enables:
--   - Full audit of who changed what and when
--   - Rollback to any previous version by reading this table
--   - Snapshot association (snapshot_id FK → system_snapshots)
--
-- This table is APPEND-ONLY. No row is ever deleted.
-- GC policy: rows older than 90 days with no snapshot_id may be pruned
-- by a future maintenance job (will be logged as consistency_log entry).

CREATE TABLE IF NOT EXISTS runtime_domain_history (
  id          BIGSERIAL   PRIMARY KEY,
  domain      TEXT        NOT NULL,
  version     BIGINT      NOT NULL,
  value       JSONB       NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  TEXT        NOT NULL DEFAULT 'system',
  change_op   TEXT        NOT NULL
              CHECK (change_op IN ('CREATE','UPDATE','PATCH','CAS','RESTORE','ROLLBACK','SNAPSHOT')),
  snapshot_id BIGINT      REFERENCES system_snapshots(id) ON DELETE SET NULL,
  notes       TEXT
);

-- Fast lookup: most recent history for a given domain
CREATE INDEX IF NOT EXISTS idx_rdh_domain_ver
  ON runtime_domain_history (domain, version DESC);

-- Time-range queries and GC
CREATE INDEX IF NOT EXISTS idx_rdh_changed_at
  ON runtime_domain_history (changed_at DESC);

-- Snapshot-associated history lookup
CREATE INDEX IF NOT EXISTS idx_rdh_snapshot
  ON runtime_domain_history (snapshot_id)
  WHERE snapshot_id IS NOT NULL;

-- ── End of migration 002 ─────────────────────────────────────────────────
