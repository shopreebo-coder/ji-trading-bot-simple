"use strict";
/**
 * Sprint 2 — TradeIntentManager + RuntimeDomainManager Integration Tests
 *
 * Tests the TIM + RDM combined flows:
 *   - executeIntent() updates the runtime domain when RDM is injected
 *   - Graceful degradation when RDM is unavailable or throws
 *   - TIM is fully functional without RDM
 *
 * All test data uses signal_id LIKE 'test_tim_rdm_%'.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/integration/tim_rdm_integration.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { TradeIntentManager } = require("../../managers/TradeIntentManager");
const { RuntimeDomainManager } = require("../../managers/RuntimeDomainManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SIG_PREFIX   = "test_tim_rdm_";

let pool, tim, rdm, timWithRdm;

async function cleanup(p) {
  await p.query(
    `DELETE FROM trade_intent_history WHERE intent_id IN
       (SELECT id FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%')`
  );
  await p.query(`DELETE FROM trade_intents WHERE signal_id LIKE '${SIG_PREFIX}%'`);
  // Clean up RDM test domains
  await p.query(`DELETE FROM runtime_domain_history WHERE domain LIKE 'test_rdm_tim_%'`);
  await p.query(`DELETE FROM runtime_domains WHERE domain LIKE 'test_rdm_tim_%'`);
}

function sig(s) { return `${SIG_PREFIX}${s}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`; }

before(async () => {
  pool       = new Pool({ connectionString: DATABASE_URL, max: 10 });
  rdm        = new RuntimeDomainManager({ _pool: pool });
  tim        = new TradeIntentManager({ _pool: pool });            // standalone
  timWithRdm = new TradeIntentManager({ _pool: pool, rdm });       // with RDM
  await rdm.init();
  await tim.init();
  await timWithRdm.init();
  await cleanup(pool);
});

after(async () => {
  await cleanup(pool);
  await pool.end();
});

beforeEach(async () => {
  await cleanup(pool);
});

// ── TIM standalone (no RDM) ──────────────────────────────────────────────────

describe("TIM + RDM — TIM standalone (no RDM injected)", () => {

  it("executeIntent returns rdmUpdated:false when no RDM", async () => {
    const { row: created } = await tim.createIntent({ signal_id: sig("s1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await tim.validateIntent(created.id, { passed: true });
    await tim.approveIntent(created.id);
    const result = await tim.executeIntent(created.id, { units: 10000 });
    assert.strictEqual(result.rdmUpdated, false);
    assert.strictEqual(result.rdmError,   null);
    assert.strictEqual(result.row.status, "EXECUTED");
  });

  it("executeIntent succeeds without RDM — intent is stored correctly", async () => {
    const { row } = await tim.createIntent({ signal_id: sig("s2"), intent_type: "OPEN", symbol: "GBP_USD" });
    await tim.validateIntent(row.id, { passed: true });
    await tim.approveIntent(row.id);
    const { row: exec } = await tim.executeIntent(row.id, { test: true });
    assert.strictEqual(exec.status, "EXECUTED");
    assert.ok(exec.execution_detail);
  });

});

// ── TIM with RDM — happy path ─────────────────────────────────────────────────

describe("TIM + RDM — executeIntent patches runtime domain", () => {

  it("rdmUpdated is true when RDM patched successfully", async () => {
    const { row } = await timWithRdm.createIntent({ signal_id: sig("r1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timWithRdm.validateIntent(row.id, { passed: true });
    await timWithRdm.approveIntent(row.id);
    const result = await timWithRdm.executeIntent(row.id, { fill_price: 1.2540 });
    assert.strictEqual(result.rdmUpdated, true);
    assert.strictEqual(result.rdmError,   null);
    assert.strictEqual(result.row.status, "EXECUTED");
  });

  it("'live' domain reflects lastIntentId after execute", async () => {
    const { row } = await timWithRdm.createIntent({ signal_id: sig("r2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timWithRdm.validateIntent(row.id, { passed: true });
    await timWithRdm.approveIntent(row.id);
    await timWithRdm.executeIntent(row.id, {});

    const liveDomain = await rdm.getDomain("live");
    assert.ok(liveDomain, "live domain must exist");
    assert.strictEqual(String(liveDomain.value.lastIntentId), String(row.id));
    assert.strictEqual(liveDomain.value.lastIntentSymbol, "EUR_USD");
    assert.strictEqual(liveDomain.value.lastIntentType, "OPEN");
  });

  it("'live' domain is updated with each successive executeIntent", async () => {
    const r1 = await timWithRdm.createIntent({ signal_id: sig("r3a"), intent_type: "OPEN",  symbol: "EUR_USD" });
    const r2 = await timWithRdm.createIntent({ signal_id: sig("r3b"), intent_type: "CLOSE", symbol: "GBP_USD" });

    for (const r of [r1, r2]) {
      await timWithRdm.validateIntent(r.row.id, { passed: true });
      await timWithRdm.approveIntent(r.row.id);
      await timWithRdm.executeIntent(r.row.id, {});
    }

    const liveDomain = await rdm.getDomain("live");
    // Last executed intent should be r2
    assert.strictEqual(String(liveDomain.value.lastIntentId), String(r2.row.id));
    assert.strictEqual(liveDomain.value.lastIntentSymbol, "GBP_USD");
  });

  it("intent remains EXECUTED even if RDM patch domain returns null (domain not found)", async () => {
    // Use a non-existent runtime_domain so RDM getDomain returns null
    const { row } = await timWithRdm.createIntent({
      signal_id:      sig("r4"),
      intent_type:    "OPEN",
      symbol:         "EUR_USD",
      runtime_domain: "nonexistent_domain_xyz",
    });
    await timWithRdm.validateIntent(row.id, { passed: true });
    await timWithRdm.approveIntent(row.id);
    const result = await timWithRdm.executeIntent(row.id, {});
    // Intent should be EXECUTED regardless of RDM outcome
    assert.strictEqual(result.row.status, "EXECUTED");
  });

});

// ── TIM with RDM — graceful degradation ──────────────────────────────────────

describe("TIM + RDM — Graceful degradation when RDM fails", () => {

  it("intent is EXECUTED even when RDM throws — rdmError captures the error", async () => {
    // Create a TIM with a broken RDM (throws on patchDomain)
    const brokenRdm = {
      getDomain:      async () => ({ value: {} }),
      patchDomain:    async () => { throw new Error("RDM simulated failure"); },
      logConsistency: async () => {},
    };
    const timBroken = new TradeIntentManager({ _pool: pool, rdm: brokenRdm });
    await timBroken.init();

    const { row } = await timBroken.createIntent({ signal_id: sig("deg1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timBroken.validateIntent(row.id, { passed: true });
    await timBroken.approveIntent(row.id);
    const result = await timBroken.executeIntent(row.id, {});

    assert.strictEqual(result.row.status, "EXECUTED");  // Intent is safely EXECUTED
    assert.strictEqual(result.rdmUpdated, false);
    assert.ok(result.rdmError.includes("RDM simulated failure"));
  });

  it("RDM failure does not prevent subsequent operations on the intent", async () => {
    const brokenRdm = {
      getDomain:      async () => { throw new Error("RDM down"); },
      patchDomain:    async () => { throw new Error("RDM down"); },
      logConsistency: async () => {},
    };
    const timBroken = new TradeIntentManager({ _pool: pool, rdm: brokenRdm });
    await timBroken.init();

    const { row } = await timBroken.createIntent({ signal_id: sig("deg2"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timBroken.validateIntent(row.id, { passed: true });
    await timBroken.approveIntent(row.id);
    await timBroken.executeIntent(row.id, {}); // RDM fails but intent is EXECUTED
    const archived = await timBroken.archiveIntent(row.id);
    assert.strictEqual(archived.status, "ARCHIVED");
  });

  it("logConsistency failure does not crash executeIntent", async () => {
    const brokenRdm = {
      getDomain:      async () => ({ value: {} }),
      patchDomain:    async () => { throw new Error("patch fail"); },
      logConsistency: async () => { throw new Error("log fail too"); },
    };
    const timBroken = new TradeIntentManager({ _pool: pool, rdm: brokenRdm });
    await timBroken.init();

    const { row } = await timBroken.createIntent({ signal_id: sig("deg3"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timBroken.validateIntent(row.id, { passed: true });
    await timBroken.approveIntent(row.id);
    // Should not throw even though both RDM operations fail
    const result = await timBroken.executeIntent(row.id, {});
    assert.strictEqual(result.row.status, "EXECUTED");
  });

});

// ── RDM snapshot coherence ────────────────────────────────────────────────────

describe("TIM + RDM — Snapshot coherence", () => {

  it("RDM snapshot can be taken after TIM execution without error", async () => {
    const { row } = await timWithRdm.createIntent({ signal_id: sig("snap1"), intent_type: "OPEN", symbol: "EUR_USD" });
    await timWithRdm.validateIntent(row.id, { passed: true });
    await timWithRdm.approveIntent(row.id);
    await timWithRdm.executeIntent(row.id, {});

    // Snapshot should succeed and include live domain with intent info
    const snapshot = await rdm.takeSnapshot("test_rdm_tim_snap");
    assert.ok(snapshot, "snapshot should be created");
    assert.ok(snapshot.snapshotId > 0, "snapshot should have a valid snapshotId");
    assert.ok(snapshot.domainCount >= 1, "snapshot should cover at least one domain");
    // Verify snapshot completed without error — domain data is stored in system_snapshots table
  });

});
