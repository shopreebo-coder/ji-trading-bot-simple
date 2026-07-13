---
name: Selected Engine invariants
description: Non-negotiable design constraints for the read-only "Selected Engine" intelligence-orchestration layer; violate any and you break its reason for existing.
---

The Selected Engine is a pure **read-only intelligence aggregation/orchestration**
layer over the shadow_* research + knowledge_* artifacts. It exists to *observe and
rank*, never to act. When touching it, keep these invariants:

- **Never trades, never influences a Live Bot / Shadow / Risk decision.** Nothing
  it produces may feed back into a trading path. Outputs go only to HTTP responses
  and an in-memory ring buffer.
  **Why:** the whole point is a safe observation layer; if its output ever gated a
  real order it would become an unreviewed trading engine.
- **Never writes to any table.** Reads only — `db.get`/`db.all`, no INSERT/UPDATE,
  no DDL, no `pool.connect()`. (No held-client path ⇒ CAS pool deadlock is
  structurally impossible.)
  **Why:** it aggregates existing research; a write would corrupt provenance and
  could churn knowledge-artifact versions.
- **Zero hardcoded engine names.** Engines are auto-discovered via
  `DISTINCT engine_id` from `shadow_engine_evals` (+ optional fs-scanned plugin
  dir), each wrapped in a generic recorded-eval adapter. Adding Engine E/F/G must
  need no code change — do not special-case any engine id anywhere.
- **DecisionContext id must stay deterministic.** Basis = content only
  (`{signalId, evalIds, artifactVersions, snapshotChecksum}`). Never put wall-clock
  / `generated` timestamps in the id basis, or identical inputs stop deduping.
- **Ranking is NOT winrate.** Order is
  Confidence → Expectancy → TrainingEvents → ArtifactVersion → SnapshotFreshness.
  Consensus is **tri-state**: an abstaining engine (`would_trade IS NULL`) is
  excluded from BOTH numerator and denominator — never coerce abstention to a
  decision (see the `Number(null) === 0` trap).
- **`SELECTED_ENGINE` flag (default OFF) gates ONLY the background poll.** OFF is a
  complete no-op (no timer, no builds). Read-only endpoints are always registered
  and build contexts on demand regardless of the flag.
