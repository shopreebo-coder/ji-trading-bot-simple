"use strict";
/**
 * Sprint 6 — Migration 006 (Knowledge Foundation) integration test.
 *
 * Proves migration 006 is a correct, ADDITIVE, idempotent schema change:
 *   1. `006_knowledge_foundation.sql` is registered in the autoMigrate order.
 *   2. ensureSchema() adds the provenance columns to knowledge_artifacts and
 *      creates knowledge_snapshots (with its unique dedupe index).
 *   3. Running ensureSchema() again applies NOTHING (idempotent).
 *   4. knowledge_artifacts retains its migration-001 core columns + indexes
 *      (idx_ka_active / idx_ka_checksum / idx_ka_history) — nothing dropped.
 *
 * Requires a PostgreSQL DATABASE_URL. Skips cleanly on SQLite-only envs.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { ensureSchema, MIGRATIONS } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");

const IS_PG = USE_PG;

after(async () => {
  if (!IS_PG) return;
  await db._pool.end();
});

test("migration 006 is registered in the apply order", () => {
  assert.ok(
    MIGRATIONS.includes("006_knowledge_foundation.sql"),
    "006 must be appended to the MIGRATIONS array"
  );
  // 006 must come last (depends on knowledge_artifacts from 001).
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1], "006_knowledge_foundation.sql");
});

test("ensureSchema applies 006 and is idempotent", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  await t.test("first ensureSchema leaves the schema fully applied", async () => {
    const r = await ensureSchema(db._pool, { log: () => {} });
    assert.equal(r.ok, true);
    // Every migration is now either freshly applied or already present.
    const total = r.applied.length + r.skipped.length;
    assert.equal(total, MIGRATIONS.length, "all migrations accounted for");
  });

  await t.test("knowledge_artifacts has provenance columns (additive)", async () => {
    const cols = await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
      "knowledge_artifacts"
    );
    const names = new Set(cols.map((c) => c.column_name));
    // core columns from migration 001 are still present (nothing dropped)
    for (const c of ["id", "domain", "artifact", "version", "value", "checksum",
                     "superseded_at", "migration_from", "training_events", "confidence", "notes"]) {
      assert.ok(names.has(c), `core column ${c} must survive`);
    }
    // provenance columns added by migration 006
    for (const c of ["run_id", "build_id", "config_hash", "source_window_from", "source_window_to"]) {
      assert.ok(names.has(c), `migration 006 must add ${c}`);
    }
  });

  await t.test("knowledge_snapshots exists with the expected shape", async () => {
    const cols = await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
      "knowledge_snapshots"
    );
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ["id", "artifact_count", "total_bytes", "manifest", "manifest_checksum",
                     "run_id", "build_id", "config_hash", "dedupe_key", "created_at"]) {
      assert.ok(names.has(c), `knowledge_snapshots must have ${c}`);
    }
  });

  await t.test("critical indexes exist (active + checksum uniqueness preserved)", async () => {
    const idx = await db.all(
      "SELECT indexname FROM pg_indexes WHERE tablename IN (?, ?)",
      "knowledge_artifacts", "knowledge_snapshots"
    );
    const names = new Set(idx.map((i) => i.indexname));
    for (const i of ["idx_ka_active", "idx_ka_checksum", "idx_ka_history", "idx_ks_dedupe"]) {
      assert.ok(names.has(i), `index ${i} must exist`);
    }
  });

  await t.test("re-running ensureSchema applies nothing new", async () => {
    const r = await ensureSchema(db._pool, { log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 0, "no migrations should re-apply");
    assert.equal(r.skipped.length, MIGRATIONS.length, "all migrations already applied");
  });
});
