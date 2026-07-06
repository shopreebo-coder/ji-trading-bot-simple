---
name: db-adapter run() RETURNING id quirk
description: db.run() auto-appends RETURNING id to INSERT statements; fails on tables whose PK is not named id
---

## Rule
Use `db.exec()` (not `db.run()`) for INSERT/UPDATE statements targeting tables whose primary key is NOT named `id`.

**Why:** `telemetry/db-adapter.js` line ~85:
```javascript
const hasReturning = /RETURNING/i.test(sql);
if (isInsert && !hasReturning) convertedSql += " RETURNING id";
```
This auto-appends `RETURNING id` to every INSERT that lacks a RETURNING clause. Any table with a non-`id` primary key (e.g. `runtime_domains` with `PRIMARY KEY (domain)`) will throw:
```
error: column "id" does not exist
```

**Tables with non-id PKs (as of Sprint 0):**
- `runtime_domains` — PK is `domain TEXT`
- `event_idempotency` — PK is `key TEXT`

**How to apply:**
- `db.exec(sql)` — for DDL and for INSERTs where you don't need lastInsertRowid
- `db.run(sql, ...params)` — only for tables with a BIGSERIAL/integer `id` column as PK
- `db.get(sql, ...params)` / `db.all(sql, ...params)` — safe for all SELECT queries
