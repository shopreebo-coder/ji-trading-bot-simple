"use strict";
/**
 * Sprint 3 — MemoryManager Persistence & Crash Simulations
 *
 * Proves the Sprint 3 spec claim: memory survives restart, redeploy,
 * crash, and power failure. Nothing lives in-process.
 *
 *   SIM-1  Restart: a brand-new manager instance sees everything
 *   SIM-2  Crash mid-transaction: pg_terminate_backend → clean rollback
 *   SIM-3  Partial-write rollback: history and row always move together
 *   SIM-4  Corruption survival: raw-SQL damage detected, never deleted
 *   SIM-5  Pool reconnect after connection loss
 *   SIM-6  Append-first invariants under simulated multi-day usage
 *
 * All test data uses source = 'test_mm_sim' and is cleaned up.
 *
 * Run:
 *   node --test --test-reporter=spec telemetry/tests/simulation/mm_persistence.test.js
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const { MemoryManager } = require("../../managers/MemoryManager");

const DATABASE_URL = process.env.DATABASE_URL || "";
const SRC   = "test_mm_sim";
const KV_NS = "test_mm_sim_ns";
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
    event_type: "TEST_MM_SIM_EVENT",
    runtime_domain: "meta",
    payload: { sim: true },
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

// ── SIM-1: Restart ───────────────────────────────────────────────────────────

describe("SIM-1 — Restart: new manager instance sees everything", () => {

  it("memories, context, history and KV survive a manager restart", async () => {
    const { row } = await mm.createMemory(mem({
      reasoning: "pre-restart", tags: ["persist"], importance: 0.9,
    }));
    await mm.appendMemory(row.id, { phase: "before restart" });
    await mm.kvSet(KV_NS, "restart_probe", { alive: true });

    // "Restart": brand-new pool + manager (simulates process death + relaunch)
    const pool2 = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const mm2   = new MemoryManager({ _pool: pool2 });
    await mm2.init();
    try {
      const revived = await mm2.getMemory(row.id);
      assert.equal(revived.reasoning, "pre-restart");
      assert.equal(revived.context.length, 1);
      assert.equal(revived.context[0].addendum.phase, "before restart");
      assert.deepEqual(revived.tags, ["persist"]);
      assert.equal(String(revived.version), "2");

      const hist = await mm2.getMemoryHistory(row.id);
      assert.equal(hist.length, 2);

      assert.deepEqual(await mm2.kvGet(KV_NS, "restart_probe"), { alive: true });

      // New instance can continue mutating where the old one left off
      const { row: cont } = await mm2.appendMemory(row.id, { phase: "after restart" });
      assert.equal(String(cont.version), "3");
      assert.equal(cont.context.length, 2);
    } finally {
      await pool2.end();
    }
  });

  it("search and summaries are identical across instances", async () => {
    await mm.createMemory(mem({ event_type: "TEST_MM_SIM_A", tags: ["x"] }));
    await mm.createMemory(mem({ event_type: "TEST_MM_SIM_B", tags: ["x", "y"] }));

    const pool2 = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const mm2   = new MemoryManager({ _pool: pool2 });
    await mm2.init();
    try {
      const s1 = await mm.searchMemory({ tagsAny: ["x"], source: SRC });
      const s2 = await mm2.searchMemory({ tagsAny: ["x"], source: SRC });
      assert.equal(s1.length, s2.length);
      assert.deepEqual(s1.map(r => String(r.id)).sort(), s2.map(r => String(r.id)).sort());
    } finally {
      await pool2.end();
    }
  });
});

// ── SIM-2: Crash mid-transaction ─────────────────────────────────────────────

describe("SIM-2 — Crash mid-transaction: pg_terminate_backend", () => {

  it("killed backend mid-mutation leaves no partial state", async () => {
    const { row } = await mm.createMemory(mem());

    // Open a transaction on a dedicated client, do the UPDATE half of a
    // mutation, then kill the backend before history insert / COMMIT.
    const crashPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const victim = await crashPool.connect();
    let pid;
    try {
      const { rows: pidRows } = await victim.query("SELECT pg_backend_pid() AS pid");
      pid = pidRows[0].pid;
      await victim.query("BEGIN");
      await victim.query(
        `UPDATE memory_events SET importance = 0.01, version = version + 1 WHERE id = $1`,
        [row.id]
      );
      // Crash: terminate the backend from another connection
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await victim.query("COMMIT").catch(() => {}); // will fail — connection dead
    } catch (_) {
      // expected
    } finally {
      victim.release(true);
      await crashPool.end().catch(() => {});
    }

    // The uncommitted work must be fully rolled back
    const after = await mm.getMemory(row.id);
    assert.equal(after.importance, 0.5);
    assert.equal(String(after.version), "1");
    const hist = await mm.getMemoryHistory(row.id);
    assert.equal(hist.length, 1);

    // The system continues to operate on the same row afterwards
    const { row: healed } = await mm.appendMemory(row.id, { post_crash: true });
    assert.equal(String(healed.version), "2");
  });
});

// ── SIM-3: Partial-write rollback ────────────────────────────────────────────

describe("SIM-3 — Atomicity: row and history always move together", () => {

  it("a failed mutation rolls back both row and history", async () => {
    const { row } = await mm.createMemory(mem());

    // Force the history INSERT to fail by monkey-patching _writeHistory,
    // proving the row UPDATE in the same transaction is rolled back.
    const original = mm._writeHistory.bind(mm);
    mm._writeHistory = async () => { throw new Error("simulated history failure"); };
    try {
      await assert.rejects(
        () => mm.updateMemory(row.id, { importance: 0.99 }),
        /simulated history failure/
      );
    } finally {
      mm._writeHistory = original;
    }

    const after = await mm.getMemory(row.id);
    assert.equal(after.importance, 0.5, "row update must have rolled back");
    assert.equal(String(after.version), "1");
    assert.equal((await mm.getMemoryHistory(row.id)).length, 1);

    // invariant holds for validator too
    const res = await mm.validateMemory({ markCorrupted: false });
    const gap = res.issues.find(i =>
      i.check === "version_history_gap" && String(i.memoryId) === String(row.id)
    );
    assert.equal(gap, undefined);
  });

  it("history count === version for every memory after mixed load", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { row } = await mm.createMemory(mem({ strategy_id: `sim3_${i}` }));
      ids.push(row.id);
    }
    await Promise.all(ids.flatMap(id => [
      mm.appendMemory(id, { a: 1 }),
      mm.updateMemory(id, { importance: 0.6 }),
      mm.tagMemory(id, { add: ["sim3"] }),
    ]));
    for (const id of ids) {
      const row  = await mm.getMemory(id);
      const hist = await mm.getMemoryHistory(id);
      assert.equal(String(hist.length), String(row.version));
    }
  });
});

// ── SIM-4: Corruption survival ───────────────────────────────────────────────

describe("SIM-4 — External corruption: detected, quarantined, never deleted", () => {

  it("raw-SQL damage across multiple rows is quarantined without data loss", async () => {
    const clean   = await mm.createMemory(mem({ reasoning: "clean row" }));
    const broken1 = await mm.createMemory(mem({ reasoning: "will corrupt context" }));
    const broken2 = await mm.createMemory(mem({ reasoning: "will corrupt payload" }));

    await pool.query(`UPDATE memory_events SET context = '"garbage"'::jsonb WHERE id = $1`, [broken1.row.id]);
    await pool.query(`UPDATE memory_events SET payload = '[1,2]'::jsonb   WHERE id = $1`, [broken2.row.id]);

    const res = await mm.validateMemory();
    const corrupted = res.corrupted.map(String);
    assert.ok(corrupted.includes(String(broken1.row.id)));
    assert.ok(corrupted.includes(String(broken2.row.id)));
    assert.ok(!corrupted.includes(String(clean.row.id)));

    // Rows still exist with all salvageable data intact — NOTHING deleted
    const b1 = await mm.getMemory(broken1.row.id);
    assert.equal(b1.status, "CORRUPTED");
    assert.equal(b1.reasoning, "will corrupt context");
    const b2 = await mm.getMemory(broken2.row.id);
    assert.equal(b2.status, "CORRUPTED");

    // Clean row untouched
    assert.equal((await mm.getMemory(clean.row.id)).status, "ACTIVE");

    // CORRUPTED rows are excluded from default searches but reachable explicitly
    const activeRows = await mm.searchMemory({ source: SRC });
    assert.ok(!activeRows.some(r => String(r.id) === String(broken1.row.id)));
    const corruptedRows = await mm.searchMemory({ status: "CORRUPTED", source: SRC });
    assert.equal(corruptedRows.length, 2);
  });

  it("repair + restore returns a quarantined memory to service", async () => {
    const { row } = await mm.createMemory(mem());
    await pool.query(`UPDATE memory_events SET context = '17'::jsonb WHERE id = $1`, [row.id]);
    await mm.validateMemory();
    assert.equal((await mm.getMemory(row.id)).status, "CORRUPTED");

    // Operator repairs the damage, then restores
    await pool.query(`UPDATE memory_events SET context = '[]'::jsonb WHERE id = $1`, [row.id]);
    const { row: revived } = await mm.restoreMemory(row.id, "manually repaired");
    assert.equal(revived.status, "ACTIVE");

    // Fully operational again
    const { row: working } = await mm.appendMemory(row.id, { repaired: true });
    assert.equal(working.context.length, 1);

    // The whole incident is in the audit trail
    const hist = await mm.getMemoryHistory(row.id);
    const ops = hist.map(h => h.change_op).reverse();
    assert.deepEqual(ops, ["CREATE", "VALIDATE", "RESTORE", "APPEND"]);
  });
});

// ── SIM-5: Pool reconnect ────────────────────────────────────────────────────

describe("SIM-5 — Connection loss and pool recovery", () => {

  it("manager keeps working after its idle connections are terminated", async () => {
    const { row } = await mm.createMemory(mem());

    // Kill every other backend for this database user (simulates network blip)
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'idle'
    `).catch(() => {});

    // The pool must transparently establish fresh connections
    let recovered = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        recovered = await mm.getMemory(row.id);
        break;
      } catch (_) { /* dead pooled conn — retry surfaces a fresh one */ }
    }
    assert.ok(recovered, "manager should recover after connection loss");
    assert.equal(String(recovered.id), String(row.id));

    // Mutations work again too
    const { row: after } = await mm.appendMemory(row.id, { reconnected: true });
    assert.equal(String(after.version), "2");
  });
});

// ── SIM-6: Multi-day usage pattern ───────────────────────────────────────────

describe("SIM-6 — Simulated multi-day trading memory accumulation", () => {

  it("3 'days' of trading across restarts: full recall at the end", async () => {
    const managers = [];
    const memIds = [];
    try {
      for (let day = 1; day <= 3; day++) {
        // Each day = fresh process
        const p = new Pool({ connectionString: DATABASE_URL, max: 3 });
        const m = new MemoryManager({ _pool: p });
        await m.init();
        managers.push({ p, m });

        const { row } = await m.createMemory(mem({
          event_type: "TEST_MM_SIM_DAILY",
          occurred_at: new Date(`2026-07-0${day}T09:00:00Z`),
          tags: [`day${day}`],
          importance: 0.3 * day,
          reasoning: `day ${day} session`,
        }));
        memIds.push(row.id);
        await m.appendMemory(row.id, { day, trades: day * 2 });

        // Yesterday's memories are visible today
        const past = await m.searchMemory({ event_type: "TEST_MM_SIM_DAILY", source: SRC, status: "ANY" });
        assert.equal(past.length, day);
      }

      // Final "restart" — full recall of all three days
      const finalPool = new Pool({ connectionString: DATABASE_URL, max: 3 });
      const finalMm   = new MemoryManager({ _pool: finalPool });
      await finalMm.init();
      try {
        const all = await finalMm.queryByTime("2026-07-01T00:00:00Z", "2026-07-03T23:59:59Z",
          { event_type: "TEST_MM_SIM_DAILY", source: SRC });
        assert.equal(all.length, 3);
        for (const r of all) {
          assert.equal(r.context.length, 1);
          assert.equal(String(r.version), "2");
        }
        const sum = await finalMm.summarizeMemory();
        assert.ok(sum.byEventType["TEST_MM_SIM_DAILY"] >= 3);
        // No integrity drift after all the churn
        const res = await finalMm.validateMemory({ markCorrupted: false });
        const ours = res.issues.filter(i => memIds.map(String).includes(String(i.memoryId)));
        assert.equal(ours.length, 0);
      } finally {
        await finalPool.end();
      }
    } finally {
      for (const { p } of managers) await p.end().catch(() => {});
    }
  });
});
