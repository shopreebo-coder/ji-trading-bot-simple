---
name: psql for multi-statement DDL migrations
description: Why JS SQL splitters fail silently for multi-statement DDL files, and how to run migrations reliably
---

## Rule
Always use `psql -f <sqlfile>` via `execSync` to run multi-statement DDL migration files. Never write a custom JS regex splitter for this purpose.

**Why:** A custom regex splitter (even one that handles `IF NOT EXISTS`, comments, and multi-line strings) silently groups multi-line `CREATE TABLE` statements with adjacent statements when the regex lookahead doesn't match every whitespace/comment pattern exactly. The resulting combined string fails with `42P01` (table doesn't exist for index), which a naïve error handler then logs as "SKIP (already exists)" — the tables are simply never created, with no fatal error raised.

**How to apply:**
```javascript
const { execSync } = require("child_process");
execSync(
  `psql "${DATABASE_URL}" -f "${sqlPath}" --set ON_ERROR_STOP=1 2>&1`,
  { encoding: "utf8", timeout: 60000 }
);
```
- `--set ON_ERROR_STOP=1` makes psql exit 1 on any SQL error → execSync throws → caught and surfaced
- `psql` is available in the Replit Nix environment: `/nix/store/.../bin/psql` (PostgreSQL 16.10)

**Confirmed working:** Sprint 0 migration `001_shadow_os_v2_schema.sql` (220L, 29 statements, 7 new tables + 3 existing IF NOT EXISTS + 12 indexes + 1 bootstrap INSERT).
