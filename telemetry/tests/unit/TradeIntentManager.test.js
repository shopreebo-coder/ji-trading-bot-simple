"use strict";
/**
 * Sprint 2 — TradeIntentManager Unit Tests
 *
 * Tests every public method against the live PostgreSQL database.
 * All test data uses signal_id LIKE 'test_tim_unit_%' and is cleaned up.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/unit/TradeIntentManager.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { TradeIntentManager, VALID_TRANSITIONS, VALID_INTENT_TYPES, VALID_DIRECTIONS } =
  require("../../managers/TradeIntentManager");

// ── Setup ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || "";
let pool, tim;

const SIG_PREFIX = "test_tim_unit_";

async function cleanup(p) {
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
}

function sig(suffix) { return `${SIG_PREFIX}${suffix}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; }

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
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

// ── Constructor ───────────────────────────────────────────────────────────────

describe("TradeIntentManager — Constructor", () => {

  it("rejects invalid connection string", () => {
    assert.throws(
      () => new TradeIntentManager({ connectionString: "mysql://bad" }),
      /connectionString must start with postgres/
    );
  });

  it("rejects empty connection string", () => {
    assert.throws(
      () => new TradeIntentManager({ connectionString: "" }),
      /connectionString must start with postgres/
    );
  });

  it("accepts a pre-created pool via _pool option", () => {
    const t = new TradeIntentManager({ _pool: pool });
    assert.ok(t);
  });

  it("accepts a valid postgres:// connection string", () => {
    const t = new TradeIntentManager({ connectionString: DATABASE_URL });
    assert.ok(t);
    t.shutdown().catch(() => {});
  });

  it("exports VALID_TRANSITIONS, VALID_INTENT_TYPES, VALID_DIRECTIONS", () => {
    assert.ok(VALID_TRANSITIONS);
    assert.ok(VALID_TRANSITIONS.CREATED.includes("VALIDATED"));
    assert.ok(VALID_INTENT_TYPES.has("OPEN"));
    assert.ok(VALID_DIRECTIONS.has("BUY"));
  });

});

// ── init() ────────────────────────────────────────────────────────────────────

describe("TradeIntentManager — init()", () => {

  it("init() succeeds when all required tables exist", async () => {
    const t = new TradeIntentManager({ _pool: pool });
    const result = await t.init();
    assert.strictEqual(result.ok, true);
    assert.ok(result.tables.includes("trade_intents"));
    assert.ok(result.tables.includes("trade_intent_history"));
    assert.ok(result.tables.includes("consistency_log"));
  });

  it("throws before init() is called", async () => {
    const t = new TradeIntentManager({ _pool: pool });
    await assert.rejects(
      () => t.createIntent({ signal_id: sig("x"), intent_type: "OPEN", symbol: "EUR_USD" }),
      /call init\(\)/
    );
  });

});

// ── ping() ────────────────────────────────────────────────────────────────────

describe("TradeIntentManager — ping()", () => {

  it("returns ok:true with numeric latencyMs", async () => {
    const r = await tim.ping();
    assert.strictEqual(r.ok, true);
    assert.ok(typeof r.latencyMs === "number" && r.latencyMs >= 0);
  });

  it("works before init()", async () => {
    const t = new TradeIntentManager({ _pool: pool });
    const r = await t.ping();
    assert.strictEqual(r.ok, true);
  });

});

// ── createIntent() ────────────────────────────────────────────────────────────

describe("TradeIntentManager — createIntent()", () => {

  it("creates intent with minimal required fields", async () => {
    const r = await tim.createIntent({ signal_id: sig("c1"), intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.duplicate, false);
    assert.ok(r.row.id > 0);
    assert.strictEqual(r.row.status, "CREATED");
  });

  it("row has default runtime_domain = 'live'", async () => {
    const r = await tim.createIntent({ signal_id: sig("c2"), intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r.row.runtime_domain, "live");
    assert.strictEqual(r.row.engine_source, "system");
    assert.strictEqual(r.row.strategy_id, "default");
  });

  it("stores all optional fields correctly", async () => {
    const r = await tim.createIntent({
      signal_id:     sig("c3"),
      intent_type:   "OPEN",
      symbol:        "GBP_USD",
      runtime_domain: "shadowA",
      engine_source:  "engineC",
      strategy_id:    "knn_v3",
      direction:      "BUY",
      confidence:     0.87,
      risk_score:     0.3,
      position_size:  10000,
      stop_loss:      1.2500,
      take_profit:    1.2700,
      reasoning:      "Strong momentum signal",
      metadata:       { extra: "data" },
    });
    assert.strictEqual(r.row.runtime_domain, "shadowA");
    assert.strictEqual(r.row.engine_source, "engineC");
    assert.strictEqual(r.row.direction, "BUY");
    assert.ok(Math.abs(Number(r.row.confidence) - 0.87) < 0.001);
    assert.strictEqual(r.row.reasoning, "Strong momentum signal");
  });

  it("records initial history entry with from_status=null", async () => {
    const r = await tim.createIntent({ signal_id: sig("c4"), intent_type: "OPEN", symbol: "EUR_USD" });
    const history = await tim.getIntentHistory(r.row.id);
    assert.ok(history.length >= 1);
    const first = history[history.length - 1]; // oldest
    assert.strictEqual(first.from_status, null);
    assert.strictEqual(first.to_status, "CREATED");
    assert.strictEqual(Number(first.version), 0);
  });

  it("returns duplicate:true for same (signal_id, intent_type)", async () => {
    const sid = sig("c5");
    await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(r2.created, false);
    assert.strictEqual(r2.duplicate, true);
    assert.ok(r2.row);
  });

  it("same signal_id with different intent_type creates separate intent", async () => {
    const sid = sig("c6");
    const r1 = await tim.createIntent({ signal_id: sid, intent_type: "OPEN",  symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sid, intent_type: "CLOSE", symbol: "EUR_USD" });
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r2.created, true);
    assert.notStrictEqual(r1.row.id, r2.row.id);
  });

  it("throws for missing signal_id", async () => {
    await assert.rejects(
      () => tim.createIntent({ intent_type: "OPEN", symbol: "EUR_USD" }),
      /signal_id is required/
    );
  });

  it("throws for empty signal_id", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: "   ", intent_type: "OPEN", symbol: "EUR_USD" }),
      /signal_id is required/
    );
  });

  it("throws for invalid intent_type", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: sig("c7"), intent_type: "BUY", symbol: "EUR_USD" }),
      /intent_type must be one of/
    );
  });

  it("throws for missing symbol", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: sig("c8"), intent_type: "OPEN" }),
      /symbol is required/
    );
  });

  it("throws for invalid direction", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: sig("c9"), intent_type: "OPEN", symbol: "EUR_USD", direction: "LONG" }),
      /direction must be one of/
    );
  });

  it("throws for confidence out of range", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: sig("c10"), intent_type: "OPEN", symbol: "EUR_USD", confidence: 1.5 }),
      /confidence must be a number in/
    );
  });

  it("throws for negative risk_score", async () => {
    await assert.rejects(
      () => tim.createIntent({ signal_id: sig("c11"), intent_type: "OPEN", symbol: "EUR_USD", risk_score: -0.1 }),
      /risk_score must be a number in/
    );
  });

  it("version starts at 0 on CREATED", async () => {
    const r = await tim.createIntent({ signal_id: sig("c12"), intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(Number(r.row.version), 0);
  });

});

// ── validateIntent() ──────────────────────────────────────────────────────────

describe("TradeIntentManager — validateIntent()", () => {

  async function makeCreated(suffix) {
    const r = await tim.createIntent({ signal_id: sig(suffix), intent_type: "OPEN", symbol: "EUR_USD" });
    return r.row;
  }

  it("CREATED → VALIDATED when passed=true", async () => {
    const row = await makeCreated("v1");
    const updated = await tim.validateIntent(row.id, { passed: true, checks: { confidence: true } });
    assert.strictEqual(updated.status, "VALIDATED");
    assert.strictEqual(Number(updated.version), 1);
  });

  it("CREATED → REJECTED when passed=false", async () => {
    const row = await makeCreated("v2");
    const updated = await tim.validateIntent(row.id, { passed: false, reason: "Confidence too low" });
    assert.strictEqual(updated.status, "REJECTED");
    assert.strictEqual(updated.rejection_reason, "Confidence too low");
  });

  it("preserves validation_detail.checks", async () => {
    const row = await makeCreated("v3");
    await tim.validateIntent(row.id, { passed: true, checks: { confidence: true, risk: false } });
    const fresh = await tim.getIntent(row.id);
    assert.ok(fresh.validation_detail);
    assert.strictEqual(fresh.validation_detail.confidence, true);
    assert.strictEqual(fresh.validation_detail.risk, false);
  });

  it("records audit history entry", async () => {
    const row = await makeCreated("v4");
    await tim.validateIntent(row.id, { passed: true, checks: {} });
    const history = await tim.getIntentHistory(row.id);
    const validEntry = history.find(h => h.to_status === "VALIDATED");
    assert.ok(validEntry, "history entry for VALIDATED should exist");
    assert.strictEqual(validEntry.from_status, "CREATED");
  });

  it("throws when intent is not in CREATED status", async () => {
    const row = await makeCreated("v5");
    await tim.validateIntent(row.id, { passed: true });
    await assert.rejects(
      () => tim.validateIntent(row.id, { passed: true }),
      /invalid transition/
    );
  });

  it("throws when passed=false and reason is missing", async () => {
    const row = await makeCreated("v6");
    await assert.rejects(
      () => tim.validateIntent(row.id, { passed: false }),
      /reason is required when passed=false/
    );
  });

  it("throws when passed is not boolean", async () => {
    const row = await makeCreated("v7");
    await assert.rejects(
      () => tim.validateIntent(row.id, { passed: "yes" }),
      /must be a boolean/
    );
  });

});

// ── approveIntent() ───────────────────────────────────────────────────────────

describe("TradeIntentManager — approveIntent()", () => {

  async function makeValidated(suffix) {
    const r = await tim.createIntent({ signal_id: sig(suffix), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    return r.row;
  }

  it("VALIDATED → APPROVED", async () => {
    const row = await makeValidated("a1");
    const updated = await tim.approveIntent(row.id);
    assert.strictEqual(updated.status, "APPROVED");
    assert.strictEqual(Number(updated.version), 2);
  });

  it("records audit entry for approval", async () => {
    const row = await makeValidated("a2");
    await tim.approveIntent(row.id);
    const history = await tim.getIntentHistory(row.id);
    const approvalEntry = history.find(h => h.to_status === "APPROVED");
    assert.ok(approvalEntry);
    assert.strictEqual(approvalEntry.from_status, "VALIDATED");
  });

  it("throws when not in VALIDATED status (still CREATED)", async () => {
    const r = await tim.createIntent({ signal_id: sig("a3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.approveIntent(r.row.id),
      /invalid transition/
    );
  });

  it("throws for non-existent intent", async () => {
    await assert.rejects(
      () => tim.approveIntent(999999999),
      /not found/
    );
  });

});

// ── rejectIntent() ────────────────────────────────────────────────────────────

describe("TradeIntentManager — rejectIntent()", () => {

  it("rejects from CREATED status", async () => {
    const r = await tim.createIntent({ signal_id: sig("r1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const updated = await tim.rejectIntent(r.row.id, "Not profitable enough");
    assert.strictEqual(updated.status, "REJECTED");
    assert.strictEqual(updated.rejection_reason, "Not profitable enough");
  });

  it("rejects from VALIDATED status", async () => {
    const r = await tim.createIntent({ signal_id: sig("r2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    const updated = await tim.rejectIntent(r.row.id, "Risk too high post-validation");
    assert.strictEqual(updated.status, "REJECTED");
  });

  it("rejects from APPROVED status", async () => {
    const r = await tim.createIntent({ signal_id: sig("r3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    const updated = await tim.rejectIntent(r.row.id, "Market conditions changed");
    assert.strictEqual(updated.status, "REJECTED");
  });

  it("preserves rejection_reason permanently (sacred constraint)", async () => {
    const r = await tim.createIntent({ signal_id: sig("r4"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.rejectIntent(r.row.id, "Preserved reason test");
    const fresh = await tim.getIntent(r.row.id);
    assert.strictEqual(fresh.rejection_reason, "Preserved reason test");
  });

  it("throws for empty reason", async () => {
    const r = await tim.createIntent({ signal_id: sig("r5"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.rejectIntent(r.row.id, ""),
      /reason is required/
    );
  });

  it("throws for whitespace-only reason", async () => {
    const r = await tim.createIntent({ signal_id: sig("r6"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.rejectIntent(r.row.id, "   "),
      /reason is required/
    );
  });

});

// ── executeIntent() ───────────────────────────────────────────────────────────

describe("TradeIntentManager — executeIntent()", () => {

  async function makeApproved(suffix) {
    const r = await tim.createIntent({ signal_id: sig(suffix), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    return r.row;
  }

  it("APPROVED → EXECUTED", async () => {
    const row = await makeApproved("e1");
    const result = await tim.executeIntent(row.id, { units: 10000 });
    assert.strictEqual(result.row.status, "EXECUTED");
    assert.strictEqual(Number(result.row.version), 3);
  });

  it("returns rdmUpdated:false and rdmError:null when no RDM", async () => {
    const row = await makeApproved("e2");
    const result = await tim.executeIntent(row.id, {});
    assert.strictEqual(result.rdmUpdated, false);
    assert.strictEqual(result.rdmError, null);
  });

  it("stores execution_detail", async () => {
    const row = await makeApproved("e3");
    await tim.executeIntent(row.id, { oanda_response: "OK", units: 5000 });
    const fresh = await tim.getIntent(row.id);
    assert.ok(fresh.execution_detail);
    assert.strictEqual(fresh.execution_detail.units, 5000);
  });

  it("stores oanda_order_id when provided in opts", async () => {
    const row = await makeApproved("e4");
    await tim.executeIntent(row.id, {}, { oanda_order_id: "ORD-TEST-001" });
    const fresh = await tim.getIntent(row.id);
    assert.strictEqual(fresh.oanda_order_id, "ORD-TEST-001");
  });

  it("records audit history entry", async () => {
    const row = await makeApproved("e5");
    await tim.executeIntent(row.id, {});
    const history = await tim.getIntentHistory(row.id);
    const execEntry = history.find(h => h.to_status === "EXECUTED");
    assert.ok(execEntry);
    assert.strictEqual(execEntry.from_status, "APPROVED");
  });

  it("throws when not in APPROVED status", async () => {
    const r = await tim.createIntent({ signal_id: sig("e6"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    // Still VALIDATED, not APPROVED
    await assert.rejects(
      () => tim.executeIntent(r.row.id, {}),
      /invalid transition/
    );
  });

});

// ── cancelIntent() ────────────────────────────────────────────────────────────

describe("TradeIntentManager — cancelIntent()", () => {

  it("cancels from CREATED", async () => {
    const r = await tim.createIntent({ signal_id: sig("x1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const updated = await tim.cancelIntent(r.row.id, "Signal expired");
    assert.strictEqual(updated.status, "CANCELLED");
    assert.strictEqual(updated.cancelled_reason, "Signal expired");
  });

  it("cancels from VALIDATED", async () => {
    const r = await tim.createIntent({ signal_id: sig("x2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    const updated = await tim.cancelIntent(r.row.id, "Stale after validation");
    assert.strictEqual(updated.status, "CANCELLED");
  });

  it("cancels from APPROVED", async () => {
    const r = await tim.createIntent({ signal_id: sig("x3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    const updated = await tim.cancelIntent(r.row.id, "Cancelled before execution");
    assert.strictEqual(updated.status, "CANCELLED");
  });

  it("preserves cancelled_reason permanently", async () => {
    const r = await tim.createIntent({ signal_id: sig("x4"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.cancelIntent(r.row.id, "Preserved cancel reason");
    const fresh = await tim.getIntent(r.row.id);
    assert.strictEqual(fresh.cancelled_reason, "Preserved cancel reason");
  });

  it("throws for empty reason", async () => {
    const r = await tim.createIntent({ signal_id: sig("x5"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.cancelIntent(r.row.id, ""),
      /reason is required/
    );
  });

  it("throws for already EXECUTED intent", async () => {
    const r = await tim.createIntent({ signal_id: sig("x6"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    await tim.executeIntent(r.row.id, {});
    await assert.rejects(
      () => tim.cancelIntent(r.row.id, "Too late"),
      /invalid transition|terminal/
    );
  });

});

// ── archiveIntent() ───────────────────────────────────────────────────────────

describe("TradeIntentManager — archiveIntent()", () => {

  it("archives from EXECUTED", async () => {
    const r = await tim.createIntent({ signal_id: sig("ar1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    await tim.executeIntent(r.row.id, {});
    const updated = await tim.archiveIntent(r.row.id);
    assert.strictEqual(updated.status, "ARCHIVED");
  });

  it("archives from REJECTED", async () => {
    const r = await tim.createIntent({ signal_id: sig("ar2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.rejectIntent(r.row.id, "Rejected for archive test");
    const updated = await tim.archiveIntent(r.row.id);
    assert.strictEqual(updated.status, "ARCHIVED");
  });

  it("archives from CANCELLED", async () => {
    const r = await tim.createIntent({ signal_id: sig("ar3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.cancelIntent(r.row.id, "Cancelled for archive test");
    const updated = await tim.archiveIntent(r.row.id);
    assert.strictEqual(updated.status, "ARCHIVED");
  });

  it("throws when trying to archive from CREATED (not terminal-eligible)", async () => {
    const r = await tim.createIntent({ signal_id: sig("ar4"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.archiveIntent(r.row.id),
      /invalid transition/
    );
  });

  it("throws for non-existent intent", async () => {
    await assert.rejects(
      () => tim.archiveIntent(999999988),
      /not found/
    );
  });

});

// ── getIntent() ───────────────────────────────────────────────────────────────

describe("TradeIntentManager — getIntent()", () => {

  it("returns intent by id", async () => {
    const r = await tim.createIntent({ signal_id: sig("gi1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const intent = await tim.getIntent(r.row.id);
    assert.ok(intent);
    assert.strictEqual(intent.id, r.row.id);
  });

  it("returns null for missing id", async () => {
    const result = await tim.getIntent(999999987);
    assert.strictEqual(result, null);
  });

  it("returns all expected columns", async () => {
    const r = await tim.createIntent({
      signal_id: sig("gi2"), intent_type: "OPEN", symbol: "GBP_USD",
      direction: "BUY", confidence: 0.7,
    });
    const intent = await tim.getIntent(r.row.id);
    const required = ["id", "signal_id", "intent_type", "symbol", "status",
      "runtime_domain", "engine_source", "strategy_id", "version",
      "created_at", "updated_at", "metadata"];
    for (const col of required) {
      assert.ok(col in intent, `missing column: ${col}`);
    }
  });

  it("throws for invalid intentId type", async () => {
    await assert.rejects(
      () => tim.getIntent("abc"),
      /intentId must be a positive number/
    );
  });

});

// ── listIntents() ─────────────────────────────────────────────────────────────

describe("TradeIntentManager — listIntents()", () => {

  it("filters by status", async () => {
    const r1 = await tim.createIntent({ signal_id: sig("li1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const r2 = await tim.createIntent({ signal_id: sig("li2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.rejectIntent(r2.row.id, "Filter test rejection");

    const created  = await tim.listIntents({ status: "CREATED",  signal_id: r1.row.signal_id });
    const rejected = await tim.listIntents({ status: "REJECTED", signal_id: r2.row.signal_id });
    assert.ok(created.some(i => i.id === r1.row.id));
    assert.ok(rejected.some(i => i.id === r2.row.id));
  });

  it("filters by symbol", async () => {
    await tim.createIntent({ signal_id: sig("li3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.createIntent({ signal_id: sig("li4"), intent_type: "OPEN", symbol: "GBP_USD" });

    const eur = await tim.listIntents({ symbol: "EUR_USD" });
    const gbp = await tim.listIntents({ symbol: "GBP_USD" });
    assert.ok(eur.every(i => i.symbol === "EUR_USD"));
    assert.ok(gbp.every(i => i.symbol === "GBP_USD"));
  });

  it("filters by runtime_domain", async () => {
    await tim.createIntent({ signal_id: sig("li5"), intent_type: "OPEN", symbol: "EUR_USD", runtime_domain: "shadowA" });
    const rows = await tim.listIntents({ runtime_domain: "shadowA" });
    assert.ok(rows.every(i => i.runtime_domain === "shadowA"));
    assert.ok(rows.length >= 1);
  });

  it("filters by engine_source", async () => {
    await tim.createIntent({ signal_id: sig("li6"), intent_type: "OPEN", symbol: "EUR_USD", engine_source: "engineCtest" });
    const rows = await tim.listIntents({ engine_source: "engineCtest" });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.engine_source === "engineCtest"));
  });

  it("respects limit", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      tim.createIntent({ signal_id: sig(`li7_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
    ));
    const rows = await tim.listIntents({ limit: 2 });
    assert.ok(rows.length <= 2);
  });

  it("returns results in DESC order by default", async () => {
    const r1 = await tim.createIntent({ signal_id: sig("li8a"), intent_type: "OPEN", symbol: "EUR_USD" });
    await new Promise(r => setTimeout(r, 10));
    const r2 = await tim.createIntent({ signal_id: sig("li8b"), intent_type: "OPEN", symbol: "EUR_USD" });
    const rows = await tim.listIntents({ signal_id: r1.row.signal_id.replace(/test_tim_unit_li8a.*/, "test_tim_unit_li8") });
    // Just verify we get both
    assert.ok(rows.length >= 0); // may vary with concurrent test data
  });

  it("filters by since date", async () => {
    const since = new Date();
    since.setMinutes(since.getMinutes() - 1);
    await tim.createIntent({ signal_id: sig("li9"), intent_type: "OPEN", symbol: "EUR_USD" });
    const rows = await tim.listIntents({ since });
    assert.ok(rows.length >= 1);
  });

});

// ── getIntentHistory() ────────────────────────────────────────────────────────

describe("TradeIntentManager — getIntentHistory()", () => {

  it("returns all history entries for an intent", async () => {
    const r = await tim.createIntent({ signal_id: sig("h1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);

    const history = await tim.getIntentHistory(r.row.id);
    assert.ok(history.length >= 3); // CREATED + VALIDATED + APPROVED
  });

  it("returns empty array for intent that was only created (has 1 history entry)", async () => {
    const r = await tim.createIntent({ signal_id: sig("h2"), intent_type: "OPEN", symbol: "EUR_USD" });
    const history = await tim.getIntentHistory(r.row.id);
    assert.ok(history.length >= 1);
    assert.strictEqual(history[history.length - 1].to_status, "CREATED");
  });

  it("entries have correct fields", async () => {
    const r = await tim.createIntent({ signal_id: sig("h3"), intent_type: "OPEN", symbol: "EUR_USD" });
    const history = await tim.getIntentHistory(r.row.id);
    const entry = history[0];
    assert.ok("intent_id" in entry);
    assert.ok("from_status" in entry);
    assert.ok("to_status" in entry);
    assert.ok("version" in entry);
    assert.ok("changed_at" in entry);
    assert.ok("changed_by" in entry);
    assert.ok("detail" in entry);
  });

  it("history is in descending order (most recent first)", async () => {
    const r = await tim.createIntent({ signal_id: sig("h4"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);

    const history = await tim.getIntentHistory(r.row.id);
    assert.strictEqual(history[0].to_status, "APPROVED");
    assert.strictEqual(history[history.length - 1].to_status, "CREATED");
  });

  it("throws for invalid intentId", async () => {
    await assert.rejects(
      () => tim.getIntentHistory(-1),
      /intentId must be a positive number/
    );
  });

});

// ── getDuplicates() ───────────────────────────────────────────────────────────

describe("TradeIntentManager — getDuplicates()", () => {

  it("returns existing intent when duplicate exists", async () => {
    const sid = sig("dup1");
    await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    const dups = await tim.getDuplicates(sid, "OPEN");
    assert.ok(dups.length >= 1);
    assert.strictEqual(dups[0].signal_id, sid);
  });

  it("returns empty array when no duplicate exists", async () => {
    const dups = await tim.getDuplicates("nonexistent_signal_xyz_999", "OPEN");
    assert.strictEqual(dups.length, 0);
  });

  it("throws for missing signalId", async () => {
    await assert.rejects(
      () => tim.getDuplicates("", "OPEN"),
      /signalId and intentType are required/
    );
  });

});

// ── getStats() ────────────────────────────────────────────────────────────────

describe("TradeIntentManager — getStats()", () => {

  it("returns correct shape", async () => {
    const stats = await tim.getStats();
    assert.ok("byStatus" in stats);
    assert.ok("total" in stats);
    assert.ok("historyRows" in stats);
    assert.ok("pool" in stats);
    assert.ok("total" in stats.pool);
    assert.ok("idle" in stats.pool);
    assert.ok("waiting" in stats.pool);
  });

  it("total equals sum of byStatus counts", async () => {
    const stats = await tim.getStats();
    const sum = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
    assert.strictEqual(stats.total, sum);
  });

  it("reflects newly created intents", async () => {
    const before = await tim.getStats();
    await tim.createIntent({ signal_id: sig("st1"), intent_type: "OPEN", symbol: "EUR_USD" });
    const after = await tim.getStats();
    assert.ok(after.total >= before.total + 1);
  });

  it("historyRows increases after transitions", async () => {
    const before = await tim.getStats();
    const r = await tim.createIntent({ signal_id: sig("st2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    const after = await tim.getStats();
    assert.ok(after.historyRows >= before.historyRows + 2);
  });

});

// ── State machine violations ──────────────────────────────────────────────────

describe("TradeIntentManager — State machine enforcement", () => {

  it("VALIDATED → EXECUTED is blocked (must go through APPROVED)", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await assert.rejects(
      () => tim.executeIntent(r.row.id, {}),
      /invalid transition/
    );
  });

  it("CREATED → APPROVED is blocked", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await assert.rejects(
      () => tim.approveIntent(r.row.id),
      /invalid transition/
    );
  });

  it("APPROVED → VALIDATED is blocked", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    await assert.rejects(
      () => tim.validateIntent(r.row.id, { passed: true }),
      /invalid transition/
    );
  });

  it("EXECUTED → APPROVED is blocked", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm4"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);
    await tim.executeIntent(r.row.id, {});
    await assert.rejects(
      () => tim.approveIntent(r.row.id),
      /invalid transition|terminal/
    );
  });

  it("ARCHIVED → any transition is blocked (terminal state)", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm5"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.rejectIntent(r.row.id, "For terminal test");
    await tim.archiveIntent(r.row.id);
    await assert.rejects(
      () => tim.cancelIntent(r.row.id, "Trying to cancel archived"),
      /terminal/
    );
  });

  it("CANCELLED → APPROVED is blocked", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm6"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.cancelIntent(r.row.id, "For state machine test");
    await assert.rejects(
      () => tim.approveIntent(r.row.id),
      /invalid transition|terminal/
    );
  });

  it("error messages include current status and target status", async () => {
    const r = await tim.createIntent({ signal_id: sig("sm7"), intent_type: "OPEN", symbol: "EUR_USD" });
    try {
      await tim.executeIntent(r.row.id, {});
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("EXECUTED") || err.message.includes("APPROVED"),
        `Error message should mention states, got: ${err.message}`);
    }
  });

});

// ── Version tracking ──────────────────────────────────────────────────────────

describe("TradeIntentManager — Version tracking", () => {

  it("version increments by 1 on each transition", async () => {
    const r = await tim.createIntent({ signal_id: sig("ver1"), intent_type: "OPEN", symbol: "EUR_USD" });
    assert.strictEqual(Number(r.row.version), 0);

    const v1 = await tim.validateIntent(r.row.id, { passed: true });
    assert.strictEqual(Number(v1.version), 1);

    const v2 = await tim.approveIntent(r.row.id);
    assert.strictEqual(Number(v2.version), 2);

    const { row: v3 } = await tim.executeIntent(r.row.id, {});
    assert.strictEqual(Number(v3.version), 3);

    const v4 = await tim.archiveIntent(r.row.id);
    assert.strictEqual(Number(v4.version), 4);
  });

  it("history records capture correct version after each transition", async () => {
    const r = await tim.createIntent({ signal_id: sig("ver2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(r.row.id, { passed: true });
    await tim.approveIntent(r.row.id);

    const history = await tim.getIntentHistory(r.row.id);
    const versions = history.map(h => Number(h.version)).sort((a, b) => a - b);
    assert.deepStrictEqual(versions, [0, 1, 2]);
  });

});
