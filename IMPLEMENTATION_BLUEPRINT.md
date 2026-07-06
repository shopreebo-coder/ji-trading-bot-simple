# SHADOW OS v2 — Implementation Blueprint
## FOREX ENGINE PRO · Complete Migration Program

**Classification:** Lead Implementation Architect Reference Document  
**Baseline Architecture:** SHADOW OS v2 (SHADOW_OS_V2.md)  
**Baseline Persistence:** Architecture B (SHADOW_OS_ARCHITECTURE_V1.md)  
**Date:** 2026-06-30  
**Status:** Pre-implementation — awaiting sprint authorization  

---

> **GOLDEN RULE — Non-negotiable. Governs every decision in this document:**
>
> *No deployment, restart, or migration step may destroy, corrupt, or make  
> permanently irrecoverable the accumulated trading knowledge of the system.*
>
> At every phase boundary, the system must be deployable to Railway and  
> operate correctly with zero knowledge loss. There are no exceptions.

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Section 0 — Current Architecture Audit](#section-0--current-architecture-audit)
- [Section 1 — Migration Philosophy and Constraints](#section-1--migration-philosophy-and-constraints)
- [Section 2 — Phase 0: Schema Foundation](#section-2--phase-0-schema-foundation)
- [Section 3 — Phase 1: StateManager + Runtime Domains](#section-3--phase-1-statemanager--runtime-domains)
- [Section 4 — Phase 2: IntentManager + Trade Safety](#section-4--phase-2-intentmanager--trade-safety)
- [Section 5 — Phase 3: Read Switchover](#section-5--phase-3-read-switchover)
- [Section 6 — Phase 4: MemoryManager](#section-6--phase-4-memorymanager)
- [Section 7 — Phase 5: KnowledgeManager + Learning Pipeline](#section-7--phase-5-knowledgemanager--learning-pipeline)
- [Section 8 — Phase 6: RecoveryManager + ValidationManager](#section-8--phase-6-recoverymanager--validationmanager)
- [Section 9 — Phase 7: SnapshotManager + Plugin Architecture](#section-9--phase-7-snapshotmanager--plugin-architecture)
- [Section 10 — Phase 8: Production Hardening + Cleanup](#section-10--phase-8-production-hardening--cleanup)
- [Section 11 — Testing Strategy](#section-11--testing-strategy)
- [Section 12 — Rollback Strategy](#section-12--rollback-strategy)
- [Section 13 — Success Metrics](#section-13--success-metrics)
- [Section 14 — Production Readiness Checklist](#section-14--production-readiness-checklist)

---

## Executive Summary

This document is the authoritative implementation guide for the migration from FOREX ENGINE PRO v40.1 to SHADOW OS v2. It translates the architectural designs in SHADOW_OS_V2.md and SHADOW_OS_ARCHITECTURE_V1.md into precise, phased, rollback-capable engineering tasks.

**What is being built:**
A four-layer operating system (Runtime, Memory, Knowledge, Event Log) with a Manager Tier API that mediates all data access. The system eliminates cold-start knowledge rebuilds, provides TTL-based contextual memory, versioned learned intelligence, and a 9-phase recovery sequence with automated consistency validation.

**Current state:** 7,439 lines of production JavaScript across 6 active modules. All state is in-memory. All modules call the database directly. Engine knowledge is rebuilt from scratch on every restart. A 10,000-trade system takes 10–18 seconds to restart.

**Target state:** O(1) startup at any scale (~150ms). Knowledge persists across any number of restarts. All database access mediated through the Manager Tier. Automated consistency validation every 5 minutes. Every failure scenario is identified, handled, and tested.

**Timeline:** 32 working days (6.5 weeks) across 8 phases + Sprint 0 audit.

**Risk level:** MEDIUM. The migration is non-destructive at every phase. index.js (the live bot) is FROZEN and never modified. Every phase is independently rollbackable. The Golden Rule is enforced by gate criteria at every phase boundary.

---

## Section 0 — Current Architecture Audit

### 0.1 Module Inventory

| File | Lines | Role | DB Calls | State Owned | Risk |
|------|-------|------|----------|-------------|------|
| `index.js` | 2,360 | Live bot — FROZEN | 0 | None (stdout) | FROZEN — no changes ever |
| `telemetry/server.js` | 2,997 | Orchestrator + HTTP API | ~42 | live.dailyTrades, live.openTrades | HIGH — monolith |
| `telemetry/shadowlab.js` | 1,094 | ShadowLab engines A/B/C/D | ~15 | _processedIds, shadowMode, KNN dataset, weights | HIGH — owns learning |
| `telemetry/shadowm.js` | 718 | Shadow M + Exit Lab | ~15 | _active, _knownSids, _lastId | MEDIUM |
| `telemetry/index.js` | 145 | Event log + EventEmitter | ~3 | None | LOW |
| `telemetry/db-adapter.js` | 125 | DB abstraction (PG/SQLite) | N/A | None | LOW |
| `dashboard.js` | 481 | Standalone dev tool | 0 | None | INACTIVE — dead code |
| `index_backup_*.js` (×3) | ~7,000 | Old bot backups | 0 | None | DEAD — archive |
| `telemetry/server_backup_*.js` (×1) | ~2,500 | Old server backup | 0 | None | DEAD — archive |
| `telemetry/shadowlab_backup_*.js` (×1) | ~800 | Old lab backup | 0 | None | DEAD — archive |
| **TOTAL ACTIVE** | **7,439** | | **~70** | | |

**Key finding about dashboard.js:** This is a completely standalone HTTP server (port 3001, spawns its own bot process) with embedded HTML. It is NOT required by or connected to `telemetry/server.js`. It appears to be a prior-generation dashboard. It should be archived, not migrated.

### 0.2 In-Memory State Inventory

Every variable that is in memory and lost on process death:

```
OWNER: telemetry/server.js
  live.dailyTrades    INTEGER  — count of trades opened today (UTC date)
  live.openTrades     OBJECT   — {symbol: {symbol, side, pips, peak, breakEven, entryTime, signalId}}
  live.botStatus      STRING   — 'running' | 'stopped'
  live.recentBlocks   ARRAY    — last 20 blocked signal lines (read-only, not critical)

OWNER: telemetry/shadowlab.js
  _shadowMode         STRING   — 'OBSERVE' | 'GATE'
  shadowLab._processedIds  SET — all signalIds that have completed the full pipeline
  ShadowKNNEngine.dataset  ARRAY — KNN training examples (rebuilt from shadowm_trades)
  ShadowMetaEngine._cond   OBJECT — condition weights (rebuilt from shadowm_trades)
  ShadowPositionAdvisor    OBJECT — in-flight position advice (per signalId)

OWNER: telemetry/shadowm.js
  shadowM._active     MAP    — signalId → tracking object (open trades only)
  shadowM._knownSids  SET    — all signalIds ever opened
  shadowM._lastId     INTEGER — highest events.id polled
  shadowM._polling    BOOLEAN — guard against concurrent poll ticks
  shadowM._pollCount  INTEGER — diagnostic counter (not critical)
```

### 0.3 Database Tables (current)

```
TABLE: events
  Columns: id BIGSERIAL PK, ts TEXT, bot_id TEXT, type TEXT, symbol TEXT, data JSONB
  Rows: grows ~12/min (12 polls × 1 event avg); ~17,000/day theoretical max
  Used by: server.js (read, ~35 analytics queries), shadowm.js (read cursor + write cursor events),
           shadowlab.js (read for _processedIds, analytics), index.js (write via logEvent)
  Critical event types: trade_open, trade_close, trade_state_snapshot, shadowm_cursor,
                        shadow_mode_change, lab_shadow_a/b/c/d, lab_comparison,
                        signal_detected, signal_filtered

TABLE: shadowm_trades
  Columns: id BIGSERIAL PK, signal_id TEXT UNIQUE, symbol, side, entry_time, exit_time,
           best_strategy, profit_live, profit_saved, mfe, mae, data JSONB
  Rows: 1 per closed trade (grows slowly, maybe 2–5/day)
  Used by: shadowm.js (read+write), shadowlab.js (read for KNN rebuild), server.js (read stats)

TABLE: shadowm_timeline
  Columns: id BIGSERIAL PK, signal_id TEXT, ts TEXT, pips, mfe, mae, minutes REAL
  Rows: ~10–20 per open trade (high frequency while trade is open)
  Used by: shadowm.js (write during trade lifecycle), shadowm.js getShadowMTimeline (read)
```

### 0.4 HTTP API Inventory

server.js exposes **51 HTTP endpoints** (50 GET, 1 POST):

```
CATEGORY A: Live State (6 endpoints) — must remain fast (<50ms)
  GET  /api/live           → live.openTrades + dailyTrades + botStatus
  GET  /api/today          → today's trade summary
  GET  /api/stats          → system stats (event counts, DB status)
  GET  /api/symbols        → tracked symbol list
  GET  /api/events/stream  → SSE live event stream
  POST /api/shadow/mode    → set OBSERVE/GATE mode

CATEGORY B: Analytics (35 endpoints) — heavy DB reads, OK to be slow (200–2000ms)
  GET /api/trades, /api/events, /api/export, /api/exit-manager, ...
  All query events table with LIMIT (safe at any size)
  NO state mutations — read-only

CATEGORY C: Shadow Lab (9 endpoints) — moderate DB reads
  GET /api/lab/overview, /api/lab/shadow-a, /api/lab/shadow-b, ...
  GET /api/shadow/status → includes live.openTrades, getShadowMode()

CATEGORY D: System (1 endpoint)
  GET /api/shadow/status → full system health including state + OANDA cursor info
```

**Key insight:** Only Category A endpoints interact with live state. Category B/C/D are analytics (read-only event table queries). The migration needs to protect Category A. Category B/C/D require no changes during Phases 0–5.

### 0.5 Scheduled Tasks

```
TASK 1: server.js SSE keepalive
  setInterval(() => res.write(": ka\n\n"), 25000)
  Per SSE client connection. Non-critical.

TASK 2: shadowm.js Shadow M polling
  setInterval(() => shadowM._poll(), 5000)
  Started: shadowM.start() called at server startup
  Writes: shadowm_trades (UPSERT), events (shadowm_cursor)
  Reads: events WHERE id > _lastId

TASK 3: shadowlab.js ShadowLab cycle
  setInterval(() => shadowLab._cycle(), 30000) [inferred from code]
  Reads: events, shadowm_trades (for KNN rebuild)
  Writes: events (lab_shadow_a/b/c/d, lab_comparison)
```

### 0.6 External API Dependencies

```
DEPENDENCY: OANDA REST API
  Called by: index.js ONLY (FROZEN)
  Calls:
    GET  /v3/accounts/{id}/pricing           — price data
    GET  /v3/accounts/{id}/instruments       — ATR data
    GET  /v3/accounts/{id}/summary           — account info
    GET  /v3/accounts/{id}/openTrades        — open positions
    POST /v3/accounts/{id}/orders            — place market order
    PUT  /v3/accounts/{id}/trades/{id}/orders — modify SL
  Authentication: Bearer token via OANDA_API_KEY env var
  Env vars: OANDA_API_KEY, OANDA_ACCOUNT_ID, OANDA_ENV (live/practice)

DEPENDENCY: PostgreSQL (Railway managed)
  Connected by: db-adapter.js
  Pool: max 10 connections, 5s connect timeout, 30s idle timeout
  Env var: DATABASE_URL

DEPENDENCY: None in telemetry/* (no direct OANDA calls)
  server.js does NOT call OANDA directly.
  All OANDA calls are in index.js (FROZEN).
  OANDA reconciliation on startup must use a NEW dedicated client.
```

### 0.7 Dependency Graph

```
                           EXTERNAL
                         ┌──────────┐
                         │  OANDA   │
                         │  REST    │
                         └────┬─────┘
                              │ axios
                         ┌────▼─────┐
         stdout parse    │ index.js │  ← FROZEN — never modify
         ┌───────────────┤  (bot)   │
         │               └──────────┘
         │
         ▼
┌──────────────────┐      ┌──────────────┐      ┌──────────────────┐
│  telemetry/      │◄─────│  telemetry/  │      │  telemetry/      │
│  server.js       │      │  shadowm.js  │      │  shadowlab.js    │
│  (orchestrator)  │      └──────┬───────┘      └────────┬─────────┘
└──────┬───────────┘             │                       │
       │                         │                       │
       │  requires               │ requires              │ requires
       └──────────────┐          │                       │
                      ▼          ▼                       ▼
               ┌──────────────────────────────────────────────┐
               │              telemetry/index.js               │
               │  (logEvent, db, emitter, getDbStats, ...)     │
               └──────────────────┬───────────────────────────┘
                                  │ requires
                                  ▼
                         ┌────────────────┐
                         │ telemetry/     │
                         │ db-adapter.js  │
                         │ (PG or SQLite) │
                         └────────┬───────┘
                                  │
                                  ▼
                         ┌────────────────┐
                         │  PostgreSQL    │
                         │  (Railway)     │
                         └────────────────┘
```

### 0.8 State Mutation Flow (current)

```
TRADE LIFECYCLE:
  1. index.js detects signal → evaluates conditions → calls shadowGate()
  2. shadowGate() → returns {blocked, reason} based on shadowMode + Engine C/D
  3. If not blocked:
     a. index.js calls OANDA → trade opens
     b. index.js logs to stdout: "trade=EUR_USD side=buy signal=ABC ..."
     c. index.js calls logEvent({type:'trade_open', ...}) [async, fire-and-forget]
  4. server.js parses stdout → handleBotLine() → live.openTrades[sym] = {...}
  5. shadowm.js receives trade_open event in next _poll() → updates _active, shadowm_trades
  6. trade_close:
     a. index.js detects close (P&L threshold) → calls logEvent({type:'trade_close'})
     b. server.js receives trade_close via emitter → delete live.openTrades[sym]
     c. shadowm.js next _poll() → _onClose() → updates shadowm_trades.exit_time

SIGNAL EVALUATION:
  1. index.js generates signal → calls shadowGate(signal) [SYNC]
  2. shadowGate reads _shadowMode (module var) + calls Engine C/D in-memory
  3. Returns {blocked: true/false} synchronously
  4. ShadowLab._cycle() runs async (every 30s): updates Engine C/D, logs lab events

STATE RESTORE (current, on process restart):
  1. restoreLiveState():
     SELECT COUNT trade_open events for today → live.dailyTrades
     Scan trade_open events, build live.openTrades (excludes closed)
  2. shadowM._restore():
     SELECT shadowm_trades → _active, _knownSids
     SELECT latest shadowm_cursor event → _lastId
  3. shadowLab._init():
     SELECT trade_close events → _processedIds
     SELECT latest shadow_mode_change → _shadowMode
  4. ShadowLab._cycle() first run: rebuilds KNN dataset from shadowm_trades (SLOW at scale)
```

### 0.9 Critical Findings and Migration Risks

```
FINDING 1: server.js is a 2,997-line monolith
  Contains: process management, HTTP API (51 endpoints), live state, analytics queries
  Risk: High blast radius for changes
  Mitigation: Extract state management only; leave HTTP routes untouched

FINDING 2: 35+ analytics DB queries in server.js are NOT state management
  These query events table for dashboards (read-only)
  They do NOT need migration to StateManager
  They remain as-is: direct db.all() calls are fine for analytics

FINDING 3: ShadowKNNEngine and ShadowMetaEngine have NO persistence today
  _buildDataset() and weight computation are called from _cycle() and rebuild from scratch
  This is the highest-impact migration target (SIM-10: 10,000 trades = 18s startup)

FINDING 4: dashboard.js is dead code
  It is a standalone dev tool. It is not connected to server.js.
  Action: Archive to /archive/ before migration begins. Not migrated.

FINDING 5: 5 backup files are dead code (~11,000 lines total)
  Action: Archive to /archive/ before migration begins. Remove from active directory.

FINDING 6: index.js calls OANDA directly; telemetry/* has no OANDA client
  RecoveryManager needs a new minimal OANDA client for reconciliation
  This client must only call GET /openTrades (no trade execution)

FINDING 7: shadowGate() is SYNCHRONOUS by design (fail-safe)
  shadowGate() must remain synchronous throughout the migration
  KnowledgeManager.load() must provide synchronous access to cached artifacts

FINDING 8: db-adapter.js already provides an excellent abstraction layer
  The Manager Tier will use db._pool (PostgreSQL) or db._raw (SQLite) internally
  Or use the existing db.run/all/get interface — it already handles both backends
```

---

## Section 1 — Migration Philosophy and Constraints

### 1.1 The Three Non-Negotiable Rules

```
RULE 1: KNOWLEDGE PRESERVATION
  No phase may delete, truncate, or make irrecoverable any row in:
    events, shadowm_trades, shadowm_timeline, knowledge_artifacts, memory_entries
  All new tables are additive. All schema changes add columns or tables.
  DROP TABLE is forbidden until the post-production cleanup phase.

RULE 2: GOLDEN DEPLOYMENT WINDOW
  After each phase, the system must be deployable to Railway and operate correctly.
  "Correctly" means: trades execute, state is correct, no console ERRORs.
  A phase is COMPLETE only when it has been deployed to Railway and verified.

RULE 3: FROZEN BOT
  index.js (the live trading bot) is never modified.
  Any changes needed from the bot side are implemented via the stdout-parse layer in server.js.
  This is non-negotiable. The bot is the revenue engine.
```

### 1.2 Migration Approach: Layered Introduction

```
PRINCIPLE: Add before you remove.

For each new capability:
  Step A: Build the new module (StateManager, MemoryManager, etc.)
  Step B: Enable dual-write: write to BOTH old path AND new path
  Step C: Validate: confirm new path produces same results as old path
  Step D: Switch: reads now come from new path (old path still written)
  Step E: Validate: monitor for 48–72 hours in production
  Step F: Retire: remove old path (only after validation)

This means at any point, reverting is as simple as disabling one flag or reverting one commit.
```

### 1.3 Phase Summary

```
PHASE 0  Schema Foundation      1 day     Zero risk. Schema additions only. No behavior change.
PHASE 1  StateManager           3 days    Low risk. Dual-write mode. Old path remains active.
PHASE 2  IntentManager          3 days    Low risk. Ghost trade protection. Additive only.
PHASE 3  Read Switchover        1 day     Medium risk. Startup reads from runtime_domains.
PHASE 4  MemoryManager          3 days    Low risk. Additive. Cooldowns survive restart.
PHASE 5  KnowledgeManager       4 days    Medium risk. Engine artifacts migrate.
PHASE 6  RecoveryManager        4 days    High care. Replaces startup sequence.
PHASE 7  SnapshotManager        2 days    Low risk. Additive capability.
PHASE 8  Hardening + Cleanup    3 days    Low risk. Dead code removal, monitoring.
─────────────────────────────────────────────────────────────────
TOTAL                           24 days   (Core implementation)
+ Sprint 0 (Audit + Setup)       3 days
+ Sprint 7 (Production)          5 days
= 32 DAYS TOTAL
```

---

## Section 2 — Phase 0: Schema Foundation

### 2.1 Goal

Add all new database tables required by SHADOW OS v2. **No behavior changes.** No code changes to existing modules. The system operates identically after this phase, but the schema is ready.

### 2.2 Dependencies

- PostgreSQL connection via DATABASE_URL must be working
- Current events, shadowm_trades, shadowm_timeline tables must be healthy

### 2.3 What to Create

**File:** `telemetry/migrations/001_shadow_os_v2_schema.sql`

Seven new tables, all additive:
1. `runtime_domains` — Runtime Layer (replaces single-blob runtime_state concept)
2. `memory_entries` — Memory Layer (TTL-based contextual memory)
3. `knowledge_artifacts` — Knowledge Layer (versioned learned intelligence)
4. `trade_intents` — Exactly-once trade protection
5. `event_idempotency` — Duplicate event prevention
6. `consistency_log` — Validation history
7. `system_snapshots` — Periodic runtime snapshots

Full DDL is in SHADOW_OS_V2.md Appendix A. The migration script must be **idempotent** (CREATE TABLE IF NOT EXISTS on every table, ON CONFLICT DO NOTHING on bootstrap inserts).

**File:** `telemetry/migrations/run.js`

A standalone script that:
1. Connects to PostgreSQL using DATABASE_URL
2. Runs 001_shadow_os_v2_schema.sql
3. Verifies each table was created
4. Logs result and exits
5. Is safe to run multiple times (idempotent)

### 2.4 Bootstrap Data

After creating tables, bootstrap runtime_domains with 10 empty domain rows (live, shadowA–D, shadowM, exitLab, telemetry, scheduler, meta). Use ON CONFLICT DO NOTHING — safe to run on an existing database.

### 2.5 Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Migration script fails (DB unreachable) | Low | Retry logic in run.js; pre-check DB connectivity |
| Existing table name collision | Very Low | IF NOT EXISTS everywhere; no existing tables are touched |
| ON CONFLICT DO NOTHING fails on bootstrap | None | Standard PostgreSQL syntax |
| Schema deployed to production, old code runs | Intended | Old code ignores new tables entirely |

### 2.6 Testing

- Run `node telemetry/migrations/run.js` locally against heliumdb
- Verify: `SELECT table_name FROM information_schema.tables WHERE table_schema='public'` shows all 10 tables
- Verify: `SELECT domain FROM runtime_domains` returns 10 rows
- Deploy to Railway: verify Railway startup log shows no DB errors
- Run `node telemetry/migrations/run.js` a second time: verify no errors (idempotency test)

### 2.7 Rollback

Simply DROP the 7 new tables. Existing tables (events, shadowm_trades, shadowm_timeline) are untouched. The system returns to v40.1 state completely.

```sql
DROP TABLE IF EXISTS system_snapshots;
DROP TABLE IF EXISTS consistency_log;
DROP TABLE IF EXISTS event_idempotency;
DROP TABLE IF EXISTS trade_intents;
DROP TABLE IF EXISTS knowledge_artifacts;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS runtime_domains;
```

### 2.8 Duration and Complexity

- Duration: 1 day
- Complexity: LOW
- Priority: P0 — all subsequent phases depend on this

### 2.9 Phase 0 Exit Criteria

```
[ ] All 7 new tables exist in PostgreSQL
[ ] 10 runtime_domains rows present (bootstrap)
[ ] Migration script is idempotent (run twice, second run: no errors, no duplicates)
[ ] Existing system behavior unchanged (no errors in Railway logs post-deploy)
[ ] Old tables (events, shadowm_trades, shadowm_timeline) are untouched
[ ] run.js script committed and documented
```

---

## Section 3 — Phase 1: StateManager + Runtime Domains

### 3.1 Goal

Create the `StateManager` module. Begin writing every live state mutation to `runtime_domains` IN ADDITION to the existing in-memory path (dual-write). Reads still come from the old path. This phase makes the new path ready but does not rely on it yet.

### 3.2 What to Build

**New file:** `telemetry/managers/state-manager.js`

Required methods (full specification in SHADOW_OS_V2.md Appendix B):
```
loadDomain(domain)            → Promise<DomainState | null>
loadAll()                     → Promise<Record<string, DomainState>>
saveDomain(domain, value, expectedVersion) → Promise<SaveResult>
saveDomainRetry(domain, transform, maxRetries=3) → Promise<SaveResult>
flush()                       → Promise<void>
migrateIfNeeded()             → Promise<migrations[]>
getCached(domain)             → DomainState | null  (synchronous, from in-memory cache)
```

**Implementation requirements:**
- Uses `db` from `./index` (the existing db-adapter interface)
- Maintains an in-memory cache of all loaded domains (avoids redundant DB reads)
- `saveDomainRetry`: loads current, applies transform, writes with expectedVersion; retries up to maxRetries on version conflict
- All methods log errors to console but never throw (return {ok: false} on failure)
- Exported as a singleton: `const stateManager = new StateManager(db)`

**Modifications to server.js:**
```
At top of file:
  const { stateManager } = require('./managers/state-manager');

In restoreLiveState(), after restoring in-memory state:
  // PHASE 1: dual-write — persist restored state to runtime_domains
  stateManager.saveDomainRetry('live', _ => ({
    dailyTrades: live.dailyTrades,
    openTrades: live.openTrades,
    date: today,
    sequence: 0
  })).catch(err => console.warn('[STATE-MANAGER] dual-write failed:', err.message));

After every mutation to live.dailyTrades or live.openTrades:
  stateManager.saveDomainRetry('live', current => ({
    ...current,
    dailyTrades: live.dailyTrades,
    openTrades: live.openTrades
  })).catch(err => console.warn('[STATE-MANAGER] live update failed:', err.message));
  // NOTE: fire-and-forget — never await in hot path (handleBotLine is sync)
```

**Mutations to instrument in server.js:**
```
handleBotLine() touches live state at these points:
  Line ~135: live.openTrades[sym].pips = ...     → fire stateManager save
  Line ~144: live.openTrades[sym].peak = ...     → fire stateManager save (batched with pips)
  Line ~152: live.openTrades[sym] = {...}         → CRITICAL: trade opened
  Line ~161: live.openTrades[sym].breakEven = true → fire stateManager save
  Line ~168: live.dailyTrades = parseInt(dtM[1]) → CRITICAL: counter update
  Line ~189: delete live.openTrades[sym]          → CRITICAL: trade closed

  Only the 3 CRITICAL lines require immediate saves (no debounce).
  Others may be batched with 100ms debounce to avoid per-tick DB writes.
```

**Modifications to shadowm.js:**
```
After every _onOpen(), _onSnapshot(), _onClose():
  stateManager.saveDomainRetry('shadowM', current => ({
    ...current,
    lastId: this._lastId,
    active: Object.fromEntries(this._active),
    knownSids: [...this._knownSids],
    pollCount: this._pollCount,
    lastPollTs: new Date().toISOString()
  })).catch(e => {}); // fire-and-forget
```

**Modifications to shadowlab.js:**
```
After _init() completes:
  stateManager.saveDomainRetry('shadowlab', _ => ({
    processedIds: [...shadowLab._processedIds],
    mode: _shadowMode
  })).catch(e => {});

After each _cycle() that changes _processedIds:
  stateManager.saveDomainRetry('shadowlab', _ => ({...})).catch(e => {});
```

### 3.3 Validation (Phase 1 specific)

Add a startup comparison log in restoreLiveState():
```javascript
// PHASE 1 VALIDATION: compare event-replay result with runtime_domains
const dbState = await stateManager.loadDomain('live');
if (dbState) {
  const drift = [];
  if (dbState.value.dailyTrades !== live.dailyTrades)
    drift.push(`dailyTrades: db=${dbState.value.dailyTrades} mem=${live.dailyTrades}`);
  const dbKeys = Object.keys(dbState.value.openTrades || {}).sort().join(',');
  const memKeys = Object.keys(live.openTrades).sort().join(',');
  if (dbKeys !== memKeys) drift.push(`openTrades keys: db=${dbKeys} mem=${memKeys}`);
  if (drift.length > 0) console.warn('[STATE DRIFT]', drift.join(' | '));
  else console.log('[STATE MANAGER] Phase 1 validation: CLEAN — runtime_domains matches event-replay');
}
```

This log is the primary success indicator for Phase 1. Zero STATE DRIFT logs = ready for Phase 3.

### 3.4 Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| saveDomainRetry blocks hot path (handleBotLine) | Medium | Latency | Always fire-and-forget; never await in hot path |
| Frequent version conflicts (tick-level pips updates) | Medium | Log noise | Batch non-critical updates with 100ms debounce |
| [STATE DRIFT] log appears at startup | Low-Medium | Indicates bug | Root cause and fix before proceeding to Phase 3 |
| stateManager.js has bug, crashes server.js | Low | SERVICE DOWN | Module must catch all errors; never propagate |

### 3.5 Rollback

Remove all `stateManager.*` calls added in this phase. StateManager module can remain in the codebase but goes unused. `runtime_domains` table retains whatever was written (harmless).

### 3.6 Duration: 3 days | Complexity: MEDIUM | Priority: P1

### 3.7 Phase 1 Exit Criteria

```
[ ] stateManager.js exists and passes module-level unit tests (≥10 tests)
[ ] [STATE DRIFT] logs: 0 occurrences over 48h in production
[ ] runtime_domains.live.version increments correctly on each trade event
[ ] runtime_domains.shadowM.lastId tracks shadowm._lastId correctly
[ ] After Railway restart: runtime_domains rows match event-replay result (verified manually)
[ ] No new errors in Railway logs attributable to Phase 1 changes
[ ] stateManager.flush() tested: correctly commits all pending mutations
```

---

## Section 4 — Phase 2: IntentManager + Trade Safety

### 4.1 Goal

Create the `IntentManager` module. Add the `trade_intents` table to the trade lifecycle. Add OANDA position reconciliation on startup. Close **Seam 3** (ghost trade from crash between OANDA fill and DB commit) permanently.

### 4.2 What to Build

**New file:** `telemetry/managers/intent-manager.js`

Required methods:
```
writeIntent(signalId, type, symbol, side, payload) → Promise<TradeIntent>
confirmIntent(signalId, oandaOrderId)               → Promise<void>
failIntent(signalId, reason)                        → Promise<void>
getPendingIntents()                                 → Promise<TradeIntent[]>
reconcileWithOanda(baseUrl, token, accountId, live) → Promise<ReconciliationAction[]>
cleanupStale(maxAgeHours=0.083)                    → Promise<number>  // 5 min
```

**New file:** `telemetry/oanda-client.js`

A minimal read-only OANDA client for reconciliation:
```
getOpenTrades(baseUrl, token, accountId) → Promise<OandaPosition[]>
getOrder(baseUrl, token, accountId, orderId) → Promise<OandaOrder | null>
```

Uses axios (already in package.json). Read-only — never calls POST or PUT.

**Modification to server.js (emitter-based, not inside index.js):**

The emitter in `telemetry/index.js` fires events when logEvent() writes specific types. server.js already listens to these via `emitter.on(...)`.

When the `trade_open` event is received (emitter fires after logEvent):
```javascript
emitter.on('trade_open', async (data) => {
  // PHASE 2: write intent (retroactive — after the fact, since index.js already called OANDA)
  // This is "confirm-without-prior-intent" — intent and confirm in the same handler.
  // Full intent-before-action requires index.js modification (FROZEN).
  // Retroactive pattern closes Seam 3 via OANDA reconciliation on startup.
  await intentManager.writeIntent(data.signalId, 'OPEN', data.symbol, data.side, data);
  await intentManager.confirmIntent(data.signalId, data.oandaOrderId || data.signalId);
});

emitter.on('trade_close', async (data) => {
  await intentManager.writeIntent(data.signalId, 'CLOSE', data.symbol, null, data);
  await intentManager.confirmIntent(data.signalId, data.signalId);
});
```

**Modification to restoreLiveState() in server.js:**
```javascript
// PHASE 2: After loading live state, reconcile with OANDA
const pendingIntents = await intentManager.getPendingIntents();
if (pendingIntents.length > 0) {
  console.log(`[INTENT] ${pendingIntents.length} PENDING intent(s) found — reconciling with OANDA`);
  const actions = await intentManager.reconcileWithOanda(
    process.env.OANDA_BASE_URL, process.env.OANDA_API_KEY,
    process.env.OANDA_ACCOUNT_ID, live
  );
  for (const action of actions) {
    console.log(`[INTENT RECONCILE] ${action.signalId}: ${action.action} — ${action.detail}`);
    if (action.action === 'CONFIRMED') {
      // Add to live.openTrades if not already there
      if (!live.openTrades[action.symbol]) {
        live.openTrades[action.symbol] = action.resolvedState;
      }
    }
  }
}
```

### 4.3 Note on Limitation

Since index.js is FROZEN, we cannot write the intent BEFORE the OANDA call. The intent is written retroactively (confirmed immediately after trade_open event). This means:

**Crash scenario:** OANDA fills the trade → process crashes → trade_open event never fires → intent never written → on restart, reconcile finds OANDA position but no intent.

**Resolution:** OANDA reconciliation on startup (Phase 2 OANDA client) catches this. Any OANDA position not in `live.openTrades` is flagged and resolved according to `RECONCILE_POLICY`.

This is documented as a **known limitation** — partial Seam 3 closure without index.js modification.

### 4.4 Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OANDA API key not available in server.js environment | Medium | Reconciliation skipped | Check env vars at startup; log WARNING if missing; skip gracefully |
| OANDA rate limit hit during reconciliation | Low | Startup delayed | Single GET /openTrades call only; no retry loop |
| trade_intents table rows accumulate indefinitely | Low | Performance | cleanupStale() called on startup: removes rows >5 min old that are not PENDING |

### 4.5 Duration: 3 days | Complexity: MEDIUM | Priority: P1

### 4.6 Phase 2 Exit Criteria

```
[ ] intentManager.js exists and passes ≥8 unit tests
[ ] oanda-client.js (read-only) exists and is tested with mock OANDA responses
[ ] trade_intents row created for every trade_open event (verify in production over 48h)
[ ] trade_intents row CONFIRMED for every trade_close event
[ ] OANDA reconciliation: simulated test (mock PENDING intent + mock OANDA GET response)
[ ] cleanupStale() tested: removes 5-min+ PENDING intents
[ ] No new errors in Railway logs attributable to Phase 2 changes
[ ] OANDA_BASE_URL added to Railway environment variables
```

---

## Section 5 — Phase 3: Read Switchover

### 5.1 Goal

Startup now reads state from `runtime_domains` FIRST. Event-replay falls back only if `runtime_domains` is missing, stale (wrong date), or corrupted. Remove the [STATE DRIFT] validation logs (they confirmed Phase 1 was working). Achieve startup time ≤200ms.

### 5.2 What to Change

**Modification to server.js — restoreLiveState():**
```javascript
async function restoreLiveState() {
  const today = new Date().toISOString().slice(0, 10);

  // PHASE 3: Read from runtime_domains first
  const rs = await stateManager.loadDomain('live');
  if (rs && rs.value.date === today && rs.version > 0) {
    live.dailyTrades = rs.value.dailyTrades;
    live.openTrades  = rs.value.openTrades;
    console.log(`[SERVER] State loaded from runtime_domains v${rs.version}: `
      + `dailyTrades=${live.dailyTrades} openTrades=${Object.keys(live.openTrades).length}`);
    return;  // EXIT: no event-replay needed
  }

  // FALLBACK: event-replay (existing code — PRESERVED, do not delete yet)
  console.log(`[SERVER] runtime_domains stale/missing (${rs?.value?.date ?? 'none'}) `
    + `— falling back to event replay (Phase 3 fallback)`);
  // ... existing restoreLiveState() code ...
  // After replay, persist to runtime_domains:
  await stateManager.saveDomainRetry('live', _ => ({
    dailyTrades: live.dailyTrades,
    openTrades:  live.openTrades,
    date:        today
  }));
}
```

**Modification to shadowm.js — _restore():**
```javascript
async _restore() {
  const rs = await stateManager.loadDomain('shadowM');
  if (rs && rs.version > 0) {
    this._active    = new Map(Object.entries(rs.value.active || {}));
    this._knownSids = new Set(rs.value.knownSids || []);
    this._lastId    = typeof rs.value.lastId === 'number' ? rs.value.lastId : 0;
    console.log(`[SHADOW M] State loaded from runtime_domains: `
      + `active=${this._active.size} lastId=${this._lastId}`);
    return;
  }
  // FALLBACK: existing _restore() code (preserved)
  // ...
}
```

### 5.3 Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| runtime_domains.live.date is yesterday (midnight UTC crossover) | Medium | Falls back to replay | Date check handles this correctly |
| runtime_domains.shadowM stale by 1 poll cycle | Low | Shadow M replays 5s of events | Acceptable — idempotent replay |
| version > 0 check fails (domain was never written) | Low | Falls back to replay | Correct behavior |

### 5.4 Duration: 1 day | Complexity: LOW | Priority: P1

### 5.5 Phase 3 Exit Criteria

```
[ ] Startup log shows "State loaded from runtime_domains" for all domains (not fallback)
[ ] Startup time measured ≤200ms (without OANDA reconciliation)
[ ] After Railway restart: state correct (live.openTrades matches actual open positions)
[ ] After midnight UTC: dailyTrades resets to 0 (date check triggers fallback correctly)
[ ] [STATE DRIFT] validation logs removed from codebase
[ ] Event-replay fallback code PRESERVED (do not delete until Phase 8)
[ ] 48h monitoring: no state inconsistencies detected
```

---

## Section 6 — Phase 4: MemoryManager

### 6.1 Goal

Create the `MemoryManager` module and `memory_entries` table. Migrate cooldown state and market context into the Memory Layer. Cooldowns now survive process restarts naturally.

### 6.2 What to Build

**New file:** `telemetry/managers/memory-manager.js`

Required methods (from SHADOW_OS_V2.md Section 7.3):
```
set(namespace, key, value, opts)     → Promise<void>
get(namespace, key)                  → Promise<object | null>
getAll(namespace)                    → Promise<Record<string, object>>
getByTags(namespace, tags)           → Promise<Record<string, object>>
delete(namespace, key)               → Promise<void>
touch(namespace, key, newTtlMs)      → Promise<void>
expire(namespace, key)               → Promise<void>
gc()                                 → Promise<{deleted, namespaces}>
scheduleGC(intervalMs)               → void
stats()                              → Promise<{totalEntries, expiredEntries, namespaces}>
```

**Namespaces to implement (in order of value):**

| Namespace | Migration source | TTL | Value |
|-----------|-----------------|-----|-------|
| `cooldowns` | Currently in-memory (lost on restart) | Per signal (30-120 min) | HIGH — prevents re-entry too soon |
| `market_state` | Currently rebuilt each cycle | 4h (refreshed) | MEDIUM — saves OANDA calls |
| `decision_history` | Currently in events table (slow query) | 7d | MEDIUM — improves Engine D |
| `observations` | Not currently stored | 48h | MEDIUM — Exit Lab context |
| `confidence_decay` | Not currently tracked | 30d | LOW — monitoring only |

**Phase 4 scope:** Implement only `cooldowns` namespace. Other namespaces are additive and can be added in Phase 5 or later without deployment risk.

**Integration in server.js:**

When a signal is blocked due to cooldown (server.js parses stdout lines starting with "COOLDOWN"):
```javascript
// PHASE 4: persist cooldown to MemoryManager
const ttlMs = computeCooldownTtl(reason);  // 30–120 min depending on reason
await memoryManager.set('cooldowns', `cd:${symbol}:${session}`, {
  symbol, session, reason, triggeredAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + ttlMs).toISOString()
}, { ttlMs });
```

At startup, after restoreLiveState():
```javascript
// PHASE 4: load active cooldowns from Memory Layer
const activeCooldowns = await memoryManager.getAll('cooldowns');
console.log(`[MEMORY] Loaded ${Object.keys(activeCooldowns).length} active cooldowns`);
// Note: cooldowns are consumed by index.js internally — this is for telemetry/monitoring only
// The actual cooldown enforcement in index.js does not read from MemoryManager
// (it manages its own internal cooldown state which is NOT restored today)
// Phase 4 establishes the pattern; Phase 6 would connect it to bot cooldown restoration
```

**Limitation:** index.js manages its own internal cooldown state and is FROZEN. We cannot make index.js read from MemoryManager. Phase 4 stores cooldowns as an observation layer — they survive restart for monitoring purposes but do not currently restore the bot's internal cooldown state.

This is noted as a **known limitation** and tracked in the Risk Register. The value is in: (a) establishing the pattern, (b) monitoring, (c) future cooldown state injection through the stdout channel.

### 6.3 GC Scheduling

```javascript
// In server.js startup (after restoreLiveState):
memoryManager.scheduleGC(3600000); // GC every 60 minutes
// First GC run at startup to clear any expired entries from previous sessions
const gcResult = await memoryManager.gc();
console.log(`[MEMORY GC] Startup: deleted ${gcResult.deleted} expired entries`);
```

### 6.4 Duration: 3 days | Complexity: MEDIUM | Priority: P2

### 6.5 Phase 4 Exit Criteria

```
[ ] memoryManager.js exists and passes ≥10 unit tests
[ ] Cooldown events observed in memory_entries table during live trading
[ ] GC correctly deletes expired entries (tested with a short TTL entry)
[ ] memory_entries count stays bounded (< 1000 entries after 1 week)
[ ] get() returns null for expired entries (unit tested)
[ ] scheduleGC() running correctly (verified via stats() endpoint)
[ ] No new errors in Railway logs
```

---

## Section 7 — Phase 5: KnowledgeManager + Learning Pipeline

### 7.1 Goal

Create the `KnowledgeManager` module. Migrate Engine C (KNN dataset) and Engine D (meta-weights) to the Knowledge Layer. **This is the highest-impact migration target** — after this phase, startup at 10,000 trades goes from 18 seconds to ~150ms.

### 7.2 What to Build

**New file:** `telemetry/managers/knowledge-manager.js`

Required methods (from SHADOW_OS_V2.md Section 7.4):
```
load(domain, artifact)                          → Promise<KnowledgeArtifact | null>
save(domain, artifact, value, opts)             → Promise<KnowledgeArtifact>
loadHistory(domain, artifact, limit=10)         → Promise<KnowledgeArtifact[]>
rollback(domain, artifact, toVersion)           → Promise<KnowledgeArtifact>
migrate(domain, artifact, migrationFn, notes)   → Promise<KnowledgeArtifact>
verifyAll()                                     → Promise<VerificationResult[]>
confidence(domain, artifact)                    → Promise<number | null>
prune(keepDays=90)                              → Promise<{deleted}>
```

**Checksum implementation:**
```javascript
const crypto = require('crypto');
function computeChecksum(value) {
  const canonical = JSON.stringify(value, Object.keys(value).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
```

**Critical: synchronous cache for shadowGate()**

shadowGate() is SYNCHRONOUS. It calls Engine C and D in-memory. KnowledgeManager must provide synchronous access to already-loaded artifacts:

```javascript
class KnowledgeManager {
  constructor(db) {
    this._cache = new Map();  // 'engineC:dataset' → KnowledgeArtifact
  }

  // Synchronous — returns null if not yet loaded; used by shadowGate()
  getCached(domain, artifact) {
    return this._cache.get(`${domain}:${artifact}`) ?? null;
  }

  // Async — loads from DB and populates cache
  async load(domain, artifact) {
    // ... DB query ...
    this._cache.set(`${domain}:${artifact}`, artifact);
    return artifact;
  }
}
```

### 7.3 Engine C Migration

**Modification to shadowlab.js — ShadowKNNEngine:**

```
CURRENT BEHAVIOR:
  _cycle() → _refreshDatasetAsync() → SELECT * FROM shadowm_trades (ALL rows, N×) → builds dataset

NEW BEHAVIOR:
  Startup:
    knowledgeManager.load('engineC', 'dataset')
    → artifact found: dataset = artifact.value.examples  ← O(1)
    → artifact not found: dataset = []  ← first run, will populate as trades close

  After each trade closes (in _cycle()):
    1. Build feature vector for the new closed trade
    2. dataset.push(newExample)  ← in-memory
    3. if (newExamplesCount % 10 === 0):
       knowledgeManager.save('engineC', 'dataset', {examples: dataset, version: artifact.version+1})
    → knowledge artifact updated incrementally

  The full shadowm_trades scan is ELIMINATED after first knowledge save.
```

**Migration of existing data (one-time):**

On the FIRST startup after Phase 5 is deployed:
1. knowledgeManager.load('engineC', 'dataset') → null (no artifact yet)
2. **One-time migration:** SELECT * FROM shadowm_trades → build dataset → save to knowledge_artifacts
3. Log: `[KNOWLEDGE] First-time migration: built engineC/dataset from ${N} shadowm_trades rows`
4. On all subsequent startups: load from knowledge_artifacts → O(1)

### 7.4 Engine D Migration

**Modification to shadowlab.js — ShadowMetaEngine:**

```
CURRENT BEHAVIOR:
  _cycle() computes weights by scanning last N closed trades from shadowm_trades

NEW BEHAVIOR:
  Startup:
    knowledgeManager.load('engineD', 'weights')
    → artifact found: weights = artifact.value.conditions  ← O(1)
    → artifact not found: weights = default equal weights

  Every 100 closed trades:
    Compute EMA update: newWeight[c] = α × recent[c] + (1-α) × current[c]
    knowledgeManager.save('engineD', 'weights', {conditions: newWeights, ...}, {
      trainingEvents: totalClosed,
      confidence: computedConfidence
    })
```

### 7.5 Exit Lab Migration

```
Every 20 closed trades:
  Compute strategy performance stats from shadowm_trades (last 500 rows only)
  knowledgeManager.save('exitLab', 'strategies', {strategies, bestStrategy}, {
    trainingEvents: totalClosed
  })

On startup:
  knowledgeManager.load('exitLab', 'strategies')
  → Exit Lab knows best historical strategy immediately
```

### 7.6 Corruption Protection

When loading any knowledge artifact:
```javascript
const artifact = await load(domain, name);
if (artifact) {
  const computed = computeChecksum(artifact.value);
  if (computed !== artifact.checksum) {
    console.error(`[KNOWLEDGE] CORRUPTION: ${domain}/${name} checksum mismatch`);
    // Attempt rollback to previous version
    const history = await loadHistory(domain, name, 5);
    for (const prior of history) {
      const priorChecksum = computeChecksum(prior.value);
      if (priorChecksum === prior.checksum) {
        console.log(`[KNOWLEDGE] Rolling back ${domain}/${name} to v${prior.version}`);
        await rollback(domain, name, prior.version);
        return prior;
      }
    }
    console.error(`[KNOWLEDGE] No valid prior version found — returning null`);
    return null;  // Engine uses safe defaults
  }
}
```

### 7.7 Duration: 4 days | Complexity: HIGH | Priority: P1

### 7.8 Phase 5 Exit Criteria

```
[ ] knowledgeManager.js exists and passes ≥15 unit tests
[ ] Engine C dataset loaded from knowledge_artifacts (not shadowm_trades) on startup
[ ] Engine D weights loaded from knowledge_artifacts on startup
[ ] Startup time ≤200ms without OANDA (measured 5 consecutive restarts)
[ ] New closed trade increments knowledge artifact version correctly
[ ] knowledge_artifacts.checksum verified correct on every load
[ ] Checksum mismatch triggers rollback to prior version (integration test)
[ ] getCached() returns artifact synchronously (shadowGate() unaffected)
[ ] First-time migration: shadowm_trades → knowledge_artifacts completes in <30s
[ ] After first-time migration: subsequent restarts do NOT scan shadowm_trades
[ ] 48h production monitoring: no learning regression detected
[ ] knowledgeManager.prune(90) tested: removes superseded artifacts > 90 days old
```

---

## Section 8 — Phase 6: RecoveryManager + ValidationManager

### 8.1 Goal

Create the `RecoveryManager` (9-phase startup sequence) and `ValidationManager` (12 consistency checks + auto-repair). Replace the ad-hoc startup sequence in server.js with the RecoveryManager. System status is now formally tracked: HEALTHY, DEGRADED, HALTED.

### 8.2 What to Build

**New file:** `telemetry/managers/recovery-manager.js`

The RecoveryManager orchestrates all startup logic currently spread across:
- `restoreLiveState()` in server.js
- `shadowM._restore()` in shadowm.js
- `shadowLab._init()` in shadowlab.js

It calls these via the EnginePlugin interface (or directly if the plugin interface hasn't been built yet). It runs in sequence:

```
Phase 1: SCHEMA         → stateManager.migrateIfNeeded()
Phase 2: DOMAINS        → stateManager.loadAll()
Phase 3: MEMORY         → memoryManager.getAll() for critical namespaces
Phase 4: KNOWLEDGE      → knowledgeManager.load() for all artifacts; verify checksums
Phase 5: INTENTS        → intentManager.getPendingIntents()
Phase 6: OANDA          → oandaClient.getOpenTrades() + reconcile
Phase 7: ENGINES        → call engine verify methods (shadowM._restore, shadowLab._init)
Phase 8: VALIDATION     → validationManager.runChecks()
Phase 9: READY          → set meta.status; spawn bot; start intervals
```

**New file:** `telemetry/managers/validation-manager.js`

12 consistency checks (full list in SHADOW_OS_V2.md Section 9.1):
```
live_vs_oanda             — openTrades matches OANDA /openTrades
shadowm_cursor_lag        — shadowM.lastId within 100 of max(events.id)
shadowm_active_vs_live    — Every shadowM._active entry in openTrades and vice versa
knowledge_checksums       — All active knowledge artifact checksums valid
engine_c_version_mismatch — Engine C loaded version matches shadowC.datasetVersion
engine_d_version_mismatch — Engine D loaded version matches shadowD.weightsVersion
learning_degradation      — Engine C/D accuracy has not dropped >5% from prior version
memory_leak_detection     — memory_entries count < 10,000
intent_stuck              — No PENDING trade_intents > 5 minutes old
daily_counter_drift       — live.dailyTrades matches COUNT(trade_open events for today)
schema_version_drift      — Each domain schema_ver matches expected version
event_log_gap             — events.id is monotonically increasing (no large gaps)
```

**Modification to server.js — startup:**
```javascript
// PHASE 6: Replace ad-hoc startup with RecoveryManager
const recoveryReport = await recoveryManager.run({
  baseUrl: process.env.OANDA_BASE_URL,
  token:   process.env.OANDA_API_KEY,
  accountId: process.env.OANDA_ACCOUNT_ID
});

console.log(`[RECOVERY] Status: ${recoveryReport.status} in ${recoveryReport.totalMs}ms`);

if (recoveryReport.status === 'HALTED') {
  console.error('[RECOVERY] HALTED — see blockers:', recoveryReport.blockers);
  console.error('[RECOVERY] System will not trade until blockers are resolved');
  // Start HTTP server for diagnostics, but do NOT spawn bot
} else {
  if (recoveryReport.status === 'DEGRADED') {
    console.warn('[RECOVERY] DEGRADED — warnings:', recoveryReport.warnings);
  }
  // Spawn bot
  startBot();
}
```

### 8.3 Duration: 4 days | Complexity: HIGH | Priority: P1

### 8.4 Phase 6 Exit Criteria

```
[ ] recoveryManager.js exists and passes ≥12 integration tests (one per phase)
[ ] validationManager.js exists and passes ≥12 unit tests (one per check)
[ ] RecoveryManager replaces ad-hoc startup code in server.js
[ ] System status correctly set to HEALTHY after clean Railway restart
[ ] System status set to DEGRADED when OANDA unreachable (bot NOT spawned)
[ ] ValidationManager auto-repairs: shadowm_cursor_lag, intent_stuck, daily_counter_drift
[ ] consistency_log table receives entries for every check run
[ ] GET /api/system/status endpoint returns status + last recovery report
[ ] Full 9-phase recovery completes in ≤700ms (measured, not estimated)
[ ] ValidationManager scheduled every 5 minutes (verified via consistency_log)
```

---

## Section 9 — Phase 7: SnapshotManager + Plugin Architecture

### 9.1 Goal

Create the `SnapshotManager` (periodic forensic snapshots). Create the `EnginePlugin` interface and `EngineRegistry`. Register existing engines. This phase is additive and carries low risk.

### 9.2 What to Build

**New file:** `telemetry/managers/snapshot-manager.js`

```
takeSnapshot(trigger)           → Promise<{id, createdAt, trigger}>
scheduleSnapshots(intervalMs)   → void   (default: 5 minutes)
getLatestSnapshot()             → Promise<Snapshot | null>
compareSnapshots(id1, id2)      → Promise<diff>
```

Snapshots do NOT replace runtime_domains (those are the recovery source). Snapshots are forensic records — they capture a summary of system state at a point in time for debugging and auditing.

**New file:** `telemetry/managers/engine-registry.js`

```
register(engine: EnginePlugin) → void
getAll()                       → EnginePlugin[]
get(name)                      → EnginePlugin | null
runRecovery(domains, knowledge, memory) → Promise<results[]>
runHealthChecks()              → Promise<results[]>
```

**New files:** `telemetry/engines/shadow-m-engine.js`, `telemetry/engines/shadow-lab-engine.js`

These are thin wrappers that implement the EnginePlugin interface:
```javascript
class ShadowMEngine {
  get name() { return 'shadowM'; }
  get ownedDomains() { return ['shadowM']; }
  get ownedArtifacts() { return []; }
  get memoryNamespaces() { return ['observations']; }
  async onRecovery(domains, knowledge, memory) { ... }
  onDegraded(reason) { ... }
  async onShutdown() { ... }
  async healthCheck() { ... }
}
```

**New API endpoints in server.js:**
```
GET /api/system/status      → {status, bootCount, uptimeSeconds, version, lastRecoveryReport}
GET /api/system/domains     → {domain: {version, updatedAt, schemaVer}}
GET /api/system/knowledge   → [{domain, artifact, version, confidence, byteSize, createdAt}]
GET /api/system/memory      → [{namespace, key, expiresIn, tags}]
GET /api/system/validation  → {lastRun, status, openIssues}
POST /api/system/snapshot   → triggers manual snapshot
POST /api/system/validate   → triggers immediate validation run
```

### 9.3 Duration: 2 days | Complexity: LOW | Priority: P2

### 9.4 Phase 7 Exit Criteria

```
[ ] Snapshots taken at: POST_RECOVERY, PRE_SHUTDOWN (SIGTERM handler), every 5 minutes
[ ] system_snapshots table receiving rows
[ ] EngineRegistry has both engines registered
[ ] GET /api/system/status returns HEALTHY and correct bootCount
[ ] GET /api/system/knowledge returns current artifacts with confidence scores
[ ] SnapshotManager.compareSnapshots() shows correct diff between two snapshots
```

---

## Section 10 — Phase 8: Production Hardening + Cleanup

### 10.1 Goal

Remove dead code, archive backup files, validate performance under load, set up monitoring, document operational runbooks.

### 10.2 What to Do

**Dead code removal:**
```
Archive to /archive/:
  dashboard.js
  index_backup_v39_2.js
  index_backup_v39_3_before_v39_4.js
  index_backup_v39_4_before_v39_4b.js
  index_railway_mtf_v39_optimized.js
  index_original_safe.js
  telemetry/server_backup_pre_snowball_lab.js
  telemetry/shadowlab_backup_pre_v40.js

After archiving: 7,439 LOC → ~5,000 LOC active
```

**Fallback code removal:**
```
Remove from server.js:
  event-replay fallback in restoreLiveState() (now dead code — runtime_domains is always current)
  shadowm_cursor event writes (cursor now in runtime_domains)
  [STATE DRIFT] validation logging (served its purpose in Phase 1)

Remove from shadowm.js:
  Event-based cursor fallback in _restore()
  shadowm_cursor event write in _poll()
```

**SIGTERM handler (graceful shutdown):**
```javascript
process.on('SIGTERM', async () => {
  console.log('[SERVER] SIGTERM received — graceful shutdown');
  await stateManager.flush();
  await snapshotManager.takeSnapshot('PRE_SHUTDOWN');
  await stateManager.saveDomainRetry('meta', m => ({
    ...m,
    lastCleanShutdown: new Date().toISOString()
  }));
  bot?.kill('SIGTERM');
  server.close(() => process.exit(0));
});
```

**TTL cleanup jobs:**
```javascript
// In server.js startup, after RecoveryManager:
setInterval(async () => {
  await knowledgeManager.prune(90);         // remove knowledge > 90 days old
  const deleted = await intentManager.cleanupStale(24);  // remove stale intents > 24h
  console.log(`[CLEANUP] Pruned old artifacts and ${deleted} stale intents`);
}, 24 * 60 * 60 * 1000); // Daily

setInterval(async () => {
  await memoryManager.gc();                 // remove expired memory entries
}, 60 * 60 * 1000); // Hourly
```

**Operational monitoring:**
```
Add to railway.json:
  "healthcheckPath": "/api/system/status"
  "healthcheckTimeout": 10

Add to GET /api/system/status response:
  {
    status: 'HEALTHY'|'DEGRADED'|'HALTED',
    uptimeSeconds, bootCount,
    memoryEntries: N,
    knowledgeArtifacts: N,
    runtimeDomains: [{domain, version}],
    lastValidation: {ranAt, checksRun, issueCount}
  }
```

### 10.3 Duration: 3 days | Complexity: LOW | Priority: P3

### 10.4 Phase 8 Exit Criteria

```
[ ] All backup files moved to /archive/ (not deleted)
[ ] Dead code paths removed from server.js, shadowm.js, shadowlab.js
[ ] SIGTERM handler tested: flush + snapshot + graceful exit in ≤3s
[ ] Railway healthcheck returning 200 /api/system/status
[ ] TTL cleanup jobs running: knowledge prune, intent cleanup, memory GC
[ ] Final startup time benchmark: ≤150ms (without OANDA)
[ ] Final Railway restart test: complete recovery, correct state, no console errors
[ ] Production monitoring active (consistency_log checked manually after 72h)
```

---

## Section 11 — Testing Strategy

### 11.1 Testing Philosophy

Every new module (StateManager, MemoryManager, KnowledgeManager, IntentManager, RecoveryManager, SnapshotManager, ValidationManager) must have passing tests before it is integrated into a production module (server.js, shadowm.js, shadowlab.js). Integration happens AFTER unit tests pass, not before.

### 11.2 Test Framework

```
Framework: Node.js built-in test runner (node --test, available in Node 18+)
           OR Jest (already in use if package.json includes it; if not, node --test)
Location:  telemetry/tests/
Structure:
  telemetry/tests/
    unit/
      state-manager.test.js
      memory-manager.test.js
      knowledge-manager.test.js
      intent-manager.test.js
      recovery-manager.test.js
      snapshot-manager.test.js
      validation-manager.test.js
    integration/
      phase-3-read-switchover.test.js
      phase-5-knowledge-migration.test.js
      phase-6-recovery-sequence.test.js
      railway-restart-simulation.test.js
      oanda-reconciliation.test.js
    stress/
      concurrent-writers.test.js
      knowledge-at-scale.test.js
      million-events.test.js
```

### 11.3 Unit Tests — StateManager

```
Minimum 10 tests required:

TEST 1: loadDomain — returns null when domain does not exist
TEST 2: loadDomain — returns DomainState with correct fields when domain exists
TEST 3: saveDomain — writes with correct version increment
TEST 4: saveDomain — returns {ok: false} on version conflict
TEST 5: saveDomainRetry — retries on version conflict, succeeds on second attempt
TEST 6: saveDomainRetry — raises ConcurrencyError after maxRetries conflicts
TEST 7: saveDomainRetry — transform is called with current value from DB
TEST 8: loadAll — returns all 10 domains in a single call
TEST 9: flush — commits all pending mutations before returning
TEST 10: getCached — returns in-memory value synchronously after loadAll
BONUS TEST 11: Concurrent writes — two saveDomainRetry calls resolve without data loss
BONUS TEST 12: Schema migration — domain with stale schema_ver gets migrated
```

### 11.4 Unit Tests — MemoryManager

```
Minimum 10 tests required:

TEST 1: set — creates entry with correct expires_at (TTL respected)
TEST 2: set — updates existing entry (ON CONFLICT DO UPDATE)
TEST 3: get — returns null for missing key
TEST 4: get — returns null for expired entry (expires_at < NOW())
TEST 5: get — returns value for non-expired entry
TEST 6: getAll — excludes expired entries
TEST 7: delete — entry no longer returned after delete
TEST 8: touch — updates expires_at, entry no longer expires when expected
TEST 9: gc — deletes expired rows, returns count per namespace
TEST 10: stats — returns correct totalEntries and expiredEntries counts
BONUS TEST 11: Concurrent set — no duplicate rows (ON CONFLICT DO NOTHING / DO UPDATE)
BONUS TEST 12: get — increments access_count (fire-and-forget)
```

### 11.5 Unit Tests — KnowledgeManager

```
Minimum 15 tests required:

TEST 1: load — returns null when no artifact exists
TEST 2: save — creates first artifact with correct version=1
TEST 3: save — supersedes prior version (superseded_at set)
TEST 4: save — no-op when checksum is identical to current active (returns existing)
TEST 5: save — new artifact has correct checksum
TEST 6: load — returns active (non-superseded) artifact
TEST 7: load — CRITICAL: detects checksum mismatch, returns null
TEST 8: load — after checksum mismatch: attempts rollback to prior valid version
TEST 9: rollback — creates new version with content of target version
TEST 10: rollback — migration_from set to target version's id
TEST 11: loadHistory — returns versions in DESC order
TEST 12: migrate — applies migration function, saves new version
TEST 13: verifyAll — returns {ok: true} for valid artifacts
TEST 14: verifyAll — returns {ok: false, error} for corrupted artifact
TEST 15: prune — deletes superseded artifacts older than keepDays
BONUS TEST 16: Concurrent save — two saves: both produce valid artifacts, last writer wins
BONUS TEST 17: getCached — returns artifact synchronously (critical for shadowGate)
```

### 11.6 Integration Tests — Phase 5 (Knowledge Migration)

```
TEST INT-01: First-time migration
  Setup: shadowm_trades has 50 rows (closed trades). No knowledge_artifacts.
  Action: Deploy Phase 5.
  Expected: knowledge_artifacts has engineC/dataset (50 examples), engineD/weights.
  Measure: Migration completes in < 30s.

TEST INT-02: Incremental update
  Setup: 50 examples in knowledge_artifacts.
  Action: Simulate 10 trade_close events.
  Expected: knowledge_artifacts version incremented, examples count = 60.

TEST INT-03: Startup performance at 10,000 trades
  Setup: knowledge_artifacts with 10,000 examples in engineC/dataset.
  Action: Kill process, restart.
  Expected: Phase 4 (knowledge load) completes in ≤ 100ms.
  Expected: shadowm_trades is NOT scanned at startup.

TEST INT-04: Knowledge corruption recovery
  Setup: Manually corrupt checksum in knowledge_artifacts (update checksum to 'invalid').
  Action: Restart process.
  Expected: Phase 4 detects corruption, rolls back to prior version, logs CRITICAL.
  Expected: System reaches HEALTHY status (not HALTED).
```

### 11.7 Integration Tests — Recovery Sequence

```
TEST INT-05: Clean restart
  Action: Railway restart simulation (kill -15 + restart).
  Expected: All 9 phases complete in ≤ 700ms.
  Expected: meta.status = HEALTHY, bot spawned.
  Expected: live.openTrades matches OANDA positions.

TEST INT-06: Crash (kill -9)
  Action: kill -9 the process, restart.
  Expected: Phase 5 (INTENTS) finds 0 PENDING intents (clean state).
  Expected: OANDA reconciliation: 0 discrepancies.
  Expected: Recovery completes in ≤ 700ms.

TEST INT-07: OANDA unreachable
  Setup: OANDA_API_KEY set to invalid value.
  Action: Restart process.
  Expected: Phase 6 fails, status = DEGRADED.
  Expected: Bot is NOT spawned.
  Expected: GET /api/system/status returns {status: 'DEGRADED', blockers: ['oanda_unreachable']}.

TEST INT-08: Pending intent on startup
  Setup: INSERT a PENDING trade_intent manually.
  Action: Restart process with OANDA key valid.
  Expected: Phase 5 finds 1 PENDING intent.
  Expected: Phase 6 queries OANDA for this signalId.
  Expected: Intent marked CONFIRMED or FAILED depending on OANDA response.
```

### 11.8 Stress Tests

```
TEST STRESS-01: 1 million events in events table
  Setup: Bulk INSERT 1,000,000 rows into events table.
  Action: Restart process.
  Expected: Startup time unchanged (events table NOT scanned).
  Expected: Phase 2 (domain load) ≤ 50ms.
  Expected: shadowM._poll() latency unchanged (uses id > _lastId index).

TEST STRESS-02: Concurrent StateManager writes
  Action: Fire 10 concurrent saveDomainRetry calls on 'live' domain.
  Expected: All 10 writes succeed (some with retries).
  Expected: Final version = initial version + 10.
  Expected: No data loss (version counter is correct).

TEST STRESS-03: memory_entries at 10,000 rows
  Setup: INSERT 10,000 memory_entries (mix of expired and current).
  Action: Run memoryManager.gc().
  Expected: Expired entries deleted in ≤ 500ms.
  Expected: getAll() still returns correct non-expired entries.
```

### 11.9 Failure Injection Tests

```
TEST FAIL-01: DB connection drops during saveDomainRetry
  Action: Simulate connection drop mid-write.
  Expected: StateManager logs error, returns {ok: false}.
  Expected: In-memory state unchanged. System continues operating.

TEST FAIL-02: DB connection drops during knowledge save
  Action: Simulate connection drop mid-INSERT.
  Expected: PostgreSQL rolls back transaction (ACID guarantee).
  Expected: Prior knowledge artifact remains active.
  Expected: Next save() attempt succeeds.

TEST FAIL-03: DB connection drops during RecoveryManager Phase 4
  Action: Drop connection after Phase 2, before Phase 4.
  Expected: Phase 4 fails, recovery continues with safe defaults.
  Expected: Engines use default state (equal weights, empty dataset).
  Expected: Status = DEGRADED (knowledge unavailable).

TEST FAIL-04: Railway restart during trade execution (SIM-04)
  Action: Simulate crash immediately after trade_open logEvent fires.
  Expected: PENDING intent found on startup.
  Expected: OANDA reconciliation identifies position.
  Expected: live.openTrades updated correctly.
```

### 11.10 Acceptance Criteria per Phase

| Phase | Primary acceptance criteria |
|-------|---------------------------|
| 0 | Schema deployed; migration idempotent; no production errors |
| 1 | [STATE DRIFT] = 0 over 48h; runtime_domains.version increments correctly |
| 2 | trade_intents populated for every trade; OANDA reconciliation tested |
| 3 | Startup from runtime_domains; [FALLBACK] never appears; ≤200ms startup |
| 4 | Cooldowns in memory_entries; GC running; no memory growth |
| 5 | Startup ≤150ms at 10,000 trades; knowledge artifacts correct; no shadowm_trades scan |
| 6 | RecoveryManager replaces ad-hoc startup; all 12 checks run; DEGRADED works |
| 7 | Snapshots taken; plugin interface implemented; system endpoints active |
| 8 | Dead code removed; SIGTERM handler works; cleanup jobs running; production stable |

---

## Section 12 — Rollback Strategy

### 12.1 Rollback Trigger Conditions

A rollback should be initiated if ANY of the following occur after a phase deployment:

```
IMMEDIATE ROLLBACK (< 15 minutes):
  - Bot stops trading (botStatus = stopped, no restart)
  - Console shows ERROR rate > 10/minute (up from baseline ~0)
  - Railway health check fails
  - live.openTrades incorrect (missing position or extra ghost position)
  - Trade executed but not in trade_intents (after Phase 2)

PLANNED ROLLBACK (within 24 hours):
  - [STATE DRIFT] logs appearing (Phase 1) — investigate root cause first
  - Startup time regression (> 500ms) after Phase 3/5
  - Knowledge artifact not updating after new closed trades (Phase 5)
  - ValidationManager reporting persistent CRITICAL issues after Phase 6
```

### 12.2 Rollback Procedure per Phase

```
PHASE 0 ROLLBACK:
  Command: psql $DATABASE_URL < archive/rollback_phase0.sql
  SQL:
    DROP TABLE IF EXISTS system_snapshots, consistency_log, event_idempotency,
                         trade_intents, knowledge_artifacts, memory_entries, runtime_domains;
  Duration: 30 seconds
  Risk: None (new tables only)

PHASE 1 ROLLBACK:
  Action: git revert phase-1 commit(s)
  Action: Deploy (removes StateManager calls)
  Tables: runtime_domains retains written rows (harmless; table not used by old code)
  Duration: 5 minutes (git revert + deploy)

PHASE 2 ROLLBACK:
  Action: git revert phase-2 commit(s)
  Tables: trade_intents retains written rows (harmless)
  Duration: 5 minutes

PHASE 3 ROLLBACK:
  Action: git revert phase-3 commit(s) (restores event-replay as primary read path)
  Tables: runtime_domains rows remain (provide the initial state for next Phase 3 attempt)
  Duration: 5 minutes
  ⚠️ WARNING: After rollback, startup reverts to event-replay. This is safe but slower.

PHASE 4 ROLLBACK:
  Action: git revert phase-4 commit(s) (removes MemoryManager calls)
  Tables: memory_entries retains rows (harmless)
  Duration: 5 minutes

PHASE 5 ROLLBACK (MOST CRITICAL):
  Action: git revert phase-5 commit(s)
  Action: Engine C/D revert to rebuilding from shadowm_trades
  Tables: knowledge_artifacts retains rows (this is the KNOWLEDGE — DO NOT DROP)
  Duration: 5 minutes
  ⚠️ NOTE: Rolling back Phase 5 does NOT lose knowledge. knowledge_artifacts rows
           remain. When Phase 5 is re-deployed, artifacts are loaded immediately.

PHASE 6 ROLLBACK:
  Action: git revert phase-6 commit(s) (restores ad-hoc startup in server.js)
  Tables: consistency_log retains rows
  Duration: 5 minutes

PHASE 7 ROLLBACK:
  Action: git revert phase-7 commit(s)
  Duration: 5 minutes

PHASE 8 ROLLBACK:
  No code changes that affect production behavior.
  If dead code removal introduced a bug: git revert phase-8 commit(s).
  Archive directory is recoverable.
```

### 12.3 The Knowledge Protection Guarantee

```
ACROSS ALL PHASES, knowledge_artifacts is NEVER:
  - Dropped (no DROP TABLE)
  - Truncated (no TRUNCATE)
  - Subject to mass DELETE
  - Rolled back to a prior version without creating a new version first

Even if ALL phases are rolled back, knowledge_artifacts retains every trained artifact.
When phases are re-deployed, artifacts are loaded immediately — no re-training needed.

This is the implementation of the GOLDEN RULE at the database level.
```

---

## Section 13 — Success Metrics

### 13.1 Performance Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Startup time (no OANDA) | ~18s at 10K trades | ≤150ms | Time from process start to "System READY" log |
| Startup time (with OANDA) | ~18s + ~300ms | ≤450ms | Time from process start to first heartbeat |
| shadowM._poll() latency | ~2ms | ≤2ms (unchanged) | Average over 100 polls |
| shadowGate() latency | <1ms | <1ms (unchanged) | Must not regress — sync constraint |
| Trade lifecycle (open→tracked) | ~5s (next poll) | ~5s (unchanged) | Time from trade_open event to shadowM._active |
| Event write latency (logEvent) | ~5ms | ≤5ms (unchanged) | Must not regress |
| POST /api/shadow/mode latency | <50ms | ≤50ms | Railway response time |
| Knowledge artifact load | N/A | ≤100ms | Phase 4 duration in RecoveryManager |

### 13.2 Reliability Metrics

| Metric | Current | Target |
|--------|---------|--------|
| State loss on Railway restart | Possible | 0 (runtime_domains always current) |
| Ghost trade probability | Low (async race) | 0 (OANDA reconciliation on startup) |
| Knowledge loss on restart | 100% (rebuilt each time) | 0 (loaded from knowledge_artifacts) |
| Cooldown survival across restart | 0% | 100% (TTL-based memory_entries) |
| Consistency check frequency | 0 (manual only) | Every 5 minutes (automated) |
| Mean time to detect inconsistency | Hours (manual review) | ≤5 minutes (automated checks) |
| Mean time to repair inconsistency | Minutes (manual) | ≤30 seconds (auto-repair for known patterns) |

### 13.3 Learning Continuity Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Engine C dataset size after restart | 0 (rebuilt) | Preserved (loaded in ≤100ms) |
| Engine D weight accuracy after restart | 0 (rebuilt) | Preserved (loaded in ≤5ms) |
| Exit Lab strategy stats after restart | 0 (rebuilt) | Preserved (loaded in ≤5ms) |
| Learning sessions lost per Railway deploy | All | 0 |
| Minimum closed trades for knowledge init | 0 (always rebuilt) | 10 (first knowledge save) |

---

## Section 14 — Production Readiness Checklist

```
PRE-MIGRATION GATES:
[ ] Current system (v40.1) has been in production for ≥30 days without critical bugs
[ ] Phase 0 migration script tested on heliumdb (dev PostgreSQL)
[ ] Test framework configured (telemetry/tests/ directory created)
[ ] archive/ directory created for dead code
[ ] All backup files confirmed non-essential (no shared dependencies)
[ ] OANDA_BASE_URL added to Railway environment variables
[ ] Team has read and understood SHADOW_OS_V2.md and SHADOW_OS_ARCHITECTURE_V1.md
[ ] Each phase has been reviewed by at least one other engineer (if team size > 1)

POST-PHASE PRODUCTION VALIDATION (per phase):
[ ] Railway deployment succeeded (no build errors)
[ ] Railway health check passing (/api/system/status returns 200)
[ ] Bot trading normally (live.openTrades correct, no missed trades)
[ ] No unhandled errors in Railway logs for 24h
[ ] Database table counts as expected (no missing rows)
[ ] Phase-specific metrics within bounds (see Section 13.1)

FINAL PRODUCTION READINESS:
[ ] All 8 phases deployed and validated
[ ] Startup time ≤150ms (5 consecutive cold starts measured)
[ ] 72h of clean production operation post-Phase 8
[ ] All unit tests passing (pnpm test)
[ ] SIGTERM graceful shutdown tested (manual SIGTERM + verify snapshot + clean restart)
[ ] ValidationManager shows CLEAN for 72h (no unresolved issues)
[ ] knowledge_artifacts has ≥3 versions for engineC/dataset (demonstrates accumulation)
[ ] Operational runbook written (how to: rollback, manual reconcile, force validation)
[ ] POST /api/system/validate returns CLEAN
[ ] GET /api/system/knowledge shows current version with confidence > 0
[ ] Daily cleanup jobs confirmed running (consistency_log has recent entries)
[ ] replit.md updated with SHADOW OS v2 architecture overview
```

---

*This blueprint is the single authoritative reference for the SHADOW OS v2 migration.*  
*All implementation decisions must be consistent with the constraints and phases defined here.*  
*The Golden Rule — no step may destroy accumulated knowledge — is non-negotiable.*  
*Refer to PROJECT_ROADMAP.md for sprint scheduling, RISK_REGISTER.md for risk tracking,*  
*and MIGRATION_CHECKLIST.md for step-by-step execution guidance.*
