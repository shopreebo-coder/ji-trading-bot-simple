# SHADOW OS v2 — Test Framework

## Running Tests

```bash
# All tests (from workspace root)
node --test telemetry/tests/unit/*.test.js

# Single file
node --test telemetry/tests/unit/smoke.test.js

# With verbose output (Node 24 flag)
node --test --test-reporter=spec telemetry/tests/unit/smoke.test.js
```

## Structure

```
telemetry/tests/
  unit/          Unit tests per manager module (no external services)
  integration/   Integration tests (require DB, may require mock OANDA)
  stress/        Performance benchmarks (require large DB fixture)
  mocks/         Shared mock factories (mock DB, mock OANDA client)
  README.md      This file
```

## Naming Convention

- Files: `<module-name>.test.js`
- Tests: plain English description of the behavior
- Mocks: `telemetry/tests/mocks/<service>-mock.js`

## Environment

Tests use `DATABASE_URL` from the environment (same as production).
Integration tests that write to DB use a `test_` prefix on all test data
and clean up after themselves.

Never run stress tests against production during trading hours.

## Adding a Test

1. Create `telemetry/tests/unit/<manager>.test.js`
2. Import `node:test` and `node:assert`
3. Write tests using `describe` + `it` blocks
4. Run with `node --test`

## Phase Gate

Sprint 0 gate criterion: smoke test must pass.
All subsequent sprints add test files to this directory before deploying.
