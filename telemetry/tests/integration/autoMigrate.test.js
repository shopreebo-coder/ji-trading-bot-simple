"use strict";
/**
 * Sprint 4.1 — Auto-migration / production-persistence verification.
 *
 * Proves the startup schema runner (telemetry/migrations/autoMigrate.js):
 *   1. Creates every SHADOW OS v2 table on a PostgreSQL pool.
 *   2. Is idempotent — a second run applies nothing and skips all files.
 *   3. NEVER erases existing data (sacred constraint) — the exact scenario a
 *      Railway redeploy triggers: write data → "redeploy" (re-run ensureSchema)
 *      → data still present.
 *
 * Requires a PostgreSQL DATABASE_URL (the dev/CI Postgres). Skips cleanly on
 * SQLite-only environments.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { ensureSchema } = require("../../migrations/autoMigrate");

const DATABASE_URL = process.env.DATABASE_URL || "";
const IS_PG = DATABASE_URL.startsWith("postgres://") || DATABASE_URL.startsWith("postgresql://");

const EXPECTED_TABLES = [
  "events", "shadowm_trades", "shadowm_timeline",
  "runtime_domains", "runtime_domain_history",
  "trade_intents", "trade_intent_history",
  "memory_entries", "memory_events", "memory_event_history",
  "knowledge_artifacts", "event_idempotency", "consistency_log",
  "system_snapshots", "schema_migrations",
  // Sprint 5 — Shadow LAB Foundation (research-only measurement layer)
  "shadow_signals", "shadow_engine_evals", "shadow_outcomes",
  "shadow_expectancy_snapshots",
];

const SENTINEL_TYPE = "__automigrate_test__";
let pool;

before(async () => {
  if (!IS_PG) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 3, connectionTimeoutMillis: 10000 });
});

after(async () => {
  if (pool) {
    try { await pool.query("DELETE FROM events WHERE type = $1", [SENTINEL_TYPE]); } catch (_) {}
    await pool.end();
  }
});

test("ensureSchema creates the full v2 schema and is idempotent + data-safe", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  await t.test("first run reports ok and leaves every expected table present", async () => {
    const summary = await ensureSchema(pool, { log: () => {} });
    assert.equal(summary.ok, true);
    assert.equal(summary.backend, "postgresql");

    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const found = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) {
      assert.ok(found.has(t), `expected table missing after ensureSchema: ${t}`);
    }
  });

  await t.test("second run is a no-op — applies nothing, skips all migrations", async () => {
    const summary = await ensureSchema(pool, { log: () => {} });
    assert.equal(summary.ok, true);
    assert.equal(summary.applied.length, 0, "idempotent run must apply zero migrations");
    assert.ok(summary.skipped.length >= 4, "all known migrations should be skipped on re-run");
  });

  await t.test("re-running ensureSchema (simulated redeploy) never erases data", async () => {
    // Baseline count of real trading history.
    const pre = Number((await pool.query("SELECT COUNT(*) AS n FROM events")).rows[0].n);

    // Write a sentinel row (stands in for accumulated trading knowledge).
    await pool.query(
      "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES ($1,$2,$3,$4,$5)",
      [new Date().toISOString(), "test", SENTINEL_TYPE, "EURUSD", JSON.stringify({ marker: true })]
    );

    // Simulate a Railway redeploy: the new process runs ensureSchema again.
    const summary = await ensureSchema(pool, { log: () => {} });
    assert.equal(summary.ok, true);

    // Sacred constraint: nothing was dropped/truncated.
    const post = Number((await pool.query("SELECT COUNT(*) AS n FROM events")).rows[0].n);
    assert.equal(post, pre + 1, "row count must be preserved across re-migration");

    const sentinel = await pool.query("SELECT data FROM events WHERE type = $1 LIMIT 1", [SENTINEL_TYPE]);
    assert.equal(sentinel.rows.length, 1, "sentinel data must survive re-migration");
  });
});
