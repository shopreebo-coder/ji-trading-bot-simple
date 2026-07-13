"use strict";
/**
 * Selected Engine — integration test (end-to-end, READ-ONLY orchestration).
 *
 * Proves the Selected Engine aggregates already-recorded research into a
 * normalized, ranked, tri-state DecisionContext WITHOUT ever writing to a
 * live/shadow/knowledge table:
 *   1. Engines are AUTO-DISCOVERED from shadow_engine_evals (DISTINCT engine_id).
 *      A brand-new engine_id='E' inserted directly into the research table is
 *      picked up with ZERO code changes — the core "add Engine E/F/G = no code"
 *      requirement.
 *   2. buildDecisionContext() produces per-engine opinions, a tri-state
 *      consensus (abstention excluded), a ranked intelligence package, dynamic
 *      shadow<ID> aliases, and auto-discovered Knowledge domains.
 *   3. The DecisionContext id is DETERMINISTIC — building twice over unchanged
 *      inputs yields the identical id (no wall-clock in the id basis).
 *   4. The ring buffer serves getLatest / getContext(id) / listContexts.
 *   5. It writes NOTHING: research + knowledge row counts are unchanged after a
 *      full build cycle.
 *
 * Isolation: all seeded rows are namespaced (NS). Requires PostgreSQL; skips
 * cleanly otherwise. Node runs each test file in its own process, so the
 * per-file db._pool.end() in after() is safe.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { ShadowLabManager } = require("../../managers/ShadowLabManager");
const { SelectedEngineManager } = require("../../managers/SelectedEngineManager");
const { createProvenance } = require("../../managers/knowledgeProvenance");

const IS_PG = USE_PG;
const NS = `SEL-${crypto.randomUUID().slice(0, 8)}`;
const CFG = crypto.createHash("sha256").update(NS).digest("hex");
const SLM_PROV = createProvenance({ runId: `slm-${NS}`, buildId: "v40.1+selslm00000", configHash: CFG });
const SEL_PROV = createProvenance({ runId: `sel-${NS}`, buildId: "v40.1+sel0000000", configHash: CFG });

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
  await seedEvent("lab_shadow_c", { signalId: sid, symbol, wouldTrade: true, confidence: "MEDIUM", historicalWinrate: 58.3, historicalExpectancy: 2.1 }, symbol);
  await seedEvent("lab_shadow_d", { signalId: sid, symbol, wouldTrade: true, confidence: "HIGH", metaVoteScore: 0.71 }, symbol);
  await seedEvent("trade_close", { signalId: sid, symbol, profitPips: profit, mfe: 18.0, mae: -3.1, duration: 42 }, symbol);
}

// Insert a recorded eval for a *new* engine id, directly into the research table
// — this simulates a future Engine E that starts recording evaluations. No code
// anywhere in the Selected Engine references 'E'.
async function seedExtraEngineEval(sid, engineId, { wouldTrade, score, confidence, reason }) {
  await db.run(
    `INSERT INTO shadow_engine_evals
       (signal_id, engine_id, engine_version, would_trade, score, confidence, eval, run_id, build_id, config_hash, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
    sid, engineId, `v${engineId}-test`, wouldTrade, score, confidence,
    JSON.stringify({ reason, score }), SLM_PROV.runId, SLM_PROV.buildId, CFG, `${NS}-${engineId}-eval`
  );
}

let SID;

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  SID = `${NS}-S1`;
  await seedResolvedSignal(SID, { symbol: "EUR_USD", side: "buy", fp: `fp-${NS}-1`, trend: "UP", vol: "MED", spread: "TIGHT", profit: 14.2 });
  const slm = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
  slm._lastId = 0;
  await slm.reconcileAll(); // populates shadow_signals + shadow_engine_evals (A..D) + shadow_outcomes
  // A future Engine 'E' records an evaluation for the same signal — zero code change.
  await seedExtraEngineEval(SID, "E", { wouldTrade: true, score: 88, confidence: "HIGH", reason: "engine E: strong go" });
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM shadow_signals      WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM shadow_outcomes     WHERE signal_id LIKE $1", [`${NS}-%`]);
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}-%`]);
  } catch (_) {}
  await db._pool.end();
});

test("SelectedEngineManager orchestrates read-only intelligence", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  const shadowLab = new ShadowLabManager({ db, provenance: SLM_PROV, batchLimit: 5000 });
  const mgr = new SelectedEngineManager({ db, shadowLab, provenance: SEL_PROV, pollIntervalMs: 3_600_000 });

  await t.test("auto-discovers every recorded engine incl. the new Engine E", async () => {
    const engines = await mgr.listEngines();
    const ids = engines.map((e) => e.engineId);
    for (const id of ["A", "B", "C", "D", "E"]) {
      assert.ok(ids.includes(id), `engine ${id} auto-discovered from shadow_engine_evals`);
    }
    const e = engines.find((x) => x.engineId === "E");
    assert.equal(e.kind, "recorded-eval", "generic adapter used for the new engine — no bespoke code");
  });

  await t.test("buildDecisionContext produces opinions, consensus, ranking, aliases", async () => {
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    assert.match(ctx.id, /^[0-9a-f]{64}$/, "deterministic content-hash id");
    assert.equal(ctx.symbol, "EUR_USD");
    assert.equal(ctx.setupId, `fp-${NS}-1`, "setupId derives from the signal fingerprint");

    // per-engine opinions (dynamic map) + shadow<ID> aliases
    assert.ok(ctx.engines.E, "Engine E opinion present in dynamic engines map");
    assert.equal(ctx.engines.E.wouldTrade, true);
    assert.equal(ctx.engines.E.confidence, "HIGH");
    assert.ok(ctx.shadowE, "dynamic shadowE alias generated with zero hardcoding");
    assert.equal(ctx.shadowE, ctx.engines.E);
    assert.ok(ctx.shadowA && ctx.shadowB && ctx.shadowC && ctx.shadowD, "shadowA..D aliases present");

    // tri-state consensus: all five committed engines say TRADE → unanimous
    assert.equal(ctx.consensus, "TRADE");
    assert.equal(ctx.consensusDetail.abstain, 0);
    assert.equal(ctx.agreementScore, 100);
    assert.equal(ctx.disagreementScore, 0);

    // ranked intelligence package includes engines, knowledge and expectancy
    assert.ok(Array.isArray(ctx.ranking) && ctx.ranking.length > 0);
    const sources = ctx.ranking.map((r) => r.source);
    assert.ok(sources.includes("engine:E"), "Engine E appears in the ranking");
    assert.ok(sources.includes("expectancy:ALL"), "Shadow LAB expectancy included in the ranking");

    // metadata surfaces auto-discovery + provenance (never inside content)
    assert.ok(ctx.metadata.engineIds.includes("E"));
    assert.equal(ctx.metadata.provenance.runId, SEL_PROV.runId);
    assert.equal(ctx.metadata.resolved, true, "outcome recorded for the seeded signal");
  });

  await t.test("DecisionContext id is deterministic across rebuilds", async () => {
    const a = await mgr.buildDecisionContext({ signalId: SID });
    const b = await mgr.buildDecisionContext({ signalId: SID });
    assert.equal(a.id, b.id, "identical inputs ⇒ identical id (no wall-clock in the basis)");
  });

  await t.test("DecisionContext carries a stable schemaVersion", async () => {
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    assert.equal(ctx.schemaVersion, 1, "DecisionContext contract is version 1");
    const empty = await mgr.buildDecisionContext({ signalId: `${NS}-does-not-exist` });
    assert.equal(empty.schemaVersion, 1, "empty context reports the same contract version");
    assert.equal(empty.evidenceTrace, null, "empty context has no evidence trace");
    assert.equal(empty.explainability, null, "empty context has no explainability block");
  });

  await t.test("EvidenceTrace is complete, immutable, and reproducible", async () => {
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    const tr = ctx.evidenceTrace;
    assert.ok(tr, "evidence trace present");
    // required fields
    for (const k of [
      "signalId", "evalIds", "engineIds", "consensus", "marketFingerprint",
      "rankingCriteria", "records", "artifacts", "artifactVersions",
      "snapshotChecksum", "contextId", "checksum",
    ]) {
      assert.ok(k in tr, `evidence trace exposes ${k}`);
    }
    assert.match(tr.checksum, /^[0-9a-f]{64}$/, "trace checksum is a sha256");
    assert.equal(tr.contextId, ctx.id, "trace pins the context id it explains");
    assert.deepEqual(
      tr.rankingCriteria.map((c) => c.key),
      ["confidence", "expectancy", "trainingEvents", "version", "freshness", "inputOrder"],
      "trace embeds the ranking criteria verbatim"
    );
    // records carry no wall-clock/freshness (determinism guarantee)
    assert.ok(tr.records.every((r) => !("freshness" in r)), "trace records exclude freshness (wall-clock)");
    assert.ok(tr.records.length > 0 && tr.records[0].rank === 1, "records are 1-indexed by rank");
    // deep-frozen — any mutation throws in strict mode
    assert.ok(Object.isFrozen(tr), "trace is frozen");
    assert.throws(() => { tr.checksum = "tampered"; }, "cannot tamper the trace checksum");
    assert.throws(() => { tr.records.push({}); }, "cannot append to frozen records");
    // reproducible: identical inputs ⇒ identical trace checksum
    const again = await mgr.buildDecisionContext({ signalId: SID });
    assert.equal(again.evidenceTrace.checksum, tr.checksum, "same inputs ⇒ identical trace checksum");
  });

  await t.test("explainability surfaces the full decision rationale", async () => {
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    const ex = ctx.explainability;
    assert.ok(ex, "explainability block present");
    assert.ok(Array.isArray(ex.selectedSources) && ex.selectedSources.length > 0, "selectedSources listed");
    assert.equal(typeof ex.selectionReason, "string", "human-readable selection reason");
    assert.ok(ex.confidenceChain && "average" in ex.confidenceChain && "tier" in ex.confidenceChain, "confidence chain present");
    assert.ok(ex.knowledgeVersions && "artifacts" in ex.knowledgeVersions, "knowledge versions present");
    assert.equal(ex.evidenceSummary.traceChecksum, ctx.evidenceTrace.checksum, "evidence summary points at the trace");
    assert.ok(ex.evidenceSummary.engineIds.includes("E"), "evidence summary lists discovered engines");
  });

  await t.test("ring buffer serves getLatest / getContext / listContexts", async () => {
    const ctx = await mgr.buildDecisionContext({ signalId: SID });
    assert.equal(mgr.getContext(ctx.id).id, ctx.id, "getContext(id) returns the stored context");
    assert.equal(mgr.getLatest().id, ctx.id, "getLatest returns the most recent");
    const list = mgr.listContexts(10);
    assert.ok(list.some((c) => c.id === ctx.id), "listContexts includes it");
    // deterministic id means repeated builds dedupe rather than growing the ring
    assert.equal(mgr.getContext("does-not-exist"), null);
  });

  await t.test("getStatus reports discovery + telemetry, running=false without start()", async () => {
    const status = await mgr.getStatus();
    assert.equal(status.running, false, "no background timer unless start() is called");
    assert.ok(status.engineCount >= 5, "at least engines A..E discovered");
    assert.ok(Array.isArray(status.knowledgeDomains));
    assert.ok(status.telemetry && status.telemetry.consensus === "TRADE", "latest telemetry reflects last build");
  });

  await t.test("the whole build cycle writes NOTHING (pure read-only)", async () => {
    const q = async (sql, p) => Number((await db._pool.query(sql, p)).rows[0].n);
    const evalsBefore = await q("SELECT COUNT(*) AS n FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]);
    const sigBefore   = await q("SELECT COUNT(*) AS n FROM shadow_signals WHERE signal_id LIKE $1", [`${NS}-%`]);
    const kaBefore    = await q("SELECT COUNT(*) AS n FROM knowledge_artifacts", []);

    await mgr.buildDecisionContext({ signalId: SID });
    await mgr.getStatus();
    await mgr.listEngines();

    assert.equal(await q("SELECT COUNT(*) AS n FROM shadow_engine_evals WHERE signal_id LIKE $1", [`${NS}-%`]), evalsBefore, "no eval rows written");
    assert.equal(await q("SELECT COUNT(*) AS n FROM shadow_signals WHERE signal_id LIKE $1", [`${NS}-%`]), sigBefore, "no signal rows written");
    assert.equal(await q("SELECT COUNT(*) AS n FROM knowledge_artifacts", []), kaBefore, "no knowledge rows written");
  });
});
