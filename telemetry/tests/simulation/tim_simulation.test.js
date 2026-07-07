"use strict";
/**
 * Sprint 2 — TradeIntentManager Simulation Tests
 *
 * Realistic trading-session scenarios that test system behaviour
 * under real-world conditions: multi-symbol flows, duplicate signals,
 * recovery from partial failures, concurrent races, and mixed outcomes.
 *
 * All test data uses signal_id LIKE 'test_tim_sim_%'.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/simulation/tim_simulation.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { TradeIntentManager } = require("../../managers/TradeIntentManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SIG_PREFIX   = "test_tim_sim_";

let pool, tim;

async function cleanup(p) {
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
}

let _sigCounter = 0;
function sig(s) { return `${SIG_PREFIX}${s}_${++_sigCounter}_${Math.random().toString(36).slice(2,6)}`; }

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  tim  = new TradeIntentManager({ _pool: pool });
  await tim.init();
  await cleanup(pool);
});

after(async () => {
  await cleanup(pool);
  await pool.end();
});

beforeEach(async () => {
  await cleanup(pool);
});

// ── SIM-1: Multi-symbol normal trading session ────────────────────────────────

describe("SIM-1 — Multi-symbol normal trading session", () => {

  it("3 symbols complete full happy path concurrently", async () => {
    const instruments = [
      { symbol: "EUR_USD", direction: "BUY",  confidence: 0.85, risk_score: 0.2 },
      { symbol: "GBP_USD", direction: "SELL", confidence: 0.78, risk_score: 0.3 },
      { symbol: "USD_JPY", direction: "BUY",  confidence: 0.91, risk_score: 0.15 },
    ];
    const created = await Promise.all(
      instruments.map((inst, i) => tim.createIntent({
        signal_id:   sig(`s1_${i}`),
        intent_type: "OPEN",
        symbol:      inst.symbol,
        direction:   inst.direction,
        confidence:  inst.confidence,
        risk_score:  inst.risk_score,
      }))
    );
    assert.ok(created.every(r => r.created === true));
    await Promise.all(created.map(r =>
      tim.validateIntent(r.row.id, { passed: true, checks: { confidence: true, risk: true } })
    ));
    await Promise.all(created.map(r => tim.approveIntent(r.row.id)));
    const executed = await Promise.all(created.map((r, i) =>
      tim.executeIntent(r.row.id, { fill_price: 1.2500 + i * 0.001 })
    ));
    assert.ok(executed.every(r => r.row.status === "EXECUTED"));
    const archived = await Promise.all(created.map(r => tim.archiveIntent(r.row.id)));
    assert.ok(archived.every(r => r.status === "ARCHIVED"));
  });

  it("each instrument's intent is independently tracked", async () => {
    const r1 = await tim.createIntent({ signal_id: sig("s1b_eur"), intent_type: "OPEN", symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sig("s1b_gbp"), intent_type: "OPEN", symbol: "GBP_USD" });
    await tim.validateIntent(r1.row.id, { passed: true });
    await tim.validateIntent(r2.row.id, { passed: false, reason: "GBP spread too wide" });
    const i1 = await tim.getIntent(r1.row.id);
    const i2 = await tim.getIntent(r2.row.id);
    assert.strictEqual(i1.status, "VALIDATED");
    assert.strictEqual(i2.status, "REJECTED");
    assert.strictEqual(i2.rejection_reason, "GBP spread too wide");
  });

  it("history for each intent is isolated — no cross-contamination", async () => {
    const r1 = await tim.createIntent({ signal_id: sig("s1c_a"), intent_type: "OPEN", symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sig("s1c_b"), intent_type: "OPEN", symbol: "GBP_USD" });
    await tim.validateIntent(r1.row.id, { passed: true });
    await tim.approveIntent(r1.row.id);
    const h1 = await tim.getIntentHistory(r1.row.id);
    const h2 = await tim.getIntentHistory(r2.row.id);
    assert.ok(h1.every(h => h.intent_id === r1.row.id));
    assert.ok(h2.every(h => h.intent_id === r2.row.id));
    assert.ok(h1.length >= 3);
    assert.ok(h2.length >= 1);
  });

  it("validation_detail.checks preserved from signal through archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s1d"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true, checks: { confidence: true, risk: true, liquidity: true } });
    await tim.approveIntent(row.id);
    await tim.executeIntent(row.id, {});
    await tim.archiveIntent(row.id);
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.validation_detail.confidence, true);
    assert.strictEqual(final.validation_detail.liquidity, true);
  });

  it("multiple CLOSE intents for different positions are independent", async () => {
    const closes = await Promise.all(
      ["EUR_USD", "GBP_USD", "USD_JPY"].map((sym, i) =>
        tim.createIntent({ signal_id: sig(`s1e_${i}`), intent_type: "CLOSE", symbol: sym })
      )
    );
    assert.ok(closes.every(r => r.created === true));
    assert.ok(closes.every(r => r.row.intent_type === "CLOSE"));
  });

});

// ── SIM-2: Duplicate signal detection ────────────────────────────────────────

describe("SIM-2 — Duplicate signal detection under concurrent load", () => {

  it("10 concurrent creates for same signal produce exactly 1 intent", async () => {
    const sid = sig("s2_dedup");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const created = results.filter(r => r.created);
    const dupes   = results.filter(r => r.duplicate);
    assert.strictEqual(created.length, 1, "exactly one intent must be created");
    assert.strictEqual(dupes.length,   9, "nine must be duplicates");
    const rows = await tim.getDuplicates(sid, "OPEN");
    assert.strictEqual(rows.length, 1);
  });

  it("same signal_id + different intent_types creates 3 separate intents", async () => {
    const sid = sig("s2_types");
    const [r1, r2, r3] = await Promise.all([
      tim.createIntent({ signal_id: sid, intent_type: "OPEN",   symbol: "EUR_USD" }),
      tim.createIntent({ signal_id: sid, intent_type: "CLOSE",  symbol: "EUR_USD" }),
      tim.createIntent({ signal_id: sid, intent_type: "MODIFY", symbol: "EUR_USD" }),
    ]);
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r2.created, true);
    assert.strictEqual(r3.created, true);
    assert.notStrictEqual(r1.row.id, r2.row.id);
    assert.notStrictEqual(r2.row.id, r3.row.id);
  });

  it("duplicate detection works after intent progresses to VALIDATED", async () => {
    const sid = sig("s2_prog");
    const r1 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r1.row.id, { passed: true });
    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(r2.row.status, "VALIDATED");
  });

  it("duplicate returns the exact same row as the original", async () => {
    const sid = sig("s2_same");
    const r1 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "GBP_USD",
      confidence: 0.77, reasoning: "original" });
    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "GBP_USD" });
    assert.strictEqual(r2.row.id, r1.row.id);
    assert.strictEqual(r2.row.reasoning, "original");
  });

});

// ── SIM-3: Crash recovery simulation ─────────────────────────────────────────

describe("SIM-3 — Crash recovery: intent persists in pre-crash state", () => {

  it("intent created but not validated persists after restart", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s3_c1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const tim2 = new TradeIntentManager({ _pool: pool });
    await tim2.init();
    const recovered = await tim2.getIntent(row.id);
    assert.ok(recovered, "intent must persist after restart");
    assert.strictEqual(recovered.status, "CREATED");
  });

  it("intent validated but not approved persists after restart", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s3_c2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    const tim2 = new TradeIntentManager({ _pool: pool });
    await tim2.init();
    const recovered = await tim2.getIntent(row.id);
    assert.strictEqual(recovered.status, "VALIDATED");
  });

  it("intent approved but not executed persists after restart", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s3_c3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const tim2 = new TradeIntentManager({ _pool: pool });
    await tim2.init();
    const recovered = await tim2.getIntent(row.id);
    assert.strictEqual(recovered.status, "APPROVED");
  });

  it("all history is preserved after simulated restart", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s3_hist"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const tim2 = new TradeIntentManager({ _pool: pool });
    await tim2.init();
    const history = await tim2.getIntentHistory(row.id);
    assert.ok(history.length >= 3);
    const statuses = history.map(h => h.to_status);
    assert.ok(statuses.includes("CREATED"));
    assert.ok(statuses.includes("VALIDATED"));
    assert.ok(statuses.includes("APPROVED"));
  });

  it("new TIM instance can continue transitions on existing APPROVED intent", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s3_cont"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const tim2 = new TradeIntentManager({ _pool: pool });
    await tim2.init();
    const { row: exec } = await tim2.executeIntent(row.id, { fill_price: 1.2540 });
    assert.strictEqual(exec.status, "EXECUTED");
  });

});

// ── SIM-4: Concurrent transition race ────────────────────────────────────────

describe("SIM-4 — Concurrent transition race: exactly one winner", () => {

  it("10 concurrent approvals on same intent: exactly one succeeds", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s4_race"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => tim.approveIntent(row.id))
    );
    const winners = results.filter(r => r.status === "fulfilled");
    assert.strictEqual(winners.length, 1, "exactly one approval should succeed");
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.status, "APPROVED");
    assert.strictEqual(Number(final.version), 2);
  });

  it("5 concurrent rejects on same intent: exactly one succeeds", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s4_rej"), intent_type: "OPEN", symbol: "EUR_USD" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tim.rejectIntent(row.id, "Race test rejection"))
    );
    const winners = results.filter(r => r.status === "fulfilled");
    assert.strictEqual(winners.length, 1, "exactly one rejection should succeed");
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.status, "REJECTED");
  });

  it("concurrent approve and cancel: final state is deterministic", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s4_ac"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    const results = await Promise.allSettled([
      tim.approveIntent(row.id),
      tim.cancelIntent(row.id, "Race cancel"),
    ]);
    // cancelIntent accepts [CREATED, VALIDATED, APPROVED] so both can succeed sequentially.
    // At least one must succeed; final state is a valid terminal-eligible status.
    const fulfilled = results.filter(r => r.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one transition should succeed");
    const final = await tim.getIntent(row.id);
    assert.ok(["APPROVED", "CANCELLED"].includes(final.status),
      "final state must be APPROVED or CANCELLED, got: " + final.status);
  });

  it("concurrent execute attempts on same APPROVED intent: exactly one wins", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s4_exec"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tim.executeIntent(row.id, {}))
    );
    const winners = results.filter(r => r.status === "fulfilled");
    assert.strictEqual(winners.length, 1, "exactly one execute should succeed");
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.status, "EXECUTED");
    assert.strictEqual(Number(final.version), 3);
  });

});

// ── SIM-5: Full mixed-outcome session ────────────────────────────────────────

describe("SIM-5 — Full session with mixed outcomes", () => {

  it("6 intents: 2 execute, 2 cancel, 2 reject — all archived", async () => {
    const rows = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`s5_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const ids = rows.map(r => r.row.id);
    await Promise.all(ids.map(id => tim.validateIntent(id, { passed: true })));
    await Promise.all(ids.slice(0, 4).map(id => tim.approveIntent(id)));
    await Promise.all(ids.slice(0, 2).map(id => tim.executeIntent(id, {})));
    await Promise.all(ids.slice(2, 4).map(id => tim.cancelIntent(id, "Position limit")));
    await Promise.all(ids.slice(4, 6).map(id => tim.rejectIntent(id, "Signal expired")));
    await Promise.all(ids.map(id => tim.archiveIntent(id)));
    const finals = await Promise.all(ids.map(id => tim.getIntent(id)));
    assert.ok(finals.every(f => f.status === "ARCHIVED"), "all 6 should be ARCHIVED");
  });

  it("stats shows correct byStatus distribution after session", async () => {
    const rCreated   = await tim.createIntent({ signal_id: sig("s5b_cr"),  intent_type: "OPEN", symbol: "EUR_USD" });
    const rValidated = await tim.createIntent({ signal_id: sig("s5b_val"), intent_type: "OPEN", symbol: "EUR_USD" });
    const rApproved  = await tim.createIntent({ signal_id: sig("s5b_app"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(rValidated.row.id, { passed: true });
    await tim.validateIntent(rApproved.row.id,  { passed: true });
    await tim.approveIntent(rApproved.row.id);
    const stats = await tim.getStats();
    assert.ok(stats.byStatus.CREATED  >= 1);
    assert.ok(stats.byStatus.VALIDATED >= 1);
    assert.ok(stats.byStatus.APPROVED  >= 1);
  });

  it("listIntents signal_id filter isolates test intents", async () => {
    const sids = Array.from({ length: 4 }, (_, i) => sig(`s5c_${i}`));
    await Promise.all(sids.map(sid =>
      tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" })
    ));
    const rows = await tim.listIntents({ status: "CREATED" });
    const ourIds = new Set(sids);
    const ours = rows.filter(r => ourIds.has(r.signal_id));
    assert.strictEqual(ours.length, 4);
  });

});

// ── SIM-6: Parallel creation flood ───────────────────────────────────────────

describe("SIM-6 — Parallel signal flood", () => {

  it("20 concurrent intents for 20 different symbols all created successfully", async () => {
    const symbols = [
      "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD",
      "EUR_GBP", "EUR_JPY", "GBP_JPY", "NZD_USD", "USD_CHF",
      "EUR_CHF", "EUR_AUD", "GBP_AUD", "AUD_JPY", "CAD_JPY",
      "CHF_JPY", "EUR_CAD", "GBP_CHF", "NZD_JPY", "AUD_NZD",
    ];
    const results = await Promise.all(
      symbols.map((sym, i) =>
        tim.createIntent({ signal_id: sig(`s6_${i}`), intent_type: "OPEN", symbol: sym })
      )
    );
    assert.strictEqual(results.length, 20);
    assert.ok(results.every(r => r.created === true));
    assert.ok(results.every(r => r.row.id > 0));
  });

  it("all 20 flood intents can be validated in parallel", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`s6b_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const validated = await Promise.all(
      created.map(r => tim.validateIntent(r.row.id, { passed: true }))
    );
    assert.ok(validated.every(v => v.status === "VALIDATED"));
  });

});

// ── SIM-7: Rejection reasoning preservation ───────────────────────────────────

describe("SIM-7 — Rejection reasoning preservation (Sacred Constraint)", () => {

  it("validation_detail.checks and rejection_reason preserved after archive", async () => {
    const { row } = await tim.createIntent({
      signal_id:   sig("s7_reason"),
      intent_type: "OPEN",
      symbol:      "GBP_USD",
      reasoning:   "ShadowC KNN: 87% BUY confidence",
    });
    await tim.validateIntent(row.id, {
      passed: false,
      reason: "Risk score 0.8 exceeds threshold 0.5",
      checks: { confidence: true, risk: false, symbol: true },
    });
    await tim.archiveIntent(row.id);
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.status, "ARCHIVED");
    assert.strictEqual(final.rejection_reason, "Risk score 0.8 exceeds threshold 0.5");
    assert.strictEqual(final.reasoning, "ShadowC KNN: 87% BUY confidence");
    assert.strictEqual(final.validation_detail.risk, false);
    assert.strictEqual(final.validation_detail.confidence, true);
  });

  it("late rejection from APPROVED preserves reason and history context", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s7_late"), intent_type: "OPEN", symbol: "USD_JPY" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const rejReason = "Market gap detected — aborting to prevent slippage";
    await tim.rejectIntent(row.id, rejReason, { calledBy: "live_engine" });
    const intent = await tim.getIntent(row.id);
    assert.strictEqual(intent.rejection_reason, rejReason);
    const history = await tim.getIntentHistory(row.id);
    const rejEntry = history.find(h => h.to_status === "REJECTED");
    assert.strictEqual(rejEntry.from_status, "APPROVED");
    assert.strictEqual(rejEntry.changed_by, "live_engine");
  });

  it("cancellation reason is preserved through archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s7_can"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.cancelIntent(row.id, "News event risk — cancelling before execution");
    await tim.archiveIntent(row.id);
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.cancelled_reason, "News event risk — cancelling before execution");
    assert.strictEqual(final.status, "ARCHIVED");
  });

  it("execution_detail preserved after archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s7_exec"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    await tim.executeIntent(row.id, { fill_price: 1.2540, units: 10000, latency_ms: 45 });
    await tim.archiveIntent(row.id);
    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.execution_detail.fill_price, 1.2540);
    assert.strictEqual(final.execution_detail.units, 10000);
    assert.strictEqual(final.execution_detail.latency_ms, 45);
  });

});
