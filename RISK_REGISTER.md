# RISK REGISTER — SHADOW OS v2
## FOREX ENGINE PRO · Complete Risk Catalog

**Classification:** Risk Management Reference  
**Parent document:** IMPLEMENTATION_BLUEPRINT.md  
**Date:** 2026-06-30  
**Review cycle:** Before each sprint + after every production incident  

---

## Risk Scoring Guide

```
PROBABILITY  (P)           IMPACT  (I)                    SCORE = P × I
  1 = Very Low (<5%)         1 = Negligible (cosmetic)      1–4  = LOW
  2 = Low     (5–15%)        2 = Minor (hours to fix)       5–9  = MEDIUM
  3 = Medium  (15–35%)       3 = Moderate (missed trades)   10–14 = HIGH
  4 = High    (35–60%)       4 = Serious (state loss)       15–20 = CRITICAL
  5 = Very High (>60%)       5 = Critical (data loss/outage)
```

---

## Risk Summary

| ID | Title | P | I | Score | Status |
|----|-------|---|---|-------|--------|
| R-01 | Live state lost on Railway restart | 4 | 4 | 16 | OPEN — Phase 3 closes this |
| R-02 | Engine C/D knowledge rebuilt from scratch every restart | 5 | 3 | 15 | OPEN — Phase 5 closes this |
| R-03 | Ghost trade from crash between OANDA fill and DB commit | 2 | 4 | 8 | OPEN — Phase 2 mitigates |
| R-04 | StateManager blocks hot path (handleBotLine) | 3 | 5 | 15 | Phase 1 — must be async |
| R-05 | Version conflict storm in saveDomainRetry | 2 | 3 | 6 | Phase 1 — debounce required |
| R-06 | OANDA API key not available in telemetry environment | 3 | 3 | 9 | Phase 2 — env var required |
| R-07 | Knowledge artifact checksum corruption | 1 | 5 | 5 | Phase 5 — auto-rollback |
| R-08 | RecoveryManager hangs indefinitely at startup | 2 | 5 | 10 | Phase 6 — timeouts required |
| R-09 | ValidationManager false positive triggers HALTED | 2 | 5 | 10 | Phase 6 — classification |
| R-10 | shadowGate() latency regression (sync→async corruption) | 2 | 5 | 10 | All phases — design |
| R-11 | midnight UTC daily counter reset race condition | 2 | 3 | 6 | Phase 3 — date check |
| R-12 | memory_entries unbounded growth | 3 | 2 | 6 | Phase 4 — GC required |
| R-13 | Knowledge artifact byte size exceeds PostgreSQL row limit | 1 | 3 | 3 | Phase 5 — monitoring |
| R-14 | Engine C/D learning regression post-migration | 2 | 4 | 8 | Phase 5 — validation |
| R-15 | Concurrent startup (two Railway instances) corrupts state | 1 | 5 | 5 | Design — pg_advisory_lock |
| R-16 | Phase rollback destroys forward progress | 1 | 4 | 4 | Design — additive only |
| R-17 | Railway deploys while trade is open | 3 | 3 | 9 | Design — SIGTERM handler |
| R-18 | events table performance degrades at 1M+ rows | 2 | 3 | 6 | Architecture — indexes |
| R-19 | db-adapter.js pool exhaustion under load | 2 | 4 | 8 | Phase 0 — pool sizing |
| R-20 | Dead code archived file is still required somewhere | 2 | 4 | 8 | Phase 0 — grep check |
| R-21 | index.js silently changed by external actor | 1 | 5 | 5 | GOLDEN RULE — git protection |
| R-22 | OANDA rate limit hit during startup reconciliation | 2 | 2 | 4 | Phase 2 — minimal calls |
| R-23 | knowledge_artifacts.value column size limit | 2 | 3 | 6 | Phase 5 — chunked storage |
| R-24 | IntentManager trade_intents table grows unbounded | 3 | 1 | 3 | Phase 2 — cleanupStale |
| R-25 | PostgreSQL connection string changes (Railway migration) | 1 | 5 | 5 | Ops — env var management |
| R-26 | Manager module requires circular dependency | 2 | 2 | 4 | Design — dependency graph |
| R-27 | ValidationManager check false negative (misses real issue) | 2 | 3 | 6 | Phase 6 — test coverage |
| R-28 | SnapshotManager snapshot size too large (slows startup) | 1 | 2 | 2 | Phase 7 — size limits |
| R-29 | EnginePlugin.onRecovery() throws and blocks Phase 7 | 2 | 3 | 6 | Phase 7 — timeout+catch |
| R-30 | Production data loss if DROP TABLE is run accidentally | 1 | 5 | 5 | GOLDEN RULE — DDL policy |

---

## Risk Details

---

### R-01 — Live State Lost on Railway Restart

```
TITLE:        Live state (openTrades, dailyTrades) lost on Railway restart
CATEGORY:     Data Loss
PHASE:        Affects current system (v40.1); closed by Phase 3
PROBABILITY:  4 (High) — Railway restarts happen on every deploy, crash, or OOM
IMPACT:       4 (Serious) — dailyTrades resets to 0 (may allow over-limit trading);
                            openTrades lost (bot re-opens positions that are already open)
SCORE:        16 (CRITICAL)
OWNER:        Phase 1 (dual-write) + Phase 3 (read switchover)

CURRENT STATE:
  State is restored via event-replay on every restart.
  Replay time grows with events table size.
  At 10,000 events: ~2-3s. At 100,000 events: ~15-20s. At 1M events: ~2-3min.
  During replay: bot is NOT running. Missed signals possible.

MITIGATION:
  Phase 1: Dual-write every state mutation to runtime_domains.
  Phase 3: Read from runtime_domains on startup → O(1) regardless of event count.
  Phase 6 (RecoveryManager Phase 6): OANDA reconciliation confirms live.openTrades
           matches actual OANDA positions, fixing any possible drift.

RESIDUAL RISK (post-Phase 3):
  LOW. The only remaining risk is the midnight UTC date crossover:
  runtime_domains.live.date = yesterday → fallback to event-replay → slower startup.
  This is expected behavior and takes ~200ms at current event counts.

TRIGGER CONDITIONS:
  - Railway process OOM restart
  - Railway deploy (SIGTERM + new process)
  - Any unhandled exception that kills the Node.js process

DETECTION:
  - Railway logs: [SERVER FALLBACK] message (Phase 3 fallback path activated)
  - GET /api/system/status: status = 'DEGRADED' if reconciliation failed

MONITORING:
  After Phase 3: Watch for [SERVER FALLBACK] in Railway logs.
  After Phase 6: Check consistency_log.check_id = 'live_vs_oanda' for failures.
```

---

### R-02 — Engine Knowledge Rebuilt from Scratch Every Restart

```
TITLE:        Engine C (KNN) and Engine D (weights) rebuild from shadowm_trades on every restart
CATEGORY:     Performance + Learning Continuity
PHASE:        Affects current system; closed by Phase 5
PROBABILITY:  5 (Very High) — This happens on EVERY restart without exception
IMPACT:       3 (Moderate) — 10–18s cold start; accumulated learning lost for 1 restart cycle
SCORE:        15 (CRITICAL)
OWNER:        Phase 5

CURRENT STATE:
  ShadowKNNEngine._refreshDatasetAsync(): SELECT * FROM shadowm_trades WHERE exit_time IS NOT NULL
  ShadowMetaEngine weight computation: full scan of recent shadowm_trades
  Both executed on first _cycle() after startup.
  At 2,000 closed trades: ~8-12s rebuild time.
  At 10,000 closed trades: ~18s rebuild time.
  During rebuild: Engine C/D use default weights → suboptimal trade decisions.

MITIGATION:
  Phase 5: KnowledgeManager stores built dataset in knowledge_artifacts.
  On startup: load('engineC', 'dataset') → O(1), ~80ms at any scale.
  Incremental updates: only append new examples, never full rebuild.
  getCached() provides synchronous access for shadowGate().

RESIDUAL RISK (post-Phase 5):
  VERY LOW. Scenario: knowledge_artifacts corrupted AND no valid prior version.
  Mitigation: Engine uses safe defaults (equal weights, empty dataset).
  System enters DEGRADED status. Trading continues but Engine C/D less accurate.
  Recovery: 10–50 trades rebuild meaningful knowledge base.

QUANTIFIED BENEFIT:
  Before Phase 5 (10,000 trades): 18s startup + learning lost each restart
  After Phase 5 (10,000 trades):  80ms startup + learning fully preserved
  After Phase 5 (1,000,000 trades): 80ms startup + learning fully preserved
  This benefit compounds indefinitely as the system accumulates experience.
```

---

### R-03 — Ghost Trade from Crash Between OANDA Fill and DB Commit

```
TITLE:        OANDA fills trade order but process crashes before trade_open event fires
CATEGORY:     Data Integrity
PHASE:        Partial mitigation in Phase 2; full mitigation requires Phase 6
PROBABILITY:  2 (Low) — Requires crash in specific 50ms window
IMPACT:       4 (Serious) — Open position in OANDA not tracked in server; bot may re-open
SCORE:        8 (MEDIUM)
OWNER:        Phase 2 (OANDA reconciliation) + Phase 6 (RecoveryManager Phase 6)

CURRENT STATE:
  Timeline: OANDA POST /orders → fill (~50ms) → index.js calls logEvent() → emitter fires
  If crash between fill and logEvent: OANDA has open position; server.js does not.
  On restart: event-replay finds no trade_open → live.openTrades empty → bot re-opens.
  Result: TWO OANDA positions for same signal. Doubled exposure.

MITIGATION (Phase 2):
  OANDA reconciliation on startup: compare live.openTrades with OANDA /openTrades.
  Any OANDA position not in live.openTrades → flagged + added (RECONCILE_POLICY=AUTO).

LIMITATION:
  Since index.js is FROZEN, intent cannot be written BEFORE the OANDA call.
  The intent write is retroactive (after trade_open event fires).
  This means the crash window (fill→logEvent) cannot be fully eliminated without
  modifying index.js.

RESIDUAL RISK (post-Phase 2):
  LOW. The crash window is ~50ms. OANDA reconciliation on startup catches it.
  The only scenario not covered: crash during a Railway RESTART that is triggered
  by Railway's own health check while a trade is in the fill→logEvent window.
  Probability: <0.1% per deploy.

DETECTION:
  consistency_log.check_id = 'live_vs_oanda' → mismatch found on startup
  Railway logs: [INTENT RECONCILE] with action=CONFIRMED for previously unknown signalId

MONITORING:
  After Phase 2: count of [INTENT RECONCILE] CONFIRMED events. Expected: ~0/month.
  A spike indicates a pattern that requires investigation.
```

---

### R-04 — StateManager Blocks Hot Path

```
TITLE:        saveDomainRetry() accidentally awaited in handleBotLine(), blocking the event loop
CATEGORY:     Performance / Service Outage
PHASE:        Phase 1 — must be designed around
PROBABILITY:  3 (Medium) — Common mistake, easy to accidentally add await
IMPACT:       5 (Critical) — Blocks stdout parsing; bot lines are not processed; no trade tracking
SCORE:        15 (CRITICAL)
OWNER:        Phase 1 implementation engineer

DESCRIPTION:
  handleBotLine() is called synchronously by the 'data' event from index.js's stdout.
  It must return immediately. Any await in this function blocks the event loop.
  saveDomainRetry() is async (returns a Promise).
  If an engineer accidentally writes: await stateManager.saveDomainRetry(...) in handleBotLine(),
  all subsequent stdout lines are queued but not processed until the await resolves.
  During that time: trade state is not updated. Missed pips, missed closes.

MITIGATION:
  RULE (enforced via code review):
    stateManager.saveDomainRetry(...).catch(e => {})  ← CORRECT (fire-and-forget)
    await stateManager.saveDomainRetry(...)           ← FORBIDDEN in handleBotLine()
  Add comment in handleBotLine(): // CRITICAL: never use await here. Fire-and-forget only.
  Write an integration test: confirm handleBotLine() returns in <1ms regardless of DB latency.

DETECTION:
  Symptom: live.openTrades shows delay in updates (pips not updating after opening)
  Symptom: Railway logs show 'data' events backing up

RESIDUAL RISK (post-Phase 1 if rule enforced): VERY LOW
```

---

### R-05 — Version Conflict Storm in saveDomainRetry

```
TITLE:        High-frequency pips/peak updates cause version conflict storms
CATEGORY:     Performance
PHASE:        Phase 1
PROBABILITY:  2 (Low) — Occurs if debounce not implemented
IMPACT:       3 (Moderate) — DB write amplification; Railway PG connections exhausted
SCORE:        6 (MEDIUM)
OWNER:        Phase 1

DESCRIPTION:
  index.js emits pips updates every 5 seconds per open position.
  With 4 open positions: 48 writes/minute to runtime_domains.live.
  Each write is a version-checked UPDATE: two concurrent updates → one retries.
  In practice: pips and peak are cosmetic — they don't affect trading decisions.
  DB writes for cosmetic state changes are wasteful.

MITIGATION:
  Debounce non-critical updates (pips, peak, breakEven) with 100ms window.
  Only immediate-write on: trade_open, trade_close, dailyTrades increment.
  Debounce implementation: use a single debounce timer per position per update type.

EXPECTED RESULT:
  Without debounce: ~48 writes/min (4 positions × 12 ticks/min)
  With debounce:    ~4 writes/min (once per 100ms window, batched)
  Reduction: 92%

MONITORING:
  After Phase 1: watch runtime_domains.live.version increment rate.
  Expected: 5–10 version increments per trade (open, close, breakEven, dailyTrades).
  If seeing >100 increments per trade: debounce is not working.
```

---

### R-06 — OANDA API Key Not Available in Telemetry Environment

```
TITLE:        OANDA_API_KEY and OANDA_ACCOUNT_ID not set in server.js environment
CATEGORY:     Configuration
PHASE:        Phase 2
PROBABILITY:  3 (Medium) — Railway env vars are set per service; telemetry may not have them
IMPACT:       3 (Moderate) — OANDA reconciliation skipped; ghost trades not detected
SCORE:        9 (MEDIUM)
OWNER:        Phase 2

DESCRIPTION:
  index.js uses OANDA_API_KEY and OANDA_ACCOUNT_ID (confirmed — they are in the bot env).
  server.js (telemetry/server.js) is the SAME Railway service → same environment.
  However: a new OANDA_BASE_URL variable is needed (currently hardcoded in index.js).
  Risk: OANDA_BASE_URL is missing from Railway env vars.

MITIGATION:
  Add OANDA_BASE_URL to Railway environment variables before Phase 2 deploy.
  In server.js startup: check for OANDA_BASE_URL, OANDA_API_KEY, OANDA_ACCOUNT_ID.
  If any missing: log WARNING, skip reconciliation (do not HALT).
  Add test: verify reconciliation gracefully handles missing env vars (no throw, just log).

REQUIRED RAILWAY ENV VARS:
  OANDA_BASE_URL:  https://api-fxtrade.oanda.com  (or https://api-fxpractice.oanda.com)
  OANDA_API_KEY:   (already set — used by index.js)
  OANDA_ACCOUNT_ID: (already set — used by index.js)

DETECTION:
  Railway logs: [INTENT] WARNING: OANDA_BASE_URL not set — reconciliation skipped
```

---

### R-07 — Knowledge Artifact Checksum Corruption

```
TITLE:        knowledge_artifacts row has invalid checksum (storage corruption or bad write)
CATEGORY:     Data Integrity — Knowledge Layer
PHASE:        Phase 5 (must be handled at load time)
PROBABILITY:  1 (Very Low) — PostgreSQL ACID guarantees prevent partial writes
IMPACT:       5 (Critical) — Engine C/D would load corrupted dataset → wrong decisions
SCORE:        5 (MEDIUM-LOW)
OWNER:        Phase 5

DESCRIPTION:
  SHA-256 checksum is computed at save time and stored in the row.
  On load: checksum is recomputed from the value JSON and compared.
  Corruption scenarios:
    1. Bug in save(): computed wrong checksum (implementation error)
    2. Manual DB edit: someone updated the value without updating the checksum
    3. PostgreSQL page-level corruption (extremely rare with JSONB + WAL)

MITIGATION:
  On checksum mismatch:
    1. Log CRITICAL: [KNOWLEDGE] CORRUPTION detected in ${domain}/${artifact}
    2. Attempt rollback: load prior 5 versions, verify each checksum
    3. Use first valid prior version (create new active version from it)
    4. If no valid prior: log CRITICAL, proceed with safe defaults (empty/equal weights)
    5. Set system status to DEGRADED (not HALTED — training can resume from scratch)

  At save time: verify checksum round-trip before committing
    (compute checksum, save, reload, verify — used in integration tests only)

DETECTION:
  [KNOWLEDGE] CORRUPTION log entry
  consistency_log.check_id = 'knowledge_checksums' with severity = 'CRITICAL'
  GET /api/system/knowledge: confidence=0 or artifact missing

RECOVERY TIME: <5 seconds (auto-rollback to prior version)
```

---

### R-08 — RecoveryManager Hangs Indefinitely at Startup

```
TITLE:        A recovery phase hangs (e.g. OANDA API timeout, DB query timeout) blocking startup
CATEGORY:     Service Availability
PHASE:        Phase 6
PROBABILITY:  2 (Low) — Network timeouts are not handled if timeouts are not implemented
IMPACT:       5 (Critical) — Process never reaches READY state; bot never spawns
SCORE:        10 (HIGH)
OWNER:        Phase 6

DESCRIPTION:
  RecoveryManager calls external APIs (OANDA) and DB queries at startup.
  If OANDA call hangs (no timeout set) and OANDA is unresponsive: process never starts.
  Railway restartPolicy: ON_FAILURE — would restart after Node.js process times out.
  But if the process is hanging (not crashed), Railway does not restart it.

MITIGATION:
  Every phase in RecoveryManager must have an explicit timeout:
    Phase 6 (OANDA): timeout = 5000ms (5 seconds)
    Phase 2 (DB loadAll): timeout = 3000ms
    Phase 4 (knowledge load): timeout = 2000ms per artifact
    Phase 8 (validation): timeout = 10000ms total
  
  Timeout implementation:
    const withTimeout = (promise, ms, label) =>
      Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms))]);
  
  On timeout: log ERROR, mark phase as FAILED, continue with next phase.
  Phase 6 timeout → OANDA_UNREACHABLE → status = DEGRADED (not HALTED).
  No individual phase timeout should prevent the system from reaching Phase 9.

DETECTION:
  Railway logs: [RECOVERY] Phase N timeout after Xms
  Railway health check: /api/system/status returns 503 (not yet up)
  Railway would eventually restart after its own health check timeout (30s)

RESIDUAL RISK: LOW — all phases have explicit timeouts.
```

---

### R-09 — ValidationManager False Positive Triggers HALTED

```
TITLE:        A validation check incorrectly classifies a WARN issue as CRITICAL, halting the system
CATEGORY:     Availability
PHASE:        Phase 6
PROBABILITY:  2 (Low) — Possible on first deployment before checks are tuned
IMPACT:       5 (Critical) — System halted; no trading
SCORE:        10 (HIGH)
OWNER:        Phase 6

DESCRIPTION:
  12 validation checks run at startup and every 5 minutes.
  If a check severity is miscategorized (WARN → CRITICAL) in code:
    RecoveryManager sees Phase 8 result as CRITICAL issue → sets status to HALTED.
    Bot is not spawned. No trading until manual intervention.
  
  Most likely false positive candidates:
    - live_vs_oanda: during startup race condition (OANDA call before state loaded)
    - shadowm_cursor_lag: if events.id has gaps (normal after period of inactivity)
    - learning_degradation: edge case at very low trade counts (< 20 samples)

MITIGATION:
  Conservative severity policy:
    Default severity for new checks: WARN (not CRITICAL)
    Only escalate to CRITICAL after 3 consecutive check failures (not first failure)
    HALTED status requires 2+ CRITICAL issues simultaneously (not just 1)
  
  Threshold tuning:
    shadowm_cursor_lag: threshold = 100 events (not 10)
    learning_degradation: only active if ≥ 50 training samples available
    live_vs_oanda: run after Phase 6 OANDA reconciliation completes (ordering)
  
  Phase 6 testing: simulate each condition that would trigger CRITICAL.
    Verify: system enters DEGRADED, not HALTED.
    Intentionally trigger HALTED: verify it requires genuinely unrecoverable state.

DETECTION:
  [RECOVERY] Status: HALTED when system should be HEALTHY
  GET /api/system/status: blockers[] contains unexpected check names
```

---

### R-10 — shadowGate() Latency Regression

```
TITLE:        A phase introduces async behavior into the shadowGate() synchronous call chain
CATEGORY:     Trading Performance / Correctness
PHASE:        All phases — permanent design constraint
PROBABILITY:  2 (Low) — Easy mistake when refactoring shadowlab.js
IMPACT:       5 (Critical) — shadowGate() called on every index.js signal evaluation;
                             any await = broken synchrony = signals evaluated incorrectly
SCORE:        10 (HIGH)
OWNER:        All phases — enforced by design rule

DESCRIPTION:
  shadowGate() in shadowlab.js is SYNCHRONOUS by design.
  index.js calls: const result = shadowGate(signal)  ← no await, no Promise
  If shadowGate() returns a Promise (accidentally made async):
    result = Promise {<pending>} (truthy object)
    Destructuring: const {blocked} = result  → blocked = undefined → signal passes gate
    All signals now pass through the gate regardless of Engine C/D decisions.
  This is a silent failure — no error, no log, just wrong behavior.

MITIGATION:
  RULE: shadowGate() MUST remain synchronous. Never add async/await to it.
  KnowledgeManager: all data accessed via getCached() (synchronous, from _cache Map)
  MemoryManager: all data accessed via getCached() if needed (synchronous)
  StateManager: getCached() for domain reads (synchronous)
  
  Linting rule: add eslint-plugin rule or comment: // NO async — shadowGate is called sync
  
  Integration test (runs in every sprint's test suite):
    const result = shadowGate({...signal});
    assert.ok(!(result instanceof Promise), 'shadowGate must be synchronous');
    assert.ok(typeof result.blocked === 'boolean', 'shadowGate must return {blocked: boolean}');
  
  This test must be in the CI suite and run before every deploy.

DETECTION:
  Symptom: win rate suddenly changes dramatically (all signals pass or all signals block)
  Symptom: shadowGate eval events show unexpected patterns
  Test: the integration test above catches it before deployment

RESIDUAL RISK: LOW — if the test is run before every deploy.
```

---

### R-11 — Midnight UTC Daily Counter Reset Race Condition

```
TITLE:        Daily trade counter resets at midnight while a trade is opening
CATEGORY:     Data Correctness
PHASE:        Phase 3 (date-based runtime_domains check)
PROBABILITY:  2 (Low) — Requires trade opening exactly at 00:00:00 UTC
IMPACT:       3 (Moderate) — dailyTrades counter may be off by 1 after midnight
SCORE:        6 (MEDIUM)
OWNER:        Phase 3

DESCRIPTION:
  At midnight UTC, runtime_domains.live.date ≠ today.
  restoreLiveState() detects stale date → falls back to event-replay.
  Event-replay: SELECT trade_open events WHERE date=today → correct count.
  
  Race: trade opens at 23:59:59 UTC → both date checks see different dates.
  
MITIGATION:
  The event-replay fallback path handles this correctly.
  restoreLiveState() date check: if (rs.value.date === today) → use runtime_domains.
  At midnight: today ≠ stored date → fallback to event-replay → dailyTrades = 0 (correct).
  
  After fallback: update runtime_domains.live.date = today → next midnight-plus restart is fast.
  
  The one-second window at midnight: acceptable risk. If a trade opens in this window
  and the process restarts in the same second: counter may be off by 1.
  Counter drift check: ValidationManager.check_id = 'daily_counter_drift' catches and repairs.

RESIDUAL RISK: VERY LOW — even in the worst case, auto-repair corrects it.
```

---

### R-12 — memory_entries Unbounded Growth

```
TITLE:        TTL entries accumulate faster than GC removes them; memory_entries grows without bound
CATEGORY:     Performance / Storage
PHASE:        Phase 4
PROBABILITY:  3 (Medium) — If GC schedule is wrong or TTLs are too long
IMPACT:       2 (Minor) — Slow query performance on memory_entries; Railway PostgreSQL storage
SCORE:        6 (MEDIUM)
OWNER:        Phase 4

DESCRIPTION:
  memory_entries is the Memory Layer store.
  Every cooldown, observation, and market context entry adds a row.
  Rows are NOT physically deleted at expiry — only logically filtered (expires_at < NOW()).
  Physical deletion requires GC (explicit DELETE WHERE expires_at < NOW()).
  
  If GC does not run (bug in scheduleGC, or missed after restart):
    Rows accumulate. At 100 signals/day × 30 day TTL = 3000 rows/30 days.
    At current signal volume: ~300 rows/day max.
    At 1 year: ~110,000 rows (manageable but suboptimal without GC).

MITIGATION:
  GC runs hourly: setInterval(() => memoryManager.gc(), 3600000)
  GC on startup: await memoryManager.gc() before accepting connections
  
  Monitoring query (run weekly):
    SELECT COUNT(*), namespace FROM memory_entries GROUP BY namespace;
  
  Hard cap (optional): if memory_entries > 50,000: alert + force GC
  ValidationManager check: check_id = 'memory_leak_detection' (count > 10,000 = WARN)

EXPECTED STEADY STATE:
  With hourly GC and ~300 rows/day input:
    Rows that survive GC = entries with long TTLs (7d decision history).
    Steady state: ~2,100 rows (7 days × 300/day).
    GC removes expired rows hourly. Growth is bounded.
```

---

### R-13 — Knowledge Artifact Exceeds PostgreSQL Row Size

```
TITLE:        knowledge_artifacts.value JSONB column exceeds PostgreSQL practical limits
CATEGORY:     Performance / Correctness
PHASE:        Phase 5
PROBABILITY:  1 (Very Low) — Only at 100,000+ training examples
IMPACT:       3 (Moderate) — save() fails; incremental updates stop; stuck at last saved version
SCORE:        3 (LOW)
OWNER:        Phase 5 — monitoring required

DESCRIPTION:
  PostgreSQL JSONB column: no hard limit. Practical limit: TOAST threshold (~8KB inline).
  Above 8KB: PostgreSQL stores TOAST externally but retrieves correctly.
  Practical concern: very large JSON blobs (>10MB) slow serialization and parsing.
  
  Engine C dataset at scale:
    1,000 examples × ~500 bytes each = 500KB (fine)
    10,000 examples × 500 bytes = 5MB (manageable, slightly slow)
    100,000 examples × 500 bytes = 50MB (problematic — 200ms+ serialization)

MITIGATION (Phase 5 implementation):
  Monitor artifact byte_size column after Phase 5 deploy.
  If byte_size > 5,000,000 (5MB): log WARNING, consider chunked storage.
  Chunked storage: split dataset into chunks (1,000 examples each), each a separate artifact.
  Implementation deferred until byte_size > 5MB (expected at ~10,000 closed trades).
  
  At current trading volume (3–5 trades/day): 10,000 closed trades ≈ 5–9 years away.
  Re-evaluate at 2,000 closed trades or 2MB artifact size.

MONITORING:
  Monthly: SELECT domain, artifact, byte_size FROM knowledge_artifacts WHERE superseded_at IS NULL;
  Alert threshold: byte_size > 5,000,000 → implement chunked storage
```

---

### R-14 — Engine C/D Learning Regression Post-Migration

```
TITLE:        Engine C/D behavior changes after migration to KnowledgeManager
              (win rate drops, different trade decisions vs pre-migration)
CATEGORY:     Product Quality
PHASE:        Phase 5
PROBABILITY:  2 (Low) — Possible if feature vector construction differs
IMPACT:       4 (Serious) — Bot takes worse trades; financial impact
SCORE:        8 (MEDIUM)
OWNER:        Phase 5

DESCRIPTION:
  The one-time migration builds the Engine C dataset from shadowm_trades rows.
  The feature vector function must produce identical output to the current
  _buildDataset() function in shadowlab.js.
  If there is any discrepancy (different normalization, different field selection):
    Engine C's KNN distances are computed on a different feature space.
    Predictions change. Gates behave differently. Win rate may change.

MITIGATION:
  Pre-migration validation:
    1. On staging: run current _buildDataset() → save as "reference dataset"
    2. Run migration function → save as "migrated dataset"
    3. Compare: every example must be bit-for-bit identical
    4. Run Engine C on 100 signals with reference dataset → record decisions
    5. Run Engine C on 100 signals with migrated dataset → record decisions
    6. Decisions must be identical

  Post-migration monitoring (48h minimum):
    Compare win rates: pre-migration 7-day average vs post-migration 7-day average.
    If win rate drops > 5%: trigger rollback.
    Win rate = percentage of trades that closed in profit.

  Rollback trigger: win rate drops >5% over 48h post-Phase 5 deploy.

RESIDUAL RISK (if validated before deploy): LOW
```

---

### R-15 — Concurrent Startup (Two Railway Instances) Corrupts State

```
TITLE:        Railway blue-green deploy briefly runs two instances simultaneously
              Both write to runtime_domains with the same version → one wins, one silently loses
CATEGORY:     Data Integrity
PHASE:        Design constraint — relevant in all phases
PROBABILITY:  1 (Very Low) — Railway deploy strategy + optimistic locking mitigates
IMPACT:       5 (Critical) — Potential split-brain: two instances with different live.openTrades
SCORE:        5 (MEDIUM-LOW)
OWNER:        Architecture

DESCRIPTION:
  Railway's deploy process: new instance starts before old instance stops.
  Brief overlap: two processes running simultaneously.
  Both load runtime_domains.live → get same version (e.g., v42).
  Both call saveDomainRetry('live', ...) → one writes v43 (version=42 OK), one fails (version≠42).
  saveDomainRetry retries: reloads v43, applies transform, writes v44.
  Result: both instances write, but with slightly different transforms.
  The losing instance applies its transform to v43 (which already incorporated the winner's transform).
  
  In practice: Railway uses SIGTERM (not concurrent), and the SIGTERM handler flushes state.
  The new instance starts after the old one finishes its graceful shutdown.
  True concurrent startup is rare.

MITIGATION:
  Phase 8 SIGTERM handler: flush all pending saves + write 'shutting_down' to meta.status.
  New instance on startup (RecoveryManager Phase 2): if meta.status = 'shutting_down':
    wait 2000ms (let old process finish) → retry loadAll().
  
  For true concurrent scenarios (Railway bug): optimistic concurrency handles conflicts.
  saveDomainRetry retries: the transform function is always applied to the CURRENT DB value.
  Idempotent transforms: f(f(x)) = f(x) → writes are safe to compose.
  Non-idempotent: counter++ → two concurrent increments = +2, not +1.
  
  Solution: avoid non-idempotent transforms. Use absolute values, not deltas:
    daily_counter: set to current count, not increment.

RESIDUAL RISK: LOW — SIGTERM handler + idempotent transforms prevent data loss.
```

---

### R-16 — Phase Rollback Destroys Forward Progress

```
TITLE:        Rolling back a phase deletes knowledge, memory, or state that was accumulated
CATEGORY:     Data Loss
PHASE:        All phases
PROBABILITY:  1 (Very Low) — Only if rollback procedure is done incorrectly
IMPACT:       4 (Serious) — Accumulated knowledge lost; must rebuild from scratch
SCORE:        4 (LOW)
OWNER:        All phases — enforced by additive design principle

DESCRIPTION:
  A naive rollback might DROP TABLE knowledge_artifacts → losing all training data.
  Or: DELETE FROM runtime_domains → losing state that Phase 3 relies on.
  
MITIGATION:
  GOLDEN RULE (enforced): Phase rollback only reverts CODE, never DATA.
  Rollback = git revert + deploy. Database is never touched in a code rollback.
  
  Phase rollback procedures (see MIGRATION_CHECKLIST.md) only:
    - Revert code commits (git revert)
    - Drop new-in-this-phase tables (Phase 0 only: new tables only)
    - Never touch: events, shadowm_trades, shadowm_timeline, knowledge_artifacts, runtime_domains
  
  Documentation: each rollback procedure explicitly lists what is NOT touched.
  Code review: no PR may include a schema change that removes data.
```

---

### R-17 — Railway Deploys While Trade Is Open

```
TITLE:        Railway deploy sends SIGTERM while index.js has an open OANDA position
CATEGORY:     Trading Safety
PHASE:        All phases — Phase 8 SIGTERM handler addresses this
PROBABILITY:  3 (Medium) — Every deploy during market hours could hit this
IMPACT:       3 (Moderate) — Trade not properly tracked until next OANDA reconciliation
SCORE:        9 (MEDIUM)
OWNER:        Phase 8 (SIGTERM handler)

DESCRIPTION:
  Railway deploy: SIGTERM → old process → 5s grace → SIGKILL.
  index.js receives SIGTERM: if no handler, dies immediately.
  Open OANDA positions remain open (OANDA doesn't close on our process death).
  New instance restarts: OANDA reconciliation finds the position and adds to live.openTrades.
  Gap: ~5–15 seconds between old instance dying and new instance reconciling OANDA.
  During this gap: no monitoring of the open position (SL/TP still managed by OANDA).
  
  Since index.js is FROZEN: we cannot add a SIGTERM handler to it.
  server.js can handle SIGTERM and kill index.js gracefully.

MITIGATION:
  Phase 8 SIGTERM handler in server.js:
    1. await stateManager.flush() → ensure runtime_domains are current
    2. bot.kill('SIGTERM') → signal index.js to finish its current loop cycle
    3. await Promise.race([botExited, timeout(5000)]) → wait max 5s
    4. await snapshotManager.takeSnapshot('PRE_SHUTDOWN')
    5. server.close() → stop accepting new HTTP requests
    6. process.exit(0)
  
  index.js handles SIGTERM: it finishes its current trade loop cycle (existing behavior).
  After loop cycle: closes gracefully. Open positions: OANDA manages with existing SL/TP.
  
  New instance reconciliation (Phase 2/6): finds and tracks any open positions within 500ms.

RESIDUAL RISK: LOW — open positions are always managed by OANDA SL/TP regardless of our process.
```

---

### R-18 — events Table Performance Degrades at 1M+ Rows

```
TITLE:        events table grows to 1M+ rows; analytics queries take 30+ seconds
CATEGORY:     Performance
PHASE:        All phases — events table is append-only, grows forever
PROBABILITY:  2 (Low) — At current volume, ~1M rows reached in ~2 years
IMPACT:       3 (Moderate) — Analytics endpoints slow; Railway PG storage cost grows
SCORE:        6 (MEDIUM)
OWNER:        Architecture — future work

DESCRIPTION:
  events table: ~500–1000 rows/day (conservative estimate).
  At 1,000 rows/day: 1M rows in ~3 years. At 5,000 rows/day: ~7 months.
  Analytics queries in server.js always use LIMIT (500–5000 rows).
  Index on (type, id DESC) would make these fast regardless of total count.
  Index on (symbol, ts) for date-range queries.
  
  SHADOW OS v2 changes: startup NO LONGER scans events table (runtime_domains is primary).
  All remaining events table scans are analytics (read-only, not latency-sensitive).

MITIGATION:
  Phase 0: verify index exists: CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id DESC);
  
  At 1M rows (future): consider partitioning events by month or year.
  At 5M rows (future): consider archiving events older than 1 year to cold storage.
  
  SHADOW OS v2 dramatically reduces event table scanning:
    Before: events table scanned on EVERY startup for state restore
    After: events table only scanned for analytics queries (user-initiated, bounded by LIMIT)

MONITORING:
  Monthly: SELECT reltuples FROM pg_class WHERE relname = 'events';
  Alert at: 500,000 rows (add index if not present); 2,000,000 rows (plan archiving)
```

---

### R-19 — db-adapter.js Pool Exhaustion Under Load

```
TITLE:        PostgreSQL connection pool (max=10) exhausted by concurrent Manager Tier calls
CATEGORY:     Performance / Availability
PHASE:        All phases — new managers increase concurrent DB calls
PROBABILITY:  2 (Low) — Pool exhaustion unlikely at current query volume
IMPACT:       4 (Serious) — All DB calls queue or fail; managers return errors
SCORE:        8 (MEDIUM)
OWNER:        Phase 0 — pool sizing review

DESCRIPTION:
  Current pool: max=10 connections.
  SHADOW OS v2 adds 7 managers, each making async DB calls.
  Worst case: all managers call DB simultaneously at startup (RecoveryManager Phase 2–8).
  
  Phase 2 (loadAll): 1 query
  Phase 4 (knowledge load ×3): 3 queries
  Phase 5 (pending intents): 1 query
  Phase 6 (OANDA reconcile): 1 query (plus intent updates)
  Phase 8 (validation checks ×12): 12 concurrent queries
  Peak: ~18 concurrent queries at validation time.
  
  With pool max=10: 8 queries queue. At 5ms/query: 40ms queue wait.
  Not critical at current scale. Becomes a concern at high validation frequency.

MITIGATION:
  Increase pool max to 20 in db-adapter.js:
    max: 20,  // was 10; managers add ~10 more concurrent connections
  
  Run validation checks sequentially (not concurrently) to avoid pool pressure:
    for (const check of this._checks) { result = await check(); }
  
  Monitor pool usage: add db._pool.totalCount and db._pool.idleCount to /api/stats.
  Alert if: idleCount === 0 (all connections in use) for >30 seconds.

RESIDUAL RISK: LOW — sequential validation checks prevent pool exhaustion.
```

---

### R-20 — Archived File Is Still Required Somewhere

```
TITLE:        A file moved to /archive/ is still required() by active code
CATEGORY:     Build / Service Outage
PHASE:        Phase 0
PROBABILITY:  2 (Low) — Possible if dead code analysis was incomplete
IMPACT:       4 (Serious) — Module not found error; process crashes at startup
SCORE:        8 (MEDIUM)
OWNER:        Phase 0

DESCRIPTION:
  Files to archive: dashboard.js, index_backup_*.js, server_backup_*.js, shadowlab_backup_*.js.
  If any of these is required by active code: archiving causes MODULE_NOT_FOUND error.
  Current analysis: none of these files are required by any active module.
  However: if grep misses a dynamic require() or a string-based require, it could be missed.

MITIGATION:
  Before archiving each file:
    grep -r "require.*<filename>" . --include="*.js" | grep -v node_modules | grep -v archive
  Expected result: 0 matches.
  Also check: dynamic require patterns: grep -r "require(\`" . --include="*.js"
  
  After archiving: run locally:
    node -e "require('./telemetry/server')" 2>&1 | head -5
  Expected: no MODULE_NOT_FOUND errors.
  
  Also verify: node telemetry/server.js starts without error (full startup test).
```

---

### R-21 — index.js Modified by External Actor (Frozen Bot Violation)

```
TITLE:        index.js (the live trading bot) is modified in violation of the GOLDEN RULE
CATEGORY:     Governance / Safety
PHASE:        All phases — permanent constraint
PROBABILITY:  1 (Very Low) — Only if process controls fail
IMPACT:       5 (Critical) — Unintended behavior in live trading bot; financial risk
SCORE:        5 (MEDIUM-LOW)
OWNER:        All phases — governance control

DESCRIPTION:
  index.js is 2,360 lines of live trading logic.
  It directly calls OANDA and executes real trades.
  Any modification, no matter how small, carries risk of unintended side effects.
  The FROZEN status means: no engineer may modify index.js during the SHADOW OS v2 migration.
  
MITIGATION:
  Git protection: add a pre-commit hook that fails if index.js is in the diff.
  Code review policy: any PR that touches index.js requires senior review + staging deploy.
  
  Pre-commit hook:
    #!/bin/sh
    if git diff --cached --name-only | grep -q "^index\.js$"; then
      echo "ERROR: index.js is FROZEN. Do not modify it during SHADOW OS v2 migration."
      exit 1
    fi
  
  Add to OPERATIONS_RUNBOOK.md: "index.js must not be modified until SHADOW OS v2 is PRODUCTION CERTIFIED and the constraint is formally lifted."

RESIDUAL RISK: VERY LOW with pre-commit hook in place.
```

---

### R-22 — OANDA Rate Limit During Startup Reconciliation

```
TITLE:        OANDA API returns 429 Too Many Requests during startup OANDA reconciliation
CATEGORY:     External API
PHASE:        Phase 2, Phase 6
PROBABILITY:  2 (Low) — Single GET /openTrades call; very unlikely to hit rate limit
IMPACT:       2 (Minor) — Reconciliation skipped for this startup; re-checked on next validation
SCORE:        4 (LOW)
OWNER:        Phase 2

DESCRIPTION:
  OANDA limits: 120 requests/second per access token.
  Startup makes 1 GET /openTrades call.
  index.js also makes OANDA calls (price fetches, order placement).
  Combined: still well under 120 req/s.
  
  Risk is only relevant if: multiple Railway instances start simultaneously (see R-15).

MITIGATION:
  On 429 response from OANDA: log WARNING + skip reconciliation (do not retry at startup).
  Next ValidationManager run (5 minutes later): retry reconciliation.
  oanda-client.js: handle 429 explicitly: throw RateLimitError (caught in Phase 6 gracefully).
```

---

### R-23 — knowledge_artifacts.value Column Approaching Practical Size Limit

```
TITLE:        Engine C dataset JSON exceeds 50MB — save() becomes slow
CATEGORY:     Performance
PHASE:        Phase 5 — future concern
PROBABILITY:  2 (Low) — At ~100,000 closed trades
IMPACT:       3 (Moderate) — 200ms+ save time; startup load slow
SCORE:        6 (MEDIUM)
OWNER:        Phase 5 — monitor and plan

DESCRIPTION:
  PostgreSQL can store JSONB up to 1GB per value.
  Practical performance limit: ~50MB (beyond that, serialization noticeably slow).
  At 100,000 closed trades: dataset = ~50MB.
  At current trading volume: ~100,000 trades ≈ 90–100 years (3–5 trades/day).
  Not an immediate concern but should be planned.

MITIGATION:
  Near-term (Phases 5-8): monitor byte_size column monthly.
  Long-term solution (if needed): chunked artifact storage.
    Each chunk: 1,000 examples → separate knowledge_artifacts row.
    load('engineC', 'dataset') → fetches all chunks → reassembles.
  
  Interim solution: limit KNN training set to last N examples (N=5,000 is typical).
    Older examples provide diminishing returns (market conditions change over years).
    This caps dataset size at ~2.5MB regardless of total trade count.
  
  Decision threshold: implement limit when byte_size > 2,500,000 (2.5MB).
```

---

### R-24 — trade_intents Grows Unbounded

```
TITLE:        trade_intents table accumulates CONFIRMED rows without cleanup
CATEGORY:     Storage
PHASE:        Phase 2
PROBABILITY:  3 (Medium) — If cleanupStale() only removes PENDING, CONFIRMED rows accumulate
IMPACT:       1 (Negligible) — Storage cost; query speed unaffected with proper indexes
SCORE:        3 (LOW)
OWNER:        Phase 2

MITIGATION:
  cleanupStale(maxAgeHours=24): deletes ALL rows older than 24 hours (regardless of status).
  Called on startup + daily cleanup job.
  Expected steady state: trade_intents has ≤48h of rows (2 days × 5 trades/day = 10 rows).
```

---

### R-25 — PostgreSQL Connection String Changes (Railway Managed DB Migration)

```
TITLE:        Railway changes DATABASE_URL (e.g., database migration, plan change)
CATEGORY:     Infrastructure
PHASE:        All phases
PROBABILITY:  1 (Very Low) — Only happens with explicit action
IMPACT:       5 (Critical) — All DB calls fail; service outage
SCORE:        5 (MEDIUM-LOW)
OWNER:        Operations

MITIGATION:
  Maintain a backup of the full schema DDL (telemetry/migrations/001_shadow_os_v2_schema.sql).
  After any DATABASE_URL change: run migration script immediately to recreate schema.
  Document: any Railway database migration MUST be performed during maintenance window.
  
  Note: knowledge_artifacts is a new table — if DATABASE_URL changes to a new DB,
  knowledge artifacts are NOT automatically migrated. They must be manually copied.
  Recovery: pg_dump knowledge_artifacts | psql <new_db>

CONTINGENCY:
  If knowledge_artifacts data is lost due to DB migration:
    System enters DEGRADED mode (knowledge artifacts missing).
    Engines rebuild from first principles over next ~50–100 closed trades.
    Full knowledge recovery: ~20–50 closed trades for Engine C; ~100 for Engine D.
```

---

### R-26 — Manager Module Circular Dependency

```
TITLE:        A Manager module requires another Manager module creating a circular dependency
CATEGORY:     Build / Runtime
PHASE:        Phases 1–7
PROBABILITY:  2 (Low) — Node.js module caching can handle most cycles; undefined exports cause bugs
IMPACT:       2 (Minor) — Undefined exports; difficult to debug
SCORE:        4 (LOW)
OWNER:        Architecture

MITIGATION:
  Define dependency order (no cycles allowed):
    db-adapter.js  → (no dependencies)
    index.js       → db-adapter.js
    state-manager  → db (from index.js)
    memory-manager → db
    knowledge-manager → db
    intent-manager → db, oanda-client.js
    validation-manager → db, state-manager, knowledge-manager, memory-manager, intent-manager
    recovery-manager → ALL managers
    snapshot-manager → db, state-manager
    engine-registry → all engines
    
  Rule: managers only require lower-level dependencies.
  No manager may require another manager of equal or higher level.
  recovery-manager is the top-level orchestrator — it may require all others.
  
  Before each sprint: review require() graph for new modules; confirm no cycles.
```

---

### R-27 — ValidationManager False Negative (Misses Real Issue)

```
TITLE:        A consistency check fails to detect a genuine inconsistency
CATEGORY:     Monitoring Quality
PHASE:        Phase 6
PROBABILITY:  2 (Low) — Checks may have edge case blind spots
IMPACT:       3 (Moderate) — Silent inconsistency accumulates; hard to debug later
SCORE:        6 (MEDIUM)
OWNER:        Phase 6

DESCRIPTION:
  Example: live_vs_oanda check queries OANDA but OANDA returns a cached response.
  Or: daily_counter_drift check counts events but misses events in the same DB transaction.
  Or: knowledge_checksums check verifies checksum but doesn't verify the value is loadable.
  
MITIGATION:
  Each check must be tested with an intentionally injected failure:
    Simulate the failure condition → verify check detects it → verify severity correct.
  
  For live_vs_oanda: test with manually inserted openTrade that isn't in OANDA.
  For daily_counter_drift: test with manually decremented live.dailyTrades.
  For knowledge_checksums: test with manually corrupted checksum value.
  
  All 12 checks require a corresponding negative test (test that failure is detected).
  Acceptance: 12/12 checks detect injected failures.
```

---

### R-28 — SnapshotManager Snapshot Too Large

```
TITLE:        System snapshot includes full dataset → snapshot is 50MB+ → slow to take and store
CATEGORY:     Performance
PHASE:        Phase 7
PROBABILITY:  1 (Very Low) — Only if snapshot includes knowledge artifact values
IMPACT:       2 (Minor) — Slow snapshot; system_snapshots table grows large
SCORE:        2 (LOW)
OWNER:        Phase 7

MITIGATION:
  Snapshot design: snapshots contain METADATA, not full data.
    Include: domain versions (not values), artifact versions (not values), memory counts, stats
    Exclude: full domain value JSON, full knowledge artifact JSON
  
  Snapshot size target: ≤50KB per snapshot.
  With 5-minute snapshots: ~288 snapshots/day × 50KB = 14MB/day (acceptable).
  
  Prune snapshots: keep last 7 days (7 × 14MB = 100MB steady state).
```

---

### R-29 — EnginePlugin.onRecovery() Throws and Blocks Phase 7

```
TITLE:        An engine plugin's onRecovery() method throws an uncaught exception,
              causing RecoveryManager Phase 7 to fail and system to enter HALTED state
CATEGORY:     Availability
PHASE:        Phase 7
PROBABILITY:  2 (Low) — Possible on first implementation of engine wrappers
IMPACT:       3 (Moderate) — System HALTED until exception is fixed and redeployed
SCORE:        6 (MEDIUM)
OWNER:        Phase 7

MITIGATION:
  engineRegistry.runRecovery() wraps every plugin call in try/catch:
    for (const engine of this._engines) {
      try {
        await withTimeout(engine.onRecovery(domains, knowledge, memory), 5000, engine.name);
        results.push({engine: engine.name, ok: true});
      } catch (e) {
        results.push({engine: engine.name, ok: false, error: e.message});
        console.error(`[REGISTRY] ${engine.name} onRecovery failed:`, e.message);
        // DO NOT rethrow — continue with other engines
        engine.onDegraded(e.message);  // notify engine it's degraded
      }
    }
  
  A single failing plugin = DEGRADED for that engine, not HALTED for the system.
  System enters HALTED only if both engines fail onRecovery.
```

---

### R-30 — Accidental DROP TABLE on Production Data

```
TITLE:        An engineer accidentally runs DROP TABLE on events, shadowm_trades, or knowledge_artifacts
CATEGORY:     Catastrophic Data Loss
PHASE:        All phases
PROBABILITY:  1 (Very Low) — Requires explicit destructive SQL command
IMPACT:       5 (Critical) — ALL historical knowledge and trading data permanently lost
SCORE:        5 (MEDIUM-LOW — LOW probability makes total risk manageable)
OWNER:        All phases — governance control

DESCRIPTION:
  The most catastrophic possible outcome: losing events or knowledge_artifacts.
  events: losing this means losing all historical trade records.
  knowledge_artifacts: losing this means losing all accumulated intelligence.
  shadowm_trades: losing this means losing all closed trade details used for analysis.

MITIGATION:
  Railway PostgreSQL: enable Point-in-Time Recovery (PITR) if available on plan.
  Railway PostgreSQL: daily backups automatic (verify in Railway dashboard).
  Manual backup: add backupDatabase() call to daily cleanup job.
  
  DDL policy: no engineer runs DROP, TRUNCATE, or DELETE without WHERE clause on production.
  Migration scripts: all use CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING.
  No migration script may contain DROP TABLE (except for the Phase 0 rollback procedure,
  which is explicitly labeled and only used when explicitly needed).
  
  OPERATIONS_RUNBOOK.md: "Before running any DDL on production: take a manual backup."
  
  Recovery from accidental drop:
    Railway PITR: restore to 1 second before the DROP (if PITR enabled).
    Railway daily backup: restore to previous day (max 24h of data loss).
    Manual backup: restore to last successful backupDatabase() run.
```

---

## Risk Closure Criteria

A risk is considered CLOSED when:

```
CLOSED = mitigation implemented + validated in production + monitoring in place

For phase-specific risks:
  Phase 0 risks: closed when Phase 0 gate criteria all pass
  Phase N risks: closed when Phase N gate criteria all pass

For architectural risks (R-10, R-15, R-16, R-21, R-30):
  Closed when: design rule documented + automated enforcement in place + team trained

Current open CRITICAL risks (score ≥15):
  R-01: Closed by Phase 3
  R-02: Closed by Phase 5
  R-04: Closed by Phase 1 (design rule + test)

Review schedule:
  Before each sprint: review all OPEN risks relevant to that sprint
  After each production incident: add new risk or update existing risk
  Monthly: review all risks; close resolved ones; re-score others
```

---

*This risk register is a living document.*  
*Add new risks as they are identified. Update scores as mitigations are implemented.*  
*The Golden Rule — no step may destroy accumulated knowledge — is the ultimate backstop for all risks.*
