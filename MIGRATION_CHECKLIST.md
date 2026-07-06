# MIGRATION CHECKLIST — SHADOW OS v2
## FOREX ENGINE PRO · Step-by-Step Execution Guide

**Classification:** Engineering Execution Checklist  
**Parent document:** IMPLEMENTATION_BLUEPRINT.md  
**Date:** 2026-06-30  

---

> **How to use this document:**  
> Execute steps in order. Each `[ ]` is a physical action with a defined completion signal.  
> Do not advance to the next phase until ALL gate criteria for the current phase are checked.  
> If a step cannot be completed, consult RISK_REGISTER.md before proceeding.

---

## Pre-Migration Prerequisites

```
[ ] PREREQUISITE-01: Current production system (v40.1) has been running stably for ≥30 days
[ ] PREREQUISITE-02: DATABASE_URL is set and PostgreSQL is accessible
[ ] PREREQUISITE-03: You can run `node telemetry/server.js` locally without errors
[ ] PREREQUISITE-04: You have read SHADOW_OS_V2.md (especially Sections 3–8 and Appendices A and B)
[ ] PREREQUISITE-05: You have read IMPLEMENTATION_BLUEPRINT.md completely
[ ] PREREQUISITE-06: Railway CLI or Dashboard is accessible for log monitoring
[ ] PREREQUISITE-07: Git repository is clean (no uncommitted changes)
[ ] PREREQUISITE-08: You can push to the git remote and Railway deploys automatically
[ ] PREREQUISITE-09: OANDA_BASE_URL will be added to Railway env vars before Sprint 2 ends
[ ] PREREQUISITE-10: You have a method for running SQL against production PostgreSQL
         (psql CLI, Railway dashboard query, or pg_admin)
```

---

## PHASE 0 — Schema Foundation

**Target:** Deploy all new tables to production. Zero behavior change.

### Step 0.1 — Archive Dead Code

```
[ ] 0.1.1  Create directory: mkdir archive
[ ] 0.1.2  Move file: git mv dashboard.js archive/
[ ] 0.1.3  Move file: git mv index_backup_v39_2.js archive/
[ ] 0.1.4  Move file: git mv index_backup_v39_3_before_v39_4.js archive/
[ ] 0.1.5  Move file: git mv index_backup_v39_4_before_v39_4b.js archive/
[ ] 0.1.6  Move file: git mv index_railway_mtf_v39_optimized.js archive/
[ ] 0.1.7  Move file: git mv index_original_safe.js archive/
[ ] 0.1.8  Move file: git mv telemetry/server_backup_pre_snowball_lab.js archive/
[ ] 0.1.9  Move file: git mv telemetry/shadowlab_backup_pre_v40.js archive/
[ ] 0.1.10 Verify no active file requires any archived file:
           grep -r "require.*dashboard\|require.*backup\|require.*original_safe\|require.*optimized" .
           EXPECTED: 0 results
[ ] 0.1.11 Commit: git commit -m "chore: archive dead code (pre-SHADOW-OS-v2)"
```

### Step 0.2 — Set Up Test Framework

```
[ ] 0.2.1  Create directory: mkdir -p telemetry/tests/unit telemetry/tests/integration
           mkdir -p telemetry/tests/stress telemetry/tests/mocks
[ ] 0.2.2  Create telemetry/tests/README.md with:
           - How to run: node --test telemetry/tests/**/*.test.js
           - Test naming conventions
           - Mock database setup instructions
[ ] 0.2.3  Verify node --test is available:
           node --test --version (Node 18+ required)
[ ] 0.2.4  Write a single smoke test: telemetry/tests/unit/smoke.test.js
           Content: assert.ok(true, 'test framework working')
[ ] 0.2.5  Run smoke test: node --test telemetry/tests/unit/smoke.test.js
           EXPECTED: 1 test passes
```

### Step 0.3 — Create Migration Script

```
[ ] 0.3.1  Create directory: mkdir -p telemetry/migrations
[ ] 0.3.2  Create file: telemetry/migrations/001_shadow_os_v2_schema.sql
           Copy COMPLETE DDL from SHADOW_OS_V2.md Appendix A
           Verify all 7 CREATE TABLE statements present:
             [ ] runtime_domains
             [ ] memory_entries
             [ ] knowledge_artifacts
             [ ] trade_intents
             [ ] event_idempotency
             [ ] consistency_log
             [ ] system_snapshots
           Verify all CREATE TABLE statements use IF NOT EXISTS
           Verify all bootstrap INSERTs use ON CONFLICT DO NOTHING
           Verify all 10 runtime_domains bootstrap rows present
[ ] 0.3.3  Create file: telemetry/migrations/run.js
           Requirements:
             - Reads DATABASE_URL from process.env
             - Reads + executes 001_shadow_os_v2_schema.sql
             - Logs each table created or "already exists"
             - Logs "MIGRATION COMPLETE" on success
             - Exits with code 1 on any error
             - Is safe to run multiple times (idempotent)
[ ] 0.3.4  Test migration first run (local DB):
           DATABASE_URL=<heliumdb-url> node telemetry/migrations/run.js
           EXPECTED: All 7 tables created, "MIGRATION COMPLETE"
[ ] 0.3.5  Test migration second run (idempotency):
           DATABASE_URL=<heliumdb-url> node telemetry/migrations/run.js
           EXPECTED: No errors, "MIGRATION COMPLETE" (tables already exist)
[ ] 0.3.6  Verify tables in DB:
           psql $DATABASE_URL -c "\dt"
           EXPECTED: 10 tables visible (3 original + 7 new)
[ ] 0.3.7  Verify bootstrap data:
           psql $DATABASE_URL -c "SELECT domain FROM runtime_domains ORDER BY domain;"
           EXPECTED: 10 rows (exitLab, live, meta, scheduler, shadowA, shadowB,
                              shadowC, shadowD, shadowM, telemetry)
```

### Step 0.4 — Deploy to Production

```
[ ] 0.4.1  Commit migration files:
           git add telemetry/migrations/
           git commit -m "feat(phase-0): SHADOW OS v2 schema migration"
[ ] 0.4.2  Push to remote: git push
[ ] 0.4.3  Monitor Railway deploy log: no build errors
[ ] 0.4.4  Monitor Railway runtime logs (first 2 minutes): no new errors
[ ] 0.4.5  Run migration against production:
           DATABASE_URL=<railway-db-url> node telemetry/migrations/run.js
           EXPECTED: "MIGRATION COMPLETE"
[ ] 0.4.6  Verify production DB has new tables:
           psql $RAILWAY_DATABASE_URL -c "\dt"
[ ] 0.4.7  Verify system behavior unchanged:
           - GET /api/live: returns same response as before
           - GET /api/stats: returns same response as before
           - Trading active if market hours (no disruption)
```

### PHASE 0 GATE — Must check ALL before proceeding to Phase 1

```
[ ] GATE-0.A: All 7 new tables present in production PostgreSQL
[ ] GATE-0.B: 10 runtime_domains bootstrap rows present
[ ] GATE-0.C: Migration script idempotent (tested twice with no errors)
[ ] GATE-0.D: Production system behavior unchanged post-deploy
[ ] GATE-0.E: No new errors in Railway logs for 1 hour post-deploy
[ ] GATE-0.F: Archive directory contains all dead code files
[ ] GATE-0.G: Test framework smoke test passing
```

**ROLLBACK PROCEDURE (if any gate fails):**
```sql
-- Run in production PostgreSQL:
DROP TABLE IF EXISTS system_snapshots;
DROP TABLE IF EXISTS consistency_log;
DROP TABLE IF EXISTS event_idempotency;
DROP TABLE IF EXISTS trade_intents;
DROP TABLE IF EXISTS knowledge_artifacts;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS runtime_domains;
```

---

## PHASE 1 — StateManager + Runtime Domains

**Target:** All live state mutations dual-write to runtime_domains. Event-replay remains primary.

### Step 1.1 — Build StateManager

```
[ ] 1.1.1  Create file: telemetry/managers/state-manager.js
           Implement all methods from IMPLEMENTATION_BLUEPRINT.md Section 3.2:
             [ ] loadDomain(domain) → Promise<DomainState | null>
             [ ] loadAll() → Promise<Record<string, DomainState>>
             [ ] saveDomain(domain, value, expectedVersion) → Promise<SaveResult>
             [ ] saveDomainRetry(domain, transform, maxRetries=3) → Promise<SaveResult>
             [ ] flush() → Promise<void>
             [ ] migrateIfNeeded() → Promise<migrations[]>
             [ ] getCached(domain) → DomainState | null (synchronous)
           Verify optimistic concurrency:
             UPDATE runtime_domains SET value=$v, version=version+1
             WHERE domain=$d AND version=$expected
             if rowCount === 0 → version conflict → retry
[ ] 1.1.2  Write unit tests: telemetry/tests/unit/state-manager.test.js
           Minimum 10 tests from IMPLEMENTATION_BLUEPRINT.md Section 11.3
[ ] 1.1.3  Run tests: node --test telemetry/tests/unit/state-manager.test.js
           EXPECTED: ≥10 tests, ALL PASSING
           STOP HERE if any test fails. Fix before proceeding.
```

### Step 1.2 — Instrument server.js

```
[ ] 1.2.1  Add at top of server.js:
           const { stateManager } = require('./managers/state-manager');
[ ] 1.2.2  In restoreLiveState(), after in-memory state is populated:
           - Add Phase 1 validation log (compare runtime_domains vs event-replay result)
           - Add fire-and-forget save to runtime_domains after restore
           See IMPLEMENTATION_BLUEPRINT.md Section 3.2 for exact code pattern
[ ] 1.2.3  Identify all 6 live state mutation points in handleBotLine() (lines ~135, ~144, ~152, ~161, ~168, ~189)
[ ] 1.2.4  Add saveDomainRetry fire-and-forget calls at each mutation point
           RULE: NEVER use await in handleBotLine() — it is synchronous/sync-context
           Pattern: stateManager.saveDomainRetry(...).catch(e => {})
[ ] 1.2.5  For pips/peak updates (lines ~135, ~144): batch with 100ms debounce
           (These fire every tick — debouncing prevents excessive DB writes)
[ ] 1.2.6  For trade open/close/dailyTrades (lines ~152, ~168, ~189): IMMEDIATE save (no debounce)
           These are CRITICAL state changes — must be committed immediately
```

### Step 1.3 — Instrument shadowm.js

```
[ ] 1.3.1  Add at top of shadowm.js:
           const { stateManager } = require('./managers/state-manager');
[ ] 1.3.2  In _onOpen() [line ~430]: add saveDomainRetry('shadowM', ...) at end
[ ] 1.3.3  In _onSnapshot() [line ~486]: add saveDomainRetry('shadowM', ...) at end
[ ] 1.3.4  In _onClose() [line ~515, ~553]: add saveDomainRetry('shadowM', ...) at end
[ ] 1.3.5  In _poll() at end of successful poll [line ~388 area]:
           add saveDomainRetry('shadowM', ...) if new events were processed
[ ] 1.3.6  Value to save: {lastId: this._lastId, active: mapToObj(this._active),
           knownSids: [...this._knownSids], pollCount: this._pollCount,
           lastPollTs: new Date().toISOString()}
```

### Step 1.4 — Instrument shadowlab.js

```
[ ] 1.4.1  Add at top of shadowlab.js:
           const { stateManager } = require('./managers/state-manager');
[ ] 1.4.2  In ShadowLab._init() [line ~690 area]: after init complete,
           save runtime_domains for shadowC, shadowD, shadowA, shadowB
[ ] 1.4.3  In ShadowLab._cycle() [line ~782 area]: after cycle complete,
           save updated shadowC/shadowD domain state (dataset size, weights version, accuracy)
[ ] 1.4.4  Verify getShadowMode() and shadowMode changes also save to shadowlab domain
```

### Step 1.5 — Deploy and Validate

```
[ ] 1.5.1  Run server.js locally: node telemetry/server.js
           Verify: no startup errors
           Verify: [STATE MANAGER] logs appear
[ ] 1.5.2  Commit:
           git add telemetry/managers/state-manager.js
           git add telemetry/tests/unit/state-manager.test.js
           git add telemetry/server.js telemetry/shadowm.js telemetry/shadowlab.js
           git commit -m "feat(phase-1): StateManager dual-write to runtime_domains"
[ ] 1.5.3  Push + deploy to Railway
[ ] 1.5.4  Monitor Railway logs for [STATE DRIFT]:
           Run: railway logs --tail | grep "STATE DRIFT"
           EXPECTED: 0 occurrences over 48h
[ ] 1.5.5  Verify runtime_domains.live.version incrementing:
           psql $DATABASE_URL -c "SELECT domain, version, updated_at FROM runtime_domains WHERE domain='live';"
           Check every few hours: version should increase after each trade event
[ ] 1.5.6  Verify runtime_domains.shadowM.lastId:
           psql $DATABASE_URL -c "SELECT value->>'lastId' FROM runtime_domains WHERE domain='shadowM';"
           Compare with: psql $DATABASE_URL -c "SELECT MAX(id) FROM events;"
           EXPECTED: runtime_domains.shadowM.lastId close to (within 10 of) MAX(events.id)
```

### PHASE 1 GATE

```
[ ] GATE-1.A: state-manager.test.js: ≥10 tests, ALL PASSING
[ ] GATE-1.B: [STATE DRIFT] log count = 0 over 48h production
[ ] GATE-1.C: runtime_domains.live.version increments on every trade open/close
[ ] GATE-1.D: runtime_domains.shadowM.lastId tracks shadowm._lastId correctly
[ ] GATE-1.E: runtime_domains rows visible in DB for all 3 modified domains
[ ] GATE-1.F: No new Railway errors attributable to Phase 1 changes
[ ] GATE-1.G: stateManager.flush() tested manually (call from REPL, verify DB write)
```

**ROLLBACK:** git revert phase-1 commits → deploy. runtime_domains rows harmless.

---

## PHASE 2 — IntentManager + Trade Safety

**Target:** trade_intents rows for every trade. OANDA reconciliation on startup.

### Step 2.1 — Build OANDA Read-Only Client

```
[ ] 2.1.1  Create file: telemetry/oanda-client.js
           Implement:
             getOpenTrades(baseUrl, token, accountId) → Promise<OandaPosition[]>
           Uses: axios.get(url, {headers: {Authorization: `Bearer ${token}`}})
           URL: ${baseUrl}/v3/accounts/${accountId}/openTrades
           Handles: 200 → return trades array; 401/403 → throw AuthError;
                    429 → throw RateLimitError; 500 → throw ServerError
           Returns: [{instrument, currentUnits, price, id, openTime}]
[ ] 2.1.2  Create mock: telemetry/tests/mocks/oanda-mock.js
           Exports: createMockOandaClient(positions) that returns a mock of oanda-client.js
```

### Step 2.2 — Build IntentManager

```
[ ] 2.2.1  Create file: telemetry/managers/intent-manager.js
           Implement all methods from IMPLEMENTATION_BLUEPRINT.md Section 4.2:
             [ ] writeIntent(signalId, type, symbol, side, payload)
             [ ] confirmIntent(signalId, oandaOrderId)
             [ ] failIntent(signalId, reason)
             [ ] getPendingIntents()
             [ ] reconcileWithOanda(baseUrl, token, accountId, liveOpenTrades)
             [ ] cleanupStale(maxAgeHours=0.083)
[ ] 2.2.2  reconcileWithOanda logic:
           1. Call oandaClient.getOpenTrades() → oandaPositions[]
           2. For each PENDING intent: check if oandaPositions contains that symbol
              - Found: confirmIntent(), add to liveOpenTrades if missing
              - Not found: failIntent('oanda_position_not_found')
           3. For each oandaPosition NOT in liveOpenTrades:
              - Create a 'ghost trade' entry, log WARNING
              - If RECONCILE_POLICY=AUTO: add to liveOpenTrades
              - If RECONCILE_POLICY=FLAG (default): log but do not modify
[ ] 2.2.3  Write unit tests: telemetry/tests/unit/intent-manager.test.js
           Minimum 8 tests from IMPLEMENTATION_BLUEPRINT.md Section 11.3 (IntentManager block)
[ ] 2.2.4  Run tests: node --test telemetry/tests/unit/intent-manager.test.js
           EXPECTED: ≥8 tests, ALL PASSING
```

### Step 2.3 — Integrate into server.js

```
[ ] 2.3.1  Add at top of server.js:
           const { intentManager } = require('./managers/intent-manager');
           const oandaClient = require('./oanda-client');
[ ] 2.3.2  Add emitter handlers (AFTER emitter initialization):
           emitter.on('trade_open', async (data) => {
             try {
               await intentManager.writeIntent(data.signalId, 'OPEN', data.symbol, data.side, data);
               await intentManager.confirmIntent(data.signalId, data.oandaOrderId || data.signalId);
             } catch (e) { console.warn('[INTENT] trade_open handler error:', e.message); }
           });
           emitter.on('trade_close', async (data) => {
             try {
               await intentManager.writeIntent(data.signalId, 'CLOSE', data.symbol, null, data);
               await intentManager.confirmIntent(data.signalId, data.signalId);
             } catch (e) { console.warn('[INTENT] trade_close handler error:', e.message); }
           });
[ ] 2.3.3  In restoreLiveState(), at the end:
           Add OANDA reconciliation (see IMPLEMENTATION_BLUEPRINT.md Section 4.2)
           Wrap in try/catch: if OANDA unreachable, log WARNING and continue
           Add intentManager.cleanupStale() before reconciliation
[ ] 2.3.4  Verify OANDA_BASE_URL is set in Railway environment:
           psql $DATABASE_URL -c "SELECT 1"  ← just a connectivity check
           Check Railway dashboard: OANDA_BASE_URL variable present
           If missing: add OANDA_BASE_URL to Railway env vars NOW
```

### Step 2.4 — Deploy and Validate

```
[ ] 2.4.1  Commit and push
[ ] 2.4.2  Deploy to Railway, monitor logs
[ ] 2.4.3  Verify trade_intents rows after next trade:
           psql $DATABASE_URL -c "SELECT * FROM trade_intents ORDER BY created_at DESC LIMIT 5;"
           EXPECTED: rows with status='CONFIRMED' (not 'PENDING' — should be confirmed immediately)
[ ] 2.4.4  Verify OANDA reconciliation runs on startup:
           Railway log should contain: [INTENT RECONCILE] or [INTENT] 0 PENDING intent(s)
[ ] 2.4.5  Simulate pending intent (optional, staging only):
           INSERT INTO trade_intents (signal_id, intent_type, symbol, side, payload, status)
           VALUES ('TEST-GHOST', 'OPEN', 'EUR_USD', 'buy', '{}', 'PENDING');
           Restart server → watch logs for reconciliation of TEST-GHOST
```

### PHASE 2 GATE

```
[ ] GATE-2.A: intent-manager.test.js: ≥8 tests, ALL PASSING
[ ] GATE-2.B: trade_intents rows created for every trade_open event (observed over 48h)
[ ] GATE-2.C: trade_intents rows CONFIRMED for every trade_close event
[ ] GATE-2.D: OANDA reconciliation runs at every startup (log visible)
[ ] GATE-2.E: cleanupStale() runs on startup (no stuck PENDING intents from prior sessions)
[ ] GATE-2.F: OANDA_BASE_URL set in Railway environment
[ ] GATE-2.G: No new Railway errors
```

**ROLLBACK:** git revert phase-2 commits → deploy. trade_intents rows harmless.

---

## PHASE 3 — Read Switchover

**Target:** Startup reads from runtime_domains. Event-replay is fallback only.

### Step 3.1 — Modify restoreLiveState()

```
[ ] 3.1.1  Open server.js, find restoreLiveState() (line ~37)
[ ] 3.1.2  Add at TOP of function (before all existing code):
           const today = new Date().toISOString().slice(0, 10);
           const rs = await stateManager.loadDomain('live');
           if (rs && rs.value.date === today && rs.version > 0) {
             live.dailyTrades = rs.value.dailyTrades;
             live.openTrades  = rs.value.openTrades || {};
             live.botStatus   = 'stopped';  // will be set to 'running' when bot spawns
             console.log(`[SERVER] State loaded from runtime_domains v${rs.version}: `
               + `dailyTrades=${live.dailyTrades} openTrades=${Object.keys(live.openTrades).length}`);
             return;  // ← EXIT: skip event-replay
           }
           console.log(`[SERVER FALLBACK] runtime_domains missing/stale (date=${rs?.value?.date ?? 'none'}) — event replay`);
[ ] 3.1.3  PRESERVE all existing event-replay code below the new block (DO NOT DELETE)
[ ] 3.1.4  At end of event-replay path: add save to runtime_domains so next restart is fast
           (runtime_domains row now current → no replay needed next time)
```

### Step 3.2 — Modify shadowM._restore()

```
[ ] 3.2.1  Open shadowm.js, find _restore() method (line ~281)
[ ] 3.2.2  Add at TOP of method:
           const rs = await stateManager.loadDomain('shadowM');
           if (rs && rs.version > 0) {
             this._active    = new Map(Object.entries(rs.value.active || {}));
             this._knownSids = new Set(rs.value.knownSids || []);
             this._lastId    = typeof rs.value.lastId === 'number' ? rs.value.lastId : 0;
             console.log(`[SHADOW M] State from runtime_domains: active=${this._active.size} lastId=${this._lastId}`);
             return;
           }
[ ] 3.2.3  PRESERVE existing shadowm_trades scan fallback
```

### Step 3.3 — Deploy and Measure

```
[ ] 3.3.1  Commit and push
[ ] 3.3.2  Deploy to Railway
[ ] 3.3.3  Trigger a Railway restart (via dashboard or deploy)
[ ] 3.3.4  Check startup logs:
           EXPECTED: "[SERVER] State loaded from runtime_domains"
           MUST NOT SEE: "[SERVER FALLBACK]" (unless it's midnight UTC test)
[ ] 3.3.5  Measure startup time:
           Find in Railway logs: timestamp of process start
           Find in Railway logs: timestamp of "State loaded from runtime_domains"
           Calculate difference. Record here: _______ ms
           REPEAT 5 times, record all:
             Measurement 1: _____ ms
             Measurement 2: _____ ms
             Measurement 3: _____ ms
             Measurement 4: _____ ms
             Measurement 5: _____ ms
           ALL must be ≤200ms (excluding OANDA reconciliation time)
[ ] 3.3.6  Verify live.openTrades correct after restart:
           GET /api/live → compare openTrades with OANDA actual positions
[ ] 3.3.7  Test midnight crossover (optional if near midnight UTC):
           Temporarily set an old date in runtime_domains.live → restart → verify fallback triggers
```

### PHASE 3 GATE

```
[ ] GATE-3.A: Startup log: "State loaded from runtime_domains" on all 5 test restarts
[ ] GATE-3.B: [SERVER FALLBACK] log: 0 appearances during normal restarts
[ ] GATE-3.C: Startup time: all 5 measurements ≤200ms (record actual times above)
[ ] GATE-3.D: live.openTrades correct after restart (matches OANDA)
[ ] GATE-3.E: shadowM._restore() uses runtime_domains (log confirms it)
[ ] GATE-3.F: Event-replay fallback code PRESERVED in codebase (do not delete)
[ ] GATE-3.G: 48h clean production operation post-switchover
```

**ROLLBACK:** git revert phase-3 commits → deploy. Event-replay resumes. runtime_domains untouched.

---

## PHASE 4 — MemoryManager

**Target:** Cooldowns and market state persist to memory_entries with TTL.

### Step 4.1 — Build MemoryManager

```
[ ] 4.1.1  Create file: telemetry/managers/memory-manager.js
           Implement all methods from IMPLEMENTATION_BLUEPRINT.md Section 6.2
           UPSERT pattern: INSERT INTO memory_entries ... ON CONFLICT (namespace, key) DO UPDATE
           Logical TTL: in get(), check expires_at IS NULL OR expires_at > NOW()
[ ] 4.1.2  Write unit tests: telemetry/tests/unit/memory-manager.test.js
           Minimum 10 tests from IMPLEMENTATION_BLUEPRINT.md Section 11.4
[ ] 4.1.3  Run tests: node --test telemetry/tests/unit/memory-manager.test.js
           EXPECTED: ≥10 tests, ALL PASSING
```

### Step 4.2 — Integrate Cooldowns

```
[ ] 4.2.1  Add at top of server.js:
           const { memoryManager } = require('./managers/memory-manager');
[ ] 4.2.2  Find cooldown signal detection in handleBotLine() or server.js event handling
           (Cooldowns may appear as stdout lines or as specific event types)
[ ] 4.2.3  When a cooldown is detected, add:
           memoryManager.set('cooldowns', `cd:${symbol}`, {
             symbol, reason, triggeredAt: new Date().toISOString()
           }, { ttlMs: COOLDOWN_TTL_MS }).catch(e => {});
[ ] 4.2.4  In startup (after RecoveryManager or restoreLiveState):
           const activeCooldowns = await memoryManager.getAll('cooldowns');
           console.log(`[MEMORY] Loaded ${Object.keys(activeCooldowns).length} active cooldowns`);
[ ] 4.2.5  Schedule GC: memoryManager.scheduleGC(3600000);
[ ] 4.2.6  Run startup GC: await memoryManager.gc()
```

### Step 4.3 — Add Memory Stats Endpoint

```
[ ] 4.3.1  Add to server.js:
           app.get('/api/system/memory', async (req, res) => {
             const stats = await memoryManager.stats();
             res.json(stats);
           });
[ ] 4.3.2  Verify endpoint returns correct response
```

### Step 4.4 — Deploy and Validate

```
[ ] 4.4.1  Commit and push, deploy
[ ] 4.4.2  After first trade with cooldown: verify memory_entries row created
           psql $DATABASE_URL -c "SELECT namespace, key, expires_at FROM memory_entries ORDER BY created_at DESC LIMIT 10;"
[ ] 4.4.3  After 1 hour: verify GC ran (Railway log: [MEMORY GC])
[ ] 4.4.4  After 1 week: verify memory_entries count bounded
           psql $DATABASE_URL -c "SELECT COUNT(*) FROM memory_entries;"
           EXPECTED: < 1000 rows
```

### PHASE 4 GATE

```
[ ] GATE-4.A: memory-manager.test.js: ≥10 tests, ALL PASSING
[ ] GATE-4.B: memory_entries rows present for cooldowns in production
[ ] GATE-4.C: GC running hourly (Railway logs show [MEMORY GC])
[ ] GATE-4.D: memory_entries count stable (< 1000 rows after 1 week)
[ ] GATE-4.E: GET /api/system/memory returns correct stats
[ ] GATE-4.F: Expired entries return null from get() (test with short TTL entry)
```

---

## PHASE 5 — KnowledgeManager + Learning Pipeline

**Target:** Engine C/D load from knowledge_artifacts at startup. No shadowm_trades scan.

### ⚠️ CRITICAL: Read this entire phase before beginning any implementation.

```
KNOWLEDGE PROTECTION CHECKLIST (verify before any code change):
[ ] PRE-5.A: knowledge_artifacts table has NO existing rows (expected on first Phase 5 run)
[ ] PRE-5.B: IF knowledge_artifacts already has rows (re-run scenario):
             SELECT COUNT(*), domain, artifact FROM knowledge_artifacts
             GROUP BY domain, artifact ORDER BY domain, artifact;
             If rows exist: do NOT run one-time migration. Load existing artifacts.
[ ] PRE-5.C: The one-time migration function has a "migration guard":
             If knowledge_artifacts already has rows for engineC/dataset, SKIP migration
             Never overwrite existing knowledge artifacts with a fresh rebuild
```

### Step 5.1 — Build KnowledgeManager

```
[ ] 5.1.1  Create file: telemetry/managers/knowledge-manager.js
           Implement all methods from IMPLEMENTATION_BLUEPRINT.md Section 7.2
           SHA-256 checksum with deterministic JSON serialization (sorted keys)
           In-memory cache (_cache Map) for getCached() synchronous access
           Supersession pattern: UPDATE SET superseded_at + INSERT new version in transaction
[ ] 5.1.2  Write unit tests: telemetry/tests/unit/knowledge-manager.test.js
           Minimum 15 tests from IMPLEMENTATION_BLUEPRINT.md Section 11.5
[ ] 5.1.3  Run tests: node --test telemetry/tests/unit/knowledge-manager.test.js
           EXPECTED: ≥15 tests, ALL PASSING
           STOP if any test fails. Fix before continuing.
[ ] 5.1.4  Write scale test: telemetry/tests/stress/knowledge-at-scale.test.js
           Setup: insert knowledge_artifact with 10,000 example dataset
           Measure: load() time must be ≤100ms
[ ] 5.1.5  Run scale test: verify ≤100ms
```

### Step 5.2 — Integrate Engine C (KNN Dataset)

```
[ ] 5.2.1  Open telemetry/shadowlab.js, find ShadowKNNEngine class (line ~204)
[ ] 5.2.2  Add at top of shadowlab.js:
           const { knowledgeManager } = require('./managers/knowledge-manager');
[ ] 5.2.3  In ShadowKNNEngine constructor or _init phase:
           Add load call: await knowledgeManager.load('engineC', 'dataset')
           If artifact found: this._dataset = artifact.value.examples (skip DB scan)
           If artifact null: run one-time migration (see Step 5.2.4)
[ ] 5.2.4  Write one-time migration function:
           async function _migrateEngineC() {
             // Guard: skip if artifact already exists
             const existing = await knowledgeManager.load('engineC', 'dataset');
             if (existing) { console.log('[KNOWLEDGE] engineC/dataset already migrated'); return; }
             // Migrate from shadowm_trades
             const rows = await db.all('SELECT * FROM shadowm_trades WHERE exit_time IS NOT NULL');
             const examples = rows.map(r => buildFeatureVector(r));
             await knowledgeManager.save('engineC', 'dataset',
               {examples, migratedAt: new Date().toISOString()},
               {trainingEvents: rows.length, notes: 'One-time migration from shadowm_trades'});
             console.log(`[KNOWLEDGE] Migrated ${rows.length} trades to engineC/dataset`);
           }
[ ] 5.2.5  In _refreshDatasetAsync() (line ~257 area):
           After rebuilding dataset in memory: call incremental knowledge save
           if (this._newExamplesCount % 10 === 0 && this._newExamplesCount > 0):
             await knowledgeManager.save('engineC', 'dataset', {examples: this._dataset})
           Reset _newExamplesCount counter
[ ] 5.2.6  Verify: add log line when shadowm_trades is NOT scanned at startup
           console.log('[ENGINE C] Dataset loaded from Knowledge Layer (no shadowm_trades scan)')
```

### Step 5.3 — Integrate Engine D (Meta Weights)

```
[ ] 5.3.1  Find ShadowMetaEngine class (line ~434)
[ ] 5.3.2  In ShadowMetaEngine init:
           const artifact = await knowledgeManager.load('engineD', 'weights');
           if (artifact) {
             this._cond = artifact.value.conditions;
             console.log(`[ENGINE D] Weights loaded from Knowledge Layer v${artifact.version}`);
           } else {
             // One-time migration (similar to Engine C migration above)
           }
[ ] 5.3.3  After every 100 closed trades:
           Compute EMA update of weights
           await knowledgeManager.save('engineD', 'weights',
             {conditions: this._cond, learnRate: 0.2},
             {trainingEvents: totalClosed, confidence: this._confidence})
[ ] 5.3.4  Verify getCached('engineD', 'weights') returns weights synchronously
           (critical — shadowGate calls Engine D synchronously)
```

### Step 5.4 — Integrate Exit Lab

```
[ ] 5.4.1  Find ExitLab / ComparisonEngine strategy stats logic
[ ] 5.4.2  In Exit Lab init:
           const artifact = await knowledgeManager.load('exitLab', 'strategies');
           if (artifact) { this._strategyStats = artifact.value.strategies; }
[ ] 5.4.3  After every 20 closed trades:
           await knowledgeManager.save('exitLab', 'strategies', {strategies: this._strategyStats})
```

### Step 5.5 — Deploy and Validate

```
[ ] 5.5.1  Run locally: node telemetry/server.js
           WATCH FOR: "[ENGINE C] Dataset loaded from Knowledge Layer" in logs
           WATCH FOR: "[ENGINE D] Weights loaded from Knowledge Layer" in logs
           WATCH FOR: "[KNOWLEDGE] Migrated N trades to engineC/dataset" (only on first run)
           MUST NOT SEE: any shadowm_trades scan message at startup
[ ] 5.5.2  Commit and push, deploy to Railway
[ ] 5.5.3  Verify knowledge_artifacts rows in DB:
           psql $DATABASE_URL -c "SELECT domain, artifact, version, confidence, training_events
                                   FROM knowledge_artifacts WHERE superseded_at IS NULL ORDER BY domain, artifact;"
           EXPECTED: rows for engineC/dataset, engineD/weights, exitLab/strategies
[ ] 5.5.4  Measure startup time (5 consecutive Railway restarts):
           ALL must be ≤150ms (non-OANDA phases only)
           Record:
             Measurement 1: _____ ms
             Measurement 2: _____ ms
             Measurement 3: _____ ms
             Measurement 4: _____ ms
             Measurement 5: _____ ms
[ ] 5.5.5  Verify incremental update: close a trade, verify knowledge_artifacts version increments:
           psql $DATABASE_URL -c "SELECT version, training_events, created_at
                                   FROM knowledge_artifacts WHERE domain='engineC'
                                   ORDER BY version DESC LIMIT 3;"
           EXPECTED: version count grows after trades close
[ ] 5.5.6  Verify checksum protection:
           Run: UPDATE knowledge_artifacts SET checksum='invalid'
                WHERE domain='engineC' AND superseded_at IS NULL;
           Restart server
           EXPECTED: log shows CORRUPTION detected, rollback attempted
           Restore: fix the checksum or restore prior version
[ ] 5.5.7  Monitor 48h: verify no learning regression (Engine C/D gate behavior unchanged)
```

### PHASE 5 GATE

```
[ ] GATE-5.A: knowledge-manager.test.js: ≥15 tests, ALL PASSING
[ ] GATE-5.B: knowledge_artifacts: engineC/dataset, engineD/weights, exitLab/strategies present
[ ] GATE-5.C: Startup log: "loaded from Knowledge Layer" for all 3 engines (no shadowm_trades scan)
[ ] GATE-5.D: Startup time: all 5 measurements ≤150ms (record above)
[ ] GATE-5.E: 10,000-example scale test: load() ≤100ms
[ ] GATE-5.F: Checksum mismatch test: rollback triggered correctly
[ ] GATE-5.G: knowledge_artifacts version count growing as trades close
[ ] GATE-5.H: getCached() returns synchronous artifact (shadowGate unaffected — no latency change)
[ ] GATE-5.I: Engine C/D behavior unchanged (win rate not regressed vs prior 7 days)
[ ] GATE-5.J: 48h production: no learning degradation detected
```

**CRITICAL ROLLBACK NOTE:**  
Rolling back Phase 5 does NOT delete knowledge_artifacts rows.  
Knowledge is preserved. Engine C/D revert to full shadowm_trades rebuild.  
On re-deployment: artifacts loaded immediately. No re-migration needed.

---

## PHASE 6 — RecoveryManager + ValidationManager

**Target:** Formal 9-phase startup. Automated 12-check validation. System status tracking.

### Step 6.1 — Build RecoveryManager

```
[ ] 6.1.1  Create file: telemetry/managers/recovery-manager.js
           Implement 9-phase run() method per SHADOW_OS_V2.md Section 8
           Implement runPhase(phase) for individual phase execution
           Implement getSystemStatus() and setSystemStatus()
[ ] 6.1.2  Phase 1 implementation: call stateManager.migrateIfNeeded()
[ ] 6.1.3  Phase 2 implementation: call stateManager.loadAll() → cache all domains
[ ] 6.1.4  Phase 3 implementation: call memoryManager.getAll() for cooldowns, market_state
[ ] 6.1.5  Phase 4 implementation: knowledgeManager.load() for all 3 artifacts; verify checksums
           On checksum fail: attempt rollback; if all fail: proceed with safe defaults (WARN, not HALT)
[ ] 6.1.6  Phase 5 implementation: intentManager.getPendingIntents()
           If DB unavailable: HALT (cannot trade without intent tracking)
[ ] 6.1.7  Phase 6 implementation: oandaClient.getOpenTrades(); intentManager.reconcileWithOanda()
           If OANDA unavailable: DEGRADED (no new trades until OANDA reachable)
[ ] 6.1.8  Phase 7 implementation: call engine verify methods (shadowM._restore, shadowLab._init)
           Verify loaded state matches engine expectations
[ ] 6.1.9  Phase 8 implementation: validationManager.runChecks()
           CRITICAL issues → HALT
           ERROR issues → DEGRADED
           WARN → HEALTHY with alerts
[ ] 6.1.10 Phase 9 implementation: set meta.status; emit logEvent(system_startup)
```

### Step 6.2 — Build ValidationManager

```
[ ] 6.2.1  Create file: telemetry/managers/validation-manager.js
           Implement runChecks() calling all 12 individual check methods
           Implement scheduleChecks(intervalMs) for periodic execution
           Write all 12 checks per SHADOW_OS_V2.md Section 9.1
[ ] 6.2.2  Implement auto-repair for these 5 checks:
           - shadowm_cursor_lag: force _poll() cycle
           - intent_stuck: reconcile + mark FAILED
           - daily_counter_drift: recount from events, update live.dailyTrades
           - engine_c_version_mismatch: reload from knowledgeManager
           - engine_d_version_mismatch: reload from knowledgeManager
[ ] 6.2.3  Write unit tests: telemetry/tests/unit/recovery-manager.test.js (≥12 tests)
[ ] 6.2.4  Write unit tests: telemetry/tests/unit/validation-manager.test.js (≥12 tests)
[ ] 6.2.5  Run tests: ALL MUST PASS before proceeding
```

### Step 6.3 — Replace Startup Sequence in server.js

```
[ ] 6.3.1  Add at top of server.js:
           const { recoveryManager } = require('./managers/recovery-manager');
           const { validationManager } = require('./managers/validation-manager');
[ ] 6.3.2  Replace the startup sequence (currently: restoreLiveState() + shadowM.start() + etc.):
           const recoveryReport = await recoveryManager.run({
             baseUrl:   process.env.OANDA_BASE_URL,
             token:     process.env.OANDA_API_KEY,
             accountId: process.env.OANDA_ACCOUNT_ID
           });
           console.log(`[RECOVERY] Status: ${recoveryReport.status} in ${recoveryReport.totalMs}ms`);
           if (recoveryReport.status === 'HALTED') {
             console.error('[RECOVERY] HALTED:', recoveryReport.blockers.join('; '));
             // Do NOT spawn bot — start HTTP server for diagnostics only
           } else {
             if (recoveryReport.status === 'DEGRADED') {
               console.warn('[RECOVERY] DEGRADED:', recoveryReport.warnings.join('; '));
             }
             startBot();  // Only spawn if HEALTHY or DEGRADED (configurable)
           }
[ ] 6.3.3  Add SIGTERM handler:
           process.on('SIGTERM', async () => {
             console.log('[SERVER] SIGTERM — graceful shutdown');
             await stateManager.flush();
             await stateManager.saveDomainRetry('meta', m => ({...m, lastCleanShutdown: new Date().toISOString()}));
             bot?.kill('SIGTERM');
             server.close(() => process.exit(0));
           });
[ ] 6.3.4  Add ValidationManager scheduling after startup:
           validationManager.scheduleChecks(300000);  // every 5 minutes
[ ] 6.3.5  Add enhanced system status endpoint:
           app.get('/api/system/status', (req, res) => {
             res.json({
               status: recoveryManager.getSystemStatus(),
               lastReport: recoveryManager.getLastReport(),
               bootCount: stateManager.getCached('meta')?.value?.bootCount ?? 0
             });
           });
```

### Step 6.4 — Deploy and Validate

```
[ ] 6.4.1  Run locally before deploy:
           node telemetry/server.js
           EXPECTED: RecoveryManager Phase 1–9 logs visible
           EXPECTED: "System HEALTHY" or "System DEGRADED" (depending on OANDA key)
[ ] 6.4.2  Commit and push, deploy to Railway
[ ] 6.4.3  Measure recovery time:
           From Railway logs: find time from process start to Phase 9 READY
           EXPECTED: ≤700ms total
[ ] 6.4.4  Verify ValidationManager running:
           After 5 minutes: psql $DATABASE_URL -c "SELECT * FROM consistency_log ORDER BY detected_at DESC LIMIT 5;"
           EXPECTED: rows with check_id values, severity levels
[ ] 6.4.5  Simulate DEGRADED mode (test):
           Temporarily set OANDA_API_KEY=invalid in Railway → restart
           EXPECTED: [RECOVERY] Status: DEGRADED
           EXPECTED: Bot NOT spawned
           EXPECTED: GET /api/system/status returns {status: 'DEGRADED'}
           Restore: fix OANDA_API_KEY → restart → verify HEALTHY
[ ] 6.4.6  Verify SIGTERM handler:
           In Railway Dashboard: Deploy (triggers SIGTERM)
           EXPECTED: Railway logs show "[SERVER] SIGTERM — graceful shutdown"
           EXPECTED: New process starts and reaches HEALTHY status
```

### PHASE 6 GATE

```
[ ] GATE-6.A: recovery-manager.test.js: ≥12 tests, ALL PASSING
[ ] GATE-6.B: validation-manager.test.js: ≥12 tests, ALL PASSING
[ ] GATE-6.C: RecoveryManager replaces ad-hoc startup (no restoreLiveState() call remains)
[ ] GATE-6.D: Recovery time: ≤700ms (measured in Railway logs)
[ ] GATE-6.E: System status HEALTHY on clean Railway restart
[ ] GATE-6.F: DEGRADED mode correctly triggered (OANDA unavailable test)
[ ] GATE-6.G: Bot NOT spawned when system is DEGRADED
[ ] GATE-6.H: consistency_log receiving entries every 5 minutes (12 checks per run)
[ ] GATE-6.I: SIGTERM handler: graceful shutdown verified in production
[ ] GATE-6.J: GET /api/system/status returns full recovery report
```

---

## PHASE 7 — SnapshotManager + Plugin Architecture

**Target:** Periodic forensic snapshots. EnginePlugin interface registered.

### Step 7.1 — Build SnapshotManager

```
[ ] 7.1.1  Create file: telemetry/managers/snapshot-manager.js
[ ] 7.1.2  Implement takeSnapshot(trigger) — saves to system_snapshots table
[ ] 7.1.3  Add to RecoveryManager Phase 9: snapshotManager.takeSnapshot('POST_RECOVERY')
[ ] 7.1.4  Add to SIGTERM handler: await snapshotManager.takeSnapshot('PRE_SHUTDOWN')
[ ] 7.1.5  Schedule: snapshotManager.scheduleSnapshots(300000) in server.js startup
[ ] 7.1.6  Add endpoint: POST /api/system/snapshot → triggers manual snapshot
[ ] 7.1.7  Verify system_snapshots rows after Railway restart
```

### Step 7.2 — Build EnginePlugin Interface

```
[ ] 7.2.1  Create file: telemetry/managers/engine-registry.js
[ ] 7.2.2  Create file: telemetry/engines/shadow-m-engine.js
           Implements EnginePlugin: name, ownedDomains, ownedArtifacts, memoryNamespaces,
           onRecovery(), onDegraded(), onShutdown(), healthCheck()
[ ] 7.2.3  Create file: telemetry/engines/shadow-lab-engine.js (same structure)
[ ] 7.2.4  Register both engines in server.js startup:
           engineRegistry.register(new ShadowMEngine(shadowM, stateManager));
           engineRegistry.register(new ShadowLabEngine(shadowLab, stateManager, knowledgeManager));
[ ] 7.2.5  Update RecoveryManager Phase 7 to use engineRegistry.runRecovery()
```

### Step 7.3 — System API Endpoints

```
[ ] 7.3.1  Add to server.js:
           GET /api/system/domains   → stateManager.loadAll() (domain summaries)
           GET /api/system/knowledge → knowledgeManager.load() for all artifacts (summaries)
           GET /api/system/memory    → memoryManager.stats()
           GET /api/system/validation → validationManager.getRecentIssues()
           POST /api/system/validate  → validationManager.runChecks() (immediate trigger)
[ ] 7.3.2  Update railway.json to add healthcheck:
           "healthcheckPath": "/api/system/status"
[ ] 7.3.3  Verify all 7 system endpoints return correct data
```

### PHASE 7 GATE

```
[ ] GATE-7.A: system_snapshots table receiving rows (POST_RECOVERY + every 5 min)
[ ] GATE-7.B: PRE_SHUTDOWN snapshot created on Railway restart (SIGTERM)
[ ] GATE-7.C: Both engines registered in EngineRegistry
[ ] GATE-7.D: All 7 system API endpoints returning correct data
[ ] GATE-7.E: railway.json healthcheck path set
```

---

## PHASE 8 — Production Hardening + Cleanup

**Target:** Dead code removed. Cleanup jobs running. System certified for long-term operation.

### Step 8.1 — Remove Dead Code

```
[ ] 8.1.1  Confirm archive/ contains all backup files (see Step 0.1)
[ ] 8.1.2  Remove from server.js:
           - restoreLiveState() function (now dead — RecoveryManager handles startup)
             VERIFY: grep for any caller of restoreLiveState() → must be 0 callers
           - shadowm_cursor event writes (cursor now in runtime_domains)
           - [STATE DRIFT] validation logging (served its purpose in Phase 1)
[ ] 8.1.3  Remove from shadowm.js:
           - Event-based cursor write (shadowm_cursor events)
           - DB-scan fallback in _restore() (runtime_domains is always populated now)
[ ] 8.1.4  Verify: after removal, node telemetry/server.js starts correctly
[ ] 8.1.5  Run full test suite: node --test telemetry/tests/**/*.test.js
           EXPECTED: ALL tests still passing
```

### Step 8.2 — Add Cleanup Jobs

```
[ ] 8.2.1  Add daily cleanup job in server.js:
           setInterval(async () => {
             await knowledgeManager.prune(90);
             const d = await intentManager.cleanupStale(24);
             console.log(`[CLEANUP] Knowledge pruned. ${d} stale intents removed.`);
           }, 86400000); // 24 hours

[ ] 8.2.2  Add hourly memory GC in server.js (if not already added in Phase 4):
           setInterval(async () => {
             const r = await memoryManager.gc();
             if (r.deleted > 0) console.log(`[MEMORY GC] Deleted ${r.deleted} expired entries`);
           }, 3600000); // 1 hour

[ ] 8.2.3  Verify cleanup jobs running (Railway logs after 1 hour: [MEMORY GC])
[ ] 8.2.4  Verify after 24h: [CLEANUP] log visible
```

### Step 8.3 — Final Benchmarks

```
[ ] 8.3.1  Measure final startup times (5 consecutive Railway restarts):
           Phase 2 (Domains):    _____ ms (target ≤50ms)
           Phase 4 (Knowledge):  _____ ms (target ≤100ms)
           Phase 6 (OANDA):      _____ ms (target ≤500ms, including network)
           Phase 9 (READY):      _____ ms total (target ≤700ms)
[ ] 8.3.2  Verify: GET /api/system/status returns HEALTHY with all phase timings
[ ] 8.3.3  Final knowledge check:
           psql $DATABASE_URL -c "SELECT domain, artifact, version, confidence
                                   FROM knowledge_artifacts WHERE superseded_at IS NULL;"
           EXPECTED: 3 rows (engineC/dataset, engineD/weights, exitLab/strategies)
           EXPECTED: version > 1 for each (demonstrates accumulation)
[ ] 8.3.4  Final consistency check:
           POST /api/system/validate
           GET  /api/system/validation
           EXPECTED: status = 'CLEAN' (0 unresolved issues)
```

### Step 8.4 — Write Operations Runbook

```
[ ] 8.4.1  Create OPERATIONS_RUNBOOK.md with sections:
           - Daily Monitoring (what to check)
           - How to trigger manual validation
           - How to interpret system status
           - How to force knowledge rollback (step-by-step SQL commands)
           - How to recover from DEGRADED mode
           - How to read consistency_log
           - How to archive events table (when > 500K rows)
           - Emergency contacts and escalation
[ ] 8.4.2  Update replit.md with SHADOW OS v2 architecture notes
```

### PHASE 8 GATE (FINAL PRODUCTION CERTIFICATION)

```
[ ] GATE-8.A: Dead code paths removed from server.js, shadowm.js
[ ] GATE-8.B: All backup files in /archive/ (not in active codebase)
[ ] GATE-8.C: Full test suite passing: all unit + integration tests
[ ] GATE-8.D: SIGTERM graceful shutdown: verified in production ≥2 times
[ ] GATE-8.E: Startup time ≤150ms (Phase 9 READY) for 5 consecutive cold starts
[ ] GATE-8.F: Recovery time ≤700ms (Phase 9 READY including OANDA)
[ ] GATE-8.G: 72h continuous production monitoring: 0 CRITICAL/ERROR in consistency_log
[ ] GATE-8.H: knowledge_artifacts.version growing (demonstrated over 72h)
[ ] GATE-8.I: POST /api/system/validate returns {status: 'CLEAN'}
[ ] GATE-8.J: Cleanup jobs running (knowledge prune, intent cleanup, memory GC)
[ ] GATE-8.K: OPERATIONS_RUNBOOK.md written and reviewed
[ ] GATE-8.L: replit.md updated
[ ] GATE-8.M: GET /api/system/knowledge returns all 3 artifacts with confidence > 0

┌─────────────────────────────────────────────────────────────────────┐
│              SHADOW OS v2 PRODUCTION CERTIFIED                      │
│                                                                     │
│  Sign-off: _______________________  Date: _______________           │
│                                                                     │
│  All Phase 8 gate criteria checked. System operating correctly.     │
│  Knowledge preservation verified. Golden Rule honored.             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Emergency Procedures

### If system enters HALTED status unexpectedly:

```
1. GET /api/system/status → read blockers[]
2. Common blockers and fixes:
   - 'schema_error': run telemetry/migrations/run.js against production
   - 'domain_load_error': check DB connectivity; verify runtime_domains table exists
   - 'oanda_unreachable': verify OANDA_API_KEY in Railway env vars
   - 'knowledge_corruption': see Knowledge Rollback below
3. After fixing: Railway restart → verify HEALTHY
```

### Knowledge Rollback (emergency):

```sql
-- Step 1: Find the version to roll back to
SELECT id, version, confidence, training_events, created_at, notes
FROM knowledge_artifacts
WHERE domain='engineC' AND artifact='dataset'
ORDER BY version DESC LIMIT 5;

-- Step 2: Note the id of the TARGET version (the good one)

-- Step 3: Supersede the current active version
UPDATE knowledge_artifacts
SET superseded_at = NOW()
WHERE domain='engineC' AND artifact='dataset' AND superseded_at IS NULL;

-- Step 4: Reactivate the target version by inserting a copy
-- (do not modify the original row — insert a new row with the same value)
INSERT INTO knowledge_artifacts (domain, artifact, version, value, checksum,
  byte_size, training_events, confidence, migration_from, notes)
SELECT 'engineC', 'dataset',
  (SELECT MAX(version)+1 FROM knowledge_artifacts WHERE domain='engineC' AND artifact='dataset'),
  value, checksum, byte_size, training_events, confidence, id,
  'EMERGENCY ROLLBACK from v' || version || ' at ' || NOW()
FROM knowledge_artifacts WHERE id = <TARGET_ID>;

-- Step 5: Restart the server → RecoveryManager will load the restored version
```

### If knowledge_artifacts table is missing (catastrophic):

```
1. Run: DATABASE_URL=<url> node telemetry/migrations/run.js
   This recreates the table (idempotent).
2. The table will be empty → engines will use safe defaults.
3. System will run in DEGRADED mode until knowledge rebuilds from trading.
4. First 10 closed trades: engineC/dataset created automatically (incremental).
5. First 100 closed trades: engineD/weights created automatically.
6. System returns to HEALTHY after knowledge artifacts are created.
```
