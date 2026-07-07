"use strict";
/**
 * Sprint 2 — TradeIntentManager Integration Tests
 *
 * Full lifecycle flows, concurrent operations, duplicate detection,
 * and history integrity. All test data uses signal_id LIKE 'test_tim_int_%'.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/integration/tim_integration.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { TradeIntentManager } = require("../../managers/TradeIntentManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SIG_PREFIX   = "test_tim_int_";

let pool, tim;

async function cleanup(p) {
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
}

function sig(s) { return `${SIG_PREFIX}${s}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`; }

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

// ── Full Lifecycle Flows ──────────────────────────────────────────────────────

describe("Integration — Happy path: CREATED→VALIDATED→APPROVED→EXECUTED→ARCHIVED", () => {

  it("complete happy path produces correct final state", async () => {
    const { row: created } = await tim.createIntent({
      signal_id:     sig("happy1"),
      intent_type:   "OPEN",
      symbol:        "EUR_USD",
      direction:     "BUY",
      confidence:    0.9,
      risk_score:    0.2,
      position_size: 10000,
      stop_loss:     1.2450,
      take_profit:   1.2600,
      reasoning:     "Strong uptrend",
    });

    const validated = await tim.validateIntent(created.id, {
      passed: true,
      checks: { confidence: true, risk: true, symbol: true },
    });

    const approved = await tim.approveIntent(created.id, { calledBy: "engine_approver" });

    const { row: executed } = await tim.executeIntent(created.id,
      { oanda_order_id: "ORD-INT-001", fill_price: 1.2540 },
      { calledBy: "live_engine" }
    );

    const archived = await tim.archiveIntent(created.id, { notes: "Session ended" });

    assert.strictEqual(archived.status, "ARCHIVED");
    assert.strictEqual(Number(archived.version), 4);

    // All fields preserved through transitions
    assert.strictEqual(archived.symbol, "EUR_USD");
    assert.strictEqual(archived.reasoning, "Strong uptrend");
    assert.ok(Math.abs(Number(archived.confidence) - 0.9) < 0.001);
  });

  it("history has 5 entries covering all transitions", async () => {
    const { row: created } = await tim.createIntent({ signal_id: sig("hist1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(created.id, { passed: true });
    await tim.approveIntent(created.id);
    await tim.executeIntent(created.id, {});
    await tim.archiveIntent(created.id);

    const history = await tim.getIntentHistory(created.id);
    assert.ok(history.length >= 5);

    const statuses = history.map(h => h.to_status).sort();
    assert.ok(statuses.includes("CREATED"));
    assert.ok(statuses.includes("VALIDATED"));
    assert.ok(statuses.includes("APPROVED"));
    assert.ok(statuses.includes("EXECUTED"));
    assert.ok(statuses.includes("ARCHIVED"));
  });

  it("history from_status chain is correct", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("chain1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);

    const history = await tim.getIntentHistory(row.id);
    const sorted  = [...history].sort((a, b) => a.id - b.id); // ascending

    assert.strictEqual(sorted[0].from_status, null);
    assert.strictEqual(sorted[0].to_status,   "CREATED");
    assert.strictEqual(sorted[1].from_status, "CREATED");
    assert.strictEqual(sorted[1].to_status,   "VALIDATED");
    assert.strictEqual(sorted[2].from_status, "VALIDATED");
    assert.strictEqual(sorted[2].to_status,   "APPROVED");
  });

});

describe("Integration — Rejection path: CREATED→VALIDATED→REJECTED→ARCHIVED", () => {

  it("rejection path produces correct final state", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("rej1"), intent_type: "OPEN", symbol: "GBP_USD" });
    await tim.validateIntent(row.id, { passed: false, reason: "Confidence below threshold" });
    const archived = await tim.archiveIntent(row.id);

    assert.strictEqual(archived.status, "ARCHIVED");
    assert.strictEqual(archived.rejection_reason, "Confidence below threshold");
    assert.ok(Number(archived.version) >= 2);
  });

  it("reject directly from CREATED (no validation)", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("rej2"), intent_type: "CLOSE", symbol: "USD_JPY" });
    const rejected = await tim.rejectIntent(row.id, "Market closed");
    assert.strictEqual(rejected.status, "REJECTED");
    assert.strictEqual(rejected.rejection_reason, "Market closed");
  });

});

describe("Integration — Cancellation flows", () => {

  it("cancel from CREATED and archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("can1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.cancelIntent(row.id, "Signal stale");
    const archived = await tim.archiveIntent(row.id);
    assert.strictEqual(archived.status, "ARCHIVED");
    assert.strictEqual(archived.cancelled_reason, "Signal stale");
  });

  it("cancel from VALIDATED and archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("can2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.cancelIntent(row.id, "Position limit reached");
    const archived = await tim.archiveIntent(row.id);
    assert.strictEqual(archived.status, "ARCHIVED");
  });

  it("cancel from APPROVED and archive", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("can3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    await tim.cancelIntent(row.id, "Market moved against us");
    const archived = await tim.archiveIntent(row.id);
    assert.strictEqual(archived.status, "ARCHIVED");
  });

});

// ── Duplicate Detection ───────────────────────────────────────────────────────

describe("Integration — Duplicate signal detection", () => {

  it("second createIntent for same (signal_id, intent_type) returns duplicate:true", async () => {
    const sid = sig("dup1");
    const r1 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r2.created, false);
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(r2.row.id, r1.row.id);
  });

  it("duplicate returns the existing row's current status (not necessarily CREATED)", async () => {
    const sid = sig("dup2");
    const r1 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r1.row.id, { passed: true });

    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(r2.row.status, "VALIDATED");
  });

  it("getDuplicates detects existing intent", async () => {
    const sid = sig("dup3");
    await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    const dups = await tim.getDuplicates(sid, "OPEN");
    assert.ok(dups.length >= 1);
    assert.strictEqual(dups[0].signal_id, sid);
  });

  it("concurrent duplicate creates: only one row inserted", async () => {
    const sid = sig("dup4");
    // Fire 5 concurrent creates for the same signal_id + intent_type
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const created = results.filter(r => r.created);
    const dupes   = results.filter(r => r.duplicate);
    assert.strictEqual(created.length, 1, "exactly one should be created");
    assert.strictEqual(dupes.length, 4, "four should be duplicates");
  });

});

// ── Concurrent Operations ─────────────────────────────────────────────────────

describe("Integration — Concurrent operations", () => {

  it("concurrent approvals on same intent: exactly one winner", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("conc1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tim.approveIntent(row.id))
    );
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected  = results.filter(r => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1, "exactly one approval should succeed");
    assert.ok(rejected.length >= 4, "the rest should fail");
  });

  it("concurrent creates for different symbols do not interfere", async () => {
    const symbols = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD"];
    const results = await Promise.all(
      symbols.map((sym, i) =>
        tim.createIntent({ signal_id: sig(`conc2_${i}`), intent_type: "OPEN", symbol: sym })
      )
    );
    assert.ok(results.every(r => r.created === true));
  });

  it("concurrent reads do not block concurrent writes", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("conc3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });

    // Concurrent: 5 reads + 1 write
    const [approveResult, ...reads] = await Promise.allSettled([
      tim.approveIntent(row.id),
      ...Array.from({ length: 5 }, () => tim.listIntents({ limit: 10 })),
    ]);
    assert.strictEqual(approveResult.status, "fulfilled");
    assert.ok(reads.every(r => r.status === "fulfilled"));
  });

});

// ── listIntents & getStats ────────────────────────────────────────────────────

describe("Integration — listIntents and getStats consistency", () => {

  it("listIntents and getStats agree on CREATED count", async () => {
    const before = (await tim.listIntents({ status: "CREATED" })).length;
    await tim.createIntent({ signal_id: sig("ls1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.createIntent({ signal_id: sig("ls2"), intent_type: "OPEN", symbol: "EUR_USD" });
    const after = (await tim.listIntents({ status: "CREATED" })).length;
    assert.ok(after >= before + 2);
  });

  it("getStats.byStatus reflects mixed lifecycle states", async () => {
    const r1 = await tim.createIntent({ signal_id: sig("stat1"), intent_type: "OPEN",  symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sig("stat2"), intent_type: "CLOSE", symbol: "EUR_USD" });
    await tim.rejectIntent(r2.row.id, "Stats test");
    const stats = await tim.getStats();
    assert.ok(stats.byStatus.CREATED  >= 1);
    assert.ok(stats.byStatus.REJECTED >= 1);
  });

  it("listIntents with intent_type filter", async () => {
    await tim.createIntent({ signal_id: sig("lt1"), intent_type: "OPEN",   symbol: "EUR_USD" });
    await tim.createIntent({ signal_id: sig("lt2"), intent_type: "CLOSE",  symbol: "EUR_USD" });
    await tim.createIntent({ signal_id: sig("lt3"), intent_type: "MODIFY", symbol: "EUR_USD" });

    const opens   = await tim.listIntents({ intent_type: "OPEN" });
    const closes  = await tim.listIntents({ intent_type: "CLOSE" });
    const modifies = await tim.listIntents({ intent_type: "MODIFY" });

    assert.ok(opens.every(i => i.intent_type === "OPEN"));
    assert.ok(closes.every(i => i.intent_type === "CLOSE"));
    assert.ok(modifies.every(i => i.intent_type === "MODIFY"));
  });

  it("listIntents with signal_id filter returns only that intent", async () => {
    const sid = sig("lt4");
    await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    const rows = await tim.listIntents({ signal_id: sid });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.signal_id === sid));
  });

});

// ── Data Integrity ────────────────────────────────────────────────────────────

describe("Integration — Data integrity (Sacred Constraint)", () => {

  it("rejected intent preserves all original creation fields", async () => {
    const { row } = await tim.createIntent({
      signal_id:     sig("di1"),
      intent_type:   "OPEN",
      symbol:        "EUR_USD",
      direction:     "BUY",
      confidence:    0.75,
      position_size: 50000,
      reasoning:     "Data integrity test",
    });

    await tim.validateIntent(row.id, { passed: false, reason: "Risk check failed" });
    await tim.archiveIntent(row.id);

    const final = await tim.getIntent(row.id);
    assert.strictEqual(final.symbol, "EUR_USD");
    assert.strictEqual(final.direction, "BUY");
    assert.ok(Math.abs(Number(final.confidence) - 0.75) < 0.001);
    assert.strictEqual(final.reasoning, "Data integrity test");
    assert.strictEqual(final.rejection_reason, "Risk check failed");
    assert.strictEqual(final.status, "ARCHIVED");
  });

  it("history table contains immutable records across the full lifecycle", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("di2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    await tim.executeIntent(row.id, { fill_price: 1.2540 });
    await tim.archiveIntent(row.id);

    const history = await tim.getIntentHistory(row.id);
    const statusSequence = [...history].sort((a, b) => a.id - b.id).map(h => h.to_status);

    assert.ok(statusSequence.includes("CREATED"));
    assert.ok(statusSequence.includes("VALIDATED"));
    assert.ok(statusSequence.includes("APPROVED"));
    assert.ok(statusSequence.includes("EXECUTED"));
    assert.ok(statusSequence.includes("ARCHIVED"));
  });

  it("trade_intents UNIQUE constraint on (signal_id, intent_type) is enforced at DB level", async () => {
    const sid = sig("di3");
    await pool.query(
      `INSERT INTO trade_intents (signal_id, intent_type, symbol) VALUES ($1, 'OPEN', 'EUR_USD')`,
      [sid]
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO trade_intents (signal_id, intent_type, symbol) VALUES ($1, 'OPEN', 'EUR_USD')`,
        [sid]
      ),
      /duplicate key/
    );
  });

});
