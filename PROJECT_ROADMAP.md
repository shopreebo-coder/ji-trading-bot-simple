# PROJECT ROADMAP — SHADOW OS v2
## FOREX ENGINE PRO · Sprint Plan

**Classification:** Project Management Reference  
**Parent document:** IMPLEMENTATION_BLUEPRINT.md  
**Date:** 2026-06-30  
**Total estimated duration:** 32 working days (6.5 weeks)  

---

> **Golden Rule:** Every sprint produces a deployable system. No sprint may end  
> with knowledge in a worse state than it started. Roll-back must be possible  
> at every sprint boundary in ≤ 5 minutes.

---

## Milestone Overview

```
MILESTONE 1: SCHEMA FOUNDATION            End of Sprint 0  (Day 3)
MILESTONE 2: ARCH-B COMPLETE              End of Sprint 2  (Day 13)
MILESTONE 3: READ SWITCHOVER              End of Sprint 3  (Day 16)
MILESTONE 4: MEMORY LAYER LIVE           End of Sprint 4  (Day 21)
MILESTONE 5: KNOWLEDGE LAYER LIVE        End of Sprint 5  (Day 27)
MILESTONE 6: FULL RECOVERY SYSTEM        End of Sprint 6  (Day 32)
MILESTONE 7: PRODUCTION CERTIFIED         End of Sprint 7  (Day 37)
```

---

## Critical Path

```
Sprint 0 (schema) → Sprint 1 (StateManager) → Sprint 2 (IntentManager)
    → Sprint 3 (Read Switchover) → Sprint 5 (KnowledgeManager)
    → Sprint 6 (RecoveryManager)

Sprint 4 (MemoryManager) is parallel to Sprint 5 (can start after Sprint 3)
Sprint 7 (SnapshotManager + Plugin) is parallel to Sprint 6

LONGEST CHAIN: Sprint 0 → 1 → 2 → 3 → 5 → 6 → 7 = 32 days
```

---

## Sprint 0 — Foundation (Days 1–3)

### Objectives

1. Complete and document the codebase audit
2. Archive dead code
3. Set up the test harness
4. Deploy schema Phase 0 to production
5. Establish development workflow

### Deliverables

| Deliverable | File | Status |
|-------------|------|--------|
| Codebase audit report | IMPLEMENTATION_BLUEPRINT.md Section 0 | DONE |
| Dead code archived | /archive/ | Pending |
| Test framework configured | telemetry/tests/README.md | Pending |
| Migration script | telemetry/migrations/001_shadow_os_v2_schema.sql | Pending |
| Migration runner | telemetry/migrations/run.js | Pending |
| Schema deployed to production | Railway + heliumdb | Pending |

### Tasks

```
DAY 1:
  - Create /archive/ directory
  - Move dashboard.js, index_backup_*.js, index_railway_*.js, index_original_safe.js to /archive/
  - Move telemetry/server_backup_*.js, telemetry/shadowlab_backup_*.js to /archive/
  - Create telemetry/tests/ directory structure
  - Install test framework (node --test or Jest)
  - Write telemetry/tests/README.md (how to run tests)

DAY 2:
  - Write 001_shadow_os_v2_schema.sql (full DDL from SHADOW_OS_V2.md Appendix A)
  - Write telemetry/migrations/run.js (idempotent runner)
  - Test migration script against heliumdb: first run (creates tables)
  - Test migration script against heliumdb: second run (idempotency — no errors)
  - Verify all 7 tables exist + 10 runtime_domains bootstrap rows

DAY 3:
  - Deploy to Railway (git push)
  - Verify Railway logs: no new errors
  - Verify schema deployed: psql $DATABASE_URL -c "\dt"
  - Verify bootstrap: SELECT domain FROM runtime_domains (10 rows)
  - Write Sprint 0 completion notes (phase gate checklist in MIGRATION_CHECKLIST.md)
```

### Dependencies

- None (this is the first sprint)

### Exit Criteria

```
[ ] Archive directory contains all dead code files
[ ] telemetry/tests/ structure created
[ ] Migration script idempotent (tested twice)
[ ] All 7 new tables present in production PostgreSQL
[ ] 10 runtime_domains rows present
[ ] No Railway errors post-deploy
[ ] replit.md updated with Sprint 0 status
```

### Risk

- LOW. Purely additive. No production behavior changes.

---

## Sprint 1 — StateManager + Runtime Domains (Days 4–8)

### Objectives

1. Build and unit-test the StateManager module
2. Instrument all live state mutations in server.js to dual-write to runtime_domains
3. Instrument shadowm.js state to dual-write to runtime_domains
4. Instrument shadowlab.js state to dual-write to runtime_domains
5. Validate drift between event-replay and runtime_domains is zero over 48h production

### Deliverables

| Deliverable | File |
|-------------|------|
| StateManager module | telemetry/managers/state-manager.js |
| StateManager unit tests | telemetry/tests/unit/state-manager.test.js |
| Dual-write instrumentation | server.js, shadowm.js, shadowlab.js (changes) |
| Phase 1 validation log | Visible in Railway logs: `[STATE MANAGER]` |

### Tasks

```
DAY 4:
  - Create telemetry/managers/ directory
  - Write telemetry/managers/state-manager.js
    * loadDomain(), loadAll(), saveDomain(), saveDomainRetry(), flush()
    * getCached(), migrateIfNeeded()
    * In-memory cache (_cache Map)
    * Optimistic concurrency (UPDATE WHERE version=$n)
    * Error handling: catch all errors, log, return {ok: false}
  - Write telemetry/tests/unit/state-manager.test.js (≥10 tests)
  - Run all tests: must pass before proceeding

DAY 5:
  - Modify server.js: require StateManager, add dual-write in restoreLiveState()
  - Identify all 6 mutation points in handleBotLine() (pips, peak, openTrade, breakEven, dailyTrades, closeTrade)
  - Add fire-and-forget saves at each mutation point (never await in hot path)
  - Add Phase 1 validation log (compare runtime_domains vs event-replay result)

DAY 6:
  - Modify shadowm.js: require StateManager
  - Add saveDomainRetry('shadowM', ...) in _onOpen(), _onSnapshot(), _onClose(), _poll() end
  - Run locally: verify shadowM domain updating correctly

DAY 7:
  - Modify shadowlab.js: require StateManager
  - Add saveDomainRetry('shadowC', ...) after each Engine C cycle
  - Add saveDomainRetry('shadowD', ...) after each Engine D cycle
  - Add saveDomainRetry('shadowA/B', ...) after mode changes
  - Deploy to Railway

DAY 8:
  - Monitor production logs for 48h (or compress to 4h if trading is active)
  - Check: [STATE DRIFT] log count = 0
  - Verify: runtime_domains.live.version increments on every trade event
  - Verify: runtime_domains.shadowM.lastId tracks correctly
  - Complete Sprint 1 gate checklist
```

### Dependencies

- Sprint 0 complete (schema deployed)
- 10 runtime_domains bootstrap rows present

### Parallel Tasks

- None (StateManager is on the critical path)

### Exit Criteria

```
[ ] state-manager.test.js: ≥10 tests, all passing
[ ] [STATE DRIFT] count = 0 over 48h production monitoring
[ ] runtime_domains.live.version increments on every trade open/close
[ ] runtime_domains.shadowM.lastId matches shadowm._lastId after each poll
[ ] No new Railway errors attributable to Sprint 1
[ ] stateManager.flush() works correctly (tested manually)
```

### Risk

- MEDIUM. Changes to hot path (handleBotLine). Always fire-and-forget — never block.

---

## Sprint 2 — IntentManager + Trade Safety (Days 9–13)

### Objectives

1. Build and unit-test the IntentManager module
2. Build the minimal read-only OANDA client for reconciliation
3. Add trade_intents row for every trade_open and trade_close event
4. Add OANDA position reconciliation on startup

### Deliverables

| Deliverable | File |
|-------------|------|
| IntentManager module | telemetry/managers/intent-manager.js |
| OANDA read-only client | telemetry/oanda-client.js |
| IntentManager unit tests | telemetry/tests/unit/intent-manager.test.js |
| OANDA mock | telemetry/tests/mocks/oanda-mock.js |

### Tasks

```
DAY 9:
  - Write telemetry/oanda-client.js
    * getOpenTrades(baseUrl, token, accountId) → OandaPosition[]
    * Uses axios; handles 200, 401, 403, 429 (rate limit), 500
    * Read-only — zero POST/PUT calls
  - Write telemetry/tests/mocks/oanda-mock.js
    * Mock getOpenTrades returning configurable positions list
  - Write telemetry/managers/intent-manager.js
    * writeIntent(), confirmIntent(), failIntent(), getPendingIntents()
    * reconcileWithOanda(), cleanupStale()

DAY 10:
  - Write telemetry/tests/unit/intent-manager.test.js (≥8 tests)
  - Tests include: PENDING→CONFIRMED, PENDING→FAILED, reconciliation with mock OANDA
  - Run all tests: must pass before proceeding

DAY 11:
  - Modify server.js: require IntentManager
  - Add emitter.on('trade_open') handler: writeIntent + confirmIntent
  - Add emitter.on('trade_close') handler: writeIntent + confirmIntent
  - Add OANDA reconciliation to restoreLiveState() (after state load)

DAY 12:
  - Deploy to Railway
  - Verify: trade_intents rows created for every trade_open/close (check production DB)
  - Verify: reconciliation runs on startup (check Railway logs for [INTENT RECONCILE])

DAY 13:
  - Write integration test: telemetry/tests/integration/oanda-reconciliation.test.js
  - Simulate: PENDING intent + mock OANDA returning the position
  - Expected: intent marked CONFIRMED, live.openTrades updated
  - Complete Sprint 2 gate checklist
  - Add OANDA_BASE_URL to Railway env vars if not already set
```

### Dependencies

- Sprint 1 complete (StateManager running)

### Exit Criteria

```
[ ] intent-manager.test.js: ≥8 tests, all passing
[ ] trade_intents rows in production DB for every trade_open/close event
[ ] OANDA reconciliation runs at startup (log visible in Railway)
[ ] cleanupStale() runs at startup (no stuck PENDING intents from prior sessions)
[ ] Integration test: PENDING intent + mock OANDA → CONFIRMED
[ ] No new Railway errors
```

---

## Sprint 3 — Read Switchover (Days 14–16)

### Objectives

1. Switch startup reads from event-replay to runtime_domains as primary source
2. Achieve startup time ≤200ms (non-OANDA)
3. Validate correctness over 48h production

### Deliverables

| Deliverable | Notes |
|-------------|-------|
| Modified restoreLiveState() | Reads runtime_domains first, falls back to event-replay |
| Modified shadowM._restore() | Reads runtime_domains first |
| Modified shadowLab._init() | Reads runtime_domains first |
| Integration test | telemetry/tests/integration/phase-3-read-switchover.test.js |

### Tasks

```
DAY 14:
  - Modify restoreLiveState() in server.js:
    * if runtime_domains.live.date === today and version > 0: load from DB, return
    * else: event-replay fallback (existing code — preserved, not deleted)
  - Modify shadowM._restore():
    * if runtime_domains.shadowM.version > 0: load from DB, return
    * else: existing DB-scan fallback (preserved)

DAY 15:
  - Modify shadowLab._init():
    * if runtime_domains.shadowC.version > 0 AND runtime_domains.shadowD.version > 0:
      load _processedIds from shadowM data (not events), return
    * else: existing fallback
  - Write telemetry/tests/integration/phase-3-read-switchover.test.js
  - Test: clean state (no runtime_domains) → fallback path works
  - Test: populated runtime_domains → fast path used
  - Deploy to Railway

DAY 16:
  - Monitor startup logs: [SERVER] should show "State loaded from runtime_domains"
  - Monitor: [FALLBACK] should NOT appear (unless midnight crossover)
  - Measure startup time: 5 consecutive Railway restarts, record each
  - Target: all ≤200ms (without OANDA reconciliation)
  - Complete Sprint 3 gate checklist
```

### Dependencies

- Sprint 1 complete (dual-write running, runtime_domains populated)
- Sprint 2 complete (IntentManager + reconciliation)

### Exit Criteria

```
[ ] Startup log: "State loaded from runtime_domains" (not "falling back")
[ ] [FALLBACK] log: 0 appearances during normal restarts
[ ] Startup time: 5 consecutive measurements all ≤200ms (without OANDA)
[ ] After midnight UTC: dailyTrades resets correctly (fallback triggered by date check)
[ ] 48h of clean production operation post-switchover
[ ] Event-replay fallback code PRESERVED (not deleted — critical safety net)
```

---

## Sprint 4 — MemoryManager (Days 17–21)

### Objectives

1. Build and unit-test the MemoryManager module
2. Integrate cooldown storage in the Memory Layer
3. Establish GC scheduling
4. Add additional namespaces (market_state, observations) as capacity allows

### Deliverables

| Deliverable | File |
|-------------|------|
| MemoryManager module | telemetry/managers/memory-manager.js |
| MemoryManager unit tests | telemetry/tests/unit/memory-manager.test.js |
| Cooldown integration | server.js modifications |
| Memory stats endpoint | GET /api/system/memory |

### Tasks

```
DAY 17:
  - Write telemetry/managers/memory-manager.js
    * set(), get(), getAll(), getByTags(), delete(), touch(), expire()
    * gc(), scheduleGC(), stats()
    * ON CONFLICT (namespace, key) DO UPDATE pattern
    * Logical TTL: filter expires_at < NOW() at read time

DAY 18:
  - Write telemetry/tests/unit/memory-manager.test.js (≥10 tests)
  - Tests: TTL creation, expired entry returns null, GC deletes expired
  - Run all tests: must pass

DAY 19:
  - Modify server.js: integrate cooldown storage
  - Identify cooldown signal patterns in handleBotLine() stdout parsing
  - Add memoryManager.set('cooldowns', ...) when cooldown signals detected
  - Add GC scheduling in startup: memoryManager.scheduleGC(3600000)
  - Add startup GC run: await memoryManager.gc()

DAY 20:
  - Add GET /api/system/memory endpoint (stats view)
  - Add observations namespace: set observation when signal enters pipeline
  - Deploy to Railway

DAY 21:
  - Verify: memory_entries rows created for cooldowns during live trading
  - Verify: GC runs hourly (check Railway logs at T+1h, T+2h)
  - Verify: memory_entries count bounded (no unbounded growth)
  - Complete Sprint 4 gate checklist
```

### Dependencies

- Sprint 3 complete (startup using runtime_domains)

### Can Run Parallel With

- Sprint 5 preparation (knowledge-manager.js design)

### Exit Criteria

```
[ ] memory-manager.test.js: ≥10 tests, all passing
[ ] memory_entries table receiving cooldown rows during live trading
[ ] GC runs hourly without errors
[ ] memory_entries count ≤ 1000 after 1 week in production
[ ] get() returns null for expired entries (verified in production via test entry)
[ ] GET /api/system/memory returns correct stats
```

---

## Sprint 5 — KnowledgeManager + Learning Pipeline (Days 22–27)

### Objectives

1. Build and unit-test the KnowledgeManager module (highest-impact sprint)
2. Perform one-time migration of existing Engine C/D data to knowledge_artifacts
3. Switch Engine C and D to incremental updates (no more full rebuilds)
4. Achieve startup time ≤150ms at current trade count
5. Demonstrate startup time is O(1) — does NOT grow with historical trade count

### Deliverables

| Deliverable | File |
|-------------|------|
| KnowledgeManager module | telemetry/managers/knowledge-manager.js |
| KnowledgeManager unit tests | telemetry/tests/unit/knowledge-manager.test.js |
| Engine C integration | shadowlab.js — ShadowKNNEngine modifications |
| Engine D integration | shadowlab.js — ShadowMetaEngine modifications |
| Exit Lab integration | shadowlab.js — ComparisonEngine + ExitLab modifications |
| Integration tests | telemetry/tests/integration/phase-5-knowledge-migration.test.js |
| Scale tests | telemetry/tests/stress/knowledge-at-scale.test.js |

### Tasks

```
DAY 22:
  - Write telemetry/managers/knowledge-manager.js
    * load(), save(), loadHistory(), rollback(), migrate()
    * verifyAll(), confidence(), prune()
    * In-memory cache (_cache Map)
    * getCached() — synchronous (critical for shadowGate)
    * SHA-256 checksum with deterministic JSON serialization
    * Optimistic locking for supersession

DAY 23:
  - Write telemetry/tests/unit/knowledge-manager.test.js (≥15 tests)
  - Run all tests: must pass
  - Write telemetry/tests/stress/knowledge-at-scale.test.js
    * Setup: 10,000-example dataset in knowledge_artifacts
    * Measure load() time: ≤100ms target

DAY 24:
  - Modify shadowlab.js — ShadowKNNEngine:
    * On startup: knowledgeManager.load('engineC', 'dataset')
    * If null: run one-time migration (SELECT shadowm_trades → build → save)
    * After each 10 closed trades: incremental save
  - Write first-time migration logic (one-time, self-disabling)

DAY 25:
  - Modify shadowlab.js — ShadowMetaEngine:
    * On startup: knowledgeManager.load('engineD', 'weights')
    * If null: compute from shadowm_trades → save
    * Every 100 closed trades: EMA update + save
  - Modify shadowlab.js — ExitLab:
    * On startup: knowledgeManager.load('exitLab', 'strategies')
    * Every 20 closed trades: update + save
  - Deploy to Railway

DAY 26:
  - Verify: knowledge_artifacts rows created for engineC, engineD, exitLab
  - Verify: startup log shows "loaded from knowledge_artifacts" (not "rebuilding")
  - Measure: startup time 5× consecutive restarts
  - Verify: shadowm_trades NOT scanned at startup (add log to confirm)
  - Write telemetry/tests/integration/phase-5-knowledge-migration.test.js

DAY 27:
  - Run scale test: insert 10,000 example artifact, measure startup time
  - Verify: checksum protection working (manually corrupt checksum → verify rollback)
  - Monitor production: 48h, verify no learning regression
  - Complete Sprint 5 gate checklist
```

### Dependencies

- Sprint 3 complete (startup from runtime_domains)
- Sprint 0 complete (knowledge_artifacts table exists)

### This Is The Highest-Value Sprint

```
BEFORE Sprint 5 (at 2,000 closed trades):
  Startup time: ~8–12 seconds
  On restart: Engine C/D learn nothing from prior sessions

AFTER Sprint 5 (at any scale):
  Startup time: ≤150ms
  On restart: Engine C/D have full historical knowledge in ≤100ms
  At 100,000 trades (5 years): still ≤150ms startup
```

### Exit Criteria

```
[ ] knowledge-manager.test.js: ≥15 tests, all passing
[ ] knowledge_artifacts: engineC/dataset, engineD/weights, exitLab/strategies all present
[ ] Startup log: "loaded from knowledge_artifacts" for all three engines
[ ] shadowm_trades NOT scanned at startup (confirmed by log)
[ ] Startup time: 5 consecutive measurements all ≤150ms (without OANDA)
[ ] 10,000-example load time: ≤100ms (scale test)
[ ] Checksum mismatch → automatic rollback (integration test passing)
[ ] Engine C/D behavior unchanged post-migration (no win rate regression)
[ ] 48h production monitoring: no learning degradation detected
```

---

## Sprint 6 — RecoveryManager + ValidationManager (Days 28–32)

### Objectives

1. Build and test the RecoveryManager (9-phase startup)
2. Build and test the ValidationManager (12 consistency checks)
3. Replace ad-hoc startup sequence with RecoveryManager
4. Formally track system status: HEALTHY, DEGRADED, HALTED

### Deliverables

| Deliverable | File |
|-------------|------|
| RecoveryManager module | telemetry/managers/recovery-manager.js |
| ValidationManager module | telemetry/managers/validation-manager.js |
| RecoveryManager tests | telemetry/tests/unit/recovery-manager.test.js |
| ValidationManager tests | telemetry/tests/unit/validation-manager.test.js |
| Integration tests | telemetry/tests/integration/phase-6-recovery-sequence.test.js |
| System status endpoint | GET /api/system/status (enhanced) |

### Tasks

```
DAY 28:
  - Write telemetry/managers/recovery-manager.js
    * run(oandaCredentials) → RecoveryReport
    * runPhase(phase) → PhaseReport
    * getLastReport() → RecoveryReport | null
    * getSystemStatus() → 'HEALTHY' | 'DEGRADED' | 'HALTED'
    * setSystemStatus(status, reason)
    * Internal: 9 phase implementations

DAY 29:
  - Write telemetry/managers/validation-manager.js
    * runChecks(oandaCredentials) → ValidationReport
    * scheduleChecks(intervalMs)
    * getRecentIssues(severity, limit)
    * All 12 individual check methods
    * Auto-repair for: shadowm_cursor_lag, intent_stuck, daily_counter_drift,
                       engine_c_version_mismatch, engine_d_version_mismatch

DAY 30:
  - Write unit tests:
    * recovery-manager.test.js: ≥12 tests (one per phase)
    * validation-manager.test.js: ≥12 tests (one per check)
  - Run all tests: must pass

DAY 31:
  - Modify server.js: replace ad-hoc startup with RecoveryManager
    * Remove restoreLiveState() (its logic now in RecoveryManager.Phase2+Phase3+Phase6)
    * Call recoveryManager.run() → get status
    * if HALTED: start HTTP server only (no bot)
    * if DEGRADED: start HTTP server + log warning (no bot by default)
    * if HEALTHY: start HTTP server + start bot
  - Add SIGTERM handler with stateManager.flush() + snapshot
  - Add ValidationManager.scheduleChecks(300000) [every 5 minutes]
  - Deploy to Railway

DAY 32:
  - Verify: 9-phase recovery completes in ≤700ms (Railway log timestamps)
  - Verify: ValidationManager runs every 5 minutes (consistency_log entries)
  - Verify: GET /api/system/status returns status + phases + timing
  - Simulate DEGRADED: set OANDA_API_KEY to invalid → restart → verify DEGRADED status
  - Write integration test: phase-6-recovery-sequence.test.js
  - Complete Sprint 6 gate checklist — MILESTONE 6 ACHIEVED
```

### Dependencies

- Sprint 5 complete (KnowledgeManager running)
- Sprint 4 complete (MemoryManager running)

### Exit Criteria

```
[ ] recovery-manager.test.js: ≥12 tests, all passing
[ ] validation-manager.test.js: ≥12 tests, all passing
[ ] RecoveryManager replaces ad-hoc startup in server.js
[ ] 9-phase recovery: ≤700ms measured in Railway
[ ] System status: HEALTHY on clean restart
[ ] System status: DEGRADED when OANDA unavailable (bot not spawned)
[ ] ValidationManager: runs every 5 minutes (consistency_log rows growing)
[ ] SIGTERM handler: flush + snapshot + clean exit tested
[ ] GET /api/system/status: returns full recovery report + system status
[ ] All 12 auto-repairs tested (at least 3 triggers simulated in staging)
```

---

## Sprint 7 — SnapshotManager + Plugin Architecture + Production (Days 33–37)

### Objectives

1. Build the SnapshotManager (forensic snapshots)
2. Define and register the EnginePlugin interface
3. Add system management API endpoints
4. Archive dead code
5. Production validation and certification

### Deliverables

| Deliverable | File |
|-------------|------|
| SnapshotManager module | telemetry/managers/snapshot-manager.js |
| EngineRegistry module | telemetry/managers/engine-registry.js |
| Engine wrappers | telemetry/engines/shadow-m-engine.js, shadow-lab-engine.js |
| System API endpoints | server.js additions |
| Dead code archived | /archive/ (Phase 8 cleanup) |
| Production runbook | OPERATIONS_RUNBOOK.md |

### Tasks

```
DAY 33:
  - Write telemetry/managers/snapshot-manager.js
    * takeSnapshot(trigger), scheduleSnapshots(intervalMs)
    * getLatestSnapshot(), compareSnapshots(id1, id2)
  - Add snapshot triggers: POST_RECOVERY (in RecoveryManager), PRE_SHUTDOWN (SIGTERM handler)
  - Schedule: snapshotManager.scheduleSnapshots(300000)  [every 5 minutes]

DAY 34:
  - Write telemetry/managers/engine-registry.js
  - Write telemetry/engines/shadow-m-engine.js
  - Write telemetry/engines/shadow-lab-engine.js
  - Register both engines in server.js startup
  - Recovery Phase 7 now uses registry.runRecovery()

DAY 35:
  - Add system API endpoints to server.js:
    GET  /api/system/status
    GET  /api/system/domains
    GET  /api/system/knowledge
    GET  /api/system/memory
    GET  /api/system/validation
    POST /api/system/snapshot
    POST /api/system/validate
  - Add TTL cleanup jobs: knowledge prune (daily), intent cleanup (daily), memory GC (hourly)
  - Deploy to Railway

DAY 36:
  - Archive all remaining dead code (see Phase 8 in Blueprint)
  - Remove dead fallback paths from restoreLiveState (now fully dead)
  - Add railway.json healthcheck path
  - Run full test suite: pnpm test (or node --test)
  - Measure final startup time: 5 consecutive cold starts
  - Verify: GET /api/system/knowledge shows all 3 artifacts with confidence scores

DAY 37:
  - 72h production monitoring (continuous)
  - Check consistency_log: CLEAN for all checks
  - Check knowledge_artifacts: version count growing (new trades incrementing versions)
  - Verify: SIGTERM graceful shutdown on Railway (use Railway CLI to restart + observe logs)
  - Write OPERATIONS_RUNBOOK.md:
    * How to trigger manual validation
    * How to force knowledge rollback
    * How to interpret system status
    * How to monitor consistency_log
  - Update replit.md with SHADOW OS v2 architecture notes
  - MILESTONE 7: PRODUCTION CERTIFIED
```

### Exit Criteria

```
[ ] system_snapshots table receiving rows every 5 minutes
[ ] PRE_SHUTDOWN snapshot created on SIGTERM (verified via Railway restart)
[ ] EngineRegistry registered with both engines
[ ] All system API endpoints returning correct data
[ ] Dead code archived (not deleted)
[ ] Full test suite passing: all unit + integration tests
[ ] Startup time: ≤150ms for 5 consecutive cold starts (final benchmark)
[ ] 72h production: 0 CRITICAL or ERROR entries in consistency_log
[ ] knowledge_artifacts.version count growing (demonstrates accumulation)
[ ] GET /api/system/status returning HEALTHY with all phases PASS
[ ] OPERATIONS_RUNBOOK.md written
[ ] replit.md updated
```

---

## Master Sprint Timeline

```
WEEK 1 (Days 1–5):
  Mon (D1): Sprint 0 — Archive dead code, set up test framework
  Tue (D2): Sprint 0 — Write migration SQL + runner
  Wed (D3): Sprint 0 — Deploy schema; MILESTONE 1
  Thu (D4): Sprint 1 — Write StateManager module + tests
  Fri (D5): Sprint 1 — Instrument server.js dual-write

WEEK 2 (Days 6–10):
  Mon (D6): Sprint 1 — Instrument shadowm.js + shadowlab.js
  Tue (D7): Sprint 1 — Deploy + monitor
  Wed (D8): Sprint 1 — 48h validation; complete Sprint 1 gate
  Thu (D9): Sprint 2 — Write OANDA client + IntentManager
  Fri (D10): Sprint 2 — IntentManager tests

WEEK 3 (Days 11–15):
  Mon (D11): Sprint 2 — Integrate into server.js
  Tue (D12): Sprint 2 — Deploy + verify
  Wed (D13): Sprint 2 — Complete Sprint 2 gate; MILESTONE 2
  Thu (D14): Sprint 3 — Modify restoreLiveState, shadowM._restore
  Fri (D15): Sprint 3 — Modify shadowLab._init, deploy

WEEK 4 (Days 16–21):
  Mon (D16): Sprint 3 — Verify, measure startup time; MILESTONE 3
  Tue (D17): Sprint 4 — Write MemoryManager
  Wed (D18): Sprint 4 — MemoryManager tests
  Thu (D19): Sprint 4 — Integrate cooldowns in server.js
  Fri (D20): Sprint 4 — Deploy + verify
  Sat (D21): Sprint 4 — Complete gate; MILESTONE 4

WEEK 5 (Days 22–27):
  Mon (D22): Sprint 5 — Write KnowledgeManager (day 1)
  Tue (D23): Sprint 5 — KnowledgeManager tests + scale tests
  Wed (D24): Sprint 5 — Engine C integration (first-time migration)
  Thu (D25): Sprint 5 — Engine D + ExitLab integration; deploy
  Fri (D26): Sprint 5 — Verify; measure startup time
  Sat (D27): Sprint 5 — 48h monitor; MILESTONE 5

WEEK 6 (Days 28–32):
  Mon (D28): Sprint 6 — Write RecoveryManager
  Tue (D29): Sprint 6 — Write ValidationManager
  Wed (D30): Sprint 6 — Tests for both; must pass
  Thu (D31): Sprint 6 — Integrate into server.js; deploy
  Fri (D32): Sprint 6 — Verify, simulate DEGRADED; MILESTONE 6

WEEK 7 (Days 33–37):
  Mon (D33): Sprint 7 — SnapshotManager
  Tue (D34): Sprint 7 — EngineRegistry + engine wrappers
  Wed (D35): Sprint 7 — System API endpoints + cleanup jobs; deploy
  Thu (D36): Sprint 7 — Archive dead code; full test suite; final benchmark
  Fri (D37): Sprint 7 — 72h monitor start; runbook; MILESTONE 7
```

---

## Project Management Board

### Milestones

| Milestone | Sprint | Day | Status |
|-----------|--------|-----|--------|
| 1 — Schema Foundation | Sprint 0 | Day 3 | PENDING |
| 2 — ARCH-B Complete | Sprint 2 | Day 13 | PENDING |
| 3 — Read Switchover | Sprint 3 | Day 16 | PENDING |
| 4 — Memory Layer Live | Sprint 4 | Day 21 | PENDING |
| 5 — Knowledge Layer Live | Sprint 5 | Day 27 | PENDING |
| 6 — Full Recovery System | Sprint 6 | Day 32 | PENDING |
| 7 — Production Certified | Sprint 7 | Day 37 | PENDING |

### Blocked Tasks

```
Currently blocked: None

Future blocks (anticipated):
  Sprint 5 blocks: knowledgeManager.prune() requires careful testing before deployment
    → Do not deploy prune() to production until integration test passes
  Sprint 6 blocks: RecoveryManager Phase 6 requires OANDA_BASE_URL in Railway env vars
    → Must confirm env var is set before Day 31 deploy
  Sprint 7 blocks: Dead code archival requires confirming no file is depended upon
    → Run grep for each filename before archiving (grep -r "dashboard.js" . etc.)
```

### Parallel Tasks

```
Sprint 4 (MemoryManager) can start in parallel with Sprint 5 preparation
Sprint 7 SnapshotManager can be built in parallel with Sprint 6 testing
Knowledge-manager.js unit tests can be written while Engine C integration is pending
```

### Technical Debt (planned, not immediate)

```
TD-001: Event-replay fallback code remains in codebase until Phase 8
  Resolution: Remove in Sprint 7, Day 36 cleanup

TD-002: shadowm_cursor events still written to events table until Phase 8
  Resolution: Remove cursor write after runtime_domains is confirmed primary source

TD-003: 35+ analytics DB queries in server.js are direct db.all() calls
  Resolution: Not migrated. These are read-only analytics. Acceptable long-term.

TD-004: index.js writes intents retroactively (cannot write before OANDA call)
  Resolution: Cannot fix without modifying index.js (FROZEN).
  Acceptable: OANDA reconciliation on startup closes the gap.

TD-005: dashboard.js (481 lines) is dead code occupying the root directory
  Resolution: Archive in Sprint 0.

TD-006: MemoryManager cooldowns are observational only (do not restore bot's internal cooldowns)
  Resolution: Requires stdout protocol extension OR index.js modification.
  Deferred: Post-SHADOW OS v2. Track as future enhancement.
```

### Future Improvements (post-SHADOW OS v2)

```
FUTURE-001: Risk Engine plugin (requires 6+ months of knowledge data)
FUTURE-002: Portfolio Engine (requires Risk Engine + 1 year data)
FUTURE-003: Async knowledge saves (background queue for large artifacts)
FUTURE-004: Chunked artifact storage (for datasets > 10,000 examples)
FUTURE-005: Distributed execution (pg_advisory_lock + LISTEN/NOTIFY)
FUTURE-006: SHADOW OS v3 — Kubernetes, stream processing, ML inference layer
FUTURE-007: Full EnginePlugin compliance for index.js (requires unfreezing)
```

---

*This roadmap is derived from IMPLEMENTATION_BLUEPRINT.md and should be read alongside it.*  
*For risk details, see RISK_REGISTER.md.*  
*For step-by-step execution, see MIGRATION_CHECKLIST.md.*
