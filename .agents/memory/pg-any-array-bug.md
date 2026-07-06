---
name: pg ANY($1) with JS array returns 0 rows
description: The pg library does not reliably serialize a JS array for use with PostgreSQL ANY($1) operator
---

## Rule
Never use `WHERE column = ANY($1)` with a JavaScript array as the bound parameter in the `pg` library. It silently returns 0 rows.

**Why:** When you pass a JS array as `$1` to `client.query(sql, [arrayValue])`, the pg library serializes it as a PostgreSQL array literal. The type resolution for `ANY()` may not match, causing the query to return zero rows without throwing an error. This is especially unreliable with `information_schema` queries where `table_name` is `name` type, not `text`.

**Broken pattern:**
```javascript
const { rows } = await client.query(
  "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)",
  [["events", "shadowm_trades"]]   // ← returns 0 rows
);
```

**Safe pattern — fetch all, filter in JS:**
```javascript
const { rows } = await client.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
);
const found = new Set(rows.map(r => r.table_name));
const missing = expectedTables.filter(t => !found.has(t));
```

**Alternative — individual placeholders (verbose but guaranteed):**
```javascript
const placeholders = tables.map((_, i) => `$${i+1}`).join(",");
await client.query(`SELECT table_name FROM ... WHERE table_name IN (${placeholders})`, tables);
```
