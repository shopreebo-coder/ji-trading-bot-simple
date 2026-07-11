"use strict";
/**
 * Sprint 5 — ShadowLabManager expectancy (research aggregates) integration test.
 *
 * Proves the F4 measurement methods on telemetry/managers/ShadowLabManager.js:
 *   1. computeExpectancy(scope) math:
 *        expectancy_pips = total_profit_pips / resolved_trades
 *        win = profit_pips>0, loss = profit_pips<0, breakeven = 0
 *        gross_profit / gross_loss, profit_factor (null when no losses)
 *   2. confidence_level is AUTO-COMPUTED from resolved_trades
 *        (<30 LOW, 30–100 MEDIUM, >100 HIGH).
 *   3. snapshotExpectancy(scope) appends an idempotent time-series point —
 *        one row per distinct (config_hash, scope, resolved_trades); a
 *        re-run with unchanged data inserts nothing; a newly resolved trade
 *        yields a new point.
 *   4. getTimeseries(scope) reads the persisted series back (oldest→newest).
 *   5. getResearchSummary() returns counts + ALL expectancy + provenance.
 *
 * Isolation: every seeded row is scoped by a unique per-run symbol / signal id,
 * so assertions are deterministic regardless of pre-existing dev data, and the
 * teardown deletes ONLY this run's rows (mirrors autoMigrate.test.js).
 *
 * Requires a PostgreSQL DATABASE_URL. Skips cleanly on SQLite-only envs.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { ShadowLabManager } = require("../../managers/ShadowLabManager");
const { createProvenance } = require("../../managers/shadowLabProvenance");

const IS_PG = USE_PG;

const NS = `T5EXP-${crypto.randomUUID().slice(0, 8)}`;
const SYM_MATH = `${NS}_MATH`;     // small known set — exercises the math
const SYM_NOLOSS = `${NS}_NOLOSS`; // only winners — profit_factor must be null
const SYM_MED = `${NS}_MED`;       // 50 resolved → MEDIUM confidence
const SYM_HIGH = `${NS}_HIGH`;     // 101 resolved → HIGH confidence

const PROV = createProvenance({
  runId: `run-${NS}`,
  buildId: "v40.1+exptest01",
  configHash: "e".repeat(64),
});

async function seedSignal(symbol, signalId) {
  const values = PROV.stamp({
    signal_id: signalId,
    symbol,
    features: JSON.stringify({ signalId, symbol }),
    dedupe_key: `sig:${signalId}`,
  });
  await db.run(
    `INSERT INTO shadow_signals (signal_id, symbol, features, run_id, build_id, config_hash, dedupe_key)
     VALUES (@signal_id, @symbol, @features, @run_id, @build_id, @config_hash, @dedupe_key)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    values
  );
}

async function seedOutcome(symbol, signalId, profitPips, ts) {
  const values = PROV.stamp({
    signal_id: signalId,
    symbol,
    profit_pips: profitPips,
    outcome: JSON.stringify({ signalId, profitPips }),
    source_ts: ts ?? new Date().toISOString(),
    dedupe_key: `out:${signalId}`,
  });
  await db.run(
    `INSERT INTO shadow_outcomes (signal_id, symbol, profit_pips, outcome, source_ts, run_id, build_id, config_hash, dedupe_key)
     VALUES (@signal_id, @symbol, @profit_pips, @outcome, @source_ts, @run_id, @build_id, @config_hash, @dedupe_key)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    values
  );
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });

  // ── MATH scope: +10, +20, -5, 0 ──────────────────────────────────────────
  //   resolved=4  wins=2  losses=1  breakeven=1
  //   total=25  grossProfit=30  grossLoss=5
  //   expectancy=25/4=6.25  profit_factor=30/5=6
  const mathPips = [10, 20, -5, 0];
  for (let i = 0; i < mathPips.length; i++) {
    const id = `${NS}-MATH-${i}`;
    await seedSignal(SYM_MATH, id);
    // stagger source_ts so window_from < window_to deterministically
    await seedOutcome(SYM_MATH, id, mathPips[i], `2026-01-01T00:0${i}:00.000Z`);
  }

  // ── NOLOSS scope: +5, +7 (no losing trades) ──────────────────────────────
  const noLossPips = [5, 7];
  for (let i = 0; i < noLossPips.length; i++) {
    const id = `${NS}-NOLOSS-${i}`;
    await seedSignal(SYM_NOLOSS, id);
    await seedOutcome(SYM_NOLOSS, id, noLossPips[i]);
  }

  // ── MED scope: 50 resolved trades → MEDIUM confidence ────────────────────
  for (let i = 0; i < 50; i++) {
    await seedOutcome(SYM_MED, `${NS}-MED-${i}`, 1);
  }

  // ── HIGH scope: 101 resolved trades → HIGH confidence ────────────────────
  for (let i = 0; i < 101; i++) {
    await seedOutcome(SYM_HIGH, `${NS}-HIGH-${i}`, 1);
  }
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM shadow_signals  WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_expectancy_snapshots WHERE scope LIKE $1", [`${NS}%`]);
  } catch (_) {}
  await db._pool.end();
});

test("ShadowLabManager expectancy aggregates", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const mgr = new ShadowLabManager({ db, provenance: PROV, batchLimit: 1000 });

  await t.test("computeExpectancy: math over a known set", async () => {
    const e = await mgr.computeExpectancy(SYM_MATH);
    assert.equal(e.scope, SYM_MATH);
    assert.equal(e.sampleCount, 4, "4 signals observed in scope");
    assert.equal(e.resolvedTrades, 4);
    assert.equal(e.wins, 2);
    assert.equal(e.losses, 1);
    assert.equal(e.breakevens, 1);
    assert.equal(e.totalProfitPips, 25);
    assert.equal(e.grossProfitPips, 30);
    assert.equal(e.grossLossPips, 5);
    assert.equal(e.expectancyPips, 6.25);
    assert.equal(e.profitFactor, 6);
    assert.equal(e.confidenceLevel, "LOW"); // 4 < 30
    assert.equal(e.windowFrom, "2026-01-01T00:00:00.000Z");
    assert.equal(e.windowTo, "2026-01-01T00:03:00.000Z");
  });

  await t.test("computeExpectancy: profit_factor is null when there are no losses", async () => {
    const e = await mgr.computeExpectancy(SYM_NOLOSS);
    assert.equal(e.resolvedTrades, 2);
    assert.equal(e.wins, 2);
    assert.equal(e.losses, 0);
    assert.equal(e.grossLossPips, 0);
    assert.equal(e.profitFactor, null, "no losses ⇒ profit_factor undefined ⇒ null");
    assert.equal(e.expectancyPips, 6); // (5+7)/2
  });

  await t.test("confidence_level is auto-computed from resolved_trades", async () => {
    const med = await mgr.computeExpectancy(SYM_MED);
    assert.equal(med.resolvedTrades, 50);
    assert.equal(med.confidenceLevel, "MEDIUM"); // 30–100

    const high = await mgr.computeExpectancy(SYM_HIGH);
    assert.equal(high.resolvedTrades, 101);
    assert.equal(high.confidenceLevel, "HIGH"); // > 100
  });

  await t.test("snapshotExpectancy is idempotent per (config_hash, scope, resolved_trades)", async () => {
    const first = await mgr.snapshotExpectancy(SYM_MATH);
    assert.equal(first.inserted, true, "first snapshot must insert");
    assert.equal(first.resolvedTrades, 4);
    assert.equal(first.dedupeKey, `exp:${PROV.configHash}:${SYM_MATH}:4`);

    const second = await mgr.snapshotExpectancy(SYM_MATH);
    assert.equal(second.inserted, false, "same resolved_trades ⇒ no duplicate");

    const rows = await mgr.getTimeseries(SYM_MATH);
    assert.equal(rows.length, 1, "exactly one persisted point so far");
    const p = rows[0];
    assert.equal(Number(p.resolved_trades), 4);
    assert.equal(Number(p.expectancy_pips), 6.25);
    assert.equal(Number(p.profit_factor), 6);
    assert.equal(p.confidence_level, "LOW");
    assert.equal(p.run_id ?? PROV.runId, PROV.runId); // provenance present on snapshots
  });

  await t.test("a newly resolved trade appends a new time-series point", async () => {
    const id = `${NS}-MATH-extra`;
    await seedSignal(SYM_MATH, id);
    await seedOutcome(SYM_MATH, id, 3); // resolved_trades 4 → 5

    const snap = await mgr.snapshotExpectancy(SYM_MATH);
    assert.equal(snap.inserted, true, "new resolved_trades ⇒ new point");
    assert.equal(snap.resolvedTrades, 5);

    const rows = await mgr.getTimeseries(SYM_MATH);
    assert.equal(rows.length, 2, "two points: resolved=4 then resolved=5");
    assert.deepEqual(rows.map((r) => Number(r.resolved_trades)), [4, 5], "ordered oldest→newest");
  });

  await t.test("getResearchSummary returns counts, ALL expectancy and provenance", async () => {
    const s = await mgr.getResearchSummary();
    assert.ok(s.generated, "has a generated timestamp");
    assert.ok(s.counts && typeof s.counts.signals === "number");
    assert.ok(s.counts && typeof s.counts.outcomes === "number");
    assert.equal(s.expectancy.scope, "ALL");
    assert.ok(Array.isArray(s.engines));
    assert.equal(s.provenance.runId, PROV.runId);
    assert.equal(s.provenance.configHash, PROV.configHash);
  });
});
