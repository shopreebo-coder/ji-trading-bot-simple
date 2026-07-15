"use strict";
/**
 * Sprint 7.1 — patterns/validated threshold validation (T3 diagnostic proof).
 *
 * The dashboard report showed "Patterns: 39, validated: 0". This test proves the
 * validation gate in KnowledgeManager._buildValidatedPatterns works EXACTLY as
 * designed, so validated=0 with dozens of observed patterns is a data-volume
 * state, not a bug:
 *
 *   validated = (resolved >= VALIDATION_MIN_SAMPLE(30)) AND (avg_pips > 0)
 *
 * Three seeded buckets prove the boundary:
 *   1. 30 resolved outcomes, positive expectancy  → validated = true
 *   2. 29 resolved outcomes, positive expectancy  → validated = false (below sample)
 *   3. 30 resolved outcomes, negative expectancy  → validated = false (no edge)
 *
 * Seeds shadow_signals + shadow_outcomes directly (namespaced symbols) and calls
 * the builder read-only — no knowledge_artifacts rows are written.
 * Requires PostgreSQL; skips cleanly otherwise.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { KnowledgeManager } = require("../../managers/KnowledgeManager");
const { createProvenance } = require("../../managers/knowledgeProvenance");

const IS_PG = USE_PG;
const NS = `T71-${crypto.randomUUID().slice(0, 8)}`;
const CFG = crypto.createHash("sha256").update(NS).digest("hex");
const PROV = createProvenance({ runId: `vp-${NS}`, buildId: "v40.1+t71vp00000", configHash: CFG });

// Unique symbols so assertions are deterministic on the shared dev database
// (the builder aggregates the WHOLE shadow_signals table).
const SYM_VALID    = `${NS}_VALID`;   // 30 resolved, avg +2.0 pips → validated
const SYM_UNDER    = `${NS}_UNDER`;   // 29 resolved, avg +2.0 pips → NOT validated
const SYM_NEGATIVE = `${NS}_NEG`;     // 30 resolved, avg -1.5 pips → NOT validated

async function seedBucket(symbol, count, profitPips) {
  for (let i = 0; i < count; i++) {
    const sid = `${NS}-${symbol}-${i}`;
    await db.run(
      `INSERT INTO shadow_signals
         (signal_id, symbol, side, trend_bucket, volatility_bucket, spread_bucket,
          run_id, build_id, config_hash, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sid, symbol, "buy", "UP", "MED", "TIGHT",
      PROV.runId, PROV.buildId, CFG, `sig-${sid}`
    );
    await db.run(
      `INSERT INTO shadow_outcomes
         (signal_id, symbol, profit_pips, run_id, build_id, config_hash, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sid, symbol, profitPips,
      PROV.runId, PROV.buildId, CFG, `out-${sid}`
    );
  }
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  await seedBucket(SYM_VALID, 30, 2.0);
  await seedBucket(SYM_UNDER, 29, 2.0);
  await seedBucket(SYM_NEGATIVE, 30, -1.5);
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM shadow_outcomes WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_signals  WHERE signal_id LIKE $1", [`${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("patterns/validated threshold gate works as designed", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const mgr = new KnowledgeManager({ db, provenance: PROV, pollIntervalMs: 3_600_000 });
  const built = await mgr._buildValidatedPatterns();
  assert.ok(built && built.content, "builder returned content");
  const { validationMinSample, patterns } = built.content;
  assert.equal(validationMinSample, 30, "documented threshold is 30 resolved outcomes");

  const find = (sym) => patterns.find((p) => p.symbol === sym);

  await t.test("30 resolved + positive expectancy → validated", () => {
    const p = find(SYM_VALID);
    assert.ok(p, "bucket present");
    assert.equal(p.resolved, 30);
    assert.ok(p.expectancyPips > 0);
    assert.equal(p.validated, true, "meets both conditions → validated");
  });

  await t.test("29 resolved + positive expectancy → NOT validated (one short of sample)", () => {
    const p = find(SYM_UNDER);
    assert.ok(p, "bucket present");
    assert.equal(p.resolved, 29);
    assert.ok(p.expectancyPips > 0);
    assert.equal(p.validated, false, "below VALIDATION_MIN_SAMPLE → not validated");
  });

  await t.test("30 resolved + negative expectancy → NOT validated (no realized edge)", () => {
    const p = find(SYM_NEGATIVE);
    assert.ok(p, "bucket present");
    assert.equal(p.resolved, 30);
    assert.ok(p.expectancyPips < 0);
    assert.equal(p.validated, false, "negative expectancy → not validated");
  });

  await t.test("validated flag never fabricated from null expectancy", () => {
    for (const p of patterns) {
      if (p.validated) {
        assert.ok(p.resolved >= 30 && p.expectancyPips !== null && p.expectancyPips > 0,
          `validated pattern ${p.symbol} must satisfy both gate conditions`);
      }
    }
  });
});
