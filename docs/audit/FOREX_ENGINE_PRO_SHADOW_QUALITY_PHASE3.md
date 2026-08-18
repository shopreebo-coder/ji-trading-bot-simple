---
title: "FOREX ENGINE PRO — Shadow Quality Audit Phase 3/3"
date: "2026-08-18"
status: "AUDIT COMPLETE — PUBLISH NOT EXECUTED"
---

# FOREX ENGINE PRO — Shadow Quality Audit Phase 3/3

## 1. Executive conclusion

This audit does **not** establish a predictive advantage for Shadow A, B, C or M. The live evidence base is too small:

- `shadow_engine_evals`: 3 observations per engine A/B/C/D.
- `shadow_outcomes`: 3 matched outcomes in total.
- Only 1 outcome is non-test; 2 are `testSimulation=true`.
- Shadow M has 4 observed rows: 2 wins and 2 flat test records.
- Local OANDA access returns `401 Insufficient authorization`, so no new broker-backed observations could be collected.

The correct production conclusion is **INSUFFICIENT DATA**, not USEFUL or DEGRADING. No confidence calibration, ranking claim, or live influence should be promoted from this sample.

The confirmed quality fixes are deliberately narrow:

1. Shadow A/B now return `ABSTAIN` when required market evidence is missing or malformed instead of inventing score/confidence from zero-like defaults.
2. Knowledge expectancy/confidence metadata now separates current non-test outcomes from historical snapshot points.
3. Selected Engine rejects Knowledge evidence unless the current non-test resolved sample reaches the minimum of 30.

After the fixes, the active Knowledge artifacts report `currentResolvedOutcomes=1` and `LOW` confidence. Controlled evidence is therefore unavailable and the Capital Gate remains fail-closed.

## 2. Scope and safety boundary

The audit covered:

- Shadow A/B/C observations and agreement with matched outcomes.
- Abstain quality and malformed/missing evidence behavior.
- Confidence versus outcome evidence.
- Shadow M exit observations.
- Selected Engine same-signal aggregation and Knowledge matching.
- Knowledge artifact provenance, checksums, versions and sample-size semantics.
- Capital Gate `ALLOW / ABSTAIN / BLOCK` behavior.
- Broker/order ownership and the BEFORE vs AFTER safety boundary.

The following were intentionally not changed:

- Live Entry signal generation and existing live filters.
- Risk, sizing, lot size, SL/TP, trailing, break-even and execution parameters.
- `placeTrade()` ownership and the Live Bot's final authority.
- Shadow M strategies or exit behavior.
- Shadow A/B scoring weights and their intended research logic.
- Shadow D's research-only role.
- Any broker credentials or deployment settings.

The controlled flow remains:

```text
MARKET DATA
  -> LIVE SIGNAL
  -> EXISTING LIVE FILTERS
  -> SHADOW A/B/C OPINIONS
  -> SELECTED ENGINE
  -> KNOWLEDGE EVIDENCE
  -> CAPITAL GATE
  -> LIVE FINAL DECISION
  -> EXISTING EXECUTION
```

## 3. Dataset and observability limits

| Source | Observed sample | Audit interpretation |
|---|---:|---|
| Shadow A evals | 3 | 1 non-test matched outcome, 2 test simulations |
| Shadow B evals | 3 | 1 non-test matched outcome, 2 test simulations |
| Shadow C evals | 3 | 3 abstains; no predictive claim possible |
| Shadow D evals | 3 | Research context only; excluded from controlled capital evidence |
| Shadow outcomes | 3 | 1 non-test, 2 test simulations |
| Shadow M trades | 4 | 2 wins, 2 flat; all strategies report `Live (no improvement)` |
| Current resolved non-test outcomes | 1 | Below the minimum sample of 30 |
| Live broker observations | 0 new | OANDA returned HTTP 401 authorization failure |

The database contains historical research and test activity, but historical volume must not be presented as live predictive validation. Snapshot point counts are not training-event counts.

## 4. Shadow A quality

### Observations

Shadow A has 3 evaluations:

- 2 `wouldTrade=true`.
- 1 `wouldTrade=false`.
- Scores: 91.2, 87.8 and 9.0.
- Confidence: 2 HIGH and 1 LOW.

### Outcome agreement

There is only one non-test matched outcome. On that record, Shadow A returned `wouldTrade=false` while the observed outcome was a win. This is one false-negative observation if A had been used as a blocking entry filter. The two `testSimulation` records were flat and cannot validate live usefulness.

### Classification

**INSUFFICIENT DATA.** The single non-test record is a caution signal, not enough evidence to label A harmful or degrading. A must remain advisory-only.

### Confirmed fix

When required inputs (`spread`, `atrPips`, `emaDistance`, `candleStrength`, and the complete condition map) are absent, null, empty or non-numeric, A now returns `ABSTAIN` with no fabricated score/confidence.

## 5. Shadow B quality

### Observations

Shadow B has 3 evaluations:

- 3 `RANGING`.
- 3 `wouldTrade=false`.
- 0 trade recommendations.

### Outcome agreement

The single non-test matched record was a win while B said `NO_TRADE`. This is one false-negative observation if B had been allowed to block live entry. The two test simulations were flat and do not establish harm or benefit.

### Classification

**INSUFFICIENT DATA.** B appears conservative in this tiny sample, but there are no live positive/negative pairs sufficient for calibration. Its `NO_TRADE` output must not become a capital veto outside the controlled, complete, high-confidence gate.

### Confirmed fix

B uses the same strict evidence guard as A. Missing or malformed market evidence produces `ABSTAIN` instead of a synthetic `RANGING`/confidence result.

## 6. Shadow C quality

Shadow C returned `ABSTAIN` for all 3 observations. The recorded reason is insufficient KNN/history evidence. This is the correct behavior for an engine without enough neighbors; it is not a failed prediction.

Classification: **INSUFFICIENT DATA — abstain behavior is appropriate.**

The audit found no confirmed telemetry problem requiring a change to C's KNN logic. C remains research/advisory-only and cannot create controlled `ALLOW` evidence when it abstains.

## 7. Shadow M quality

Shadow M has 4 persisted trade observations:

- 2 positive outcomes: 10.5 pips and 14.2 pips.
- 2 flat test records.
- `best_strategy` is `Live (no improvement)` for every row.
- `profit_saved=0` for every row.

The observed rows do not demonstrate that any shadow exit strategy improves the Live baseline. This is **INSUFFICIENT DATA**, not a basis for enabling Exit Engine X. The existing boundary remains intact:

- observe and log only;
- no broker calls;
- no Live Exit influence;
- require a substantially larger real trade sample before any influence discussion.

## 8. Confidence, abstain and agreement quality

### BEFORE

Before the correction:

- `confidence/history` could report `training_events=104` and confidence `1.0` from snapshot-point accumulation.
- `expectancy/history` could report 32 resolved trades and `MEDIUM` based on historical/test-contaminated snapshot rows.
- Selected evidence could therefore look available even though current non-test outcomes were only 1.
- Sparse A/B inputs could become ordinary-looking low/default decisions instead of explicit abstains.

### AFTER

After the correction and restart:

- Active `confidence/history`: `training_events=1`, `currentResolvedOutcomes=1`, `LOW`.
- Active `expectancy/history`: `training_events=1`, `currentResolvedOutcomes=1`, `LOW`.
- Active validated patterns: `validatedCount=0`, minimum sample 30.
- Selected evidence: unavailable when current non-test sample is below 30.
- Shadow A/B sparse/malformed evidence: `ABSTAIN`.
- Shadow C sparse history: `ABSTAIN`.

The system now distinguishes historical research points from current resolved, non-test outcomes. This is the required fail-closed interpretation.

## 9. Selected Engine and Knowledge Layer

Selected Engine remains read-only and uses same-signal A/B/C evidence. Persisted D and other research context do not satisfy the controlled A/B/C contract.

The Knowledge evidence contract now requires:

- active `patterns/validated`, `market/fingerprints` and `expectancy/history`;
- current confidence/history or expectancy sample metadata;
- `currentResolvedOutcomes >= 30`;
- matched symbol/fingerprint/pattern/expectancy evidence;
- no malformed or out-of-scope inline evidence.

With the actual current sample of 1, Selected must not expose Knowledge as available evidence for controlled capital. Its resulting recommendation is advisory context only; it cannot bypass Capital Gate.

## 10. Capital Gate and order-flow safety

The Capital Gate retains exactly three outcomes:

- `ALLOW` only for complete, same-signal, high-confidence A/B/C agreement plus valid Knowledge evidence.
- `ABSTAIN` for missing data, timeout, malformed data, NaN, conflict, sample insufficiency or system failure.
- `BLOCK` only for complete high-confidence `NO_TRADE` agreement.

Tests covering `ALLOW`, `ABSTAIN`, `BLOCK`, conflict, missing/malformed evidence, low confidence, low-sample Knowledge, fail-safe behavior and order protection passed.

The broker ownership check remains clean:

- `placeTrade()` appears only in the Live Bot execution path.
- Shadow A/B/C/M, Selected and Knowledge contain no order creation or broker execution path.
- The Dashboard and research workers are observational.
- No Shadow/Selected/Knowledge component can authorize an order by itself.

## 11. Test and runtime verification

Validated test groups:

| Group | Result |
|---|---:|
| Unit suite | 301/301 PASS |
| Non-Knowledge integration suite | 118/118 PASS |
| Memory Integration, isolated | 18/18 PASS |
| Knowledge migration/manager/recovery/flag/pattern tests, isolated | 25/25 PASS |
| Selected/Shadow targeted regression after final fix | 9/9 PASS |
| Simulation suite | PASS |
| Stress suite | 48/48 PASS |

The shared PostgreSQL-backed Knowledge and Memory fixture tests were intentionally run in isolated processes. Running those fixture files concurrently caused cross-test writes and false idempotency failures; isolated execution is the valid verification mode for these database-locking tests.

Runtime smoke checks after restart:

- Telemetry Dashboard: running on port 8083.
- API, Mockup Sandbox and Telemetry workflows: running.
- Knowledge build: successful.
- Selected build: successful with no reported build error.
- Shadow M: restored and running in `OBSERVE` mode.
- Dashboard HTML contains Shadow A/B/C/M, Selected, Knowledge and Exit Lab sections.
- Lab, Shadow M, Knowledge, Selected and Modules status endpoints returned successfully.
- OANDA 401 authorization errors are visible with HTTP/body/endpoint context; they are not hidden as fake candle insufficiency.

## 12. Final classification

| Component | Classification | Live influence |
|---|---|---|
| Shadow A | INSUFFICIENT DATA; one cautionary false-negative observation | None |
| Shadow B | INSUFFICIENT DATA; conservative on one non-test win | None |
| Shadow C | INSUFFICIENT DATA; abstain behavior appropriate | None |
| Shadow M | INSUFFICIENT DATA; no exit improvement observed | None |
| Selected Engine | PASS as read-only same-signal orchestrator; evidence unavailable at current sample | Advisory only |
| Knowledge Layer | PASS after sample-size correction; current evidence LOW/unavailable | Read-only |
| Capital Gate | PASS fail-closed contract | Only gate before Live final decision |
| Live Bot | PASS ownership preserved | Sole broker authority |

## 13. Recommendation

Do not claim Shadow advantage, do not calibrate confidence upward, and do not enable Shadow or Exit Engine influence. The next valid research step is to collect at least 30 resolved, non-test, matched outcomes per evaluation policy, while preserving signal identity and broker authorization telemetry.

The code and local runtime are ready for one controlled publish action. Publishing was **not** executed automatically.