"use strict";
/**
 * Sprint 2 — TradeIntentManager Stress Tests
 *
 * High-throughput scenarios that verify the system behaves correctly
 * under concurrent load, large batch operations, and sustained pressure.
 *
 * All test data uses signal_id LIKE 'test_tim_str_%'.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/stress/tim_stress.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { TradeIntentManager } = require("../../managers/TradeIntentManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SIG_PREFIX   = "test_tim_str_";

let pool, tim;

async function cleanup(p) {
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
}

let _ctr = 0;
function sig(s) { return `${SIG_PREFIX}${s}_${++_ctr}_${Math.random().toString(36).slice(2,5)}`; }

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
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

// ── STRESS-1: Sequential create throughput ────────────────────────────────────

describe("STRESS-1 — Sequential createIntent throughput", () => {

  it("100 sequential creates complete without error", async () => {
    const N = 100;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const { row } = await tim.createIntent({
        signal_id:   sig(`seq_${i}`),
        intent_type: "OPEN",
        symbol:      "EUR_USD",
      });
      ids.push(row.id);
    }
    assert.strictEqual(ids.length, N);
    assert.ok(ids.every(id => id > 0));
  });

  it("100 sequential creates: all appear in listIntents", async () => {
    const sids = Array.from({ length: 50 }, (_, i) => sig(`seq2_${i}`));
    for (const sid of sids) {
      await tim.createIntent({ signal_id: sid, intent_type: "OPEN", symbol: "EUR_USD" });
    }
    const rows = await tim.listIntents({ limit: 1000 });
    const ourSids = new Set(sids);
    const ours = rows.filter(r => ourSids.has(r.signal_id));
    assert.strictEqual(ours.length, sids.length);
  });

});

// ── STRESS-2: Sequential lifecycle throughput ─────────────────────────────────

describe("STRESS-2 — Sequential lifecycle transitions", () => {

  it("20 intents through full create→validate→approve→execute→archive", async () => {
    const N = 20;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const { row } = await tim.createIntent({ signal_id: sig(`lc_${i}`), intent_type: "OPEN", symbol: "EUR_USD" });
      ids.push(row.id);
    }
    for (const id of ids) await tim.validateIntent(id, { passed: true });
    for (const id of ids) await tim.approveIntent(id);
    for (const id of ids) await tim.executeIntent(id, { batch: true });
    for (const id of ids) await tim.archiveIntent(id);

    const finals = await Promise.all(ids.map(id => tim.getIntent(id)));
    assert.ok(finals.every(f => f.status === "ARCHIVED"));
    assert.ok(finals.every(f => Number(f.version) === 4));
  });

  it("20 intents through create→reject→archive", async () => {
    const N = 20;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const { row } = await tim.createIntent({ signal_id: sig(`rj_${i}`), intent_type: "OPEN", symbol: "GBP_USD" });
      ids.push(row.id);
    }
    for (const id of ids) await tim.rejectIntent(id, "Stress test rejection");
    for (const id of ids) await tim.archiveIntent(id);
    const finals = await Promise.all(ids.map(id => tim.getIntent(id)));
    assert.ok(finals.every(f => f.status === "ARCHIVED"));
  });

});

// ── STRESS-3: Concurrent create throughput ────────────────────────────────────

describe("STRESS-3 — Concurrent createIntent throughput", () => {

  it("50 concurrent creates for different signals: all succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`con_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    assert.strictEqual(results.length, 50);
    assert.ok(results.every(r => r.created === true));
  });

  it("100 concurrent creates for different signals: no errors or duplicates", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`con2_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const created = results.filter(r => r.created);
    assert.strictEqual(created.length, 100, "all 100 should be created (unique signal_ids)");
  });

  it("50 concurrent creates, all validated concurrently", async () => {
    const created = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`cv_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const validated = await Promise.all(
      created.map(r => tim.validateIntent(r.row.id, { passed: true }))
    );
    assert.ok(validated.every(v => v.status === "VALIDATED"));
  });

});

// ── STRESS-4: Concurrent reads under load ─────────────────────────────────────

describe("STRESS-4 — Concurrent reads under load", () => {

  it("50 concurrent listIntents calls complete without error", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`rd_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const reads = await Promise.all(
      Array.from({ length: 50 }, () => tim.listIntents({ limit: 20 }))
    );
    assert.ok(reads.every(r => Array.isArray(r)));
  });

  it("50 concurrent getStats calls complete without error", async () => {
    const stats = await Promise.all(
      Array.from({ length: 50 }, () => tim.getStats())
    );
    assert.ok(stats.every(s => typeof s.total === "number"));
  });

  it("100 concurrent getIntent calls (some null) complete without error", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("rd2"), intent_type: "OPEN", symbol: "EUR_USD" });
    const results = await Promise.all([
      ...Array.from({ length: 50 }, () => tim.getIntent(row.id)),
      ...Array.from({ length: 50 }, () => tim.getIntent(999999000)),
    ]);
    const found  = results.filter(r => r !== null);
    const notFound = results.filter(r => r === null);
    assert.strictEqual(found.length, 50);
    assert.strictEqual(notFound.length, 50);
  });

});

// ── STRESS-5: Large metadata JSONB ────────────────────────────────────────────

describe("STRESS-5 — Large metadata JSONB handling", () => {

  it("1KB metadata JSONB stored and retrieved correctly", async () => {
    const bigMeta = { data: "x".repeat(1024), tags: Array.from({ length: 20 }, (_, i) => `tag_${i}`) };
    const { row } = await tim.createIntent({
      signal_id: sig("big1"), intent_type: "OPEN", symbol: "EUR_USD", metadata: bigMeta,
    });
    const intent = await tim.getIntent(row.id);
    assert.strictEqual(intent.metadata.data.length, 1024);
    assert.strictEqual(intent.metadata.tags.length, 20);
  });

  it("10KB metadata JSONB stored correctly", async () => {
    const bigMeta = {
      signal_history: Array.from({ length: 100 }, (_, i) => ({ ts: Date.now(), score: i * 0.01, label: `signal_${i}` })),
      features: Array.from({ length: 50 }, (_, i) => ({ name: `feature_${i}`, value: Math.random() })),
    };
    const { row } = await tim.createIntent({
      signal_id: sig("big2"), intent_type: "OPEN", symbol: "GBP_USD", metadata: bigMeta,
    });
    const intent = await tim.getIntent(row.id);
    assert.strictEqual(intent.metadata.signal_history.length, 100);
    assert.strictEqual(intent.metadata.features.length, 50);
  });

  it("execution_detail with complex nested structure stored correctly", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("big3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const detail = {
      oanda_response: {
        orderFillTransaction: { price: "1.25400", units: "10000", tradeOpened: { tradeID: "12345" } },
        relatedTransactionIDs: ["T1", "T2", "T3"],
        lastTransactionID: "67890",
      },
      latency_breakdown: { network: 12, db: 3, engine: 30 },
      retries: 0,
    };
    await tim.executeIntent(row.id, detail);
    const intent = await tim.getIntent(row.id);
    assert.strictEqual(intent.execution_detail.oanda_response.lastTransactionID, "67890");
    assert.strictEqual(intent.execution_detail.retries, 0);
  });

});

// ── STRESS-6: History query performance ───────────────────────────────────────

describe("STRESS-6 — History table query performance", () => {

  it("intent with 4 history entries queries in <200ms", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("hq1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    await tim.executeIntent(row.id, {});

    const t0 = Date.now();
    const history = await tim.getIntentHistory(row.id);
    const elapsed = Date.now() - t0;

    assert.ok(history.length >= 4);
    assert.ok(elapsed < 200, `History query took ${elapsed}ms (expected < 200ms)`);
  });

  it("10 concurrent history queries complete in <2s", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("hq2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);

    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, () => tim.getIntentHistory(row.id))
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `10 concurrent history queries took ${elapsed}ms`);
  });

  it("listIntents with status filter queries correctly under load", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`hq3_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const t0 = Date.now();
    const rows = await tim.listIntents({ status: "CREATED", limit: 100 });
    const elapsed = Date.now() - t0;
    assert.ok(rows.length >= 20);
    assert.ok(elapsed < 500, `listIntents took ${elapsed}ms (expected < 500ms)`);
  });

});

// ── STRESS-7: Pool health under load ─────────────────────────────────────────

describe("STRESS-7 — Pool health and connection management", () => {

  it("ping() works under 50 concurrent calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => tim.ping())
    );
    assert.ok(results.every(r => r.ok === true));
  });

  it("pool stats after heavy load show no waiting connections", async () => {
    // Run 30 creates and then check pool is healthy
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`pool_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    // Brief pause to let connections drain back to idle
    await new Promise(r => setTimeout(r, 100));
    const stats = await tim.getStats();
    assert.strictEqual(stats.pool.waiting, 0, "no connections should be waiting after load");
  });

  it("no pool deadlock when 20 concurrent full-lifecycle runs complete", async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const { row } = await tim.createIntent({ signal_id: sig(`dl_${i}`), intent_type: "OPEN", symbol: "EUR_USD" });
        await tim.validateIntent(row.id, { passed: true });
        await tim.approveIntent(row.id);
        const { row: exec } = await tim.executeIntent(row.id, {});
        await tim.archiveIntent(row.id);
        return exec.status;
      })
    );
    assert.ok(results.every(s => s === "EXECUTED"));
  });

});

// ── STRESS-8: getStats accuracy under load ────────────────────────────────────

describe("STRESS-8 — getStats accuracy under concurrent load", () => {

  it("getStats total matches actual row count after 50 creates", async () => {
    const before = await tim.getStats();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`gs_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const after = await tim.getStats();
    assert.ok(after.total >= before.total + 50, "getStats.total should increase by at least 50");
  });

  it("historyRows count stays consistent across concurrent transitions", async () => {
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tim.createIntent({ signal_id: sig(`hr_${i}`), intent_type: "OPEN", symbol: "EUR_USD" })
      )
    );
    const before = await tim.getStats();
    await Promise.all(rows.map(r => tim.validateIntent(r.row.id, { passed: true })));
    const after = await tim.getStats();
    // Each validateIntent adds 1 history row
    assert.ok(after.historyRows >= before.historyRows + 10);
  });

});
