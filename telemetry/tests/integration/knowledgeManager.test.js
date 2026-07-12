"use strict";
/**
 * Sprint 6 — KnowledgeManager integration test (end-to-end, READ-ONLY layer).
 *
 * Proves the Knowledge Layer turns MEASURED research into versioned, immutable,
 * provenance-stamped knowledge:
 *   1. snapshotAll() builds all seven knowledge artifacts from the Shadow LAB
 *      tables ONLY (events → ShadowLabManager → shadow_* → KnowledgeManager).
 *   2. Every artifact carries provenance (run_id/build_id/config_hash) + checksum
 *      + training_events, and the built content reflects the seeded research.
 *   3. Re-running with unchanged source is idempotent (0 new versions) and the
 *      manifest snapshot dedupes.
 *   4. New research data supersedes the affected artifact to v2 (migration_from
 *      set, exactly one active row) while untouched artifacts stay at v1.
 *   5. exportAll() returns a read-only bundle of the active set with values.
 *
 * Isolation: a unique domainPrefix gives this run its own artifact identities,
 * and all seeded research is namespaced (NS) so assertions are deterministic on
 * the shared dev database. Requires PostgreSQL; skips cleanly otherwise.
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
const NS = `T6-${crypto.randomUUID().slice(0, 8)}`;
const PREFIX = `test-${NS}-`;
const CFG = crypto.createHash("sha256").update(NS).digest("hex");

// ShadowLabManager provenance — stamps the research rows (unique config_hash so
// config/history + experiments/metadata include this run deterministically).
const SLM_PROV = createProvenance({ runId: `slm-${NS}`, buildId: "v40.1+t6slm000000", configHash: CFG });
// KnowledgeManager provenance — stamps the knowledge artifacts.
const KM_PROV = createProvenance({ runId: `km-${NS}`, buildId: "v40.1+t6km0000000", configHash: CFG });

async function seedEvent(type, payload, symbol = null) {
  const ts = new Date().toISOString();
  const data = JSON.stringify({ ...payload, type, ts, botId: "test" });
  await db.run("INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)", ts, "test", type, symbol, data);
}

async function seedResolvedSignal(sid, { symbol, side, fp, trend, vol, spread, profit }) {
  await seedEvent("trade_open", {
    signalId: sid, symbol, session: "LONDON", side, fingerprint: fp,
    entryGate: "HARD", passCount: 8, spread: 0.8, atrPips: 12.5, emaDistance: 4.2, candleStrength: 0.31,
    trendBucket: trend, volatilityBucket: vol, spreadBucket: spread,
  }, symbol);
  await seedEvent("lab_shadow_a", { signalId: sid, symbol, score: 72, confidence: "MEDIUM", wouldTrade: true }, symbol);
  await seedEvent("lab_shadow_b", { signalId: sid, symbol, marketState: "TRENDING", confidence: "HIGH", wouldTrade: true }, symbol);
  await seedEvent("lab_shadow_c", { signalId: sid, symbol, wouldTrade: true, confidence: "MEDIUM", historicalWinrate: 58.3 }, symbol);
  await seedEvent("lab_shadow_d", { signalId: sid, symbol, wouldTrade: true, confidence: "HIGH", metaVoteScore: 0.71 }, symbol);
  await seedEvent("trade_close", { signalId: sid, symbol, profitPips: profit, mfe: 18.0, mae: -3.1, duration: 42 }, symbol);
}

async function seedExpectancy(scope, dedupe) {
  await db.run(
    `INSERT INTO shadow_expectancy_snapshots
       (scope, sample_count, resolved_trades, wins, losses, total_profit_pips, gross_profit_pips,
        gross_loss_pips, expectancy_pips, profit_factor, confidence_level, window_from, window_to,
        detail, run_id, build_id, config_hash, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
    scope, 40, 40, 24, 16, 96.0, 240.0, -144.0, 2.4, 1.67, "MEDIUM", "w0", "w1", "{}",
    SLM_PROV.runId, SLM_PROV.buildId, CFG, dedupe
  );
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  await seedResolvedSignal(`${NS}-S1`, { symbol: "EUR_USD", side: "buy", fp: `fp-${NS}-1`, trend: "UP", vol: "MED", spread: "TIGHT", profit: 14.2 });
  const slm = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
  slm._lastId = 0;
  await slm.reconcileAll();
  await seedExpectancy(`${NS}-ALL`, `${NS}-exp-1`);
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM knowledge_artifacts WHERE domain LIKE $1", [`${PREFIX}%`]);
    await db._pool.query("DELETE FROM knowledge_snapshots WHERE run_id = $1", [KM_PROV.runId]);
    await db._pool.query("DELETE FROM shadow_signals      WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes     WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_expectancy_snapshots WHERE dedupe_key LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("KnowledgeManager builds versioned knowledge from research only", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const mgr = new KnowledgeManager({ db, provenance: KM_PROV, domainPrefix: PREFIX, pollIntervalMs: 3_600_000 });

  await t.test("first snapshotAll builds all seven artifacts", async () => {
    const r = await mgr.snapshotAll();
    assert.equal(r.ok, true);
    assert.equal(r.results.filter((x) => x.skipped).length, 0, "no builder should skip — data was seeded for all");
    assert.equal(r.results.filter((x) => x.error).length, 0, "no builder should error");
    assert.equal(r.changed, 7, "all seven artifacts created on first build");

    const active = await db.all("SELECT domain, artifact, version FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL ORDER BY domain", `${PREFIX}%`);
    assert.equal(active.length, 7, "seven active artifacts");
    for (const a of active) assert.equal(Number(a.version), 1);
  });

  await t.test("artifacts carry provenance, checksum and training_events", async () => {
    const rows = await db.all("SELECT * FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL", `${PREFIX}%`);
    for (const r of rows) {
      assert.equal(r.run_id, KM_PROV.runId, "run_id stamped");
      assert.equal(r.build_id, KM_PROV.buildId, "build_id stamped");
      assert.equal(r.config_hash, KM_PROV.configHash, "config_hash stamped");
      assert.match(r.checksum, /^[0-9a-f]{64}$/, "content checksum present");
      assert.ok(Number(r.byte_size) > 0, "byte_size recorded");
    }
  });

  await t.test("built content reflects the seeded research", async () => {
    const fp = await mgr.getArtifact(`${PREFIX}market`, "fingerprints");
    const value = typeof fp.value === "string" ? JSON.parse(fp.value) : fp.value;
    const mine = value.fingerprints.find((f) => f.fingerprint === `fp-${NS}-1`);
    assert.ok(mine, "seeded fingerprint appears in market/fingerprints");
    assert.equal(mine.resolved, 1, "one resolved outcome for the seeded signal");
    assert.ok(Number(fp.training_events) >= 1);

    const exp = await mgr.getArtifact(`${PREFIX}expectancy`, "history");
    const expVal = typeof exp.value === "string" ? JSON.parse(exp.value) : exp.value;
    assert.ok(expVal.scopes.some((s) => s.scope === `${NS}-ALL`), "seeded expectancy scope present");
  });

  await t.test("re-running with unchanged source is idempotent", async () => {
    const r = await mgr.snapshotAll();
    assert.equal(r.changed, 0, "no new versions when nothing changed");
    assert.equal(r.snapshot.inserted, false, "manifest snapshot dedupes on unchanged active set");
    const active = await db.all("SELECT COUNT(*) AS n FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL", `${PREFIX}%`);
    assert.equal(Number(active[0].n), 7, "still exactly seven active artifacts");
  });

  await t.test("new research supersedes the affected artifact to v2", async () => {
    const before = await mgr.getArtifact(`${PREFIX}market`, "fingerprints");
    const beforeId = Number(before.id);

    // Add a brand-new resolved signal with a NEW fingerprint.
    await seedResolvedSignal(`${NS}-S2`, { symbol: "GBP_USD", side: "sell", fp: `fp-${NS}-2`, trend: "DOWN", vol: "HIGH", spread: "WIDE", profit: -6.0 });
    const slm2 = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
    slm2._lastId = 0;
    await slm2.reconcileAll();

    const r = await mgr.snapshotAll();
    assert.ok(r.changed >= 1, "at least the fingerprint artifact changed");

    const after = await mgr.getArtifact(`${PREFIX}market`, "fingerprints");
    assert.equal(Number(after.version), 2, "fingerprint artifact bumped to v2");
    assert.equal(Number(after.migration_from), beforeId, "migration_from points at the previous version");

    const activeFp = await db.all("SELECT COUNT(*) AS n FROM knowledge_artifacts WHERE domain = ? AND artifact = ? AND superseded_at IS NULL", `${PREFIX}market`, "fingerprints");
    assert.equal(Number(activeFp[0].n), 1, "exactly one active fingerprint artifact");
  });

  await t.test("exportAll returns a read-only bundle of the active set", async () => {
    const bundle = await mgr.exportAll();
    assert.match(bundle.bundleChecksum, /^[0-9a-f]{64}$/);
    const mine = bundle.artifacts.filter((a) => a.domain.startsWith(PREFIX));
    assert.equal(mine.length, 7, "export includes all seven active artifacts");
    for (const a of mine) {
      assert.ok(a.value && typeof a.value === "object", "value payload included");
      assert.equal(a.provenance.runId, KM_PROV.runId);
    }
  });
});
