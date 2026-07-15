# CHANGELOG — SHADOW OS v2 Migration

All notable changes to the SHADOW OS v2 migration program. The production
entrypoint (`index.js`) and its start chain are FROZEN — every entry below is
additive.

---

## SPRINT 7 FAZA 1: Smart Decision Integration — OBSERVATIONAL ONLY (2026-07-15)

Two-file additive change set (`telemetry/managers/SelectedAdvisor.js` `_record()`
+ `telemetry/public/index.html` report). Zero server.js change, zero new
endpoints, zero DB/migration change, zero API-contract break (all fields are
additive), zero trading-logic / Risk Manager / Shadow Lab / Knowledge Layer /
Selected Engine impact. The advisor still NEVER writes to the DB, NEVER throws
into the trading path, and records its opinion strictly AFTER each live trade
open.

### Added
- **SelectedAdvisor advisory record — Sprint 7 Phase 1 fields** (purely
  additive; existing payload fields byte-identical):
  - `status` — normalized observational status: `OK` (opinion attached),
    `NOT_AVAILABLE` (no DecisionContext could be built — no signalId recovered
    or empty context), `ERROR` (swallowed exception). The detailed
    `advisor.status` (`OK`/`NO_SIGNAL_ID`/`EMPTY_CONTEXT`/`ERROR`) is kept.
  - `selectedRankingTop3` — explicit Sprint 7 field name; same content as the
    kept `selectedRanking` (top 3 of the Selected Engine ranking).
  - `knowledgeVersion` / `knowledgeSnapshot` — knowledge-layer provenance of
    the opinion (from `ctx.metadata`, falling back to
    `ctx.explainability.knowledgeVersions`).
  - `marketFingerprint` — from `ctx.explainability.evidenceSummary`.
  - `selectedDecisionTime` (ISO) + `decisionLatencyMs` — when the Selected
    opinion was captured, and how long after the observed trade open.
  (`selectedConsensus`, `selectedConfidence`, `selectedReason`,
  `selectedEvidenceId` already existed and are unchanged.)
- **AI Report v2 — SELECTED ADVISOR ANALYSIS section** (after SELECTED
  ENGINE): advisor counters, status breakdown (OK / NOT_AVAILABLE / ERROR),
  confidence distribution (HIGH/MEDIUM/LOW), Selected decisions
  (TRADE/NO_TRADE/SPLIT/ABSTAIN), agreement with the Live Bot (among decided
  opinions — every advisory corresponds to an executed trade), average
  consensus (mean `agreementScore`). Pre-Sprint-7 ring entries without the
  new `status` field are classified via `advisor.status` fallback.
- **AI Report v2 — "WOULD SELECTED HAVE HELPED?"** (AI SUMMARY, after
  SELECTED ENGINE SANITY): joins REAL executed & closed trades
  (`/api/trades`) with OK advisories by `signalId` — strictly retrospective
  filtering, no simulated entries. Reports: losses where Selected said
  NO_TRADE (incl. HIGH-confidence subset), profits that would have been
  rejected, potential Win Rate / expectancy impact (same trades with
  NO_TRADE-flagged removed; BREAKEVEN excluded from WR), and a verdict
  (NEUTRAL / PROMISING / SLIGHTLY POSITIVE / MIXED) derived from the measured
  expectancy delta. Architect-review hardening: when the close event carries
  its own `signalId`, the join requires `close.signalId === open.signalId` —
  guards against `/api/trades`' symbol+timestamp close→open pairing attaching
  another trade's outcome to the advisory (legacy closes without `signalId`
  still join as before).
- Report fetch phase 6 now pulls `/api/memory-integration/status`,
  `/api/selected/advisories?limit=100`, `/api/trades` via `fetchLimited(…, 2)`
  (33 endpoints total; concurrency caps preserved).

### Tests
- `telemetry/tests/unit/SelectedAdvisor.test.js`: +5 Sprint 7 tests (16/16) —
  new fields on success, metadata→explainability fallback, NOT_AVAILABLE
  normalization (empty context + no signalId), ERROR normalization; zero-DB-
  write contract re-asserted.
- Report smoke tests on the extracted dashboard code: full scenario counts,
  verdict branches (PROMISING/NEUTRAL/MIXED), null/502/no-join fallbacks,
  outcome-string + BREAKEVEN handling. esbuild syntax check PASS.
- Regression: Selected Engine trio 25/25, knowledgeProvenance 7/7.

---

## SPRINT 6.2: Telemetry stabilization — AI Report v2 (2026-07-15)

Dashboard-only change set (`telemetry/public/index.html`, `generateReport` +
`buildReportV2` only). Zero server change, zero API-contract change, zero
Live Bot / Advisor / Selected Engine / Knowledge / Shadow Lab impact.
`generateSnapshot()` and the global `api()` helper remain byte-identical.

### Fixed
- **HTTP 502 bursts during report generation.** Root cause (static analysis —
  server must never be run locally): the report fired 6 phases of **6 parallel
  fetches**; phase-1 endpoints are the heaviest (`/api/stats` alone runs 4
  `queryEvents` calls incl. a LIMIT-10000 whole-day scan; `/api/symbols`
  LIMIT 10000), all sharing ONE pg pool (max 10 connections,
  `connectionTimeoutMillis` 5000) **with the live trading bot**. The burst
  exhausts the pool → >5s connect waits throw → 500 at origin / 502 JSON at
  the Railway edge. Fix (client-side only):
  - `fetchLimited(paths, limit)` — ordered results with capped concurrency
    (2 for heavy phases, 3 for the light knowledge-artifact phase) replaces
    every intra-phase `Promise.all`, leaving pool headroom for the bot;
  - `safe()` now **retries transient failures** (non-2xx except 404, plus
    network errors) up to 2× with 600 ms/1800 ms backoff. 404 stays
    immediate-null/no-retry/no-failure (expected "artifact not built"
    contract). Exactly one FAILURES entry per finally-failed endpoint;
    `timings` recorded once per path on every exit branch, so
    "Endpoints fetched: 31" is preserved.
- **"Selected sources: [[object Object]]".** `explainability.selectedSources`
  is an array of OBJECTS `{source, kind, confidence, expectancy}`
  (`SelectedEngineManager`); the report `.join(", ")`-ed it directly. Now maps
  objects → `s.source` (plain names, same as `topSources`).
- **AI SUMMARY contradicting ACTIVE ARTIFACTS.** `knowledgeActive` came only
  from `knStatus?.artifacts?.active` — if `/api/knowledge/status` failed while
  `/api/knowledge/artifacts` succeeded, the summary claimed "no active
  artifacts" under a populated artifact list. Now a single shared derivation
  (`knActiveCount`, Number-coerced status value when present, else the
  artifact-list length; `knDomains` analogously) feeds ACTIVE ARTIFACTS,
  PIPELINE HEALTH → KNOWLEDGE STAGE, AI SUMMARY and KNOWLEDGE LAYER VALUE.
  STORE STATISTICS still reports the status endpoint verbatim (by design).

### Known cosmetic edge (accepted)
- Inverse asymmetry: if `/api/knowledge/status` succeeds but
  `/api/knowledge/artifacts` fails, ACTIVE ARTIFACTS prints "N/A" while
  KNOWLEDGE STAGE shows the status count. Low priority; both retry now, so
  the window is small.

### Verification
- esbuild syntax check of the whole dashboard script: PASS.
- Node smoke tests of the ACTUAL extracted code: `buildReportV2` (object
  selectedSources → names; knStatus-failed + artifacts-present → all sections
  agree; status authoritative over list; empty list → 0/"NOT YET"; all-null →
  no crash; 502-object `syms` → prior fix intact; prev-comparison 9→7
  detected) and `safe()`/`fetchLimited` (502→200 retried, 0 failures;
  persistent 502 → 3 attempts, exactly 1 failure; 404 → 1 attempt, 0
  failures; network-error retry; ordered results; max in-flight = 2;
  timings key per path).
- Regression: SelectedAdvisor + selectedRanking + knowledgeProvenance pure
  unit suites — 29/29 pass.
- Architect review: **PASS** — pool-saturation diagnosis confirmed as the
  dominant 502 mechanism (retry additionally covers a pure edge-timeout
  cause); all 31 report endpoints verified GET/read-only, so duplicate
  requests are safe; failure accounting sound.

---

## BUGFIX: dashboard report crash "(syms || []).map is not a function" (2026-07-15)

Dashboard-only fix (`telemetry/public/index.html`, +15/−2). Zero server change,
zero API-contract change, zero Live Bot / Advisor / Engine / Knowledge /
Shadow Lab impact.

### Fixed
- **Root cause:** `GET /api/symbols` did NOT change its contract — it always
  returns a JSON array. But the report's `safe()` fetch helper never checked
  `r.ok`, so any HTTP-error response **with a JSON body** (most plausibly a
  Railway edge 502 document `{"status":"error","code":502,…}` when the heavy
  10k-event `/api/symbols` scan times out) was parsed and passed through as
  data. The truthy non-array object then crashed at the first unguarded array
  consumer in `buildReportV2()` — exactly `(syms||[]).map`.
- `safe()` now treats non-2xx as absent data (`null` → rendered as N/A):
  status ≠ 404 is recorded in FAILURES; **404 is excluded** (expected
  "knowledge artifact not built yet" contract previously absorbed by
  `knParse` as `ok:false` — keeps the `failures.length <= 5` baseline-save
  guard semantics identical).
- Belt-and-braces: `(syms||[]).map` → `(Array.isArray(syms)?syms:[]).map`.
- `generateSnapshot()` and the global `api()` helper are **byte-identical**
  (changing `api()` would risk regressions in every dashboard tab that reads
  `{ok:false}` JSON bodies).

### Verification
- Node smoke tests of the ACTUAL extracted code: `buildReportV2` with
  syms = 502-error-object / null / valid array → no crash, correct rendering;
  `safe()` against mocked 502-JSON / 404-JSON / 500-HTML / 200 responses →
  correct null/failure semantics. esbuild syntax check of the whole dashboard
  script: PASS.
- Architect review: **PASS** — diagnosis confirmed (no route shadowing, no
  middleware, `db.all` always returns an array; no report section relied on
  non-2xx JSON bodies; `/api/healthz/persistence` degrades inside a 200 body).

---

## Selected Advisor — advisor-only Live Bot integration (2026-07-15)

Connects the (already existing, read-only) Selected Engine to the live trade
stream as a **PURE ADVISORY layer**. Zero change to bot logic, entry/exit,
risk, TP/SL, trailing, cooldowns, thresholds or config — `index.js` untouched,
no existing endpoint modified, no Shadow Lab / Knowledge / pipeline / DB-schema
change, **no DB writes** (only read-only `SELECT`s). If the Selected Engine
fails, the Live Bot behaves exactly as before.

### Added
- **`telemetry/managers/SelectedAdvisor.js`** — advisor-only bridge
  (LiveMemoryIntegration pattern). On a live trade open observed by server.js
  (stdout `Trade -> SYMBOL SIDE`), on detached **unref'd timers**
  (10s/25s/60s retries): recovers the trade's `signalId` from the append-only
  `events` table (read-only `db.get`, dual TEXT/JSONB parse, 120s stale-attach
  guard), builds the Selected Engine's DecisionContext for that **exact**
  signal (always explicit `signalId`, never latest), and records the opinion
  `{signalId, symbol, side, selectedDecision, selectedConsensus,
  selectedConfidence, selectedRanking (top-3), selectedEvidenceId
  (evidence-trace checksum), contextId, selectedReason, advisor.status}` into
  a bounded **in-memory** ring (100). Every path try/catch — `onTradeOpen`
  can never throw into the stdout parser.
- **`server.js` wiring (additive only)**: `SELECTED_ADVISOR` flag (default
  **ON**, `off` = kill switch restoring prior behavior exactly), instance next
  to `selectedEngine`, ONE best-effort hook line after
  `memoryIntegration.recordTradeOpen`, `selectedAdvisor.stop()` in
  `gracefulExit`.
- **NEW endpoint `GET /api/selected/advisories?limit=`** — newest-first
  in-memory advisory list + advisor status/counters. Purely additive.
- **`telemetry/tests/unit/SelectedAdvisor.test.js`** — 11 tests (mock db +
  mock engine): advisory shape, empty-context retry→stub, engine-throw and
  db-throw swallowed, missing-event→`NO_SIGNAL_ID`, stale-event guard,
  flag-off complete no-op, `stop()` cancels timers, ring bound, TEXT/JSONB
  parse, malformed args.

### Operational note
- Meaningful (non-stub) advisories require `SHADOW_LAB_RESEARCH=on` on
  Railway — the DecisionContext is built from `shadow_signals`, populated by
  the research reconciler. With research off every advisory is an
  `EMPTY_CONTEXT` stub (harmless: a few read-only SELECTs per trade).

### Verification
- New suite 11/11 PASS. Full regression green: Sprint 1 107/107, Sprint 2
  169/169, Sprint 3 87/87 + mm_stress 14/14, Sprint 4 18/18 + mi_process 3/3,
  autoMigrate 4/4, Sprint 5 23/23, Sprint 6 27/27, Selected Engine 25/25,
  schema 11/11, smoke 8/8 (pre-existing pool-hang-after-pass quirk on the
  last two, documented in replit.md).
- Architect review: **PASS** — zero-write path confirmed by inspection
  (advisor uses only `db.get`; `buildDecisionContext` read-only end to end),
  no throw path into `handleBotLine`, retry schedule (10s/35s/95s cumulative)
  fits inside the 120s stale guard, diff strictly additive (+46/−1 across
  `server.js` + barrel, 2 new files).

---

## AI Complete Analysis Report v2 — Dashboard Export (2026-07-14)

One-click, **client-side only** extension of the Analysis Report in the
dashboard EXPORT tab (`telemetry/public/index.html`). Zero server change, zero
DB writes, zero Live Bot impact — the report is assembled in the browser from
~26 existing read-only GET endpoints and downloaded as
`ai_analysis_report_v2_TIMESTAMP.txt`. `generateSnapshot()` (Full Analysis
Snapshot) is untouched.

### Added
- **`buildReportV2()`** — pure, defensive report builder (module-level, no I/O):
  every endpoint input may be `null` (failed fetch) and every field renders as
  `N/A` instead of crashing. Sections:
  - **LIVE BOT** — legacy performance summary, verbatim content.
  - **SHADOW LAB** — overview, gate evaluations, research-layer counts,
    agreement & caution flags, Shadow A/B/C/D summaries, per-symbol comparison,
    virtual-expectancy ranking (+ dataQualityNote), virtual performance,
    Exit Lab (Shadow M), computed BEST/WORST observations.
  - **KNOWLEDGE LAYER** — latest snapshot/manifest, growth diff vs previous
    snapshot (artifact/byte delta + manifest-checksum change), store statistics,
    active artifact versions, and 5 artifact deep-dives (confidence/history,
    expectancy/history, experiments/metadata, market/fingerprints,
    patterns/validated).
  - **SELECTED ENGINE** — DecisionContext (schema v1), consensus &
    disagreement, confidence chain, engine opinions, ranking, explainability,
    reproducible evidence trace, knowledge-vs-engine contribution, final
    reasoning, manager status.
  - **PIPELINE HEALTH** — ingestion waterfall, research/knowledge/selected
    stages, telemetry & persistence, polling & cache, export-stage self-metrics
    (per-endpoint timings), FAILURES (fetch + CRITICAL/HIGH audit findings),
    WARNINGS (data quality, INFO findings, disabled feature flags).
  - **AI SUMMARY** — deterministic rule-based synthesis (no external AI):
    what works well, degraded-since-previous-report (localStorage baseline
    `forex_ai_report_v2_prev`, guarded so a heavily-failed fetch pass never
    overwrites a healthy baseline), best developing Shadow, Knowledge-layer
    value verdict, Selected Engine sanity check (incl. Lab-vs-Selected ranking
    consistency), next-sprint recommendations.
- **`safe()` fetch wrapper** in `generateReport()` — per-endpoint try/catch →
  `null`, collects failures and timings; 6 batched `Promise.all` waves with
  progress status updates.

### Fixed (during review)
- `patterns/validated` winrate is stored as a 0–1 fraction — rendered ×100 as a
  percent (architect review catch; would have fed "WR 0.6%" to the AI).

### Verification
- esbuild JSX syntax check of the whole Babel-standalone script: PASS.
- Node smoke tests of `buildReportV2`: all-null inputs (199 lines, no crash) and
  realistic mocks (309 lines) — PASS.
- All 26 fetched endpoint paths verified present in `telemetry/server.js` /
  `telemetry/index.js`.
- Architect review: PASS after the winrate fix; read-only constraint confirmed
  (GET-only, localStorage is the sole write surface).

---

## Selected Engine — Read-Only Intelligence Orchestration (2026-07-13)

A pure **read-only** aggregation/orchestration layer that turns already-recorded
research into a normalized, ranked, tri-state **DecisionContext** per signal. It
**never trades, never influences any Live Bot / Shadow / Risk decision, and never
writes to any table** — reads only. `index.js` and the trading paths are untouched.

### Added
- **Pure ranking + consensus core** (`telemetry/managers/selected/ranking.js`):
  `numOrNull`/`boolOrNull` (null/undefined/"" → `null`, never a fabricated `0`;
  tri-state booleans preserve engine abstention), `confidenceToScore`/
  `scoreToTier`, `cmpDescNullsLast`, `rankIntelligence` (orders by
  **Confidence → Expectancy → TrainingEvents → ArtifactVersion → SnapshotFreshness**,
  NOT winrate), and `computeConsensus` (abstainers excluded from BOTH numerator
  and denominator; TRADE / NO_TRADE / SPLIT / ABSTAIN with null scores when
  nobody commits).
- **Auto-discovery plugin layer** (`telemetry/managers/selected/enginePlugins.js`):
  `discoverEngines` reads `DISTINCT engine_id` from `shadow_engine_evals` and
  wraps each in a generic `RecordedEvalAdapter` (uniform
  `analyze`/`score`/`explain`/`confidence`/`metadata` interface) — **zero
  hardcoded engine names**, so a future Engine E/F/G that starts recording evals
  is picked up with no code change. Also fs-scans an optional plugin directory
  for bespoke custom plugins (best-effort).
- **SelectedEngineManager** (`telemetry/managers/SelectedEngineManager.js`):
  `buildDecisionContext({ signalId })` composes per-engine opinions, dynamic
  `shadow<ID>` aliases, tri-state consensus, an auto-discovered Knowledge-domain
  list, and a ranked intelligence package (engines + expectancy + knowledge).
  DecisionContext **id is deterministic** (SHA-256 over
  `{signalId, evalIds, artifactVersions, snapshotChecksum}` — no wall-clock).
  In-memory ring buffer serves `getLatest`/`getContext(id)`/`listContexts`; read
  APIs `getStatus`/`listEngines`/`getContext`. Lifecycle `start()` (unref'd poll)
  / `stop()`; construction is side-effect-free. Uses ONLY `db.get`/`db.all`, every
  read wrapped try/catch (no `pool.connect()` → CAS deadlock structurally
  impossible).
- **Five read-only endpoints** (`telemetry/server.js`): `/api/selected/status`,
  `/api/selected/engines`, `/api/selected/context`, `/api/selected/contexts`,
  `/api/selected/context/:id` — always registered, each reports `selectedEnabled`.
- **Dashboard SELECTED tab** (`telemetry/public/index.html`): Polish-language UI
  showing discovered engines, per-signal opinions, consensus and the ranked
  intelligence package.

### Behavior / flags
- **`SELECTED_ENGINE`** (default **OFF**) gates ONLY the background refresh loop.
  OFF is a complete no-op: no timer, no builds, zero behavior change. The
  read-only endpoints are always registered and build DecisionContexts on demand
  regardless of the flag. `stop()` is wired into graceful shutdown for symmetry
  (harmless — the timer is already unref'd).

### Tests
- `telemetry/tests/unit/selectedRanking.test.js` — 10 pure tests (null-safety,
  no fabricated zero, tri-state consensus, full ranking key chain).
- `telemetry/tests/integration/selectedEngineManager.test.js` — end-to-end:
  auto-discovery of a brand-new Engine `E` with zero code, deterministic id,
  consensus, ring buffer, and a **"writes NOTHING"** row-count proof over
  `shadow_signals` / `shadow_engine_evals` / `knowledge_artifacts`.
- `telemetry/tests/integration/selectedFeatureFlag.test.js` — flag-OFF no-op,
  on-demand reads without `start()`, and `start()`/`stop()` idempotent lifecycle.
- All 21 pass; full `pnpm run typecheck` clean.

### Hardening — Pre-Push Review (2026-07-13)
Additive-only hardening to make the Selected Engine the permanent orchestration
layer. No trading path touched; still never trades / never writes / never
influences the Live Bot. `pnpm run typecheck` clean, 25/25 tests pass (+4 new).

- **Determinism fix (BUG):** the `expectancy:ALL` ranking record fed
  `freshness: tsMs(generated)` — wall-clock — into a ranking key. Changed to
  `freshness: null`. All other ranking freshness values are DB row `created_at`
  (stable per row), so ranking is now fully reproducible across restarts.
- **`RANKING_CRITERIA`** (`selected/ranking.js`): exported deep-frozen, ordered
  spec of the ranking key chain (Confidence → Expectancy → TrainingEvents →
  Version → Freshness → InputOrder). Win rate is deliberately absent. Embedded
  verbatim in every EvidenceTrace so downstream consumers can audit the ordering.
- **`schemaVersion: 1`** added to DecisionContext — an explicit contract version
  for the canonical event object (bump only on a breaking shape change).
- **EvidenceTrace** — an **immutable, reproducible** record on each
  DecisionContext: `{signalId, evalIds, engineIds, consensus summary,
  marketFingerprint, rankingCriteria (verbatim), records (ranked, EXCLUDING
  wall-clock freshness), artifacts, artifactVersions, snapshotChecksum,
  contextId, checksum}`. `checksum` is SHA-256 via `checksumValue` over
  `canonicalJson` (key-sorted, array-order-preserving) — identical inputs ⇒
  identical trace checksum across processes/restarts. Deep-frozen: tampering
  throws in strict mode. Shared structures (consensus arrays, marketFingerprint,
  artifactVersions) are COPIED into the basis so freezing the trace never freezes
  the live context references.
- **explainability** block — one stable read-only surface for decision rationale:
  `{selectedSources, selectionReason, confidenceChain, knowledgeVersions,
  evidenceSummary}` (evidenceSummary pins the trace checksum).
- `_emptyContext` updated for shape parity (`schemaVersion`, `evidenceTrace:null`,
  `explainability:null`).
- **Tests:** `RANKING_CRITERIA` shape/frozen unit test; integration coverage for
  `schemaVersion`, EvidenceTrace completeness/immutability/reproducibility, and
  explainability.

---

## Sprint 6 — Knowledge Manager Foundation (2026-07-12)

### Added
- **Knowledge schema** (`telemetry/migrations/006_knowledge_foundation.sql`):
  additive provenance + source-window columns (`run_id`, `build_id`,
  `config_hash`, `source_window_from/to`) on `knowledge_artifacts` (defined in
  `001`, 0 rows before this producer) via `ADD COLUMN IF NOT EXISTS`, plus a new
  append-first `knowledge_snapshots` manifest table keyed
  `dedupe_key = manifest_checksum`. Registered in `autoMigrate.js`. No
  `DROP`/`DELETE`/`TRUNCATE`.
- **Content-only checksum module** (`telemetry/managers/knowledgeProvenance.js`):
  `checksumValue` (SHA-256 over canonical, recursively key-sorted JSON of the
  artifact **content only** — provenance excluded), `canonicalJson`,
  `confidenceScore`/`confidenceLevel`, and `createProvenance().provenanceNote()`.
- **Immutable versioned store** (`telemetry/managers/KnowledgeRepository.js`):
  `upsertVersion` is a compare-and-set — unchanged content is a true no-op,
  changed content inserts a new version and supersedes the prior active row
  (`superseded_at` + `migration_from` chain) in one PG transaction;
  `insertSnapshot` records a dedupe-keyed manifest; plus `getActive`/`getVersion`/
  `getHistory`/`listActive`/`exportActive`/`statistics`/`listSnapshots`.
- **Knowledge builder** (`telemetry/managers/KnowledgeManager.js`): seven pure
  SQL aggregations over the `shadow_*` research tables → `expectancy/history`,
  `engines/statistics`, `patterns/validated`, `market/fingerprints`,
  `config/history`, `confidence/history`, `experiments/metadata`. `snapshotAll()`
  builds all seven, CAS-upserts each, then records the manifest. Lifecycle
  `start()` (unref'd 15-min poll) / `stop()`; construction is side-effect-free.
  Read APIs `getStatistics`/`getArtifact`/`listArtifacts`/`listSnapshots`/
  `exportAll`. Null-safe helpers honour the `Number(null) === 0` trap.
- **Five read-only endpoints** (`telemetry/server.js`): `/api/knowledge/status`,
  `/api/knowledge/artifacts`, `/api/knowledge/artifacts/:domain/:artifact`
  (`?version=` / `?history=1`), `/api/knowledge/snapshots`,
  `/api/knowledge/export` — always registered, each reports `knowledgeEnabled`.
- **Barrel export** (`telemetry/managers/index.js`): `KnowledgeManager`,
  `KnowledgeRepository`, `KNOWLEDGE_ARTIFACTS`.
- **Tests (27)**: `knowledgeProvenance` (7), `knowledgeMigration` (7),
  `knowledgeManager` (7), `knowledgeRecovery` (3), `knowledgeFeatureFlag` (3).

### Flag
- `KNOWLEDGE_LAYER` (default **off**): off = the builder never starts (complete
  no-op); on = the 15-min builder runs. Knowledge NEVER influences live/shadow/
  risk decisions — it reads only `shadow_*` research and writes only `knowledge_*`.

### Invariant (locked)
- **Artifact checksums are content-only.** Provenance lives in dedicated columns,
  never inside `value`. A restart (new `run_id`) rebuilding identical research
  mints **no** new version — knowledge accumulates, never churns. Proven by the
  recovery suite (different provenance → 0 changed, original provenance retained).

### Unchanged (constraints)
- `index.js` untouched (git diff empty). All DDL `IF NOT EXISTS`; CAS upsert +
  manifest dedupe are idempotent. Additive-only, reversible.

---

## Sprint 5 — Shadow LAB Foundation (2026-07-11)

### Added
- **Research schema** (`telemetry/migrations/005_shadowlab_foundation.sql`): four
  new tables — `shadow_signals`, `shadow_engine_evals`, `shadow_outcomes`,
  `shadow_expectancy_snapshots` — all `CREATE TABLE IF NOT EXISTS`, each carrying
  the provenance triple (`run_id`, `build_id`, `config_hash`) plus a `dedupe_key`
  and supporting indexes. Registered in `autoMigrate.js` so it auto-applies
  idempotently on startup. No `DROP`/`DELETE`/`TRUNCATE`.
- **Provenance module** (`telemetry/managers/shadowLabProvenance.js`):
  deterministic `configHash` (SHA-256 over canonical sorted-key JSON of the
  decision-relevant config surface + version), reproducible `resolveBuildId`
  (`<version>+<git-sha|unknown>`), per-process `runId`, `confidenceLevel` tiers
  (LOW <30, MEDIUM 30–100, HIGH >100), and `createProvenance().stamp()`.
- **Reconciler + expectancy** (`telemetry/managers/ShadowLabManager.js`): a
  cursor-based, idempotent, best-effort projector of the append-only `events`
  stream into the research tables (`trade_open → shadow_signals`,
  `lab_shadow_a/b/c/d → shadow_engine_evals`, `trade_close → shadow_outcomes`),
  plus `computeExpectancy`/`snapshotExpectancy`/`getExpectancy`/
  `getResearchSummary`/`getTimeseries`. Idempotent via `ON CONFLICT (dedupe_key)
  DO NOTHING`; resumable cursor persisted as an append-only `events` row.
- **Three read-only endpoints** (`telemetry/server.js`): `/api/lab/expectancy`,
  `/api/lab/research/summary`, `/api/lab/research/timeseries`, each reporting
  `researchEnabled`.
- **Verification suites** (23 new tests): `shadowLabProvenance.test.js` (9),
  `shadowLabManager.test.js` (7), `shadowLabExpectancy.test.js` (7). All green,
  plus the 4 Sprint 4.1 `autoMigrate` regression tests (27/27 total).

### Changed
- **`telemetry/managers/index.js`** barrel now exports the Shadow LAB research
  layer (`ShadowLabManager` + provenance helpers).
- **`telemetry/server.js`** gains the flag `SHADOW_LAB_RESEARCH` (default **off**);
  when off, the reconciler never starts and behaviour is unchanged. The three
  research endpoints are always registered and read-only.
- **`autoMigrate.test.js`** expected-tables set extended with the four new tables.

### Why
- Establishes a research-only measurement layer that reconciles the event stream
  into structured, fully-provenanced tables and computes trade expectancy —
  answering *"what is the system actually learning?"* — with **zero** changes to
  live trading. `index.js` (live Engine A/B/C/D decisions) is untouched (empty
  git diff); the whole layer is additive, append-first, idempotent, reversible,
  and gated behind a default-off flag.

---

## Sprint 4.1 — Production PostgreSQL Persistence (2026-07-11)

### Added
- **Startup auto-migration** (`telemetry/migrations/autoMigrate.js`):
  `ensureSchema(pool)` creates the full SHADOW OS v2 schema on boot,
  idempotently, with no `psql` dependency. Each migration file is executed as a
  single `pool.query(fileContents)` (pg simple protocol — parses multi-statement
  DDL including `DO $$ ... $$;` blocks, one implicit transaction per file). A
  `schema_migrations` table tracks applied files; a session advisory lock
  `(21320, 40911)` serializes concurrent migrators during redeploy overlap.
- **Verification suite** (`telemetry/tests/integration/autoMigrate.test.js`,
  4 tests): schema creation, idempotency (second run applies nothing), and
  data-safety (a sentinel row survives a simulated redeploy).

### Changed
- **LiveMemoryIntegration.init()** now runs `ensureSchema` after pool creation
  and before manager construction, gated on `_ownPool` (real startup runs it;
  tests injecting `_pool` skip it). Failure degrades to no-op — never blocks
  trading. `getStatus()` now includes the migration summary.
- **`/api/healthz/persistence`** now reports `persistence: true`, a `storage`
  descriptor, and the `memoryIntegration` status so PostgreSQL is confirmed
  active end-to-end.

### Why
- Railway production had no PostgreSQL service and no `DATABASE_URL`, so every
  deploy wiped all accumulated trading knowledge. After the operator attaches a
  Railway PostgreSQL service and redeploys, the schema is auto-created and all
  trading history, memory, snapshots and recovery data persist across deploys.
  No filesystem/volume solution was used; SQLite remains dev-only fallback.

---

## Sprint 4 — Live Memory Integration (2026-07-11)

### Added
- **LiveMemoryIntegration** (`telemetry/managers/LiveMemoryIntegration.js`):
  wires the Sprint 1–3 manager tier (RDM + TIM + MM) into the running Live
  Engine. Startup recovery pipeline: memory validation (quarantine, never
  delete) → latest VALID snapshot with checksum walk-back (skips corrupt
  snapshots, never deletes them) → domain/intent/memory recovery report →
  drift detection vs the replay-built live state (observe-only, logged to
  `consistency_log`) → dedupe-keyed SYSTEM_RECOVERY event → post_recovery
  snapshot.
- **Duplicate-startup protection**: pg session-scoped advisory lock on a
  dedicated client. A second process degrades to observe-only mode; SIGKILL
  frees the lock automatically (verified by cross-process tests).
- **Trade lifecycle hooks**: `recordTradeOpen` / `recordTradeClose` /
  `recordBotRestart` — all idempotent via `dedupe_key`, all best-effort
  (memory failure can NEVER block trading).
- **Periodic persistence** (`SHADOW_OS_PERSIST_MS`, default 5 min) and
  **bounded graceful shutdown**: flush in-flight writes (allSettled +
  timeout) → SYSTEM_SHUTDOWN event → final snapshot → lock release.
- **server.js integration** (first modification ever — additive, flag-gated
  by `SHADOW_OS_MEMORY`, default ON; `off` = zero behavior change including
  no signal handlers): startup hook after `restoreLiveState()`, trade
  open/close stdout-branch hooks, bot-restart-loop hook, SIGTERM/SIGINT
  graceful shutdown with a hard 5s exit deadline (Railway redeploys can
  never hang), `GET /api/memory-integration/status` monitoring endpoint.
- **Test suites** (21 new tests, all passing): integration (18 — recovery
  lifecycle, snapshot validation/tamper/walk-back, quarantine, drift,
  idempotency, 2 000-event large history, shutdown flush, redeploy
  simulation) and cross-process stress (3 — two-OS-process duplicate
  startup, concurrent recovery race, SIGKILL power loss) plus 3 drivers in
  `telemetry/tests/drivers/`.

### Changed
- `telemetry/server.js` — first and only production-brain modification of
  the migration; every hook is flag-gated and try/catch-wrapped.
  `index.js` remains FROZEN, untouched.
- `telemetry/managers/index.js` — barrel now exports LiveMemoryIntegration
  (+ LOCK_CLASS/LOCK_OBJ/OPEN_INTENT_STATUSES/SNAPSHOT_WALKBACK_LIMIT).

### Verification
- 417/417 tests passing (396 baseline + 21 new). Zero regressions.
- Sacred Constraint: corrupt snapshots and memories are quarantined/skipped,
  never deleted; recovery is strictly read-then-append.

---

## Sprint 3 — Memory Foundation (2026-07-07)

### Added
- **Migration 004** (`telemetry/migrations/004_memory_foundation.sql`):
  `memory_events` (permanent append-first event memory) and
  `memory_event_history` (append-only full-row audit snapshots).
  `memory_entries` untouched — retained as KV/TTL working cache. 14 tables total.
- **MemoryManager** (`telemetry/managers/MemoryManager.js`): full 13-method
  Sprint 3 spec — createMemory, appendMemory, updateMemory, archiveMemory,
  restoreMemory, searchMemory, queryByDomain/Trade/Time/Strategy, tagMemory,
  summarizeMemory, validateMemory — plus KV cache surface
  (kvSet/kvGet/kvGetAll/kvGc) and getMemory/getMemoryHistory/getStats/ping.
- **Test suites** (101 new tests, all passing):
  `telemetry/tests/unit/MemoryManager.test.js` (60),
  `telemetry/tests/integration/mm_integration.test.js` (11),
  `telemetry/tests/integration/mm_rdm_tim_integration.test.js` (7),
  `telemetry/tests/simulation/mm_persistence.test.js` (9),
  `telemetry/tests/stress/mm_stress.test.js` (14).
- `telemetry/managers/index.js` barrel now exports MemoryManager.

### Changed
- **RuntimeDomainManager.takeSnapshot(reason, { memorySummary })** — additive,
  backwards-compatible: stores a provided `summarizeMemory()` result in
  `system_snapshots.memory_summary` (placeholder when absent).
- `telemetry/migrations/run.js` — migration 004 added; EXPECTED_TABLES now 14.
- `docs/architecture/MASTER_ARCHITECTURE.md` §6.2 rewritten to the as-built
  two-table memory design; status tables updated.

### Fixed
- **CAS pool deadlock in `createMemory()` dedupe path** (found by STRESS-2,
  invisible to sequential tests): the duplicate lookup acquired a second pool
  connection while still holding one. Fixed by reusing the held client.

### Verification
- 396/396 tests passing across Sprints 0–3. Zero regressions.
- Sacred Constraint: 0 rows deleted (29 events, 1 shadowm_trade preserved);
  no DELETE path for `memory_events`/`memory_event_history` in any MM method.

---

## Sprint 2 — Intent Foundation (2026-07-07)

### Added
- **Migration 003** (`telemetry/migrations/003_trade_intent_v2.sql`): 17 new
  `trade_intents` columns, lifecycle CHECK constraints, 5 indexes, and the
  append-only `trade_intent_history` table.
- **TradeIntentManager** (`telemetry/managers/TradeIntentManager.js`): full
  intent lifecycle CREATED→VALIDATED→APPROVED→EXECUTED→ARCHIVED (plus
  REJECTED/CANCELLED), SELECT FOR UPDATE atomicity, idempotent createIntent,
  best-effort RDM integration.
- **Test suites** (169 new tests, all passing): unit (89), integration (22),
  TIM×RDM integration (10), simulation (27), stress (21).
- `telemetry/managers/index.js` barrel created (RDM + TIM).

### Verification
- 295/295 tests passing across Sprints 0–2 at completion. Zero regressions.

---

## Sprint 1 — Runtime Awakening (2026-07-06)

### Added
- **Migration 002**: `runtime_domain_history` table.
- **RuntimeDomainManager** (`telemetry/managers/RuntimeDomainManager.js`):
  exclusive owner of `runtime_domains` — CRUD, compareAndSwap, snapshots,
  restore/rollback, history, consistency logging and checks.
- **Test suites** (107 tests): unit (65), integration (16), simulation (14),
  stress (12).

---

## Sprint 0 — Foundation (2026-07-05)

### Added
- **Migration 001**: 10-table SHADOW OS v2 schema (idempotent DDL).
- Migration runner (`telemetry/migrations/run.js`) using `psql -f`.
- Test framework on `node:test` (Node 24, `--test-reporter=spec`).
- Schema + smoke test suites (19 tests).

### Changed
- Dead code moved to `archive/` with preserved git history.
