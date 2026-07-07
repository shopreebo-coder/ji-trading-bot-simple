"use strict";
/**
 * Sprint 1 — RuntimeDomainManager Integration Tests
 *
 * Tests that require concurrent connections and multi-step flows.
 * All test data uses 'test_rdm_int_' prefix and is cleaned up.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { RuntimeDomainManager } = require("../../managers/RuntimeDomainManager");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DOMAIN = "test_rdm_int_domain";

let pool, rdm;

async function cleanup(p) {
  await p.query("DELETE FROM runtime_domain_history WHERE domain LIKE 'test_rdm_int_%'");
  await p.query("DELETE FROM runtime_domains WHERE domain LIKE 'test_rdm_int_%'");
}

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  rdm  = new RuntimeDomainManager({ _pool: pool });
  await rdm.init();
  await cleanup(pool);
});

after(async () => {
  await cleanup(pool);
  await pool.end();
});

beforeEach(async () => {
  await cleanup(pool);
});

// ── Concurrent CAS ─────────────────────────────────────────────────────────

describe("Integration — Concurrent compareAndSwap", () => {

  it("exactly one winner in 10 simultaneous CAS attempts", async () => {
    await rdm.createDomain(DOMAIN, { counter: 0 });
    const row = await rdm.getDomain(DOMAIN);

    // 10 concurrent CAS attempts on the same version
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        rdm.compareAndSwap(DOMAIN, row.version, { counter: i + 1 })
      )
    );

    const winners = results.filter(r => r.swapped);
    const losers  = results.filter(r => !r.swapped);

    assert.strictEqual(winners.length, 1,  "exactly one CAS must succeed");
    assert.strictEqual(losers.length,  9,  "exactly nine must fail");
  });

  it("version is monotonically increasing after concurrent CAS retries", async () => {
    await rdm.createDomain(DOMAIN, { counter: 0 });

    // Serialize 5 CAS updates with retry logic (simulates well-behaved engine)
    async function casWithRetry(value) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await rdm.getDomain(DOMAIN);
        const result  = await rdm.compareAndSwap(DOMAIN, current.version, value);
        if (result.swapped) return result.currentVersion;
        // Exponential backoff
        await new Promise(r => setTimeout(r, attempt * 10));
      }
      throw new Error("CAS: too many retries");
    }

    const versions = await Promise.all([
      casWithRetry({ counter: 1 }),
      casWithRetry({ counter: 2 }),
      casWithRetry({ counter: 3 }),
      casWithRetry({ counter: 4 }),
      casWithRetry({ counter: 5 }),
    ]);

    // All versions must be unique and positive
    const unique = new Set(versions);
    assert.strictEqual(unique.size, 5, "all 5 updates must produce unique versions");

    const final = await rdm.getDomain(DOMAIN);
    assert.ok(Number(final.version) >= 5);
  });

  it("concurrent updates to DIFFERENT domains do not interfere", async () => {
    const domains = ["test_rdm_int_a", "test_rdm_int_b", "test_rdm_int_c", "test_rdm_int_d"];
    for (const d of domains) await rdm.createDomain(d, { v: 0 });

    await Promise.all(
      domains.map(async (d, i) => {
        for (let j = 0; j < 5; j++) {
          const row = await rdm.getDomain(d);
          await rdm.compareAndSwap(d, row.version, { v: j + 1 });
        }
      })
    );

    for (const d of domains) {
      const row = await rdm.getDomain(d);
      assert.ok(Number(row.version) >= 1, `domain ${d} must have been updated`);
    }
  });

});

// ── Snapshot + Restore round-trip ──────────────────────────────────────────

describe("Integration — Snapshot round-trip", () => {

  it("snapshot → modify → restore returns correct values", async () => {
    const original = { state: "ORIGINAL", value: 42, flag: true };
    await rdm.createDomain(DOMAIN, original);
    const { snapshotId } = await rdm.takeSnapshot("integration_test");

    // Corrupt the value
    await rdm.updateDomain(DOMAIN, { state: "CORRUPTED", value: 0, flag: false });
    const corrupted = await rdm.getDomain(DOMAIN);
    assert.deepStrictEqual(corrupted.value, { state: "CORRUPTED", value: 0, flag: false });

    // Restore
    await rdm.restoreFromSnapshot(snapshotId, [DOMAIN]);
    const restored = await rdm.getDomain(DOMAIN);
    assert.deepStrictEqual(restored.value, original);
  });

  it("snapshot preserves all 10 production domains", async () => {
    const { snapshotId } = await rdm.takeSnapshot("integration_test_all");
    const snap = await rdm.getSnapshot(snapshotId);

    const expectedDomains = ["live","shadowA","shadowB","shadowC","shadowD","shadowM","exitLab","telemetry","scheduler","meta"];
    for (const d of expectedDomains) {
      assert.ok(snap.runtime_summary[d], `runtime_summary must include '${d}'`);
    }
  });

});

// ── History continuity ─────────────────────────────────────────────────────

describe("Integration — History continuity", () => {

  it("history grows monotonically through create→update→patch→rollback", async () => {
    await rdm.createDomain(DOMAIN, { step: 0 });      // version 0, CREATE
    await rdm.updateDomain(DOMAIN, { step: 1 });      // version 1, UPDATE
    await rdm.patchDomain(DOMAIN, { step: 2 });       // version 2, PATCH
    await rdm.rollback(DOMAIN, 1);                    // version 3, ROLLBACK

    const history = await rdm.getHistory(DOMAIN);
    assert.ok(history.length >= 4);

    const ops = history.map(h => h.change_op);
    assert.ok(ops.includes("CREATE"));
    assert.ok(ops.includes("UPDATE"));
    assert.ok(ops.includes("PATCH"));
    assert.ok(ops.includes("ROLLBACK"));
  });

  it("after rollback, value matches the target version's value exactly", async () => {
    await rdm.createDomain(DOMAIN, { secret: "INITIAL" });
    await rdm.updateDomain(DOMAIN, { secret: "UPDATED" });
    await rdm.updateDomain(DOMAIN, { secret: "AGAIN" });

    await rdm.rollback(DOMAIN, 1);
    const current = await rdm.getDomain(DOMAIN);
    assert.deepStrictEqual(current.value, { secret: "UPDATED" });
  });

});

// ── Data integrity ─────────────────────────────────────────────────────────

describe("Integration — Data integrity", () => {

  it("existing production data is untouched by test operations", async () => {
    // Read production counts before
    const beforeDomains = await rdm.listDomains();
    const prodDomains   = beforeDomains.filter(d => !d.domain.startsWith("test_rdm_"));

    // Create/modify/delete test data
    await rdm.createDomain(DOMAIN, { test: true });
    await rdm.updateDomain(DOMAIN, { test: false });

    // Read production domains again
    const afterDomains   = await rdm.listDomains();
    const prodAfter      = afterDomains.filter(d => !d.domain.startsWith("test_rdm_"));

    // All production domains must have identical values
    for (const before of prodDomains) {
      const after = prodAfter.find(d => d.domain === before.domain);
      assert.ok(after, `production domain '${before.domain}' must still exist`);
      assert.deepStrictEqual(
        after.value, before.value,
        `production domain '${before.domain}' value must be unchanged`
      );
    }
  });

  it("consistency check reports OK on production domains after test operations", async () => {
    await rdm.createDomain(DOMAIN, { test: true });
    await rdm.updateDomain(DOMAIN, { test: false });

    const result = await rdm.runConsistencyCheck();
    const prodIssues = result.detail.filter(i => !i.domain?.startsWith("test_rdm_"));
    assert.strictEqual(prodIssues.length, 0, "no consistency issues in production domains");
  });

  it("transaction rollback leaves domain in prior state", async () => {
    await rdm.createDomain(DOMAIN, { safe: true });
    const before = await rdm.getDomain(DOMAIN);

    // Simulate a failed update by using a wrong-type value
    // The update will fail at the DB level and rollback
    try {
      await rdm.updateDomain(DOMAIN, null);
    } catch (_) { /* expected */ }

    const after = await rdm.getDomain(DOMAIN);
    assert.deepStrictEqual(after.value, before.value, "domain must be unchanged after failed update");
    assert.strictEqual(Number(after.version), Number(before.version), "version must be unchanged");
  });

});

// ── Consistency log ────────────────────────────────────────────────────────

describe("Integration — Consistency log full cycle", () => {

  it("full detect → log → resolve cycle", async () => {
    const entry = await rdm.logConsistency(
      "test_rdm_int_check_001", "WARN",
      "Simulated consistency issue for integration test",
      { simulatedField: "value" },
      { domain: DOMAIN }
    );

    assert.ok(entry.id > 0);

    const { rows: before } = await pool.query(
      "SELECT resolved_at FROM consistency_log WHERE id=$1", [entry.id]
    );
    assert.strictEqual(before[0].resolved_at, null, "must start as unresolved");

    await rdm.resolveConsistency(entry.id, "auto-repaired during integration test", {
      autoRepaired: true,
      repairDetail: { action: "test cleanup" },
    });

    const { rows: after } = await pool.query(
      "SELECT resolved_at, auto_repaired FROM consistency_log WHERE id=$1", [entry.id]
    );
    assert.ok(after[0].resolved_at, "must be resolved");
    assert.strictEqual(after[0].auto_repaired, true);
  });

});
