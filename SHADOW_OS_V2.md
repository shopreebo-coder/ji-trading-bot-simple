# SHADOW OS v2
## Next-Generation Operating System for FOREX ENGINE PRO

**Classification:** Senior Architecture Design Document — Principal Systems Architect Review  
**Baseline:** SHADOW OS v1 / Architecture B (Continuous State Checkpointing) — approved  
**Status:** Awaiting implementation approval  
**Date:** 2026-06-30  
**Author:** Systems Architecture Review  

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Section 1 — Design Philosophy](#section-1--design-philosophy)
- [Section 2 — Four-Layer Memory Hierarchy](#section-2--four-layer-memory-hierarchy)
- [Section 3 — Runtime Layer](#section-3--runtime-layer)
- [Section 4 — Memory Layer](#section-4--memory-layer)
- [Section 5 — Knowledge Layer](#section-5--knowledge-layer)
- [Section 6 — Event Log](#section-6--event-log)
- [Section 7 — Manager Tier (API Contract)](#section-7--manager-tier-api-contract)
- [Section 8 — Recovery Manager](#section-8--recovery-manager)
- [Section 9 — State Validation System](#section-9--state-validation-system)
- [Section 10 — Learning Pipeline](#section-10--learning-pipeline)
- [Section 11 — Plugin Architecture](#section-11--plugin-architecture)
- [Section 12 — Architecture Diagrams](#section-12--architecture-diagrams)
- [Section 13 — Failure Simulations](#section-13--failure-simulations)
- [Section 14 — Formal Verification (Adversarial Review)](#section-14--formal-verification-adversarial-review)
- [Section 15 — Comparison Matrix](#section-15--comparison-matrix)
- [Section 16 — Implementation Plan](#section-16--implementation-plan)
- [Section 17 — Bonus: Five Strategic Questions](#section-17--bonus-five-strategic-questions)
- [Appendix A — Complete Database DDL](#appendix-a--complete-database-ddl)
- [Appendix B — Full Interface Specifications](#appendix-b--full-interface-specifications)
- [Appendix C — Configuration Reference](#appendix-c--configuration-reference)

---

## Executive Summary

Architecture B (Continuous State Checkpointing) solved the fundamental persistence problem: runtime state now survives any process death. This is necessary but insufficient.

FOREX ENGINE PRO is not a simple stateful service. It is an autonomous multi-engine trading platform that accumulates learned intelligence over months of operation, maintains rich short-term market context, coordinates multiple AI subsystems, and must make financial decisions with sub-second latency under any failure condition.

Architecture B treats all state as equivalent — a flat `runtime_state` table with JSONB blobs. It does not distinguish between:
- **Fast-changing operational state** (trade open/close, daily counter) — needs millisecond writes
- **Medium-term context** (market cooldowns, decision history, volatility) — needs TTL-based lifecycle
- **Slowly-evolving learned intelligence** (KNN weights, strategy rankings, engine parameters) — needs versioning, rollback, and corruption protection

The consequence: after every restart, Engine C rebuilds its KNN dataset from scratch, Engine D recomputes its meta-weights from history, and the system has no memory of recent market context or past decisions. The bot restarts intellectually blank, even though months of learning exist in the database.

**SHADOW OS v2** redesigns the storage and coordination model into a proper operating system:

| Component | Analogous to | Responsibility |
|-----------|-------------|----------------|
| Manager Tier | OS Kernel | Mediates all resource access; engines never touch DB directly |
| Runtime Layer | CPU registers + RAM | Operational state: live trades, domain cursors, process coordination |
| Memory Layer | Paged virtual memory | Contextual memory with TTL: cooldowns, market state, decision history |
| Knowledge Layer | Persistent disk storage | Learned intelligence: weights, datasets, statistics — never rebuilt from scratch |
| Event Log | Audit journal | Immutable record; used for compliance and replay, never for recovery |

**Key improvements over Architecture B:**

1. **Learning continuity** — Engine C, D, and Exit Lab accumulate knowledge across restarts. At 10,000 historical trades, startup is 150ms, not 30 seconds.
2. **Context continuity** — Cooldowns, decision history, and market context survive restarts. The bot remembers it was in cooldown on EUR_USD during the London session.
3. **Intellectual integrity** — Knowledge is versioned. A bad training batch does not permanently corrupt learned weights — rollback to previous version in one command.
4. **API isolation** — No engine module writes directly to PostgreSQL. All access goes through the Manager Tier. This enables future migration, testing, and multi-instance deployment.
5. **Automated consistency** — A ValidationManager runs every 5 minutes, classifies inconsistencies, and auto-repairs known patterns.
6. **Plugin extensibility** — New engines (Risk Engine, Portfolio Engine, AI Coach) implement a standard interface and register with the Manager Tier. Zero redesign.

**Production Readiness Assessment:** SHADOW OS v2 is production-ready for a 5–10 year operational horizon. Architecture B is production-ready for 1–2 years.

---

## Section 1 — Design Philosophy

### 1.1 From Persistence to Operating System

Architecture B answered: *"How do we prevent runtime state from being lost?"*

SHADOW OS v2 answers: *"How do we design a platform that an autonomous AI trading system can run on reliably, intelligently, and indefinitely?"*

The distinction is significant. A persistence layer saves state. An operating system:
- Defines resource ownership and access policies
- Enforces memory hierarchy with different performance and durability characteristics
- Provides lifecycle management for all running components
- Mediates communication between independent subsystems
- Maintains system integrity under partial failure
- Accumulates and protects institutional knowledge

### 1.2 Core Invariants

The following invariants must hold at all times. The architecture is designed to enforce them:

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
  All access is through the Manager Tier.
  Violation → bypasses optimistic concurrency, validation, versioning.

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
  After any failure, the Recovery Manager runs all 9 phases before trading resumes.
  No phase may be skipped.
  System status is HALTED until RecoveryManager reports READY or DEGRADED.
  DEGRADED → trading paused, monitoring active.
  Violation → trading on inconsistent state.

INVARIANT 6: Financial Intent Atomicity
  Every trade_open or trade_close is preceded by a committed trade_intent.
  No OANDA call is made without a committed PENDING intent.
  Violation → ghost trades, unreconcilable positions.
```

### 1.3 Naming Convention

Throughout this document:
- **Domain** — a named independent unit of state within the Runtime Layer (e.g., `live`, `shadowM`)
- **Namespace** — a named collection of entries within the Memory Layer (e.g., `cooldowns`)
- **Artifact** — a named piece of learned intelligence in the Knowledge Layer (e.g., `engineC/dataset`)
- **Manager** — a singleton module in the Manager Tier that owns a specific resource type
- **Engine** — a trading subsystem (Engine A/B/C/D, Shadow M, Exit Lab, etc.)
- **Plugin** — a future engine that registers with the Manager Tier via the Plugin Interface

---

## Section 2 — Four-Layer Memory Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SHADOW OS v2 — MEMORY HIERARCHY                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  RUNTIME LAYER           Fast · Versioned · Domain-partitioned      │   │
│  │  Write latency: ~5ms     Read latency: ~2ms    Durability: session  │   │
│  │  Domains: live, shadowA, shadowB, shadowC, shadowD, shadowM,        │   │
│  │           exitLab, telemetry, scheduler, meta                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  MEMORY LAYER            TTL-based · Contextual · Self-expiring     │   │
│  │  Write latency: ~5ms     Read latency: ~3ms    Durability: TTL      │   │
│  │  Namespaces: observations, cooldowns, market_state, volatility,     │   │
│  │              correlations, decision_history, confidence_decay       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  KNOWLEDGE LAYER         Permanent · Versioned · Append-only        │   │
│  │  Write latency: ~20ms    Read latency: ~10ms   Durability: forever  │   │
│  │  Artifacts: engineC/*, engineD/*, exitLab/*, market/*, system/*     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  EVENT LOG               Immutable · Append-only · Audit-only       │   │
│  │  Write latency: ~5ms     Read latency: variable  Durability: forever│   │
│  │  Never used for recovery. Used for compliance, analytics, replay.   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Layer communication rules:
  Runtime → Memory: Runtime state may reference Memory keys (never embed values)
  Runtime → Knowledge: Runtime may reference Knowledge versions (never embed)
  Memory → Knowledge: Prohibited (Memory is transient; Knowledge is permanent)
  Any layer → Event Log: Write-only. Never read for recovery.
  All access → through Manager Tier only.
```

---

## Section 3 — Runtime Layer

### 3.1 Design

The Runtime Layer replaces the monolithic `runtime_state` table from Architecture B with a set of **independent domains**. Each domain is a single row in `runtime_domains`, owned by exactly one engine, loadable without loading any other domain.

Independence is critical. When Shadow M advances its event cursor, it should not compete with the Live domain for the same table row. Independent domains eliminate that contention and allow parallel loading on startup.

### 3.2 Domain Definitions

```
DOMAIN: live
  Owner: server.js (Live Bot coordinator)
  Contents:
    dailyTrades   INTEGER  — trade opens today
    openTrades    OBJECT   — symbol → {symbol, side, pips, peak, breakEven, entryTime, signalId}
    date          TEXT     — YYYY-MM-DD (UTC) when dailyTrades was last reset
    sequence      INTEGER  — monotonically incrementing mutation counter
  Write frequency: On every trade open/close/snapshot (high frequency)
  TTL: None (persists until replaced)

DOMAIN: shadowA
  Owner: shadowlab.js (Engine A — Trend Engine, frozen)
  Contents:
    signalsSeen     INTEGER  — lifetime count
    signalsBlocked  INTEGER  — lifetime count
    lastEvalTs      TEXT     — ISO timestamp of last evaluation
    frozen          BOOLEAN  — always true for A (frozen engine)
  Write frequency: Each ShadowLab cycle (every 30s)

DOMAIN: shadowB
  Owner: shadowlab.js (Engine B — Candle Engine, frozen)
  Contents: same schema as shadowA

DOMAIN: shadowC
  Owner: shadowlab.js (Engine C — KNN Engine)
  Contents:
    datasetVersion  INTEGER  — version of knowledge artifact currently loaded
    datasetSize     INTEGER  — number of training examples in loaded dataset
    lastTrainTs     TEXT     — ISO timestamp of last dataset update
    nearestK        INTEGER  — current K parameter
    accuracy        REAL     — rolling accuracy on recent predictions (0-1)
  Write frequency: After each training cycle

DOMAIN: shadowD
  Owner: shadowlab.js (Engine D — Meta Engine)
  Contents:
    weightsVersion  INTEGER  — version of knowledge artifact currently loaded
    lastTrainTs     TEXT     — ISO timestamp of last weights update
    conditionCount  INTEGER  — number of conditions tracked
    topConditions   ARRAY    — top 5 performing conditions
    confidence      REAL     — current model confidence (0-1)
  Write frequency: After each training cycle (every 100 closed trades)

DOMAIN: shadowM
  Owner: shadowm.js (Exit Lab)
  Contents:
    lastId          INTEGER  — highest events.id processed
    active          OBJECT   — signalId → tracking object (open trades only)
    knownSids       ARRAY    — all known signalIds (open + closed)
    pollCount       INTEGER  — total polls executed this session
    lastPollTs      TEXT     — ISO timestamp of last poll
  Write frequency: After every poll that finds new events

DOMAIN: exitLab
  Owner: shadowlab.js (Exit Lab / Shadow D exit strategies)
  Contents:
    strategiesLoaded  ARRAY    — names of exit strategies currently loaded
    bestStrategy      TEXT     — current best-performing strategy name
    strategyVersions  OBJECT   — strategy → knowledgeArtifactVersion
    evaluationsThisSession  INTEGER
  Write frequency: Each ShadowLab cycle

DOMAIN: telemetry
  Owner: telemetry/index.js
  Contents:
    lastEventId     INTEGER  — highest events.id written this session
    eventCount      INTEGER  — total events written this session
    errorCount      INTEGER  — DB write errors this session
    lastErrorTs     TEXT
    dbBackend       TEXT     — 'postgresql' or 'sqlite'
  Write frequency: After each logEvent() batch (every 30s)

DOMAIN: scheduler
  Owner: server.js (scheduling coordinator)
  Contents:
    nextCycleTs       TEXT     — ISO timestamp of next ShadowLab cycle
    lastCycleTs       TEXT     — ISO timestamp of last completed cycle
    cycleCount        INTEGER  — total cycles this session
    shadowLabInterval INTEGER  — current cycle interval in ms (adaptive)
    botPid            INTEGER  — PID of running bot process (or null)
  Write frequency: Each cycle boundary

DOMAIN: meta
  Owner: server.js (system metadata)
  Contents:
    systemVersion     TEXT     — "v40.1"
    schemaVersion     INTEGER  — runtime_domains schema version
    bootCount         INTEGER  — total process restarts (cumulative, never reset)
    uptimeStart       TEXT     — ISO timestamp of this boot
    lastCleanShutdown TEXT     — ISO timestamp of last graceful shutdown
    status            TEXT     — 'HEALTHY' | 'DEGRADED' | 'HALTED'
  Write frequency: On boot, on shutdown, on status change
```

### 3.3 Database Schema

```sql
CREATE TABLE runtime_domains (
  domain      TEXT        PRIMARY KEY,
  version     BIGINT      NOT NULL DEFAULT 0,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER     NOT NULL DEFAULT 1,
  checksum    TEXT        GENERATED ALWAYS AS
              (md5(value::text)) STORED   -- automatic integrity check
);

-- Bootstrap all domains on first deploy (idempotent)
INSERT INTO runtime_domains (domain, version, value, schema_ver)
VALUES
  ('live',      0, '{"dailyTrades":0,"openTrades":{},"date":"","sequence":0}', 1),
  ('shadowA',   0, '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}', 1),
  ('shadowB',   0, '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}', 1),
  ('shadowC',   0, '{"datasetVersion":0,"datasetSize":0,"lastTrainTs":"","nearestK":5,"accuracy":0}', 1),
  ('shadowD',   0, '{"weightsVersion":0,"lastTrainTs":"","conditionCount":0,"topConditions":[],"confidence":0}', 1),
  ('shadowM',   0, '{"lastId":0,"active":{},"knownSids":[],"pollCount":0,"lastPollTs":""}', 1),
  ('exitLab',   0, '{"strategiesLoaded":[],"bestStrategy":"","strategyVersions":{},"evaluationsThisSession":0}', 1),
  ('telemetry', 0, '{"lastEventId":0,"eventCount":0,"errorCount":0,"lastErrorTs":"","dbBackend":""}', 1),
  ('scheduler', 0, '{"nextCycleTs":"","lastCycleTs":"","cycleCount":0,"shadowLabInterval":30000,"botPid":null}', 1),
  ('meta',      0, '{"systemVersion":"v40.1","schemaVersion":1,"bootCount":0,"uptimeStart":"","lastCleanShutdown":"","status":"HALTED"}', 1)
ON CONFLICT (domain) DO NOTHING;
```

### 3.4 Optimistic Concurrency Protocol

Every StateManager write uses optimistic concurrency to prevent lost updates from concurrent writers:

```
WRITE PROTOCOL:
  1. Load current domain state: {value, version} = stateManager.loadDomain(domain)
  2. Apply mutation: newValue = transform(value)
  3. Attempt commit:
       UPDATE runtime_domains
       SET value=$newValue, version=version+1, updated_at=NOW()
       WHERE domain=$domain AND version=$currentVersion
  4. Check rows_affected:
       If 1: success — committed
       If 0: version conflict (another writer committed between steps 1 and 3)
               → reload from DB, re-apply transform, retry (max 3 attempts)
               → After 3 failures: raise ConcurrencyError (logged, domain flagged)

TRANSFORM PATTERN:
  Transforms must be pure functions of the current value.
  Never capture external state in the transform closure.
  Example:
    stateManager.saveDomainRetry('shadowM', (current) => ({
      ...current,
      lastId: newLastId,
      active: newActive,
      pollCount: current.pollCount + 1,
      lastPollTs: new Date().toISOString(),
    }))
```

### 3.5 Domain Schema Evolution

Each domain has a `schema_ver` field. When the domain value schema changes:

```
SCHEMA MIGRATION PROTOCOL:
  1. Increment schema_ver in the migration script
  2. Write a migration function: migrate_live_v1_to_v2(value) → newValue
  3. On startup, StateManager checks: if loaded domain.schema_ver < current → run migration
  4. Migration is idempotent: can be run multiple times safely
  5. After migration: save domain with new schema_ver
  6. Log: logEvent({type:'domain_schema_migrated', domain, from, to})
```

---

## Section 4 — Memory Layer

### 4.1 Design

The Memory Layer stores **contextual operational memory** — information that is more than momentary but less than permanent. It survives restarts (stored in PostgreSQL) but expires naturally via TTL when no longer relevant.

This layer solves a class of problems that neither Runtime nor Knowledge handles well: *short-term market context that must survive crashes but becomes stale after hours or days.*

**Without Memory Layer (current + ARCH-B):** Cooldowns, decision history, and rolling market state are rebuilt from event log on restart — slow, incomplete, and wrong when the event log doesn't contain the right event type.

**With Memory Layer:** These are first-class persistent objects with defined lifecycles. A London-session cooldown on EUR_USD set at 08:00 UTC expires at 11:00 UTC, whether or not the process restarted at 09:30.

### 4.2 Namespace Definitions

```
NAMESPACE: observations
  Description: Per-signal observations accumulated during a trade's lifetime
  TTL: 48 hours from creation
  Key format: "obs:{signalId}"
  Value: {
    signalId, symbol, session, entryConditions, shadowCScore, shadowDScore,
    gateDecision, marketContext, entryAtr, entrySeries, observedAt
  }
  Purpose: Exit Lab can read the full entry context when evaluating exit
  Owner: ShadowLab

NAMESPACE: cooldowns
  Description: Per-symbol cooldown state after a trade or loss
  TTL: Varies by trigger (configured per symbol, typically 30–120 min)
  Key format: "cd:{symbol}:{session}"
  Value: {
    symbol, session, reason, triggeredAt, expiresAt, origin
  }
  Purpose: Prevent re-entry on same symbol during cooling period
  Owner: server.js (Live Bot coordinator)

NAMESPACE: market_state
  Description: Rolling market context per symbol
  TTL: 4 hours (refreshed on each tick)
  Key format: "mkt:{symbol}"
  Value: {
    symbol, lastAtr, lastSpread, lastClose, trend, session,
    spreadPercentile, volatilityRegime, lastUpdated
  }
  Purpose: Engine C and D context without re-fetching from OANDA
  Owner: shadowlab.js

NAMESPACE: volatility
  Description: ATR rolling windows per symbol
  TTL: 1 hour
  Key format: "vol:{symbol}:{period}"  — period: 14, 50, 200
  Value: {
    symbol, period, current, average, percentile, trend, lastUpdated
  }
  Purpose: Adaptive threshold calculation for gates
  Owner: shadowlab.js

NAMESPACE: correlations
  Description: Symbol correlation matrix (rolling 30-day)
  TTL: 4 hours
  Key format: "corr:{sym1}:{sym2}"
  Value: {
    symbolA, symbolB, correlation, sampleSize, windowDays, computedAt
  }
  Purpose: Portfolio risk (future Risk Engine will read this)
  Owner: scheduler / background job

NAMESPACE: decision_history
  Description: Last N gate decisions per symbol
  TTL: 7 days
  Key format: "dh:{symbol}:{session}"
  Value: {
    symbol, session, decisions: [{signalId, ts, decision, mode, confidence, outcome}],
    winRate, avgConfidence, lastUpdated
  }
  Purpose: Confidence decay calculation, Engine D training signal
  Owner: ShadowLab

NAMESPACE: confidence_decay
  Description: Per-engine confidence trajectory over time
  TTL: 30 days
  Key format: "conf:{engineName}"
  Value: {
    engine, history: [{ts, accuracy, sampleSize}],
    currentConfidence, trend, degradationAlert, lastUpdated
  }
  Purpose: Detect when an engine's predictions are degrading
  Owner: ValidationManager (written), engines (read)
```

### 4.3 Database Schema

```sql
CREATE TABLE memory_entries (
  id           BIGSERIAL   PRIMARY KEY,
  namespace    TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  value        JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,              -- NULL = never expires (use KnowledgeLayer for those)
  access_count BIGINT      NOT NULL DEFAULT 0,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  UNIQUE (namespace, key)
);

CREATE INDEX ON memory_entries (namespace);
CREATE INDEX ON memory_entries (namespace, key);
CREATE INDEX ON memory_entries (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX ON memory_entries USING GIN (tags);
CREATE INDEX ON memory_entries (updated_at DESC);

-- Constraint: expires_at must be in the future when written
-- (enforced by MemoryManager, not DB constraint, to allow tests)
```

### 4.4 Lifecycle Model

```
WRITE (set):
  1. INSERT INTO memory_entries (namespace, key, value, expires_at, tags)
     ON CONFLICT (namespace, key) DO UPDATE
     SET value=EXCLUDED.value, updated_at=NOW(), expires_at=EXCLUDED.expires_at,
         tags=EXCLUDED.tags
  2. No return value needed — fire-and-forget for non-critical writes

READ (get):
  1. SELECT value, expires_at FROM memory_entries
     WHERE namespace=$ns AND key=$key
  2. If not found: return null (caller uses default behavior — not an error)
  3. If expires_at IS NOT NULL AND expires_at < NOW(): return null
     (row is logically expired; will be physically deleted by GC)
  4. Increment access_count async (fire-and-forget)

GARBAGE COLLECTION:
  Runs every 60 minutes (scheduled by MemoryManager on startup)
  DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at < NOW()
  Log: logEvent({type:'memory_gc', deleted, namespace_counts})

EXPIRY DESIGN PRINCIPLE:
  Memory entries are designed to be absent without causing failure.
  Missing cooldown → no cooldown applied (conservative default)
  Missing market_state → re-fetch from OANDA / use cached ATR
  Missing decision_history → Engine D uses prior probability
  The system degrades gracefully without any memory entry.
```

### 4.5 Memory Namespaces — TTL Reference

| Namespace | Default TTL | Refresh on access | Max entries | GC priority |
|-----------|-------------|-------------------|-------------|-------------|
| observations | 48h | No | N (one per trade) | Low |
| cooldowns | 30–120min | Yes (on trigger) | 20 (symbols × sessions) | High |
| market_state | 4h | Yes (each tick) | 50 | Medium |
| volatility | 1h | Yes (each tick) | 200 | Medium |
| correlations | 4h | No | 100 | Low |
| decision_history | 7d | Yes (each decision) | 50 | Low |
| confidence_decay | 30d | Yes (each cycle) | 20 | Very Low |

---

## Section 5 — Knowledge Layer

### 5.1 Design

The Knowledge Layer stores **learned intelligence that accumulates over time**. Unlike runtime state (changes every second) or memory (expires in hours), knowledge changes slowly — updated after training cycles, verified for integrity, and versioned for rollback.

**Critical insight:** The current system rebuilds Engine C's KNN dataset and Engine D's weights from scratch on every startup. At 10,000 closed trades, this takes 10–30 seconds and reads tens of thousands of database rows. At 100,000 closed trades (2–3 years of operation), this becomes minutes.

SHADOW OS v2 stores pre-computed knowledge artifacts. Startup at any scale takes ~50ms: load the artifact JSON, deserialize, ready. The artifact is updated incrementally as new trades close, not rebuilt from zero.

**The Knowledge Layer is append-only.** Artifacts are never deleted. They are superseded. This provides:
- Complete learning history
- Safe rollback to any prior version
- Ability to audit how the system learned
- Corruption recovery (revert to last verified version)

### 5.2 Artifact Catalog

```
DOMAIN: engineC  (KNN — Nearest Neighbour Engine)
  ARTIFACT: dataset
    Description: Full KNN training dataset (feature vectors + outcomes)
    Structure: {
      version, trainingEvents, computedAt, confidence,
      examples: [{
        signalId, symbol, session, side,
        features: {spread, atr, emaDistance, candleStrength, passCount,
                   hourOfDay, dayOfWeek, priorSessionWinRate, ...},
        outcome: {profitPips, won, duration, mfe, mae}
      }]
    }
    Update trigger: After every 10 new closed trades
    Max size estimate: ~2KB per example × 10,000 = 20MB at scale
    Storage note: For datasets > 1MB, store feature index separately (see ARTIFACT: index)

  ARTIFACT: thresholds
    Description: Adaptive confidence thresholds per symbol and session
    Structure: {
      version, computedAt,
      thresholds: {
        "EUR_USD:LONDON": {minConfidence: 0.65, minPassCount: 7, blockBelow: 0.5},
        "GBP_USD:LONDON": {...},
        ...
      }
    }
    Update trigger: After every 50 new closed trades
    Purpose: Gate thresholds that adapt to per-pair performance

  ARTIFACT: performance
    Description: Per-symbol, per-session historical accuracy of Engine C
    Structure: {
      version, computedAt,
      accuracy: {"EUR_USD:LONDON": {correct: 142, total: 200, rate: 0.71}, ...}
    }
    Update trigger: After each ShadowLab cycle

DOMAIN: engineD  (Meta Engine — condition weight optimizer)
  ARTIFACT: weights
    Description: Learned weights for each entry condition
    Structure: {
      version, trainingEvents, computedAt, confidence,
      conditions: {
        "trend":      {weight: 1.4, sampleSize: 890, winRate: 0.63, improvement: +0.12},
        "m5close":    {weight: 1.1, sampleSize: 890, winRate: 0.58, improvement: +0.07},
        "candle":     {weight: 1.3, sampleSize: 890, winRate: 0.61, improvement: +0.10},
        "ema":        {weight: 0.9, sampleSize: 890, winRate: 0.54, improvement: +0.02},
        "strength":   {weight: 1.2, sampleSize: 890, winRate: 0.60, improvement: +0.09},
        "m1trend":    {weight: 0.8, sampleSize: 890, winRate: 0.52, improvement: -0.01},
        "m1candle":   {weight: 1.0, sampleSize: 890, winRate: 0.56, improvement: +0.04},
        "m1prev":     {weight: 0.7, sampleSize: 890, winRate: 0.51, improvement: -0.02},
        "m1close":    {weight: 1.1, sampleSize: 890, winRate: 0.57, improvement: +0.05}
      }
    }
    Update trigger: Every 100 closed trades
    Rollback policy: Auto-rollback if win rate drops >5% below prior version's win rate

  ARTIFACT: calibration
    Description: Confidence calibration curve (predicted confidence vs actual win rate)
    Structure: {
      version, computedAt,
      curve: [{predictedConfidence: 0.5, actualWinRate: 0.48}, ...]
    }
    Update trigger: Every 200 closed trades

DOMAIN: exitLab  (Exit strategy performance)
  ARTIFACT: strategies
    Description: Performance stats per exit strategy
    Structure: {
      version, computedAt, totalTrades,
      strategies: {
        "TP_HIT":   {count: 312, avgProfit: 18.2, winRate: 1.0, avgDuration: 45},
        "SL_HIT":   {count: 89,  avgProfit: -12.0, winRate: 0.0, avgDuration: 20},
        "TRAILING": {count: 156, avgProfit: 11.4, winRate: 0.78, avgDuration: 67},
        "BREAKEVEN":{count: 44,  avgProfit: 0.8, winRate: 0.62, avgDuration: 38},
        ...
      },
      bestStrategy: "TP_HIT",
      recommendation: "Increase TP target; trailing stop underperforms on EUR_USD"
    }
    Update trigger: After every 20 closed trades

  ARTIFACT: hold_time
    Description: Optimal hold time per symbol/session
    Structure: {
      version, computedAt,
      optimal: {
        "EUR_USD:LONDON": {minutes: 52, p25: 28, p75: 95, sampleSize: 234},
        ...
      }
    }
    Update trigger: Every 50 closed trades

DOMAIN: market  (Market characterization)
  ARTIFACT: pair_stats
    Description: Long-term statistical profile per trading pair
    Structure: {
      version, computedAt,
      pairs: {
        "EUR_USD": {
          avgDailyRangePoints: 87, avgSpread: 0.9, tradingDays: 245,
          bestSession: "LONDON", worstSession: "ASIAN",
          seasonalBias: {Q1: 0.03, Q2: -0.01, Q3: 0.02, Q4: 0.01},
          regime: "TRENDING"  ← updated by regime_model artifact
        }
      }
    }
    Update trigger: Weekly (scheduled background job)

  ARTIFACT: regime_model
    Description: Current market regime classification
    Structure: {
      version, computedAt,
      regimes: {
        "EUR_USD": {regime: "TRENDING", confidence: 0.72, since: "2026-06-15"},
        "GBP_USD": {regime: "RANGING",  confidence: 0.65, since: "2026-06-20"},
        ...
      },
      method: "ATR_PERCENTILE_WITH_TREND_SLOPE",
      nextReviewTs: "2026-07-07T00:00:00Z"
    }
    Update trigger: Daily at midnight UTC

DOMAIN: system  (System-level learned configuration)
  ARTIFACT: adaptive_thresholds
    Description: Thresholds that have adapted based on observed performance
    Structure: {
      version, computedAt,
      thresholds: {
        "shadowGate.minConfidence": {value: 0.62, originalDefault: 0.60, adjustedAt: "...", reason: "..."},
        "shadowM.minMFEForTrailing": {value: 6.5, originalDefault: 6.0, ...},
        ...
      }
    }
    Update trigger: Monthly review (semi-automatic, human approval required for changes >10%)
```

### 5.3 Database Schema

```sql
CREATE TABLE knowledge_artifacts (
  id              BIGSERIAL   PRIMARY KEY,
  domain          TEXT        NOT NULL,
  artifact        TEXT        NOT NULL,
  version         BIGINT      NOT NULL,
  value           JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ,           -- NULL = currently active
  checksum        TEXT        NOT NULL,  -- SHA-256 of value::text
  byte_size       INTEGER,               -- byte_length(value::text)
  training_events INTEGER,               -- how many events trained this artifact
  confidence      REAL,                  -- 0.0 to 1.0 (NULL if not applicable)
  migration_from  BIGINT      REFERENCES knowledge_artifacts(id),
  notes           TEXT                   -- human-readable description of this version
);

-- Exactly one active version per (domain, artifact) at any time
CREATE UNIQUE INDEX ON knowledge_artifacts (domain, artifact)
  WHERE superseded_at IS NULL;

-- Fast lookup by domain + artifact (history)
CREATE INDEX ON knowledge_artifacts (domain, artifact, version DESC);

-- Checksums must be unique (detects accidental duplicate saves)
CREATE UNIQUE INDEX ON knowledge_artifacts (domain, artifact, checksum);
```

### 5.4 Versioning and Supersession

```
SAVE PROTOCOL:
  1. Compute checksum: SHA-256(JSON.stringify(value, null, 0))
  2. Check uniqueness: if checksum matches current active version → skip (no-op)
  3. BEGIN TRANSACTION
     a. UPDATE knowledge_artifacts
        SET superseded_at = NOW()
        WHERE domain=$domain AND artifact=$artifact AND superseded_at IS NULL
     b. INSERT INTO knowledge_artifacts
        (domain, artifact, version, value, checksum, byte_size, training_events, confidence, notes)
        VALUES ($domain, $artifact, $prevVersion+1, $value, $checksum, ...)
  4. COMMIT
  5. Return new artifact row

ROLLBACK PROTOCOL:
  1. SELECT id, version FROM knowledge_artifacts
     WHERE domain=$domain AND artifact=$artifact AND version=$targetVersion
  2. Verify target version exists and is not currently active
  3. BEGIN TRANSACTION
     a. Supersede current: UPDATE ... SET superseded_at=NOW() WHERE superseded_at IS NULL
     b. INSERT a NEW row (copy of target), with version=currentMax+1
        (rollback creates a new version, does not resurrect old row)
        Set notes="ROLLBACK from v$currentVersion to content of v$targetVersion"
  4. COMMIT

CORRUPTION DETECTION:
  On every KnowledgeManager.load():
    computed = SHA-256(loaded.value::text)
    if computed !== loaded.checksum → CORRUPTION DETECTED
    → log ConsistencyLog entry (severity=CRITICAL)
    → try previous version (walk back through history until checksum OK)
    → if no valid version found → return null (engine uses safe defaults)
```

### 5.5 Knowledge Migration

When the schema of a knowledge artifact changes (e.g., Engine D adds a new condition), a migration function transforms old versions to the new format:

```
MIGRATION PROTOCOL:
  1. Write migration function: fn(oldValue) → newValue
  2. Call: knowledgeManager.migrate('engineD', 'weights', fn,
       "Add 'm1close' condition; default weight=1.0, sampleSize=0")
  3. KnowledgeManager:
     a. Loads current active artifact
     b. Applies fn(currentValue)
     c. Saves result as new version with migration_from=currentId
     d. Notes field includes migration description
  4. The migration chain is always traceable via migration_from references
```

---

## Section 6 — Event Log

### 6.1 Role in SHADOW OS v2

The Event Log (`events` table) remains **unchanged** from the current system. Its role is now explicitly limited:

**Event Log IS:**
- Immutable audit trail of every system event
- Source for compliance reporting
- Input for analytics and backtesting
- Historical record for human debugging

**Event Log IS NOT:**
- Source of truth for recovery
- Input for engine initialization
- Source for Knowledge Layer building (shadowm_trades is used instead)
- Performance-critical path for any startup sequence

**At 1 million events:** The Event Log table has 1 million rows. Under SHADOW OS v2, startup never touches this table. Query time for analytics is bounded by PostgreSQL B-tree indexes. No operational function depends on full-table scans of the events table.

### 6.2 Idempotency Registry

```sql
-- Prevents duplicate event writes (carried forward from Architecture A design)
CREATE TABLE event_idempotency (
  key        TEXT        PRIMARY KEY,  -- "{botId}:{type}:{signalId}:{sequence}"
  event_id   BIGINT      REFERENCES events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TTL cleanup: DELETE FROM event_idempotency WHERE created_at < NOW() - INTERVAL '7 days'
```

---

## Section 7 — Manager Tier (API Contract)

### 7.1 Architecture

The Manager Tier is the kernel of SHADOW OS v2. No engine module accesses PostgreSQL directly. All persistence operations go through a manager. This provides:
- Consistent error handling and retry logic
- Optimistic concurrency enforcement
- Unified logging and metrics
- A stable API surface that can be swapped out (e.g., replace PostgreSQL with Redis for a manager without changing engine code)

Managers are singleton modules initialized once at process startup. They share a connection pool (`pg.Pool`) injected at construction. The pool is the only direct PostgreSQL accessor in the system.

```
MODULE STRUCTURE:
  telemetry/
    managers/
      state-manager.js      ← Runtime Layer CRUD
      memory-manager.js     ← Memory Layer CRUD + TTL + GC
      knowledge-manager.js  ← Knowledge Layer CRUD + versioning
      intent-manager.js     ← Trade intents + OANDA reconciliation
      recovery-manager.js   ← 9-phase startup recovery
      snapshot-manager.js   ← Periodic runtime snapshots
      validation-manager.js ← Consistency checks + auto-repair
    index.js          (event log + pool)
    db-adapter.js     (PG/SQLite abstraction — unchanged)
    shadowm.js        (uses StateManager, not db-adapter directly)
    shadowlab.js      (uses StateManager + MemoryManager + KnowledgeManager)
    server.js         (uses all managers; uses IntentManager for trades)
```

### 7.2 StateManager

```typescript
interface DomainState {
  domain:    string;
  version:   number;
  value:     object;
  updatedAt: string;  // ISO timestamp
  schemaVer: number;
  checksum:  string;
}

interface SaveResult {
  ok:             boolean;
  domain:         string;
  newVersion:     number;
  conflictRetries: number;  // how many retries were needed (0 = first attempt succeeded)
}

interface StateManager {
  // Load a single domain. Returns null if domain does not exist.
  loadDomain(domain: string): Promise<DomainState | null>;

  // Load all domains in a single query.
  loadAll(): Promise<Record<string, DomainState>>;

  // Save a domain using optimistic concurrency.
  // expectedVersion must match current DB version, or the write is rejected.
  // Returns {ok: false} if version conflict persists after maxRetries.
  saveDomain(domain: string, value: object, expectedVersion: number): Promise<SaveResult>;

  // Retry-safe version: provides transform function instead of pre-computed value.
  // Loads current value, applies transform, saves. Retries up to 3× on conflict.
  // transform must be a pure function with no external state capture.
  saveDomainRetry(
    domain: string,
    transform: (current: object) => object
  ): Promise<SaveResult>;

  // Force-flush all pending writes to DB (called before graceful shutdown).
  flush(): Promise<void>;

  // Called on startup: verifies schema_ver of each domain, runs migrations if needed.
  migrateIfNeeded(): Promise<{ domain: string; from: number; to: number }[]>;
}
```

### 7.3 MemoryManager

```typescript
interface MemoryEntry {
  namespace:   string;
  key:         string;
  value:       object;
  createdAt:   string;
  updatedAt:   string;
  expiresAt:   string | null;
  accessCount: number;
  tags:        string[];
}

interface MemorySetOptions {
  ttlMs?:    number;    // Time to live in milliseconds. null = no TTL (use sparingly)
  tags?:     string[];  // For query-by-tag
  refresh?:  boolean;   // If true, resets TTL on update (default: true)
}

interface MemoryManager {
  set(namespace: string, key: string, value: object, opts?: MemorySetOptions): Promise<void>;
  get(namespace: string, key: string): Promise<object | null>;  // null if missing or expired
  getAll(namespace: string): Promise<Record<string, object>>;   // excludes expired
  getByTags(namespace: string, tags: string[]): Promise<Record<string, object>>;
  delete(namespace: string, key: string): Promise<void>;
  touch(namespace: string, key: string, newTtlMs: number): Promise<void>;
  gc(): Promise<{ deleted: number; namespaces: Record<string, number> }>;
  scheduleGC(intervalMs: number): void;  // called on startup
  stats(): Promise<{ totalEntries: number; expiredEntries: number; namespaces: string[] }>;
}
```

### 7.4 KnowledgeManager

```typescript
interface KnowledgeArtifact {
  id:             number;
  domain:         string;
  artifact:       string;
  version:        number;
  value:          object;
  createdAt:      string;
  supersededAt:   string | null;  // null = active
  checksum:       string;
  byteSize:       number;
  trainingEvents: number | null;
  confidence:     number | null;  // 0.0–1.0
  migrationFrom:  number | null;  // parent artifact id
  notes:          string | null;
}

interface KnowledgeSaveOptions {
  trainingEvents?: number;
  confidence?:     number;
  notes?:          string;
}

interface KnowledgeManager {
  // Load current active artifact. Returns null if none exists.
  // Verifies checksum; returns null (and logs CRITICAL) if corrupt.
  load(domain: string, artifact: string): Promise<KnowledgeArtifact | null>;

  // Save a new version, superseding current.
  // No-op if checksum is identical to current active version.
  save(
    domain:   string,
    artifact: string,
    value:    object,
    opts?:    KnowledgeSaveOptions
  ): Promise<KnowledgeArtifact>;

  // Return version history (most recent first).
  loadHistory(domain: string, artifact: string, limit?: number): Promise<KnowledgeArtifact[]>;

  // Roll back: supersede current, save new version with content of targetVersion.
  rollback(domain: string, artifact: string, toVersion: number): Promise<KnowledgeArtifact>;

  // Apply a migration function to current artifact, save as new version.
  migrate(
    domain:      string,
    artifact:    string,
    migrationFn: (v: object) => object,
    notes:       string
  ): Promise<KnowledgeArtifact>;

  // Verify checksum of all active artifacts. Returns per-artifact health.
  verifyAll(): Promise<{ domain: string; artifact: string; ok: boolean; error?: string }[]>;

  // Returns confidence of current active artifact (null if not applicable).
  confidence(domain: string, artifact: string): Promise<number | null>;
}
```

### 7.5 IntentManager

```typescript
type IntentType   = 'OPEN' | 'CLOSE' | 'MODIFY';
type IntentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILED';

interface TradeIntent {
  id:            number;
  signalId:      string;
  intentType:    IntentType;
  status:        IntentStatus;
  oandaOrderId:  string | null;
  symbol:        string;
  side:          string | null;
  payload:       object;
  createdAt:     string;
  confirmedAt:   string | null;
  failureReason: string | null;
}

interface ReconciliationAction {
  signalId: string;
  action:   'CONFIRMED' | 'FAILED' | 'NO_ACTION';
  detail:   string;
}

interface IntentManager {
  writeIntent(
    signalId:  string,
    type:      IntentType,
    symbol:    string,
    side:      string | null,
    payload:   object
  ): Promise<TradeIntent>;

  confirmIntent(signalId: string, oandaOrderId: string): Promise<void>;
  failIntent(signalId: string, reason: string): Promise<void>;
  getPendingIntents(): Promise<TradeIntent[]>;

  // Compare live.openTrades with OANDA's /openTrades. Returns discrepancy report.
  reconcileWithOanda(
    oandaBaseUrl: string,
    oandaToken:   string,
    accountId:    string,
    liveState:    object
  ): Promise<ReconciliationAction[]>;

  // Cleanup: mark intents older than maxAgeHours as FAILED (safety net for stuck intents)
  cleanupStale(maxAgeHours?: number): Promise<number>;
}
```

### 7.6 RecoveryManager

```typescript
type RecoveryPhase =
  | 'SCHEMA' | 'DOMAINS' | 'MEMORY' | 'KNOWLEDGE'
  | 'INTENTS' | 'OANDA' | 'ENGINES' | 'VALIDATION' | 'READY';

type SystemStatus = 'HEALTHY' | 'DEGRADED' | 'HALTED';

interface PhaseReport {
  phase:      RecoveryPhase;
  ok:         boolean;
  durationMs: number;
  detail:     string;
  issues:     string[];
}

interface RecoveryReport {
  startedAt:    string;
  completedAt:  string;
  totalMs:      number;
  status:       SystemStatus;
  phases:       PhaseReport[];
  blockers:     string[];     // issues that caused HALTED status
  warnings:     string[];     // non-blocking issues
}

interface RecoveryManager {
  run(oandaCredentials?: OandaCredentials): Promise<RecoveryReport>;
  runPhase(phase: RecoveryPhase): Promise<PhaseReport>;
  getLastReport(): RecoveryReport | null;
  getSystemStatus(): SystemStatus;
}
```

### 7.7 SnapshotManager

The SnapshotManager takes periodic snapshots of the combined Runtime + Memory state for point-in-time recovery reference. This is NOT used for startup recovery (that uses runtime_domains directly) but for forensic analysis after unusual events.

```typescript
interface Snapshot {
  id:          number;
  createdAt:   string;
  triggerType: 'SCHEDULED' | 'MANUAL' | 'PRE_SHUTDOWN' | 'POST_RECOVERY';
  runtimeSummary: Record<string, { version: number; checksum: string }>;
  memorySummary:  Record<string, { entryCount: number; expiredCount: number }>;
  knowledgeSummary: Record<string, { artifact: string; version: number; confidence: number | null }[]>;
  systemStatus:   SystemStatus;
}

interface SnapshotManager {
  takeSnapshot(trigger?: Snapshot['triggerType']): Promise<Snapshot>;
  scheduleSnapshots(intervalMs: number): void;
  getLatestSnapshot(): Promise<Snapshot | null>;
  compareSnapshots(id1: number, id2: number): Promise<object>;  // diff of two snapshots
}
```

### 7.8 ValidationManager

```typescript
type CheckSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

interface ConsistencyCheck {
  checkId:     string;
  severity:    CheckSeverity;
  domain:      string | null;
  description: string;
  detail:      object;
  detectedAt:  string;
  resolvedAt:  string | null;
  resolution:  string | null;
  autoRepaired: boolean;
  repairDetail: object | null;
}

interface ValidationReport {
  ranAt:    string;
  durationMs: number;
  checksRun: number;
  issues:    ConsistencyCheck[];
  repaired:  ConsistencyCheck[];
  status:    'CLEAN' | 'ISSUES_FOUND' | 'REPAIR_FAILED';
}

interface ValidationManager {
  // Run all consistency checks. Auto-repairs known patterns.
  runChecks(oandaCredentials?: OandaCredentials): Promise<ValidationReport>;
  scheduleChecks(intervalMs: number): void;
  getRecentIssues(severity?: CheckSeverity, limit?: number): Promise<ConsistencyCheck[]>;
  // Specific checks (can be called individually):
  checkLiveVsOanda(oandaCredentials: OandaCredentials): Promise<ConsistencyCheck[]>;
  checkShadowMCursor(): Promise<ConsistencyCheck[]>;
  checkKnowledgeChecksums(): Promise<ConsistencyCheck[]>;
  checkMemoryLeak(): Promise<ConsistencyCheck[]>;
  checkLearningDegradation(): Promise<ConsistencyCheck[]>;
}
```

---

## Section 8 — Recovery Manager

### 8.1 Recovery Phase Sequence

```
╔══════════════════════════════════════════════════════════════════╗
║              RECOVERY MANAGER — 9-PHASE STARTUP SEQUENCE        ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  PHASE 1: SCHEMA           T+0ms    target: <100ms              ║
║    Verify all required tables exist.                             ║
║    CREATE TABLE IF NOT EXISTS for any missing tables.            ║
║    Run domain schema migrations (schema_ver comparison).         ║
║    Run knowledge artifact migrations (migration registry).       ║
║    If schema creation fails → HALT (cannot operate without DB)  ║
║                                                                  ║
║  PHASE 2: RUNTIME DOMAINS  T+~100ms  target: <50ms              ║
║    SELECT * FROM runtime_domains (all domains in one query)      ║
║    For each domain: verify schema_ver, run migration if needed   ║
║    For missing domains: initialize with zero-state               ║
║    Load into memory: stateManager._cache = {domain: value, ...} ║
║    If load fails → HALT                                          ║
║    Increment meta.bootCount                                      ║
║                                                                  ║
║  PHASE 3: MEMORY           T+~150ms  target: <50ms              ║
║    Load non-expired entries for critical namespaces:             ║
║      cooldowns, decision_history, market_state                   ║
║    Build in-memory index for O(1) reads                          ║
║    Schedule GC sweep (60min interval)                            ║
║    If load fails → WARN (continue; safe defaults apply)          ║
║                                                                  ║
║  PHASE 4: KNOWLEDGE        T+~200ms  target: <100ms             ║
║    Load all active knowledge artifacts                           ║
║    Verify checksums for all artifacts                            ║
║    Load into engine-specific memory structures                   ║
║    If checksum fails for any artifact → attempt rollback         ║
║    If no valid version → WARN + engine uses safe defaults        ║
║                                                                  ║
║  PHASE 5: INTENTS          T+~300ms  target: <20ms              ║
║    SELECT * FROM trade_intents WHERE status='PENDING'            ║
║    If 0 PENDING: proceed immediately                             ║
║    If >0 PENDING: requires Phase 6 (OANDA reconciliation)        ║
║    If DB unavailable → HALT                                      ║
║                                                                  ║
║  PHASE 6: OANDA            T+~320ms  target: <500ms             ║
║    GET /v3/accounts/{id}/openTrades                              ║
║    Compare with runtime_domains.live.openTrades                  ║
║    Reconcile PENDING intents against OANDA state                 ║
║    Discrepancies → auto-repair if RECONCILE_POLICY=AUTO          ║
║                 → flag if RECONCILE_POLICY=FLAG (default)        ║
║    If OANDA unreachable → DEGRADED (no new trades until resolved)║
║                                                                  ║
║  PHASE 7: ENGINES          T+~820ms  target: <200ms             ║
║    Notify each engine of loaded state                            ║
║    Engines verify internal consistency vs loaded domains         ║
║    shadowM: verify _lastId matches runtime_domains.shadowM.lastId║
║    shadowLab: verify _processedIds consistent with shadowM data  ║
║    Engine C: verify dataset version matches shadowC domain       ║
║    Engine D: verify weights version matches shadowD domain       ║
║    If any engine reports INCONSISTENT → ValidationManager        ║
║                                                                  ║
║  PHASE 8: VALIDATION       T+~1020ms  target: <500ms            ║
║    ValidationManager.runChecks()                                 ║
║    All CRITICAL issues → HALTED (trading paused)                 ║
║    All ERROR issues → DEGRADED (trading paused, monitoring on)   ║
║    All WARN issues → logged, trading continues with alert        ║
║    INFO issues → logged only                                     ║
║    SnapshotManager.takeSnapshot('POST_RECOVERY')                 ║
║                                                                  ║
║  PHASE 9: READY            T+~1520ms  target: 0ms               ║
║    Set meta.status = HEALTHY | DEGRADED | HALTED                 ║
║    Emit logEvent({type:'system_startup', ...phaseReport})        ║
║    Start all scheduled intervals (Shadow M poll, ShadowLab cycle)║
║    Spawn bot process (if HEALTHY or configured for DEGRADED)     ║
║    Begin serving HTTP requests                                   ║
╚══════════════════════════════════════════════════════════════════╝

TYPICAL TOTAL STARTUP TIME: ~150ms (clean restart, no OANDA issues)
TYPICAL TOTAL WITH OANDA:   ~350ms (OANDA API round-trip included)
```

### 8.2 Recovery Decision Tree

```
START
  │
  ├─ Phase 1 fails (schema error) ──────────────────────────────→ HALT
  │
  ├─ Phase 2 fails (domain load error) ─────────────────────────→ HALT
  │
  ├─ Phase 3 fails (memory load error) ─────────────────────────→ WARN, continue
  │
  ├─ Phase 4 fails:
  │    ├─ Checksum error → rollback to prior version → retry
  │    ├─ No valid version → WARN, engine uses safe defaults, continue
  │    └─ DB error → WARN, engine uses safe defaults, continue
  │
  ├─ Phase 5 fails (DB unavailable) ────────────────────────────→ HALT
  │
  ├─ Phase 6 fails:
  │    ├─ OANDA unreachable → DEGRADED (no new trades)
  │    ├─ Ghost position found, RECONCILE=AUTO → auto-close, continue
  │    ├─ Ghost position found, RECONCILE=FLAG → DEGRADED, alert
  │    └─ Stale live state → auto-correct, continue
  │
  ├─ Phase 7 fails (engine inconsistency) ──────────────────────→ ValidationManager
  │
  ├─ Phase 8:
  │    ├─ CRITICAL → HALT
  │    ├─ ERROR → DEGRADED
  │    └─ WARN → HEALTHY with alerts
  │
  └─ Phase 9 → system operational at determined status
```

### 8.3 Partial Recovery Mode

When the system cannot complete full recovery (e.g., OANDA unreachable), it enters **Partial Recovery Mode**:

```
PARTIAL RECOVERY PROTOCOL:
  System status: DEGRADED
  Actions allowed:
    - Read-only API endpoints (dashboard, stats, history)
    - Shadow M event polling (read-only)
    - ShadowLab analytics cycle (read-only)
    - ValidationManager periodic checks
    - OANDA connectivity retry (every 60s)
  Actions blocked:
    - Bot process spawn (no new trades)
    - KnowledgeManager.save() (no learning during degradation)
    - shadowGate() → always returns blocked=true (fail-safe)

RECOVERY TRIGGER:
  When OANDA connectivity restored:
    → Run Phase 6 (OANDA reconciliation) only
    → If clean → set status=HEALTHY, spawn bot
    → Log: logEvent({type:'degraded_to_healthy', reason:'oanda_reconnected'})
```

---

## Section 9 — State Validation System

### 9.1 Consistency Check Catalog

The ValidationManager runs 12 consistency checks. Each is classified, auto-repaired when possible, and logged to `consistency_log`.

```
CHECK: live_vs_oanda
  Description: openTrades in runtime_domains.live must match OANDA /openTrades
  Severity if violated: ERROR
  Auto-repair: Remove ghost positions from live state; add missing positions
  Runs: On startup (Phase 6), every 10 minutes

CHECK: shadowm_cursor_lag
  Description: shadowM.lastId should be within 100 of max(events.id)
  Severity if violated: WARN (if lag < 1000), ERROR (if lag > 1000)
  Auto-repair: Force a _poll() cycle; update cursor
  Runs: Every 5 minutes

CHECK: shadowm_active_vs_live
  Description: Every signalId in shadowM._active must have a corresponding
               openTrades entry. Every openTrades entry must be in shadowM._active.
  Severity if violated: ERROR
  Auto-repair:
    - Extra in shadowM._active: force close in shadowM (logically closed)
    - Missing from shadowM._active: add from live.openTrades data
  Runs: Every 5 minutes

CHECK: knowledge_checksums
  Description: Every active knowledge artifact checksum must match stored value
  Severity if violated: CRITICAL
  Auto-repair: Rollback to previous valid version
  Runs: On startup (Phase 4), hourly

CHECK: engine_c_version_mismatch
  Description: Engine C's loaded dataset version must match shadowC.datasetVersion
  Severity if violated: WARN
  Auto-repair: Reload Engine C dataset from KnowledgeManager
  Runs: Every 15 minutes

CHECK: engine_d_version_mismatch
  Description: Engine D's loaded weights version must match shadowD.weightsVersion
  Severity if violated: WARN
  Auto-repair: Reload Engine D weights from KnowledgeManager
  Runs: Every 15 minutes

CHECK: learning_degradation
  Description: If Engine C accuracy drops >5% below prior version OR
               Engine D win rate drops >5% below prior version
  Severity if violated: ERROR
  Auto-repair: Rollback knowledge artifact to prior version; alert
  Runs: Every 30 minutes (after each ShadowLab cycle)

CHECK: memory_leak_detection
  Description: memory_entries count should not grow unboundedly.
               Alert if count > 10,000 or expired entries > 50% of total
  Severity if violated: WARN
  Auto-repair: Trigger immediate GC sweep
  Runs: Every 60 minutes

CHECK: intent_stuck
  Description: PENDING trade_intents older than 5 minutes indicate a stuck trade flow
  Severity if violated: ERROR
  Auto-repair: Reconcile with OANDA; mark as CONFIRMED or FAILED
  Runs: Every 5 minutes

CHECK: daily_counter_drift
  Description: live.dailyTrades must match COUNT(trade_open events for today)
  Severity if violated: WARN
  Auto-repair: Recount from events table; update live.dailyTrades
  Runs: On startup, every 60 minutes

CHECK: schema_version_drift
  Description: Each domain's schema_ver must match current expected version
  Severity if violated: ERROR (CRITICAL if live domain)
  Auto-repair: Run domain migration function
  Runs: On startup only

CHECK: event_log_gap
  Description: events.id should be monotonically increasing with no large gaps
               (gaps > 1000 suggest a DB error or bulk delete)
  Severity if violated: WARN
  Auto-repair: None (audit only)
  Runs: Daily at midnight UTC
```

### 9.2 Consistency Log Schema

```sql
CREATE TABLE consistency_log (
  id            BIGSERIAL   PRIMARY KEY,
  check_id      TEXT        NOT NULL,
  severity      TEXT        NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  domain        TEXT,
  description   TEXT        NOT NULL,
  detail        JSONB,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  auto_repaired BOOLEAN     NOT NULL DEFAULT FALSE,
  repair_detail JSONB
);

CREATE INDEX ON consistency_log (severity, detected_at DESC);
CREATE INDEX ON consistency_log (check_id, detected_at DESC);
CREATE INDEX ON consistency_log (resolved_at) WHERE resolved_at IS NULL;  -- open issues
```

---

## Section 10 — Learning Pipeline

### 10.1 Design Principle

**Learning must be continuous and incremental. Nothing is rebuilt from zero after restart.**

The current system rebuilds Engine C's KNN dataset from `shadowm_trades` on every startup and every 30-second cycle. This is O(N) in historical trade count. After one year of operation (~2,000 trades), this takes ~2 seconds per cycle. After five years (~10,000 trades), it is ~10 seconds — consuming one-third of each 30-second cycle.

SHADOW OS v2 stores the pre-computed artifact in the Knowledge Layer. Updates are incremental: each new closed trade adds one example to the dataset. Startup is O(1): load artifact, deserialize, ready.

### 10.2 Engine C (KNN) Learning Pipeline

```
INCREMENTAL UPDATE TRIGGER:
  Event: trade_close received by ShadowLab cycle

STEP 1: Build feature vector for the closed trade
  Source: shadowm_trades row + memory_entries.observations[signalId]
  Features: {
    spread, atrPips, emaDistance, candleStrength, passCount,
    session, hourOfDay, dayOfWeek, symbol,
    priorWinRate (from decision_history), priorVolatility (from volatility)
  }
  Outcome: {won, profitPips, duration, mfe, mae}

STEP 2: Append to in-memory dataset copy
  dataset.examples.push({features, outcome})
  dataset.trainingEvents += 1

STEP 3: Every 10 new closed trades → save to Knowledge Layer
  newConfidence = computeAccuracy(dataset.examples.slice(-100))
  knowledgeManager.save('engineC', 'dataset', dataset, {
    trainingEvents: dataset.examples.length,
    confidence: newConfidence,
    notes: `${dataset.examples.length} examples; last 100: acc=${newConfidence.toFixed(3)}`
  })
  stateManager.saveDomainRetry('shadowC', c => ({
    ...c,
    datasetVersion: newArtifact.version,
    datasetSize: dataset.examples.length,
    lastTrainTs: new Date().toISOString(),
    accuracy: newConfidence
  }))

STEP 4: Check for degradation
  if (newConfidence < priorConfidence - 0.05) {
    validationManager.runCheck('learning_degradation')
    // Will auto-rollback if threshold exceeded
  }

ON STARTUP:
  knowledgeManager.load('engineC', 'dataset') → artifact (50ms at 10,000 examples)
  Engine C.dataset = artifact.value.examples
  Engine C ready for gate evaluations immediately

COLD START (no artifact exists yet):
  Dataset is empty → Engine C uses safe_default mode:
    shadowGate() in OBSERVE mode → never blocks (always passes)
    Begin collecting data → first artifact saved after 10 closed trades
```

### 10.3 Engine D (Meta Engine) Learning Pipeline

```
INCREMENTAL UPDATE TRIGGER:
  Every 100 closed trades (batched, not per-trade)

STEP 1: Fetch closed trades batch (shadowm_trades, last 100)
  For each trade: what conditions passed? What was the outcome?
  Condition performance: P(win | condition_active)

STEP 2: Update weights using exponential moving average
  For each condition c:
    recentPerformance[c] = P(win | c_active, last_100_trades)
    weights[c] = α × recentPerformance[c] + (1-α) × weights[c]
    where α = 0.2 (learning rate — configurable)
  This means old data is not discarded, just downweighted over time.

STEP 3: Compute new confidence
  calibration = computeCalibrationError(predicted vs actual, last_200_trades)
  confidence = 1 - calibration  (0=random, 1=perfect)

STEP 4: Save to Knowledge Layer
  if (tradesProcessed % 100 === 0):
    knowledgeManager.save('engineD', 'weights', {weights, conditions}, {
      trainingEvents: totalTradesProcessed,
      confidence: confidence,
      notes: `EMA update batch; α=0.2; ${totalTradesProcessed} cumulative trades`
    })

DEGRADATION DETECTION:
  After each save, compare confidence to prior version.
  If confidence drops >5%:
    validationManager creates ERROR consistency check
    ValidationManager attempts rollback to prior version
    Alert: logEvent({type:'engine_d_degradation', current, prior, delta})

ON STARTUP:
  knowledgeManager.load('engineD', 'weights') → artifact (5ms)
  Engine D.weights = artifact.value.weights
  Engine D ready immediately — no rebuild required
```

### 10.4 Exit Lab Learning Pipeline

```
TRIGGER: Every 20 closed trades

STEP 1: Aggregate exit strategy performance
  Query: SELECT best_strategy, profit_live, duration FROM shadowm_trades
         WHERE exit_time IS NOT NULL ORDER BY exit_time DESC LIMIT 500

STEP 2: Compute per-strategy statistics
  For each strategy name: {count, avgProfit, winRate, avgDuration, stdDev}

STEP 3: Save to Knowledge Layer
  knowledgeManager.save('exitLab', 'strategies', {strategies, bestStrategy}, {
    trainingEvents: closedTradeCount,
    confidence: topStrategyWinRate
  })

STEP 4: Update optimal hold times per symbol/session
  Bucket trades by symbol+session, compute p25/p50/p75 of duration
  knowledgeManager.save('exitLab', 'hold_time', {optimal})

ON STARTUP:
  Load 'exitLab/strategies' → Exit Lab knows which strategy performed best historically
  Load 'exitLab/hold_time' → optimal hold times ready
  No rebuild from shadowm_trades needed at startup

KNOWLEDGE CONTINUITY:
  At 1 year of operation: 2,000 closed trades → artifact.value is ~400KB
  At 5 years: 10,000 trades → artifact.value is ~2MB
  Load time from DB: <50ms at any scale
```

### 10.5 Knowledge Accumulation Timeline

```
MONTH 1 (bootstrap):
  Engine C: 0 → 100 examples; first threshold adaptation begins
  Engine D: weights initialized from defaults; first 2 updates
  Exit Lab: first strategy performance data; hold times meaningless (N<50)
  Market stats: first pair_stats artifact; no seasonality yet

MONTH 6:
  Engine C: ~600 examples; symbol/session thresholds differentiated
  Engine D: ~6 weight updates; condition ranking stabilized
  Exit Lab: TP vs trailing confidence meaningful; hold time curves shaped
  Market stats: pair_stats showing first seasonal pattern emergence

YEAR 1:
  Engine C: ~1,200 examples; KNN highly accurate in known regimes
  Engine D: ~12 weight updates; per-session weights emerging
  Exit Lab: hold time distributions reliable; strategy rotation patterns visible
  Market stats: full seasonal picture; regime classification active

YEAR 2+:
  Engine C: regime-aware sub-datasets (trending vs ranging)
  Engine D: multi-level weights (session × pair × time-of-day)
  Exit Lab: correlation with market regime incorporated
  Market stats: cross-pair correlation stable; macro-event impact tracked

CRITICAL: At no point in this timeline does a restart set learning back to zero.
          The only loss on restart is the post-last-save delta (≤10 closed trades).
```

---

## Section 11 — Plugin Architecture

### 11.1 Engine Plugin Interface

Every engine — current or future — implements the `EnginePlugin` interface. The Manager Tier treats all engines uniformly.

```typescript
interface EnginePlugin {
  // Unique identifier for this engine
  readonly name: string;          // e.g., 'engineC', 'riskEngine', 'portfolioEngine'
  readonly version: string;       // e.g., '1.0.0'

  // Domains this engine owns (will be loaded and provided on startup)
  readonly ownedDomains: string[];

  // Knowledge artifacts this engine owns
  readonly ownedArtifacts: { domain: string; artifact: string }[];

  // Memory namespaces this engine reads/writes
  readonly memoryNamespaces: string[];

  // Called during Recovery Phase 7: verify engine state against loaded domains
  onRecovery(
    domains: Record<string, object>,
    knowledge: Record<string, KnowledgeArtifact | null>,
    memory: Record<string, Record<string, object>>
  ): Promise<{ ok: boolean; issues: string[] }>;

  // Called when the system enters DEGRADED or HALTED mode
  onDegraded(reason: string): void;

  // Called on graceful shutdown (before process exits)
  onShutdown(): Promise<void>;

  // Periodic health report (called by ValidationManager)
  healthCheck(): Promise<{ ok: boolean; metrics: Record<string, number | string> }>;
}
```

### 11.2 Engine Registry

```
The Manager Tier maintains an EngineRegistry singleton.
All engines register themselves on startup:

  registry.register(new ShadowMEngine());
  registry.register(new ShadowLabEngine());
  registry.register(new KNNEngine());       // Engine C
  registry.register(new MetaEngine());      // Engine D
  // Future:
  registry.register(new RiskEngine());
  registry.register(new PortfolioEngine());
  registry.register(new AICoachEngine());

Recovery Phase 7 iterates registry.getAll() and calls onRecovery() on each.
ValidationManager's periodic check calls healthCheck() on each registered engine.
```

### 11.3 Future Module Compatibility Map

| Future Module | Domains it adds | Memory namespaces it reads | Knowledge it owns | Blocking factors |
|--------------|-----------------|---------------------------|-------------------|-----------------|
| Risk Engine | `risk` | `correlations`, `volatility` | `market/regime_model` | None |
| Portfolio Engine | `portfolio` | `correlations`, `market_state` | `system/adaptive_thresholds` | Risk Engine first |
| AI Coach | `coach` | `decision_history`, `confidence_decay` | `engineC/*`, `engineD/*` | 3+ months data |
| Strategy Optimizer | `optimizer` | All | `engineC/*`, `engineD/*`, `exitLab/*` | 6+ months data |
| News Engine | `news` | `market_state`, `volatility` | `market/pair_stats` | External API key |
| Macro Engine | `macro` | `market_state`, `correlations` | `market/pair_stats` | External API key |
| Multi-account | `accounts.*` | All (per account) | Per-account knowledge | ARCH-C deployment |

Each new module: implement EnginePlugin interface, register with EngineRegistry. Zero changes to Manager Tier required.

---

## Section 12 — Architecture Diagrams

### 12.1 System Overview

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                      SHADOW OS v2 — SYSTEM OVERVIEW                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  ┌─────────────────────────────────────────────────────────────────────────┐ ║
║  │                          ENGINE LAYER                                   │ ║
║  │                                                                         │ ║
║  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │ ║
║  │  │ index.js │ │ShadowLab │ │Engine C  │ │Engine D  │ │  Shadow M    │ │ ║
║  │  │ (bot)    │ │(A/B/C/D) │ │  (KNN)   │ │  (Meta)  │ │  (Exit Lab)  │ │ ║
║  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ │ ║
║  └───────┼────────────┼────────────┼─────────────┼──────────────┼─────────┘ ║
║          │            │            │             │              │            ║
║  ┌───────▼────────────▼────────────▼─────────────▼──────────────▼─────────┐ ║
║  │                         MANAGER TIER (Kernel)                           │ ║
║  │                                                                         │ ║
║  │ StateManager  MemoryManager  KnowledgeManager  IntentManager            │ ║
║  │ RecoveryManager  SnapshotManager  ValidationManager  EngineRegistry     │ ║
║  └────────────────┬────────────────┬──────────────────────────────────────┘ ║
║                   │                │                                          ║
║  ┌────────────────▼──┐  ┌──────────▼───────────────────────────────────────┐║
║  │   CONNECTION POOL │  │              POSTGRESQL DATABASE                  │║
║  │   (pg.Pool)       │  │                                                   │║
║  └───────────────────┘  │  runtime_domains    memory_entries               │║
║                          │  knowledge_artifacts  trade_intents              │║
║                          │  consistency_log    event_idempotency            │║
║                          │  events (audit)     shadowm_trades               │║
║                          │  shadowm_timeline   system_snapshots             │║
║                          └───────────────────────────────────────────────────┘║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### 12.2 Memory Hierarchy Data Flow

```
                        WRITE PATH
ENGINE MUTATION
    │
    ├──→ StateManager.saveDomainRetry()
    │         │ optimistic concurrency
    │         ▼
    │    UPDATE runtime_domains SET value=..., version=version+1
    │         │
    │         ▼ (success) → in-memory cache updated
    │
    ├──→ MemoryManager.set(namespace, key, value, {ttlMs})
    │         │
    │         ▼
    │    UPSERT memory_entries (namespace, key)
    │
    ├──→ KnowledgeManager.save(domain, artifact, value)
    │         │ checksum, supersession
    │         ▼
    │    BEGIN; supersede current; INSERT new version; COMMIT
    │
    └──→ logEvent({type, ...})      ← audit log, always last, fire-and-forget

                        READ PATH (STARTUP)
    RecoveryManager.run()
    │
    ├── Phase 2: StateManager.loadAll()
    │   SELECT * FROM runtime_domains        ← 10 rows, ~2ms
    │   → all domains in memory cache
    │
    ├── Phase 3: MemoryManager.getAll(namespace) for critical namespaces
    │   SELECT * FROM memory_entries WHERE expires_at > NOW()   ← <50ms
    │
    └── Phase 4: KnowledgeManager.load(domain, artifact) per engine
        SELECT * FROM knowledge_artifacts WHERE superseded_at IS NULL   ← ~5ms per
        Verify checksum
        → artifact in engine memory
```

### 12.3 Startup Sequence Diagram

```
T+0ms    process starts
T+1ms    db-adapter.js: pool connects to PostgreSQL
T+2ms    EngineRegistry: all engines register
T+3ms    RecoveryManager.run() begins

         ┌─────────────────────────────────────────────────────┐
T+3ms    │ PHASE 1: SCHEMA                                     │
T+50ms   │ All tables present, migrations complete             │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+50ms   │ PHASE 2: RUNTIME DOMAINS                           │
T+80ms   │ 10 domains loaded; meta.bootCount incremented      │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+80ms   │ PHASE 3: MEMORY                                     │
T+110ms  │ cooldowns: 3 entries, market_state: 4 entries       │
T+110ms  │ GC sweep scheduled (T+3660s)                        │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+110ms  │ PHASE 4: KNOWLEDGE                                  │
T+160ms  │ engineC/dataset: v12 (2847 examples), acc=0.71     │
T+170ms  │ engineD/weights: v8, conf=0.68                     │
T+180ms  │ exitLab/strategies: v15, best=TP_HIT               │
T+190ms  │ All checksums OK                                    │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+190ms  │ PHASE 5: INTENTS                                    │
T+195ms  │ 0 PENDING intents                                   │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+195ms  │ PHASE 6: OANDA RECONCILIATION                      │
T+450ms  │ OANDA: 1 open position (EUR_USD)                   │
T+450ms  │ live.openTrades: {EUR_USD: {...}} ← matches        │
T+451ms  │ No discrepancies                                    │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+451ms  │ PHASE 7: ENGINE RECONCILIATION                     │
T+490ms  │ shadowM: lastId=5000 ← matches domain              │
T+495ms  │ engineC: datasetVersion=12 ← matches domain        │
T+500ms  │ engineD: weightsVersion=8 ← matches domain         │
T+505ms  │ All engines: CONSISTENT                            │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+505ms  │ PHASE 8: VALIDATION                                │
T+620ms  │ 12 checks run; 0 issues                            │
T+625ms  │ Snapshot taken (POST_RECOVERY)                     │
         └─────────────────────────────────────────────────────┘

         ┌─────────────────────────────────────────────────────┐
T+625ms  │ PHASE 9: READY                                      │
T+626ms  │ meta.status = HEALTHY                              │
T+627ms  │ Bot process spawned: node index.js                 │
T+628ms  │ [SERVER] API on :3001                              │
T+628ms  │ Shadow M polling started (5s interval)             │
T+628ms  │ ShadowLab cycle started (30s interval)             │
         └─────────────────────────────────────────────────────┘

TOTAL STARTUP TIME: ~628ms (includes OANDA round-trip ~255ms)
Without OANDA (in-process only): ~195ms
```

### 12.4 Knowledge Layer Data Flow

```
                    KNOWLEDGE ACCUMULATION CYCLE

  shadowm_trades (closed row arrives)
         │
         ▼
  ShadowLab._cycle()
         │
         ├──→ Build feature vector from shadowm_trades + memory.observations
         │
         ├──→ knowledgeManager.load('engineC', 'dataset')  ← load current
         │                │
         │                ▼ (already in-memory cache; DB call skipped if cached)
         │           KNN dataset (pre-built, 2847 examples)
         │                │
         │         dataset.examples.push(newExample)
         │                │
         │    (every 10 new trades)
         │                │
         ├──→ knowledgeManager.save('engineC', 'dataset', dataset)
         │         │ compute checksum
         │         │ supersede v12
         │         ▼
         │    INSERT knowledge_artifacts v13 (checksum=SHA256(...), acc=0.714)
         │    UPDATE runtime_domains SET value.datasetVersion=13
         │
         ├──→ knowledgeManager.load('engineD', 'weights')   ← similar path
         │         │ (every 100 trades)
         │         ▼
         │    EMA update → knowledgeManager.save('engineD', 'weights', newWeights)
         │
         └──→ Validation check:
                  if (newAccuracy < priorAccuracy - 0.05) → rollback
                  ValidationManager logs learning_degradation check
```

---

## Section 13 — Failure Simulations

### SIM-01: Normal Startup

```
SCENARIO: Clean startup, all systems healthy, 2,847 historical closed trades

TIMELINE:
  T+0ms    process starts
  T+628ms  System HEALTHY, bot running, all engines loaded from Knowledge Layer

EXPECTED BEHAVIOUR:
  Engine C dataset loaded: 2847 examples in 50ms (not rebuilt from DB)
  Engine D weights loaded: in 10ms
  Exit Lab strategies: loaded in 10ms
  No event table scanned at startup
  cooldown on GBP_USD (from prior session): still active → correct

RTO: 628ms
RPO: 0 (runtime state was written within 100ms of each mutation)
REMAINING RISK: None — this is the baseline healthy case
```

### SIM-02: Railway Restart (Deploy)

```
SCENARIO: Railway deploys new version of the service (SIGTERM → new process)

TIMELINE:
  T-100ms  Railway sends SIGTERM to running process
  T-100ms  server.js catches SIGTERM:
            stateManager.flush()    ← force-write all pending domain mutations
            intentManager.cleanupStale()  ← mark any stale intents
            SnapshotManager.takeSnapshot('PRE_SHUTDOWN')
            meta.lastCleanShutdown = NOW()
            stateManager.saveDomain('meta', ...)
            process.exit(0)
  T+0ms    New process starts
  T+628ms  System HEALTHY

EXPECTED BEHAVIOUR:
  Startup reads: runtime_domains (state exact at shutdown), memory_entries,
                 knowledge_artifacts (Knowledge Layer carries all engine state)
  No replay, no event scanning
  If trade was open at shutdown: live.openTrades persisted → recovered in 2ms
  Engine C dataset version at shutdown: still current → no rebuild

RTO: 628ms (or less — knowledge already in cache)
RPO: 0 (flush() committed all pending mutations before exit)
REMAINING RISK: <100ms of mutations if flush() fails (timeout or kill -9)
```

### SIM-03: Power Failure (kill -9, no SIGTERM)

```
SCENARIO: Railway kills process immediately, no graceful shutdown window

TIMELINE:
  T+0ms    Process killed (SIGKILL)
  T+5s     Railway starts new process
  T+5.6s   System reaches HEALTHY or DEGRADED

EXPECTED BEHAVIOUR:
  runtime_domains: up to 100ms of mutations missing (last pending flush)
  → live.dailyTrades: may be stale by 0-1 trades
  → shadowM.lastId: stale by up to one 5s poll cycle
  memory_entries: fully persisted (written before returning from set())
  knowledge_artifacts: fully persisted (each save() is an atomic transaction)
  OANDA reconciliation: corrects any discrepancy in live.openTrades
  Shadow M: replays events from stale lastId → catches up quickly

DEGRADED CONDITIONS:
  If a trade_open event was logged but live.openTrades write not committed:
    → OANDA reconciliation finds the position → auto-repairs live.openTrades
  If trade_open was NOT logged (OANDA call in-flight):
    → PENDING intent (written before OANDA call) → reconcile on startup
    → Ghost trade handled by IntentManager

RTO: ~630ms
RPO: up to 100ms of non-critical state; 0 for trade state (OANDA reconcile)
REMAINING RISK: OANDA API unreachable during reconciliation → DEGRADED mode
```

### SIM-04: Crash During OANDA Execution

```
SCENARIO: Bot makes OANDA API call, process dies between intent write and confirm

TIMELINE:
  T+0ms    signalId=ABC: IntentManager.writeIntent('OPEN', 'EUR_USD', 'buy', ...)
           → INSERT trade_intents (signal_id='ABC', status='PENDING') — COMMITTED

  T+1ms    OANDA API call begins: POST /orders
  T+50ms   OANDA responds: 201 Created (position is open on OANDA)
  T+50ms   PROCESS CRASHES (before confirmIntent() executes)

  T+8s     New process starts
  T+8.2s   PHASE 5: IntentManager.getPendingIntents() → finds signal_id='ABC'
  T+8.5s   PHASE 6: GET /v3/accounts/{id}/openTrades → EUR_USD position found
           intentManager.confirmIntent('ABC', oandaOrderId)
           live.openTrades['EUR_USD'] = {signalId:'ABC', ...}  ← repaired

  T+9.0s   Phase 6 complete: live.openTrades correct, intent confirmed

EXPECTED BEHAVIOUR: Ghost trade fully eliminated. Position accounted for.
RTO: ~9s (dominated by railway restart time ~8s, not recovery logic)
RPO: 0 trades lost; position correctly recovered
REMAINING RISK: OANDA API down during reconciliation → DEGRADED until OANDA up
```

### SIM-05: Network Outage (DB unreachable for 10 minutes)

```
SCENARIO: PostgreSQL connection drops for 10 minutes during live trading

TIMELINE:
  T+0s    DB connection drops
  T+0s    StateManager: write to runtime_domains fails
          → buffers mutations in memory (in-memory state IS the truth)
          → marks domains as 'dirty' (pending flush)
  T+0s    MemoryManager: writes fail → deferred queue
  T+0s    KnowledgeManager: writes fail → deferred queue
  T+0s    logEvent(): writes fail → deferred queue (emitter still works)
  T+0s    Trading CONTINUES normally (in-memory state unchanged)

  T+5min  DB connection restored
  T+5min  StateManager.flush() → writes all dirty domains
  T+5min  MemoryManager: flushes deferred set() calls
  T+5min  KnowledgeManager: flushes deferred save() calls
  T+5min  logEvent queue: writes all buffered events

  T+5min  If process crashed during 10-minute outage:
          Restart finds runtime_domains up to 10 min stale
          OANDA reconciliation catches any trade position drift
          Shadow M replays events from stale lastId (may replay 10min × 12 polls = 120 poll windows)
          Shadow M replay is idempotent → same result

EXPECTED BEHAVIOUR: No trading interruption. Eventual consistency after DB restored.
RTO: N/A (no downtime during outage; ~100ms on restart after outage crash)
RPO: Up to 10 minutes of non-trade state. 0 trade state (OANDA reconcile).
REMAINING RISK: Memory buffer grows unboundedly during extended outage (>60min)
  Mitigation: Cap memory buffer at 10,000 deferred writes; alert if exceeded
```

### SIM-06: Database Outage (PostgreSQL fully unavailable)

```
SCENARIO: PostgreSQL server fails for 2 hours

TIMELINE:
  T+0s    All DB writes fail → deferred queues (as SIM-05)
  T+0s    Trading continues in-memory
  T+30min If process also crashes during outage:
          → New process cannot complete Phase 1 (SCHEMA) → HALT
          → System status: HALTED
          → No bot spawned
          → Monitoring/alerting via logEvent() (emitter fires to SSE clients)
          → Human is notified

  T+2h    PostgreSQL restored
  T+2h    If process was running: flush() commits all buffered state
  T+2h    If process was HALTED: restart → Recovery runs → HEALTHY

  T+2h    State age: runtime_domains stale by 2h (writes buffered and now flushed)
          knowledge_artifacts: any artifacts saved during outage now committed
          OANDA reconciliation: verifies positions → correct

EXPECTED BEHAVIOUR (running): Trading continues. State persists on restore.
EXPECTED BEHAVIOUR (crashed during outage): HALTED until DB restored, then full recovery.
RTO: ~630ms after DB restored
RPO: 0 (all writes were buffered; none lost once DB restored)
REMAINING RISK: If DB never restores, in-memory buffer eventually fills.
  Mitigation: Circuit breaker at 30 minutes → DEGRADED → then HALT.
```

### SIM-07: Partial Database Corruption

```
SCENARIO: A specific table is corrupted (e.g., knowledge_artifacts rows for engineD)

TIMELINE:
  T+0s    PostgreSQL detects corruption in knowledge_artifacts block
  T+0s    Reads from that block return errors or wrong data

  RECOVERY PHASE 4:
    knowledgeManager.load('engineD', 'weights') → checksum fails
    → try prior version (version=7): checksum OK
    → rollback: create new version 9 with content of version 7
    → Engine D loaded with v7 weights (slightly older, but valid)
    → consistency_log: CRITICAL entry created
    → logEvent({type:'knowledge_corruption_repaired', domain:'engineD', rolledBackTo:7})

  RECOVERY PHASE 8: ValidationManager detects WARN
    (CRITICAL was already handled in Phase 4 with successful rollback)
    System status: HEALTHY (corruption resolved)

  POST-RECOVERY:
    Human reviews consistency_log
    Identifies corrupted table block → PostgreSQL VACUUM or table rebuild
    Monitoring alert sent

EXPECTED BEHAVIOUR: Engine D uses prior valid weights. System continues trading.
RTO: ~900ms (Phase 4 includes rollback + rewrite: +200ms)
RPO: Engine D learning: ~100 trades worth of weight updates (one training cycle lost)
REMAINING RISK: If all knowledge versions for engineD are corrupted → safe defaults
  Safe defaults: equal weights for all conditions → system degrades to ARCH-B behavior
```

### SIM-08: Duplicate Events

```
SCENARIO: Network retry causes trade_close event written twice to events table

TIMELINE:
  T+0s    logEvent({type:'trade_close', signalId:'XYZ', ...}) called
  T+0.1s  INSERT INTO events — first write → id=5000, committed
  T+0.1s  logEvent fires idempotency write:
          INSERT INTO event_idempotency (key='bot1:trade_close:XYZ:42', event_id=5000)

  T+0.2s  Bot retries (network timeout): calls logEvent({type:'trade_close', signalId:'XYZ', ...})
  T+0.2s  INSERT INTO event_idempotency (key='bot1:trade_close:XYZ:42') → ON CONFLICT DO NOTHING
  T+0.2s  Second INSERT INTO events is SKIPPED (duplicate blocked)

  Shadow M perspective:
    _knownSids: already contains 'XYZ' after first close
    _onClose: skipped (idempotent: only closed once)

  Without idempotency registry (events table):
    Two trade_close rows in events
    Shadow M second close call → no-op (idempotent UPSERT)
    Exit_time already set → no change
    Net result: still correct (Shadow M is idempotent for close)

EXPECTED BEHAVIOUR: Duplicate event either blocked at idempotency layer OR processed
  idempotently by Shadow M. Either way: no duplicate state mutation.
RTO: N/A (no restart)
RPO: N/A
REMAINING RISK: Very low. Both defenses (idempotency registry + idempotent Shadow M) handle this.
```

### SIM-09: Ghost Trade

```
SCENARIO: OANDA opens a trade; process crashes before any event is logged

TIMELINE:
  T+0ms   IntentManager.writeIntent('OPEN', 'EUR_USD', 'buy', ...) → PENDING — COMMITTED
  T+1ms   OANDA API call → 201 Created
  T+2ms   PROCESS CRASHES (confirmIntent never called, no logEvent)

  RECOVERY:
  T+10s   Phase 5: PENDING intent found for 'EUR_USD' (signalId='ABC')
  T+10.5s Phase 6: GET /openTrades → EUR_USD exists on OANDA
           intentManager.confirmIntent('ABC', oandaOrderId)
           logEvent({type:'trade_open', signalId:'ABC', ...})  ← retroactively logged
           live.openTrades['EUR_USD'] = {...}  ← repaired
           Shadow M will pick up trade_open on next poll → track the trade

  EXPECTED BEHAVIOUR: Ghost trade fully detected and incorporated into system state.
  RTO: ~10s (Railway restart + recovery)
  RPO: 0 (position recovered via OANDA reconciliation)
  REMAINING RISK: If OANDA is also down → DEGRADED mode; position unresolved until OANDA up
```

### SIM-10: 10,000 Historical Closed Trades

```
SCENARIO: After 18 months of operation, 10,000 trades in shadowm_trades

STARTUP PERFORMANCE ANALYSIS:

  CURRENT SYSTEM (v40.1):
    restoreLiveState(): 0ms (just counts events for today → fast)
    shadowM._restore(): scan shadowm_trades 10,000 rows → ~2-3s
    shadowLab._init(): scan trade_close events 10,000 rows → ~3-5s
    _buildDataset(): scan shadowm_trades 10,000 rows → ~5-10s
    Total non-OANDA startup: 10–18 seconds

  SHADOW OS v2:
    Phase 2 (runtime_domains): 10 rows → 2ms
    Phase 3 (memory_entries): ~50 rows → 5ms
    Phase 4 (knowledge_artifacts):
      engineC/dataset: one row, 10,000 examples pre-serialized in JSONB → 80ms to load
      engineD/weights: one row, small → 5ms
      exitLab/strategies: one row → 5ms
    Total non-OANDA startup: ~97ms

    shadowm_trades: 10,000 rows are NEVER scanned on startup.
    events table: 1,000,000+ events are NEVER scanned on startup.
    Engine C ready: 80ms after process start (deserialize pre-built artifact)

  CONCLUSION:
    Current system: O(N) startup time where N = historical trades
    SHADOW OS v2: O(1) startup time regardless of historical trade count
    At 10,000 trades: 18s → 97ms improvement (185×)
    At 100,000 trades: would have been minutes; SHADOW OS v2 still 97ms

RTO: 350ms (with OANDA)
RPO: 0
REMAINING RISK: At 10,000+ examples, engineC/dataset artifact is ~20MB of JSONB.
  PostgreSQL JSONB at 20MB: read latency ~80ms (acceptable).
  Mitigation: chunked artifact storage for datasets >10,000 examples.
```

### SIM-11: 1 Million Historical Events

```
SCENARIO: 18 months of operation, 1,000,000 events in events table

IMPACT ON SHADOW OS v2:
  events table: 1,000,000 rows
  Startup: events table is NEVER scanned → zero impact
  Runtime operations:
    logEvent(): INSERT (append) → O(log N) with B-tree index → ~5ms at any scale
    shadowM._poll(): SELECT WHERE id > $lastId → B-tree scan on id index → ~2ms
    ShadowLab analytics: queries shadowm_trades (not events) → unaffected

PERFORMANCE GUARANTEE:
  All operations remain O(log N) or O(1) regardless of events table size.

MAINTENANCE:
  Events older than 1 year may be archived to cold storage.
  Archiving does NOT affect startup or runtime performance.
  Archive policy: partition events by month → move cold partitions to archive table.

  CREATE TABLE events_archive_2025_01 (LIKE events INCLUDING ALL);
  INSERT INTO events_archive_2025_01 SELECT * FROM events WHERE ts < '2025-02-01';
  DELETE FROM events WHERE ts < '2025-02-01';

RTO: ~150ms (no OANDA needed for this test; events not touched)
RPO: 0
REMAINING RISK: None for startup. Disk space for 1M events: ~2GB. Plan archival at 500K events.
```

### SIM-12: Memory Layer Corruption

```
SCENARIO: memory_entries table has corrupted rows (bad JSONB, invalid expires_at)

IMPACT:
  MemoryManager.get(namespace, key) → JSON parse error on corrupt row
  → returns null (safe default behavior — missing memory is handled gracefully)
  → WARN consistency_log entry

RECOVERY:
  ValidationManager.checkMemoryLeak() → detects corrupt rows
  Auto-repair: DELETE FROM memory_entries WHERE... (cannot parse JSONB)
  → memory entry removed; system operates without it (safe degradation)

  Cooldown removed by corruption: symbol may re-enter too early (one trade risk)
  market_state removed: re-fetched from OANDA on next cycle
  decision_history removed: Engine D uses prior probability for one cycle

EXPECTED BEHAVIOUR: Graceful degradation. No crash. One-cycle impact at most.
RTO: N/A (no restart needed; MemoryManager returns null on corrupt entries)
RPO: One potentially missing cooldown (conservative risk: one trade too many)
REMAINING RISK: Low. Memory corruption impacts one decision, not the financial core.
```

### SIM-13: Knowledge Corruption

```
SCENARIO: engineD/weights artifact is silently corrupted in PostgreSQL
  (e.g., bit flip in JSONB storage → weights values are incorrect but JSON is valid)

DETECTION:
  Checksum: SHA-256(value::text) is stored with each artifact.
  If the value changes after storage, checksum no longer matches.
  A bit flip in the stored JSONB will change value::text → checksum mismatch detected.

RECOVERY:
  Phase 4: knowledgeManager.load('engineD', 'weights') → checksum fails
  → try version N-1: checksum OK → rollback
  → Engine D loaded with prior valid weights
  → consistency_log: CRITICAL + auto_repaired=true

REMAINING RISK:
  If corruption is in the CHECKSUM field itself (not the value):
    → Stored checksum matches modified value → corruption undetected
    Mitigation: compute expected checksum from value at load time, compare to stored checksum.
                This is what KnowledgeManager.load() already does.
                A corrupted checksum field means the computed checksum won't match stored checksum.
                → Same detection path → CRITICAL → rollback

  If PostgreSQL returns consistent bit-flipped data (memory corruption in DB):
    → Computed checksum of the corrupted value matches the corrupted stored checksum (both corrupted together).
    → This is an extreme case (hardware-level failure).
    → Mitigation: store checksum in a SEPARATE column, ideally also independently checksummed.
    → In practice: hardware-level DB corruption implies full data loss risk; PostgreSQL WAL
       and replication provide the real mitigation here.

RTO: ~900ms
RPO: Loss of the latest weights update cycle (≤100 trades of training)
REMAINING RISK: Hardware-level corruption is Railway's infrastructure concern (replication, EBS checksums)
```

### SIM-14: Recovery After One Month Offline

```
SCENARIO: System was offline for 30 days. What is the state?

STATE AT RESTART:

  runtime_domains:
    live.openTrades: may have had open trades when system went offline
    live.dailyTrades: from 30 days ago → stale
    shadowM.lastId: from 30 days ago → stale (up to 30d × events behind current)
    meta.lastCleanShutdown: 30 days ago (if clean) or never set (if crash)

  memory_entries:
    cooldowns: ALL EXPIRED (TTL was 30-120 minutes) → empty
    market_state: ALL EXPIRED → empty
    decision_history: ALL EXPIRED (TTL=7d) → empty
    confidence_decay: MOST EXPIRED (TTL=30d) → borderline

  knowledge_artifacts:
    ALL INTACT (no TTL on knowledge)
    All checksums valid
    Weights and dataset: valid but 30 days out of date

  events table:
    All events from before shutdown present
    No new events since shutdown (bot was offline)

RECOVERY SEQUENCE:
  Phase 2: Load runtime_domains → live.openTrades from 30 days ago
  Phase 3: Memory = empty (all expired) → safe defaults
  Phase 4: Knowledge loaded and valid → Engine C/D ready with 30-day-old intelligence
  Phase 5: Check PENDING intents → any PENDING from 30 days ago → mark FAILED (>maxAge)
  Phase 6: OANDA reconciliation:
    GET /openTrades → OANDA may have auto-closed open positions (via stop-loss)
    live.openTrades updated to match OANDA reality
    logEvent for each position reconciled
  Phase 7/8: Validation → WARN about knowledge staleness, WARN about empty memory

SYSTEM STATUS: DEGRADED
Reason: "Knowledge artifacts are 30 days stale; memory context empty; recommend supervised restart"

TRADING POLICY (configurable):
  OFFLINE_POLICY=SUPERVISED_RESTART: DEGRADED, human approval required before resuming
  OFFLINE_POLICY=AUTO_RESUME: resume trading immediately (higher risk)
  Default: SUPERVISED_RESTART

KNOWLEDGE REFRESH:
  After 30 days, the first ShadowLab cycle runs and updates knowledge artifacts
  using the most recent shadowm_trades data (unchanged during offline period)
  Engine C/D will update their knowledge on first cycle
  After ~1 hour: knowledge artifacts are current → DEGRADED → HEALTHY

RTO: ~630ms (startup), but DEGRADED until human approval or 1h of trading
RPO: Any trades that were open when system went offline: recovered via OANDA reconciliation
REMAINING RISK: Market conditions changed significantly in 30 days.
  Knowledge artifacts reflect old market regime.
  Mitigation: ValidationManager.checkLearningDegradation() will detect if accuracy drops.
```

---

## Section 14 — Formal Verification (Adversarial Review)

*The following section is written from the perspective of a hostile reviewer attempting to break the architecture. Each attack vector is followed by the defense mechanism and any residual risk.*

### 14.1 Race Conditions

**ATTACK 1: Concurrent domain writes from two simultaneous poll cycles**
```
Shadow M poll#1 starts, reads shadowM domain: version=100
Shadow M poll#2 starts (overlapping), reads shadowM domain: version=100
Poll#1 finishes: writes shadowM with version=100, newVersion=101 → SUCCESS
Poll#2 finishes: writes shadowM with version=100 → CONFLICT (current is 101)
  → optimistic concurrency: reload at version=101, re-apply poll#2 diff, retry
  → both polls committed, neither lost

VERDICT: HANDLED by optimistic concurrency. No data loss.
RESIDUAL RISK: If concurrent conflicts > 3 (ConcurrencyError): logged as WARN, domain flagged.
  Mitigation: Shadow M polling is single-threaded (setInterval, not parallel);
              this scenario requires a bug in the concurrency design.
```

**ATTACK 2: Knowledge save and Knowledge rollback simultaneously**
```
Thread A: knowledgeManager.save('engineD', 'weights', newWeights) in progress
Thread B: knowledgeManager.rollback('engineD', 'weights', toVersion=5) simultaneously

Both attempt: UPDATE knowledge_artifacts SET superseded_at=NOW() WHERE superseded_at IS NULL

PostgreSQL row-level locking: one UPDATE wins, the other blocks until first commits.
First winner: supersedes current active version.
Second: tries to supersede the same row (now with superseded_at set) → affects 0 rows.
  → Second transaction aborts → retries → finds new active version → proceeds correctly.

VERDICT: HANDLED by PostgreSQL row-level locking. No corruption.
RESIDUAL RISK: None. Database serializes concurrent supersession attempts correctly.
```

**ATTACK 3: StateManager concurrent writes from StateManager and RecoveryManager**
```
Recovery Phase 7: engines verify their state → RecoveryManager writes corrections to domains
Simultaneously: first normal Shadow M poll fires (interval started too early)
Both try to write shadowM domain at the same time.

Mitigation: RecoveryManager.run() blocks engine intervals until Phase 9.
  Intervals are only started in Phase 9, after RecoveryManager reports READY.
  RecoveryManager holds a "recovery lock" flag; interval callbacks check this flag.

VERDICT: HANDLED by architectural sequencing (intervals blocked until Phase 9).
RESIDUAL RISK: If interval fires during Phase 8 (race between READY and interval start):
  → optimistic concurrency handles the conflict → one write wins, other retries
  → No data loss.
```

### 14.2 Deadlocks

**ATTACK: Manager-to-manager circular dependency**
```
StateManager writes runtime domain → calls logEvent() → MemoryManager writes observation
MemoryManager writes observation → calls StateManager.saveDomain() → ?

If StateManager.saveDomain() and MemoryManager.set() both hold DB connections and
each waits for the other: deadlock.

Mitigation:
  1. All managers use the SAME connection pool (pg.Pool). Pool manages connections independently.
  2. No manager holds a connection open across calls to another manager.
  3. Each DB operation is a self-contained transaction: acquire → execute → release.
  4. No manager calls another manager within a transaction.
  5. logEvent() is fire-and-forget: StateManager never waits for logEvent() to complete.

VERDICT: DEADLOCKS IMPOSSIBLE by design.
  PostgreSQL advisory locks are not used within the Manager Tier (only for ARCH-C
  dual-instance deployment, which is out of scope for this single-instance design).
RESIDUAL RISK: None. The Manager Tier is designed as a set of independent, non-blocking services.
```

### 14.3 Single Points of Failure

**ATTACK: PostgreSQL is the only data store — its failure halts everything**
```
PostgreSQL unreachable → all Manager Tier writes fail → system eventually halts.

Defense:
  1. Network outage: in-memory buffer maintains operational state (SIM-05).
  2. PostgreSQL total failure: system operates in-memory until DB restored (SIM-06).
  3. The Trading Bot (index.js) does NOT query PostgreSQL directly → trading continues.
  4. logEvent() failures are buffered → no trading interruption.

Residual SPOF: If PostgreSQL is permanently destroyed with no backup:
  runtime_domains: LOST (recoverable from OANDA + events in backup)
  memory_entries: LOST (safe defaults apply)
  knowledge_artifacts: LOST (most serious — months of learning lost)
  events: LOST (audit trail lost)

Mitigation for knowledge loss:
  Periodic backup of knowledge_artifacts to external storage (S3, GitHub)
  knowledge_artifacts change rarely (weekly or fewer) → small backup size
  Include knowledge backup in Railway deployment pipeline

VERDICT: Single SPOF is acknowledged. Mitigation: regular PostgreSQL backups +
  knowledge artifact external backup. Railway PostgreSQL already has
  point-in-time recovery. Additional knowledge backup recommended.
```

### 14.4 Memory Leaks

**ATTACK: memory_entries grows unboundedly if TTL is not enforced**
```
Scenario: GC sweep fails (DB connection error) every time it runs.
memory_entries: grows at rate of ~100 entries/hour = 72,000 entries/month.
At 1M entries: table becomes slow (~seconds to query).

Defense:
  1. GC is scheduled every 60 minutes with retry logic (3 retries).
  2. ValidationManager.checkMemoryLeak() alerts at > 10,000 entries.
  3. MemoryManager.get() always filters by expires_at < NOW() at read time (logical TTL).
     → Expired entries are logically invisible even if physically present.
  4. A hard limit: if memory_entries > 50,000, emergency GC + WARN alert.

VERDICT: MITIGATED. Unbounded growth triggers alerts before performance impact.
RESIDUAL RISK: A 50,000-entry table adds ~5ms to GC sweep. Not operationally significant.
```

**ATTACK: knowledge_artifacts grows unboundedly (every training cycle adds a row)**
```
Engine C updates every 10 trades; at 10,000 trades/year: 1,000 new artifacts/year.
Superseded rows accumulate.

Defense:
  1. Non-active rows (superseded_at IS NOT NULL) are only used for history queries.
  2. KnowledgeManager.load() always uses the UNIQUE INDEX (superseded_at IS NULL) → O(log N).
  3. Pruning policy: DELETE knowledge_artifacts WHERE superseded_at < NOW() - INTERVAL '90 days'
     (keep 90 days of history; run weekly; cannot delete active versions)

VERDICT: MITIGATED. Pruning keeps table size bounded. History retained for 90 days.
RESIDUAL RISK: None for operational performance. Historical analysis beyond 90 days unavailable.
```

### 14.5 Replay Problems

**ATTACK: Shadow M replays events after stale cursor → incorrect close triggers**
```
After crash, shadowM.lastId = 4990 (cursor was written 10 events ago).
Events 4991–5000 include one trade_close for signalId='ABC' (already processed).
shadowM already closed 'ABC' in shadowm_trades before crash.

Replay: _poll() fetches events 4991–5000, processes trade_close for 'ABC'.
_onClose() is called again → UPDATE shadowm_trades WHERE signal_id='ABC':
  Sets exit_time again (already set), updates profit_live (to same value), etc.
  This is an idempotent UPSERT → same result.

VERDICT: HANDLED. Shadow M close operations are idempotent by design.
RESIDUAL RISK: None. Replay produces identical state.
```

**ATTACK: Event idempotency registry fills with stale keys → becomes a performance bottleneck**
```
event_idempotency grows at ~100 entries/hour. After 7 days: 16,800 entries.
PRIMARY KEY lookup on 16,800 entries: O(log N) → <1ms always.

TTL cleanup: DELETE FROM event_idempotency WHERE created_at < NOW() - INTERVAL '7 days'
Runs daily at midnight.

VERDICT: Not a problem. 16,800 rows is tiny by any database standard.
```

### 14.6 Data Corruption

**ATTACK: JSONB truncation during PostgreSQL write (connection drops mid-INSERT)**
```
PostgreSQL uses WAL (Write-Ahead Log). If connection drops mid-INSERT:
  → Transaction is incomplete → PostgreSQL rolls back automatically.
  → Row is never committed. No partial JSONB written.

VERDICT: HANDLED by PostgreSQL ACID guarantees. Not possible in PostgreSQL.
```

**ATTACK: JSON serialization produces different strings for identical objects (key order instability)**
```
{ "a": 1, "b": 2 } serialized as '{"a":1,"b":2}' in run 1
{ "b": 2, "a": 1 } serialized as '{"b":2,"a":1}' in run 2
Checksums differ for semantically identical objects → false corruption alert.

Defense: KnowledgeManager uses deterministic serialization:
  JSON.stringify(value, Object.keys(value).sort(), 0)
  OR: serialize to a canonical form before checksum computation.

VERDICT: MITIGATED by deterministic JSON serialization in KnowledgeManager.
RESIDUAL RISK: None if serialization is implemented correctly. Testable.
```

### 14.7 Version Conflicts

**ATTACK: Two Railway instances write knowledge simultaneously (future multi-instance scenario)**
```
S1 and S2 both complete a ShadowLab cycle simultaneously.
Both call knowledgeManager.save('engineC', 'dataset', ...) at the same time.

Both attempt: UPDATE knowledge_artifacts SET superseded_at=NOW() WHERE superseded_at IS NULL

PostgreSQL row-level locking serializes these two UPDATEs.
Winner (S1): supersedes current v12, inserts v13.
Loser (S2): UPDATE returns 0 rows (v12 already superseded by S1).
  → KnowledgeManager detects 0-row update → retries: load v13, compute v14, insert.
  → v14 is computed from S2's dataset, which may differ slightly from S1's.
  → Both v13 and v14 are valid; v14 is the active version.

VERDICT: HANDLED for two-instance scenario. Both datasets are valid; last writer wins.
RESIDUAL RISK: For N-instance concurrent training, the winning artifact may not represent
  the globally optimal training result. Mitigation for N>2 instances: distributed
  training lock (pg_advisory_lock per knowledge artifact during training).
```

### 14.8 Learning Corruption

**ATTACK: A streak of bad trades corrupts Engine D weights permanently**
```
10 consecutive losses due to unusual market conditions (central bank intervention, flash crash).
Engine D: EMA update reduces weights for all "passed" conditions significantly.
New weights: all conditions weighted near 0 → Engine D rejects all signals.
The streak ends; market returns to normal; Engine D is permanently miscalibrated.

Defense:
  1. ValidationManager.checkLearningDegradation():
     Compare current confidence to prior version.
     If confidence drops > 5% → CRITICAL check → ValidationManager triggers rollback.
  2. confidence_decay memory entry tracks confidence over time.
     A sudden drop (< 2 cycles) is flagged as anomalous vs slow drift.
  3. Manual rollback: human can call knowledgeManager.rollback('engineD', 'weights', toVersion=N)
  4. Training rate limiter: Engine D updates every 100 trades, not every trade.
     A 10-trade streak = one partial update only (doesn't complete a training cycle).

VERDICT: MITIGATED. ValidationManager catches degradation before it becomes permanent.
RESIDUAL RISK: If confidence degrades slowly over many cycles (gradual market regime change
  rather than sudden shock), the 5% threshold may not trigger. Long-term monitoring of
  confidence_decay memory namespace provides the early warning.
```

### 14.9 Partial Writes

**ATTACK: Trade lifecycle atomic requirement — four writes must succeed together**
```
For a correct trade_close:
  1. UPDATE trade_intents SET status='CONFIRMED'
  2. UPDATE runtime_domains (live domain)
  3. INSERT INTO events (trade_close)
  4. UPDATE shadowm_trades (exit_time, profit_live)

What if #2 succeeds but #3 and #4 fail (connection drops)?

Defense:
  Wrap these four writes in a single PostgreSQL transaction:
  BEGIN;
    UPDATE trade_intents ... ← #1
    UPDATE runtime_domains ... ← #2
    INSERT INTO events ... ← #3
    UPDATE shadowm_trades ... ← #4
  COMMIT;

  If connection drops after BEGIN: transaction is rolled back automatically.
  All four writes succeed together or none do.
  On retry: IntentManager finds the intent still PENDING → retries all four.

VERDICT: HANDLED by wrapping trade lifecycle mutations in a single transaction.
RESIDUAL RISK: Transaction isolation level matters.
  Use SERIALIZABLE or READ COMMITTED (default in PostgreSQL). 
  READ COMMITTED is sufficient here (no phantom reads in this pattern).
```

---

## Section 15 — Comparison Matrix

### 15.1 Scoring Methodology

Each dimension is scored 1–10. Score justifications follow the table.

```
DIMENSION                    ARCH-A  ARCH-B  ARCH-C  SHADOW OS v2
────────────────────────────────────────────────────────────────────
                             (ESS)   (CSH)   (DIAP)  (v2)
────────────────────────────────────────────────────────────────────
Recovery Time (RTO)            7       9       6/10*   9
Data Loss Prevention (RPO)     7       8       8       9
Ghost Trade Elimination        5       9       9       10
Duplicate Event Safety         8       9       9       10
Learning Continuity            3       3       3       10
Context Continuity             2       2       2       9
Knowledge Corruption Safety    3       3       3       10
Automated Consistency          3       3       3       9
Engine API Isolation           2       2       2       10
Plugin Extensibility           2       2       2       10
Multi-instance readiness       3       3       10      8
Operational Complexity         6       8       4       7
Migration Complexity           6       8       3       7
Cost (Railway)                 9       9       6       9
Startup Performance (scale)    5       5       5       10
History / Audit Capability     10      7       7       10
Future-proofing (5-10yr)       4       5       5       10
────────────────────────────────────────────────────────────────────
WEIGHTED AVERAGE               5.2     6.1     5.4     9.5
────────────────────────────────────────────────────────────────────
* ARCH-C: 6 for Railway restart (3.2s gap), 10 for rolling deploy
```

### 15.2 Score Justifications

**Learning Continuity (ARCH-A/B/C: 3, v2: 10)**
ARCH-A/B/C all rebuild Engine C dataset and Engine D weights from scratch on every restart. After 1 year, this takes 10–18 seconds. After 5 years, it would take minutes. SHADOW OS v2 Knowledge Layer: O(1) startup, incremental updates, full continuity across any number of restarts. Score 10 is the maximum achievable.

**Context Continuity (ARCH-A/B/C: 2, v2: 9)**
No prior architecture has a concept of TTL-based operational memory. Cooldowns, decision history, and market state are all lost on restart in ARCH-A/B/C. In v2, these survive as memory_entries with TTLs. Score 9 (not 10) because there is still up to 100ms of the most recent memory mutations that may not be committed on crash.

**Knowledge Corruption Safety (ARCH-A/B/C: 3, v2: 10)**
ARCH-A/B/C store learned artifacts as JSONB blobs with no checksum, no versioning, and no rollback. A single corrupted value destroys months of learning with no recovery path. SHADOW OS v2: checksums on every artifact, version history for 90 days, auto-rollback on corruption, and lineage tracing. Score 10.

**Plugin Extensibility (ARCH-A/B/C: 2, v2: 10)**
Adding a new engine to ARCH-A/B/C requires: new database queries, new startup recovery paths, new event types, modifications to existing modules. There is no standard contract. SHADOW OS v2: implement EnginePlugin interface, register with EngineRegistry. Zero changes to Manager Tier. Score 10.

**Operational Complexity (ARCH-A: 6, ARCH-B: 8, ARCH-C: 4, v2: 7)**
SHADOW OS v2 is more complex than ARCH-B (more tables, more managers, more concepts) but significantly simpler than ARCH-C (no dual-instance, no leader election, no heartbeat). Score 7 reflects the added complexity that is justified by the capabilities gained.

**Startup Performance at Scale (all ARCH: 5, v2: 10)**
At 10,000 historical trades: ARCH-A/B/C startup is 10–18 seconds. v2 is 97ms. At 100,000 trades: ARCH-A/B/C would be minutes. v2 is still ~97ms (plus artifact load latency). This is not a theoretical future concern — it affects every Railway deployment today as trade history grows.

---

## Section 16 — Implementation Plan

### 16.1 Overview

SHADOW OS v2 builds on ARCH-B. The ARCH-B migration plan (Phases 0–5) remains the foundation. SHADOW OS v2 adds Phases 6–10 on top.

```
FOUNDATION (from ARCH-B):
  Phase 0: Schema additions (runtime_state → runtime_domains, trade_intents)  1 day
  Phase 1: Dual-write to runtime_domains                                       3 days
  Phase 2: Read from runtime_domains on startup                                1 day
  Phase 3: Intent-Confirm for trades + OANDA reconciliation                    3 days
  Phase 4: Shadow M + ShadowLab domain migration                               2 days
  Phase 5: Cleanup ARCH-B                                                      1 day
  ── ARCH-B complete ── (11 days)

SHADOW OS v2 ADDITIONS:
  Phase 6: Memory Layer                                                         3 days
  Phase 7: Knowledge Layer                                                      4 days
  Phase 8: Manager Tier refactor (all managers)                                 5 days
  Phase 9: Recovery Manager + ValidationManager                                 4 days
  Phase 10: Plugin Architecture + Learning Pipeline                             5 days
  ── SHADOW OS v2 complete ── (+21 days = 32 days total)

TOTAL ESTIMATED IMPLEMENTATION: 32 working days (6.5 weeks)
```

### 16.2 Database Changes (complete)

```sql
-- Rename runtime_state → runtime_domains (or create new, migrate, drop old)
-- New tables to add:

-- (1) memory_entries       ← Memory Layer
-- (2) knowledge_artifacts  ← Knowledge Layer
-- (3) event_idempotency    ← Duplicate prevention
-- (4) consistency_log      ← Validation history
-- (5) system_snapshots     ← SnapshotManager

CREATE TABLE system_snapshots (
  id               BIGSERIAL   PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_type     TEXT        NOT NULL,
  runtime_summary  JSONB       NOT NULL,   -- {domain: {version, checksum}}
  memory_summary   JSONB       NOT NULL,   -- {namespace: {count, expired}}
  knowledge_summary JSONB      NOT NULL,  -- [{domain, artifact, version, confidence}]
  system_status    TEXT        NOT NULL
);

-- Index for fast latest snapshot lookup
CREATE INDEX ON system_snapshots (created_at DESC);
```

### 16.3 New Modules (files to create)

```
telemetry/managers/
  state-manager.js        ← 200 LOC — Runtime Layer CRUD
  memory-manager.js       ← 250 LOC — TTL-based memory
  knowledge-manager.js    ← 300 LOC — versioned knowledge artifacts
  intent-manager.js       ← 200 LOC — trade intents (from ARCH-B)
  recovery-manager.js     ← 400 LOC — 9-phase startup
  snapshot-manager.js     ← 150 LOC — periodic snapshots
  validation-manager.js   ← 350 LOC — 12 consistency checks
  engine-registry.js      ← 100 LOC — EnginePlugin registry

telemetry/engines/        ← existing engines wrapped in EnginePlugin interface
  shadow-m-engine.js      ← 100 LOC — wraps shadowm.js in EnginePlugin
  shadow-lab-engine.js    ← 100 LOC — wraps shadowlab.js in EnginePlugin

Total new code: ~2,150 LOC
```

### 16.4 Modified Modules

```
telemetry/shadowm.js:
  - Remove direct db.all/db.get/db.run calls for state restore/save
  - Replace with: stateManager.loadDomain('shadowM'), stateManager.saveDomainRetry()
  - Remove shadowm_cursor events (cursor now in runtime_domains)
  - Implement EnginePlugin interface methods (onRecovery, healthCheck, onShutdown)
  - Estimated changes: ~150 LOC removed, ~80 LOC added

telemetry/shadowlab.js:
  - Remove _init() event-scan code
  - Replace with: stateManager.loadAll(), knowledgeManager.load()
  - _buildDataset() → knowledgeManager.load('engineC', 'dataset') + incremental update
  - _weights() → knowledgeManager.load('engineD', 'weights') + incremental update
  - Add memoryManager.set/get calls for observations, decision_history, market_state
  - Implement EnginePlugin interface
  - Estimated changes: ~300 LOC removed, ~200 LOC added

telemetry/server.js:
  - restoreLiveState() → recoveryManager.run()
  - All state mutation paths → stateManager.saveDomainRetry('live', ...)
  - trade_open/close → intentManager.writeIntent() + confirm pattern
  - Implement graceful shutdown: SIGTERM handler calls stateManager.flush() + snapshot
  - Add GET /api/system/status, GET /api/system/knowledge, GET /api/system/memory endpoints
  - Estimated changes: ~200 LOC removed, ~150 LOC added

telemetry/index.js:
  - No structural changes (logEvent, emitter, getDbStats — unchanged)
  - Add: export of pool reference for Manager Tier injection
```

### 16.5 Migration Phases (detailed)

**Phase 6: Memory Layer (3 days)**

Day 1: Create memory_entries table, implement memory-manager.js
Day 2: Integrate into shadowlab.js — set/get observations, decision_history
Day 3: Integrate into server.js — set/get cooldowns; test TTL expiry

Go/No-Go Gate:
- Cooldown set at T=0 survives process restart, expires correctly at T+TTL
- MemoryManager.get() returns null for expired entries
- GC sweep runs without errors

**Phase 7: Knowledge Layer (4 days)**

Day 1: Create knowledge_artifacts table, implement knowledge-manager.js (load, save, rollback)
Day 2: Implement Engine C incremental dataset update; save to Knowledge Layer after 10 trades
Day 3: Implement Engine D incremental weights update; save after 100 trades
Day 4: Implement Exit Lab knowledge; implement ValidationManager.checkLearningDegradation()

Go/No-Go Gate:
- Engine C dataset loads from Knowledge Layer in <100ms at 2,000 examples
- Engine D weights load in <20ms
- Knowledge rollback correctly creates new version with prior content
- Checksum mismatch triggers CRITICAL check + auto-rollback

**Phase 8: Manager Tier Refactor (5 days)**

Day 1: Implement state-manager.js with optimistic concurrency; run in shadow-write mode
Day 2: Refactor shadowm.js to use StateManager (replace direct db calls)
Day 3: Refactor shadowlab.js to use StateManager, MemoryManager, KnowledgeManager
Day 4: Refactor server.js to use all managers; implement SIGTERM flush
Day 5: Implement engine-registry.js; wrap existing engines in EnginePlugin interface

Go/No-Go Gate:
- No direct db.all/db.get/db.run calls in shadowm.js, shadowlab.js, server.js
- All state mutations go through Manager Tier
- Optimistic concurrency conflict correctly triggers retry (unit tested)

**Phase 9: Recovery Manager + ValidationManager (4 days)**

Day 1: Implement recovery-manager.js with all 9 phases
Day 2: Implement validation-manager.js with all 12 checks
Day 3: Implement snapshot-manager.js; schedule pre-shutdown + post-recovery snapshots
Day 4: Implement consistency_log table; test all checks with simulated failures

Go/No-Go Gate:
- Recovery 9 phases complete in sequence, in <700ms on clean restart
- ValidationManager detects and auto-repairs: shadowm_active_vs_live, intent_stuck
- DEGRADED mode correctly blocks bot spawn

**Phase 10: Plugin Architecture + Learning Pipeline (5 days)**

Day 1: Finalize EnginePlugin interface; verify all engines implement it correctly
Day 2: Implement incremental dataset update for Engine C (replace full rebuild)
Day 3: Implement EMA weight update for Engine D (replace full rebuild)
Day 4: End-to-end test: trade opens, closes, knowledge updates, restart, knowledge persists
Day 5: Documentation, monitoring dashboards, production validation

Go/No-Go Gate:
- At 500 historical trades: startup time ≤200ms (validated on staging)
- Knowledge artifacts persist across 10 consecutive Railway restarts
- No event table scanned at any point during startup
- Full SIM-02 (Railway Restart) simulation passes

### 16.6 Rollback Strategy

```
Each phase is independently reversible:

Phase 6 rollback: DROP TABLE memory_entries; revert memory manager calls
Phase 7 rollback: DROP TABLE knowledge_artifacts; revert engine builds to full rebuild
Phase 8 rollback: Revert shadowm.js, shadowlab.js, server.js to Phase 5 versions
Phase 9 rollback: Revert server.js startup to ARCH-B restoreLiveState()
Phase 10 rollback: Revert to non-incremental learning (only performance regression)

In all cases: git revert to the commit at the end of the prior phase.
ARCH-B phases 0–5 remain in place — minimum safety net is always preserved.
```

### 16.7 Testing Strategy

```
UNIT TESTS (new):
  state-manager.test.js:
    - loadDomain returns correct domain
    - saveDomainRetry: version conflict triggers retry, succeeds on second attempt
    - saveDomainRetry: 3 consecutive conflicts raise ConcurrencyError
    - flush() commits all dirty domains

  memory-manager.test.js:
    - set() writes entry with correct expires_at
    - get() returns null for expired entry
    - get() returns null for missing entry
    - gc() deletes expired entries, returns count
    - Concurrent set() calls: no duplicates (ON CONFLICT)

  knowledge-manager.test.js:
    - save() creates new artifact, supersedes prior
    - load() returns active (non-superseded) artifact
    - load() detects checksum mismatch, returns null, logs CRITICAL
    - rollback() creates new version with content of target version
    - Two concurrent save() calls: one wins, other retries and creates next version

  validation-manager.test.js:
    - live_vs_oanda: detects ghost position, auto-repairs
    - learning_degradation: detects accuracy drop, triggers rollback
    - knowledge_checksums: detects corruption, logs CRITICAL

INTEGRATION TESTS:
  sim-02-railway-restart.test.js:
    Full process: start → trade opens → kill process → restart → verify state correct
  sim-04-crash-during-oanda.test.js:
    Mock: write intent, crash, restart, verify OANDA reconciliation
  sim-07-knowledge-corruption.test.js:
    Manually corrupt checksum → verify rollback to prior version
  sim-14-one-month-offline.test.js:
    Set created_at of memory_entries to past → verify all are expired on load
    Verify system enters DEGRADED, not HEALTHY

PERFORMANCE TESTS:
  startup-at-scale.test.js:
    Insert 10,000 rows into shadowm_trades, 1,000,000 into events
    Measure startup time → must be ≤200ms (non-OANDA phases)
    Measure Phase 4 (knowledge load) ≤100ms with 10,000-example dataset
```

---

## Section 17 — Bonus: Five Strategic Questions

### Q1: Would you deploy this architecture into production?

**Yes, with two conditions:**

1. **ARCH-B first.** ARCH-B must be fully deployed and validated in production for at least 30 days before beginning SHADOW OS v2 Phase 6. The foundation must be stable before the superstructure is built. Skipping ARCH-B and jumping directly to v2 introduces too many simultaneous moving parts.

2. **Incremental phasing.** Each v2 phase (6–10) must pass its gate criteria before the next phase begins. No batch deployments. No "deploy everything at once." The system is processing real money; correctness must be verified at each step.

With these conditions: yes. The architecture is sound, the failure modes are identified and mitigated, and the residual risks are acceptable for a single-account trading bot on Railway. I would have higher confidence deploying this than any trading system I have reviewed that does not have an explicit Recovery Manager and Knowledge Layer.

### Q2: Would you redesign anything further?

**Three specific items:**

**1. Database-native checksums.** The Knowledge Layer uses application-level SHA-256 checksums. PostgreSQL 16 supports `pg_checksum` at the page level, but not at the application data level. A stronger design would store the checksum in a separate, independently indexed column and verify it in a PostgreSQL FUNCTION called as a trigger on every INSERT. This moves corruption detection from the application layer to the database layer — a more robust boundary.

**2. Async knowledge saves.** Currently, knowledgeManager.save() is called synchronously in the ShadowLab cycle. In practice, saving a 20MB JSONB artifact takes ~80ms. Over 30 seconds, this is 0.3% of cycle time — acceptable. But at 100,000 examples (5+ years), this could grow to 800ms, eating 2.7% of each cycle. Recommendation: make knowledgeManager.save() asynchronous in a background queue, with the ShadowLab cycle only writing the in-memory dataset. The background queue flushes every 10 minutes.

**3. Knowledge artifact compression.** The engineC/dataset artifact at 10,000 examples is ~20MB of JSONB. PostgreSQL JSONB storage compresses to ~40% of raw size, but network transfer and parse time are still substantial. At 100,000 examples, this is 200MB — a problem. Recommendation: at >10,000 examples, switch to a chunked artifact model: one artifact per 1,000 examples, a manifest artifact pointing to all chunks. The KNN engine loads only the relevant chunk for nearest-neighbor search (filtering by symbol+session). This reduces per-artifact size to 2MB regardless of total history.

### Q3: Could this architecture support multiple autonomous AI agents?

**Yes. The Manager Tier IS the shared kernel for multiple agents.**

Each agent (bot instance, strategy optimizer, AI coach, paper trader) implements the EnginePlugin interface and registers with the shared EngineRegistry. The Manager Tier mediates all access to the shared PostgreSQL database.

Key requirements for multi-agent operation:
- Each agent owns a distinct set of runtime_domains (e.g., `live_account1`, `live_account2`)
- Knowledge Layer is shared (all agents read the same learned weights) — this is the correct design for collaborative learning
- Memory Layer is namespaced by agent (e.g., `cooldowns_account1`, `cooldowns_account2`)
- IntentManager handles per-agent trade_intents with agent_id column
- OANDA reconciliation is per-account

The architecture already supports this. Multi-agent is a configuration choice, not a redesign.

### Q4: Can it support distributed execution?

**Yes, with one architectural addition: the Distributed Lock Layer.**

SHADOW OS v2 as designed is a single-instance architecture. Distributed execution (N instances, each trading independently) requires:

1. **Per-domain advisory locks:** `pg_try_advisory_lock(domain_hash)` ensures only one instance writes a given domain at a time. This is the foundation of ARCH-C's leader election, generalized to domain-level granularity.

2. **Per-knowledge-artifact write locks:** Only one instance trains at a time. Others read but do not write. The training lock is a PostgreSQL advisory lock held for the duration of the training cycle.

3. **Shared Memory Layer:** memory_entries is already shared (in PostgreSQL). Multiple agents reading/writing cooldowns is safe via the UPSERT ON CONFLICT pattern.

4. **Event fan-out via PostgreSQL LISTEN/NOTIFY:** Instead of each instance polling the events table, the primary writer NOTIFYs a channel, and all instances receive new events in real-time (<10ms latency). This replaces the 5-second polling interval with event-driven updates.

SHADOW OS v3 would include this Distributed Lock Layer as a first-class component.

### Q5: What would SHADOW OS v3 probably look like?

```
SHADOW OS v3 (projected, 2027–2028):

  DEPLOYMENT MODEL:
    Kubernetes on Railway (or AWS EKS)
    3 instances: 1 ACTIVE (trades), 1 HOT-STANDBY (ready in <1s), 1 ANALYTICS (read-only)
    Advisory locks for ACTIVE designation
    Automatic promotion (PGBouncer-aware)

  STREAMING LAYER:
    Replace event table polling with PostgreSQL LISTEN/NOTIFY
    Sub-10ms event propagation across all instances
    No polling intervals (Shadow M, ShadowLab become event-driven)

  KNOWLEDGE LAYER EVOLUTION:
    Knowledge artifacts stored in PostgreSQL for small artifacts (<1MB)
    Large artifacts (>1MB) stored in S3/R2, with PostgreSQL holding only the metadata + checksum
    Distributed training: multiple instances contribute trade data, one coordinator aggregates

  ML INFERENCE LAYER:
    Engine C and D become true ML models (scikit-learn or ONNX runtime)
    Models loaded from Knowledge Layer at startup
    Inference via a local HTTP API (separate process) — decouples model updates from bot restarts
    Model hot-swap: new model loaded in inference process without bot restart

  MACRO INTELLIGENCE:
    News Engine: real-time news scoring via LLM API (economic event impact)
    Macro Engine: long-term regime classification (TRENDING, RANGING, CRISIS)
    AI Coach: post-trade analysis agent — identifies systematic errors
    These consume but never block the trading hot path

  FINANCIAL COMPLIANCE:
    Full audit trail with tamper-evident hash chaining on events table
    MiFID II / regulatory reporting module
    Trade reporting API for compliance officers

  MONITORING:
    Grafana dashboards for all Manager Tier metrics
    Prometheus metrics exported by each manager
    PagerDuty integration for CRITICAL consistency checks
    Real-time P&L tracking per engine, per session, per pair
```

---

## Appendix A — Complete Database DDL

```sql
-- ═══════════════════════════════════════════════════════════════
-- SHADOW OS v2 — Complete Schema DDL
-- ═══════════════════════════════════════════════════════════════

-- ── EXISTING (unchanged) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL   PRIMARY KEY,
  ts      TEXT        NOT NULL,
  bot_id  TEXT,
  type    TEXT        NOT NULL,
  symbol  TEXT,
  data    JSONB
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events (ts DESC);

CREATE TABLE IF NOT EXISTS shadowm_trades (
  id            BIGSERIAL   PRIMARY KEY,
  signal_id     TEXT        UNIQUE NOT NULL,
  symbol        TEXT,
  side          TEXT,
  entry_time    TEXT,
  exit_time     TEXT,
  best_strategy TEXT,
  profit_live   REAL,
  profit_saved  REAL,
  mfe           REAL,
  mae           REAL,
  data          JSONB
);

CREATE TABLE IF NOT EXISTS shadowm_timeline (
  id        BIGSERIAL PRIMARY KEY,
  signal_id TEXT      NOT NULL,
  ts        TEXT      NOT NULL,
  pips      REAL,
  mfe       REAL,
  mae       REAL,
  minutes   REAL
);

-- ── ARCH-B (runtime_domains, trade_intents) ──────────────────────

CREATE TABLE IF NOT EXISTS runtime_domains (
  domain      TEXT        PRIMARY KEY,
  version     BIGINT      NOT NULL DEFAULT 0,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER     NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trade_intents (
  id              BIGSERIAL   PRIMARY KEY,
  signal_id       TEXT        NOT NULL,
  intent_type     TEXT        NOT NULL CHECK (intent_type IN ('OPEN','CLOSE','MODIFY')),
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','CONFIRMED','FAILED','RECONCILED')),
  oanda_order_id  TEXT,
  symbol          TEXT        NOT NULL,
  side            TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  UNIQUE (signal_id, intent_type)
);
CREATE INDEX IF NOT EXISTS idx_ti_pending ON trade_intents (status) WHERE status = 'PENDING';

-- ── SHADOW OS v2 (new tables) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_entries (
  id           BIGSERIAL   PRIMARY KEY,
  namespace    TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  value        JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  access_count BIGINT      NOT NULL DEFAULT 0,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  UNIQUE (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_mem_ns       ON memory_entries (namespace);
CREATE INDEX IF NOT EXISTS idx_mem_expires  ON memory_entries (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_tags     ON memory_entries USING GIN (tags);

CREATE TABLE IF NOT EXISTS knowledge_artifacts (
  id              BIGSERIAL   PRIMARY KEY,
  domain          TEXT        NOT NULL,
  artifact        TEXT        NOT NULL,
  version         BIGINT      NOT NULL,
  value           JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at   TIMESTAMPTZ,
  checksum        TEXT        NOT NULL,
  byte_size       INTEGER,
  training_events INTEGER,
  confidence      REAL,
  migration_from  BIGINT      REFERENCES knowledge_artifacts(id),
  notes           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_active
  ON knowledge_artifacts (domain, artifact) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ka_history
  ON knowledge_artifacts (domain, artifact, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ka_checksum
  ON knowledge_artifacts (domain, artifact, checksum);

CREATE TABLE IF NOT EXISTS event_idempotency (
  key        TEXT        PRIMARY KEY,
  event_id   BIGINT      REFERENCES events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eidem_created ON event_idempotency (created_at);

CREATE TABLE IF NOT EXISTS consistency_log (
  id            BIGSERIAL   PRIMARY KEY,
  check_id      TEXT        NOT NULL,
  severity      TEXT        NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  domain        TEXT,
  description   TEXT        NOT NULL,
  detail        JSONB,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  auto_repaired BOOLEAN     NOT NULL DEFAULT FALSE,
  repair_detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_clog_open ON consistency_log (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clog_sev  ON consistency_log (severity, detected_at DESC);

CREATE TABLE IF NOT EXISTS system_snapshots (
  id                BIGSERIAL   PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_type      TEXT        NOT NULL,
  runtime_summary   JSONB       NOT NULL,
  memory_summary    JSONB       NOT NULL,
  knowledge_summary JSONB       NOT NULL,
  system_status     TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_created ON system_snapshots (created_at DESC);

-- ── Bootstrap runtime_domains ────────────────────────────────────

INSERT INTO runtime_domains (domain, version, value, schema_ver) VALUES
  ('live',      0, '{"dailyTrades":0,"openTrades":{},"date":"","sequence":0}', 1),
  ('shadowA',   0, '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}', 1),
  ('shadowB',   0, '{"signalsSeen":0,"signalsBlocked":0,"lastEvalTs":"","frozen":true}', 1),
  ('shadowC',   0, '{"datasetVersion":0,"datasetSize":0,"lastTrainTs":"","nearestK":5,"accuracy":0}', 1),
  ('shadowD',   0, '{"weightsVersion":0,"lastTrainTs":"","conditionCount":0,"topConditions":[],"confidence":0}', 1),
  ('shadowM',   0, '{"lastId":0,"active":{},"knownSids":[],"pollCount":0,"lastPollTs":""}', 1),
  ('exitLab',   0, '{"strategiesLoaded":[],"bestStrategy":"","strategyVersions":{},"evaluationsThisSession":0}', 1),
  ('telemetry', 0, '{"lastEventId":0,"eventCount":0,"errorCount":0,"lastErrorTs":"","dbBackend":""}', 1),
  ('scheduler', 0, '{"nextCycleTs":"","lastCycleTs":"","cycleCount":0,"shadowLabInterval":30000,"botPid":null}', 1),
  ('meta',      0, '{"systemVersion":"v40.1","schemaVersion":1,"bootCount":0,"uptimeStart":"","lastCleanShutdown":"","status":"HALTED"}', 1)
ON CONFLICT (domain) DO NOTHING;
```

---

## Appendix B — Full Interface Specifications

*(All interfaces are expressed in TypeScript notation for clarity. Implementation is in JavaScript.)*

```typescript
// ── CORE TYPES ──────────────────────────────────────────────────

interface DomainState {
  domain:    string;
  version:   number;
  value:     Record<string, unknown>;
  updatedAt: string;
  schemaVer: number;
}

interface MemoryEntry {
  namespace:   string;
  key:         string;
  value:       Record<string, unknown>;
  createdAt:   string;
  updatedAt:   string;
  expiresAt:   string | null;
  accessCount: number;
  tags:        string[];
}

interface KnowledgeArtifact {
  id:             number;
  domain:         string;
  artifact:       string;
  version:        number;
  value:          Record<string, unknown>;
  createdAt:      string;
  supersededAt:   string | null;
  checksum:       string;
  byteSize:       number | null;
  trainingEvents: number | null;
  confidence:     number | null;
  migrationFrom:  number | null;
  notes:          string | null;
}

interface TradeIntent {
  id:            number;
  signalId:      string;
  intentType:    'OPEN' | 'CLOSE' | 'MODIFY';
  status:        'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILED';
  oandaOrderId:  string | null;
  symbol:        string;
  side:          string | null;
  payload:       Record<string, unknown>;
  createdAt:     string;
  confirmedAt:   string | null;
  failureReason: string | null;
}

interface ConsistencyCheck {
  id:           number;
  checkId:      string;
  severity:     'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  domain:       string | null;
  description:  string;
  detail:       Record<string, unknown> | null;
  detectedAt:   string;
  resolvedAt:   string | null;
  resolution:   string | null;
  autoRepaired: boolean;
  repairDetail: Record<string, unknown> | null;
}

// ── MANAGER INTERFACES (full specification) ─────────────────────

interface StateManager {
  loadDomain(domain: string): Promise<DomainState | null>;
  loadAll(): Promise<Record<string, DomainState>>;
  saveDomain(domain: string, value: Record<string, unknown>, expectedVersion: number):
    Promise<{ ok: boolean; newVersion: number; conflictRetries: number }>;
  saveDomainRetry(
    domain: string,
    transform: (current: Record<string, unknown>) => Record<string, unknown>,
    maxRetries?: number  // default: 3
  ): Promise<{ ok: boolean; newVersion: number; retries: number }>;
  flush(): Promise<void>;
  migrateIfNeeded():
    Promise<Array<{ domain: string; from: number; to: number }>>;
  getCached(domain: string): DomainState | null;  // synchronous, uses in-memory cache
  setCached(domain: string, value: Record<string, unknown>): void;
}

interface MemoryManager {
  set(
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    opts?: { ttlMs?: number; tags?: string[]; refresh?: boolean }
  ): Promise<void>;
  get(namespace: string, key: string): Promise<Record<string, unknown> | null>;
  getAll(namespace: string): Promise<Record<string, Record<string, unknown>>>;
  getByTags(namespace: string, tags: string[]): Promise<Record<string, Record<string, unknown>>>;
  delete(namespace: string, key: string): Promise<void>;
  touch(namespace: string, key: string, newTtlMs: number): Promise<void>;
  expire(namespace: string, key: string): Promise<void>;
  gc(): Promise<{ deleted: number; namespaces: Record<string, number> }>;
  scheduleGC(intervalMs: number): void;
  stats(): Promise<{
    totalEntries: number;
    expiredEntries: number;
    namespaces: Array<{ namespace: string; count: number; expiredCount: number }>
  }>;
}

interface KnowledgeManager {
  load(domain: string, artifact: string): Promise<KnowledgeArtifact | null>;
  save(
    domain:   string,
    artifact: string,
    value:    Record<string, unknown>,
    opts?:    { trainingEvents?: number; confidence?: number; notes?: string }
  ): Promise<KnowledgeArtifact>;
  loadHistory(
    domain:   string,
    artifact: string,
    limit?:   number  // default: 10
  ): Promise<KnowledgeArtifact[]>;
  rollback(
    domain:    string,
    artifact:  string,
    toVersion: number
  ): Promise<KnowledgeArtifact>;
  migrate(
    domain:      string,
    artifact:    string,
    migrationFn: (v: Record<string, unknown>) => Record<string, unknown>,
    notes:       string
  ): Promise<KnowledgeArtifact>;
  verifyAll(): Promise<Array<{
    domain:    string;
    artifact:  string;
    ok:        boolean;
    error?:    string;
    rolledBackTo?: number;
  }>>;
  confidence(domain: string, artifact: string): Promise<number | null>;
  prune(keepDays?: number): Promise<{ deleted: number }>;  // default: 90 days
}

interface IntentManager {
  writeIntent(
    signalId:  string,
    type:      'OPEN' | 'CLOSE' | 'MODIFY',
    symbol:    string,
    side:      string | null,
    payload:   Record<string, unknown>
  ): Promise<TradeIntent>;
  confirmIntent(signalId: string, oandaOrderId: string): Promise<void>;
  failIntent(signalId: string, reason: string): Promise<void>;
  markReconciled(signalId: string, detail: string): Promise<void>;
  getPendingIntents(): Promise<TradeIntent[]>;
  reconcileWithOanda(
    oandaBaseUrl: string,
    oandaToken:   string,
    accountId:    string,
    liveOpenTrades: Record<string, unknown>
  ): Promise<Array<{
    signalId: string;
    action:   'CONFIRMED' | 'FAILED' | 'NO_ACTION';
    detail:   string;
  }>>;
  cleanupStale(maxAgeHours?: number): Promise<number>;  // default: 24h
}

interface RecoveryManager {
  run(
    oandaCredentials?: { baseUrl: string; token: string; accountId: string }
  ): Promise<RecoveryReport>;
  runPhase(phase: RecoveryPhase): Promise<PhaseReport>;
  getLastReport(): RecoveryReport | null;
  getSystemStatus(): 'HEALTHY' | 'DEGRADED' | 'HALTED';
  setSystemStatus(status: 'HEALTHY' | 'DEGRADED' | 'HALTED', reason: string): Promise<void>;
}

type RecoveryPhase = 'SCHEMA' | 'DOMAINS' | 'MEMORY' | 'KNOWLEDGE' |
                     'INTENTS' | 'OANDA' | 'ENGINES' | 'VALIDATION' | 'READY';

interface PhaseReport {
  phase:      RecoveryPhase;
  ok:         boolean;
  durationMs: number;
  detail:     string;
  issues:     string[];
  actions:    string[];  // auto-repair actions taken
}

interface RecoveryReport {
  startedAt:   string;
  completedAt: string;
  totalMs:     number;
  status:      'HEALTHY' | 'DEGRADED' | 'HALTED';
  phases:      PhaseReport[];
  blockers:    string[];
  warnings:    string[];
}

interface SnapshotManager {
  takeSnapshot(trigger?: 'SCHEDULED' | 'MANUAL' | 'PRE_SHUTDOWN' | 'POST_RECOVERY'):
    Promise<{ id: number; createdAt: string; trigger: string }>;
  scheduleSnapshots(intervalMs: number): void;
  getLatestSnapshot(): Promise<{
    id: number; createdAt: string; trigger: string;
    runtimeSummary:   Record<string, { version: number }>;
    memorySummary:    Record<string, { count: number }>;
    knowledgeSummary: Array<{ domain: string; artifact: string; version: number; confidence: number | null }>;
    systemStatus:     string;
  } | null>;
}

interface ValidationManager {
  runChecks(
    oandaCredentials?: { baseUrl: string; token: string; accountId: string }
  ): Promise<ValidationReport>;
  scheduleChecks(intervalMs: number): void;
  getRecentIssues(
    severity?: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL',
    limit?: number
  ): Promise<ConsistencyCheck[]>;
  checkLiveVsOanda(oandaCredentials: { baseUrl: string; token: string; accountId: string }):
    Promise<ConsistencyCheck[]>;
  checkShadowMCursor():         Promise<ConsistencyCheck[]>;
  checkKnowledgeChecksums():    Promise<ConsistencyCheck[]>;
  checkMemoryLeak():            Promise<ConsistencyCheck[]>;
  checkLearningDegradation():   Promise<ConsistencyCheck[]>;
  checkIntentStuck():           Promise<ConsistencyCheck[]>;
  checkDailyCounterDrift():     Promise<ConsistencyCheck[]>;
}

interface ValidationReport {
  ranAt:      string;
  durationMs: number;
  checksRun:  number;
  issues:     ConsistencyCheck[];
  repaired:   ConsistencyCheck[];
  status:     'CLEAN' | 'ISSUES_FOUND' | 'REPAIR_FAILED';
}

interface EnginePlugin {
  readonly name:    string;
  readonly version: string;
  readonly ownedDomains:    string[];
  readonly ownedArtifacts:  Array<{ domain: string; artifact: string }>;
  readonly memoryNamespaces: string[];
  onRecovery(
    domains:   Record<string, Record<string, unknown>>,
    knowledge: Record<string, KnowledgeArtifact | null>,
    memory:    Record<string, Record<string, Record<string, unknown>>>
  ): Promise<{ ok: boolean; issues: string[] }>;
  onDegraded(reason: string): void;
  onShutdown(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; metrics: Record<string, number | string> }>;
}

interface EngineRegistry {
  register(engine: EnginePlugin): void;
  getAll(): EnginePlugin[];
  get(name: string): EnginePlugin | null;
  runRecovery(
    domains:   Record<string, Record<string, unknown>>,
    knowledge: Record<string, KnowledgeArtifact | null>,
    memory:    Record<string, Record<string, Record<string, unknown>>>
  ): Promise<Array<{ engine: string; ok: boolean; issues: string[] }>>;
  runHealthChecks():
    Promise<Array<{ engine: string; ok: boolean; metrics: Record<string, number | string> }>>;
}
```

---

## Appendix C — Configuration Reference

```
Environment Variables for SHADOW OS v2:

DATABASE_URL         PostgreSQL connection string (required)
OANDA_TOKEN          OANDA API key (required for PHASE 6 reconciliation)
OANDA_ACCOUNT_ID     OANDA account ID (required)
OANDA_BASE_URL       https://api-fxtrade.oanda.com/v3 (production)
                     https://api-fxpractice.oanda.com/v3 (practice)

RECONCILE_POLICY     'AUTO' (auto-repair ghost trades) | 'FLAG' (alert only, default)
OFFLINE_POLICY       'SUPERVISED_RESTART' (require human approval, default)
                     | 'AUTO_RESUME' (resume immediately)

KNOWLEDGE_PRUNE_DAYS  Days to keep superseded knowledge artifacts (default: 90)
MEMORY_GC_INTERVAL_MS GC sweep interval in ms (default: 3600000 = 1h)
SNAPSHOT_INTERVAL_MS  Runtime snapshot interval in ms (default: 300000 = 5min)
VALIDATION_INTERVAL_MS Consistency check interval in ms (default: 300000 = 5min)
LEARNING_DEGRADATION_THRESHOLD Accuracy drop % to trigger rollback (default: 0.05 = 5%)
CONCURRENT_WRITE_MAX_RETRIES Max retries for optimistic concurrency (default: 3)
INTENT_STALE_HOURS   Hours before PENDING intent is considered stuck (default: 5/60 = 5min expressed in hours)
KNOWLEDGE_CHUNK_THRESHOLD Max examples before chunked artifact storage (default: 10000)

System Admin Endpoints (GET only, no authentication in current design):
  GET /api/system/status       → {status, bootCount, uptimeSeconds, version}
  GET /api/system/domains      → {domain: {version, updatedAt, schemaVer}}
  GET /api/system/knowledge    → [{domain, artifact, version, confidence, byteSize, createdAt}]
  GET /api/system/memory       → [{namespace, key, expiresIn, tags}]
  GET /api/system/validation   → {lastRun, status, openIssues}
  GET /api/system/recovery     → lastRecoveryReport
  POST /api/system/snapshot    → triggers manual snapshot
  POST /api/system/validate    → triggers immediate validation run
```

---

*SHADOW OS v2 — Architecture design complete. Ready for implementation approval.*

*This document supersedes SHADOW_OS_ARCHITECTURE_V1.md.*  
*Implementation begins with ARCH-B Phases 0–5, then continues with SHADOW OS v2 Phases 6–10.*

*To generate PDF: `pandoc SHADOW_OS_V2.md -o SHADOW_OS_V2.pdf --pdf-engine=xelatex -V geometry:margin=1in`*
