---
name: Module status DB binding
description: ModuleStatusManager count readers must call the db adapter with variadic parameters, not an empty array argument.
---

`db.get(sql, [])` and `db.all(sql, [])` are not equivalent to parameterless calls in the PostgreSQL adapter: the empty array becomes one bound parameter, causing guarded status queries to fail and display fabricated zero counts.

**Why:** The status registry intentionally degrades query failures to null/empty maps, so an argument-shape mistake looked like real inactivity across multiple modules.

**How to apply:** For parameterless telemetry queries, omit the argument; for parameterized queries, spread the parameter array into `db.get(sql, ...params)` or `db.all(sql, ...params)`.