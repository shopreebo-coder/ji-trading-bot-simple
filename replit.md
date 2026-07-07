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

## Architecture decisions

- **Contract-first DB schema:** All schema changes go through `telemetry/migrations/` SQL files run via `psql -f`. Never use a JS SQL splitter for multi-statement DDL — it fails silently.
- **db-adapter quirk:** `db.run()` auto-appends `RETURNING id` to INSERT statements. For tables whose PK is not `id` (e.g. `runtime_domains` with PK=`domain`), use `db.exec()` instead.
- **FROZEN entrypoint:** `index.js` and its production start chain (`node telemetry/server.js` via railway.json) must never be modified. All SHADOW OS v2 work is additive.
- **Sacred constraint:** No deployment, restart, or migration step may ever destroy the accumulated trading knowledge of the system.
- **Test runner flag:** Node 24 uses `--test-reporter=spec` (not `--reporter=spec`).

## Product

Live OANDA forex trading bot executing trades on EUR/USD, GBP/USD and other pairs. Uses a multi-shadow-engine architecture: ShadowA (signal filter), ShadowB (confirmation), ShadowC (KNN strategy selector), ShadowD (condition weighting), ShadowM (trade tracker), ShadowLab (exit optimization).

## Migration Status

| Sprint | Objective                              | Status       |
|--------|----------------------------------------|--------------|
| 0      | Archive dead code, test framework, DB schema | ✅ COMPLETE |
| 1      | RuntimeDomainManager                   | ✅ COMPLETE  |
| 2      | Domain Adapters (TradeIntentManager)   | 🔜 NEXT      |
| 3      | MemoryManager                          | Not started  |
| 4      | KnowledgeManager                       | Not started  |
| 5      | RecoveryManager + ValidationManager    | Not started  |

## User preferences

- `index.js` is FROZEN — never modify under any circumstances.
- git push to GitHub must be done from the Shell by the user (agent git push times out).
- Remote: https://github.com/shopreebo-coder/ji-trading-bot-simple.git

## Gotchas

- **Never use a JS regex-based SQL splitter for multi-statement DDL** — use `psql -f` via `execSync` instead. JS splitters silently drop statements.
- **`db.run()` adds `RETURNING id`** — breaks on tables with non-id primary keys.
- **`git mv` is blocked** in the Replit main agent. Use plain `mv` + let git detect the rename.
- **`ANY($1)` with a JS array parameter** returns 0 rows in pg — fetch all rows and filter in JS instead.
- **`node --test --reporter=spec`** is wrong in Node 24. Use `--test-reporter=spec`.
- **`git push` times out** from the agent. User must push from the Shell.
- **CAS pool deadlock:** In a method that holds a pg pool client, never call another method that calls `pool.connect()` inside the same try/finally block — `finally { client.release() }` runs after `return` resolves, so both connections are held simultaneously. With pool.max=N and N concurrent callers, this deadlocks permanently. Fix: read all needed DB state using the already-held client, then release. This passes sequential tests but deadlocks under concurrent load.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `SHADOW_OS_V2.md` for the full v2 architecture design
- See `docs/reports/SPRINT_0_REPORT.md` for Sprint 0 findings and gate results
- See `docs/reports/SPRINT_1_REPORT.md` (+ `.pdf`) for Sprint 1 findings and gate results
- See `docs/architecture/MASTER_ARCHITECTURE.md` (+ `.pdf`) for the SHADOW OS v2 single source of truth
- See `telemetry/managers/RuntimeDomainManager.js` for the Sprint 1 core implementation
- Run all Sprint 1 tests: `node --test --test-reporter=spec telemetry/tests/unit/RuntimeDomainManager.test.js telemetry/tests/integration/rdm_integration.test.js telemetry/tests/simulation/rdm_simulation.test.js telemetry/tests/stress/rdm_stress.test.js`
