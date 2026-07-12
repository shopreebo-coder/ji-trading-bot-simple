"use strict";
/**
 * Sprint 6 — Knowledge Layer recovery / rollback-safety test.
 *
 * The critical durability property: because the artifact checksum covers CONTENT
 * ONLY (never provenance), a restart / redeploy — which mints a fresh run_id and
 * may carry a new build_id/config_hash — must NOT churn versions when the
 * underlying research is unchanged.
 *
 * Proves:
 *   1. A second manager with DIFFERENT provenance (new run_id/build_id/config_hash)
 *      rebuilding the SAME research produces ZERO new versions.
 *   2. The active rows retain the ORIGINAL builder's provenance (no silent
 *      supersede on restart).
 *   3. The manifest snapshot dedupes across the restart (unchanged active set).
 *
 * Requires PostgreSQL; skips cleanly otherwise.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { ShadowLabManager } = require("../../managers/ShadowLabManager");
const { KnowledgeManager } = require("../../managers/KnowledgeManager");
const { createProvenance } = require("../../managers/knowledgeProvenance");

const IS_PG = USE_PG;
const NS = `T6R-${crypto.randomUUID().slice(0, 8)}`;
const PREFIX = `test-${NS}-`;
const CFG_A = crypto.createHash("sha256").update(`${NS}-A`).digest("hex");
const CFG_B = crypto.createHash("sha256").update(`${NS}-B`).digest("hex");

const SLM_PROV = createProvenance({ runId: `slm-${NS}`, buildId: "v40.1+t6rslm00000", configHash: CFG_A });
const PROV_A = createProvenance({ runId: `run-A-${NS}`, buildId: "v40.1+buildAAAAAA", configHash: CFG_A });
const PROV_B = createProvenance({ runId: `run-B-${NS}`, buildId: "v40.1+buildBBBBBB", configHash: CFG_B });

async function seedEvent(type, payload, symbol = null) {
  const ts = new Date().toISOString();
  const data = JSON.stringify({ ...payload, type, ts, botId: "test" });
  await db.run("INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)", ts, "test", type, symbol, data);
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  const sid = `${NS}-S1`;
  await seedEvent("trade_open", { signalId: sid, symbol: "EUR_USD", side: "buy", fingerprint: `fp-${NS}`, entryGate: "HARD", passCount: 8, trendBucket: "UP", volatilityBucket: "MED", spreadBucket: "TIGHT" }, "EUR_USD");
  await seedEvent("lab_shadow_a", { signalId: sid, symbol: "EUR_USD", score: 70, confidence: "MEDIUM", wouldTrade: true }, "EUR_USD");
  await seedEvent("trade_close", { signalId: sid, symbol: "EUR_USD", profitPips: 11.0, duration: 30 }, "EUR_USD");
  const slm = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
  slm._lastId = 0;
  await slm.reconcileAll();
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM knowledge_artifacts WHERE domain LIKE $1", [`${PREFIX}%`]);
    await db._pool.query("DELETE FROM knowledge_snapshots WHERE run_id = ANY($1)", [[PROV_A.runId, PROV_B.runId]]);
    await db._pool.query("DELETE FROM shadow_signals      WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes     WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("Knowledge survives a restart without version churn", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const mgrA = new KnowledgeManager({ db, provenance: PROV_A, domainPrefix: PREFIX, pollIntervalMs: 3_600_000 });

  await t.test("initial build then stabilize", async () => {
    await mgrA.snapshotAll();          // create
    const again = await mgrA.snapshotAll(); // stabilize
    assert.equal(again.changed, 0, "second build by the same manager is a no-op");
  });

  await t.test("restart with new provenance mints no new versions", async () => {
    const beforeRows = await db.all("SELECT domain, artifact, version, run_id, checksum FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL ORDER BY domain", `${PREFIX}%`);
    assert.ok(beforeRows.length >= 1, "at least one artifact exists");
    for (const r of beforeRows) assert.equal(r.run_id, PROV_A.runId, "active rows built by run A");

    const mgrB = new KnowledgeManager({ db, provenance: PROV_B, domainPrefix: PREFIX, pollIntervalMs: 3_600_000 });
    const r = await mgrB.snapshotAll();
    assert.equal(r.changed, 0, "restart with new run_id/build_id/config_hash mints NO new versions");
    assert.equal(r.snapshot.inserted, false, "manifest dedupes across the restart");

    const afterRows = await db.all("SELECT domain, artifact, version, run_id, checksum FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL ORDER BY domain", `${PREFIX}%`);
    assert.equal(afterRows.length, beforeRows.length, "same number of active artifacts");
    for (let i = 0; i < afterRows.length; i++) {
      assert.equal(Number(afterRows[i].version), Number(beforeRows[i].version), "versions unchanged");
      assert.equal(afterRows[i].run_id, PROV_A.runId, "provenance NOT overwritten by run B (content-only checksum)");
      assert.equal(afterRows[i].checksum, beforeRows[i].checksum, "checksum unchanged");
    }
  });
});
