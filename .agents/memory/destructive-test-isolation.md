---
name: Destructive test suite isolation
description: Test suites that terminate idle DB backends break parallel test processes silently — run them separately and capture output to a file.
---

Any test that calls `pg_terminate_backend()` on idle connections (crash/persistence sims, pool-recovery stress tests) will kill the pool clients of OTHER test files running in the same `node --test` invocation or process group.

**Symptom:** the combined run dies silently — bash exit code -1, no output at all. Nothing points at the killer test.

**Why:** `pg_terminate_backend` on `pid <> pg_backend_pid()` matches every idle client in the database, not just the current file's pool. Node's test runner runs files in parallel processes sharing the same DB.

**How to apply:**
- Run destructive suites in a separate `node --test` invocation, never combined with other suites.
- Always wrap in `timeout N node --test ... > /tmp/x.log 2>&1` then read the log — the exit code is unreliable, the log shows the real pass/fail.
- Document the split in the canonical "run all tests" command (see replit.md pointers).
- Related: processes that hold a db-adapter connection open can also hang after all tests pass — a `-1` exit with an all-green log is benign; trust the log.
