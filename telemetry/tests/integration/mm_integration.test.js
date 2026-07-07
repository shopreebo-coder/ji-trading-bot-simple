"use strict";
/**
 * Sprint 3 — MemoryManager Integration Tests
 *
 * Full memory-lifecycle flows against live PostgreSQL:
 *   • create → append → update → tag → archive → restore chains
 *   • append-first invariants under multi-step flows
 *   • history/version continuity across complex sequences
 *   • concurrent mutation safety (SELECT FOR UPDATE serialization)
 *   • dedupe under concurrency
 *   • KV cache and event-memory coexistence
 *
 * All test data uses source = 'test_mm_int' and is cleaned up.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/integration/mm_integration.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { MemoryManager } = require("../../managers/MemoryManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SRC   = "test_mm_int";
const KV_NS = "test_mm_int_ns";
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
    event_type: "TEST_MM_INT_EVENT",
    runtime_domain: "meta",
    payload: { origin: "integration" },
    source: SRC,
    ...overrides,
  };
}

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  mm   = new MemoryManager({ _pool: pool });
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

// ── Full lifecycle chains ────────────────────────────────────────────────────

describe("MM Integration — full lifecycle", () => {

  it("create → append×3 → update → tag → archive → restore: every step audited", async () => {
    const { row } = await mm.createMemory(mem({
      importance: 0.5, tags: ["initial"], reasoning: "entry signal",
    }));

    await mm.appendMemory(row.id, { step: 1, note: "confirmation received" });
    await mm.appendMemory(row.id, { step: 2, note: "position opened" });
    await mm.appendMemory(row.id, { step: 3, note: "position closed +12 pips" });
    await mm.updateMemory(row.id, { importance: 0.9, reasoning: "profitable pattern" });
    await mm.tagMemory(row.id, { add: ["win", "london"] });
    await mm.archiveMemory(row.id, "trade cycle complete");
    const { row: fin } = await mm.restoreMemory(row.id, "needed for analysis");

    assert.equal(fin.status, "ACTIVE");
    assert.equal(String(fin.version), "8");
    assert.equal(fin.context.length, 3);
    assert.equal(fin.context[2].addendum.note, "position closed +12 pips");
    assert.equal(fin.importance, 0.9);
    assert.deepEqual(fin.tags.sort(), ["initial", "london", "win"]);
    // immutables preserved through the whole chain
    assert.deepEqual(fin.payload, { origin: "integration" });
    assert.equal(fin.event_type, "TEST_MM_INT_EVENT");

    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 8);
    const ops = hist.map(h => h.change_op).reverse();
    assert.deepEqual(ops, ["CREATE", "APPEND", "APPEND", "APPEND", "UPDATE", "TAG", "ARCHIVE", "RESTORE"]);
    // versions are strictly monotonic 1..8
    const versions = hist.map(h => Number(h.version)).reverse();
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8]);
    // each snapshot is a full row copy
    for (const h of hist) {
      assert.equal(String(h.snapshot.id), String(row.id));
      assert.ok(h.snapshot.status);
      assert.ok(h.snapshot.payload);
    }
  });

  it("history snapshots let you reconstruct any past state", async () => {
    const { row } = await mm.createMemory(mem({ importance: 0.2 }));
    await mm.updateMemory(row.id, { importance: 0.6 });
    await mm.updateMemory(row.id, { importance: 0.95 });

    const hist = await mm.getMemoryHistory(row.id);
    const byVersion = Object.fromEntries(hist.map(h => [Number(h.version), h.snapshot]));
    assert.equal(byVersion[1].importance, 0.2);
    assert.equal(byVersion[2].importance, 0.6);
    assert.equal(byVersion[3].importance, 0.95);
  });

  it("archive/restore cycles preserve every layer of context", async () => {
    const { row } = await mm.createMemory(mem());
    for (let cycle = 0; cycle < 3; cycle++) {
      await mm.appendMemory(row.id, { cycle });
      await mm.archiveMemory(row.id, `cycle ${cycle}`);
      await mm.restoreMemory(row.id, `cycle ${cycle}`);
    }
    const fin = await mm.getMemory(row.id);
    assert.equal(fin.context.length, 3);
    assert.equal(String(fin.version), "10"); // 1 + 3×3
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 10);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("MM Integration — concurrency", () => {

  it("concurrent appends all land — no lost updates", async () => {
    const { row } = await mm.createMemory(mem());
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) => mm.appendMemory(row.id, { i }))
    );
    const fin = await mm.getMemory(row.id);
    assert.equal(fin.context.length, N);
    assert.equal(String(fin.version), String(N + 1));
    const seen = new Set(fin.context.map(c => c.addendum.i));
    assert.equal(seen.size, N);
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, N + 1);
  });

  it("concurrent createMemory with same dedupe_key yields exactly one row", async () => {
    const key = `test_mm_int_race_${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => mm.createMemory(mem({ dedupe_key: key })))
    );
    const createdCount = results.filter(r => r.created).length;
    assert.equal(createdCount, 1, "exactly one create must win");
    const ids = new Set(results.filter(r => r.row).map(r => String(r.row.id)));
    assert.equal(ids.size, 1);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM memory_events WHERE dedupe_key = $1`, [key]
    );
    assert.equal(Number(rows[0].n), 1);
    // exactly one CREATE history row
    const winner = results.find(r => r.created).row;
    const hist = await mm.getMemoryHistory(winner.id);
    assert.equal(hist.length, 1);
  });

  it("concurrent archive + update: exactly one wins per state rule", async () => {
    const { row } = await mm.createMemory(mem());
    const outcomes = await Promise.allSettled([
      mm.archiveMemory(row.id, "race"),
      mm.updateMemory(row.id, { importance: 0.7 }),
    ]);
    const fulfilled = outcomes.filter(o => o.status === "fulfilled").length;
    // Serialization via FOR UPDATE: both may succeed if update commits first,
    // or update fails after archive commits. Never both fail; never a corrupt row.
    assert.ok(fulfilled >= 1);
    const fin = await mm.getMemory(row.id);
    assert.ok(["ACTIVE", "ARCHIVED"].includes(fin.status));
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(String(hist.length), String(fin.version), "history count must equal version");
  });

  it("mixed concurrent ops across many memories keep global consistency", async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const { row } = await mm.createMemory(mem({ strategy_id: `s_${i}` }));
      rows.push(row);
    }
    await Promise.all(rows.flatMap(r => [
      mm.appendMemory(r.id, { probe: 1 }),
      mm.tagMemory(r.id, { add: ["bulk"] }),
      mm.updateMemory(r.id, { importance: 0.8 }),
    ]));
    for (const r of rows) {
      const fin  = await mm.getMemory(r.id);
      const hist = await mm.getMemoryHistory(r.id);
      assert.equal(String(hist.length), String(fin.version));
      assert.equal(String(fin.version), "4");
    }
    // validator agrees
    const res = await mm.validateMemory({ markCorrupted: false });
    const ourIssues = res.issues.filter(i => rows.some(r => String(r.id) === String(i.memoryId)));
    assert.equal(ourIssues.length, 0);
  });
});

// ── Search over realistic data ───────────────────────────────────────────────

describe("MM Integration — realistic search flows", () => {

  it("trading-day reconstruction: query by domain, strategy, time and tags", async () => {
    const day = (h) => new Date(`2026-07-06T${String(h).padStart(2, "0")}:00:00Z`);
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_TRADE", runtime_domain: "live",
      strategy_id: "breakout", symbol: "EUR_USD", tags: ["win"], importance: 0.9,
      occurred_at: day(8), reasoning: "london open breakout" }));
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_TRADE", runtime_domain: "live",
      strategy_id: "meanrev", symbol: "GBP_USD", tags: ["loss"], importance: 0.4,
      occurred_at: day(11), reasoning: "failed reversion" }));
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_SIGNAL", runtime_domain: "shadowA",
      strategy_id: "breakout", symbol: "EUR_USD", tags: ["filtered"], importance: 0.2,
      occurred_at: day(14), reasoning: "shadow filtered low-quality signal" }));

    // The whole trading day
    const dayRows = await mm.queryByTime(day(0), day(23), { source: SRC });
    assert.equal(dayRows.length, 3);
    // Live trades only
    assert.equal((await mm.queryByDomain("live", { source: SRC })).length, 2);
    // Breakout strategy across domains
    assert.equal((await mm.queryByStrategy("breakout", { source: SRC })).length, 2);
    // Wins with high importance
    const wins = await mm.searchMemory({ tagsAny: ["win"], minImportance: 0.5, source: SRC });
    assert.equal(wins.length, 1);
    assert.equal(wins[0].symbol, "EUR_USD");
    // Text search over reasoning
    assert.equal((await mm.searchMemory({ text: "reversion", source: SRC })).length, 1);
  });

  it("summarizeMemory reflects the seeded day accurately", async () => {
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_A", tags: ["x"], importance: 1.0 }));
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_A", tags: ["x", "y"], importance: 0.0 }));
    const sum = await mm.summarizeMemory();
    assert.ok(sum.byEventType["TEST_MM_INT_A"] >= 2);
    assert.ok(sum.topTags["x"] >= 2);
    assert.ok(sum.importance.min === 0);
    assert.ok(sum.importance.max === 1);
  });
});

// ── KV + event-memory coexistence ────────────────────────────────────────────

describe("MM Integration — KV cache coexists with event memory", () => {

  it("KV churn (set/expire/gc) leaves event memory untouched", async () => {
    const { row } = await mm.createMemory(mem({ reasoning: "must survive" }));
    await mm.appendMemory(row.id, { key: "context" });

    // Heavy KV churn
    for (let i = 0; i < 20; i++) {
      await mm.kvSet(KV_NS, `churn_${i}`, { i }, { ttlSeconds: 1 });
    }
    await new Promise(r => setTimeout(r, 1200));
    const { removed } = await mm.kvGc();
    assert.ok(removed >= 20);

    const fin  = await mm.getMemory(row.id);
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(fin.reasoning, "must survive");
    assert.equal(fin.context.length, 1);
    assert.equal(hist.length, 2);
  });

  it("KV can cache derived views of event memory", async () => {
    await mm.createMemory(mem({ event_type: "TEST_MM_INT_CACHE", importance: 0.9 }));
    const sum = await mm.summarizeMemory();
    await mm.kvSet(KV_NS, "latest_summary", sum, { ttlSeconds: 300 });
    const cached = await mm.kvGet(KV_NS, "latest_summary");
    assert.equal(cached.total, sum.total);
    assert.equal(cached.generatedAt, sum.generatedAt);
  });
});
