"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Sprint 0 — Smoke Tests", () => {

  it("test framework is operational", () => {
    assert.ok(true, "node:test is working");
  });

  it("node:assert strict mode is working", () => {
    assert.strictEqual(1 + 1, 2);
    assert.notStrictEqual("a", "b");
    assert.deepStrictEqual({ x: 1 }, { x: 1 });
  });

  it("DATABASE_URL environment variable is set", () => {
    const url = process.env.DATABASE_URL || "";
    assert.ok(
      url.startsWith("postgres://") || url.startsWith("postgresql://"),
      `DATABASE_URL must start with postgres:// or postgresql://, got: "${url.slice(0, 20)}..."`
    );
  });

  it("db-adapter module loads without error", () => {
    assert.doesNotThrow(() => {
      const { db, USE_PG } = require("../../../telemetry/db-adapter");
      assert.ok(db, "db object must be defined");
      assert.ok(typeof db.all === "function", "db.all must be a function");
      assert.ok(typeof db.get === "function", "db.get must be a function");
      assert.ok(typeof db.run === "function", "db.run must be a function");
      assert.ok(typeof db.exec === "function", "db.exec must be a function");
      assert.strictEqual(USE_PG, true, "USE_PG must be true in Railway/production env");
    });
  });

  it("db-adapter connects and can run a basic query", async () => {
    const { db } = require("../../../telemetry/db-adapter");
    const row = await db.get("SELECT 1+1 AS result");
    assert.ok(row, "query must return a row");
    assert.strictEqual(Number(row.result), 2, "1+1 must equal 2");
  });

  it("events table exists in the database", async () => {
    const { db } = require("../../../telemetry/db-adapter");
    const row = await db.get(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='events'"
    );
    assert.ok(row, "events table must exist");
  });

  it("shadowm_trades table exists in the database", async () => {
    const { db } = require("../../../telemetry/db-adapter");
    const row = await db.get(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='shadowm_trades'"
    );
    assert.ok(row, "shadowm_trades table must exist");
  });

  it("shadowm_timeline table exists in the database", async () => {
    const { db } = require("../../../telemetry/db-adapter");
    const row = await db.get(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='shadowm_timeline'"
    );
    assert.ok(row, "shadowm_timeline table must exist");
  });

});
