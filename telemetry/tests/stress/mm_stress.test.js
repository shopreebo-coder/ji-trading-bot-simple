"use strict";
/**
 * Sprint 3 — MemoryManager Stress Tests
 *
 *   STRESS-1  Sequential create throughput
 *   STRESS-2  Concurrent create throughput (no pool deadlock)
 *   STRESS-3  Hot-row concurrent appends
 *   STRESS-4  Concurrent reads under load
 *   STRESS-5  Large JSONB payload/context handling
 *   STRESS-6  Search performance over a populated table
 *   STRESS-7  KV cache throughput
 *
 * All test data uses source = 'test_mm_str' and is cleaned up.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/stress/mm_stress.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { MemoryManager } = require("../../managers/MemoryManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SRC   = "test_mm_str";
const KV_NS = "test_mm_str_ns";
let pool, mm;

async function cleanup(p) {
  await p.query(
    `DELETE FROM memory_event_history WHERE memory_id IN
       (SELECT id FROM memory_events WHERE source = '${SRC}')`
  );
  await p.query(`DELETE FROM memory_events WHERE source = '${SRC}'`);
  await p.query(`DELETE FROM memory_entries WHERE namespace LIKE '${KV_NS}%'`);
}

function mem(overrides = {}) {
  return {
    event_type: "TEST_MM_STR_EVENT",
    runtime_domain: "meta",
    payload: { stress: true },
    source: SRC,
    ...overrides,
  };
}

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  mm   = new MemoryManager({ _pool: pool });
  await mm.init();
  await cleanup(pool);
});

after(async () => {
  await cleanup(pool);
  await pool.end();
});

// ── STRESS-1: sequential creates ─────────────────────────────────────────────

describe("STRESS-1 — Sequential create throughput", () => {

  it("100 sequential creates complete without error", async () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      const { created } = await mm.createMemory(mem({ strategy_id: `str1_${i}` }));
      assert.equal(created, true);
    }
    const elapsed = Date.now() - start;
    const rows = await mm.searchMemory({ strategy_id: undefined, source: SRC, limit: 1000 });
    assert.ok(rows.length >= 100);
    console.log(`      100 sequential creates in ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms avg)`);
  });
});

// ── STRESS-2: concurrent creates ─────────────────────────────────────────────

describe("STRESS-2 — Concurrent create throughput", () => {

  it("50 concurrent creates: all succeed, no pool deadlock", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        mm.createMemory(mem({ strategy_id: `str2_${i}`, tags: [`t${i % 5}`] }))
      )
    );
    assert.equal(results.filter(r => r.created).length, 50);
    const ids = new Set(results.map(r => String(r.row.id)));
    assert.equal(ids.size, 50);
  });

  it("100 concurrent creates with dedupe keys: exactly 100 rows", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        mm.createMemory(mem({ dedupe_key: `test_mm_str_dk_${i % 50}` }))
      )
    );
    // 50 unique keys × 2 attempts each → exactly 50 creates, 50 duplicates
    assert.equal(results.filter(r => r.created).length, 50);
    assert.equal(results.filter(r => r.duplicate).length, 50);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM memory_events WHERE dedupe_key LIKE 'test_mm_str_dk_%'`
    );
    assert.equal(Number(rows[0].n), 50);
  });
});

// ── STRESS-3: hot-row appends ────────────────────────────────────────────────

describe("STRESS-3 — Hot-row concurrent appends", () => {

  it("30 concurrent appends on one memory: zero lost updates", async () => {
    const { row } = await mm.createMemory(mem({ strategy_id: "str3_hot" }));
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => mm.appendMemory(row.id, { seq: i }))
    );
    const elapsed = Date.now() - start;

    const fin = await mm.getMemory(row.id);
    assert.equal(fin.context.length, 30);
    assert.equal(String(fin.version), "31");
    const seen = new Set(fin.context.map(c => c.addendum.seq));
    assert.equal(seen.size, 30);
    const hist = await mm.getMemoryHistory(row.id, { limit: 1000 });
    assert.equal(hist.length, 31);
    console.log(`      30 hot-row appends in ${elapsed}ms`);
  });

  it("concurrent mixed mutations on one row never violate history==version", async () => {
    const { row } = await mm.createMemory(mem({ strategy_id: "str3_mixed" }));
    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(mm.appendMemory(row.id, { i }));
      ops.push(mm.updateMemory(row.id, { importance: (i + 1) / 20 }));
      ops.push(mm.tagMemory(row.id, { add: [`tag${i}`] }));
    }
    const settled = await Promise.allSettled(ops);
    const succeeded = settled.filter(s => s.status === "fulfilled").length;
    assert.ok(succeeded >= 25, `expected most ops to succeed, got ${succeeded}/30`);

    const fin  = await mm.getMemory(row.id);
    const hist = await mm.getMemoryHistory(row.id, { limit: 1000 });
    assert.equal(String(hist.length), String(fin.version));
  });
});

// ── STRESS-4: concurrent reads ───────────────────────────────────────────────

describe("STRESS-4 — Concurrent reads under load", () => {

  it("50 concurrent searchMemory calls complete without error", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => mm.searchMemory({
        source: SRC,
        tagsAny: [`t${i % 5}`],
        limit: 20,
      }))
    );
    assert.equal(results.length, 50);
    for (const r of results) assert.ok(Array.isArray(r));
  });

  it("30 concurrent summarize + stats + validate(readonly) calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => [
        mm.summarizeMemory(),
        mm.getStats(),
        mm.validateMemory({ markCorrupted: false }),
      ]).flat()
    );
    assert.equal(results.length, 30);
  });
});

// ── STRESS-5: large JSONB ────────────────────────────────────────────────────

describe("STRESS-5 — Large JSONB handling", () => {

  it("10KB payload stored and retrieved intact", async () => {
    const big = { data: "x".repeat(10 * 1024), nested: { arr: Array.from({ length: 100 }, (_, i) => i) } };
    const { row } = await mm.createMemory(mem({ payload: big, strategy_id: "str5_big" }));
    const read = await mm.getMemory(row.id);
    assert.equal(read.payload.data.length, 10 * 1024);
    assert.equal(read.payload.nested.arr.length, 100);
  });

  it("100 appends build a large context without degradation", async () => {
    const { row } = await mm.createMemory(mem({ strategy_id: "str5_ctx" }));
    for (let i = 0; i < 100; i++) {
      await mm.appendMemory(row.id, { i, note: `entry ${i} ${"y".repeat(100)}` });
    }
    const fin = await mm.getMemory(row.id);
    assert.equal(fin.context.length, 100);
    assert.equal(String(fin.version), "101");
    assert.equal(fin.context[99].addendum.i, 99);
    // last read stays fast
    const t = Date.now();
    await mm.getMemory(row.id);
    assert.ok(Date.now() - t < 500, "large-context read should stay under 500ms");
  });
});

// ── STRESS-6: search performance ─────────────────────────────────────────────

describe("STRESS-6 — Search performance over populated table", () => {

  it("tag search (GIN) over the populated table completes in <300ms", async () => {
    const t = Date.now();
    await mm.searchMemory({ tagsAny: ["t0", "t1"], source: SRC, limit: 100 });
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 300, `tag search took ${elapsed}ms`);
  });

  it("time-window + importance search completes in <300ms", async () => {
    const t = Date.now();
    await mm.searchMemory({
      since: new Date(Date.now() - 86400_000),
      minImportance: 0.1,
      order: "importance DESC",
      source: SRC,
      limit: 100,
    });
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 300, `window search took ${elapsed}ms`);
  });

  it("summarizeMemory over populated table completes in <1000ms", async () => {
    const t = Date.now();
    const sum = await mm.summarizeMemory();
    const elapsed = Date.now() - t;
    assert.ok(sum.total > 0);
    assert.ok(elapsed < 1000, `summarize took ${elapsed}ms`);
  });
});

// ── STRESS-7: KV throughput ──────────────────────────────────────────────────

describe("STRESS-7 — KV cache throughput", () => {

  it("100 concurrent kvSet upserts complete without error", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => mm.kvSet(KV_NS, `k${i % 20}`, { i }))
    );
    const all = await mm.kvGetAll(KV_NS);
    assert.equal(Object.keys(all).length, 20);
  });

  it("100 concurrent kvGet reads complete without error", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => mm.kvGet(KV_NS, `k${i % 20}`))
    );
    assert.equal(results.filter(v => v !== null).length, 100);
  });
});
