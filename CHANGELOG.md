# CHANGELOG — SHADOW OS v2 Migration

All notable changes to the SHADOW OS v2 migration program. The production
entrypoint (`index.js`) and its start chain are FROZEN — every entry below is
additive.

---

## Sprint 6 — Knowledge Manager Foundation (2026-07-12)

### Added
- **Knowledge schema** (`telemetry/migrations/006_knowledge_foundation.sql`):
  additive provenance + source-window columns (`run_id`, `build_id`,
  `config_hash`, `source_window_from/to`) on `knowledge_artifacts` (defined in
  `001`, 0 rows before this producer) via `ADD COLUMN IF NOT EXISTS`, plus a new
  append-first `knowledge_snapshots` manifest table keyed
  `dedupe_key = manifest_checksum`. Registered in `autoMigrate.js`. No
  `DROP`/`DELETE`/`TRUNCATE`.
- **Content-only checksum module** (`telemetry/managers/knowledgeProvenance.js`):
  `checksumValue` (SHA-256 over canonical, recursively key-sorted JSON of the
  artifact **content only** — provenance excluded), `canonicalJson`,
  `confidenceScore`/`confidenceLevel`, and `createProvenance().provenanceNote()`.
- **Immutable versioned store** (`telemetry/managers/KnowledgeRepository.js`):
  `upsertVersion` is a compare-and-set — unchanged content is a true no-op,
  changed content inserts a new version and supersedes the prior active row
  (`superseded_at` + `migration_from` chain) in one PG transaction;
  `insertSnapshot` records a dedupe-keyed manifest; plus `getActive`/`getVersion`/
  `getHistory`/`listActive`/`exportActive`/`statistics`/`listSnapshots`.
- **Knowledge builder** (`telemetry/managers/KnowledgeManager.js`): seven pure
  SQL aggregations over the `shadow_*` research tables → `expectancy/history`,
  `engines/statistics`, `patterns/validated`, `market/fingerprints`,
  `config/history`, `confidence/history`, `experiments/metadata`. `snapshotAll()`
  builds all seven, CAS-upserts each, then records the manifest. Lifecycle
  `start()` (unref'd 15-min poll) / `stop()`; construction is side-effect-free.
  Read APIs `getStatistics`/`getArtifact`/`listArtifacts`/`listSnapshots`/
  `exportAll`. Null-safe helpers honour the `Number(null) === 0` trap.
- **Five read-only endpoints** (`telemetry/server.js`): `/api/knowledge/status`,
  `/api/knowledge/artifacts`, `/api/knowledge/artifacts/:domain/:artifact`
  (`?version=` / `?history=1`), `/api/knowledge/snapshots`,
  `/api/knowledge/export` — always registered, each reports `knowledgeEnabled`.
- **Barrel export** (`telemetry/managers/index.js`): `KnowledgeManager`,
  `KnowledgeRepository`, `KNOWLEDGE_ARTIFACTS`.
- **Tests (27)**: `knowledgeProvenance` (7), `knowledgeMigration` (7),
  `knowledgeManager` (7), `knowledgeRecovery` (3), `knowledgeFeatureFlag` (3).

### Flag
- `KNOWLEDGE_LAYER` (default **off**): off = the builder never starts (complete
  no-op); on = the 15-min builder runs. Knowledge NEVER influences live/shadow/
  risk decisions — it reads only `shadow_*` research and writes only `knowledge_*`.

### Invariant (locked)
- **Artifact checksums are content-only.** Provenance lives in dedicated columns,
  never inside `value`. A restart (new `run_id`) rebuilding identical research
  mints **no** new version — knowledge accumulates, never churns. Proven by the
  recovery suite (different provenance → 0 changed, original provenance retained).

### Unchanged (constraints)
- `index.js` untouched (git diff empty). All DDL `IF NOT EXISTS`; CAS upsert +
  manifest dedupe are idempotent. Additive-only, reversible.

---

## Sprint 5 — Shadow LAB Foundation (2026-07-11)

### Added
- **Research schema** (`telemetry/migrations/005_shadowlab_foundation.sql`): four
  new tables — `shadow_signals`, `shadow_engine_evals`, `shadow_outcomes`,
  `shadow_expectancy_snapshots` — all `CREATE TABLE IF NOT EXISTS`, each carrying
  the provenance triple (`run_id`, `build_id`, `config_hash`) plus a `dedupe_key`
  and supporting indexes. Registered in `autoMigrate.js` so it auto-applies
  idempotently on startup. No `DROP`/`DELETE`/`TRUNCATE`.
- **Provenance module** (`telemetry/managers/shadowLabProvenance.js`):
  deterministic `configHash` (SHA-256 over canonical sorted-key JSON of the
  decision-relevant config surface + version), reproducible `resolveBuildId`
  (`<version>+<git-sha|unknown>`), per-process `runId`, `confidenceLevel` tiers
  (LOW <30, MEDIUM 30–100, HIGH >100), and `createProvenance().stamp()`.
- **Reconciler + expectancy** (`telemetry/managers/ShadowLabManager.js`): a
  cursor-based, idempotent, best-effort projector of the append-only `events`
  stream into the research tables (`trade_open → shadow_signals`,
  `lab_shadow_a/b/c/d → shadow_engine_evals`, `trade_close → shadow_outcomes`),
  plus `computeExpectancy`/`snapshotExpectancy`/`getExpectancy`/
  `getResearchSummary`/`getTimeseries`. Idempotent via `ON CONFLICT (dedupe_key)
  DO NOTHING`; resumable cursor persisted as an append-only `events` row.
- **Three read-only endpoints** (`telemetry/server.js`): `/api/lab/expectancy`,
  `/api/lab/research/summary`, `/api/lab/research/timeseries`, each reporting
  `researchEnabled`.
- **Verification suites** (23 new tests): `shadowLabProvenance.test.js` (9),
  `shadowLabManager.test.js` (7), `shadowLabExpectancy.test.js` (7). All green,
  plus the 4 Sprint 4.1 `autoMigrate` regression tests (27/27 total).

### Changed
- **`telemetry/managers/index.js`** barrel now exports the Shadow LAB research
  layer (`ShadowLabManager` + provenance helpers).
- **`telemetry/server.js`** gains the flag `SHADOW_LAB_RESEARCH` (default **off**);
  when off, the reconciler never starts and behaviour is unchanged. The three
  research endpoints are always registered and read-only.
- **`autoMigrate.test.js`** expected-tables set extended with the four new tables.

### Why
- Establishes a research-only measurement layer that reconciles the event stream
  into structured, fully-provenanced tables and computes trade expectancy —
  answering *"what is the system actually learning?"* — with **zero** changes to
  live trading. `index.js` (live Engine A/B/C/D decisions) is untouched (empty
  git diff); the whole layer is additive, append-first, idempotent, reversible,
  and gated behind a default-off flag.

---

## Sprint 4.1 — Production PostgreSQL Persistence (2026-07-11)

### Added
- **Startup auto-migration** (`telemetry/migrations/autoMigrate.js`):
  `ensureSchema(pool)` creates the full SHADOW OS v2 schema on boot,
  idempotently, with no `psql` dependency. Each migration file is executed as a
  single `pool.query(fileContents)` (pg simple protocol — parses multi-statement
  DDL including `DO $$ ... $$;` blocks, one implicit transaction per file). A
  `schema_migrations` table tracks applied files; a session advisory lock
  `(21320, 40911)` serializes concurrent migrators during redeploy overlap.
- **Verification suite** (`telemetry/tests/integration/autoMigrate.test.js`,
  4 tests): schema creation, idempotency (second run applies nothing), and
  data-safety (a sentinel row survives a simulated redeploy).

### Changed
- **LiveMemoryIntegration.init()** now runs `ensureSchema` after pool creation
  and before manager construction, gated on `_ownPool` (real startup runs it;
  tests injecting `_pool` skip it). Failure degrades to no-op — never blocks
  trading. `getStatus()` now includes the migration summary.
- **`/api/healthz/persistence`** now reports `persistence: true`, a `storage`
  descriptor, and the `memoryIntegration` status so PostgreSQL is confirmed
  active end-to-end.

### Why
- Railway production had no PostgreSQL service and no `DATABASE_URL`, so every
  deploy wiped all accumulated trading knowledge. After the operator attaches a
  Railway PostgreSQL service and redeploys, the schema is auto-created and all
  trading history, memory, snapshots and recovery data persist across deploys.
  No filesystem/volume solution was used; SQLite remains dev-only fallback.

---

## Sprint 4 — Live Memory Integration (2026-07-11)

### Added
- **LiveMemoryIntegration** (`telemetry/managers/LiveMemoryIntegration.js`):
  wires the Sprint 1–3 manager tier (RDM + TIM + MM) into the running Live
  Engine. Startup recovery pipeline: memory validation (quarantine, never
  delete) → latest VALID snapshot with checksum walk-back (skips corrupt
  snapshots, never deletes them) → domain/intent/memory recovery report →
  drift detection vs the replay-built live state (observe-only, logged to
  `consistency_log`) → dedupe-keyed SYSTEM_RECOVERY event → post_recovery
  snapshot.
- **Duplicate-startup protection**: pg session-scoped advisory lock on a
  dedicated client. A second process degrades to observe-only mode; SIGKILL
  frees the lock automatically (verified by cross-process tests).
- **Trade lifecycle hooks**: `recordTradeOpen` / `recordTradeClose` /
  `recordBotRestart` — all idempotent via `dedupe_key`, all best-effort
  (memory failure can NEVER block trading).
- **Periodic persistence** (`SHADOW_OS_PERSIST_MS`, default 5 min) and
  **bounded graceful shutdown**: flush in-flight writes (allSettled +
  timeout) → SYSTEM_SHUTDOWN event → final snapshot → lock release.
- **server.js integration** (first modification ever — additive, flag-gated
  by `SHADOW_OS_MEMORY`, default ON; `off` = zero behavior change including
  no signal handlers): startup hook after `restoreLiveState()`, trade
  open/close stdout-branch hooks, bot-restart-loop hook, SIGTERM/SIGINT
  graceful shutdown with a hard 5s exit deadline (Railway redeploys can
  never hang), `GET /api/memory-integration/status` monitoring endpoint.
- **Test suites** (21 new tests, all passing): integration (18 — recovery
  lifecycle, snapshot validation/tamper/walk-back, quarantine, drift,
  idempotency, 2 000-event large history, shutdown flush, redeploy
  simulation) and cross-process stress (3 — two-OS-process duplicate
  startup, concurrent recovery race, SIGKILL power loss) plus 3 drivers in
  `telemetry/tests/drivers/`.

### Changed
- `telemetry/server.js` — first and only production-brain modification of
  the migration; every hook is flag-gated and try/catch-wrapped.
  `index.js` remains FROZEN, untouched.
- `telemetry/managers/index.js` — barrel now exports LiveMemoryIntegration
  (+ LOCK_CLASS/LOCK_OBJ/OPEN_INTENT_STATUSES/SNAPSHOT_WALKBACK_LIMIT).

### Verification
- 417/417 tests passing (396 baseline + 21 new). Zero regressions.
- Sacred Constraint: corrupt snapshots and memories are quarantined/skipped,
  never deleted; recovery is strictly read-then-append.

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
