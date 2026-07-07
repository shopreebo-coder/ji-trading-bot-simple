"use strict";
/**
 * Sprint 1 — RuntimeDomainManager Unit Tests
 * Tests every public method against the live heliumdb PostgreSQL database.
 * All test data uses a 'test_rdm_' prefix and is cleaned up after each test.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { RuntimeDomainManager, DEFAULT_DOMAINS } = require("../../managers/RuntimeDomainManager");
const { Pool } = require("pg");

// ── Test setup ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || "";
let pool, rdm;

const TEST_DOMAIN   = "test_rdm_unit_domain";
const TEST_DOMAIN_2 = "test_rdm_unit_domain2";

async function cleanup(p) {
  await p.query("DELETE FROM runtime_domain_history WHERE domain LIKE 'test_rdm_%'");
  await p.query("DELETE FROM runtime_domains WHERE domain LIKE 'test_rdm_%'");
  await p.query("DELETE FROM consistency_log WHERE check_id LIKE 'test_rdm_%'");
}

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
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

// ── Constructor ────────────────────────────────────────────────────────────

describe("RuntimeDomainManager — Constructor", () => {

  it("rejects missing/invalid connection string", () => {
    assert.throws(
      () => new RuntimeDomainManager({ connectionString: "mysql://bad" }),
      /connectionString must start with postgres/
    );
  });

  it("accepts a pre-created pool via _pool option", () => {
    const rdm2 = new RuntimeDomainManager({ _pool: pool });
    assert.ok(rdm2, "should not throw");
  });

  it("accepts DATABASE_URL from environment", () => {
    const rdm2 = new RuntimeDomainManager({ connectionString: DATABASE_URL });
    assert.ok(rdm2);
    rdm2.shutdown().catch(() => {});
  });

});

// ── init() ─────────────────────────────────────────────────────────────────

describe("RuntimeDomainManager — init()", () => {

  it("init() succeeds when all required tables exist", async () => {
    const rdm2 = new RuntimeDomainManager({ _pool: pool });
    const result = await rdm2.init();
    assert.strictEqual(result.ok, true);
    assert.ok(result.tables.includes("runtime_domains"));
    assert.ok(result.tables.includes("runtime_domain_history"));
    assert.ok(result.tables.includes("system_snapshots"));
    assert.ok(result.tables.includes("consistency_log"));
  });

  it("throws before init() is called", async () => {
    const rdm2 = new RuntimeDomainManager({ _pool: pool });
    await assert.rejects(() => rdm2.getDomain("live"), /not initialized/);
  });

});

// ── ping() ─────────────────────────────────────────────────────────────────

describe("RuntimeDomainManager — ping()", () => {

  it("ping() returns { ok: true, latencyMs: <number> }", async () => {
    const result = await rdm.ping();
    assert.strictEqual(result.ok, true);
    assert.ok(typeof result.latencyMs === "number");
    assert.ok(result.latencyMs >= 0, "latency must be non-negative");
    assert.ok(result.latencyMs < 5000, "latency should be under 5s");
  });

  it("ping() works before init()", async () => {
    const rdm2 = new RuntimeDomainManager({ _pool: pool });
    const result = await rdm2.ping();
    assert.strictEqual(result.ok, true);
  });

});

// ── createDomain() ─────────────────────────────────────────────────────────

describe("RuntimeDomainManager — createDomain()", () => {

  it("creates a new domain", async () => {
    const value  = { x: 1, y: "hello" };
    const result = await rdm.createDomain(TEST_DOMAIN, value);

    assert.strictEqual(result.created, true);
    assert.ok(result.row);
    assert.strictEqual(result.row.domain, TEST_DOMAIN);
    assert.strictEqual(Number(result.row.version), 0);
    assert.deepStrictEqual(result.row.value, value);
  });

  it("returns created=false for an existing domain", async () => {
    await rdm.createDomain(TEST_DOMAIN, { x: 1 });
    const result = await rdm.createDomain(TEST_DOMAIN, { x: 999 });

    assert.strictEqual(result.created, false);
    assert.ok(result.row);
    assert.deepStrictEqual(result.row.value, { x: 1 }, "existing value must be preserved");
  });

  it("records a CREATE history entry", async () => {
    await rdm.createDomain(TEST_DOMAIN, { k: "v" }, { calledBy: "unit_test" });
    const history = await rdm.getHistory(TEST_DOMAIN, 1);

    assert.ok(history.length >= 1);
    assert.strictEqual(history[0].change_op, "CREATE");
    assert.strictEqual(history[0].changed_by, "unit_test");
    assert.strictEqual(Number(history[0].version), 0);
  });

  it("rejects non-object initialValue", async () => {
    await assert.rejects(
      () => rdm.createDomain(TEST_DOMAIN, [1, 2, 3]),
      /initialValue must be a plain object/
    );
    await assert.rejects(
      () => rdm.createDomain(TEST_DOMAIN, "string"),
      /initialValue must be a plain object/
    );
    await assert.rejects(
      () => rdm.createDomain(TEST_DOMAIN, null),
      /initialValue must be a plain object/
    );
  });

  it("rejects empty domain name", async () => {
    await assert.rejects(
      () => rdm.createDomain("", {}),
      /domain must be a non-empty string/
    );
  });

});

// ── getDomain() ────────────────────────────────────────────────────────────

describe("RuntimeDomainManager — getDomain()", () => {

  it("returns null for a non-existent domain", async () => {
    const result = await rdm.getDomain("test_rdm_nonexistent_domain_xyz");
    assert.strictEqual(result, null);
  });

  it("returns the correct row for an existing domain", async () => {
    const value = { dailyTrades: 5, openTrades: { EUR_USD: { pips: 2.1 } } };
    await rdm.createDomain(TEST_DOMAIN, value);

    const row = await rdm.getDomain(TEST_DOMAIN);
    assert.ok(row);
    assert.strictEqual(row.domain, TEST_DOMAIN);
    assert.strictEqual(Number(row.version), 0);
    assert.deepStrictEqual(row.value, value);
    assert.ok(row.updated_at instanceof Date || typeof row.updated_at === "string" || row.updated_at);
  });

  it("returns all expected fields", async () => {
    await rdm.createDomain(TEST_DOMAIN, {});
    const row = await rdm.getDomain(TEST_DOMAIN);
    assert.ok("domain"     in row);
    assert.ok("version"    in row);
    assert.ok("value"      in row);
    assert.ok("updated_at" in row);
    assert.ok("schema_ver" in row);
  });

});

// ── listDomains() ──────────────────────────────────────────────────────────

describe("RuntimeDomainManager — listDomains()", () => {

  it("returns all production domains", async () => {
    const domains = await rdm.listDomains();
    const names   = domains.map(d => d.domain);
    for (const expected of ["live","shadowA","shadowB","shadowC","shadowD","shadowM","exitLab","telemetry","scheduler","meta"]) {
      assert.ok(names.includes(expected), `missing domain: ${expected}`);
    }
  });

  it("returns rows in alphabetical order", async () => {
    const domains = await rdm.listDomains();
    const names   = domains.map(d => d.domain);
    const sorted  = [...names].sort();
    assert.deepStrictEqual(names, sorted);
  });

  it("includes test domain after creation", async () => {
    await rdm.createDomain(TEST_DOMAIN, { test: true });
    const domains = await rdm.listDomains();
    assert.ok(domains.some(d => d.domain === TEST_DOMAIN));
  });

});

// ── updateDomain() ─────────────────────────────────────────────────────────

describe("RuntimeDomainManager — updateDomain()", () => {

  beforeEach(async () => {
    await rdm.createDomain(TEST_DOMAIN, { counter: 0 });
  });

  it("increments version on update", async () => {
    const row = await rdm.updateDomain(TEST_DOMAIN, { counter: 1 });
    assert.strictEqual(Number(row.version), 1);
  });

  it("replaces entire value", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { newKey: "newValue" });
    const row = await rdm.getDomain(TEST_DOMAIN);
    assert.deepStrictEqual(row.value, { newKey: "newValue" });
    assert.ok(!("counter" in row.value), "old keys must be removed");
  });

  it("records UPDATE history", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { counter: 1 }, { calledBy: "unit_test", notes: "test note" });
    const history = await rdm.getHistory(TEST_DOMAIN);
    const updateEntry = history.find(h => h.change_op === "UPDATE");
    assert.ok(updateEntry, "must have an UPDATE history entry");
    assert.strictEqual(updateEntry.changed_by, "unit_test");
    assert.strictEqual(updateEntry.notes, "test note");
  });

  it("throws for non-existent domain", async () => {
    await assert.rejects(
      () => rdm.updateDomain("test_rdm_no_exist_xyz", { x: 1 }),
      /not found/
    );
  });

  it("throws for non-object value", async () => {
    await assert.rejects(
      () => rdm.updateDomain(TEST_DOMAIN, [1, 2]),
      /must be a plain object/
    );
  });

});

// ── patchDomain() ──────────────────────────────────────────────────────────

describe("RuntimeDomainManager — patchDomain()", () => {

  beforeEach(async () => {
    await rdm.createDomain(TEST_DOMAIN, { a: 1, b: 2, c: 3 });
  });

  it("merges patch into existing value", async () => {
    const row = await rdm.patchDomain(TEST_DOMAIN, { b: 99, d: 4 });
    assert.deepStrictEqual(row.value, { a: 1, b: 99, c: 3, d: 4 });
  });

  it("preserves unpatched keys", async () => {
    await rdm.patchDomain(TEST_DOMAIN, { b: 99 });
    const row = await rdm.getDomain(TEST_DOMAIN);
    assert.strictEqual(row.value.a, 1, "key 'a' must be preserved");
    assert.strictEqual(row.value.c, 3, "key 'c' must be preserved");
  });

  it("increments version", async () => {
    const row = await rdm.patchDomain(TEST_DOMAIN, { b: 2 });
    assert.strictEqual(Number(row.version), 1);
  });

  it("records PATCH history", async () => {
    await rdm.patchDomain(TEST_DOMAIN, { b: 2 });
    const history = await rdm.getHistory(TEST_DOMAIN);
    const patchEntry = history.find(h => h.change_op === "PATCH");
    assert.ok(patchEntry, "must have a PATCH history entry");
  });

  it("throws for non-existent domain", async () => {
    await assert.rejects(
      () => rdm.patchDomain("test_rdm_no_exist_xyz", { x: 1 }),
      /not found/
    );
  });

});

// ── compareAndSwap() ───────────────────────────────────────────────────────

describe("RuntimeDomainManager — compareAndSwap()", () => {

  beforeEach(async () => {
    await rdm.createDomain(TEST_DOMAIN, { v: 0 });
  });

  it("succeeds when version matches", async () => {
    const current = await rdm.getDomain(TEST_DOMAIN);
    const result  = await rdm.compareAndSwap(TEST_DOMAIN, current.version, { v: 1 });

    assert.strictEqual(result.swapped, true);
    assert.strictEqual(result.currentVersion, Number(current.version) + 1);
    assert.deepStrictEqual(result.row.value, { v: 1 });
  });

  it("fails when version does not match", async () => {
    const result = await rdm.compareAndSwap(TEST_DOMAIN, 9999, { v: 1 });

    assert.strictEqual(result.swapped, false);
    assert.ok(result.currentVersion !== null);
    assert.ok(result.row !== null);
  });

  it("returns current version and row on CAS failure", async () => {
    const current = await rdm.getDomain(TEST_DOMAIN);
    const result  = await rdm.compareAndSwap(TEST_DOMAIN, 9999, { v: 1 });

    assert.strictEqual(result.currentVersion, Number(current.version));
    assert.deepStrictEqual(result.row.value, current.value);
  });

  it("records CAS history on success", async () => {
    const current = await rdm.getDomain(TEST_DOMAIN);
    await rdm.compareAndSwap(TEST_DOMAIN, current.version, { v: 1 }, { calledBy: "cas_test" });
    const history = await rdm.getHistory(TEST_DOMAIN);
    const casEntry = history.find(h => h.change_op === "CAS");
    assert.ok(casEntry, "CAS history entry must exist");
    assert.strictEqual(casEntry.changed_by, "cas_test");
  });

  it("does NOT record history on CAS failure", async () => {
    const before = await rdm.getHistory(TEST_DOMAIN);
    await rdm.compareAndSwap(TEST_DOMAIN, 9999, { v: 1 });
    const after = await rdm.getHistory(TEST_DOMAIN);
    assert.strictEqual(after.length, before.length, "no history entry should be added on CAS failure");
  });

  it("sequential CAS updates increment version correctly", async () => {
    let row = await rdm.getDomain(TEST_DOMAIN);
    for (let i = 1; i <= 5; i++) {
      const result = await rdm.compareAndSwap(TEST_DOMAIN, row.version, { v: i });
      assert.strictEqual(result.swapped, true);
      assert.strictEqual(result.currentVersion, Number(row.version) + 1);
      row = result.row;
    }
    const final = await rdm.getDomain(TEST_DOMAIN);
    assert.strictEqual(Number(final.version), 5);
    assert.deepStrictEqual(final.value, { v: 5 });
  });

});

// ── takeSnapshot() / getSnapshot() / listSnapshots() ──────────────────────

describe("RuntimeDomainManager — Snapshots", () => {

  it("takeSnapshot() creates a snapshot and returns snapshotId", async () => {
    const result = await rdm.takeSnapshot("unit_test", { calledBy: "unit_test" });

    assert.ok(typeof result.snapshotId === "number");
    assert.ok(result.snapshotId > 0);
    assert.ok(result.createdAt);
    assert.ok(result.domainCount >= 10);
    assert.strictEqual(result.reason, "unit_test");
  });

  it("getSnapshot() returns the snapshot row", async () => {
    const { snapshotId } = await rdm.takeSnapshot("unit_test");
    const snapshot = await rdm.getSnapshot(snapshotId);

    assert.ok(snapshot);
    assert.strictEqual(Number(snapshot.id), snapshotId);
    assert.strictEqual(snapshot.trigger_type, "unit_test");
    assert.ok(snapshot.runtime_summary);
    assert.ok(typeof snapshot.runtime_summary === "object");
  });

  it("getSnapshot() returns null for non-existent snapshot", async () => {
    const result = await rdm.getSnapshot(999999999);
    assert.strictEqual(result, null);
  });

  it("listSnapshots() returns recent snapshots in descending order", async () => {
    const { snapshotId: id1 } = await rdm.takeSnapshot("unit_test_1");
    const { snapshotId: id2 } = await rdm.takeSnapshot("unit_test_2");
    const snapshots = await rdm.listSnapshots(5);

    assert.ok(snapshots.length >= 2);
    // Most recent first
    const idx1 = snapshots.findIndex(s => Number(s.id) === id1);
    const idx2 = snapshots.findIndex(s => Number(s.id) === id2);
    assert.ok(idx2 < idx1, "more recent snapshot must appear before older one");
  });

  it("takeSnapshot() records SNAPSHOT history for all domains", async () => {
    await rdm.createDomain(TEST_DOMAIN, { snap: true });
    const { snapshotId } = await rdm.takeSnapshot("unit_test");

    const { rows } = await pool.query(
      "SELECT domain, change_op FROM runtime_domain_history WHERE snapshot_id = $1",
      [snapshotId]
    );
    assert.ok(rows.length >= 1, "at least one history record must be linked to snapshot");
    assert.ok(rows.every(r => r.change_op === "SNAPSHOT"));
  });

  it("runtime_summary contains version and checksum for each domain", async () => {
    const { snapshotId } = await rdm.takeSnapshot("checksum_test");
    const snap = await rdm.getSnapshot(snapshotId);

    for (const d of ["live", "shadowM", "meta"]) {
      assert.ok(snap.runtime_summary[d], `runtime_summary must include domain '${d}'`);
      assert.ok(typeof snap.runtime_summary[d].version  === "number");
      assert.ok(typeof snap.runtime_summary[d].checksum === "string");
      assert.ok(snap.runtime_summary[d].checksum.length === 32, "MD5 checksum must be 32 chars");
    }
  });

});

// ── getHistory() / rollback() ──────────────────────────────────────────────

describe("RuntimeDomainManager — History & Rollback", () => {

  beforeEach(async () => {
    await rdm.createDomain(TEST_DOMAIN, { gen: 0 });
  });

  it("getHistory() returns mutations in descending version order", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { gen: 1 });
    await rdm.updateDomain(TEST_DOMAIN, { gen: 2 });
    await rdm.updateDomain(TEST_DOMAIN, { gen: 3 });

    const history = await rdm.getHistory(TEST_DOMAIN);
    assert.ok(history.length >= 4); // CREATE + 3 updates
    // Descending version order
    for (let i = 0; i < history.length - 1; i++) {
      assert.ok(Number(history[i].version) >= Number(history[i+1].version));
    }
  });

  it("getHistory() respects the limit parameter", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { gen: 1 });
    await rdm.updateDomain(TEST_DOMAIN, { gen: 2 });
    const history = await rdm.getHistory(TEST_DOMAIN, 2);
    assert.ok(history.length <= 2);
  });

  it("rollback() restores a domain to a previous value", async () => {
    const v0 = await rdm.getDomain(TEST_DOMAIN);
    await rdm.updateDomain(TEST_DOMAIN, { gen: 1 });
    await rdm.updateDomain(TEST_DOMAIN, { gen: 2 });

    const result = await rdm.rollback(TEST_DOMAIN, 0);
    assert.strictEqual(result.domain, TEST_DOMAIN);
    assert.strictEqual(result.rolledBackTo, 0);
    assert.ok(result.currentVersion > 0, "version must have been incremented");

    const current = await rdm.getDomain(TEST_DOMAIN);
    assert.deepStrictEqual(current.value, v0.value, "value must match version 0");
  });

  it("rollback() records a ROLLBACK history entry", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { gen: 1 });
    await rdm.rollback(TEST_DOMAIN, 0);

    const history = await rdm.getHistory(TEST_DOMAIN);
    const rollbackEntry = history.find(h => h.change_op === "ROLLBACK");
    assert.ok(rollbackEntry, "ROLLBACK history entry must exist");
  });

  it("rollback() throws for non-existent version", async () => {
    await assert.rejects(
      () => rdm.rollback(TEST_DOMAIN, 9999),
      /no history entry/
    );
  });

  it("rollback() does not delete any history entries", async () => {
    await rdm.updateDomain(TEST_DOMAIN, { gen: 1 });
    const before = await rdm.getHistory(TEST_DOMAIN);
    await rdm.rollback(TEST_DOMAIN, 0);
    const after = await rdm.getHistory(TEST_DOMAIN);
    assert.ok(after.length > before.length, "rollback must ADD an entry, not delete any");
  });

});

// ── restoreFromSnapshot() ──────────────────────────────────────────────────

describe("RuntimeDomainManager — restoreFromSnapshot()", () => {

  it("restores a domain to its snapshot state", async () => {
    await rdm.createDomain(TEST_DOMAIN, { state: "pre_snapshot" });
    const { snapshotId } = await rdm.takeSnapshot("restore_test");

    await rdm.updateDomain(TEST_DOMAIN, { state: "post_snapshot" });
    const afterUpdate = await rdm.getDomain(TEST_DOMAIN);
    assert.deepStrictEqual(afterUpdate.value, { state: "post_snapshot" });

    const result = await rdm.restoreFromSnapshot(snapshotId, [TEST_DOMAIN]);
    assert.ok(result.restored.includes(TEST_DOMAIN));

    const restored = await rdm.getDomain(TEST_DOMAIN);
    assert.deepStrictEqual(restored.value, { state: "pre_snapshot" });
  });

  it("throws for non-existent snapshot", async () => {
    await assert.rejects(
      () => rdm.restoreFromSnapshot(999999999),
      /not found/
    );
  });

});

// ── logConsistency() / resolveConsistency() / runConsistencyCheck() ────────

describe("RuntimeDomainManager — Consistency", () => {

  it("logConsistency() writes a consistency_log entry", async () => {
    const result = await rdm.logConsistency(
      "test_rdm_check_001", "WARN",
      "Unit test consistency entry",
      { detail: "test" }
    );
    assert.ok(result.id > 0);
    assert.ok(result.detectedAt);
  });

  it("logConsistency() rejects invalid severity", async () => {
    await assert.rejects(
      () => rdm.logConsistency("test_rdm_bad_severity", "FATAL", "test"),
      /invalid severity/
    );
  });

  it("resolveConsistency() marks an entry as resolved", async () => {
    const entry  = await rdm.logConsistency("test_rdm_resolve_001", "INFO", "test resolve");
    const result = await rdm.resolveConsistency(entry.id, "resolved by unit test", {
      autoRepaired: true,
      repairDetail: { action: "deleted stale entry" },
    });
    assert.ok(result.resolvedAt);

    const { rows } = await pool.query(
      "SELECT resolved_at, auto_repaired, resolution FROM consistency_log WHERE id=$1",
      [entry.id]
    );
    assert.ok(rows[0].resolved_at);
    assert.strictEqual(rows[0].auto_repaired, true);
    assert.strictEqual(rows[0].resolution, "resolved by unit test");
  });

  it("resolveConsistency() throws for non-existent id", async () => {
    await assert.rejects(
      () => rdm.resolveConsistency(999999999, "test"),
      /not found/
    );
  });

  it("runConsistencyCheck() returns OK for all 10 valid production domains", async () => {
    const result = await rdm.runConsistencyCheck();
    assert.strictEqual(result.severity, "OK");
    assert.strictEqual(result.issues, 0);
    assert.ok(result.domains >= 10);
    assert.ok(result.checks >= 30, `expected >= 30 checks, got ${result.checks}`);
  });

});

// ── getStats() ─────────────────────────────────────────────────────────────

describe("RuntimeDomainManager — getStats()", () => {

  it("returns correct stats shape", async () => {
    const stats = await rdm.getStats();
    assert.ok(typeof stats.domains     === "number");
    assert.ok(typeof stats.maxVersion  === "number");
    assert.ok(typeof stats.historyRows === "number");
    assert.ok(typeof stats.snapshots   === "number");
    assert.ok(typeof stats.pool        === "object");
    assert.ok(typeof stats.initialized === "boolean");
    assert.strictEqual(stats.initialized, true);
  });

  it("domains count includes all 10 production domains", async () => {
    const stats = await rdm.getStats();
    assert.ok(stats.domains >= 10);
  });

  it("historyRows increases after an update", async () => {
    const before = await rdm.getStats();
    await rdm.createDomain(TEST_DOMAIN, { x: 1 });
    await rdm.updateDomain(TEST_DOMAIN, { x: 2 });
    const after = await rdm.getStats();
    assert.ok(after.historyRows > before.historyRows);
  });

});

// ── DEFAULT_DOMAINS ────────────────────────────────────────────────────────

describe("RuntimeDomainManager — DEFAULT_DOMAINS", () => {

  it("DEFAULT_DOMAINS has all 10 domains", () => {
    const expected = ["live","shadowA","shadowB","shadowC","shadowD","shadowM","exitLab","telemetry","scheduler","meta"];
    for (const d of expected) {
      assert.ok(d in DEFAULT_DOMAINS, `DEFAULT_DOMAINS must include '${d}'`);
    }
  });

  it("DEFAULT_DOMAINS values are plain objects", () => {
    for (const [d, v] of Object.entries(DEFAULT_DOMAINS)) {
      assert.ok(typeof v === "object" && v !== null && !Array.isArray(v), `${d} must be a plain object`);
    }
  });

  it("live domain has required fields", () => {
    assert.ok("dailyTrades" in DEFAULT_DOMAINS.live);
    assert.ok("openTrades"  in DEFAULT_DOMAINS.live);
    assert.ok("date"        in DEFAULT_DOMAINS.live);
    assert.ok("sequence"    in DEFAULT_DOMAINS.live);
  });

  it("shadowM domain has the event cursor field", () => {
    assert.ok("lastId" in DEFAULT_DOMAINS.shadowM, "shadowM must have lastId cursor");
  });

  it("meta domain has status field", () => {
    assert.ok("status" in DEFAULT_DOMAINS.meta);
    assert.strictEqual(DEFAULT_DOMAINS.meta.status, "HALTED");
  });

});
