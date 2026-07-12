# MASTER ARCHITECTURE — SHADOW OS v2
## FOREX ENGINE PRO — Autonomous Trading Operating System

**Classification:** Principal Architecture Document — Single Source of Truth  
**Version:** 1.0  
**Date:** 2026-07-06  
**Authors:** Sprint 0 (Foundation) + Sprint 1 (Runtime Awakening)  
**Status:** ACTIVE — Sprint 1 implemented, Sprints 2–5 specified

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Core Design Philosophy](#2-core-design-philosophy)
3. [Four-Layer Memory Hierarchy](#3-four-layer-memory-hierarchy)
4. [Component Map](#4-component-map)
5. [Runtime Domains (10 Domains)](#5-runtime-domains)
6. [Manager Hierarchy](#6-manager-hierarchy)
7. [Lifecycle Diagrams](#7-lifecycle-diagrams)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Component Interaction Matrix](#9-component-interaction-matrix)
10. [Database Schema](#10-database-schema)
11. [API Contracts](#11-api-contracts)
12. [Recovery Sequences](#12-recovery-sequences)
13. [Failure Modes and Mitigations](#13-failure-modes-and-mitigations)
14. [Implementation Status](#14-implementation-status)
15. [Sprint Roadmap](#15-sprint-roadmap)

---

## 1. Purpose and Scope

This document is the **single source of truth** for the SHADOW OS v2 architecture. Every implementation decision, API design, and database schema must be consistent with what is written here. When this document and the code disagree, this document wins — update the code.

### 1.1 What SHADOW OS v2 Is

SHADOW OS v2 is the operating system layer of FOREX ENGINE PRO. It is not a feature. It is the foundation on which every future capability is built. Its purpose:

- **Own runtime state** — single, authoritative, version-controlled state store
- **Protect accumulated knowledge** — learned intelligence is immutable, versioned, never deleted
- **Mediate all resource access** — no engine module touches PostgreSQL directly
- **Enable recovery** — the system returns to a valid state after any failure
- **Accumulate intelligence** — the system becomes smarter over time without human intervention

### 1.2 What SHADOW OS v2 Is Not

- It is not a replacement for the live trading bot (`index.js`) — that is FROZEN
- It is not a refactor of `server.js`, `shadowm.js`, or `shadowlab.js` — those are production files, modified only when a manager is ready to take ownership
- It is not an event-driven rewrite — events remain in the `events` table, unchanged

### 1.3 The Sacred Constraint

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  SACRED CONSTRAINT — NEVER VIOLATED                                       ║
║                                                                           ║
║  No deployment, restart, or migration step may ever destroy the           ║
║  accumulated trading knowledge of the system.                             ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## 2. Core Design Philosophy

### 2.1 Six Architectural Invariants

```
INVARIANT 1: Single Source of Truth
  For every piece of information, exactly one layer owns it.
  Runtime Layer owns operational state.
  Memory Layer owns contextual memory.
  Knowledge Layer owns learned intelligence.
  Event Log owns historical record.
  Violation → data inconsistency, potential duplicate trades.

INVARIANT 2: Manager Mediation
  No engine module reads from or writes to PostgreSQL directly.
  All DB access goes through the Manager Tier.
  Violation → bypasses optimistic concurrency, validation, versioning.
  Implementation note: Sprint 1 introduces RuntimeDomainManager.
  Existing production files (server.js, shadowm.js, shadowlab.js) access DB
  directly until their respective manager is implemented and tested.

INVARIANT 3: Knowledge Immutability
  Knowledge artifacts are never deleted; they are superseded.
  Every training run produces a new version.
  The lineage of how the system learned is always traceable.
  Violation → cannot diagnose learning degradation or roll back safely.

INVARIANT 4: Memory Expiry
  Memory entries have a defined lifecycle. They expire naturally.
  The system does not rely on memory entries being present.
  Missing memory → safe default behavior, not a crash.
  Violation → stale context treated as current, incorrect decisions.

INVARIANT 5: Recovery Completeness
  After any failure, the Recovery Manager runs all recovery phases
  before trading resumes.
  System status is HALTED until RecoveryManager reports READY or DEGRADED.
  DEGRADED → trading paused, monitoring active.
  Violation → trading on inconsistent state.

INVARIANT 6: Financial Intent Atomicity
  Every trade_open or trade_close is preceded by a committed trade_intent.
  No OANDA call is made without a committed PENDING intent.
  Violation → ghost trades, unreconcilable positions.
```

### 2.2 The OS Analogy

| SHADOW OS v2 Component | OS Analogy | Responsibility |
|------------------------|-----------|----------------|
| Manager Tier | Kernel | Mediates all resource access |
| Runtime Layer | CPU registers + RAM | Operational state, domain cursors |
| Memory Layer | Virtual memory (paged) | Contextual memory with TTL |
| Knowledge Layer | Persistent disk | Learned intelligence, never rebuilt |
| Event Log | Audit journal | Immutable record, compliance only |
| RuntimeDomainManager | Process scheduler | Owns/arbitrates runtime state |
| MemoryManager | Memory allocator | Append-first event memory + TTL cache |
| KnowledgeManager | Filesystem | Versioned artifact storage |
| RecoveryManager | Fault handler | Post-failure state reconstruction |
| ValidationManager | Health monitor | Periodic integrity verification |

---

## 3. Four-Layer Memory Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SHADOW OS v2 — MEMORY HIERARCHY                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  RUNTIME LAYER                                                       │   │
│  │  Fast · Versioned · Domain-partitioned · Optimistic locking         │   │
│  │  Write latency: ~5ms     Read latency: ~2ms                         │   │
│  │  Durability: survives restart (PostgreSQL)                          │   │
│  │  Domains: live, shadowA, shadowB, shadowC, shadowD,                 │   │
│  │           shadowM, exitLab, telemetry, scheduler, meta              │   │
│  │  Owner: RuntimeDomainManager (Sprint 1)              ← IMPLEMENTED  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  MEMORY LAYER                                                        │   │
│  │  TTL-based · Contextual · Self-expiring · GC-managed               │   │
│  │  Write latency: ~5ms     Read latency: ~3ms                         │   │
│  │  Durability: TTL (hours to days)                                    │   │
│  │  Namespaces: observations, cooldowns, market_state, volatility,     │   │
│  │              correlations, decision_history, confidence_decay       │   │
│  │  Owner: MemoryManager (Sprint 3)                       ← DONE       │   │
│  │  NOTE: Sprint 3 split the layer — memory_events +                   │   │
│  │  memory_event_history are permanent (append-first, never deleted); │   │
│  │  memory_entries remains the TTL/KV working cache described above.  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  KNOWLEDGE LAYER                                                     │   │
│  │  Permanent · Versioned · Append-only · Checksum-verified            │   │
│  │  Write latency: ~20ms    Read latency: ~10ms                        │   │
│  │  Durability: forever (never deleted, only superseded)               │   │
│  │  Artifacts: engineC/*, engineD/*, exitLab/*, market/*, system/*     │   │
│  │  Owner: KnowledgeManager (Sprint 4)                    ← PLANNED    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  EVENT LOG                                                           │   │
│  │  Immutable · Append-only · Audit-only                               │   │
│  │  Write latency: ~5ms     Read latency: variable                     │   │
│  │  Durability: forever                                                 │   │
│  │  Purpose: compliance, analytics, replay — NOT recovery              │   │
│  │  Owner: existing telemetry/index.js (unchanged)        ← FROZEN     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Layer communication rules:
  Runtime  → Memory:    Runtime state may reference Memory keys (never embed values)
  Runtime  → Knowledge: Runtime may reference Knowledge versions (never embed)
  Memory   → Knowledge: PROHIBITED (Memory is transient; Knowledge is permanent)
  Any      → Event Log: Write-only. Never read for recovery.
  All access → through Manager Tier only.
```

---

## 4. Component Map

### 4.1 Trading Engines (existing, production-frozen)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRADING ENGINES                                     │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  LIVE BOT    │  │  SHADOW A    │  │  SHADOW B    │  │  SHADOW C    │   │
│  │  index.js    │  │  (in lab)    │  │  (in lab)    │  │  (in lab)    │   │
│  │  FROZEN      │  │  Trend Eng.  │  │  Candle Eng. │  │  KNN Engine  │   │
│  │  OANDA calls │  │  Frozen      │  │  Frozen      │  │  Adaptive    │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                  └──────────────────┴──────────────────┘          │
│         │                              shadowlab.js                         │
│  ┌──────┴───────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  SHADOW M    │  │  SHADOW D    │  │  EXIT LAB    │  │  TELEMETRY   │   │
│  │  shadowm.js  │  │  (in lab)    │  │  (in lab)    │  │  index.js    │   │
│  │  Trade Track │  │  Meta Engine │  │  Exit Strat. │  │  Event log   │   │
│  │  Exit detect │  │  Weights     │  │  Optimizer   │  │  SSE stream  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                  └──────────────────┘                 │            │
│  ┌──────┴───────────────────────────────────────────────────────┴───────┐   │
│  │                        server.js (orchestrator)                      │   │
│  │                    Express API · Bot lifecycle · Scheduler           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Manager Tier (SHADOW OS v2, being built)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MANAGER TIER                                       │
│                                                                             │
│  ┌────────────────────────┐   ┌────────────────────────┐                  │
│  │  RuntimeDomainManager  │   │     MemoryManager       │                  │
│  │  Sprint 1 ← DONE       │   │     Sprint 3 ← DONE     │                  │
│  │                        │   │                         │                  │
│  │  createDomain()        │   │  createMemory()         │                  │
│  │  getDomain()           │   │  appendMemory()         │                  │
│  │  updateDomain()        │   │  searchMemory()/query*()│                  │
│  │  patchDomain()         │   │  summarizeMemory()      │                  │
│  │  compareAndSwap()      │   │  validateMemory(), kv*()│                  │
│  │  takeSnapshot()        │   └────────────────────────┘                  │
│  │  restoreFromSnapshot() │                                                │
│  │  rollback()            │   ┌────────────────────────┐                  │
│  │  getHistory()          │   │   KnowledgeManager      │                  │
│  │  runConsistencyCheck() │   │   Sprint 4 (planned)    │                  │
│  └────────────────────────┘   │                         │                  │
│                                │  saveArtifact()         │                  │
│  ┌────────────────────────┐   │  loadArtifact()         │                  │
│  │    RecoveryManager     │   │  getHistory()           │                  │
│  │    Sprint 5 (planned)  │   │  rollback()             │                  │
│  │                        │   └────────────────────────┘                  │
│  │  runRecovery()         │                                                │
│  │  assessDamage()        │   ┌────────────────────────┐                  │
│  │  repairDomain()        │   │   ValidationManager     │                  │
│  │  generateReport()      │   │   Sprint 5 (planned)    │                  │
│  └────────────────────────┘   │                         │                  │
│                                │  runCheck()             │                  │
│                                │  autoRepair()           │                  │
│                                │  schedule(interval)     │                  │
│                                └────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Full System Component Responsibilities

| Component | File | Domain | Writes To | Reads From | Status |
|-----------|------|--------|-----------|------------|--------|
| Live Bot | `index.js` | — | `events` (via telemetry) | — | FROZEN |
| Server | `telemetry/server.js` | live, scheduler, meta | `events`, runtime_domains (direct, pre-v2) | events | INTEGRATED (Sprint 4 — flag-gated memory hooks; `index.js` remains FROZEN) |
| Shadow A | `telemetry/shadowlab.js` | shadowA | runtime_domains (direct, pre-v2) | events | FROZEN |
| Shadow B | `telemetry/shadowlab.js` | shadowB | runtime_domains (direct, pre-v2) | events | FROZEN |
| Shadow C | `telemetry/shadowlab.js` | shadowC | runtime_domains (direct, pre-v2) | events, knowledge_artifacts | FROZEN |
| Shadow D | `telemetry/shadowlab.js` | shadowD | runtime_domains (direct, pre-v2) | events, knowledge_artifacts | FROZEN |
| Shadow M | `telemetry/shadowm.js` | shadowM | runtime_domains (direct, pre-v2), shadowm_trades, shadowm_timeline | events | FROZEN |
| Exit Lab | `telemetry/shadowlab.js` | exitLab | runtime_domains (direct, pre-v2), knowledge_artifacts | shadowm_trades | FROZEN |
| Telemetry | `telemetry/index.js` | telemetry | `events` | — | FROZEN |
| RuntimeDomainManager | `telemetry/managers/RuntimeDomainManager.js` | ALL | runtime_domains, runtime_domain_history, system_snapshots, consistency_log | runtime_domains, runtime_domain_history | ✅ SPRINT 1 |
| MemoryManager | `telemetry/managers/MemoryManager.js` | — | memory_events, memory_event_history, memory_entries, consistency_log | memory_events, memory_event_history, memory_entries, trade_intents (ref check) | ✅ SPRINT 3 |
| KnowledgeManager | `telemetry/managers/KnowledgeManager.js` | — | knowledge_artifacts | knowledge_artifacts | SPRINT 4 |
| RecoveryManager | `telemetry/managers/RecoveryManager.js` | — | consistency_log | ALL | SPRINT 5 |
| ValidationManager | `telemetry/managers/ValidationManager.js` | — | consistency_log | ALL | SPRINT 5 |

---

## 5. Runtime Domains

The Runtime Layer is divided into 10 independent domains. Each domain is a single row in `runtime_domains`. Domains are independent — one domain's mutation does not lock another.

### 5.1 Domain: `live`
```
Owner:         server.js (Sprint 2: LiveDomainAdapter)
Write freq:    High — every trade open/close/snapshot
Contents:
  dailyTrades  INTEGER — trade opens today (resets at UTC midnight)
  openTrades   OBJECT  — {symbol → {symbol, side, pips, peak, breakEven, entryTime, signalId}}
  date         TEXT    — YYYY-MM-DD (UTC), when dailyTrades was last reset
  sequence     INTEGER — monotonically incrementing mutation counter
Critical:      Losing this domain = losing knowledge of open positions.
               Must be snapshotted before every OANDA call.
```

### 5.2 Domain: `shadowA`
```
Owner:         shadowlab.js / Engine A (Trend Engine)
Write freq:    Each ShadowLab cycle (~30s)
Contents:
  signalsSeen     INTEGER — lifetime count
  signalsBlocked  INTEGER — lifetime count
  lastEvalTs      TEXT    — ISO timestamp
  frozen          BOOLEAN — always true (Engine A is frozen)
```

### 5.3 Domain: `shadowB`
```
Owner:         shadowlab.js / Engine B (Candle Engine)
Write freq:    Each ShadowLab cycle (~30s)
Contents:      same schema as shadowA
  frozen          BOOLEAN — always true (Engine B is frozen)
```

### 5.4 Domain: `shadowC`
```
Owner:         shadowlab.js / Engine C (KNN Engine)
Write freq:    After each training cycle
Contents:
  datasetVersion  INTEGER — version of knowledge artifact currently loaded
  datasetSize     INTEGER — number of training examples
  lastTrainTs     TEXT    — ISO timestamp of last dataset update
  nearestK        INTEGER — current K parameter (default: 5)
  accuracy        REAL    — rolling accuracy on recent predictions (0–1)
```

### 5.5 Domain: `shadowD`
```
Owner:         shadowlab.js / Engine D (Meta Engine)
Write freq:    Every 100 closed trades
Contents:
  weightsVersion  INTEGER — version of knowledge artifact currently loaded
  lastTrainTs     TEXT    — ISO timestamp
  conditionCount  INTEGER — number of conditions tracked
  topConditions   ARRAY   — top 5 performing condition names
  confidence      REAL    — current model confidence (0–1)
```

### 5.6 Domain: `shadowM`
```
Owner:         shadowm.js (Trade Tracker / Exit Detector)
Write freq:    After every poll that finds new events
Contents:
  lastId      INTEGER — highest events.id processed (cursor)
  active      OBJECT  — signalId → tracking object (open trades only)
  knownSids   ARRAY   — all known signalIds (open + closed)
  pollCount   INTEGER — total polls this session
  lastPollTs  TEXT    — ISO timestamp of last poll
Critical:     lastId is the event cursor. Losing it = reprocessing trades = ghost positions.
```

### 5.7 Domain: `exitLab`
```
Owner:         shadowlab.js (Exit Lab / Exit Strategy Optimizer)
Write freq:    Each ShadowLab cycle
Contents:
  strategiesLoaded        ARRAY  — names of exit strategies loaded
  bestStrategy            TEXT   — current best-performing strategy
  strategyVersions        OBJECT — strategy → knowledgeArtifactVersion
  evaluationsThisSession  INTEGER
```

### 5.8 Domain: `telemetry`
```
Owner:         telemetry/index.js
Write freq:    After each logEvent() batch (~30s)
Contents:
  lastEventId  INTEGER — highest events.id written this session
  eventCount   INTEGER — total events written
  errorCount   INTEGER — DB write errors this session
  lastErrorTs  TEXT    — ISO timestamp of last error
  dbBackend    TEXT    — 'postgresql' or 'sqlite'
```

### 5.9 Domain: `scheduler`
```
Owner:         server.js (scheduling coordinator)
Write freq:    Each cycle boundary
Contents:
  nextCycleTs       TEXT    — ISO timestamp of next ShadowLab cycle
  lastCycleTs       TEXT    — ISO timestamp of last completed cycle
  cycleCount        INTEGER — total cycles this session
  shadowLabInterval INTEGER — current cycle interval in ms (adaptive)
  botPid            INTEGER — PID of running bot process (or null)
```

### 5.10 Domain: `meta`
```
Owner:         server.js (system metadata)
Write freq:    On boot, on shutdown, on status change
Contents:
  systemVersion     TEXT — "v40.1"
  schemaVersion     INTEGER — runtime_domains schema version
  bootCount         INTEGER — cumulative across all sessions, never reset
  uptimeStart       TEXT — ISO timestamp of this boot
  lastCleanShutdown TEXT — ISO timestamp of last graceful shutdown
  status            TEXT — 'HEALTHY' | 'DEGRADED' | 'HALTED'
Critical:     bootCount must be incremented on every restart.
              status=HALTED until RecoveryManager reports READY.
```

---

## 6. Manager Hierarchy

### 6.1 RuntimeDomainManager (Sprint 1 — IMPLEMENTED)

**Role:** Single owner of all 10 runtime domains. Gateway between engines and the `runtime_domains` table. Enforces optimistic locking, records full version history, provides snapshot and rollback.

**API:**
```javascript
// Lifecycle
rdm.init()                                    → { ok, tables[] }
rdm.shutdown()                                → void

// Core CRUD
rdm.createDomain(domain, value, opts)         → { created, row }
rdm.getDomain(domain)                         → { domain, version, value, updated_at, schema_ver }
rdm.listDomains()                             → [ row, ... ]
rdm.updateDomain(domain, value, opts)         → row
rdm.patchDomain(domain, patch, opts)          → row

// Optimistic locking (preferred for concurrent engines)
rdm.compareAndSwap(domain, expectedVer, val)  → { swapped, currentVersion, row }

// Snapshots
rdm.takeSnapshot(reason, opts)                → { snapshotId, createdAt, domainCount }
rdm.getSnapshot(id)                           → snapshot row
rdm.listSnapshots(limit)                      → [ snapshot, ... ]
rdm.restoreFromSnapshot(id, domains, opts)    → { restored[], snapshotId }

// Version history & rollback
rdm.getHistory(domain, limit)                 → [ history_row, ... ]
rdm.rollback(domain, targetVersion, opts)     → { domain, rolledBackTo, currentVersion }

// Audit
rdm.logConsistency(checkId, severity, desc, detail, opts) → { id, detectedAt }
rdm.resolveConsistency(id, resolution, opts)  → { id, resolvedAt }
rdm.runConsistencyCheck()                     → { checks, domains, issues, severity, detail[] }

// Health
rdm.ping()                                    → { ok, latencyMs }
rdm.getStats()                                → { domains, maxVersion, historyRows, snapshots, pool }
```

### 6.2 MemoryManager (Sprint 3 — ✅ COMPLETE)

**Role:** Owns the memory layer across **three tables**: `memory_events` (permanent append-first event memory), `memory_event_history` (append-only full-row audit snapshots), and `memory_entries` (KV/TTL working cache). The Sprint 3 design review upgraded the original "TTL-only" plan — a TTL cache cannot satisfy the Sacred Constraint, because expiry is deletion. Permanent memory and ephemeral cache are now physically separate tables.

**Status machine:** `ACTIVE ⇄ ARCHIVED`, `ACTIVE/ARCHIVED → CORRUPTED` (validator quarantine), `CORRUPTED → ACTIVE` (restore after repair). Rows are never deleted.

**Key contracts:**
- **Append-first:** `payload`, `event_type`, `occurred_at`, `runtime_domain`, `trade_intent_id`, `strategy_id`, `symbol`, `source`, `dedupe_key` are immutable forever. `appendMemory()` is the only way to add information (appends to the `context` JSONB array).
- **Invariant:** `memory_event_history` row count === `version` for every memory, always. Every mutation is SELECT FOR UPDATE + UPDATE + history INSERT in one transaction.
- **Idempotency:** `createMemory()` dedupes on `dedupe_key` (partial unique index + ON CONFLICT DO NOTHING); duplicates return the existing row with no history write.
- **Validation:** `validateMemory()` — structural damage → ERROR + CORRUPTED quarantine; referential orphans and version gaps → WARN only. All findings go to `consistency_log` (via `rdm.logConsistency()` when RDM is injected, direct INSERT otherwise).
- **Snapshots:** `summarizeMemory()` output feeds `system_snapshots.memory_summary` via `rdm.takeSnapshot(reason, { memorySummary })`.
- **KV cache:** `kvSet/kvGet/kvGetAll/kvGc` on `memory_entries` — namespace-isolated, TTL-expiring. `kvGc()` cannot touch event memory by construction.

```js
// Event memory (permanent, append-first)
mm.createMemory({event_type, payload, ...})     → { created, duplicate, row }
mm.appendMemory(id, addendum, opts)             → { row }   // the ONLY way to add info
mm.updateMemory(id, {importance|tags|reasoning|metadata}) → { row }
mm.tagMemory(id, {add, remove})                 → { row }
mm.archiveMemory(id, reason) / mm.restoreMemory(id, reason) → { row }
mm.getMemory(id) / mm.getMemoryHistory(id)      → row / history[]

// Query surface
mm.searchMemory({event_type, runtime_domain, strategy_id, symbol,
                 tagsAny, tagsAll, minImportance, text, since, until,
                 status, order, limit, offset})  → rows[]
mm.queryByDomain(domain, opts) / mm.queryByTrade(intentId, opts)
mm.queryByTime(since, until, opts) / mm.queryByStrategy(strategyId, opts)
mm.summarizeMemory({since})                     → { total, byEventType, byDomain,
                                                    byStatus, topTags, importance,
                                                    timeRange, historyRows, generatedAt }
mm.validateMemory({markCorrupted})              → { ok, checked, issues[], corrupted[] }

// KV cache (memory_entries — ephemeral working state)
mm.kvSet(ns, key, value, {ttlSeconds}) / mm.kvGet(ns, key)
mm.kvGetAll(ns) / mm.kvGc()                     → { removed }

// Health
mm.ping() / mm.getStats()
```

### 6.2b LiveMemoryIntegration (Sprint 4 — ✅ COMPLETE)

**Role:** The bridge between the manager tier (RDM + TIM + MM) and the running Live Engine (`telemetry/server.js`). Owns startup recovery, trade lifecycle memory hooks, periodic persistence, and graceful shutdown. Flag-gated by `SHADOW_OS_MEMORY` (default ON; `off` = zero behavior change).

**Key contracts:**
- **Never blocks trading** — every hook is best-effort try/catch; a memory failure degrades to no-op, it never throws into the trading path
- **Duplicate-startup protection** — pg session-scoped advisory lock (`LOCK_CLASS=21320`, `LOCK_OBJ=20307`) on a dedicated client; a second process degrades to observe-only; SIGKILL frees the lock automatically
- **Snapshot walk-back** — recovery loads the newest snapshot that passes checksum + history validation (up to `SNAPSHOT_WALKBACK_LIMIT=20` candidates); invalid snapshots are skipped and logged, NEVER deleted
- **Idempotency** — every write carries a `dedupe_key` (per-boot for recovery/shutdown/restart events, per-minute-bucket for trade events); restarts and retries can never double-write
- **Drift detection** — compares the replay-built `live` state against the v2 `live` domain and logs divergence to `consistency_log` (observe-only in Sprint 4; the v2 store does not yet drive trading)
- **Bounded shutdown** — flush in-flight writes (allSettled + timeout) → SYSTEM_SHUTDOWN event → final snapshot → lock release, all under the server's hard 5s exit deadline

**Public API:**
```js
const lmi = new LiveMemoryIntegration({ calledBy, connectionString | _pool, enabled });
await lmi.init()                                  → { ok } (degrades to no-op on failure)
await lmi.recoverOnStartup({ liveState })         → { recovered, lockAcquired, snapshotId,
                                                      domains, openIntents, memoryTotal,
                                                      quarantined, drift, durationMs, bootId }
await lmi.recordTradeOpen({ symbol, side, ... })  → idempotent TRADE_OPENED event
await lmi.recordTradeClose({ symbol, reason, profit, ... }) → idempotent TRADE_CLOSED event
await lmi.recordBotRestart({ exitCode, restartCount })      → idempotent BOT_RESTART event
lmi.startPeriodicPersistence(intervalMs)          → periodic snapshot + memory summary
await lmi.gracefulShutdown({ timeoutMs, reason }) → { ok, steps: { flushed, finalEvent,
                                                      finalSnapshot, lockReleased } }
lmi.getStatus()                                   → counters, bootId, lock state
```

**server.js hook points (all flag-gated):** startup after `restoreLiveState()`; trade open (openM stdout branch); trade close (exit-block parser); bot restart loop; SIGTERM/SIGINT graceful exit (bot killed first, 4s memory budget, hard 5s unref'd exit); `GET /api/memory-integration/status`.

### 6.2c ShadowLabManager (Sprint 5 — Shadow LAB Foundation — ✅ COMPLETE)

**Role:** A **research-only measurement layer**. It reconciles the append-only `events` stream into structured, fully-provenanced research tables and computes trade **expectancy** over them — answering *"what is the system actually learning?"* — with **zero** effect on live trading. Flag-gated by `SHADOW_LAB_RESEARCH` (default **OFF**; off = the reconciler never starts and behaviour is unchanged).

**Key contracts:**
- **Never touches live trading** — `index.js` (Engine A/B/C/D decisions) is untouched; the layer is a downstream reader of `events` only. Every projection/persist/snapshot is best-effort try/catch and degrades to no-op on failure.
- **Additive / append-first / idempotent / reversible** — all DDL is `CREATE TABLE IF NOT EXISTS`; every insert is `ON CONFLICT (dedupe_key) DO NOTHING`. No `DROP`/`DELETE`/`TRUNCATE`. Turning the flag off (and redeploying) fully reverts behaviour; the append-only research tables remain.
- **Full provenance** — every research row carries the triple `run_id` + `build_id` + `config_hash` plus a `dedupe_key`. `config_hash` is deterministic (SHA-256 over a canonical sorted-key JSON of the decision-relevant config surface + version), so every measurement is reproducible from the exact code + configuration that produced it.
- **Cursor-based & resumable** — a persisted cursor (an append-only `events` row of type `shadowlab_research_cursor`) lets the reconciler resume after a restart and replay from scratch if needed.
- **`events.data` agnostic** — a single `parseData` helper handles the column as BOTH `TEXT` and `JSONB` (production is `TEXT`).
- **Abstention preserved** — engine "no decision" is stored as `would_trade IS NULL` (never coerced to `false`); a missing winrate is `NULL` (never coerced to `0`).
- **Confidence auto-computed** — `confidence_level` is derived from `resolved_trades` (LOW <30, MEDIUM 30–100, HIGH >100), keeping snapshots self-consistent with their `(config_hash, scope, resolved_trades)` dedupe identity.

**Projections:** `trade_open → shadow_signals`, `lab_shadow_a/b/c/d → shadow_engine_evals`, `trade_close → shadow_outcomes`; expectancy time series → `shadow_expectancy_snapshots`.

**Public API:**
```js
const lab = new ShadowLabManager({ db, env, enabled });
await lab.reconcileOnce()                → { scanned, inserted, cursor }  (idempotent, best-effort)
await lab.reconcileAll()                 → drains the backlog in batches
await lab.recoverCursor()                → resumes the persisted cursor after restart
lab.start(intervalMs) / lab.stop()       → flag-gated polling (timer unref'd)
lab.computeExpectancy(scope)             → { resolvedTrades, wins, losses, breakevens,
                                             expectancyPips, profitFactor, confidenceLevel, ... }
await lab.snapshotExpectancy(scope)      → idempotent time-series append
lab.getExpectancy / getResearchSummary / getTimeseries → read APIs for the endpoints
```

**server.js surface (all read-only, additive):** `GET /api/lab/expectancy`, `GET /api/lab/research/summary`, `GET /api/lab/research/timeseries` — each reports `researchEnabled`. The reconciler start is gated on `SHADOW_LAB_RESEARCH` inside `app.listen`.

### 6.3 KnowledgeManager (Sprint 6 — Knowledge Manager Foundation — ✅ COMPLETE)

**Role:** A **read-only knowledge layer**. It organizes the **measured** Shadow LAB research (the `shadow_*` tables) into **versioned, immutable, content-addressed, fully-provenanced** knowledge artifacts — answering *"what does the system now know, and how confident is it?"* — with **zero** effect on live, shadow, or risk decisions. Flag-gated by `KNOWLEDGE_LAYER` (default **OFF**; off = the builder never starts and behaviour is unchanged).

**Key contracts:**
- **Never influences trading** — reads ONLY `shadow_*` research (+ the `events` they derive from) and writes ONLY the `knowledge_*` tables. No feedback path into live/shadow/risk. `index.js` untouched.
- **Content-addressed (load-bearing invariant)** — an artifact's checksum is computed over its built **content ONLY**; provenance (`run_id`/`build_id`/`config_hash`) lives in dedicated columns, never inside `value`. A restart/redeploy (new `run_id`) rebuilding identical research mints **no** new version — knowledge accumulates, never churns. Any provenance leak into content is a bug.
- **Versioned & immutable** — `upsertVersion` is a compare-and-set: unchanged content is a true no-op; changed content inserts a new version, supersedes the prior active row (`superseded_at`), and records a `migration_from` chain — all in one PG transaction. Exactly one active row per `(domain, artifact)`.
- **Additive / append-first / idempotent / reversible** — all DDL is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`; the manifest snapshot dedupes on `manifest_checksum`. No `DROP`/`DELETE`/`TRUNCATE`. Turning the flag off (and redeploying) fully reverts behaviour; the append-first knowledge tables remain.
- **Abstention-aware** — null-safe helpers honour the `Number(null) === 0` trap; an abstaining engine's "no winrate" stays `null`, never a fabricated `0`.

**Seven artifacts (each a pure SQL aggregation over `shadow_*`):** `expectancy/history`, `engines/statistics`, `patterns/validated`, `market/fingerprints`, `config/history`, `confidence/history`, `experiments/metadata`.

**Public API:**
```js
const km = new KnowledgeManager({ db, env });   // construction is side-effect-free (no timer, no writes)
await km.snapshotAll()          → { ok, changed, results, snapshot }  (build 7 → CAS-upsert → manifest)
km.start() / km.stop()          → flag-gated unref'd 15-min poll (never keeps the process alive)
km.getStatistics()              → store stats + last build + provenance
km.getArtifact(domain, artifact, { version?, history? })
km.listArtifacts() / km.listSnapshots(limit) / km.exportAll()
```

**server.js surface (all read-only, additive):** `GET /api/knowledge/status`, `/api/knowledge/artifacts`, `/api/knowledge/artifacts/:domain/:artifact` (`?version=` / `?history=1`), `/api/knowledge/snapshots`, `/api/knowledge/export` — each reports `knowledgeEnabled`. The builder start is gated on `KNOWLEDGE_LAYER` inside `app.listen`.

### 6.4 RecoveryManager (Later Sprint — Planned)

**Role:** Runs all recovery phases after process restart or failure. Blocks trading until recovery completes. Uses consistency_log to record all decisions.

**Nine recovery phases:**
1. DB connectivity check
2. Schema integrity check (all 10 tables present)
3. Domain integrity check (all 10 domains present, valid JSON)
4. Event cursor validation (shadowM.lastId vs events table MAX)
5. Open position reconciliation (runtime.live vs events)
6. Knowledge artifact integrity (checksums)
7. Memory GC (clear expired entries)
8. Snapshot creation (pre-trading baseline)
9. Status update (meta.status = HEALTHY or DEGRADED)

### 6.5 ValidationManager (Later Sprint — Planned)

**Role:** Runs periodic consistency checks every 5 minutes. Classifies issues by severity. Auto-repairs known patterns (INFO and WARN), logs CRITICAL issues for human review.

---

## 7. Lifecycle Diagrams

### 7.1 Normal Startup Sequence

```
Process starts: node telemetry/server.js
│
├─ 1. require('./index') → db-adapter initialized, emitter created
│
├─ 2. require('./shadowlab') → ShadowLab engines loaded (no DB yet)
│
├─ 3. require('./shadowm') → ShadowM loaded (no DB yet)
│
├─ 4. restoreLiveState() ← reads events table for open positions
│   └─ [FUTURE Sprint 2] RuntimeDomainManager.getDomain('live') replaces this
│
├─ 5. Express API starts on PORT
│
├─ 6. Bot process spawned: spawn('node', ['index.js'])
│   └─ index.js: FROZEN. Reports trades via stdout. Never touches DB directly.
│
├─ 7. shadowM.start() ← begins polling events table every 2s
│   └─ [FUTURE Sprint 2] Uses RuntimeDomainManager for shadowM domain state
│
├─ 8. shadowLab() cycle begins every 30s
│   └─ [FUTURE Sprint 2] Uses RuntimeDomainManager for shadowA–D, exitLab domains
│
└─ SYSTEM OPERATIONAL

[SHADOW OS v2 full startup — Sprint 5+]
│
├─ 1. RecoveryManager.runRecovery() ← all 9 phases
│
├─ 2. RuntimeDomainManager.init() ← validate tables
│
├─ 3. RuntimeDomainManager.getDomain('meta').bootCount++
│
├─ 4. RuntimeDomainManager.getDomain('meta').status = 'HEALTHY'
│
├─ 5. RuntimeDomainManager.takeSnapshot('boot')
│
└─ SYSTEM OPERATIONAL
```

### 7.2 Railway Restart Sequence

```
Railway SIGTERM received
│
├─ 1. server.js: graceful shutdown handler
│   ├─ Stop accepting new OANDA trade signals
│   ├─ [FUTURE Sprint 2] RuntimeDomainManager.updateDomain('meta',
│   │   { status: 'HALTED', lastCleanShutdown: new Date().toISOString() })
│   ├─ [FUTURE Sprint 2] RuntimeDomainManager.takeSnapshot('clean_shutdown')
│   └─ Kill bot process (SIGTERM → SIGKILL after 10s)
│
├─ 2. Process exits cleanly
│
└─ [Railway restarts container]

Post-restart:
├─ 1. [FUTURE Sprint 5] RecoveryManager.runRecovery()
│   ├─ Phase 4: validate event cursor (shadowM.lastId)
│   ├─ Phase 5: reconcile open positions (live.openTrades vs events)
│   ├─ Phase 8: take 'post_recovery' snapshot
│   └─ Phase 9: meta.status = 'HEALTHY'
│
└─ Normal startup continues
```

### 7.2b Startup Schema Auto-Migration (Sprint 4.1)

```
Boot on PostgreSQL (DATABASE_URL set — Railway managed):
│
├─ LiveMemoryIntegration.init()
│   ├─ create shared pg Pool
│   ├─ ensureSchema(pool)   ← Sprint 4.1
│   │   ├─ pg_advisory_lock(21320, 40911)  (serialize redeploy overlap)
│   │   ├─ CREATE TABLE IF NOT EXISTS schema_migrations
│   │   ├─ for each 001..004 not yet applied:
│   │   │   ├─ pool.query(<entire file>)  (simple protocol; one implicit txn;
│   │   │   │   parses DO $$..$$ blocks; NO psql binary; NO JS splitter)
│   │   │   └─ INSERT filename INTO schema_migrations
│   │   └─ pg_advisory_unlock(...)
│   └─ construct + init RDM / TIM / MM  (schema now guaranteed to exist)
│
└─ Idempotent + data-safe: all DDL is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
   ON CONFLICT DO NOTHING. No DROP / TRUNCATE / DELETE. A failure degrades the
   memory layer to no-op and NEVER blocks trading.

Fresh Railway PostgreSQL service → first boot creates the full v2 schema
automatically → all trading history, memory, snapshots and recovery data
persist across every subsequent deploy. SQLite remains a local-dev-only
fallback; no filesystem/volume persistence is used.
```

### 7.3 Power Failure / Mid-Transaction Recovery

```
Power failure during RuntimeDomainManager.updateDomain():
│
├─ PostgreSQL: transaction is NOT committed → automatic rollback
│   (domain retains its prior version — data is safe)
│
├─ runtime_domain_history: no orphan row (history written in same transaction)
│
└─ On next startup:
    ├─ RecoveryManager reads last known domain state from runtime_domains
    ├─ Detects discrepancy vs events table (if any)
    ├─ Logs to consistency_log
    └─ Repairs or flags for human review

Key property: PostgreSQL transactional integrity means a power failure
never corrupts the domain store. The worst case is "stale by one update".
```

---

## 8. Data Flow Diagrams

### 8.1 Trade Open Flow (Current — pre-SHADOW OS v2)

```
OANDA market movement
        │
        ▼
index.js (FROZEN)
  shadowGate() → evaluates conditions → OPEN signal
        │
        ▼
stdout: "Trade -> EUR_USD BUY"
        │
        ▼
server.js: handleBotLine()
  live.openTrades[symbol] = { ... }    ← IN-MEMORY ONLY
  broadcastSSE(trade_opened)
        │
        ▼
telemetry/index.js: logEvent({ type: 'trade_open', ... })
  INSERT INTO events ...               ← PERSISTED
```

### 8.2 Trade Open Flow (SHADOW OS v2 — Sprint 2+)

```
OANDA market movement
        │
        ▼
index.js (FROZEN — unchanged)
  shadowGate() → OPEN signal → stdout
        │
        ▼
server.js: handleBotLine()
        │
        ▼
TradeIntentManager (Sprint 2)
  trade_intents INSERT (PENDING)       ← Intent committed BEFORE any action
        │
        ▼
OANDA API call
        │
        ▼
RuntimeDomainManager.compareAndSwap('live', currentVersion, {
  ...live, openTrades: { ...live.openTrades, [symbol]: {...} }
})                                     ← Atomic version-checked write
        │
        ▼
TradeIntentManager: intent status = CONFIRMED
        │
        ▼
telemetry/index.js: logEvent({ type: 'trade_open', ... })  ← Event log
```

### 8.3 ShadowLab Cycle Flow (Sprint 2+)

```
Scheduler: 30s interval
        │
        ▼
RuntimeDomainManager.getDomain('scheduler')
  → reads lastCycleTs, cycleCount
        │
        ▼
ShadowLab cycle:
  Engine A (frozen) → signals evaluated
  Engine B (frozen) → confirms
  Engine C (KNN)    → KnowledgeManager.loadArtifact('engineC/dataset')
  Engine D (Meta)   → KnowledgeManager.loadArtifact('engineD/weights')
  Exit Lab          → evaluates open positions
        │
        ▼
For each domain state change:
  RuntimeDomainManager.compareAndSwap(domain, version, newValue)
        │
        ▼
RuntimeDomainManager.updateDomain('scheduler', {
  lastCycleTs: now, cycleCount: cycleCount + 1, ...
})
```

---

## 9. Component Interaction Matrix

### 9.1 Who writes to what (Sprint 1 baseline)

| Writer → | runtime_domains | runtime_domain_history | system_snapshots | consistency_log | events | shadowm_trades | knowledge_artifacts | memory_entries | trade_intents |
|----------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| RuntimeDomainManager | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| server.js (current) | ✅ direct | — | — | — | — | — | — | — | — |
| shadowm.js (current) | ✅ direct | — | — | — | — | ✅ | — | — | — |
| shadowlab.js (current) | ✅ direct | — | — | — | — | — | ✅ | — | — |
| telemetry/index.js | — | — | — | — | ✅ | — | — | — | — |
| MemoryManager (S3) | — | — | — | ✅ | — | — | — | ✅ | — |
| KnowledgeManager (S4) | — | — | — | — | — | — | ✅ | — | — |
| RecoveryManager (S5) | — | — | ✅ | ✅ | — | — | — | — | — |

> MemoryManager (Sprint 3) also owns two tables added in Migration 004 and not shown as columns above: `memory_events` and `memory_event_history` (writer: MemoryManager only; history is append-only, never deleted).

### 9.2 Domain ownership

| Domain | Current Writer | SHADOW OS v2 Writer (target) |
|--------|---------------|-------------------------------|
| live | server.js (in-memory + direct DB) | RuntimeDomainManager via LiveDomainAdapter (S2) |
| shadowA | shadowlab.js (direct) | RuntimeDomainManager via ShadowLabAdapter (S2) |
| shadowB | shadowlab.js (direct) | RuntimeDomainManager via ShadowLabAdapter (S2) |
| shadowC | shadowlab.js (direct) | RuntimeDomainManager via ShadowLabAdapter (S2) |
| shadowD | shadowlab.js (direct) | RuntimeDomainManager via ShadowLabAdapter (S2) |
| shadowM | shadowm.js (direct) | RuntimeDomainManager via ShadowMAdapter (S2) |
| exitLab | shadowlab.js (direct) | RuntimeDomainManager via ShadowLabAdapter (S2) |
| telemetry | telemetry/index.js (direct) | RuntimeDomainManager via TelemetryAdapter (S2) |
| scheduler | server.js (direct) | RuntimeDomainManager via SchedulerAdapter (S2) |
| meta | server.js (direct) | RuntimeDomainManager via MetaAdapter (S2) |

---

## 10. Database Schema

### 10.1 Complete Schema (Sprints 0 + 1)

```sql
-- ── Sprint 0: Foundation ─────────────────────────────────────────────────

-- Existing (unchanged)
CREATE TABLE events (
  id     BIGSERIAL PRIMARY KEY,
  ts     TEXT      NOT NULL,
  bot_id TEXT,
  type   TEXT      NOT NULL,
  symbol TEXT,
  data   JSONB
);

CREATE TABLE shadowm_trades (
  id            BIGSERIAL PRIMARY KEY,
  signal_id     TEXT      UNIQUE NOT NULL,
  symbol        TEXT, side TEXT, entry_time TEXT, exit_time TEXT,
  best_strategy TEXT, profit_live DOUBLE PRECISION, profit_saved DOUBLE PRECISION,
  mfe DOUBLE PRECISION, mae DOUBLE PRECISION, data JSONB
);

CREATE TABLE shadowm_timeline (
  id BIGSERIAL PRIMARY KEY, signal_id TEXT NOT NULL, ts TEXT NOT NULL,
  pips DOUBLE PRECISION, mfe DOUBLE PRECISION, mae DOUBLE PRECISION, minutes DOUBLE PRECISION
);

-- SHADOW OS v2 new tables (Sprint 0)
CREATE TABLE runtime_domains (
  domain      TEXT        PRIMARY KEY,
  version     BIGINT      NOT NULL DEFAULT 0,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER     NOT NULL DEFAULT 1
);

CREATE TABLE trade_intents (
  id BIGSERIAL PRIMARY KEY, signal_id TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK (intent_type IN ('OPEN','CLOSE','MODIFY')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CONFIRMED','FAILED','RECONCILED')),
  oanda_order_id TEXT, symbol TEXT NOT NULL, side TEXT,
  payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ, failure_reason TEXT,
  UNIQUE (signal_id, intent_type)
);

CREATE TABLE memory_entries (
  id BIGSERIAL PRIMARY KEY, namespace TEXT NOT NULL, key TEXT NOT NULL,
  value JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ,
  access_count BIGINT NOT NULL DEFAULT 0, tags TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (namespace, key)
);

CREATE TABLE knowledge_artifacts (
  id BIGSERIAL PRIMARY KEY, domain TEXT NOT NULL, artifact TEXT NOT NULL,
  version BIGINT NOT NULL, value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), superseded_at TIMESTAMPTZ,
  checksum TEXT NOT NULL, byte_size INTEGER, training_events INTEGER,
  confidence DOUBLE PRECISION, migration_from BIGINT REFERENCES knowledge_artifacts(id),
  notes TEXT
);

CREATE TABLE event_idempotency (
  key TEXT PRIMARY KEY, event_id BIGINT REFERENCES events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE consistency_log (
  id BIGSERIAL PRIMARY KEY, check_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  domain TEXT, description TEXT NOT NULL, detail JSONB,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ,
  resolution TEXT, auto_repaired BOOLEAN NOT NULL DEFAULT FALSE, repair_detail JSONB
);

CREATE TABLE system_snapshots (
  id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_type TEXT NOT NULL, runtime_summary JSONB NOT NULL,
  memory_summary JSONB NOT NULL, knowledge_summary JSONB NOT NULL,
  system_status TEXT NOT NULL
);

-- ── Sprint 1: Runtime Awakening ──────────────────────────────────────────

CREATE TABLE runtime_domain_history (
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
```

### 10.2 Index Inventory (by table)

| Table | Index | Type | Purpose |
|-------|-------|------|---------|
| events | idx_events_type | BTREE | type filter |
| events | idx_events_ts | BTREE DESC | time-range |
| events | idx_events_type_id | BTREE | type+cursor |
| shadowm_trades | idx_smt_signal_id | BTREE | signal lookup |
| shadowm_trades | idx_smt_exit_time | BTREE | time-range |
| shadowm_timeline | idx_smt_signal | BTREE | signal lookup |
| trade_intents | idx_ti_pending | BTREE (partial) | PENDING status |
| memory_entries | idx_mem_ns | BTREE | namespace |
| memory_entries | idx_mem_expires | BTREE (partial) | GC queries |
| memory_entries | idx_mem_tags | GIN | tag search |
| knowledge_artifacts | idx_ka_active | UNIQUE (partial) | active artifact |
| knowledge_artifacts | idx_ka_history | BTREE | version history |
| knowledge_artifacts | idx_ka_checksum | UNIQUE | dedup |
| event_idempotency | idx_eidem_created | BTREE | TTL cleanup |
| consistency_log | idx_clog_open | BTREE (partial) | open issues |
| consistency_log | idx_clog_sev | BTREE | severity+time |
| consistency_log | idx_clog_chk | BTREE | check_id+time |
| system_snapshots | idx_snap_created | BTREE DESC | recent snapshots |
| runtime_domain_history | idx_rdh_domain_ver | BTREE | domain+version |
| runtime_domain_history | idx_rdh_changed_at | BTREE DESC | time-range |
| runtime_domain_history | idx_rdh_snapshot | BTREE (partial) | snapshot lookup |

---

## 11. API Contracts

### 11.1 RuntimeDomainManager Error Contracts

All public methods:
- Throw `Error` with a descriptive message on unexpected DB failures
- `compareAndSwap` does NOT throw on version mismatch — it returns `{ swapped: false }`
- `createDomain` does NOT throw if domain exists — returns `{ created: false, row: existing }`
- `getDomain` does NOT throw if domain not found — returns `null`
- Every error message starts with `RuntimeDomainManager.<methodName>:`

### 11.2 Optimistic Locking Protocol

```
Engine wants to update domain 'shadowM':

1. row = await rdm.getDomain('shadowM')
   // row.version = 42

2. newValue = { ...row.value, lastId: newEventId }

3. result = await rdm.compareAndSwap('shadowM', 42, newValue)

4a. result.swapped === true → success, proceed
4b. result.swapped === false →
      current = await rdm.getDomain('shadowM')
      // re-read, re-apply changes, retry
      // Max retries: 3 (configurable)
      // After 3 failures: log WARN to consistency_log, use updateDomain() instead
```

### 11.3 Snapshot Contract

Snapshots are full system state captures. They are NOT a backup of domain values — they store checksums in `runtime_summary`. The actual domain values are reconstructed from `runtime_domain_history` using the `snapshot_id` FK.

This means: a snapshot without associated history records cannot be restored. The `takeSnapshot()` method writes both the snapshot row AND the history records in separate transactions. A partial failure (snapshot written, history not written) will be detected by `restoreFromSnapshot()` and throw.

### 11.4 History Retention Policy

| Condition | Retention |
|-----------|-----------|
| snapshot_id IS NOT NULL | Forever (linked to snapshot) |
| change_op = 'CREATE' | Forever (domain provenance) |
| change_op = 'ROLLBACK' | Forever (audit of corrections) |
| Others, age > 90 days | Eligible for GC (future ValidationManager job) |

---

## 12. Recovery Sequences

### 12.1 Normal Recovery (clean restart)

```
Phase 1: DB Connectivity
  → pool.query('SELECT 1') with 10s timeout
  → FAIL: HALT, retry every 30s (5 attempts), then alert

Phase 2: Schema Integrity
  → Check all 11 tables exist in information_schema.tables
  → FAIL: HALT if runtime_domain_history or runtime_domains missing
  → WARN: If optional tables missing (memory_entries, etc.) — log CRITICAL

Phase 3: Domain Integrity
  → All 10 domains present with valid JSON values
  → FAIL: Run createDomain() with DEFAULT_DOMAINS values for missing ones
  → Log each repair as consistency_log WARN

Phase 4: Event Cursor Validation
  → SELECT MAX(id) FROM events vs shadowM.lastId
  → If MAX > lastId: ShadowM needs to catch up (not a problem)
  → If lastId > MAX+buffer: corruption detected → WARN

Phase 5: Open Position Reconciliation
  → Rebuild live.openTrades from events (opens minus closes)
  → Compare to runtime_domains 'live' value
  → Discrepancy → use events-derived value (events are source of truth for positions)
  → Log discrepancy to consistency_log

Phase 6: Knowledge Integrity
  → For each active knowledge_artifact: verify checksum
  → Checksum mismatch → CRITICAL → rollback to prior version

Phase 7: Memory GC
  → DELETE FROM memory_entries WHERE expires_at < NOW()

Phase 8: Baseline Snapshot
  → RuntimeDomainManager.takeSnapshot('post_recovery')

Phase 9: Status Update
  → meta.status = 'HEALTHY' (all phases OK) or 'DEGRADED' (some issues)
  → bootCount++
  → uptimeStart = NOW()
```

### 12.2 Corruption Recovery

```
Corruption detected in domain 'shadowM':
  - value is not a valid JSON object
  - version has jumped unexpectedly
  - critical field missing

Step 1: Log to consistency_log (CRITICAL)
Step 2: Search runtime_domain_history for most recent valid state
Step 3: RuntimeDomainManager.rollback('shadowM', lastValidVersion)
Step 4: Verify rollback succeeded (getDomain + schema check)
Step 5: Log resolution to consistency_log
Step 6: Continue recovery
```

### 12.3 Database Reconnect

```
Pool connection dropped:
  → pg Pool auto-reconnects on next query
  → If connection fails 3 times in 10s:
       → Log CRITICAL to consistency_log (if DB available) or to stderr
       → Stop accepting new trade signals
       → Keep alive (don't exit — Railway will restart if exit code non-zero)
  → On reconnect:
       → Run Phase 3 (domain integrity check only — fast path)
       → Resume operations
```

---

## 13. Failure Modes and Mitigations

| Failure | Detection | Mitigation | Severity |
|---------|-----------|------------|----------|
| Domain value corrupted | runConsistencyCheck() / startup Phase 3 | Rollback to last history entry | CRITICAL |
| Version jump (skipped versions) | Consistency check Phase 3 | Log + investigate; may indicate multiple writers | WARN |
| Snapshot missing history | restoreFromSnapshot() throws | Log CRITICAL; use prior snapshot | CRITICAL |
| DB unavailable at startup | Phase 1 timeout | Retry 5×, then HALT | CRITICAL |
| Mid-transaction failure | PostgreSQL rollback | Domain retains prior version; retry on next cycle | INFO |
| CAS conflict (concurrent write) | swapped=false | Retry with fresh getDomain(); max 3 retries | WARN |
| history table missing | Phase 2 | HALT; require migration to run | CRITICAL |
| bootCount not incrementing | meta domain check | Repair via updateDomain; log WARN | WARN |
| Event cursor inconsistency | Phase 4 | Use events table MAX as authoritative | WARN |
| knowledge_artifact checksum mismatch | Phase 6 | Rollback artifact; log CRITICAL | CRITICAL |

---

## 14. Implementation Status

| Component | Sprint | Status | Tests |
|-----------|--------|--------|-------|
| DB Schema (10 tables) | 0 | ✅ COMPLETE | 19 tests passing |
| Dead code archive | 0 | ✅ COMPLETE | n/a |
| Test framework | 0 | ✅ COMPLETE | operational |
| runtime_domain_history table | 1 | ✅ COMPLETE | — |
| RuntimeDomainManager | 1 | ✅ COMPLETE | — |
| Unit tests | 1 | ✅ COMPLETE | — |
| Integration tests | 1 | ✅ COMPLETE | — |
| Simulation tests | 1 | ✅ COMPLETE | — |
| Stress tests | 1 | ✅ COMPLETE | — |
| TradeIntentManager | 2 | ✅ COMPLETE | 169 tests |
| LiveDomainAdapter | 2 | ⏳ PLANNED | — |
| ShadowMAdapter | 2 | ⏳ PLANNED | — |
| ShadowLabAdapter | 2 | ⏳ PLANNED | — |
| MemoryManager | 3 | ✅ COMPLETE | 101 tests |
| LiveMemoryIntegration (server.js wiring) | 4 | ✅ COMPLETE | 21 tests |
| Startup schema auto-migration (autoMigrate) | 4.1 | ✅ COMPLETE | 4 tests |
| ShadowLabManager (Shadow LAB Foundation — research layer) | 5 | ✅ COMPLETE | 23 tests |
| KnowledgeManager (Knowledge Manager Foundation — read-only knowledge layer) | 6 | ✅ COMPLETE | 27 tests |
| RecoveryManager | 7 | ⏳ PLANNED | — |
| ValidationManager | 7 | ⏳ PLANNED | — |

---

## 15. Sprint Roadmap

| Sprint | Name | Core Deliverable | Key Risk |
|--------|------|-----------------|----------|
| 0 | Foundation | DB schema, test framework, dead code archive | Idempotent migration |
| 1 | Runtime Awakening | RuntimeDomainManager — complete domain ownership | Optimistic locking under concurrency |
| 2 | Domain Wiring | Adapters — connect existing engines to RDM | Behavior regression in server.js, shadowm.js |
| 3 | Memory OS | MemoryManager — append-first permanent event memory + TTL cache | Append-first invariants, crash durability |
| 4 | Live Memory Integration ✅ | LiveMemoryIntegration — wire RDM+TIM+MM into server.js (recovery, hooks, shutdown) | Blocking the trading path (mitigated: flag-gated, best-effort) |
| 5 | Shadow LAB Foundation ✅ | ShadowLabManager — research-only measurement layer (event→research reconciler + expectancy), flag-gated `SHADOW_LAB_RESEARCH` off=no-op | Coupling to / regression in live trading (mitigated: read-only, additive, `index.js` untouched) |
| 6 | Knowledge OS ✅ | KnowledgeManager — read-only knowledge layer (research→versioned, content-addressed artifacts), flag-gated `KNOWLEDGE_LAYER` off=no-op | Checksum integrity / version churn (mitigated: content-only checksums, read-only, `index.js` untouched) |
| 7 | Recovery OS | RecoveryManager + ValidationManager | Complex state repair logic |
| 8 | Intelligence | Incremental training, startup < 50ms at scale | Knowledge artifact size growth |

**Design horizon:** 5 years of continuous operation, 100,000+ closed trades, 10+ concurrent engines.

---

*MASTER_ARCHITECTURE.md — FOREX ENGINE PRO — SHADOW OS v2*  
*Single Source of Truth — Generated Sprint 1 — 2026-07-06*  
*Next review: Sprint 2 (Domain Wiring)*
