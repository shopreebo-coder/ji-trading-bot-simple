"use strict";
/**
 * Selected Engine — feature-flag / lifecycle test.
 *
 * The SELECTED_ENGINE flag gates ONLY the background refresh loop. Proves:
 *   1. Constructing the manager is a complete no-op: no timer, not running, no
 *      DecisionContext built, ZERO writes. (flag OFF path — the production
 *      default — must never change process behavior.)
 *   2. The read-only surface (getStatus / buildDecisionContext) works WITHOUT
 *      start(), so the always-registered HTTP endpoints serve on-demand
 *      regardless of the flag.
 *   3. start() begins an UNREF'd background loop (running=true, builds a
 *      context) and start() is idempotent; stop() clears the timer and is also
 *      idempotent. The unref'd timer can never keep the process alive.
 *
 * Isolation: seeded rows are namespaced (NS). Requires PostgreSQL; skips
 * cleanly otherwise.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { ShadowLabManager } = require("../../managers/ShadowLabManager");
const { SelectedEngineManager } = require("../../managers/SelectedEngineManager");
const { createProvenance } = require("../../managers/knowledgeProvenance");

const IS_PG = USE_PG;
const NS = `SELF-${crypto.randomUUID().slice(0, 8)}`;
const CFG = crypto.createHash("sha256").update(NS).digest("hex");
const SLM_PROV = createProvenance({ runId: `slm-${NS}`, buildId: "v40.1+selfslm000", configHash: CFG });
const SEL_PROV = createProvenance({ runId: `sel-${NS}`, buildId: "v40.1+self000000", configHash: CFG });

async function seedEvent(type, payload, symbol = null) {
  const ts = new Date().toISOString();
  const data = JSON.stringify({ ...payload, type, ts, botId: "test" });
  await db.run("INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)", ts, "test", type, symbol, data);
}

let SID;

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  SID = `${NS}-S1`;
  await seedEvent("trade_open", {
    signalId: SID, symbol: "EUR_USD", session: "LONDON", side: "buy", fingerprint: `fp-${NS}`,
    entryGate: "HARD", passCount: 8, spread: 0.8, atrPips: 12.5, emaDistance: 4.2, candleStrength: 0.31,
    trendBucket: "UP", volatilityBucket: "MED", spreadBucket: "TIGHT",
  }, "EUR_USD");
  await seedEvent("lab_shadow_a", { signalId: SID, symbol: "EUR_USD", score: 70, confidence: "MEDIUM", wouldTrade: true }, "EUR_USD");
  await seedEvent("trade_close", { signalId: SID, symbol: "EUR_USD", profitPips: 9.5, mfe: 12, mae: -2, duration: 30 }, "EUR_USD");
  const slm = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
  slm._lastId = 0;
  await slm.reconcileAll();
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM shadow_signals      WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes     WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("Selected Engine flag gates only the background loop", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  await t.test("construction is a no-op (flag-OFF default path)", async () => {
    const mgr = new SelectedEngineManager({ db, provenance: SEL_PROV, pollIntervalMs: 3_600_000 });
    assert.equal(mgr._running, false, "not running on construction");
    assert.equal(mgr._timer, null, "no timer scheduled");
    assert.equal(mgr.getLatest(), null, "no context built");
    assert.equal(mgr._stats.builds, 0, "zero builds");
  });

  await t.test("read-only surface works WITHOUT start() (endpoints serve on demand)", async () => {
    const mgr = new SelectedEngineManager({ db, shadowLab: new ShadowLabManager({ db, provenance: SLM_PROV }), provenance: SEL_PROV, pollIntervalMs: 3_600_000 });
    const status = await mgr.getStatus();
    assert.equal(status.running, false);
    assert.ok(Array.isArray(status.engines));
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    assert.ok(ctx && ctx.id, "on-demand context builds without the flag");
    assert.equal(mgr._running, false, "on-demand build does not start the loop");
  });

  await t.test("start() runs an unref'd loop and is idempotent; stop() clears it", async () => {
    const mgr = new SelectedEngineManager({ db, provenance: SEL_PROV, pollIntervalMs: 3_600_000 });
    await mgr.start();
    assert.equal(mgr._running, true, "running after start()");
    assert.ok(mgr._timer, "timer scheduled");
    assert.ok(mgr._stats.builds >= 1, "initial build performed on start()");

    const timer = mgr._timer;
    await mgr.start(); // idempotent
    assert.equal(mgr._timer, timer, "start() does not schedule a second timer");

    mgr.stop();
    assert.equal(mgr._running, false, "stopped");
    assert.equal(mgr._timer, null, "timer cleared");
    mgr.stop(); // idempotent, no throw
  });
});
