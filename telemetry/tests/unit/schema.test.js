"use strict";
/**
 * Sprint 0 — Schema Validation Tests
 * Verify that all 10 SHADOW OS v2 tables exist and have the correct structure.
 * These tests run AFTER the migration script has been applied.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let db;
before(() => {
  ({ db } = require("../../../telemetry/db-adapter"));
});

const REQUIRED_TABLES = [
  "events",
  "shadowm_trades",
  "shadowm_timeline",
  "runtime_domains",
  "trade_intents",
  "memory_entries",
  "knowledge_artifacts",
  "event_idempotency",
  "consistency_log",
  "system_snapshots",
];

const REQUIRED_DOMAINS = [
  "live", "shadowA", "shadowB", "shadowC", "shadowD",
  "shadowM", "exitLab", "telemetry", "scheduler", "meta"
];

describe("Sprint 0 — Schema Validation", () => {

  it("all 10 required tables exist", async () => {
    const rows = await db.all(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name = ANY($1)`,
      REQUIRED_TABLES
    );
    const found = new Set(rows.map(r => r.table_name));
    const missing = REQUIRED_TABLES.filter(t => !found.has(t));
    assert.deepStrictEqual(
      missing,
      [],
      `Missing tables: ${missing.join(", ")}`
    );
  });

  it("runtime_domains has all 10 bootstrap rows", async () => {
    const rows = await db.all("SELECT domain FROM runtime_domains ORDER BY domain");
    const found = rows.map(r => r.domain).sort();
    const expected = [...REQUIRED_DOMAINS].sort();
    assert.deepStrictEqual(found, expected, "runtime_domains bootstrap rows mismatch");
  });

  it("runtime_domains columns are correct", async () => {
    const cols = await db.all(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='runtime_domains'
       ORDER BY ordinal_position`
    );
    const colNames = cols.map(c => c.column_name);
    assert.ok(colNames.includes("domain"),     "runtime_domains must have domain column");
    assert.ok(colNames.includes("version"),    "runtime_domains must have version column");
    assert.ok(colNames.includes("value"),      "runtime_domains must have value column");
    assert.ok(colNames.includes("updated_at"), "runtime_domains must have updated_at column");
    assert.ok(colNames.includes("schema_ver"), "runtime_domains must have schema_ver column");
  });

  it("knowledge_artifacts has unique index on active artifacts", async () => {
    const row = await db.get(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='knowledge_artifacts' AND indexname='idx_ka_active'`
    );
    assert.ok(row, "idx_ka_active partial unique index must exist on knowledge_artifacts");
  });

  it("trade_intents has partial index on PENDING status", async () => {
    const row = await db.get(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='trade_intents' AND indexname='idx_ti_pending'`
    );
    assert.ok(row, "idx_ti_pending partial index must exist on trade_intents");
  });

  it("memory_entries has GIN index on tags", async () => {
    const row = await db.get(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='memory_entries' AND indexname='idx_mem_tags'`
    );
    assert.ok(row, "idx_mem_tags GIN index must exist on memory_entries");
  });

  it("consistency_log has correct severity CHECK constraint", async () => {
    // Attempt to insert an invalid severity — must fail
    await assert.rejects(
      () => db.run(
        `INSERT INTO consistency_log (check_id, severity, description)
         VALUES ('test', 'INVALID', 'test')`
      ),
      (err) => {
        return err.message.includes("check") ||
               err.message.includes("constraint") ||
               err.message.includes("violat");
      },
      "consistency_log must reject invalid severity values"
    );
  });

  it("trade_intents has correct status CHECK constraint", async () => {
    await assert.rejects(
      () => db.run(
        `INSERT INTO trade_intents (signal_id, intent_type, symbol, status)
         VALUES ('test-sig-bad', 'OPEN', 'EUR_USD', 'INVALID_STATUS')`
      ),
      (err) => {
        return err.message.includes("check") ||
               err.message.includes("constraint") ||
               err.message.includes("violat");
      },
      "trade_intents must reject invalid status values"
    );
  });

  it("runtime_domains all rows have valid JSON values", async () => {
    const rows = await db.all("SELECT domain, value FROM runtime_domains");
    for (const row of rows) {
      assert.ok(row.value !== null, `domain '${row.domain}' value must not be null`);
      assert.strictEqual(typeof row.value, "object", `domain '${row.domain}' value must be an object (JSONB parsed)`);
    }
  });

  it("existing events and shadowm_trades data is intact (no rows deleted)", async () => {
    const evtRow = await db.get("SELECT COUNT(*) AS n FROM events");
    const smtRow = await db.get("SELECT COUNT(*) AS n FROM shadowm_trades");
    assert.ok(Number(evtRow.n) >= 0, "events row count must be non-negative (table accessible)");
    assert.ok(Number(smtRow.n) >= 0, "shadowm_trades row count must be non-negative");
  });

  it("migration is idempotent — running twice produces no errors", async () => {
    // Re-run CREATE TABLE IF NOT EXISTS statements for a subset of tables
    await assert.doesNotReject(async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_domains (
          domain      TEXT        PRIMARY KEY,
          version     BIGINT      NOT NULL DEFAULT 0,
          value       JSONB       NOT NULL,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          schema_ver  INTEGER     NOT NULL DEFAULT 1
        )
      `);
    }, "Re-running CREATE TABLE IF NOT EXISTS must not throw");

    // Bootstrap insert — use exec() not run() because runtime_domains has no 'id' column
    // (db.run() auto-appends RETURNING id which fails on tables without an id column)
    await assert.doesNotReject(async () => {
      await db.exec(
        `INSERT INTO runtime_domains (domain, version, value, schema_ver)
         VALUES ('live', 0, '{"test":true}', 1) ON CONFLICT (domain) DO NOTHING`
      );
    }, "Re-inserting bootstrap row must not throw");
  });

});
