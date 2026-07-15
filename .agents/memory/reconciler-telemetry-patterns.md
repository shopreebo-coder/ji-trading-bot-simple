---
name: Reconciler & telemetry-metric patterns
description: Durable rules for event reconcilers (dedupe consumption persistence) and health/completeness metrics (dormant measurer must report UNKNOWN).
---

# Time-window dedupe consumption must be persistent

**Rule:** When a reconciler matches external records to local events by a time
window and "consumes" matches one-to-one, the consumption set must survive
across polling cycles AND process restarts (persist consumed ids, e.g. in the
cursor/watermark record, and restore on startup).

**Why:** A per-cycle (function-local) Set lets the same local event be consumed
again in the next cycle — the second external record is then wrongly classified
as "already captured" and silently lost forever. This exact gap passed 16 tests
and was only caught by architect review; it is the precise failure class a
completeness reconciler exists to eliminate.

**How to apply:** Any manager here that polls an external source (OANDA, etc.)
and dedupes against local events by symbol/time window: check that its consumed
set is instance-level and restored from persisted state, and keep a test that
runs TWO polls sharing one matchable local event.

# Completeness metrics must be UNKNOWN when the measurer is dormant

**Rule:** A health/completeness percentage whose "missing" input comes from an
active watcher must report `null`/UNKNOWN when that watcher cannot observe
(feature flag off, credentials absent) — never default to 100%.

**Why:** `missing=0` because "nothing was looked for" is indistinguishable from
"nothing is missing"; the metric reads perfect precisely when capture is
broken, which inverts its purpose.

**How to apply:** Gate the percentage on the watcher's enabled+creds state;
also fold "failed and awaiting retry" items into missing, and don't let a
successful fetch clear per-item errors recorded in the same cycle.
