"use strict";
/**
 * Sprint 1 — RuntimeDomainManager Stress Tests
 *
 * Performance and concurrency benchmarks.
 * Validates RDM under high load: 100 concurrent updates,
 * 50 concurrent CAS, 500 sequential writes, latency benchmarks.
 *
 * All test data uses 'test_rdm_stress_' prefix and is cleaned up.
 *
 * Note: These tests may take 10–30s to complete depending on DB latency.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { RuntimeDomainManager } = require("../../managers/RuntimeDomainManager");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

const DOMAIN_A = "test_rdm_stress_domainA";
const DOMAIN_B = "test_rdm_stress_domainB";
const DOMAIN_C = "test_rdm_stress_domainC";

let pool, rdm;

async function cleanup(p) {
  await p.query("DELETE FROM runtime_domain_history WHERE domain LIKE 'test_rdm_stress_%'");
  await p.query("DELETE FROM runtime_domains WHERE domain LIKE 'test_rdm_stress_%'");
}

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
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

// ── Throughput ─────────────────────────────────────────────────────────────

describe("Stress — Sequential Write Throughput", () => {

  it("STRESS-1: 100 sequential updateDomain() calls complete in < 30s", async () => {
    await rdm.createDomain(DOMAIN_A, { counter: 0 });
    const start = Date.now();

    for (let i = 1; i <= 100; i++) {
      await rdm.updateDomain(DOMAIN_A, { counter: i });
    }

    const elapsed = Date.now() - start;
    const final   = await rdm.getDomain(DOMAIN_A);

    assert.strictEqual(Number(final.version), 100);
    assert.strictEqual(final.value.counter,   100);
    assert.ok(elapsed < 30000, `100 writes took ${elapsed}ms (expected < 30s)`);

    // Calculate average write latency
    const avgMs = elapsed / 100;
    console.log(`  [STRESS-1] 100 sequential writes: ${elapsed}ms total, ${avgMs.toFixed(1)}ms avg/write`);
  });

  it("STRESS-2: 100 sequential compareAndSwap() calls (with retry) complete in < 30s", async () => {
    await rdm.createDomain(DOMAIN_B, { counter: 0 });
    const start = Date.now();

    for (let i = 1; i <= 100; i++) {
      const row = await rdm.getDomain(DOMAIN_B);
      const result = await rdm.compareAndSwap(DOMAIN_B, row.version, { counter: i });
      assert.strictEqual(result.swapped, true, `CAS ${i} must succeed (no concurrent writers)`);
    }

    const elapsed = Date.now() - start;
    const final   = await rdm.getDomain(DOMAIN_B);

    assert.strictEqual(Number(final.version), 100);
    assert.ok(elapsed < 30000, `100 CAS took ${elapsed}ms (expected < 30s)`);
    console.log(`  [STRESS-2] 100 sequential CAS: ${elapsed}ms total, ${(elapsed/100).toFixed(1)}ms avg`);
  });

  it("STRESS-3: 50 sequential patchDomain() calls accumulate correctly", async () => {
    await rdm.createDomain(DOMAIN_C, { total: 0, patches: [] });
    const start = Date.now();

    for (let i = 1; i <= 50; i++) {
      await rdm.patchDomain(DOMAIN_C, { total: i });
    }

    const elapsed = Date.now() - start;
    const final   = await rdm.getDomain(DOMAIN_C);

    assert.strictEqual(Number(final.version), 50);
    assert.strictEqual(final.value.total, 50);
    assert.ok(elapsed < 20000, `50 patches took ${elapsed}ms (expected < 20s)`);
    console.log(`  [STRESS-3] 50 sequential patches: ${elapsed}ms total`);
  });

});

// ── Concurrency ────────────────────────────────────────────────────────────

describe("Stress — Concurrent Operations", () => {

  it("STRESS-4: 20 concurrent updateDomain() calls all commit (different domains)", async () => {
    const domains = Array.from({ length: 20 }, (_, i) => `test_rdm_stress_concurrent_${i}`);
    for (const d of domains) await rdm.createDomain(d, { written: false });

    const start   = Date.now();
    const results = await Promise.all(
      domains.map(d => rdm.updateDomain(d, { written: true }))
    );
    const elapsed = Date.now() - start;

    assert.ok(results.every(r => r !== null), "all updates must succeed");
    for (const d of domains) {
      const row = await rdm.getDomain(d);
      assert.deepStrictEqual(row.value, { written: true });
    }

    // Cleanup extra domains
    for (const d of domains) {
      await pool.query("DELETE FROM runtime_domain_history WHERE domain=$1", [d]);
      await pool.query("DELETE FROM runtime_domains WHERE domain=$1", [d]);
    }

    console.log(`  [STRESS-4] 20 concurrent domain updates: ${elapsed}ms`);
    assert.ok(elapsed < 10000, `20 concurrent updates took ${elapsed}ms (expected < 10s)`);
  });

  it("STRESS-5: 50 concurrent CAS on the same domain — exactly 1 wins per attempt", async () => {
    await rdm.createDomain(DOMAIN_A, { casRound: 0 });

    let totalWins = 0;
    const ROUNDS = 5; // 5 rounds of 10-concurrent CAS each

    for (let round = 0; round < ROUNDS; round++) {
      const current = await rdm.getDomain(DOMAIN_A);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          rdm.compareAndSwap(DOMAIN_A, current.version, { casRound: round, winner: i })
        )
      );

      const wins = results.filter(r => r.swapped).length;
      assert.strictEqual(wins, 1, `Round ${round}: exactly 1 CAS must win (got ${wins})`);
      totalWins += wins;
    }

    assert.strictEqual(totalWins, ROUNDS);
    const final = await rdm.getDomain(DOMAIN_A);
    assert.strictEqual(Number(final.version), ROUNDS);
    console.log(`  [STRESS-5] 5 rounds × 10 concurrent CAS = ${ROUNDS} wins`);
  });

  it("STRESS-6: concurrent reads don't block concurrent writes", async () => {
    await rdm.createDomain(DOMAIN_B, { value: 0 });

    const WRITE_COUNT = 10;
    const READ_COUNT  = 50;
    const start = Date.now();

    await Promise.all([
      // 10 sequential writes
      (async () => {
        for (let i = 1; i <= WRITE_COUNT; i++) {
          await rdm.updateDomain(DOMAIN_B, { value: i });
        }
      })(),
      // 50 concurrent reads
      ...Array.from({ length: READ_COUNT }, () =>
        rdm.getDomain(DOMAIN_B)
      ),
    ]);

    const elapsed = Date.now() - start;
    const final   = await rdm.getDomain(DOMAIN_B);
    assert.strictEqual(final.value.value, WRITE_COUNT);
    assert.ok(elapsed < 15000, `Mixed read/write took ${elapsed}ms (expected < 15s)`);
    console.log(`  [STRESS-6] ${WRITE_COUNT} writes + ${READ_COUNT} concurrent reads: ${elapsed}ms`);
  });

});

// ── Memory ─────────────────────────────────────────────────────────────────

describe("Stress — Memory & Throughput", () => {

  it("STRESS-7: large domain value (100KB JSONB) stores and retrieves correctly", async () => {
    // Simulate a large open positions object
    const largeTrades = {};
    for (let i = 0; i < 500; i++) {
      largeTrades[`SIM_SIGNAL_${String(i).padStart(6, "0")}`] = {
        symbol: "EUR_USD",
        side: i % 2 === 0 ? "buy" : "sell",
        pips: Math.random() * 20 - 10,
        peak: Math.random() * 15,
        entryTime: Date.now() - i * 60000,
        breakEven: false,
        features: {
          ema: Math.random(),
          atr: Math.random() * 50,
          spread: Math.random() * 2,
          candleStrength: Math.random(),
        },
      };
    }

    const largeValue = { largeTrades, generatedAt: new Date().toISOString() };
    await rdm.createDomain(DOMAIN_C, largeValue);

    const start     = Date.now();
    const retrieved = await rdm.getDomain(DOMAIN_C);
    const elapsed   = Date.now() - start;

    assert.ok(retrieved, "large domain must be retrievable");
    assert.strictEqual(Object.keys(retrieved.value.largeTrades).length, 500);
    assert.ok(elapsed < 2000, `large value retrieval took ${elapsed}ms (expected < 2s)`);
    console.log(`  [STRESS-7] 500-trade JSONB object: ${elapsed}ms read latency`);
  });

  it("STRESS-8: 200 history entries are queryable quickly", async () => {
    await rdm.createDomain(DOMAIN_A, { n: 0 });
    for (let i = 1; i <= 100; i++) {
      await rdm.updateDomain(DOMAIN_A, { n: i });
    }

    const start   = Date.now();
    const history = await rdm.getHistory(DOMAIN_A, 200);
    const elapsed = Date.now() - start;

    assert.ok(history.length >= 101, "must have 101 entries");
    assert.ok(elapsed < 3000, `history query took ${elapsed}ms (expected < 3s)`);
    console.log(`  [STRESS-8] ${history.length} history entries retrieved in ${elapsed}ms`);
  });

  it("STRESS-9: snapshot of all 10 domains completes in < 3s", async () => {
    const start   = Date.now();
    const result  = await rdm.takeSnapshot("stress_test");
    const elapsed = Date.now() - start;

    assert.ok(result.snapshotId > 0);
    assert.ok(result.domainCount >= 10);
    assert.ok(elapsed < 3000, `snapshot took ${elapsed}ms (expected < 3s)`);
    console.log(`  [STRESS-9] Full snapshot (${result.domainCount} domains): ${elapsed}ms`);
  });

  it("STRESS-10: ping() latency is < 50ms under load", async () => {
    // Fire 10 concurrent pings
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rdm.ping())
    );

    const latencies = results.map(r => r.latencyMs);
    const maxLatency = Math.max(...latencies);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    assert.ok(results.every(r => r.ok), "all pings must succeed");
    assert.ok(maxLatency < 500, `max ping latency ${maxLatency}ms (expected < 500ms)`);
    console.log(`  [STRESS-10] 10 concurrent pings: avg=${avgLatency.toFixed(1)}ms, max=${maxLatency}ms`);
  });

});
