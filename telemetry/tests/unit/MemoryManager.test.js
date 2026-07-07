"use strict";
/**
 * Sprint 3 — MemoryManager Unit Tests
 *
 * Tests every public method against the live PostgreSQL database.
 * All test data uses source = 'test_mm_unit' and is cleaned up.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/unit/MemoryManager.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { MemoryManager, VALID_STATUSES, VALID_CHANGE_OPS, MUTABLE_FIELDS, IMMUTABLE_FIELDS } =
  require("../../managers/MemoryManager");

// ── Setup ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || "";
const SRC    = "test_mm_unit";
const KV_NS  = "test_mm_unit_ns";
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
    event_type: "TEST_MM_EVENT",
    runtime_domain: "meta",
    strategy_id: "test_strategy",
    symbol: "EUR_USD",
    payload: { price: 1.0842 },
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

beforeEach(async () => {
  await cleanup(pool);
});

// ── Constructor ──────────────────────────────────────────────────────────────

describe("MemoryManager — Constructor", () => {

  it("rejects invalid connection string", () => {
    assert.throws(
      () => new MemoryManager({ connectionString: "mysql://bad" }),
      /connectionString must start with postgres/
    );
  });

  it("rejects empty connection string", () => {
    assert.throws(
      () => new MemoryManager({ connectionString: "" }),
      /connectionString must start with postgres/
    );
  });

  it("accepts a pre-created pool via _pool option", () => {
    const m = new MemoryManager({ _pool: pool });
    assert.ok(m);
  });

  it("exports the expected constants", () => {
    assert.ok(VALID_STATUSES.has("ACTIVE"));
    assert.ok(VALID_STATUSES.has("ARCHIVED"));
    assert.ok(VALID_STATUSES.has("CORRUPTED"));
    for (const op of ["CREATE", "APPEND", "UPDATE", "TAG", "ARCHIVE", "RESTORE", "VALIDATE"]) {
      assert.ok(VALID_CHANGE_OPS.has(op), `missing change_op ${op}`);
    }
    assert.ok(MUTABLE_FIELDS.has("importance"));
    assert.ok(IMMUTABLE_FIELDS.has("payload"));
    assert.ok(IMMUTABLE_FIELDS.has("event_type"));
    assert.ok(IMMUTABLE_FIELDS.has("occurred_at"));
  });
});

// ── init / ping ──────────────────────────────────────────────────────────────

describe("MemoryManager — init & ping", () => {

  it("init() verifies required tables", async () => {
    const m = new MemoryManager({ _pool: pool });
    const res = await m.init();
    assert.equal(res.ok, true);
    assert.ok(res.tables.includes("memory_events"));
    assert.ok(res.tables.includes("memory_event_history"));
    assert.ok(res.tables.includes("memory_entries"));
  });

  it("methods throw before init()", async () => {
    const m = new MemoryManager({ _pool: pool });
    await assert.rejects(() => m.createMemory(mem()), /call init\(\)/);
    await assert.rejects(() => m.searchMemory({}), /call init\(\)/);
    await assert.rejects(() => m.kvGet("x", "y"), /call init\(\)/);
  });

  it("ping() returns ok with latency", async () => {
    const res = await mm.ping();
    assert.equal(res.ok, true);
    assert.ok(typeof res.latencyMs === "number");
  });
});

// ── createMemory ─────────────────────────────────────────────────────────────

describe("MemoryManager — createMemory", () => {

  it("creates a memory with version=1, status=ACTIVE", async () => {
    const { created, duplicate, row } = await mm.createMemory(mem({
      importance: 0.8, tags: ["a", "b"], reasoning: "why",
      metadata: { k: 1 },
    }));
    assert.equal(created, true);
    assert.equal(duplicate, false);
    assert.equal(row.status, "ACTIVE");
    assert.equal(String(row.version), "1");
    assert.equal(row.event_type, "TEST_MM_EVENT");
    assert.equal(row.runtime_domain, "meta");
    assert.equal(row.importance, 0.8);
    assert.deepEqual(row.tags, ["a", "b"]);
    assert.deepEqual(row.payload, { price: 1.0842 });
    assert.deepEqual(row.context, []);
    assert.deepEqual(row.metadata, { k: 1 });
  });

  it("applies defaults", async () => {
    const { row } = await mm.createMemory({ event_type: "TEST_MM_DEF", source: SRC });
    assert.equal(row.runtime_domain, "live");
    assert.equal(row.strategy_id, "default");
    assert.equal(row.importance, 0.5);
    assert.deepEqual(row.tags, []);
    assert.deepEqual(row.payload, {});
    assert.ok(row.occurred_at);
  });

  it("writes a CREATE history record with full snapshot", async () => {
    const { row } = await mm.createMemory(mem());
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].change_op, "CREATE");
    assert.equal(String(hist[0].version), "1");
    assert.equal(String(hist[0].snapshot.id), String(row.id));
    assert.equal(hist[0].snapshot.event_type, "TEST_MM_EVENT");
  });

  it("is idempotent on dedupe_key (no duplicate, no extra history)", async () => {
    const key = `test_mm_dedupe_${Date.now()}`;
    const first = await mm.createMemory(mem({ dedupe_key: key }));
    const second = await mm.createMemory(mem({ dedupe_key: key, payload: { different: true } }));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.duplicate, true);
    assert.equal(String(second.row.id), String(first.row.id));
    // original payload untouched
    assert.deepEqual(second.row.payload, { price: 1.0842 });
    const hist = await mm.getMemoryHistory(first.row.id);
    assert.equal(hist.length, 1);
  });

  it("respects explicit occurred_at", async () => {
    const when = new Date("2026-01-15T12:00:00Z");
    const { row } = await mm.createMemory(mem({ occurred_at: when }));
    assert.equal(new Date(row.occurred_at).toISOString(), when.toISOString());
  });

  it("rejects missing event_type", async () => {
    await assert.rejects(() => mm.createMemory({ source: SRC }), /event_type is required/);
    await assert.rejects(() => mm.createMemory({ event_type: "  ", source: SRC }), /event_type is required/);
  });

  it("rejects out-of-range importance", async () => {
    await assert.rejects(() => mm.createMemory(mem({ importance: 1.5 })), /importance must be between/);
    await assert.rejects(() => mm.createMemory(mem({ importance: -0.1 })), /importance must be between/);
  });

  it("rejects invalid tags", async () => {
    await assert.rejects(() => mm.createMemory(mem({ tags: ["ok", ""] })), /tags must be/);
    await assert.rejects(() => mm.createMemory(mem({ tags: "notarray" })), /tags must be/);
  });

  it("rejects non-object payload/metadata", async () => {
    await assert.rejects(() => mm.createMemory(mem({ payload: [1, 2] })), /payload must be a plain object/);
    await assert.rejects(() => mm.createMemory(mem({ metadata: "str" })), /metadata must be a plain object/);
  });

  it("rejects invalid trade_intent_id and dedupe_key", async () => {
    await assert.rejects(() => mm.createMemory(mem({ trade_intent_id: -5 })), /trade_intent_id/);
    await assert.rejects(() => mm.createMemory(mem({ dedupe_key: "   " })), /dedupe_key/);
  });
});

// ── appendMemory ─────────────────────────────────────────────────────────────

describe("MemoryManager — appendMemory", () => {

  it("appends addenda to context, bumps version, audits APPEND", async () => {
    const { row } = await mm.createMemory(mem());
    const a1 = await mm.appendMemory(row.id, { note: "first" });
    assert.equal(String(a1.row.version), "2");
    assert.equal(a1.row.context.length, 1);
    assert.equal(a1.row.context[0].addendum.note, "first");
    assert.ok(a1.row.context[0].appended_at);
    assert.equal(a1.row.context[0].appended_by, "system");

    const a2 = await mm.appendMemory(row.id, { note: "second" }, { calledBy: "test_runner" });
    assert.equal(String(a2.row.version), "3");
    assert.equal(a2.row.context.length, 2);
    assert.equal(a2.row.context[1].addendum.note, "second");
    assert.equal(a2.row.context[1].appended_by, "test_runner");

    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.map(h => h.change_op).sort(), ["APPEND", "APPEND", "CREATE"]);
  });

  it("never mutates payload or occurred_at", async () => {
    const { row } = await mm.createMemory(mem());
    const before = { payload: row.payload, occurred_at: row.occurred_at, event_type: row.event_type };
    const { row: after } = await mm.appendMemory(row.id, { anything: true });
    assert.deepEqual(after.payload, before.payload);
    assert.equal(new Date(after.occurred_at).toISOString(), new Date(before.occurred_at).toISOString());
    assert.equal(after.event_type, before.event_type);
  });

  it("rejects non-object addendum", async () => {
    const { row } = await mm.createMemory(mem());
    await assert.rejects(() => mm.appendMemory(row.id, "string"), /addendum must be a plain object/);
    await assert.rejects(() => mm.appendMemory(row.id, [1]), /addendum must be a plain object/);
    await assert.rejects(() => mm.appendMemory(row.id, null), /addendum must be a plain object/);
  });

  it("rejects append on ARCHIVED memory", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.archiveMemory(row.id);
    await assert.rejects(() => mm.appendMemory(row.id, { x: 1 }), /invalid APPEND.*ARCHIVED/);
  });

  it("rejects unknown memory id", async () => {
    await assert.rejects(() => mm.appendMemory(999999999, { x: 1 }), /not found/);
    await assert.rejects(() => mm.appendMemory("bogus", { x: 1 }), /invalid memoryId/);
  });
});

// ── updateMemory ─────────────────────────────────────────────────────────────

describe("MemoryManager — updateMemory", () => {

  it("updates mutable fields and audits UPDATE", async () => {
    const { row } = await mm.createMemory(mem({ importance: 0.5 }));
    const { row: updated } = await mm.updateMemory(row.id, {
      importance: 0.9, tags: ["new"], reasoning: "revised", metadata: { rev: 2 },
    });
    assert.equal(updated.importance, 0.9);
    assert.deepEqual(updated.tags, ["new"]);
    assert.equal(updated.reasoning, "revised");
    assert.deepEqual(updated.metadata, { rev: 2 });
    assert.equal(String(updated.version), "2");

    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist[0].change_op, "UPDATE");
    assert.deepEqual(hist[0].detail.patched.sort(), ["importance", "metadata", "reasoning", "tags"]);
  });

  it("rejects every immutable field", async () => {
    const { row } = await mm.createMemory(mem());
    for (const field of ["payload", "event_type", "occurred_at", "runtime_domain",
                         "trade_intent_id", "strategy_id", "symbol", "source", "dedupe_key"]) {
      await assert.rejects(
        () => mm.updateMemory(row.id, { [field]: "x" }),
        /immutable — memory is append-first/,
        `expected immutability rejection for ${field}`
      );
    }
  });

  it("rejects unknown fields and empty patch", async () => {
    const { row } = await mm.createMemory(mem());
    await assert.rejects(() => mm.updateMemory(row.id, { bogus: 1 }), /unknown or non-mutable field/);
    await assert.rejects(() => mm.updateMemory(row.id, {}), /at least one field/);
  });

  it("allows setting reasoning to null", async () => {
    const { row } = await mm.createMemory(mem({ reasoning: "original" }));
    const { row: updated } = await mm.updateMemory(row.id, { reasoning: null });
    assert.equal(updated.reasoning, null);
  });

  it("rejects update on non-ACTIVE memory", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.archiveMemory(row.id);
    await assert.rejects(() => mm.updateMemory(row.id, { importance: 0.1 }), /invalid UPDATE.*ARCHIVED/);
  });
});

// ── tagMemory ────────────────────────────────────────────────────────────────

describe("MemoryManager — tagMemory", () => {

  it("adds and removes tags, deduplicates, audits TAG", async () => {
    const { row } = await mm.createMemory(mem({ tags: ["keep", "drop"] }));
    const { row: tagged } = await mm.tagMemory(row.id, { add: ["new", "keep"], remove: ["drop"] });
    assert.deepEqual(tagged.tags.sort(), ["keep", "new"]);
    assert.equal(String(tagged.version), "2");

    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist[0].change_op, "TAG");
    assert.deepEqual(hist[0].detail.added, ["new", "keep"]);
    assert.deepEqual(hist[0].detail.removed, ["drop"]);
  });

  it("rejects empty change", async () => {
    const { row } = await mm.createMemory(mem());
    await assert.rejects(() => mm.tagMemory(row.id, {}), /provide tags/);
  });

  it("rejects tagging non-ACTIVE memory", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.archiveMemory(row.id);
    await assert.rejects(() => mm.tagMemory(row.id, { add: ["x"] }), /invalid TAG.*ARCHIVED/);
  });
});

// ── archive / restore ────────────────────────────────────────────────────────

describe("MemoryManager — archiveMemory / restoreMemory", () => {

  it("ACTIVE → ARCHIVED → ACTIVE round trip, fully audited", async () => {
    const { row } = await mm.createMemory(mem());
    const { row: archived } = await mm.archiveMemory(row.id, "test reason");
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(String(archived.version), "2");

    const { row: restored } = await mm.restoreMemory(row.id, "bring back");
    assert.equal(restored.status, "ACTIVE");
    assert.equal(String(restored.version), "3");

    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 3);
    assert.equal(hist[0].change_op, "RESTORE");
    assert.equal(hist[0].detail.reason, "bring back");
    assert.equal(hist[1].change_op, "ARCHIVE");
    assert.equal(hist[1].detail.reason, "test reason");
  });

  it("rejects double archive", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.archiveMemory(row.id);
    await assert.rejects(() => mm.archiveMemory(row.id), /invalid ARCHIVE.*ARCHIVED/);
  });

  it("rejects restore of ACTIVE memory", async () => {
    const { row } = await mm.createMemory(mem());
    await assert.rejects(() => mm.restoreMemory(row.id), /invalid RESTORE.*ACTIVE/);
  });

  it("restores CORRUPTED memory back to ACTIVE", async () => {
    const { row } = await mm.createMemory(mem());
    // corrupt via raw SQL (simulating external damage), then validate marks it
    await pool.query(`UPDATE memory_events SET context = '"broken"'::jsonb WHERE id = $1`, [row.id]);
    const res = await mm.validateMemory();
    assert.ok(res.corrupted.map(String).includes(String(row.id)));
    // repair + restore
    await pool.query(`UPDATE memory_events SET context = '[]'::jsonb WHERE id = $1`, [row.id]);
    const { row: restored } = await mm.restoreMemory(row.id, "repaired");
    assert.equal(restored.status, "ACTIVE");
  });

  it("archived memory remains fully readable — nothing deleted", async () => {
    const { row } = await mm.createMemory(mem({ reasoning: "precious" }));
    await mm.appendMemory(row.id, { note: "context" });
    await mm.archiveMemory(row.id);
    const read = await mm.getMemory(row.id);
    assert.equal(read.reasoning, "precious");
    assert.equal(read.context.length, 1);
    assert.deepEqual(read.payload, { price: 1.0842 });
  });
});

// ── search & queries ─────────────────────────────────────────────────────────

describe("MemoryManager — searchMemory & queryBy*", () => {

  async function seed() {
    const a = await mm.createMemory(mem({
      event_type: "TEST_MM_TRADE", runtime_domain: "live", strategy_id: "s1",
      symbol: "EUR_USD", tags: ["win", "london"], importance: 0.9,
      reasoning: "strong breakout signal",
      occurred_at: new Date("2026-07-01T10:00:00Z"),
    }));
    const b = await mm.createMemory(mem({
      event_type: "TEST_MM_TRADE", runtime_domain: "shadowA", strategy_id: "s2",
      symbol: "GBP_USD", tags: ["loss"], importance: 0.3,
      reasoning: "false signal in chop",
      occurred_at: new Date("2026-07-02T10:00:00Z"),
    }));
    const c = await mm.createMemory(mem({
      event_type: "TEST_MM_SIGNAL", runtime_domain: "live", strategy_id: "s1",
      symbol: "EUR_USD", tags: ["win", "ny"], importance: 0.7,
      occurred_at: new Date("2026-07-03T10:00:00Z"),
    }));
    return { a: a.row, b: b.row, c: c.row };
  }

  it("filters by event_type / domain / strategy / symbol", async () => {
    await seed();
    assert.equal((await mm.searchMemory({ event_type: "TEST_MM_TRADE", source: SRC })).length, 2);
    assert.equal((await mm.searchMemory({ runtime_domain: "shadowA", source: SRC })).length, 1);
    assert.equal((await mm.searchMemory({ strategy_id: "s1", source: SRC })).length, 2);
    assert.equal((await mm.searchMemory({ symbol: "GBP_USD", source: SRC })).length, 1);
  });

  it("filters by tagsAny (&&) and tagsAll (@>)", async () => {
    await seed();
    assert.equal((await mm.searchMemory({ tagsAny: ["win", "loss"], source: SRC })).length, 3);
    assert.equal((await mm.searchMemory({ tagsAll: ["win", "london"], source: SRC })).length, 1);
    assert.equal((await mm.searchMemory({ tagsAny: ["nonexistent"], source: SRC })).length, 0);
  });

  it("filters by minImportance and text", async () => {
    await seed();
    assert.equal((await mm.searchMemory({ minImportance: 0.6, source: SRC })).length, 2);
    assert.equal((await mm.searchMemory({ text: "breakout", source: SRC })).length, 1);
  });

  it("filters by time window with ordering", async () => {
    await seed();
    const rows = await mm.searchMemory({
      since: "2026-07-01T00:00:00Z", until: "2026-07-02T23:59:59Z", source: SRC,
    });
    assert.equal(rows.length, 2);
    // occurred_at DESC
    assert.ok(new Date(rows[0].occurred_at) > new Date(rows[1].occurred_at));
  });

  it("respects status filter — ACTIVE default, ANY for all", async () => {
    const { a } = await seed();
    await mm.archiveMemory(a.id);
    assert.equal((await mm.searchMemory({ source: SRC })).length, 2);
    assert.equal((await mm.searchMemory({ status: "ARCHIVED", source: SRC })).length, 1);
    assert.equal((await mm.searchMemory({ status: "ANY", source: SRC })).length, 3);
    await assert.rejects(() => mm.searchMemory({ status: "BOGUS" }), /invalid status/);
  });

  it("supports limit/offset and importance ordering", async () => {
    await seed();
    const page1 = await mm.searchMemory({ source: SRC, limit: 2 });
    const page2 = await mm.searchMemory({ source: SRC, limit: 2, offset: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 1);
    const byImp = await mm.searchMemory({ source: SRC, order: "importance DESC" });
    assert.equal(byImp[0].importance, 0.9);
  });

  it("queryByDomain / queryByStrategy / queryByTime delegate correctly", async () => {
    await seed();
    assert.equal((await mm.queryByDomain("live", { source: SRC })).length, 2);
    assert.equal((await mm.queryByStrategy("s2", { source: SRC })).length, 1);
    assert.equal((await mm.queryByTime("2026-07-03T00:00:00Z", null, { source: SRC })).length, 1);
    await assert.rejects(() => mm.queryByDomain(""), /runtimeDomain is required/);
    await assert.rejects(() => mm.queryByStrategy(""), /strategyId is required/);
    await assert.rejects(() => mm.queryByTime(null, null), /provide since/);
  });

  it("queryByTrade finds memories linked to an intent", async () => {
    // create real intent so the soft reference is valid
    const { rows: intentRows } = await pool.query(
      `INSERT INTO trade_intents (signal_id, intent_type, symbol, status)
       VALUES ('test_mm_unit_sig', 'OPEN', 'EUR_USD', 'CREATED') RETURNING id`
    );
    const intentId = intentRows[0].id;
    try {
      await mm.createMemory(mem({ trade_intent_id: intentId }));
      const rows = await mm.queryByTrade(intentId, { source: SRC });
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].trade_intent_id), String(intentId));
      await assert.rejects(() => mm.queryByTrade("bogus"), /positive number/);
    } finally {
      await pool.query(`DELETE FROM memory_event_history WHERE memory_id IN (SELECT id FROM memory_events WHERE source = '${SRC}')`);
      await pool.query(`DELETE FROM memory_events WHERE source = '${SRC}'`);
      await pool.query(`DELETE FROM trade_intents WHERE id = $1`, [intentId]);
    }
  });

  it("getMemory returns null for missing id", async () => {
    assert.equal(await mm.getMemory(999999999), null);
  });
});

// ── summarizeMemory ──────────────────────────────────────────────────────────

describe("MemoryManager — summarizeMemory", () => {

  it("aggregates counts, importance, time range, and top tags", async () => {
    await mm.createMemory(mem({ event_type: "TEST_MM_A", tags: ["t1", "t2"], importance: 0.2 }));
    await mm.createMemory(mem({ event_type: "TEST_MM_A", tags: ["t1"], importance: 0.8 }));
    await mm.createMemory(mem({ event_type: "TEST_MM_B", runtime_domain: "shadowB", importance: 0.5 }));

    const sum = await mm.summarizeMemory();
    assert.ok(sum.total >= 3);
    assert.ok(sum.byEventType["TEST_MM_A"] >= 2);
    assert.ok(sum.byEventType["TEST_MM_B"] >= 1);
    assert.ok(sum.byDomain["meta"] >= 2);
    assert.ok(sum.byDomain["shadowB"] >= 1);
    assert.ok(sum.byStatus["ACTIVE"] >= 3);
    assert.ok(sum.topTags["t1"] >= 2);
    assert.ok(sum.importance.avg > 0 && sum.importance.avg < 1);
    assert.ok(sum.timeRange.oldest);
    assert.ok(sum.timeRange.newest);
    assert.ok(sum.historyRows >= 3);
    assert.ok(sum.generatedAt);
  });

  it("supports a since filter", async () => {
    await mm.createMemory(mem({ occurred_at: new Date("2020-01-01T00:00:00Z") }));
    await mm.createMemory(mem({ occurred_at: new Date() }));
    const all    = await mm.summarizeMemory();
    const recent = await mm.summarizeMemory({ since: new Date(Date.now() - 3600_000) });
    assert.ok(recent.total < all.total);
  });
});

// ── validateMemory ───────────────────────────────────────────────────────────

describe("MemoryManager — validateMemory", () => {

  it("returns ok on a clean database", async () => {
    await mm.createMemory(mem());
    const res = await mm.validateMemory();
    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 0);
    assert.deepEqual(res.corrupted, []);
    assert.ok(res.checked >= 1);
  });

  it("detects structural corruption and marks rows CORRUPTED", async () => {
    const { row } = await mm.createMemory(mem());
    await pool.query(`UPDATE memory_events SET payload = '[]'::jsonb WHERE id = $1`, [row.id]);

    const res = await mm.validateMemory();
    assert.equal(res.ok, false);
    const issue = res.issues.find(i => String(i.memoryId) === String(row.id));
    assert.ok(issue, "expected an issue for the corrupted row");
    assert.equal(issue.check, "structural");
    assert.equal(issue.severity, "ERROR");
    assert.ok(res.corrupted.map(String).includes(String(row.id)));

    const after = await mm.getMemory(row.id);
    assert.equal(after.status, "CORRUPTED");
    // row still exists — never deleted
    assert.deepEqual(after.tags, []);

    // marking was audited
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist[0].change_op, "VALIDATE");
  });

  it("logs findings to consistency_log", async () => {
    const { row } = await mm.createMemory(mem());
    await pool.query(`UPDATE memory_events SET metadata = '"oops"'::jsonb WHERE id = $1`, [row.id]);
    await mm.validateMemory();

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

  it("flags orphaned trade_intent_id as WARN without corrupting", async () => {
    // bypass createMemory validation by inserting via manager then re-pointing raw
    const { row } = await mm.createMemory(mem());
    await pool.query(`UPDATE memory_events SET trade_intent_id = 999999999 WHERE id = $1`, [row.id]);

    const res = await mm.validateMemory();
    const issue = res.issues.find(i => i.check === "orphaned_trade_intent" && String(i.memoryId) === String(row.id));
    assert.ok(issue);
    assert.equal(issue.severity, "WARN");
    const after = await mm.getMemory(row.id);
    assert.equal(after.status, "ACTIVE"); // WARN does not corrupt
  });

  it("flags version/history gaps as WARN", async () => {
    const { row } = await mm.createMemory(mem());
    // fabricate a gap: bump version without history
    await pool.query(`UPDATE memory_events SET version = version + 5 WHERE id = $1`, [row.id]);

    const res = await mm.validateMemory();
    const issue = res.issues.find(i => i.check === "version_history_gap" && String(i.memoryId) === String(row.id));
    assert.ok(issue);
    assert.equal(issue.severity, "WARN");
  });

  it("markCorrupted=false reports without mutating", async () => {
    const { row } = await mm.createMemory(mem());
    await pool.query(`UPDATE memory_events SET context = '5'::jsonb WHERE id = $1`, [row.id]);
    const res = await mm.validateMemory({ markCorrupted: false });
    assert.equal(res.ok, false);
    assert.deepEqual(res.corrupted, []);
    assert.equal((await mm.getMemory(row.id)).status, "ACTIVE");
  });
});

// ── KV surface ───────────────────────────────────────────────────────────────

describe("MemoryManager — KV cache (memory_entries)", () => {

  it("kvSet/kvGet round trip with objects and scalars", async () => {
    await mm.kvSet(KV_NS, "obj", { nested: { deep: true } });
    await mm.kvSet(KV_NS, "num", 42);
    await mm.kvSet(KV_NS, "str", "hello");
    assert.deepEqual(await mm.kvGet(KV_NS, "obj"), { nested: { deep: true } });
    assert.equal(await mm.kvGet(KV_NS, "num"), 42);
    assert.equal(await mm.kvGet(KV_NS, "str"), "hello");
  });

  it("kvSet upserts (last write wins)", async () => {
    await mm.kvSet(KV_NS, "k", "v1");
    await mm.kvSet(KV_NS, "k", "v2");
    assert.equal(await mm.kvGet(KV_NS, "k"), "v2");
  });

  it("kvGet returns null for missing keys", async () => {
    assert.equal(await mm.kvGet(KV_NS, "never_set"), null);
  });

  it("TTL expiry: expired entries read as null and are GC'd", async () => {
    await mm.kvSet(KV_NS, "shortlived", "x", { ttlSeconds: 1 });
    assert.equal(await mm.kvGet(KV_NS, "shortlived"), "x");
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(await mm.kvGet(KV_NS, "shortlived"), null);
    const { removed } = await mm.kvGc();
    assert.ok(removed >= 1);
    const { rows } = await pool.query(
      `SELECT * FROM memory_entries WHERE namespace = $1 AND key = 'shortlived'`, [KV_NS]
    );
    assert.equal(rows.length, 0);
  });

  it("kvGetAll returns only non-expired entries in the namespace", async () => {
    await mm.kvSet(KV_NS, "a", 1);
    await mm.kvSet(KV_NS, "b", 2, { ttlSeconds: 1 });
    await new Promise(r => setTimeout(r, 1200));
    const all = await mm.kvGetAll(KV_NS);
    assert.deepEqual(all, { a: 1 });
  });

  it("kvGc never touches memory_events", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.kvSet(KV_NS, "gcprobe", 1, { ttlSeconds: 1 });
    await new Promise(r => setTimeout(r, 1200));
    await mm.kvGc();
    assert.ok(await mm.getMemory(row.id), "memory event must survive kvGc");
    assert.equal((await mm.getMemoryHistory(row.id)).length, 1);
  });

  it("validates inputs", async () => {
    await assert.rejects(() => mm.kvSet("", "k", 1), /namespace required/);
    await assert.rejects(() => mm.kvSet(KV_NS, "", 1), /key required/);
    await assert.rejects(() => mm.kvSet(KV_NS, "k", 1, { ttlSeconds: -5 }), /ttlSeconds/);
  });
});

// ── getStats ─────────────────────────────────────────────────────────────────

describe("MemoryManager — getStats", () => {

  it("reports totals, status breakdown, history and kv counts", async () => {
    const { row } = await mm.createMemory(mem());
    await mm.archiveMemory(row.id);
    await mm.createMemory(mem());
    await mm.kvSet(KV_NS, "statprobe", 1);

    const stats = await mm.getStats();
    assert.ok(stats.total >= 2);
    assert.ok(stats.byStatus["ARCHIVED"] >= 1);
    assert.ok(stats.byStatus["ACTIVE"] >= 1);
    assert.ok(stats.historyRows >= 3);
    assert.ok(stats.kvEntries >= 1);
    assert.ok(typeof stats.pool.total === "number");
  });
});
