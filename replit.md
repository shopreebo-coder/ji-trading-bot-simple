# FOREX ENGINE PRO — SHADOW OS v2 Migration

Live OANDA forex trading bot on Railway. Currently executing the SHADOW OS v2 migration program to replace the monolithic server.js with an event-sourced, domain-manager architecture.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `index.js` — FROZEN. Production entrypoint (2360L). Never modify.
- `telemetry/server.js` — Main bot orchestrator (2997L). Current production brain.
- `telemetry/shadowm.js` — Shadow M trade tracker (718L)
- `telemetry/shadowlab.js` — ShadowLab exit strategy engines (1094L)
- `telemetry/db-adapter.js` — PostgreSQL/SQLite abstraction layer
- `telemetry/index.js` — Telemetry HTTP server
- `telemetry/migrations/` — Schema migration scripts + runner
- `telemetry/tests/` — Test suite (node:test built-in)
- `archive/` — Dead code with preserved git history (never delete)
- `SHADOW_OS_V2.md` — Master design document (3000+ lines)
- `IMPLEMENTATION_BLUEPRINT.md` — Phase specs and gate criteria
- `SPRINT_0_REPORT.md` — Sprint 0 completion report
- `telemetry/managers/TradeIntentManager.js` — Sprint 2 core implementation (~600L)
- `telemetry/managers/MemoryManager.js` — Sprint 3 core implementation (append-first memory layer)
- `telemetry/managers/LiveMemoryIntegration.js` — Sprint 4: wires RDM+TIM+MM into server.js (recovery, hooks, shutdown)
- `telemetry/managers/index.js` — Manager tier barrel export (RDM + TIM + MM + LMI + ShadowLab research layer + Knowledge layer)
- `telemetry/managers/ShadowLabManager.js` — Sprint 5 research-only measurement layer (event→research reconciler + expectancy)
- `telemetry/managers/shadowLabProvenance.js` — Sprint 5 provenance (config_hash, build_id, run_id, confidence tiers)
- `telemetry/migrations/005_shadowlab_foundation.sql` — Sprint 5 schema migration (4 research tables: shadow_signals, shadow_engine_evals, shadow_outcomes, shadow_expectancy_snapshots)
- `telemetry/managers/KnowledgeManager.js` — Sprint 6 read-only knowledge layer (7 SQL-aggregation builders over shadow_* → versioned artifacts + manifest snapshots)
- `telemetry/managers/KnowledgeRepository.js` — Sprint 6 immutable versioned store (content-addressed CAS upsert + supersede chain + manifest snapshot + read APIs)
- `telemetry/managers/knowledgeProvenance.js` — Sprint 6 content-ONLY checksum (canonical key-sorted JSON) + provenance triple + confidence score
- `telemetry/migrations/006_knowledge_foundation.sql` — Sprint 6 schema migration (provenance cols on knowledge_artifacts + new knowledge_snapshots manifest table)
- `telemetry/managers/TelemetryReconciler.js` — Sprint 7.2 telemetry-only OANDA close reconciler: polls `GET /trades?state=CLOSED` (unref'd 60s, GET-only, never throws), emits synthetic `trade_close` (`synthetic:true`, `captureMethod:"oanda_reconciler"`, `oandaTradeId`, `realizedPL`, honest nulls for bot-only fields) for every OANDA-side close the bot missed (TP/SL incl. v39.4 MFE-floor SL, manual, margin, bot-down closes). Dedupe: oandaTradeId exact → signalId-first (recovered from trade_open symbol+openTime±180s) → symbol+closeTime±90s consumed 1:1. Grace 3 min (fire-and-forget logEvent) + first-run baseline=NOW (no backfill). Cursor: `telemetry_reconciler_cursor` events rows. Flag `TELEMETRY_RECONCILER` default ON (`off` = kill switch). Endpoint: `GET /api/telemetry/health` (always registered) — expected/captured/missing/completeness% + native/synthetic breakdown. Report v2: TELEMETRY HEALTH section after PIPELINE HEALTH. The two pipeline-audit "OANDA SL/TP not captured" warnings are now dynamic on the flag.
- `telemetry/managers/SelectedAdvisor.js` — ADVISOR-ONLY bridge: live trade open (stdout) → delayed signalId recovery (read-only events SELECT, 120s stale guard, 10s/25s/60s unref'd retries) → `buildDecisionContext({signalId})` → in-memory advisory ring (100). Flag `SELECTED_ADVISOR` default ON (`off` = kill switch). New endpoint: `GET /api/selected/advisories`. NEVER writes DB, NEVER throws into the trading path. Sprint 7 F1 (additive fields per advisory): normalized `status` OK/NOT_AVAILABLE/ERROR (detailed `advisor.status` kept), `selectedRankingTop3` (mirror of kept `selectedRanking`), `knowledgeVersion`/`knowledgeSnapshot` (ctx.metadata → explainability.knowledgeVersions fallback), `marketFingerprint`, `selectedDecisionTime` (ISO) + `decisionLatencyMs`.
- `telemetry/managers/selected/ranking.js` — Selected Engine PURE core (null-safe coercion, tri-state consensus, `rankIntelligence` by Confidence→Expectancy→TrainingEvents→ArtifactVersion→SnapshotFreshness, exported deep-frozen `RANKING_CRITERIA` spec). No I/O.
- `telemetry/managers/selected/enginePlugins.js` — Selected Engine auto-discovery (`DISTINCT engine_id` → generic `RecordedEvalAdapter`, ZERO hardcoded engine names) + optional fs-scanned custom plugin dir
- `telemetry/managers/SelectedEngineManager.js` — Selected Engine READ-ONLY orchestrator (buildDecisionContext → versioned DecisionContext with `schemaVersion`, deterministic id, deep-frozen reproducible `evidenceTrace` + `explainability`, ring buffer, unref'd poll; only db.get/db.all; never trades, never writes)
- `telemetry/tests/drivers/` — cross-process test drivers (spawned as separate OS processes; never spawn server.js)
- `telemetry/migrations/003_trade_intent_v2.sql` — Sprint 2 schema migration
- `telemetry/migrations/004_memory_foundation.sql` — Sprint 3 schema migration (memory_events + memory_event_history)
- `telemetry/migrations/autoMigrate.js` — Sprint 4.1 startup auto-migration (`ensureSchema`) — pg-native, idempotent, no `psql` dependency
- `CHANGELOG.md` — Sprint-by-sprint change log
- `telemetry/public/index.html` — Dashboard (Babel-standalone JSX single file). EXPORT tab: "AI Complete Analysis Report v2" (`buildReportV2()` + `generateReport()`) — client-side-only .txt report assembled from 33 read-only GET endpoints (LIVE BOT / SHADOW LAB / KNOWLEDGE LAYER / SELECTED ENGINE / SELECTED ADVISOR ANALYSIS / PIPELINE HEALTH / rule-based AI SUMMARY incl. "WOULD SELECTED HAVE HELPED?" — Sprint 7 F1: joins closed trades with OK advisories by signalId, retrospective filter only, no simulated entries). Sprint 6.2: `safe()` retries transient 5xx/network errors (600/1800 ms backoff, 404 = expected-absent, no retry, no failure) and `fetchLimited()` caps fetch concurrency at 2–3 per phase (shared pg pool max=10 with the live bot — never restore full-parallel `Promise.all`). Shared `knActiveCount`/`knDomains` derivation keeps ACTIVE ARTIFACTS / PIPELINE HEALTH / AI SUMMARY consistent when one knowledge endpoint fails. Previous-report comparison baseline in localStorage `forex_ai_report_v2_prev`; `generateSnapshot()` untouched

## Architecture decisions

- **Contract-first DB schema:** All schema changes go through `telemetry/migrations/` SQL files. Manual runs use `psql -f` (`run.js`). At startup on Postgres they auto-apply idempotently via `telemetry/migrations/autoMigrate.js` (`ensureSchema`), which sends each whole file to `pool.query()` (pg simple protocol) so Postgres parses multi-statement DDL incl. `DO $$` blocks. Never use a JS SQL splitter for multi-statement DDL — it fails silently.
- **db-adapter quirk:** `db.run()` auto-appends `RETURNING id` to INSERT statements. For tables whose PK is not `id` (e.g. `runtime_domains` with PK=`domain`), use `db.exec()` instead.
- **FROZEN entrypoint:** `index.js` must never be modified. `telemetry/server.js` was FROZEN through Sprint 3; as of Sprint 4 it carries additive, flag-gated memory hooks (`SHADOW_OS_MEMORY`, default on; `off` = zero behavior change, no signal handlers). Every hook is best-effort try/catch — memory failure can never block trading.
- **Sacred constraint:** No deployment, restart, or migration step may ever destroy the accumulated trading knowledge of the system.
- **Test runner flag:** Node 24 uses `--test-reporter=spec` (not `--reporter=spec`).

## Product

Live OANDA forex trading bot executing trades on EUR/USD, GBP/USD and other pairs. Uses a multi-shadow-engine architecture: ShadowA (signal filter), ShadowB (confirmation), ShadowC (KNN strategy selector), ShadowD (condition weighting), ShadowM (trade tracker), ShadowLab (exit optimization).

## Migration Status

| Sprint | Objective                              | Status       |
|--------|----------------------------------------|--------------|
| 0      | Archive dead code, test framework, DB schema | ✅ COMPLETE |
| 1      | RuntimeDomainManager                   | ✅ COMPLETE  |
| 2      | Domain Adapters (TradeIntentManager)   | ✅ COMPLETE  |
| 3      | MemoryManager                          | ✅ COMPLETE  |
| 4      | Live Memory Integration (LMI → server.js) | ✅ COMPLETE |
| 4.1    | Production PostgreSQL persistence (auto-migrate on startup) | ✅ COMPLETE |
| 5      | Shadow LAB Foundation (research-only measurement layer) | ✅ COMPLETE |
| 6      | KnowledgeManager (read-only knowledge layer) | ✅ COMPLETE |
| 7      | RecoveryManager + ValidationManager    | Not started  |
| 7 F1   | Smart Decision Integration (observational advisor telemetry + report) | ✅ COMPLETE |
| 7.1    | Stabilization (insights/weak-relaxed crash fix + rejection guard + validation) | ✅ COMPLETE |
| 7.2    | Telemetry Completeness (OANDA close reconciler + /api/telemetry/health + report section) | ✅ COMPLETE |
| SEL    | Selected Engine (read-only intelligence orchestration) | ✅ COMPLETE |

## User preferences

- `index.js` is FROZEN — never modify under any circumstances.
- git push to GitHub must be done from the Shell by the user (agent git push times out).
- Remote: https://github.com/shopreebo-coder/ji-trading-bot-simple.git

## Gotchas

- **Never use a JS regex-based SQL splitter for multi-statement DDL** — use `psql -f` via `execSync` instead. JS splitters silently drop statements.
- **Startup migrations (Railway, where `psql` may be absent):** run each whole `.sql` file through `pool.query(fileContents)` (node-postgres simple protocol). Postgres parses statement boundaries — including `DO $$ … $$;` blocks — as one implicit transaction per file. This is NOT a JS splitter and is the safe pg-native path used by `autoMigrate.js`.
- **`events` table has two definers:** `telemetry/index.js` `_initSchema` (`data TEXT`) and migration `001` (`data JSONB`). Whichever `CREATE TABLE IF NOT EXISTS` runs first wins; on a fresh boot `_initSchema` wins, so prod `events.data` is TEXT. Harmless today (no JSONB operators used on it) — reconcile the two before adding any.
- **`db.run()` adds `RETURNING id`** — breaks on tables with non-id primary keys.
- **`git mv` is blocked** in the Replit main agent. Use plain `mv` + let git detect the rename.
- **`ANY($1)` with a JS array parameter** returns 0 rows in pg — fetch all rows and filter in JS instead.
- **`node --test --reporter=spec`** is wrong in Node 24. Use `--test-reporter=spec`.
- **`git push` times out** from the agent. User must push from the Shell.
- **Multi-file `node --test` runs need `--test-concurrency=1`** — files run concurrently by default, and `mm_persistence` uses `pg_terminate_backend`, which kills other suites' connections mid-test.
- **`smoke.test.js` hangs the process after all tests pass** (db-adapter pool never closes — pre-existing since Sprint 0). A file-level timeout with `pass N / fail 0` is the expected outcome.
- **`Number(null) === 0` coercion trap:** a numeric coercion helper that does `Number(x)` turns `null`/`undefined`/`""` into a real `0`, silently fabricating data (e.g. an abstaining engine's "no winrate" becomes a `0` winrate). Guard for null/undefined/"" and return `null` first; keep boolean coercion tri-state (`true`/`false`/`null`) so engine abstention (`would_trade IS NULL`) is never coerced to `false`.
- **CAS pool deadlock:** In a method that holds a pg pool client, never call another method that calls `pool.connect()` inside the same try/finally block — `finally { client.release() }` runs after `return` resolves, so both connections are held simultaneously. With pool.max=N and N concurrent callers, this deadlocks permanently. Fix: read all needed DB state using the already-held client, then release. This passes sequential tests but deadlocks under concurrent load.
- **Knowledge artifact checksum is CONTENT-ONLY** (Sprint 6, locked invariant): provenance (`run_id`/`build_id`/`config_hash`) lives in dedicated `knowledge_artifacts` columns, NEVER inside `value`. A builder that embeds ANY provenance-coupled field in its content churns a spurious new artifact version on every restart (new `run_id`). Two builders were fixed for this during Sprint 6 (config/history embedded `config_hash`+`isCurrent`). Recovery test proves: different run/build/config rebuilding identical research → 0 changed, original provenance retained.
- **Dashboard fetch helpers and HTTP-error JSON bodies:** the report's `safe()` checks `r.ok` (non-2xx → `null`/N/A; 404 excluded from FAILURES — it's the expected "artifact not built" contract). The global `api()` helper deliberately does NOT check `r.ok` — changing it risks regressions in every tab that reads `{ok:false}` JSON bodies; consequence: a proxy 502-JSON during Generate Snapshot embeds the error object in the snapshot JSON (harmless, no crash). Guard array consumers with `Array.isArray` instead.
- **`/api/trades` pairs close→open by symbol + first `close.ts >= open.ts`** — without consuming matched closes or checking signalId, so with overlapping trades on one symbol a close can attach to the wrong open (or to several). Any consumer joining trades to per-signal data must verify `close.signalId === open.signalId` when the close carries one (the report's "WOULD SELECTED HAVE HELPED?" join does).
- **Express 4 async handlers + no rejection guard = process death (Sprint 7.1):** `server.js` is the SUPERVISOR that spawns the live bot; Express 4 gives async route handlers zero error propagation, so any rejected handler promise became an `unhandledRejection` that killed the whole process on Node ≥15 (and Railway `restartPolicyMaxRetries=10` stops restarting after 10 crashes). Two such bugs existed: `.filter()` called directly on the Promise from `queryEvents()` in `/api/insights` and `/api/weak-relaxed` — a **two-line** statement that single-line greps miss (use multiline grep `await \w+\([^;]*\)\s*\n\s*\.` to sweep). Always `(await queryEvents(...)).filter(...)`. A log-only `process.on("unhandledRejection")` guard now backstops the supervisor — keep it log-only, never exit.
- **TelemetryReconciler 50-close cap:** OANDA `GET /trades?state=CLOSED&count=50` returns the NEWEST 50 — after a multi-day outage with >50 closes past baseline, the oldest missed closes are unrecoverable (accepted; covers MAX_DAILY_TRADES=50 for outages under ~1 day). Time-window consumption is persisted via `consumedEventIds` in cursor rows (restored on restart) — never revert to a per-poll Set (silent close loss). `/api/telemetry/health` completeness is `null` (UNKNOWN) when the reconciler is dormant — never a fake 100%.
- **`ShadowLabManager.reconcileAll()` appends an expectancy snapshot whenever trades resolve** — so adding a resolved signal legitimately bumps the `expectancy/history` knowledge artifact. Do NOT assert "unchanged research artifact" after resolving a trade; idempotency is only guaranteed for genuinely unchanged content.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `SHADOW_OS_V2.md` for the full v2 architecture design
- See `docs/reports/SPRINT_0_REPORT.md` for Sprint 0 findings and gate results
- See `docs/reports/SPRINT_1_REPORT.md` (+ `.pdf`) for Sprint 1 findings and gate results
- See `docs/architecture/MASTER_ARCHITECTURE.md` (+ `.pdf`) for the SHADOW OS v2 single source of truth
- See `telemetry/managers/RuntimeDomainManager.js` for the Sprint 1 core implementation
- See `docs/reports/SPRINT_3_REPORT.md` (+ `.pdf`) for Sprint 3 findings and gate results
- Run all Sprint 1 tests: `node --test --test-reporter=spec telemetry/tests/unit/RuntimeDomainManager.test.js telemetry/tests/integration/rdm_integration.test.js telemetry/tests/simulation/rdm_simulation.test.js telemetry/tests/stress/rdm_stress.test.js`
- Run all Sprint 3 tests: `node --test --test-reporter=spec --test-concurrency=1 telemetry/tests/unit/MemoryManager.test.js telemetry/tests/integration/mm_integration.test.js telemetry/tests/integration/mm_rdm_tim_integration.test.js telemetry/tests/simulation/mm_persistence.test.js` then separately `node --test --test-reporter=spec telemetry/tests/stress/mm_stress.test.js` (stress suite kills idle DB connections — never run it in the same process group as other suites)
- See `docs/reports/SPRINT_4_REPORT.md` (+ `.pdf`) for Sprint 4 findings and gate results
- Run Sprint 4 tests: `node --test --test-reporter=spec telemetry/tests/integration/mi_integration.test.js` then separately `node --test --test-reporter=spec telemetry/tests/stress/mi_process.test.js` (spawns extra OS processes for lock/crash scenarios)
- See `docs/reports/SPRINT_4_1_REPORT.md` (+ `.pdf`) for Sprint 4.1 (production PostgreSQL persistence) findings and gate results
- Run Sprint 4.1 test: `node --test --test-reporter=spec telemetry/tests/integration/autoMigrate.test.js`
- See `docs/reports/SPRINT_5_REPORT.md` (+ `.pdf`) for Sprint 5 (Shadow LAB Foundation) findings and gate results
- Run Sprint 5 tests: `node --test --test-reporter=spec --test-concurrency=1 telemetry/tests/unit/shadowLabProvenance.test.js telemetry/tests/integration/shadowLabManager.test.js telemetry/tests/integration/shadowLabExpectancy.test.js`
- Sprint 5 flag: `SHADOW_LAB_RESEARCH` (default OFF) gates the research reconciler. Read-only endpoints: `/api/lab/expectancy`, `/api/lab/research/summary`, `/api/lab/research/timeseries` (always registered; report `researchEnabled`)
- See `docs/reports/SPRINT_6_REPORT.md` (+ `.pdf`) for Sprint 6 (Knowledge Manager Foundation) findings and gate results
- Run Sprint 6 tests: `node --test --test-reporter=spec --test-concurrency=1 telemetry/tests/unit/knowledgeProvenance.test.js telemetry/tests/integration/knowledgeMigration.test.js telemetry/tests/integration/knowledgeManager.test.js telemetry/tests/integration/knowledgeRecovery.test.js telemetry/tests/integration/knowledgeFeatureFlag.test.js`
- Sprint 6 flag: `KNOWLEDGE_LAYER` (default OFF) gates the knowledge builder (unref'd 15-min poll). Read-only endpoints: `/api/knowledge/status`, `/api/knowledge/artifacts`, `/api/knowledge/artifacts/:domain/:artifact` (`?version=`/`?history=1`), `/api/knowledge/snapshots`, `/api/knowledge/export` (always registered; report `knowledgeEnabled`)
- Run Selected Engine tests: `node --test --test-reporter=spec --test-concurrency=1 telemetry/tests/unit/selectedRanking.test.js telemetry/tests/integration/selectedEngineManager.test.js telemetry/tests/integration/selectedFeatureFlag.test.js`
- Run Selected Advisor tests: `node --test --test-reporter=spec telemetry/tests/unit/SelectedAdvisor.test.js` (pure in-memory, no DB needed)
- Run Sprint 7.2 tests: `node --test --test-reporter=spec --test-concurrency=1 telemetry/tests/integration/telemetryReconciler.test.js` (mock OANDA client, no network; needs PG)
- Sprint 7.2 flag: `TELEMETRY_RECONCILER` (default ON; `off` = kill switch, pre-7.2 behavior). OPERATIONAL: synthetic closes require OANDA creds in the server env; without them the reconciler is dormant and `/api/telemetry/health` serves DB-only counters. Baseline pins scope to first deployment — pre-7.2 history is never backfilled. Synthetic `trade_close` carries `signalId` when recoverable (else null → ShadowM symbol-fallback path, same as post-restart native closes).
- Selected Advisor flag: `SELECTED_ADVISOR` (default ON; `off` = complete no-op, prior behavior exactly). OPERATIONAL: meaningful advisories require `SHADOW_LAB_RESEARCH=on` in prod — with research off, `shadow_signals` is never populated and every advisory is an `EMPTY_CONTEXT` stub (harmless, a few read-only SELECTs per trade).
- Selected Engine flag: `SELECTED_ENGINE` (default OFF) gates ONLY the background refresh loop (unref'd poll); OFF is a complete no-op. Read-only endpoints build DecisionContexts on demand regardless of the flag: `/api/selected/status`, `/api/selected/engines`, `/api/selected/context` (`?signalId=`), `/api/selected/contexts`, `/api/selected/context/:id` (always registered; report `selectedEnabled`). Engines are AUTO-DISCOVERED (`DISTINCT engine_id`) — adding Engine E/F/G = zero code changes. Read-only: never trades, never writes.
- Selected Engine DecisionContext (post-hardening) carries `schemaVersion` (contract v1), a deep-frozen reproducible `evidenceTrace` (sha256 `checksum` over content only — NO wall-clock/freshness — so identical DB rows ⇒ identical checksum across restarts), and an `explainability` block. Determinism gotcha: never feed `freshness` derived from `generated`/`Date.now()` into a ranking record (the `expectancy:ALL` record must use `freshness: null`); DB-row `created_at` freshness is fine as a ranking input but is excluded from the trace. deepFreeze gotcha: COPY consensus arrays / `marketFingerprint` / `artifactVersions` into the trace basis before freezing — they are shared with `ctx.consensusDetail`/`explainability`, else a future strict-mode mutation throws.
