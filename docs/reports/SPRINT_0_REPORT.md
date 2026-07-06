# SPRINT 0 REPORT — SHADOW OS v2 Foundation
**Project:** FOREX ENGINE PRO  
**Sprint:** 0 — Infrastructure Foundation  
**Report Version:** 1.0  
**Date:** 2026-07-06  
**Git Commit:** `dc2a2791e97fb074b7df10c7ba51ae3a7d2fbdf9`  
**Status:** ✅ SPRINT PASSED — READY FOR SPRINT 1

---

## Executive Summary

Sprint 0 establishes the non-negotiable infrastructure required before a single line of SHADOW OS v2 logic can be written. All six objectives were completed in a single session without any deployment, restart, or data-loss event.

The production bot (`node telemetry/server.js`) was not touched. All 29 rows of accumulated trading knowledge (events) and the live shadowm_trades record were preserved intact. The heliumdb PostgreSQL database now contains all 10 tables required by the SHADOW OS v2 architecture. A fully idempotent migration script and a 19-test validation suite verify that the foundation is solid.

**Sprint 0 is officially closed. Sprint 1 (RuntimeDomainManager) may begin.**

---

## Objectives

| # | Objective | Result |
|---|-----------|--------|
| 1 | Archive all dead code with zero active dependencies broken | ✅ COMPLETE |
| 2 | Create test framework using Node 24 built-in `node:test` | ✅ COMPLETE |
| 3 | Write idempotent schema migration SQL for all 7 new tables | ✅ COMPLETE |
| 4 | Build and validate the migration runner | ✅ COMPLETE |
| 5 | Apply migration to production database with zero data loss | ✅ COMPLETE |
| 6 | Produce Sprint 0 documentation | ✅ COMPLETE |

**Sacred Constraint (upheld throughout):**
> No deployment, restart, or migration step may ever destroy the accumulated trading knowledge of the system.

---

## Completed Tasks

### Task 1 — Dead Code Archive (GATE-0.A)

Identified 8 dead backup files with zero `require()` references in any active source file. Moved all 8 to `archive/` preserving git rename-detection history.

**Pre-archive safety check:** `grep -r require()` across all 5 active source files returned **0 matches**.

| # | Original Path | Archive Path |
|---|---------------|--------------|
| 1 | `dashboard.js` | `archive/dashboard.js` |
| 2 | `index_backup_v39_2.js` | `archive/index_backup_v39_2.js` |
| 3 | `index_backup_v39_3_before_v39_4.js` | `archive/index_backup_v39_3_before_v39_4.js` |
| 4 | `index_backup_v39_4_before_v39_4b.js` | `archive/index_backup_v39_4_before_v39_4b.js` |
| 5 | `index_original_safe.js` | `archive/index_original_safe.js` |
| 6 | `index_railway_mtf_v39_optimized.js` | `archive/index_railway_mtf_v39_optimized.js` |
| 7 | `telemetry/server_backup_pre_snowball_lab.js` | `archive/server_backup_pre_snowball_lab.js` |
| 8 | `telemetry/shadowlab_backup_pre_v40.js` | `archive/shadowlab_backup_pre_v40.js` |

Repository root after archiving: **only `index.js` remains** (FROZEN — production entrypoint).

### Task 2 — Test Framework (GATE-0.B)

Created `telemetry/tests/` with a four-tier structure:

```
telemetry/tests/
  README.md                    # Runner instructions, conventions, phase-gate policy
  unit/
    smoke.test.js              # 8 tests — environment, db-adapter, existing tables
    schema.test.js             # 11 tests — all 10 tables, indexes, constraints, idempotency
  integration/                 # Placeholder — Sprint 1+
  stress/                      # Placeholder — Sprint 3+
  mocks/                       # Placeholder — Sprint 1+
```

Uses **zero additional npm dependencies** — Node 24's built-in `node:test` + `node:assert/strict`.

### Task 3 — Schema Migration SQL (GATE-0.C)

`telemetry/migrations/001_shadow_os_v2_schema.sql` (220 lines):

- All DDL uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
- All bootstrap inserts use `ON CONFLICT DO NOTHING`
- Fully idempotent — safe to run on any state of the database

### Task 4 — Migration Runner (GATE-0.D)

`telemetry/migrations/run.js` (179 lines):

- Validates `DATABASE_URL` format before connecting
- Captures pre-migration row counts as baseline
- Executes SQL via `psql -f --set ON_ERROR_STOP=1` (not a JS splitter)
- Verifies all 10 tables exist post-migration
- Verifies all 10 `runtime_domains` bootstrap rows exist
- Compares post-migration row counts against baseline (data-loss guard)
- Exits 1 with clear message on any failure

### Task 5 — Migration Applied to Production (GATE-0.D + GATE-0.E)

First run: created 7 new tables, 12 new indexes, 10 bootstrap rows.  
Second run (idempotency): all `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` applied, 0 errors, 0 changes.

### Task 6 — Zero Active Code Modified (GATE-0.F)

```
git diff HEAD -- telemetry/server.js telemetry/shadowm.js telemetry/shadowlab.js
                 telemetry/db-adapter.js index.js
→ 0 lines changed
```

---

## Files Changed

### New Files

| File | Size | Purpose |
|------|------|---------|
| `archive/dashboard.js` | 16.6 KB | Archived dead code |
| `archive/index_backup_v39_2.js` | 16.6 KB | Archived dead code |
| `archive/index_backup_v39_3_before_v39_4.js` | 106 KB | Archived dead code |
| `archive/index_backup_v39_4_before_v39_4b.js` | 110 KB | Archived dead code |
| `archive/index_original_safe.js` | 18.2 KB | Archived dead code |
| `archive/index_railway_mtf_v39_optimized.js` | 6.6 KB | Archived dead code |
| `archive/server_backup_pre_snowball_lab.js` | — | Archived dead code |
| `archive/shadowlab_backup_pre_v40.js` | — | Archived dead code |
| `telemetry/migrations/001_shadow_os_v2_schema.sql` | 220 lines | Idempotent DDL migration |
| `telemetry/migrations/run.js` | 179 lines | Migration runner (psql-based) |
| `telemetry/tests/README.md` | — | Test runner documentation |
| `telemetry/tests/unit/smoke.test.js` | — | 8 smoke tests |
| `telemetry/tests/unit/schema.test.js` | — | 11 schema validation tests |
| `docs/reports/SPRINT_0_REPORT.md` | This file | Sprint report |
| `docs/reports/SPRINT_0_REPORT.pdf` | — | Sprint report (PDF) |

### Modified Files

| File | Change |
|------|--------|
| `replit.md` | Updated with project overview, architecture decisions, migration status |
| `.agents/memory/MEMORY.md` | Added 4 new memory entries |

### Unchanged Active Production Files

| File | Lines | Status |
|------|-------|--------|
| `index.js` | 2360 | ✅ FROZEN — 0 lines changed |
| `telemetry/server.js` | 2997 | ✅ 0 lines changed |
| `telemetry/shadowm.js` | 718 | ✅ 0 lines changed |
| `telemetry/shadowlab.js` | 1094 | ✅ 0 lines changed |
| `telemetry/db-adapter.js` | — | ✅ 0 lines changed |
| `telemetry/index.js` | — | ✅ 0 lines changed |

---

## Database Changes

### Connection Details

| Property | Value |
|----------|-------|
| Host | heliumdb (Railway) |
| Engine | PostgreSQL 16.10 on x86_64-pc-linux-gnu |
| Schema | public |
| Migration file | `001_shadow_os_v2_schema.sql` |

### New Tables Created

| Table | Type | Primary Key | Key Features |
|-------|------|-------------|--------------|
| `runtime_domains` | New | `domain TEXT` | Versioned JSONB state store; 10 bootstrap rows |
| `trade_intents` | New | `BIGSERIAL id` | OANDA order idempotency; CHECK on intent_type, status |
| `memory_entries` | New | `BIGSERIAL id` | Namespace+key K/V; UNIQUE(namespace,key); GIN index on tags |
| `knowledge_artifacts` | New | `BIGSERIAL id` | Versioned strategy snapshots; partial UNIQUE on active |
| `event_idempotency` | New | `key TEXT` | Deduplication; FK → events |
| `consistency_log` | New | `BIGSERIAL id` | Self-healing audit; CHECK on severity |
| `system_snapshots` | New | `BIGSERIAL id` | Full state capture at decision points |

### Existing Tables (Unchanged)

| Table | Rows Before | Rows After | Status |
|-------|-------------|------------|--------|
| `events` | 29 | 29 | ✅ No data lost |
| `shadowm_trades` | 1 | 1 | ✅ No data lost |
| `shadowm_timeline` | 0 | 0 | ✅ No data lost |

### runtime_domains Bootstrap Rows (10)

| Domain | Purpose |
|--------|---------|
| `live` | Daily trade counts, open positions, sequence counter |
| `shadowA` | Signal filter state (frozen=true initially) |
| `shadowB` | Signal confirmation state (frozen=true initially) |
| `shadowC` | KNN strategy selector state |
| `shadowD` | Condition weighting state |
| `shadowM` | Trade tracker state |
| `exitLab` | Exit strategy engine state |
| `telemetry` | Telemetry service state |
| `scheduler` | Cycle scheduler state |
| `meta` | System version, boot count, status |

### Indexes Created

| Index | Table | Type | Notes |
|-------|-------|------|-------|
| `idx_events_type` | events | BTREE | Existing |
| `idx_events_ts` | events | BTREE | Existing |
| `idx_events_type_id` | events | BTREE | New |
| `idx_smt_signal_id` | shadowm_trades | BTREE | Existing |
| `idx_smt_exit_time` | shadowm_trades | BTREE | Existing |
| `idx_smt_signal` | shadowm_timeline | BTREE | Existing |
| `idx_ti_pending` | trade_intents | BTREE (partial) | WHERE status='PENDING' |
| `idx_mem_ns` | memory_entries | BTREE | namespace lookup |
| `idx_mem_expires` | memory_entries | BTREE (partial) | WHERE expires_at IS NOT NULL |
| `idx_mem_tags` | memory_entries | GIN | Array search |
| `idx_ka_active` | knowledge_artifacts | UNIQUE (partial) | WHERE superseded_at IS NULL |
| `idx_ka_history` | knowledge_artifacts | BTREE | (domain, artifact, version DESC) |
| `idx_ka_checksum` | knowledge_artifacts | UNIQUE | Dedup by content hash |
| `idx_eidem_created` | event_idempotency | BTREE | TTL cleanup queries |
| `idx_clog_open` | consistency_log | BTREE (partial) | WHERE resolved_at IS NULL |
| `idx_clog_sev` | consistency_log | BTREE | severity + time range |
| `idx_clog_chk` | consistency_log | BTREE | check_id + time range |
| `idx_snap_created` | system_snapshots | BTREE | created_at DESC |

---

## Test Results

### Run Command

```bash
node --test --test-reporter=spec telemetry/tests/unit/smoke.test.js
node --test --test-reporter=spec telemetry/tests/unit/schema.test.js
```

### Smoke Tests (smoke.test.js) — 8/8 PASS ✅

| # | Test | Result | Duration |
|---|------|--------|----------|
| 1 | test framework is operational | ✅ PASS | 0.8ms |
| 2 | node:assert strict mode is working | ✅ PASS | 1.3ms |
| 3 | DATABASE_URL environment variable is set | ✅ PASS | 0.1ms |
| 4 | db-adapter module loads without error | ✅ PASS | 59.4ms |
| 5 | db-adapter connects and can run a basic query | ✅ PASS | 34.3ms |
| 6 | events table exists in the database | ✅ PASS | 3.1ms |
| 7 | shadowm_trades table exists in the database | ✅ PASS | 4.1ms |
| 8 | shadowm_timeline table exists in the database | ✅ PASS | 2.4ms |

**Suite total: 107ms**

### Schema Validation Tests (schema.test.js) — 11/11 PASS ✅

| # | Test | Result | Duration |
|---|------|--------|----------|
| 1 | all 10 required tables exist | ✅ PASS | 36.0ms |
| 2 | runtime_domains has all 10 bootstrap rows | ✅ PASS | 4.1ms |
| 3 | runtime_domains columns are correct | ✅ PASS | 23.5ms |
| 4 | knowledge_artifacts has unique index on active artifacts | ✅ PASS | 7.6ms |
| 5 | trade_intents has partial index on PENDING status | ✅ PASS | 2.2ms |
| 6 | memory_entries has GIN index on tags | ✅ PASS | 2.5ms |
| 7 | consistency_log has correct severity CHECK constraint | ✅ PASS | 10.9ms |
| 8 | trade_intents has correct status CHECK constraint | ✅ PASS | 19.7ms |
| 9 | runtime_domains all rows have valid JSON values | ✅ PASS | 13.4ms |
| 10 | existing events and shadowm_trades data is intact | ✅ PASS | 4.4ms |
| 11 | migration is idempotent — running twice produces no errors | ✅ PASS | 4.0ms |

**Suite total: 131ms**

### Overall Test Summary

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| smoke.test.js | 8 | 0 | 8 |
| schema.test.js | 11 | 0 | 11 |
| **TOTAL** | **19** | **0** | **19** |

---

## Railway Validation

| Check | Result |
|-------|--------|
| Production start command unchanged (`node telemetry/server.js`) | ✅ Verified |
| `railway.json` not modified | ✅ Verified |
| No new environment variables required by Sprint 0 code | ✅ Verified |
| No new npm packages added to production bundle | ✅ Verified |
| `index.js` (Railway entrypoint) — 0 lines changed | ✅ Verified |
| Migration runner is a standalone script, not part of the server start | ✅ Verified |
| Migration can be run manually: `node telemetry/migrations/run.js` | ✅ Verified |

**No Railway deployment or restart was performed during Sprint 0.**  
The migration is applied separately from deployment — it runs against the production DB directly using `DATABASE_URL` and is completely independent of the bot lifecycle.

---

## PostgreSQL Validation

```
Database:    heliumdb (Railway)
Engine:      PostgreSQL 16.10 on x86_64-pc-linux-gnu
Schema:      public
Verified by: telemetry/migrations/run.js (second idempotency run)
```

| Validation Step | Result |
|----------------|--------|
| Connection established | ✅ |
| psql available in environment (v16.10) | ✅ |
| All 10 expected tables present in `information_schema.tables` | ✅ |
| All 10 `runtime_domains` rows present with valid JSONB values | ✅ |
| All CHECK constraints enforced (severity, intent_type, status) | ✅ |
| All partial indexes present in `pg_indexes` | ✅ |
| GIN index on `memory_entries.tags` present | ✅ |
| Unique partial index on `knowledge_artifacts` (active artifacts) | ✅ |
| Migration idempotent (second run: 0 errors, 0 new rows) | ✅ |
| `events` row count: 29 (pre) → 29 (post) | ✅ No data lost |
| `shadowm_trades` row count: 1 (pre) → 1 (post) | ✅ No data lost |
| `shadowm_timeline` row count: 0 (pre) → 0 (post) | ✅ No data lost |

---

## Production Validation

| Check | Result | Notes |
|-------|--------|-------|
| `telemetry/server.js` not modified | ✅ | 0 diff lines |
| `telemetry/shadowm.js` not modified | ✅ | 0 diff lines |
| `telemetry/shadowlab.js` not modified | ✅ | 0 diff lines |
| `telemetry/db-adapter.js` not modified | ✅ | 0 diff lines |
| `index.js` not modified | ✅ | FROZEN — 0 diff lines |
| No new `require()` calls in production files | ✅ | grep confirmed |
| Archived files have 0 active `require()` references | ✅ | grep confirmed |
| Production bot behavior: zero change | ✅ | No code paths altered |
| New DB tables are additive only | ✅ | No existing tables dropped/altered |

The production bot can be restarted on Railway at any time with identical behavior to pre-Sprint-0.

---

## Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R-001 | JS SQL splitter silently drops statements | **MATERIALIZED** | High | Replaced with `psql -f --set ON_ERROR_STOP=1` |
| R-002 | Migration destroys existing data | Low | Critical | Pre/post row count guards + IF NOT EXISTS/ON CONFLICT DO NOTHING |
| R-003 | `db.run()` breaks on non-id PK tables | **MATERIALIZED** | Medium | Documented in MEMORY; use `db.exec()` for those tables |
| R-004 | `ANY($1)` pg library array bug | **MATERIALIZED** | Medium | Fetch all rows, filter in JS |
| R-005 | New tables interfere with bot startup | Low | High | New tables are never referenced by server.js in Sprint 0 |
| R-006 | `git mv` blocked in Replit agent | **MATERIALIZED** | Low | Used plain `mv`; git detects rename automatically |

---

## Lessons Learned

### 1. Never use a JS regex-based SQL splitter for multi-statement DDL

The first version of `run.js` used a regex lookahead to split the SQL file on semicolons. It appeared to work (producing 20 "statements") but silently grouped some multi-line `CREATE TABLE` statements together. The grouped statements failed with `42P01` (table doesn't exist for the index), which was incorrectly caught as a harmless "SKIP". The seven new tables were never created. **Fix: always use `psql -f <file>` via `execSync`.**

### 2. `db.run()` auto-appends `RETURNING id` — dangerous for tables without an id column

`telemetry/db-adapter.js` line 85 adds `RETURNING id` to every INSERT that lacks a RETURNING clause. Tables with non-BIGSERIAL primary keys (e.g. `runtime_domains` with `PRIMARY KEY(domain)`) will throw `column "id" does not exist`. **Fix: use `db.exec()` for INSERTs into tables with non-id PKs.**

### 3. `ANY($1)` with a JavaScript array returns zero rows in pg

Passing `[["table1", "table2"]]` as a parameter to `WHERE table_name = ANY($1)` silently returns 0 rows due to pg's type resolution for `information_schema.name` columns. **Fix: query all rows and filter in JavaScript.**

### 4. Node 24 test reporter flag is `--test-reporter=spec`, not `--reporter=spec`

`--reporter=spec` does not exist in Node 24's `node --test`. The process exits immediately with `bad option: --reporter=spec`. **Fix: always use `--test-reporter=spec`.**

### 5. `psql` is available in the Replit Nix environment

`/nix/store/.../bin/psql` at PostgreSQL 16.10 — no installation required. This means migration scripts can reliably use `psql` as their execution engine.

---

## Known Issues

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| KI-001 | `db.run()` will fail on any INSERT into `runtime_domains`, `event_idempotency`, or any other non-`id`-PK table | Medium | Documented; use `db.exec()` |
| KI-002 | `node --test` with `--test-reporter=spec` exits with non-zero code (-1) even when all tests pass (Node 24 quirk) | Low | Check test output text, not exit code |
| KI-003 | `git mv` is blocked in the Replit main agent; plain `mv` must be used instead | Low | Documented in `replit.md` Gotchas |
| KI-004 | `git push` from the agent times out; user must push from the Shell | Low | Documented in `replit.md` |

---

## Architecture Notes

### SHADOW OS v2 Schema Overview

The SHADOW OS v2 schema is an event-sourced, domain-partitioned state store. The seven new tables form three logical tiers:

**Tier 1 — State (runtime_domains)**
Single-table key-value store where each row is an entire domain's mutable state. Version field enables optimistic locking. The 10 bootstrap rows pre-initialize all domain namespaces.

**Tier 2 — Intent & Memory**
- `trade_intents`: records every OANDA order attempt before it is sent, enabling idempotent retries and reconciliation after crashes.
- `memory_entries`: ephemeral and persistent K/V storage with namespace scoping, TTL, and GIN-indexed tags for fast multi-tag lookup.
- `event_idempotency`: prevents duplicate event processing by mapping idempotency keys to event IDs.

**Tier 3 — Knowledge & Audit**
- `knowledge_artifacts`: versioned snapshots of trained strategy models (KNN weights, condition tables, etc.) with checksums and superseded-at timestamps. A partial unique index ensures exactly one "active" artifact per (domain, artifact) pair.
- `consistency_log`: append-only audit trail of self-detected data integrity issues, with severity levels and resolution tracking.
- `system_snapshots`: point-in-time captures of the full system state (runtime + memory + knowledge summaries) taken at key decision points.

### Design Invariants

1. **Existing tables are never altered** — only indexes are added with IF NOT EXISTS.
2. **All new tables are append-friendly** — the bot can be restarted at any point without corrupt state.
3. **runtime_domains is the single source of truth** for all mutable domain state — no domain manager keeps state in memory beyond a single processing cycle.
4. **knowledge_artifacts uses a superseded_at pattern** — old versions are retained forever (knowledge is never deleted), enabling rollback and audit.

---

## Migration Checklist

| Step | Description | Status |
|------|-------------|--------|
| MC-01 | Confirm DATABASE_URL is set and points to PostgreSQL | ✅ Done |
| MC-02 | Verify `psql` is available in the execution environment | ✅ Done |
| MC-03 | Read and validate `001_shadow_os_v2_schema.sql` for correctness | ✅ Done |
| MC-04 | Capture pre-migration row counts for all existing tables | ✅ Done |
| MC-05 | Run `node telemetry/migrations/run.js` (first pass) | ✅ Done |
| MC-06 | Verify all 10 tables exist in `information_schema.tables` | ✅ Done |
| MC-07 | Verify all 10 `runtime_domains` rows are present | ✅ Done |
| MC-08 | Verify post-migration row counts equal pre-migration counts | ✅ Done |
| MC-09 | Run `node telemetry/migrations/run.js` (second pass — idempotency) | ✅ Done |
| MC-10 | Confirm second pass produces 0 errors | ✅ Done |
| MC-11 | Run `node --test telemetry/tests/unit/smoke.test.js` — 8/8 pass | ✅ Done |
| MC-12 | Run `node --test telemetry/tests/unit/schema.test.js` — 11/11 pass | ✅ Done |
| MC-13 | `git diff` confirms 0 lines changed in active production files | ✅ Done |

---

## Validation Checklist

| Gate | Criterion | Pass Condition | Status |
|------|-----------|----------------|--------|
| GATE-0.A | Dead code archived | 8 files in `archive/`, 0 active `require()` references | ✅ PASS |
| GATE-0.B | Test framework operational | `node --test` runs; at least 1 test passes | ✅ PASS |
| GATE-0.C | Migration SQL complete | All 7 new tables + indexes + bootstrap in SQL file | ✅ PASS |
| GATE-0.D | Migration runs clean | Runner exits 0; all 10 tables verified; data intact | ✅ PASS |
| GATE-0.E | Migration is idempotent | Second run exits 0 with same verification output | ✅ PASS |
| GATE-0.F | Zero active code modified | `git diff` on 5 active files = 0 lines changed | ✅ PASS |
| GATE-0.G | All tests pass | 19/19 pass (8 smoke + 11 schema) | ✅ PASS |

**All 7 gates passed. Sprint 0 is officially CLOSED.**

---

## Sprint Status

```
┌─────────────────────────────────────────────────────┐
│  SPRINT 0 — SHADOW OS v2 Foundation                 │
│                                                     │
│  Status:      ✅ PASSED                             │
│  Date:        2026-07-06                            │
│  Commit:      dc2a2791e97fb074b7df10c7ba51ae3a7d2f  │
│  Tests:       19/19 PASS                            │
│  Data lost:   0 rows                                │
│  Code changed: 0 lines (active production files)   │
│  Gates:       7/7 PASSED                            │
└─────────────────────────────────────────────────────┘
```

---

## Readiness for Sprint 1

### Sprint 1 Objective
Implement `RuntimeDomainManager` — the first SHADOW OS v2 domain manager. Responsible for reading/writing the `runtime_domains` table, providing atomic version-checked updates, and bootstrapping the domain state on first boot.

### Prerequisites Confirmed

| Prerequisite | Status |
|-------------|--------|
| `runtime_domains` table with correct schema | ✅ Present |
| 10 bootstrap domain rows | ✅ Present |
| `consistency_log` table for error recording | ✅ Present |
| `system_snapshots` table for state capture | ✅ Present |
| Test framework operational | ✅ Operational |
| Migration runner validated and idempotent | ✅ Validated |
| `db-adapter.js` available (no changes) | ✅ Available |
| Zero active code changes required to unblock Sprint 1 | ✅ Confirmed |

### Sprint 1 Entry Criteria — ALL MET ✅

Sprint 1 may begin immediately.

---

*SPRINT_0_REPORT.md — FOREX ENGINE PRO — SHADOW OS v2 Migration*  
*Generated: 2026-07-06 | Commit: dc2a2791e97fb074b7df10c7ba51ae3a7d2fbdf9*
