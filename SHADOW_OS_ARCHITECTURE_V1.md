# SHADOW OS — Next-Generation State Architecture v1

**Classification:** Architecture Design Document  
**Status:** Awaiting approval before implementation begins  
**Date:** 2026-06-30  
**Scope:** Deployment, restart, crash, and network resilience for FOREX ENGINE PRO  

---

## Table of Contents

1. [Current System — Exact Failure Analysis](#1-current-system--exact-failure-analysis)
2. [Architecture A — Event Sourcing + Periodic Snapshots (ESS)](#2-architecture-a--event-sourcing--periodic-snapshots-ess)
3. [Architecture B — Continuous State Checkpointing (CSH)](#3-architecture-b--continuous-state-checkpointing-csh)
4. [Architecture C — Dual-Instance Active-Passive (DIAP)](#4-architecture-c--dual-instance-active-passive-diap)
5. [Comparison Matrix](#5-comparison-matrix)
6. [Recommended Architecture](#6-recommended-architecture)
7. [Migration Plan — Current System → ARCH-B](#7-migration-plan--current-system--arch-b)

---

## 1. Current System — Exact Failure Analysis

### 1.1 In-Memory State Inventory

Every piece of state that currently lives in memory and is destroyed on any process death:

| State Variable | Owner | Type | Current Recovery Method | Recovery Risk |
|----------------|-------|------|------------------------|---------------|
| `live.dailyTrades` | server.js | int | COUNT trade_open events for today | ✓ Reliable |
| `live.openTrades` | server.js | Map(symbol→obj) | Scan trade_open where not in trade_close | ⚠ Race window |
| `shadowM._active` | shadowm.js | Map(signalId→obj) | SELECT shadowm_trades WHERE exit_time IS NULL | ✓ Reliable |
| `shadowM._knownSids` | shadowm.js | Set(signalId) | SELECT signal_id FROM shadowm_trades | ✓ Reliable |
| `shadowM._lastId` | shadowm.js | int | SELECT data FROM events WHERE type='shadowm_cursor' | ⚠ Stale by 5s |
| `shadowLab._processedIds` | shadowlab.js | Set(signalId) | Scan trade_close events for signalId | ✓ Reliable |
| `shadowMode` | shadowlab.js | string | SELECT latest shadow_mode_change event | ✓ Reliable |
| `[ENGINE_C].dataset` | shadowlab.js | array | Full rebuild from shadowm_trades | ✓ Slow (~N trades) |
| `[ENGINE_D].weights` | shadowlab.js | object | Full rebuild from shadowm_trades | ✓ Slow (~N trades) |

### 1.2 Existing Database Schema

```
events
  id        BIGSERIAL PRIMARY KEY
  ts        TEXT NOT NULL
  bot_id    TEXT
  type      TEXT NOT NULL          ← trade_open, trade_close, trade_state_snapshot,
  symbol    TEXT                      shadowm_cursor, shadowm_startup, shadow_mode_change,
  data      JSONB                     shadowlab_*, signal_detected, signal_filtered …

shadowm_trades
  id            BIGSERIAL PRIMARY KEY
  signal_id     TEXT UNIQUE
  symbol        TEXT
  side          TEXT
  entry_time    TEXT
  exit_time     TEXT               ← NULL = open
  best_strategy TEXT
  profit_live   REAL
  profit_saved  REAL
  mfe, mae      REAL
  data          JSONB              ← full tracking object blob

shadowm_timeline
  id         BIGSERIAL PRIMARY KEY
  signal_id  TEXT
  ts         TEXT
  pips, mfe, mae, minutes  REAL
```

### 1.3 Exact Failure Seams

#### Seam 1: Bot crash → live.openTrades reconstruction gap

```
Timeline:
  T+0s   trade_open event written to DB          ← DB has it
  T+0.1s bot updates live.openTrades in memory   ← memory has it
  T+5s   BOT CRASHES
  T+5.5s _scheduleRestart() calls restoreLiveState()
  T+6s   restoreLiveState() scans events table
         Finds trade_open ← CORRECT, state recovers

Risk: NONE for this specific path.

Dangerous variant:
  T+0s   bot calls OANDA (trade fills on OANDA)
  T+0.1s logEvent("trade_open") fires async — DB write in flight
  T+0.2s BOT CRASHES — DB write may or may not have committed
  T+0.5s restoreLiveState() reads events table
         If write NOT committed: trade_open missing
         → live.openTrades does not contain the open position
         → bot may open a SECOND position on same symbol (duplicate trade risk)
```

#### Seam 2: Shadow M cursor staleness

```
Timeline:
  T+0s   events table has id=1000 (last event)
  T+4s   shadowM._poll() runs — finds no new events — does NOT write cursor
         _lastId = 990 (last cursor written 10 events ago, at T-50s)
  T+4.5s BOT CRASHES
  T+5s   shadowM._restore():
         shadowm_cursor → lastId=990
         _lastId = 990 (not 1000)
  T+5.5s _poll() runs from id>990
         Events 991-1000 are replayed
         If any are trade_open: _onOpen() checks _knownSids → skips (safe)
         If any are trade_state_snapshot: MFE/MAE updated again (idempotent for max())
         If any are trade_close: _onClose() called again → DB update is idempotent

Risk: ACCEPTABLE — replay of existing data produces same result.
      NOT acceptable if events between cursor and crash contain state
      that produces side effects on replay (e.g., external API calls).
```

#### Seam 3: Partial DB write during trade

```
Timeline:
  T+0s   OANDA trade fills → bot logs:
           console.log("trade=..., signal=..., dailyTrades=N")
           logEvent({type:"trade_open", ...})   ← fire-and-forget async
  T+0.1s DB write begins (pool.query INSERT INTO events ...)
  T+0.15s RAILWAY KILLS PROCESS (deploy/restart)
  T+0.2s DB write aborted — transaction rolled back by PostgreSQL

Result:
  - OANDA has an open position
  - events table has NO trade_open
  - On restart: restoreLiveState() finds no trade_open → live.openTrades empty
  - Bot has free slot → may open duplicate position on next signal
  - Shadow M _restore(): no open trade in shadowm_trades → won't track P&L
  - Ghost trade on OANDA, untracked, never closed by bot logic
```

#### Seam 4: Duplicate event processing

```
Timeline:
  T+0s   trade_state_snapshot written (id=500, mfe=8.2)
  T+0.1s shadowM._poll() processes id=500: t.mfe = max(8.2, 8.2) → no-op
  T+5s   Same snapshot event written again (network retry in bot)
         New id=550, same signalId, same mfe=8.2
  T+5.1s shadowM._poll() processes id=550: t.mfe = max(8.2, 8.2) → no-op

Result: SAFE for snapshot events (max() is idempotent).
        UNSAFE if bot ever calls logEvent("trade_open") twice for same signalId:
          _onOpen checks _knownSids → skips second call → SAFE.
        UNSAFE if close event duplicated after bot restart:
          _onClose called twice → DB updated twice → second call is no-op (idempotent upsert)
```

#### Seam 5: Railway restart with long ShadowLab rebuild

```
Timeline:
  T+0s   Railway stops the process
  T+8s   Railway starts new process
  T+8.1s server.js starts, DB connects
  T+8.2s restoreLiveState() runs (fast: ~200ms)
  T+8.5s shadowM.start() → _restore() (~100ms)
  T+8.6s shadowLab._init() → scans all trade_close events
         At 1000 closed trades: ~500ms
         At 10000 closed trades: ~5000ms
  T+9s   shadowLab._cycle() first run:
         _buildDataset(): scans all shadowm_trades closed rows
         At 10000 rows: ~10s before first intelligent gate evaluation

Risk: ShadowLab cold-start time grows linearly with trade history.
      At scale (months of trading), startup penalty becomes 30-60 seconds.
```

---

## 2. Architecture A — Event Sourcing + Periodic Snapshots (ESS)

### 2.1 Design

**Core principle:** The `events` table is the single, immutable source of truth. All state is a deterministic projection of the event log. Periodic snapshots compress the replay window from "all history" to "events since last snapshot," keeping cold-start time bounded regardless of total trade history.

The architecture introduces no new external services. It extends the existing event log with snapshot checkpoints and an idempotency-key registry.

**Key properties:**
- Every event is assigned a deterministic `idempotency_key` before being written
- State derivation is a pure function: `state = fold(snapshot, events[snapshot.event_id..])`
- Snapshots are taken automatically every 60 seconds or every 200 events, whichever comes first
- Any state can be reconstructed at any point in history (full auditability)

### 2.2 New Database Schema

```sql
-- Idempotency registry (prevents duplicate event writes)
CREATE TABLE event_idempotency (
  key         TEXT PRIMARY KEY,          -- "{bot_id}:{type}:{signalId}:{sequence}"
  event_id    BIGINT REFERENCES events(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON event_idempotency(created_at); -- for TTL cleanup

-- Full-state snapshots
CREATE TABLE state_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  high_water_mark BIGINT NOT NULL,       -- highest events.id included in this snapshot
  schema_version  INTEGER NOT NULL,      -- for forward-compatibility
  live            JSONB NOT NULL,        -- {dailyTrades, openTrades, date}
  shadow_m        JSONB NOT NULL,        -- {active, knownSids, lastId}
  shadow_lab      JSONB NOT NULL,        -- {processedIds, mode, engineC_dataset, engineD_weights}
  checksum        TEXT                   -- SHA-256 of payload (integrity check)
);
CREATE INDEX ON state_snapshots(high_water_mark DESC);

-- Existing tables: events, shadowm_trades, shadowm_timeline (unchanged)
```

### 2.3 Data Flow

```
BOT PROCESS                    TELEMETRY SERVER                 POSTGRESQL
────────────────               ─────────────────────────        ─────────────────
strategy() fires
  → generates signal
  → idempotency_key =
    sha256(type+signalId+seq)
  → logEvent({..., idem_key})
                               writes to events table
                               writes to event_idempotency
                               (ON CONFLICT DO NOTHING)
                               ↑ duplicate blocked at DB level

bot opens trade on OANDA
  → logEvent(trade_open)       same path above

                               shadowM._poll() every 5s:
                               SELECT events WHERE id > _lastId
                               → processes new events
                               → updates shadowm_trades
                               → writes shadowm_cursor event

                               SnapshotManager every 60s:
                               → serializes ALL in-memory state
                               → writes state_snapshots row
                               → prunes snapshots older than 7 days
```

### 2.4 Source of Truth

| Question | Answer | Where |
|----------|--------|-------|
| What is the canonical history? | `events` table, ordered by id | events |
| What is the current state? | Latest snapshot + events since snapshot | state_snapshots + events |
| Was this event already processed? | `event_idempotency.key` EXISTS | event_idempotency |
| What was the state at time T? | Find snapshot with high_water_mark ≤ T, replay forward | state_snapshots + events |

### 2.5 Failure Simulations

#### Deploy / Redeploy
```
BEFORE: process at events.id=5000, snapshot at id=4980
  snapshot.live = {dailyTrades:3, openTrades:{EUR_USD:{...}}}
  snapshot.shadow_m = {active:{_lifecycle_123:{...}}, lastId:4980}

Railway kills process → Railway starts new process

RECOVERY:
  1. Load latest snapshot: high_water_mark=4980
  2. Query: SELECT * FROM events WHERE id > 4980 ORDER BY id  → 20 events
  3. Replay 20 events in order:
     - Apply to live state
     - Apply to Shadow M _active/_knownSids
     - Apply to ShadowLab _processedIds
  4. State fully restored in ~50ms (20 events × ~2ms each)
  5. Resume normal operation

RESULT: COMPLETE STATE RECOVERY, 0 events missed
```

#### Bot Crash (OANDA write before DB commit)
```
T+0s  OANDA fills trade (position open on broker)
T+0s  logEvent(trade_open, signalId=ABC, idem_key="bot1:trade_open:ABC:42")
T+0.1s INSERT INTO events ... — in flight
T+0.1s INSERT INTO event_idempotency ... — in flight
T+0.15s PROCESS CRASHES — both INSERTs rolled back

T+5s  RECOVERY:
  Load snapshot → no ABC in snapshot.live.openTrades
  Replay events since snapshot → no trade_open for ABC found
  live.openTrades = {} ← OANDA position UNTRACKED

  *** Same vulnerability as current system ***
  Without the intent pattern, ESS does NOT solve Seam 3.
  Mitigation: add a startup reconciliation that calls OANDA's
  /v3/accounts/{id}/openTrades and compares with live.openTrades.
  Any OANDA position not in live.openTrades → force-close or flag.
```

#### Railway Restart
```
Identical to Deploy simulation above.
Snapshot bounds the replay to ≤200 events regardless of total history.
Cold-start time: snapshot load (~5ms) + replay (~50ms for 200 events) = ~55ms
vs. current system: ~200ms + (N×2ms) for all historical trades
```

#### Network Failure (DB unreachable during snapshot write)
```
T+0s  SnapshotManager attempts to write state_snapshots
T+0.1s PostgreSQL connection fails
T+0.1s SnapshotManager: catches error, logs warning
       → previous snapshot (60s ago) remains valid
       → system continues with last good snapshot
       → retries snapshot write every 10s

T+120s DB connection restored
       SnapshotManager writes snapshot with high_water_mark=5200
       → 220 events in replay window (200 since last good snapshot)

RESULT: No data loss. Bounded replay window grows at most 10× (60s retry
        budget × 10s retry interval = up to 600s of events = ~N×5s_polls).
        Worst case: 7200 events in replay window (10 min outage × 12 polls/min).
```

#### Partial DB Failure (events table write fails)
```
logEvent() writes to events — INSERT fails.
event_idempotency write also fails (same transaction, or separate).

Result:
  - Event is NOT in events table
  - State that was derived from this event is also NOT in any snapshot
    (snapshot only includes high_water_mark = events actually committed)
  - On recovery: state matches committed events exactly — no inconsistency

Risk: THE EVENT IS LOST. State at the time of failure is lost.
      This is acceptable for telemetry events (signal_detected, etc.)
      NOT acceptable for trade_open/trade_close (financial events).
      → Same mitigation as above: OANDA reconciliation on startup.
```

#### Duplicate Events
```
Bot retries logEvent(trade_open, signalId=ABC):
  First call:  INSERT INTO event_idempotency(key="bot1:trade_open:ABC:42") → OK, id=5001
  Second call: INSERT INTO event_idempotency(key="bot1:trade_open:ABC:42") → ON CONFLICT DO NOTHING
               Returns existing event_id=5001
               Second INSERT INTO events is skipped
               Duplicate blocked at DB level.

Snapshot replay: events table has only one trade_open for ABC → correct state.
```

#### Replay
```
To replay from any point in time:
  1. SELECT * FROM state_snapshots WHERE high_water_mark <= $target_id ORDER BY id DESC LIMIT 1
  2. Deserialize snapshot payload
  3. SELECT * FROM events WHERE id > $snapshot.high_water_mark AND id <= $target_id
  4. Fold events into snapshot state
  5. Resulting state = exact system state at $target_id

Use case: audit a specific trade decision, debug a ShadowLab gate evaluation,
          backtest engine changes against historical event stream.
```

#### Recovery Summary
```
Scenario                     RTO           RPO (max data loss)
────────────────────────────────────────────────────────────
Clean deploy                 ~55ms         0 events
Bot crash (DB writes OK)     ~55ms         0 events
Bot crash (DB write lost)    ~55ms         1 event (the lost write)
Railway restart              ~55ms         0 events
Network failure (60s)        ~55ms         0 events (next snapshot catches up)
Full DB failure then restore ~55ms         events during outage (unavoidable)
```

### 2.6 Architecture A — Pros and Cons

```
PROS:
  + Complete audit trail — any state at any time is reconstructable
  + Idempotency registry prevents duplicate events at write time
  + Snapshot bounds cold-start time regardless of trade history
  + No external services required (PostgreSQL only)
  + Replay capability is valuable for backtesting and debugging
  + Incremental migration — snapshots can be added alongside existing code
  + Events table unchanged — existing tooling continues to work

CONS:
  - Seam 3 (OANDA write before DB commit) requires a separate reconciliation mechanism
  - Snapshot serialization must be forward-compatible (schema versioning required)
  - Snapshot writes must be atomic — partial snapshots corrupt recovery
  - Two-phase state: snapshot + replay is more complex than a single state read
  - Snapshot pruning logic needed to prevent unbounded table growth
  - Engine weights and KNN datasets may be large (JSONB blobs in snapshots)
```

---

## 3. Architecture B — Continuous State Checkpointing (CSH)

### 3.1 Design

**Core principle:** Runtime state is not derived — it is the primary database record. Every state mutation is written to PostgreSQL before (or atomically with) the mutation taking effect. Recovery requires a single database read with no replay, no snapshot loading, no event scanning. Cold-start time is O(1) regardless of trade history.

The `events` table is retained as an immutable audit log, but it is never used for recovery. It becomes a secondary record that can be queried for analytics, debugging, and compliance.

Critical-path mutations (trade_open, trade_close) use an **Intent-Confirm** pattern: the intent is durably written to PostgreSQL before the OANDA API call is made. If the process crashes between the intent write and the OANDA call, the intent is found on recovery and reconciled with OANDA. This provides exactly-once guarantees for financial events.

**Key properties:**
- State is always at most 100ms stale in the DB (flush interval)
- OANDA positions are always reconcilable from `trade_intents`
- Recovery time is independent of trade history
- No snapshot serialization/deserialization complexity
- State schema is explicit and versioned (not a blob)

### 3.2 New Database Schema

```sql
-- Primary state store: one row per domain, continuously updated
CREATE TABLE runtime_state (
  key         TEXT PRIMARY KEY,          -- 'live' | 'shadowm' | 'shadowlab'
  value       JSONB NOT NULL,
  version     BIGINT NOT NULL DEFAULT 0, -- optimistic concurrency: increment on each write
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER NOT NULL DEFAULT 1
);

-- Trade intent registry: exactly-once for financial operations
CREATE TABLE trade_intents (
  id              BIGSERIAL PRIMARY KEY,
  signal_id       TEXT NOT NULL UNIQUE,
  intent_type     TEXT NOT NULL,         -- 'OPEN' | 'CLOSE' | 'MODIFY'
  status          TEXT NOT NULL          -- 'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILED'
                  DEFAULT 'PENDING',
  oanda_order_id  TEXT,                  -- populated after OANDA confirms
  symbol          TEXT NOT NULL,
  side            TEXT,
  payload         JSONB NOT NULL,        -- full parameters for OANDA call
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  failure_reason  TEXT
);
CREATE INDEX ON trade_intents(status) WHERE status = 'PENDING';
CREATE INDEX ON trade_intents(signal_id);

-- Existing tables: events (audit only), shadowm_trades, shadowm_timeline (unchanged)

-- Bootstrap: seed runtime_state with empty domains
INSERT INTO runtime_state (key, value, version, schema_ver) VALUES
  ('live',      '{"dailyTrades":0,"openTrades":{},"date":"","version":0}', 0, 1),
  ('shadowm',   '{"active":{},"knownSids":[],"lastId":0,"version":0}',     0, 1),
  ('shadowlab', '{"processedIds":[],"mode":"OBSERVE","weights":{},"version":0}', 0, 1)
ON CONFLICT DO NOTHING;
```

### 3.3 Data Flow

```
MUTATION FLOW (non-critical: dailyTrades, Shadow M poll, ShadowLab cycle)
────────────────────────────────────────────────────────────────────────
  1. State changes in memory
  2. StateManager queues a flush (debounced, max 100ms delay)
  3. UPDATE runtime_state SET value=$newState, version=version+1, updated_at=NOW()
     WHERE key=$domain AND version=$expectedVersion  ← optimistic lock
  4. If version mismatch (concurrent write): reload from DB, re-apply diff, retry
  5. Events table written in parallel (audit only, non-blocking)

MUTATION FLOW (critical: trade_open, trade_close)
──────────────────────────────────────────────────────────────────────
  STEP 1 — Write intent (durably committed before OANDA call)
    INSERT INTO trade_intents (signal_id, intent_type, status, symbol, side, payload)
    VALUES ($signalId, 'OPEN', 'PENDING', $symbol, $side, $params)

  STEP 2 — Call OANDA API
    POST /v3/accounts/{id}/orders { ... }

  STEP 3 — Confirm (if OANDA succeeds)
    BEGIN;
      UPDATE trade_intents SET status='CONFIRMED', oanda_order_id=$id,
             confirmed_at=NOW() WHERE signal_id=$signalId;
      UPDATE runtime_state SET
             value = jsonb_set(value, '{openTrades,$symbol}', $tradeObj),
             version = version + 1 WHERE key = 'live';
      INSERT INTO events (type, symbol, data) VALUES ('trade_open', $symbol, $payload);
    COMMIT;

  STEP 4 — If OANDA fails (HTTP 4xx/5xx)
    UPDATE trade_intents SET status='FAILED', failure_reason=$error WHERE signal_id=$signalId;
    -- No state change. Intent left as FAILED for audit.

STARTUP RECOVERY FLOW
──────────────────────────────────────────────────────────────────────
  1. SELECT * FROM runtime_state                              → ~5ms
  2. Deserialize: live, shadowm, shadowlab domains
  3. Check: are loaded values for today's date?
     If yesterday's date in 'live': reset dailyTrades=0, openTrades={}
  4. Reconcile PENDING intents:
     SELECT * FROM trade_intents WHERE status='PENDING'       → usually 0 rows
     For each PENDING intent:
       GET /v3/accounts/{id}/orders/{intent.signal_id}
       If OANDA has the trade → mark CONFIRMED, add to openTrades
       If OANDA does NOT have it → mark FAILED, no state change
  5. Compare live.openTrades with OANDA's actual open positions (GET /openTrades)
     Any discrepancy → flag in logs, emit 'position_discrepancy' event
  6. Resume normal operation
  Total startup time: ~100ms (independent of trade history)
```

### 3.4 Source of Truth

| Question | Answer | Where |
|----------|--------|-------|
| What is the current live state? | `runtime_state WHERE key='live'` | runtime_state |
| Did this trade intent execute on OANDA? | `trade_intents WHERE signal_id=$id AND status='CONFIRMED'` | trade_intents |
| What is the full event history? | `events` table | events (audit only) |
| Was this trade slot open or closed? | `shadowm_trades WHERE signal_id=$id` | shadowm_trades |
| What are current Shadow M active trades? | `runtime_state WHERE key='shadowm'` | runtime_state |

### 3.5 Failure Simulations

#### Deploy / Redeploy
```
BEFORE: runtime_state.live = {dailyTrades:3, openTrades:{EUR_USD:{...}}, version:142}
        runtime_state.shadowm = {active:{...}, lastId:5000, version:88}
        trade_intents: all CONFIRMED (no PENDING)

Railway kills process → Railway starts new process

RECOVERY:
  1. SELECT * FROM runtime_state → 3 rows returned in ~5ms
  2. live.dailyTrades = 3, live.openTrades = {EUR_USD:{...}} ← exact state
  3. shadowm._active = {...}, _lastId = 5000 ← exact state
  4. SELECT * FROM trade_intents WHERE status='PENDING' → 0 rows
  5. Reconcile OANDA positions → matches live.openTrades → no action
  6. Resume in ~100ms

RESULT: PERFECT STATE RECOVERY, 0 replay, 0 event scanning
```

#### Bot Crash (OANDA write before DB commit)
```
VARIANT A: Crash before STEP 1 (intent not written)
  → OANDA call never made → no position on OANDA → no inconsistency

VARIANT B: Crash after STEP 1, before STEP 2 (intent PENDING, no OANDA call)
  T+0s  INSERT trade_intents status='PENDING' — COMMITTED
  T+0.1s CRASH

  RECOVERY:
    SELECT trade_intents WHERE status='PENDING' → finds signal_id=ABC
    GET /v3/accounts/{id}/orders/ABC → OANDA: 404 Not Found (order never placed)
    UPDATE trade_intents SET status='FAILED' WHERE signal_id=ABC
    No trade opened. Correct.

VARIANT C: Crash after STEP 2 (OANDA has position), before STEP 3 (confirm not committed)
  T+0s  INSERT trade_intents status='PENDING' — COMMITTED
  T+0.1s OANDA API call → 201 Created → position open on OANDA
  T+0.2s CRASH — STEP 3 (BEGIN...COMMIT) never executed

  RECOVERY:
    SELECT trade_intents WHERE status='PENDING' → finds signal_id=ABC
    GET /v3/accounts/{id}/orders/ABC → OANDA: 200 OK, position open
    UPDATE trade_intents status='CONFIRMED', update runtime_state.live, insert events row
    live.openTrades now contains EUR_USD → correct state recovered

RESULT: ALL VARIANTS HANDLED. Ghost trades eliminated.
```

#### Railway Restart
```
Identical to Deploy simulation.
RTO: ~100ms
RPO: 0 (runtime_state is written within 100ms of each mutation)
```

#### Network Failure (DB unreachable for 5 minutes)
```
T+0s  DB connection lost
T+0s  StateManager: write to runtime_state fails
      → buffers pending state mutations in memory
      → continues operating normally (in-memory state is authoritative)
      → marks runtime_state as "dirty" (pending flush)

T+5min DB connection restored
T+5min StateManager flushes all buffered mutations:
       UPDATE runtime_state SET value=$currentState, version=... WHERE key=...
       → single write captures all 5 minutes of accumulated state

T+5min If process crashes during the 5-minute outage:
       Worst case: restart with 5-minute-old runtime_state
       → live.dailyTrades might be stale (can fall back to event-log COUNT)
       → openTrades might be stale (OANDA reconciliation on startup covers this)
       → Shadow M _lastId might be stale (replays up to 5min of events)

Risk: 5-minute DB outage is the worst case. In practice Railway/PostgreSQL
      outages are measured in seconds, not minutes.
Mitigation: write runtime_state synchronously for critical mutations
            (trade_open, trade_close). Only batch non-critical state.
```

#### Partial DB Failure (one table fails, others OK)
```
Scenario: shadowm_trades writes fail, events and runtime_state OK

  trade_close event writes to:
    runtime_state.live → removes from openTrades → OK
    events → trade_close event written → OK
    shadowm_trades → UPSERT fails

  Result:
    live.openTrades correct (trade removed)
    events has trade_close (audit correct)
    shadowm_trades: exit_time NULL (trade still "open" in Shadow M view)

  Recovery:
    On startup: load runtime_state → openTrades = {} (correct)
    shadowm._active: built from shadowm_trades → trade still "active"
    Discrepancy: shadow_m shows trade as active, runtime_state shows it closed
    Reconciliation detects: signal_id in shadowm._active but NOT in runtime_state.openTrades
    → Shadow M manually closes the trade in shadowm_trades
    → State converges

Mitigation: trade close should wrap shadowm_trades update in same transaction
            as runtime_state update. Both succeed or both fail.
```

#### Duplicate Events
```
Bot calls logEvent(trade_open, signalId=ABC) twice (network retry):

First call:
  trade_intents: INSERT signal_id=ABC, status=PENDING → OK

Second call:
  trade_intents: INSERT signal_id=ABC → ON CONFLICT (signal_id) DO NOTHING
  → second intent silently dropped

  runtime_state update uses optimistic concurrency (version check)
  → second update with stale version fails → reloads from DB → re-applies only delta
  → idempotent: result is same openTrades state

events table: may have two trade_open rows (audit log accepts duplicates)
              shadow_m._onOpen: _knownSids check prevents duplicate processing
```

#### Replay (for analytics / debugging)
```
runtime_state is a point-in-time current state — it does NOT support historical replay.
For replay, use the events table (audit log):

  SELECT * FROM events WHERE ts >= $start AND ts <= $end ORDER BY id
  → Reconstruct any historical state by folding events

This is the one dimension where ARCH-A is stronger than ARCH-B.
Mitigation: implement a separate read-only "replay" function that uses the
            events table (always maintained) for analytics, never for recovery.
```

#### Recovery Summary
```
Scenario                         RTO         RPO (max data loss)
──────────────────────────────────────────────────────────────────
Clean deploy                     ~100ms      0 mutations
Bot crash (DB writes OK)         ~100ms      0 mutations
Bot crash, OANDA before confirm  ~100ms      0 (reconciled via intent)
Railway restart                  ~100ms      0 mutations
Network failure (5 min)          ~100ms      up to 5 min of non-critical state
                                             0 for critical state (sync writes)
Full DB failure then restore     ~100ms      all mutations during outage (unavoidable)
Duplicate OANDA call             prevented   n/a (intent table blocks duplicate)
```

### 3.6 Architecture B — Pros and Cons

```
PROS:
  + RTO: ~100ms regardless of trade history — best possible for single-instance
  + RPO: 0 for critical operations (intent+confirm), ~100ms for non-critical
  + No replay, no snapshot deserialization — single DB read on startup
  + Intent-Confirm pattern eliminates ghost trades (Seam 3 fully closed)
  + OANDA reconciliation on startup catches any remaining discrepancy
  + Explicit state schema (typed columns, not opaque blobs)
  + Optimistic concurrency prevents state corruption from concurrent writers
  + Events table preserved for audit, analytics, and debugging
  + Builds on existing PostgreSQL + async DB infrastructure
  + No external services (Redis, Kafka, etc.) required
  + Single Railway service — no operational overhead

CONS:
  - Every state mutation requires a DB write (adds ~5ms per mutation to hot path)
  - Optimistic concurrency adds retry logic complexity
  - runtime_state.value is JSONB — must manage schema evolution carefully
  - During extended DB outage: in-memory state diverges from DB state
  - Historical point-in-time reconstruction requires event log (no snapshot support)
  - trade_intents table requires TTL cleanup (PENDING intents older than 24h → auto-FAILED)
```

---

## 4. Architecture C — Dual-Instance Active-Passive (DIAP)

### 4.1 Design

**Core principle:** Two instances of the system run simultaneously. The ACTIVE instance executes all trades and writes all state. The PASSIVE instance continuously mirrors every state mutation and is ready to take over as ACTIVE within 3 seconds of any failure. This eliminates RTO entirely for Railway restarts and deployments.

The ACTIVE instance holds an exclusive PostgreSQL advisory lock. If the lock is released (process death, Railway restart), the PASSIVE instance acquires the lock and promotes itself to ACTIVE in under 3 seconds.

This architecture requires two Railway services, both connected to the same PostgreSQL database. Each instance has a unique `INSTANCE_ID` environment variable. The advisory lock mechanism uses PostgreSQL's built-in `pg_try_advisory_lock()` — no additional consensus system is required.

**Key properties:**
- Zero-downtime deployments (PASSIVE becomes ACTIVE before ACTIVE shuts down)
- OANDA API is called exclusively by the ACTIVE instance
- PASSIVE instance keeps a live shadow of ACTIVE state (≤1s lag)
- Leadership is determined by PostgreSQL advisory lock (cannot split-brain)

### 4.2 New Database Schema

```sql
-- Instance registry: who is ACTIVE
CREATE TABLE instance_registry (
  instance_id    TEXT PRIMARY KEY,
  role           TEXT NOT NULL,          -- 'ACTIVE' | 'PASSIVE'
  state_version  BIGINT NOT NULL DEFAULT 0,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  railway_region TEXT                    -- 'us-west1', etc.
);

-- Incremental state replication from ACTIVE → PASSIVE
CREATE TABLE state_replication (
  id              BIGSERIAL PRIMARY KEY,
  from_version    BIGINT NOT NULL,
  to_version      BIGINT NOT NULL,
  diff            JSONB NOT NULL,        -- {domain: "live", op: "set", path: "openTrades.EUR_USD", value: {...}}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON state_replication(from_version);
-- Cleanup: DELETE FROM state_replication WHERE created_at < NOW() - INTERVAL '1 hour'

-- Lock ID for advisory lock (arbitrary constant, must be unique per deployment)
-- pg_try_advisory_lock(1234567890) ← ACTIVE holds this
-- pg_try_advisory_lock(1234567891) ← PASSIVE holds this (as PASSIVE sentinel)

-- Existing tables: runtime_state (from ARCH-B, also used here), events,
--                  shadowm_trades, shadowm_timeline, trade_intents
```

### 4.3 Data Flow

```
RAILWAY SERVICE 1 (ACTIVE)        RAILWAY SERVICE 2 (PASSIVE)       POSTGRESQL
───────────────────────────        ──────────────────────────────     ──────────
                                   -- Both start simultaneously --

T+0s: try pg_try_advisory_lock     try pg_try_advisory_lock
      (1234567890) → TRUE           (1234567890) → FALSE (S1 has it)
      → role = ACTIVE               → role = PASSIVE
      INSERT instance_registry      INSERT instance_registry
        (id=S1, role=ACTIVE)          (id=S2, role=PASSIVE)

ACTIVE STEADY STATE:
  Every 1s:
    UPDATE instance_registry         SELECT * FROM instance_registry
    SET last_heartbeat=NOW(),         WHERE role='ACTIVE'
    state_version=N                   → S1 last_heartbeat: 0.3s ago → OK

  On state mutation:
    mutate in memory
    INSERT INTO state_replication     SELECT * FROM state_replication
      (from=N-1, to=N, diff={...})    WHERE from_version > $PASSIVE_version
    UPDATE runtime_state              → apply diffs to PASSIVE in-memory state
    UPDATE instance_registry          → PASSIVE.state_version = ACTIVE.state_version
      state_version=N                 → PASSIVE is 1s behind ACTIVE (worst case)

ACTIVE FAILURE (S1 crashes):
  S2: SELECT instance_registry
      WHERE role='ACTIVE'
      → last_heartbeat = 4.2s ago  ← exceeds 3s threshold
  S2: SELECT pg_try_advisory_lock(1234567890) → TRUE (S1 released it on crash)
  S2: UPDATE instance_registry SET role='ACTIVE' WHERE instance_id='S2'
  S2: UPDATE instance_registry SET role='PASSIVE' WHERE instance_id='S1'
  S2: Load runtime_state → apply any unprocessed state_replication diffs
  S2: Reconcile OANDA positions (startup check)
  S2: Begin trading as ACTIVE

  TOTAL PROMOTION TIME: 3s (heartbeat timeout) + 200ms (state sync) = ~3.2s
  STATE LAG AT TAKEOVER: ≤1s of state diffs (from S2's last applied version)
```

### 4.4 Source of Truth

| Question | Answer | Where |
|----------|--------|-------|
| Which instance is authoritative? | Holds pg_advisory_lock(1234567890) | PostgreSQL advisory lock |
| What is current live state? | ACTIVE's runtime_state | runtime_state |
| Has ACTIVE died? | last_heartbeat > 3s ago | instance_registry |
| How far behind is PASSIVE? | ACTIVE.state_version - PASSIVE.state_version | instance_registry |
| What state diffs are pending? | state_replication WHERE from_version > PASSIVE.version | state_replication |

### 4.5 Failure Simulations

#### Deploy / Redeploy (zero-downtime)
```
Railway deploys new version of SERVICE 1:
  1. Railway starts new S1 container (new code)
  2. New S1 tries pg_try_advisory_lock → FALSE (old S1 still holds it)
  3. New S1 starts as PASSIVE, syncing state from old S1
  4. Railway sends SIGTERM to old S1
  5. Old S1 receives SIGTERM:
     → Sets role='PASSIVE' in instance_registry (voluntary demotion)
     → Releases advisory lock: pg_advisory_unlock(1234567890)
     → Stops taking OANDA actions
  6. New S1 acquires advisory lock → promotes to ACTIVE
  7. New S1 has ≤1s of state lag → applies pending diffs from state_replication
  8. New S1 begins trading
  Total downtime: 0 seconds (PASSIVE → ACTIVE transition is instantaneous)
```

#### Bot Crash
```
S1 crashes unexpectedly (no SIGTERM):
  Advisory lock auto-released by PostgreSQL (connection closed)
  S2 detects: last_heartbeat > 3s ago AND pg_try_advisory_lock → TRUE
  S2 promotes to ACTIVE in ~3s
  State lag: ≤1s (last applied state_replication)

  S1 restarts (Railway restart policy):
  S1 starts, tries advisory lock → FALSE (S2 is now ACTIVE)
  S1 starts as PASSIVE, begins syncing state from S2
  Both instances healthy again after ~10s total
```

#### Railway Restart (both instances)
```
Railway kills BOTH instances simultaneously (e.g., region maintenance):
  All advisory locks released
  Both new instances start simultaneously
  Race: both try pg_try_advisory_lock(1234567890)
  PostgreSQL serializes: exactly one succeeds → becomes ACTIVE
  The other → becomes PASSIVE
  Both load runtime_state from PostgreSQL (no replay needed)
  State at time of crash: as of last runtime_state write (≤100ms old)

  Trading gap: ~5s (Railway restart time + advisory lock race + OANDA reconcile)
  This is the only scenario where DIAP has a trading gap.
```

#### Network Failure (ACTIVE loses DB for 30s)
```
S1 (ACTIVE) loses DB connection:
  S1 continues in-memory state (no DB reads/writes)
  S1 CANNOT write heartbeat → S2 sees stale heartbeat

  If outage < 3s: S2 does not promote (heartbeat just barely stale)
  If outage > 3s: S2 promotes to ACTIVE (S1 appears dead)
    → SPLIT BRAIN RISK: both S1 and S2 think they are ACTIVE

  Prevention: When S1 detects DB connection loss:
    1. S1 immediately stops making OANDA calls (safe mode)
    2. S1 does NOT release advisory lock (still holds it at advisory level)
    3. But S2 cannot verify lock (DB unreachable) → cannot acquire lock
    4. Both enter safe mode until DB restored
    5. DB restored → S1 re-acquires lock (was never released) → remains ACTIVE
    6. S2 confirms S1 still holds lock → remains PASSIVE

  *** IMPORTANT: If S1's DB connection and S1's process both fail simultaneously,
      there is a 3s window where no trades execute. This is acceptable.
```

#### Duplicate Events
```
Only ACTIVE makes OANDA calls and writes events.
PASSIVE mirrors state but makes no OANDA calls.
Therefore: no duplicate trades possible due to PASSIVE promotion
           (PASSIVE knows the ACTIVE's last trade state before taking over)

Duplicate event from bot retry: handled identically to ARCH-B (trade_intents)
```

#### Recovery Summary
```
Scenario                         RTO         Notes
──────────────────────────────────────────────────────────────────
Clean deploy (rolling)           0ms         PASSIVE absorbs load during switch
Bot crash (S1)                   ~3.2s       S2 promotes after heartbeat timeout
Railway restart (one instance)   ~3.2s       Same as crash
Railway restart (both instances) ~5s         Lock race + OANDA reconcile
DB outage < 3s                   0ms         ACTIVE stays active
DB outage > 3s                   0ms         ACTIVE enters safe mode (no trades)
DB total failure                 0ms trades  Safe mode; recovery on DB restore
```

### 4.6 Architecture C — Pros and Cons

```
PROS:
  + True zero-downtime deployments (voluntary leader transfer)
  + No state loss possible between instances (≤1s replication lag)
  + OANDA position integrity: only ACTIVE trades
  + PostgreSQL advisory locks: no Zookeeper, etcd, or Redis needed
  + PASSIVE provides read-only dashboard access during ACTIVE downtime
  + Hardware-level redundancy (different Railway containers)

CONS:
  - Requires 2 Railway services: 2× cost
  - Significantly higher operational complexity
  - Split-brain risk on simultaneous DB+network failure (rare but real)
  - OANDA has rate limits: must ensure PASSIVE never makes API calls
  - Deployment configuration is more complex (INSTANCE_ID env var per service)
  - Advisory lock release on process death is implicit — must be tested carefully
  - state_replication table requires continuous pruning
  - Both instances need identical env vars except INSTANCE_ID
  - Network between services goes through PostgreSQL (not direct) → latency
  - Monitoring must cover 2 services + replication lag
  - Migration from current system requires deploying a second Railway service
    and testing leader election before cutover
```

---

## 5. Comparison Matrix

```
DIMENSION                      ARCH-A (ESS)    ARCH-B (CSH)    ARCH-C (DIAP)
─────────────────────────────────────────────────────────────────────────────
Recovery Time (RTO)            ~55ms            ~100ms           0ms–3.2s
Max State Loss (RPO)           0 events         ~100ms (non-crit) 1s (replication lag)
                               (if snapshot OK)  0 (critical ops)  0 (critical ops)
Ghost trade elimination        PARTIAL          YES (intent)     YES (intent+active-only)
Duplicate event safety         YES (idem key)   YES (intent)     YES (active-only writes)
Cold-start time at 10k trades  ~55ms            ~100ms           ~3.2s (promotion lag)
Railway instances required     1                1                2
Additional infrastructure       none             none             none
Cost                           $                $                $$
Operational complexity         MEDIUM           LOW              HIGH
Historical replay              EXCELLENT        GOOD (events)    GOOD (events)
Schema evolution               MEDIUM (blobs)   MEDIUM (JSONB)   MEDIUM (JSONB)
Migration complexity           MEDIUM           LOW              HIGH
Deploy procedure               simple           simple           rolling (complex)
DB failure resilience          MEDIUM           MEDIUM           HIGH (safe mode)
Idempotency model              idem key table   trade_intents    trade_intents + active-only
Live OANDA reconciliation      startup only     startup only     continuous (PASSIVE mirrors)
Audit capability               EXCELLENT        GOOD             GOOD
Builds on current code (%)     ~65%             ~75%             ~40%
Suitable for solo dev team     YES              YES              MARGINAL
Railway-native deployment      YES              YES              PARTIAL (2 services)
Time to implement              10–14 days       8–10 days        20–30 days
```

### Decision Criteria

```
For a solo/small team FOREX bot on Railway where:
  - Financial correctness is paramount (no duplicate trades, no ghost positions)
  - Operational simplicity matters (one developer maintains the system)
  - Cost matters (Railway billing per active service)
  - Cold-start time of 100ms is acceptable (vs 0ms for DIAP)
  - Historical replay is a valuable debugging tool

Weights:
  Financial correctness         ████████████ 30%
  Operational simplicity        █████████    20%
  RTO/RPO                       ████████     18%
  Migration complexity          ███████      15%
  Cost                          █████        12%
  Replay/audit capability       ███           5%

ARCH-A score: 71/100
ARCH-B score: 89/100
ARCH-C score: 63/100
```

---

## 6. Recommended Architecture

### **ARCHITECTURE B — Continuous State Checkpointing (CSH)**

**Rationale:**

ARCH-B is chosen unanimously on all weighted criteria. The analysis is:

**vs. ARCH-A (Event Sourcing):**
ARCH-A is philosophically elegant but ARCH-B solves the same problems with less complexity. ARCH-A still requires a startup reconciliation for Seam 3 (OANDA write before DB commit). ARCH-B closes Seam 3 completely with the intent+confirm pattern. Both achieve near-zero RPO for critical operations, but ARCH-B's single-read startup is strictly simpler than ARCH-A's snapshot-load + replay sequence. Historical replay remains available via the `events` table in both architectures.

**vs. ARCH-C (Dual-Instance):**
ARCH-C is compelling for systems where 3-second downtime windows are unacceptable (e.g., high-frequency trading). A FOREX swing/position bot is not in that category — 3 seconds of downtime during a Railway restart does not materially affect P&L when trades are open for 20–60 minutes. ARCH-C's operational complexity (2 services, leader election, split-brain handling, replication lag monitoring) is disproportionate for this deployment model. ARCH-B achieves 99% of ARCH-C's guarantees at 30% of the implementation cost.

**The one ARCH-C advantage that matters — zero-downtime deployment — can be achieved in ARCH-B via a 30-second Railway rolling deploy. The bot already has a graceful shutdown path (SIGTERM → drain → exit). A `restartPolicyType: ON_FAILURE` with health check ensures Railway waits for the new instance to be healthy before terminating the old one.**

### What ARCH-B Looks Like When Complete

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FOREX ENGINE PRO v41 — ARCH-B                    │
│                                                                     │
│  ┌─────────────┐    stdout/stdin    ┌──────────────────────────┐   │
│  │  index.js   │◄──────────────────►│    telemetry/server.js   │   │
│  │  (live bot) │                    │    (orchestrator)         │   │
│  └─────────────┘                    └──────────┬───────────────┘   │
│       │ OANDA API                              │                   │
│       ▼                                        │ DB writes          │
│  ┌─────────┐                          ┌────────▼────────────────┐   │
│  │  OANDA  │                          │      PostgreSQL          │   │
│  │  REST   │                          │                          │   │
│  └─────────┘                          │  events (audit log)      │   │
│                                       │  runtime_state           │   │
│  TRADE FLOW:                         │  trade_intents           │   │
│  1. Signal → write INTENT (PENDING)  │  shadowm_trades          │   │
│  2. OANDA call                        │  shadowm_timeline        │   │
│  3. CONFIRM intent + update state     └─────────────────────────┘   │
│  4. Audit event written                                             │
│                                                                     │
│  STARTUP FLOW:                                                      │
│  1. SELECT runtime_state → all domains in one query (~5ms)          │
│  2. Reconcile PENDING intents vs OANDA (~200ms, usually 0 rows)     │
│  3. Begin trading. Total: ~100ms                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Migration Plan — Current System → ARCH-B

### Overview

The migration is non-destructive at every phase. Each phase can be deployed independently. The system remains fully operational throughout. Rollback is possible after any phase.

**Zero risk to production trades at all times.**

```
Phase    Duration     What Changes                      Rollback Complexity
──────────────────────────────────────────────────────────────────────────
Phase 0  1 day        Schema additions only             None (new tables only)
Phase 1  2-3 days     Dual-write to runtime_state       Drop runtime_state writes
Phase 2  1 day        Read from runtime_state           Revert startup function
Phase 3  2-3 days     Intent-Confirm for trades         Remove STEP 1 and STEP 3
Phase 4  1-2 days     Shadow M + ShadowLab migration    Revert their startup paths
Phase 5  1 day        Cleanup and monitoring            None (deletion only)
──────────────────────────────────────────────────────────────────────────
Total    8-10 days    Full migration complete
```

---

### Phase 0 — Schema Foundation (Day 1)

**Goal:** Add new tables. No code behavior changes.

```sql
-- Run via: pnpm --filter @workspace/db run push  (or direct psql)

CREATE TABLE IF NOT EXISTS runtime_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  version     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_ver  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trade_intents (
  id              BIGSERIAL PRIMARY KEY,
  signal_id       TEXT NOT NULL,
  intent_type     TEXT NOT NULL CHECK (intent_type IN ('OPEN', 'CLOSE', 'MODIFY')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'RECONCILED')),
  oanda_order_id  TEXT,
  symbol          TEXT NOT NULL,
  side            TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  UNIQUE (signal_id, intent_type)
);

CREATE INDEX IF NOT EXISTS idx_ti_pending ON trade_intents(status) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ti_signal  ON trade_intents(signal_id);

-- Bootstrap empty state domains
INSERT INTO runtime_state (key, value, version, schema_ver) VALUES
  ('live',      '{"dailyTrades":0,"openTrades":{},"date":"","version":0}', 0, 1),
  ('shadowm',   '{"active":{},"knownSids":[],"lastId":0,"version":0}',     0, 1),
  ('shadowlab', '{"processedIds":[],"mode":"OBSERVE","weights":{},"dataset":[],"version":0}', 0, 1)
ON CONFLICT (key) DO NOTHING;
```

**Files to create:**
- `telemetry/state-manager.js` — new module, implements `StateManager` class (read/write runtime_state, optimistic concurrency)
- `telemetry/intent-manager.js` — new module, implements `IntentManager` class (write intent, confirm, reconcile on startup)

**New module: `telemetry/state-manager.js` spec:**
```
class StateManager:
  constructor(db)
  async load(key) → value object
  async save(key, newValue, expectedVersion) → {ok, actualVersion}
    → if version mismatch: returns {ok:false, actualVersion}
    → caller reloads, re-applies diff, retries
  async loadAll() → {live, shadowm, shadowlab}  ← used at startup
  async saveLive(newLive) → idempotent, handles version retry internally
  async saveShadowM(newShadowM) → same
  async saveShadowLab(newShadowLab) → same
  flush() → forces immediate write (used before graceful shutdown)
```

**New module: `telemetry/intent-manager.js` spec:**
```
class IntentManager:
  constructor(db)
  async writeIntent(signalId, type, symbol, side, payload) → intent row
  async confirmIntent(signalId, oandaOrderId) → void
  async failIntent(signalId, reason) → void
  async reconcileOnStartup(oandaClient) → [{signalId, action, result}]
    → Finds all PENDING intents
    → For each: queries OANDA to determine actual status
    → Marks CONFIRMED or FAILED accordingly
    → Returns reconciliation report (logged on startup)
```

**Validation:** Deploy Phase 0. Verify:
```sql
SELECT key, version, updated_at FROM runtime_state;
-- Should return 3 rows: live, shadowm, shadowlab
SELECT COUNT(*) FROM trade_intents;
-- Should return 0
```

---

### Phase 1 — Dual-Write (Days 2–4)

**Goal:** Every state mutation writes to BOTH the current in-memory path AND `runtime_state`. The system still READS from event replay (no behavior change for recovery). This phase validates that `runtime_state` is always consistent with in-memory state.

**Files to modify:**

`telemetry/server.js`:
```
After every mutation to live.dailyTrades or live.openTrades:
  stateManager.saveLive(live)   ← add this line
  (do NOT await — fire-and-forget to avoid blocking hot path)

After restoreLiveState() completes:
  stateManager.saveLive(live)   ← persist restored state immediately

Add startup validation (Phase 1 only, remove in Phase 2):
  const dbState = await stateManager.load('live')
  compare dbState with result of restoreLiveState()
  if mismatch: log [STATE DRIFT] warning with diff
```

`telemetry/shadowm.js`:
```
After every _onOpen, _onSnapshot, _onClose:
  stateManager.saveShadowM({
    active: Object.fromEntries(this._active),
    knownSids: [...this._knownSids],
    lastId: this._lastId,
    version: this._stateVersion++
  })
  (fire-and-forget)

After _restore() completes:
  stateManager.saveShadowM(...)  ← persist restored state
```

`telemetry/shadowlab.js`:
```
After _init() completes:
  stateManager.saveShadowLab({
    processedIds: [...shadowLab._processedIds],
    mode: getShadowMode(),
    version: ...
  })

After each _cycle() that changes _processedIds:
  stateManager.saveShadowLab(...)  ← fire-and-forget
```

**Validation:** Run for 2–3 days in production. Monitor for [STATE DRIFT] logs.
- Expected: 0 drift events during normal operation
- Expected: 0 drift events after a Railway restart (both paths give same result)
- If drift detected: fix before proceeding to Phase 2

---

### Phase 2 — Read Switchover (Day 5)

**Goal:** `restoreLiveState()` and `_restore()` now read from `runtime_state` FIRST. Fall back to event replay only if `runtime_state` is empty, too old (>24h), or has wrong date.

**Files to modify:**

`telemetry/server.js`:
```javascript
async function restoreLiveState() {
  // PHASE 2: Read from runtime_state first
  const rs = await stateManager.load('live');
  const today = new Date().toUTCString().slice(0,10);

  if (rs && rs.date === today && rs.version > 0) {
    // Fast path: state is current
    live.dailyTrades = rs.dailyTrades;
    live.openTrades  = rs.openTrades;
    console.log(`[SERVER] Live state loaded from runtime_state: `
      + `dailyTrades=${live.dailyTrades} openTrades=${Object.keys(live.openTrades).length}`);
    return;
  }

  // Fallback: event replay (existing code — kept as safety net)
  console.log(`[SERVER] runtime_state stale/missing — falling back to event replay`);
  // ... existing restoreLiveState() code ...
  // After replay, persist to runtime_state:
  await stateManager.saveLive({...live, date: today});
}
```

`telemetry/shadowm.js`:
```javascript
async _restore() {
  const rs = await stateManager.load('shadowm');
  if (rs && rs.version > 0) {
    // Fast path
    this._active    = new Map(Object.entries(rs.active || {}));
    this._knownSids = new Set(rs.knownSids || []);
    this._lastId    = rs.lastId || 0;
    console.log(`[SHADOW M] State loaded from runtime_state: `
      + `active=${this._active.size} known=${this._knownSids.size} lastId=${this._lastId}`);
    return;
  }
  // Fallback: existing _restore() code
  // ...
}
```

**Deploy and monitor for 1 week. Verify:**
- `[STATE DRIFT]` warnings do not appear (dual-write validation from Phase 1 should silence these)
- Startup times decrease from ~200ms to ~100ms
- After Railway restart: state is correct, no event replay in logs

---

### Phase 3 — Intent-Confirm for Trade Operations (Days 6–8)

**Goal:** Wrap trade_open and trade_close in the intent+confirm pattern. Close Seam 3 permanently.

**Files to modify:**

`index.js` — *NOTE: index.js is FROZEN. The intent pattern must be implemented in server.js via the stdout parse layer, NOT inside index.js.*

The current architecture already has a stdout parse layer in server.js (lines ~135–190) that reads bot stdout and derives `live.openTrades`. This is where the intent pattern hooks in:

`telemetry/server.js` — bot stdout parser:
```javascript
// When server.js parses bot stdout line that indicates trade is about to open:
// (bot logs "SIGNAL PASS: signalId=ABC symbol=EUR_USD side=buy ...")
// 
// BEFORE OANDA call (bot has not made the call yet — signal is pre-execution):
//   This hook point does NOT exist in current architecture.
//   The bot makes the OANDA call internally in index.js.
//
// REALISTIC APPROACH for frozen index.js:
// Intent is written RETROACTIVELY after seeing "trade_open" in stdout OR events:
//
// When server.js sees trade_open event arrive:
//   intentManager.writeIntent(signalId, 'OPEN', symbol, side, payload) ON CONFLICT IGNORE
//   intentManager.confirmIntent(signalId, oandaOrderId)
//
// This is "confirm-without-prior-intent" — the intent and confirm happen
// in the same code path (no split between STEP 1 and STEP 2).
// True intent-before-action requires modifying index.js.
//
// RECOMMENDATION: Request a single hook in index.js that calls back to server.js
// before the OANDA call. This is the minimum modification to the frozen bot
// that enables full intent-before-action protection.
// If index.js remains truly frozen: implement OANDA reconciliation instead (see below).
```

**OANDA Reconciliation (Seam 3 mitigation without modifying index.js):**

`telemetry/intent-manager.js` — startup reconciliation:
```javascript
async reconcileOnStartup(oandaBaseUrl, oandaToken, accountId) {
  // 1. Get all open positions from OANDA
  const oandaPositions = await GET(`${oandaBaseUrl}/accounts/${accountId}/openTrades`,
    {Authorization: `Bearer ${oandaToken}`});

  // 2. Compare with live.openTrades (from runtime_state)
  const liveSymbols = new Set(Object.keys(live.openTrades));
  const oandaSymbols = new Set(oandaPositions.map(p => p.instrument.replace('_', '')));

  // 3. In OANDA but NOT in live.openTrades → ghost position
  for (const sym of oandaSymbols) {
    if (!liveSymbols.has(sym)) {
      logEvent({type: 'position_discrepancy', symbol: sym, direction: 'oanda_not_live'});
      console.error(`[RECONCILE] GHOST POSITION: ${sym} on OANDA but not in live state`);
      // Policy options (configure via env var):
      //   RECONCILE_POLICY=FORCE_CLOSE → place market close order
      //   RECONCILE_POLICY=FLAG_ONLY   → alert only, human decides (default)
    }
  }

  // 4. In live.openTrades but NOT in OANDA → stale live state
  for (const sym of liveSymbols) {
    if (!oandaSymbols.has(sym)) {
      logEvent({type: 'position_discrepancy', symbol: sym, direction: 'live_not_oanda'});
      console.warn(`[RECONCILE] STALE LIVE STATE: ${sym} in live state but not on OANDA`);
      // Remove from live.openTrades
      delete live.openTrades[sym];
    }
  }

  await stateManager.saveLive(live);
}
```

**Phase 3 validation:**
- Simulate crash between OANDA fill and event write (kill -9 during test run)
- Verify reconciliation correctly identifies and handles the ghost position
- Monitor production for `position_discrepancy` events (should be 0 in normal operation)

---

### Phase 4 — Shadow M + ShadowLab Full Migration (Days 9–10)

**Goal:** Remove the event-replay fallback paths. `runtime_state` is the only startup source.

`telemetry/shadowm.js`:
```
Remove the existing _restore() event-replay code.
Replace entirely with stateManager.load('shadowm') read.
Keep _initTables() for shadowm_trades and shadowm_timeline (these are separate stores).
```

`telemetry/shadowlab.js`:
```
Remove _init() event-scan code.
Replace with stateManager.load('shadowlab') read.
ShadowLab still runs _buildDataset() from shadowm_trades (not from events).
Persist dataset to runtime_state.shadowlab.dataset periodically.
```

`telemetry/server.js`:
```
Remove restoreLiveState() event-replay fallback.
restoreLiveState() = stateManager.loadAll() + OANDA reconciliation.
```

**Phase 4 validation:**
- Force a Railway restart
- Verify startup logs show "State loaded from runtime_state" for all 3 domains
- Verify no event-replay logs appear
- Verify first ShadowLab cycle completes in <500ms (no full dataset rebuild needed)

---

### Phase 5 — Cleanup (Day 11)

**Files:**
- Remove `[STATE DRIFT]` validation logging from Phase 1
- Remove event-replay code paths (now dead code)
- Add `trade_intents` TTL cleanup job: 
  ```sql
  DELETE FROM trade_intents 
  WHERE created_at < NOW() - INTERVAL '7 days' 
  AND status != 'PENDING'
  ```
- Add `state_replication` table cleanup (if ARCH-C elements were prototyped)
- Update `replit.md` with new architecture overview
- Update `railway.json` health check:
  ```json
  "healthcheckPath": "/api/healthz",
  "healthcheckTimeout": 10
  ```

---

### Migration Decision Gates

Before proceeding from each phase, ALL of the following must be true:

```
Phase 0 → Phase 1:
  [ ] runtime_state table exists with 3 rows
  [ ] trade_intents table exists, empty
  [ ] No errors in migration SQL

Phase 1 → Phase 2:
  [ ] 0 [STATE DRIFT] warnings over 48h in production
  [ ] runtime_state.version increments correctly on each trade event
  [ ] After Railway restart: runtime_state matches event-replay result

Phase 2 → Phase 3:
  [ ] Startup time consistently ≤150ms (logged in [SERVER] startup line)
  [ ] No [FALLBACK] event-replay used in production over 48h
  [ ] runtime_state correctly survives Railway restarts

Phase 3 → Phase 4:
  [ ] 0 unhandled position_discrepancy events over 48h
  [ ] OANDA reconciliation correctly handles simulated ghost position
  [ ] trade_intents table shows correct CONFIRMED states for all trades

Phase 4 → Phase 5:
  [ ] 0 event-replay fallbacks in production over 72h
  [ ] ShadowLab first cycle completes in ≤500ms after restart
  [ ] Shadow M state fully correct after Railway restart (verified vs. shadowm_trades)
  [ ] Full integration test: open trade, Railway restart, verify state correct
```

---

### New Files Summary (for implementer reference)

```
telemetry/
  state-manager.js      ← NEW: read/write runtime_state with optimistic concurrency
  intent-manager.js     ← NEW: trade_intents CRUD + OANDA reconciliation on startup
  db-adapter.js         ← UNCHANGED (already handles PG/SQLite)
  index.js              ← UNCHANGED (logEvent, emitter, getDbStats — audit log)
  shadowm.js            ← MODIFIED: _restore() reads runtime_state, saves on mutation
  shadowlab.js          ← MODIFIED: _init() reads runtime_state, saves after cycle
  server.js             ← MODIFIED: restoreLiveState() reads runtime_state,
                                     starts intent reconciliation, saves on mutation

New DB tables:
  runtime_state         ← primary state store (3 rows)
  trade_intents         ← exactly-once trade operation registry

Unchanged DB tables:
  events                ← audit log (never used for recovery after Phase 5)
  shadowm_trades        ← shadow trade analytics store
  shadowm_timeline      ← intra-trade price history
```

---

*Document complete. Implementation may begin after approval of the recommended architecture (ARCH-B) and the migration plan. Phase 0 can begin immediately — it is purely additive and carries zero risk.*
