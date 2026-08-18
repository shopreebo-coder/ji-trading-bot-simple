---
title: "FOREX ENGINE PRO — Final Pre-Push Fix"
date: "2026-08-18"
status: "READY_FOR_PUSH"
---

# FOREX ENGINE PRO — Final Pre-Push Fix

## Deadlock verdict

**Deadlock existed.**

The Live Bot already produced `signal_detected` and Shadow/Selected telemetry, but the only path to a broker-confirmed `trade_open` passed through `cooperativeEntry()`. With only one real resolved outcome, Knowledge was unavailable; Capital Gate returned `ABSTAIN`; the existing Live entry branch returned before `placeTrade()`. Therefore no new real outcomes could be created.

## Minimal fix

The bootstrap path now recognizes exactly one case:

```text
capitalGateDecision = ABSTAIN
capitalGateReason   = knowledge_evidence_unavailable
```

In that case only, the already-approved Live strategy may continue to its existing execution code to collect a real outcome. This is explicitly **baseline collection**, not a controlled `ALLOW`:

- Capital Gate remains `ABSTAIN`.
- No Shadow or Selected output authorizes the trade.
- `BLOCK` still stops execution.
- Timeout, service failure, malformed data, conflict, low confidence and every other `ABSTAIN` still stop execution.
- Existing Live filters have already passed before this branch.
- Existing risk, sizing, lot size, SL/TP, trailing, break-even and `placeTrade()` are unchanged.
- A `controlled_baseline_collection` telemetry event records the exception with `shadowInfluence=false`, `authority=live_bot`, and the same `signalId`.

No Knowledge threshold was reduced. `testSimulation` rows are not used as real outcomes.

## Files changed

1. `telemetry/managers/CooperativeManager.js`
   - Added the exact-reason helper `canCollectLiveBaseline`.
   - It returns true only for Knowledge-bootstrap `ABSTAIN`.

2. `index.js`
   - Applied the helper symmetrically to BUY and SELL.
   - Added explicit baseline-collection telemetry.
   - Did not modify `placeTrade()`, risk calculations or execution parameters.

3. `telemetry/tests/unit/cooperativeManager.test.js`
   - Added the minimal regression test for bootstrap collection and rejection of unsafe reasons.

## Tests

- Unit suite: **302/302 PASS**
- Non-Knowledge integration suite: **PASS**
- Knowledge migration/manager/recovery/feature-flag/pattern tests: **PASS**
- Memory Integration, isolated: **PASS**
- Simulation suite: **PASS**
- Stress suite: **48/48 PASS**
- Final targeted Shadow/Selected/Capital Gate tests: **16/16 PASS**
- JavaScript syntax checks: **PASS**
- `git diff --check`: **PASS**

The shared PostgreSQL Knowledge and Memory fixtures were run in isolated processes to avoid false failures caused by concurrent fixture writes.

## Live and risk invariants

Confirmed unchanged:

- `RISK_PERCENT` and `calculateUnits()`.
- `MAX_OPEN_TRADES` and existing daily/open-trade limits.
- Stop-loss and take-profit calculations.
- `placeTrade(symbol, side, units, slPips, tpPips)` signature and calls.
- Existing Live filters and broker ownership.
- Shadow A/B/C/M, Selected and Knowledge remain unable to make broker calls.

## Runtime and OANDA status

After restart:

- Telemetry Dashboard: running.
- API Server: running.
- Mockup Sandbox: running.
- Knowledge build: successful.
- Selected build: successful with `lastError=null`.
- Shadow M: restored in `OBSERVE` mode.
- OANDA remains unavailable locally: HTTP **401 Insufficient authorization** for candle requests.

The code is ready to collect real data once OANDA authorization is repaired. No deployment or publish was performed.

## Recommendation

**PUSH** the code change. Before expecting new real outcomes, repair the OANDA account/API authorization and verify the first `controlled_baseline_collection`, broker-confirmed `trade_open`, and subsequent outcome all retain the same `signalId`.

READY_FOR_PUSH