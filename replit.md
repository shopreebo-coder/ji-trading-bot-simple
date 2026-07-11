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
- `telemetry/managers/index.js` — Manager tier barrel export (RDM + TIM + MM + LMI + ShadowLab research layer)
- `telemetry/managers/ShadowLabManager.js` — Sprint 5 research-only measurement layer (event→research reconciler + expectancy)
- `telemetry/managers/shadowLabProvenance.js` — Sprint 5 provenance (config_hash, build_id, run_id, confidence tiers)
- `telemetry/migrations/005_shadowlab_foundation.sql` — Sprint 5 schema migration (4 research tables: shadow_signals, shadow_engine_evals, shadow_outcomes, shadow_expectancy_snapshots)
- `telemetry/tests/drivers/` — cross-process test drivers (spawned as separate OS processes; never spawn server.js)
- `telemetry/migrations/003_trade_intent_v2.sql` — Sprint 2 schema migration
- `telemetry/migrations/004_memory_foundation.sql` — Sprint 3 schema migration (memory_events + memory_event_history)
- `telemetry/migrations/autoMigrate.js` — Sprint 4.1 startup auto-migration (`ensureSchema`) — pg-native, idempotent, no `psql` dependency
- `CHANGELOG.md` — Sprint-by-sprint change log

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
| 6      | KnowledgeManager                       | Not started  |
| 7      | RecoveryManager + ValidationManager    | Not started  |

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
