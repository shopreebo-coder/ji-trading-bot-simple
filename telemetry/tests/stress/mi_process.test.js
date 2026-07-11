"use strict";
/**
 * Sprint 4 — LiveMemoryIntegration Cross-Process Stress Tests
 *
 * Real two-OS-process scenarios that cannot be simulated in-process:
 *   • duplicate startup — a second PROCESS must not acquire the recovery lock
 *   • concurrent recovery — two processes racing → exactly one recovers
 *   • power loss — SIGKILL (no cleanup possible) → advisory lock is freed by
 *     Postgres and the next boot recovers cleanly
 *
 * Drivers live in telemetry/tests/drivers/ and never spawn server.js
 * (spawning server.js would launch the live trading bot).
 *
 * Run SEPARATELY from other suites:
 *   node --test --test-reporter=spec telemetry/tests/stress/mi_process.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { Pool } = require("pg");

const { LiveMemoryIntegration } = require("../../managers");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DRIVERS = path.join(__dirname, "..", "drivers");

let pool;
let snapWatermark = 0;
let testStart;

/**
 * Spawns a driver and resolves with {proc, firstLine} on the first stdout
 * line MATCHING the given regex (the module logs its own lines too).
 */
function spawnDriver(file, args = [], timeoutMs = 20000, match = /.*/) {
  const proc = spawn(process.execPath, [path.join(DRIVERS, file), ...args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let settled = false;
  const firstLine = new Promise((resolve, reject) => {
    const to = setTimeout(() => { settled = true; reject(new Error(`${file}: no matching output in ${timeoutMs}ms`)); }, timeoutMs);
    proc.stdout.on("data", (d) => {
      if (settled) return;
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (match.test(line)) { settled = true; clearTimeout(to); resolve(line); return; }
      }
    });
    proc.on("error", (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
    proc.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(to); reject(new Error(`${file} exited ${code} with no matching output`)); }
    });
  });
  return { proc, firstLine };
}

function waitExit(proc, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    const to = setTimeout(() => { proc.kill("SIGKILL"); resolve(null); }, timeoutMs);
    proc.on("exit", (code) => { clearTimeout(to); resolve(code); });
  });
}

async function cleanupEvents(p) {
  await p.query(
    `DELETE FROM memory_event_history WHERE memory_id IN
       (SELECT id FROM memory_events WHERE source LIKE 'mi_driver%' OR source LIKE 'test_mi%')`
  );
  await p.query(`DELETE FROM memory_events WHERE source LIKE 'mi_driver%' OR source LIKE 'test_mi%'`);
}

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set");
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  testStart = new Date();
  const { rows } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM system_snapshots`);
  snapWatermark = Number(rows[0].m);
  await cleanupEvents(pool);
});

after(async () => {
  await cleanupEvents(pool);
  await pool.query(
    `DELETE FROM runtime_domain_history WHERE snapshot_id IN
       (SELECT id FROM system_snapshots WHERE id > $1)`, [snapWatermark]
  );
  await pool.query(`DELETE FROM system_snapshots WHERE id > $1`, [snapWatermark]);
  await pool.query(
    `DELETE FROM consistency_log
     WHERE detected_at >= $1
       AND (check_id LIKE 'recovery:%' OR check_id LIKE 'memory_validate:%')`,
    [testStart]
  );
  await pool.end();
});

describe("MI cross-process — duplicate startup", () => {

  it("a second OS process cannot acquire the recovery lock", async () => {
    const a = spawnDriver("mi_hold_lock.js", [], 20000, /^(LOCKED|NOLOCK|INITFAIL|FATAL)/);
    const b = { proc: null };
    try {
      const aLine = await a.firstLine;
      assert.equal(aLine, "LOCKED", `holder A: ${aLine}`);

      const bd = spawnDriver("mi_hold_lock.js", [], 20000, /^(LOCKED|NOLOCK|INITFAIL|FATAL)/);
      b.proc = bd.proc;
      const bLine = await bd.firstLine;
      assert.equal(bLine, "NOLOCK", `process B must be refused: ${bLine}`);

      // An in-process boot must also degrade to observe-only while A holds the lock
      const local = new LiveMemoryIntegration({ calledBy: "test_mi_stress" });
      const ini = await local.init();
      assert.equal(ini.ok, true);
      const rep = await local.recoverOnStartup({ liveState: { dailyTrades: 0, openTrades: {} } });
      assert.equal(rep.recovered, false);
      assert.match(rep.reason, /lock/);
      await local.gracefulShutdown({ reason: "stress-observe-done" });
    } finally {
      // ALWAYS reap the holders — a leaked holder poisons later lock tests
      if (b.proc) b.proc.kill("SIGKILL");
      a.proc.kill("SIGKILL");
      await Promise.all([waitExit(a.proc), b.proc ? waitExit(b.proc) : Promise.resolve()]);
    }
  });
});

describe("MI cross-process — concurrent recovery race", () => {

  it("two processes recovering simultaneously → exactly one wins the lock", async () => {
    const a = spawnDriver("mi_recover_once.js", ["1500"], 30000, /^RESULT /);
    const b = spawnDriver("mi_recover_once.js", ["1500"], 30000, /^RESULT /);
    try {
      const [aOut, bOut] = await Promise.all([a.firstLine, b.firstLine]);
      const ra = JSON.parse(aOut.slice(7));
      const rb = JSON.parse(bOut.slice(7));
      assert.ok(!ra.fatal && !rb.fatal, `driver fatals: ${aOut} | ${bOut}`);

      const winners = [ra, rb].filter(r => r.lockAcquired === true);
      const losers  = [ra, rb].filter(r => r.lockAcquired === false);
      assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}`);
      assert.equal(losers.length, 1);
      assert.equal(winners[0].recovered, true);
      assert.equal(losers[0].recovered, false);
      assert.match(losers[0].reason, /lock/);
    } finally {
      await Promise.all([waitExit(a.proc, 15000), waitExit(b.proc, 15000)]);
    }
  });
});

describe("MI cross-process — power loss (SIGKILL)", () => {

  it("SIGKILL mid-write frees the lock; next boot recovers cleanly", async () => {
    const holder = spawnDriver("mi_crash_holder.js", [], 25000, /^(READY|NOLOCK|INITFAIL|FATAL)/);
    let line;
    try {
      line = await holder.firstLine;
    } finally {
      if (line !== "READY") holder.proc.kill("SIGKILL");
    }
    assert.equal(line, "READY", `crash holder: ${line}`);

    holder.proc.kill("SIGKILL"); // power loss — no cleanup of any kind
    await waitExit(holder.proc);

    // Postgres frees a session-scoped advisory lock when the backend notices
    // the dead connection. Retry briefly to absorb that propagation delay.
    const next = new LiveMemoryIntegration({ calledBy: "test_mi_aftercrash" });
    const ini = await next.init();
    assert.equal(ini.ok, true);

    try {
      let rep = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        rep = await next.recoverOnStartup({ liveState: { dailyTrades: 0, openTrades: {} } });
        if (rep.lockAcquired) break;
        await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(rep.lockAcquired, `lock never freed after SIGKILL: ${rep.reason}`);
      assert.equal(rep.recovered, true, rep.reason);
      assert.ok(rep.durationMs < 10000, `post-crash recovery took ${rep.durationMs}ms`);

      // The driver awaited its first write before READY — it must be durable
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS n FROM memory_events WHERE source = 'mi_driver_crash' AND event_type = 'TRADE_OPENED'`
      );
      assert.ok(Number(rows[0].n) >= 1, "at least the awaited pre-kill write persisted");
    } finally {
      // ALWAYS release pool + lock client, or the test file hangs on exit
      await next.gracefulShutdown({ reason: "post-crash-done" });
    }
  });
});
