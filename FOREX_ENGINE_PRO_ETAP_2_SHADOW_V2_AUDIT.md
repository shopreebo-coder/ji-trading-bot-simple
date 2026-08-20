# FOREX ENGINE PRO — ETAP 2 Shadow V2 Audit

**Audit type:** Read-only  
**Scope:** Shadow A v2, Shadow B v2, Shadow C v2, plus preliminary Shadow M findings  
**Audit date:** 2026-08-20  
**Runtime observed:** Telemetry Dashboard workflow, PostgreSQL-backed telemetry  
**Change policy:** No code, Live Bot logic, commit, deployment, or configuration was changed.

## Executive summary

Shadow A, B, and C are implemented and reachable from the Live Bot's signal path. A and B are deterministic, stateless evaluators over the signal's current market/condition payload. C is intentionally historical: it constructs a KNN dataset from stored `trade_open` and `trade_close` telemetry and uses that memory when evaluating a current signal.

The current runtime is not producing current Shadow A/B/C evaluations because OANDA candle requests return HTTP 401 and the strategy exits before complete M5+M1 evidence reaches `shadowGate()`. `signal_detected` events continue to be produced, but this is not equivalent to a valid current Shadow A/B/C observation.

The largest provenance risk is that the stored event stream does not visibly distinguish live, test, synthetic, or reconstructed events. ShadowLab's backfill path can process stored `trade_open` records, and Shadow C's historical dataset can therefore inherit any contamination already present in telemetry.

## Runtime evidence snapshot

Observed during the audit:

- Current time observed: approximately `2026-08-20T18:59Z`.
- OANDA candle requests for EUR_USD, GBP_USD, USD_JPY, and XAU_USD returned HTTP 401:
  `Insufficient authorization to perform request.`
- `signal_detected`: 24,794 records; latest observed at `2026-08-20T18:59:29Z`.
- `trade_open`: 3 records, latest `2026-07-31T09:38:54Z`.
- `trade_close`: 3 records, latest `2026-07-31T09:39:19Z`.
- `lab_shadow_a`, `lab_shadow_b`, `lab_shadow_c`: 3 records each, latest approximately `2026-07-31T09:38:59Z`.
- `shadow_a_advisory_generated`, `shadow_b_advisory_generated`, `shadow_c_advisory_generated`: 212 each, latest `2026-08-18T20:14:40Z`.
- Current runtime logs show `ENGINE_C Dataset cached: 3 historical pair(s)`.
- Current runtime shows no new `shadow_gate_eval` after the last valid Shadow lifecycle; the current signal loop is failing at market-data acquisition before the Shadow gate.

---

# Shadow A v2 — ENTRY QUALITY

## 1. CONFIRMED

Shadow A v2 is implemented as `ENGINE_A_QUALITY`. It computes an entry-quality score from the supplied condition map and current market-quality fields. It is advisory/read-only and does not place, modify, or close trades.

The evaluator requires complete market evidence and all configured boolean condition fields. Missing or malformed evidence produces an explicit abstention with `wouldTrade: null`.

## 2. NOT CONFIRMED

It is not confirmed that Shadow A observes only current live events.

The direct evaluator is stateless, but the ShadowLab orchestrator scans persisted `trade_open` rows and can run A against stored events that were produced earlier. The event schema does not provide a reliable live/test provenance field that A can independently enforce.

## 3. EVIDENCE

Shadow A uses:

- nine boolean entry conditions:
  `trend`, `m5close`, `candle`, `ema`, `strength`, `m1trend`, `m1candle`, `m1prev`, `m1close`
- `passCount`
- `entryGate`
- `spread`
- `atrPips`
- `emaDistance`
- `candleStrength`

The score is condition-weighted, adjusted by market quality, clamped to 0–100, and classified as:

- `TRADE` when score is at least 65
- confidence `HIGH` at least 80
- confidence `MEDIUM` at least 65
- otherwise `LOW`

Current persisted A evaluations are historical/test-era records from June 30 and July 31. Current `signal_detected` records from August 20 do not have corresponding current A evaluations because the strategy cannot obtain valid OANDA candle data.

## 4. EXACT FILE/FUNCTION

- `telemetry/shadowlab.js`
  - `class ShadowQualityEngine`
  - `ShadowQualityEngine.evaluate(signal)`
- `telemetry/shadowlab.js`
  - `ShadowLab._processSignal()`
  - `ShadowLab._cycle()`
- `telemetry/shadowlab.js`
  - `shadowGate()`
- `index.js`
  - `strategy(symbol)`
  - condition maps are assembled before `shadowGate()`

## 5. DATA SOURCE

For the live path, A receives the payload assembled in `index.js` from current OANDA-derived M5/M1 candle data and current spread/indicator calculations.

For the persisted ShadowLab path, A receives parsed `trade_open.data` from the shared `events` table.

## 6. LIVE/HISTORICAL/TEST PROVENANCE

- **Live-capable:** yes, when valid current M5/M1 data reaches `shadowGate()`.
- **Historical-capable:** yes, through `ShadowLab._cycle()` scanning stored `trade_open` events.
- **Test contamination possible:** yes. Synthetic/test `trade_open` rows are structurally accepted unless provenance is enforced elsewhere.
- **Current runtime:** no valid current A observation was confirmed during this audit because OANDA returned 401 before the complete Shadow payload was formed.

## 7. RISK

Shadow A's scoring logic is not itself contaminated by internal memory, but its historical backfill path can make test or synthetic `trade_open` records look like live observations. This can inflate apparent Shadow coverage and make historical A results appear current.

The current system also has many `signal_detected` events without A evaluations, so a dashboard that treats signal detection as Shadow observation would overstate A runtime coverage.

## 8. RECOMMENDED NEXT ACTION

Do not change A during this audit. For a later fix review:

1. define and persist an explicit event provenance classification;
2. keep live evaluation metrics separate from stored backfill metrics;
3. report `UNKNOWN` or incomplete coverage when valid market data is unavailable;
4. add tests proving synthetic `trade_open` rows cannot enter a live-quality cohort without explicit classification.

---

# Shadow B v2 — REGIME

## 1. CONFIRMED

Shadow B v2 is implemented as `ENGINE_B_CONTEXT`. It classifies the supplied market conditions into:

- `TRENDING`
- `RANGING`
- `VOLATILE`
- `NOISE`
- `DEAD`

It recommends trading only in `TRENDING`. Missing market evidence produces `UNKNOWN` plus abstention.

## 2. NOT CONFIRMED

It is not confirmed that B currently observes live runtime conditions at the time of this audit.

The implementation is capable of consuming live conditions, but current OANDA failures prevent a complete current market payload from reaching the Shadow gate. Existing B outputs are historical/test-era evaluations.

## 3. EVIDENCE

B evaluates:

- `atrPips`
- `emaDistance`
- `candleStrength`
- `spread`
- `session`

The current stored `lab_shadow_b` rows have source timestamps from June 30 and July 31. They classify the observed historical/test samples as `RANGING`.

The current runtime continues to emit `signal_detected`, but the strategy reports OANDA 401 errors while fetching candles. No new `lab_shadow_b` output was observed for the current August 20 signal stream.

## 4. EXACT FILE/FUNCTION

- `telemetry/shadowlab.js`
  - `class ShadowContextEngine`
  - `ShadowContextEngine.evaluate(signal)`
- `telemetry/shadowlab.js`
  - `ShadowLab._processSignal()`
  - `ShadowLab._cycle()`
- `telemetry/shadowlab.js`
  - `shadowGate()`
- `index.js`
  - `strategy(symbol)`
  - M5/M1 indicator and regime inputs are calculated before `shadowGate()`

## 5. DATA SOURCE

Live-capable inputs originate from the Live Bot's current OANDA candle and spread calculations:

- ATR
- EMA distance
- candle strength
- current spread
- current session

The stored-processing path reads the same fields from `trade_open.data`.

## 6. LIVE/HISTORICAL/TEST PROVENANCE

- **Live-capable:** yes, when the current M5/M1 market payload is valid.
- **Historical-capable:** yes, because ShadowLab reprocesses stored `trade_open` events.
- **Test contamination possible:** yes, because stored events do not expose a mandatory live/test provenance gate for B.
- **Current runtime:** current valid B observations were not confirmed; latest persisted B outputs are historical/test-era.

## 7. RISK

B can provide a plausible regime label for stale or synthetic input because it is a pure deterministic classifier. Without provenance and freshness checks, a historical B result can be mistaken for a current regime observation.

The current OANDA 401 state also creates a coverage risk: current signal detection is active, but current regime evaluation is not.

## 8. RECOMMENDED NEXT ACTION

For a later fix review:

1. attach source timestamp and provenance to every B evaluation;
2. distinguish current signal evaluation from historical ShadowLab backfill;
3. expose a freshness/availability state separate from the regime label;
4. keep missing OANDA evidence as `UNKNOWN`, never as a synthetic regime.

---

# Shadow C v2 — CONFIRMATION / MEMORY

## 1. CONFIRMED

Shadow C v2 is implemented as `ENGINE_C_KNN`. It is intentionally memory-driven and uses a cached historical dataset of resolved trade pairs.

Its current runtime cache contains 3 historical pairs. This is confirmed by runtime logs:

`[ENGINE_C] Dataset cached: 3 historical pair(s)`

The evaluator abstains when there are no historical pairs or fewer than three qualifying neighbours.

## 2. NOT CONFIRMED

It is not confirmed that C's current memory contains only clean, live, production outcomes.

The current event store contains test-looking signal IDs such as `e2e-sim-*` and `e2e-fix-*`. C's dataset builder reads the same shared event stream and does not enforce a live/test provenance filter.

It is also not confirmed that current August 20 signals are being evaluated by C; OANDA 401 prevents the complete current signal payload from reaching `shadowGate()`.

## 3. EVIDENCE

C builds a 15-dimensional vector from:

- the nine condition flags;
- normalized `passCount`;
- `entryGate`;
- normalized `spread`;
- normalized `atrPips`;
- normalized `emaDistance`;
- normalized `candleStrength`.

The dataset builder:

1. loads up to 3,000 stored `trade_open` events;
2. loads up to 3,000 stored `trade_close` events;
3. joins primarily by exact `signalId`;
4. falls back to matching fingerprint plus a close timestamp within four hours of the open;
5. computes historical profit, win/loss, and KNN similarity;
6. caches the resulting dataset for 60 seconds.

The current database has only three `trade_open` and three `trade_close` events, all dated June 30 or July 31. The runtime reports a three-pair cache. The stored historical records include test-style identifiers.

## 4. EXACT FILE/FUNCTION

- `telemetry/shadowlab.js`
  - `class ShadowKNNEngine`
  - `ShadowKNNEngine._extract(signal)`
  - `ShadowKNNEngine._refreshDatasetAsync()`
  - `ShadowKNNEngine.evaluate(signal)`
  - `ShadowKNNEngine._getDataset()`
- `telemetry/shadowlab.js`
  - `ShadowLab._cycle()`
  - `_processSignal()`
- `telemetry/shadowlab.js`
  - `shadowGate()`

## 5. DATA SOURCE

C has two distinct data sources:

1. **Current query signal:** the current A/B/C signal payload supplied to `shadowGate()`.
2. **Memory dataset:** persisted `events` rows of type `trade_open` and `trade_close`, joined by signal ID or fingerprint/time window.

It does not read the Knowledge Layer artifacts as its primary KNN dataset in the implementation audited here. Its memory is the historical event-derived dataset.

## 6. LIVE/HISTORICAL/TEST PROVENANCE

- **Live-capable current input:** yes, if a valid current signal payload reaches the gate.
- **Historical memory:** yes, by design.
- **Test contamination possible:** confirmed as a risk. Test-looking event IDs are present in the source population, and no mandatory provenance filter is visible in `_refreshDatasetAsync()`.
- **Current runtime:** historical memory is active; current live C evaluation is not confirmed because current OANDA requests fail before complete Shadow evaluation.

## 7. RISK

C is the highest provenance risk of A/B/C because historical outcomes directly influence its recommendation.

Specific risks:

- test or synthetic outcomes can become KNN neighbours;
- fingerprint/time-window fallback can link a close without exact `signalId`;
- the current dataset is only three historical pairs, far below a mature training base;
- a small contaminated dataset can materially change win rate, expectancy, and neighbour selection;
- current signal detection without valid market evidence can be mistaken for current C coverage.

The implementation correctly abstains when evidence is insufficient, but dataset provenance and maturity are separate concerns and are not fully enforced by the KNN builder.

## 8. RECOMMENDED NEXT ACTION

For a later fix review:

1. require explicit live/non-test provenance before a row enters the KNN dataset;
2. label exact-signal joins separately from fingerprint/time-window fallback joins;
3. expose dataset composition and freshness in C status;
4. keep C in abstention until the controlled evidence threshold and clean resolved-outcome threshold are satisfied;
5. add tests with synthetic/test events proving they cannot influence live C results.

---

# Shadow M preliminary findings

Shadow M is implemented in `telemetry/shadowm.js` as `class ShadowM`.

## Confirmed

- It is OBSERVE-only.
- It does not poll OANDA directly.
- It polls the shared `events` table for `trade_open`, `trade_state_snapshot`, and `trade_close`.
- It writes only its own `shadowm_trades`, `shadowm_timeline`, and diagnostic events.
- It can consume current live-trade telemetry emitted by the Live Bot.
- It can replay stored historical events on first deployment when no cursor exists.

## Not confirmed

The suspected current cursor replay bug was not confirmed.

The current runtime repeatedly reports `_lastId=14720`, and the latest persisted cursor also has `lastId=14720`. No new trade lifecycle events exist after that event ID.

## Evidence

- Current Shadow M database poll: `_lastId=14720`, `active=0`, `known=6`.
- Current event history contains three opens and three closes, latest July 31.
- Current OANDA errors mean no new live trades are being observed.
- Three August `shadowm_trades` rows have no matching current `trade_open` event, so their provenance requires later investigation.

## Risk

Shadow M's Trade Behaviour dataset can contain reconstructed, test, or synthetic records if they enter the event or Shadow M tables without explicit provenance. The cursor is not the confirmed problem at present; provenance classification is the stronger open risk.

## Recommended next action

Later, trace the three August Shadow M records to their writer/test path and classify them explicitly. Do not alter Shadow M execution or Live Bot behaviour as part of this audit.

---

# Cross-shadow risks

1. **Event provenance is not enforced at the shared stream boundary.** Live, historical, test, and synthetic records use the same event types and can therefore be consumed by ShadowLab or C.
2. **Freshness is not equivalent to signal detection.** Current `signal_detected` events are present, but valid OANDA market evidence is unavailable and current A/B/C evaluations are not being produced.
3. **ShadowLab backfill is historical by design.** It scans stored `trade_open` rows and processes records not already represented in `lab_comparison`.
4. **C has a broader contamination impact than A/B.** Historical outcomes directly influence its KNN recommendations.
5. **Small-sample risk is active.** The current C cache contains only three historical pairs, and existing `trade_close` data is not a mature live baseline.
6. **Fallback matching weakens identity guarantees.** C's fingerprint/time-window fallback is not equivalent to an exact same-signal join.
7. **No current live execution was observed.** Runtime logs show zero executed trades and persistent OANDA authentication failures.

# Recommended fixes — not implemented

These are audit recommendations only:

1. Add immutable event provenance such as `origin=live_broker`, `origin=test`, `origin=synthetic`, or `origin=reconstructed`.
2. Add explicit `sourceTs`, ingestion timestamp, and freshness checks to A/B/C status and dashboard metrics.
3. Separate live-current evaluation counters from historical/backfill counters.
4. Require clean, resolved, non-test outcomes before adding rows to C's memory dataset.
5. Report exact-signal and fallback-linked C samples separately.
6. Keep insufficient or unavailable OANDA data as `UNKNOWN`/abstention rather than allowing coverage metrics to imply successful observation.
7. Add provenance-focused tests for Shadow A, B, C, and Shadow M.
8. Investigate the three August Shadow M records before using them as Trade Behaviour evidence.

# Explicit no-change statement

During this ETAP 2 audit:

- no source code was modified;
- no Live Bot logic was modified;
- no Shadow implementation was modified;
- no database records were modified;
- no commit was created;
- no deployment was performed;
- no broker action was initiated.
