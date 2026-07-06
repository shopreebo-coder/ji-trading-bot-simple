---
name: Node 24 built-in test runner flags
description: Correct flags for node:test built-in runner in Node.js 24
---

## Rule
Use `--test-reporter=spec` (not `--reporter=spec`) for verbose output in Node 24's built-in test runner.

**Why:** `--reporter=spec` was never a valid flag for `node --test`. The correct flag in Node 24 is `--test-reporter=<format>`. Using the wrong flag causes immediate exit with:
```
node: bad option: --reporter=spec
```

**Correct invocations:**
```bash
node --test                                            # TAP output (default)
node --test --test-reporter=spec                       # human-readable spec output
node --test --test-reporter=tap                        # explicit TAP
node --test telemetry/tests/unit/smoke.test.js         # single file
node --test 'telemetry/tests/unit/*.test.js'           # glob (quote the pattern)
```

**Note:** The exit code behavior for `node --test` with all-passing tests may be non-zero (-1) in some Node 24 builds when run with `--test-reporter=spec`. This is a Node 24 quirk — check actual test pass/fail output, not just exit code.
