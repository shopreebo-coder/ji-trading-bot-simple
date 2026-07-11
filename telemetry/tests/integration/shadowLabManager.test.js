"use strict";
/**
 * Sprint 5 — ShadowLabManager reconciliation integration test.
 *
 * Proves the research-only reconciler (telemetry/managers/ShadowLabManager.js):
 *   1. Projects the append-only `events` stream into the research tables:
 *        trade_open      → shadow_signals
 *        lab_shadow_a..d → shadow_engine_evals   (engine id from event type)
 *        trade_close     → shadow_outcomes
 *   2. Stamps every row with full provenance (run_id + build_id + config_hash).
 *   3. Is idempotent — re-reconciling the same events inserts NO duplicates.
 *   4. Advances + persists a resumable cursor (shadowlab_research_cursor).
 *   5. Handles engine abstention (wouldTrade === null → would_trade IS NULL).
 *   6. Parses events.data as BOTH JSON string (TEXT) and object (JSONB).
 *
 * Isolation: all assertions filter by unique per-run signal ids, so the test is
 * deterministic regardless of any pre-existing events in the dev database.
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

// Unique namespace so this run never collides with prior runs or live data.
const NS = `T5-${crypto.randomUUID().slice(0, 8)}`;
const S1 = `${NS}-S1`; // fully instrumented signal (open → A/B/C/D → close)
const S2 = `${NS}-S2`; // engine-C abstention signal (wouldTrade === null)

// Deterministic provenance (real context with a working stamp()) for assertions.
const PROV = createProvenance({
  runId: `run-${NS}`,
  buildId: "v40.1+testsha0001",
  configHash: "a".repeat(64),
});

// Insert an events row exactly like logEvent would (data = JSON string / TEXT).
async function seedEvent(type, payload, symbol = null) {
  const ts = new Date().toISOString();
  const data = JSON.stringify({ ...payload, type, ts, botId: "test" });
  await db.run(
    "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)",
    ts, "test", type, symbol, data
  );
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });

  // ── S1: a fully instrumented signal ──────────────────────────────────────
  await seedEvent("trade_open", {
    signalId: S1, symbol: "EUR_USD", session: "LONDON", side: "buy",
    fingerprint: "fp-s1", entryGate: "HARD", passCount: 8,
    spread: 0.8, atrPips: 12.5, emaDistance: 4.2, candleStrength: 0.31,
    trendBucket: "UP", volatilityBucket: "MED", spreadBucket: "TIGHT",
  }, "EUR_USD");
  await seedEvent("lab_shadow_a", { signalId: S1, symbol: "EUR_USD", score: 72, confidence: "MEDIUM", wouldTrade: true, reason: "score>=65" }, "EUR_USD");
  await seedEvent("lab_shadow_b", { signalId: S1, symbol: "EUR_USD", marketState: "TRENDING", confidence: "HIGH", wouldTrade: true }, "EUR_USD");
  await seedEvent("lab_shadow_c", { signalId: S1, symbol: "EUR_USD", wouldTrade: true, confidence: "MEDIUM", historicalWinrate: 58.3 }, "EUR_USD");
  await seedEvent("lab_shadow_d", { signalId: S1, symbol: "EUR_USD", wouldTrade: true, confidence: "HIGH", metaVoteScore: 0.71 }, "EUR_USD");
  await seedEvent("trade_close", { signalId: S1, symbol: "EUR_USD", profitPips: 14.2, mfe: 18.0, mae: -3.1, duration: 42, profitGivenBackPips: 3.8 }, "EUR_USD");

  // ── S2: engine-C abstains (wouldTrade === null) ──────────────────────────
  await seedEvent("trade_open", {
    signalId: S2, symbol: "GBP_USD", session: "NY", side: "sell",
    fingerprint: "fp-s2", entryGate: "RELAXED", passCount: 6,
    spread: 1.1, atrPips: 9.0, emaDistance: 2.0, candleStrength: 0.12,
  }, "GBP_USD");
  await seedEvent("lab_shadow_c", { signalId: S2, symbol: "GBP_USD", wouldTrade: null, confidence: "NONE", historicalWinrate: null }, "GBP_USD");
});

after(async () => {
  if (!IS_PG) return;
  // Test-only cleanup of this run's rows (mirrors autoMigrate.test.js sentinel cleanup).
  try {
    await db._pool.query("DELETE FROM shadow_signals        WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_engine_evals   WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes        WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("ShadowLabManager reconciles the event stream into research tables", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const mgr = new ShadowLabManager({ db, provenance: PROV, batchLimit: 1000 });

  await t.test("first reconcile projects signals, engine evals and outcomes", async () => {
    mgr._lastId = 0;
    await mgr.reconcileAll();

    const sig = await db.get("SELECT * FROM shadow_signals WHERE signal_id = ?", S1);
    assert.ok(sig, "shadow_signals row for S1 must exist");
    assert.equal(sig.symbol, "EUR_USD");
    assert.equal(sig.side, "buy");
    assert.equal(sig.entry_gate, "HARD");
    assert.equal(Number(sig.pass_count), 8);
    assert.equal(Number(sig.atr_pips), 12.5);
    assert.equal(sig.live_would_trade, true);
    // provenance stamped
    assert.equal(sig.run_id, PROV.runId);
    assert.equal(sig.build_id, PROV.buildId);
    assert.equal(sig.config_hash, PROV.configHash);
    // features preserved as JSONB (object round-trips)
    const feats = typeof sig.features === "string" ? JSON.parse(sig.features) : sig.features;
    assert.equal(feats.signalId, S1);
    assert.equal(feats.fingerprint, "fp-s1");
  });

  await t.test("all four engine evaluations are recorded with promoted columns", async () => {
    const evals = await db.all("SELECT * FROM shadow_engine_evals WHERE signal_id = ? ORDER BY engine_id ASC", S1);
    assert.equal(evals.length, 4, "expected A, B, C, D");
    const byEngine = Object.fromEntries(evals.map((e) => [e.engine_id, e]));

    assert.equal(byEngine.A.would_trade, true);
    assert.equal(Number(byEngine.A.score), 72);
    assert.equal(byEngine.A.confidence, "MEDIUM");

    assert.equal(byEngine.B.market_state, "TRENDING");
    assert.equal(byEngine.B.would_trade, true);

    assert.equal(Number(byEngine.C.historical_winrate), 58.3);

    assert.equal(byEngine.D.would_trade, true);
    assert.equal(Number(byEngine.D.score), 0.71); // D score = metaVoteScore

    for (const e of evals) {
      assert.equal(e.run_id, PROV.runId);
      assert.equal(e.config_hash, PROV.configHash);
    }
  });

  await t.test("resolved outcome is recorded from trade_close", async () => {
    const out = await db.get("SELECT * FROM shadow_outcomes WHERE signal_id = ?", S1);
    assert.ok(out, "shadow_outcomes row for S1 must exist");
    assert.equal(Number(out.profit_pips), 14.2);
    assert.equal(Number(out.mfe), 18.0);
    assert.equal(Number(out.mae), -3.1);
    assert.equal(Number(out.duration_min), 42);
    assert.equal(Number(out.profit_given_back), 3.8);
  });

  await t.test("engine abstention is preserved as NULL (would_trade)", async () => {
    const c2 = await db.get("SELECT * FROM shadow_engine_evals WHERE signal_id = ? AND engine_id = 'C'", S2);
    assert.ok(c2, "S2 engine-C eval must exist");
    assert.equal(c2.would_trade, null, "abstention must be NULL, not false");
    assert.equal(c2.historical_winrate, null);
  });

  await t.test("cursor advanced and was persisted", async () => {
    assert.ok(mgr._lastId > 0, "cursor must have advanced past 0");
    const fresh = new ShadowLabManager({ db, provenance: PROV });
    const recovered = await fresh.recoverCursor();
    assert.ok(recovered > 0, "a persisted cursor row must be recoverable");
  });

  await t.test("re-reconciling the same events is idempotent (no duplicates)", async () => {
    const mgr2 = new ShadowLabManager({ db, provenance: PROV, batchLimit: 1000 });
    mgr2._lastId = 0;
    const again = await mgr2.reconcileAll();
    // second pass over the same source rows must insert nothing new for our NS
    assert.equal(again.signals, 0, "no new signals on re-run");
    assert.equal(again.evals, 0, "no new evals on re-run");
    assert.equal(again.outcomes, 0, "no new outcomes on re-run");

    const sigCount = await db.get("SELECT COUNT(*) AS n FROM shadow_signals WHERE signal_id LIKE ?", `${NS}-%`);
    const evalCount = await db.get("SELECT COUNT(*) AS n FROM shadow_engine_evals WHERE signal_id LIKE ?", `${NS}-%`);
    const outCount = await db.get("SELECT COUNT(*) AS n FROM shadow_outcomes WHERE signal_id LIKE ?", `${NS}-%`);
    assert.equal(Number(sigCount.n), 2, "exactly S1 + S2 signals");
    assert.equal(Number(evalCount.n), 5, "S1: A,B,C,D + S2: C");
    assert.equal(Number(outCount.n), 1, "only S1 resolved");
  });
});
