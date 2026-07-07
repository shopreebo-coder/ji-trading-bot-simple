---
name: CAS Pool Deadlock
description: compareAndSwap() deadlocks under concurrent load when the else-branch acquires a second connection while the first is still held.
---

## Rule

In any method that holds a pool connection inside a try/finally block, never call another method that acquires a pool connection from within the `try` block or from a `return` statement — the `finally { client.release() }` runs AFTER the return expression is fully evaluated (including awaiting promises). This means both connections are held simultaneously.

**How to apply:** In the CAS failure path, read all needed state from the DB using the already-held `client`, then ROLLBACK, then return. Never call `this.getDomain()` or any other method that calls `this._pool.connect()` while a client is checked out.

```js
// WRONG — getDomain() needs a second connection while client is still held:
} else {
  await client.query("ROLLBACK");
  const current = await this.getDomain(domain); // deadlocks under concurrent CAS
  return { swapped: false, currentVersion: current?.version, row: current };
}

// CORRECT — read in same transaction, then ROLLBACK, then return:
} else {
  const { rows: currentRows } = await client.query(
    "SELECT domain, version, value, updated_at, schema_ver FROM runtime_domains WHERE domain=$1",
    [domain]
  );
  await client.query("ROLLBACK");
  const current = currentRows[0] ?? null;
  return { swapped: false, currentVersion: current ? Number(current.version) : null, row: current };
}
```

**Why:** Node.js async function `finally` blocks run after the return expression resolves. With pool.max=N and N concurrent callers, all N hold their connections and all N try to acquire an N+1th connection — permanent deadlock. This does NOT appear in sequential tests; only concurrent load reveals it.

**How to spot:** Tests pass individually/sequentially but hang silently when run concurrently (Promise.all with N ≥ pool.max operations). Look for any `this._pool.connect()` call that can execute while another client from the same pool is still checked out in the same call stack.

## Recurrence (Sprint 3): `this._pool.query()` counts too

The pattern recurred in a create-with-dedupe path: after `ROLLBACK` on a unique-constraint conflict, the duplicate lookup used `this._pool.query()` while the original client was still held. `pool.query()` internally does connect→query→release, so it is just as deadlock-prone as `pool.connect()`. Sequential and low-concurrency (< pool.max) tests all passed; only a stress test with 100 concurrent creates against pool.max=5 exposed it.

**Durable rule:** while holding a pool client, ALL database access must go through that held client — audit for both `pool.connect()` AND `pool.query()`. A stress gate with concurrency ≥ pool.max on every conflict/fallback path is mandatory before declaring a manager done.
