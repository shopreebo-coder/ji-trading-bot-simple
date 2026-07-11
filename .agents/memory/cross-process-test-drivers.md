---
name: Cross-process test drivers
description: Lessons for node:test suites that spawn real second OS processes (lock holders, crash targets) against a shared Postgres DB.
---

# Cross-process test drivers

Rules learned while building multi-process lock/crash test suites (advisory locks, SIGKILL power-loss scenarios) with `node --test` and Postgres.

- **A driver must await its first durable write BEFORE signaling READY.** If the parent SIGKILLs the driver right after READY, an un-awaited write may never reach the DB and the "durability after crash" assertion fails flakily.
  **Why:** SIGKILL can land between stdout READY and the first commit.
- **Reap every spawned driver in try/finally.** A leaked lock-holder process poisons every later test that needs the lock. Same for any per-test manager instance holding a pool — shut it down in `finally` or the open pool hangs the file until timeout.
- **Parse driver output with a match regex, not "first line".** Module logging pollutes stdout; have the driver print a unique prefix (e.g. `RESULT {json}`) and grep for it.
- **Drivers that race for a lock need a retry loop** (e.g. 20×500ms) — process startup order is nondeterministic.
- **Never spawn the production server entrypoint from a test** if it launches live side effects (here: the live trading bot). Test the integration module directly via small driver scripts.
- **Multi-file `node --test` runs default to concurrent files.** Any suite using `pg_terminate_backend` kills other suites' connections — always pass `--test-concurrency=1` for grouped runs, and run backend-killing stress suites in a separate process invocation.
