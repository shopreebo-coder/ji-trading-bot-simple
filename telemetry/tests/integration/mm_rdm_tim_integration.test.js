"use strict";
/**
 * Sprint 3 — MemoryManager × RuntimeDomainManager × TradeIntentManager
 *
 * Cross-manager integration:
 *   • MM + TIM: memories linked to real trade intents (soft reference)
 *   • MM + RDM: validateMemory findings via rdm.logConsistency
 *   • MM + RDM: summarizeMemory feeds system_snapshots.memory_summary
 *   • Full pipeline: intent lifecycle producing memories at each stage
 *
 * All test data uses source = 'test_mm_x' / signal prefix 'test_mm_x_'.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/integration/mm_rdm_tim_integration.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { MemoryManager }        = require("../../managers/MemoryManager");
const { TradeIntentManager }   = require("../../managers/TradeIntentManager");
const { RuntimeDomainManager } = require("../../managers/RuntimeDomainManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SRC        = "test_mm_x";
const SIG_PREFIX = "test_mm_x_";
let pool, mm, tim, rdm;

async function cleanup(p) {
  await p.query(
    `DELETE FROM memory_event_history WHERE memory_id IN
       (SELECT id FROM memory_events WHERE source = '${SRC}')`
  );
  await p.query(`DELETE FROM memory_events WHERE source = '${SRC}'`);
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
}

function sig(s) { return `${SIG_PREFIX}${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  rdm  = new RuntimeDomainManager({ _pool: pool });
  await rdm.init();
  tim  = new TradeIntentManager({ _pool: pool, rdm });
  await tim.init();
  mm   = new MemoryManager({ _pool: pool, rdm });
  await mm.init();
  await cleanup(pool);
});

after(async () => {
  await cleanup(pool);
  await pool.end();
});

beforeEach(async () => {
  await cleanup(pool);
});

// ── MM + TIM ─────────────────────────────────────────────────────────────────

describe("MM × TIM — memories linked to trade intents", () => {

  it("full intent lifecycle produces a queryable memory trail", async () => {
    const { row: intent } = await tim.createIntent({
      signal_id: sig("pipeline"), intent_type: "OPEN", symbol: "EUR_USD",
      direction: "BUY", confidence: 0.85,
    });

    // Memory at creation
    const { row: m1 } = await mm.createMemory({
      event_type: "TEST_MM_X_INTENT_CREATED", source: SRC,
      trade_intent_id: Number(intent.id), symbol: "EUR_USD",
      payload: { confidence: 0.85 }, tags: ["intent"],
    });

    await tim.validateIntent(intent.id, { passed: true, checks: { conf: true } });
    await tim.approveIntent(intent.id);
    const { row: executed } = await tim.executeIntent(intent.id, { oanda_order_id: "TEST-MM-X-1" });
    assert.equal(executed.status, "EXECUTED");

    // Memory at execution, appended context after fill
    const { row: m2 } = await mm.createMemory({
      event_type: "TEST_MM_X_INTENT_EXECUTED", source: SRC,
      trade_intent_id: Number(intent.id), symbol: "EUR_USD",
      payload: { order_id: "TEST-MM-X-1" }, tags: ["execution"],
    });
    await mm.appendMemory(m2.id, { fill_price: 1.0845, slippage_pips: 0.3 });

    // Reconstruct the trade's memory trail
    const trail = await mm.queryByTrade(Number(intent.id), { source: SRC });
    assert.equal(trail.length, 2);
    const types = trail.map(r => r.event_type).sort();
    assert.deepEqual(types, ["TEST_MM_X_INTENT_CREATED", "TEST_MM_X_INTENT_EXECUTED"]);

    // Soft reference is valid — validator raises no orphan warnings for these
    const res = await mm.validateMemory({ markCorrupted: false });
    const orphanIssues = res.issues.filter(i =>
      i.check === "orphaned_trade_intent" &&
      [String(m1.id), String(m2.id)].includes(String(i.memoryId))
    );
    assert.equal(orphanIssues.length, 0);
  });

  it("validator flags memories pointing at nonexistent intents", async () => {
    const { row } = await mm.createMemory({
      event_type: "TEST_MM_X_ORPHAN", source: SRC, payload: {},
    });
    await pool.query(
      `UPDATE memory_events SET trade_intent_id = 888888888 WHERE id = $1`, [row.id]
    );
    const res = await mm.validateMemory({ markCorrupted: false });
    const orphan = res.issues.find(i =>
      i.check === "orphaned_trade_intent" && String(i.memoryId) === String(row.id)
    );
    assert.ok(orphan);
    assert.equal(orphan.severity, "WARN");
  });
});

// ── MM + RDM ─────────────────────────────────────────────────────────────────

describe("MM × RDM — consistency logging & snapshots", () => {

  it("validateMemory logs findings through rdm.logConsistency", async () => {
    const { row } = await mm.createMemory({
      event_type: "TEST_MM_X_CORRUPT", source: SRC, payload: {},
    });
    await pool.query(`UPDATE memory_events SET payload = '3'::jsonb WHERE id = $1`, [row.id]);

    const res = await mm.validateMemory();
    assert.ok(res.corrupted.map(String).includes(String(row.id)));

    const { rows } = await pool.query(
      `SELECT * FROM consistency_log
       WHERE check_id = 'memory_validate:structural'
         AND description LIKE '%memory ' || $1 || '%'
       ORDER BY id DESC LIMIT 1`,
      [String(row.id)]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, "ERROR");
  });

  it("falls back to direct consistency_log INSERT without RDM", async () => {
    const mmSolo = new MemoryManager({ _pool: pool }); // no rdm injected
    await mmSolo.init();
    const { row } = await mmSolo.createMemory({
      event_type: "TEST_MM_X_SOLO", source: SRC, payload: {},
    });
    await pool.query(`UPDATE memory_events SET metadata = '[]'::jsonb WHERE id = $1`, [row.id]);
    const res = await mmSolo.validateMemory();
    assert.ok(res.corrupted.map(String).includes(String(row.id)));
    const { rows } = await pool.query(
      `SELECT * FROM consistency_log
       WHERE check_id = 'memory_validate:structural'
         AND description LIKE '%memory ' || $1 || '%'`,
      [String(row.id)]
    );
    assert.equal(rows.length, 1);
  });

  it("summarizeMemory feeds system_snapshots.memory_summary via takeSnapshot", async () => {
    await mm.createMemory({
      event_type: "TEST_MM_X_SNAP", source: SRC, payload: {}, tags: ["snapshot"],
    });
    const summary = await mm.summarizeMemory();
    const snap = await rdm.takeSnapshot("test_mm_x_snapshot", { memorySummary: summary });
    assert.ok(snap.snapshotId > 0);

    const { rows } = await pool.query(
      `SELECT memory_summary FROM system_snapshots WHERE id = $1`, [snap.snapshotId]
    );
    assert.equal(rows.length, 1);
    const stored = rows[0].memory_summary;
    assert.equal(stored.total, summary.total);
    assert.ok(stored.byEventType["TEST_MM_X_SNAP"] >= 1);
    assert.equal(stored.generatedAt, summary.generatedAt);
  });

  it("takeSnapshot without memorySummary keeps a safe placeholder (backwards compatible)", async () => {
    const snap = await rdm.takeSnapshot("test_mm_x_plain");
    const { rows } = await pool.query(
      `SELECT memory_summary FROM system_snapshots WHERE id = $1`, [snap.snapshotId]
    );
    assert.ok(rows[0].memory_summary.note);
  });
});

// ── Full pipeline ────────────────────────────────────────────────────────────

describe("MM × RDM × TIM — full decision pipeline", () => {

  it("signal → intent → execution → memory → summary → snapshot", async () => {
    // 1. Signal arrives — remembered
    const { row: signalMem } = await mm.createMemory({
      event_type: "TEST_MM_X_SIGNAL", source: SRC, runtime_domain: "shadowA",
      symbol: "GBP_USD", payload: { strength: 0.77 }, importance: 0.6,
      tags: ["signal"],
    });

    // 2. Intent created and driven to execution
    const { row: intent } = await tim.createIntent({
      signal_id: sig("full"), intent_type: "OPEN", symbol: "GBP_USD",
      direction: "SELL", confidence: 0.77,
    });
    await tim.validateIntent(intent.id, { passed: true, checks: {} });
    await tim.approveIntent(intent.id);
    await tim.executeIntent(intent.id, { oanda_order_id: "TEST-MM-X-FULL" });

    // 3. Execution remembered, linked to both signal memory and intent
    const { row: execMem } = await mm.createMemory({
      event_type: "TEST_MM_X_EXECUTION", source: SRC, runtime_domain: "live",
      trade_intent_id: Number(intent.id), symbol: "GBP_USD",
      payload: { order_id: "TEST-MM-X-FULL" }, importance: 0.8,
      tags: ["execution"], metadata: { signal_memory_id: Number(signalMem.id) },
    });

    // 4. Outcome appended later
    await mm.appendMemory(execMem.id, { outcome: "closed", pips: 8.2 });
    await mm.tagMemory(execMem.id, { add: ["win"] });

    // 5. Summarize and snapshot the whole system state
    const summary = await mm.summarizeMemory();
    const snap = await rdm.takeSnapshot("test_mm_x_pipeline", { memorySummary: summary });

    // Verify the chain end-to-end
    const trail = await mm.queryByTrade(Number(intent.id), { source: SRC });
    assert.equal(trail.length, 1);
    assert.equal(trail[0].context[0].addendum.pips, 8.2);
    assert.equal(Number(trail[0].metadata.signal_memory_id), Number(signalMem.id));

    const { rows } = await pool.query(
      `SELECT memory_summary FROM system_snapshots WHERE id = $1`, [snap.snapshotId]
    );
    assert.ok(rows[0].memory_summary.total >= 2);

    // Everything still valid
    const res = await mm.validateMemory({ markCorrupted: false });
    const ours = res.issues.filter(i =>
      [String(signalMem.id), String(execMem.id)].includes(String(i.memoryId))
    );
    assert.equal(ours.length, 0);
  });
});
