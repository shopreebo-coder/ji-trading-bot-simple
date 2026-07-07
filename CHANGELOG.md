# CHANGELOG — SHADOW OS v2 Migration

All notable changes to the SHADOW OS v2 migration program. The production
entrypoint (`index.js`) and its start chain are FROZEN — every entry below is
additive.

---

## Sprint 3 — Memory Foundation (2026-07-07)

### Added
- **Migration 004** (`telemetry/migrations/004_memory_foundation.sql`):
  `memory_events` (permanent append-first event memory) and
  `memory_event_history` (append-only full-row audit snapshots).
  `memory_entries` untouched — retained as KV/TTL working cache. 14 tables total.
- **MemoryManager** (`telemetry/managers/MemoryManager.js`): full 13-method
  Sprint 3 spec — createMemory, appendMemory, updateMemory, archiveMemory,
  restoreMemory, searchMemory, queryByDomain/Trade/Time/Strategy, tagMemory,
  summarizeMemory, validateMemory — plus KV cache surface
  (kvSet/kvGet/kvGetAll/kvGc) and getMemory/getMemoryHistory/getStats/ping.
- **Test suites** (101 new tests, all passing):
  `telemetry/tests/unit/MemoryManager.test.js` (60),
  `telemetry/tests/integration/mm_integration.test.js` (11),
  `telemetry/tests/integration/mm_rdm_tim_integration.test.js` (7),
  `telemetry/tests/simulation/mm_persistence.test.js` (9),
  `telemetry/tests/stress/mm_stress.test.js` (14).
- `telemetry/managers/index.js` barrel now exports MemoryManager.

### Changed
- **RuntimeDomainManager.takeSnapshot(reason, { memorySummary })** — additive,
  backwards-compatible: stores a provided `summarizeMemory()` result in
  `system_snapshots.memory_summary` (placeholder when absent).
- `telemetry/migrations/run.js` — migration 004 added; EXPECTED_TABLES now 14.
- `docs/architecture/MASTER_ARCHITECTURE.md` §6.2 rewritten to the as-built
  two-table memory design; status tables updated.

### Fixed
- **CAS pool deadlock in `createMemory()` dedupe path** (found by STRESS-2,
  invisible to sequential tests): the duplicate lookup acquired a second pool
  connection while still holding one. Fixed by reusing the held client.

### Verification
- 396/396 tests passing across Sprints 0–3. Zero regressions.
- Sacred Constraint: 0 rows deleted (29 events, 1 shadowm_trade preserved);
  no DELETE path for `memory_events`/`memory_event_history` in any MM method.

---

## Sprint 2 — Intent Foundation (2026-07-07)

### Added
- **Migration 003** (`telemetry/migrations/003_trade_intent_v2.sql`): 17 new
  `trade_intents` columns, lifecycle CHECK constraints, 5 indexes, and the
  append-only `trade_intent_history` table.
- **TradeIntentManager** (`telemetry/managers/TradeIntentManager.js`): full
  intent lifecycle CREATED→VALIDATED→APPROVED→EXECUTED→ARCHIVED (plus
  REJECTED/CANCELLED), SELECT FOR UPDATE atomicity, idempotent createIntent,
  best-effort RDM integration.
- **Test suites** (169 new tests, all passing): unit (89), integration (22),
  TIM×RDM integration (10), simulation (27), stress (21).
- `telemetry/managers/index.js` barrel created (RDM + TIM).

### Verification
- 295/295 tests passing across Sprints 0–2 at completion. Zero regressions.

---

## Sprint 1 — Runtime Awakening (2026-07-06)

### Added
- **Migration 002**: `runtime_domain_history` table.
- **RuntimeDomainManager** (`telemetry/managers/RuntimeDomainManager.js`):
  exclusive owner of `runtime_domains` — CRUD, compareAndSwap, snapshots,
  restore/rollback, history, consistency logging and checks.
- **Test suites** (107 tests): unit (65), integration (16), simulation (14),
  stress (12).

---

## Sprint 0 — Foundation (2026-07-05)

### Added
- **Migration 001**: 10-table SHADOW OS v2 schema (idempotent DDL).
- Migration runner (`telemetry/migrations/run.js`) using `psql -f`.
- Test framework on `node:test` (Node 24, `--test-reporter=spec`).
- Schema + smoke test suites (19 tests).

### Changed
- Dead code moved to `archive/` with preserved git history.
