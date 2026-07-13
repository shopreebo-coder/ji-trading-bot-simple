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
- **DecisionContext id AND EvidenceTrace checksum must stay deterministic.** id
  basis = content only (`{signalId, evalIds, artifactVersions, snapshotChecksum}`);
  the EvidenceTrace checksum basis likewise excludes ALL wall-clock — including
  per-record `freshness`. `freshness` derived from `generated`/`Date.now()` is a
  wall-clock leak (this bit the `expectancy:ALL` record: `freshness: tsMs(generated)`
  → must be `null`). DB-row `created_at` freshness is fine as a *ranking* input
  (stable per row) but is still excluded from the trace `records`. Rule: identical
  DB rows ⇒ identical id ⇒ identical trace checksum across processes/restarts.
- **deepFreeze on a structure that embeds shared references freezes them
  everywhere.** The EvidenceTrace is deep-frozen; consensus arrays
  (`agreeing/dissenting/abstaining`, also exposed as `ctx.consensusDetail`),
  `marketFingerprint`, and `artifactVersions` are reused elsewhere in the context /
  explainability. COPY them (`[...]` / `{...}`) into the trace basis before freezing
  — otherwise a future strict-mode mutation of the live `ctx.consensusDetail` etc.
  throws. Already-frozen module constants (e.g. `RANKING_CRITERIA`) can be embedded
  verbatim; deepFreeze skips them.
- **`schemaVersion` on DecisionContext is a real contract.** Downstream consumers
  branch on it. Additive fields do NOT bump it; only a breaking shape change does.
- **Ranking is NOT winrate.** Order is
  Confidence → Expectancy → TrainingEvents → ArtifactVersion → SnapshotFreshness.
  Consensus is **tri-state**: an abstaining engine (`would_trade IS NULL`) is
  excluded from BOTH numerator and denominator — never coerce abstention to a
  decision (see the `Number(null) === 0` trap).
- **`SELECTED_ENGINE` flag (default OFF) gates ONLY the background poll.** OFF is a
  complete no-op (no timer, no builds). Read-only endpoints are always registered
  and build contexts on demand regardless of the flag.
