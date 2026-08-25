"use strict";
/**
 * SelectedAdvisor unit tests — ADVISOR-ONLY contract
 * ============================================================================
 * Proves the absolute rules of the advisor integration:
 *   - NEVER throws to the caller (even when the Selected Engine explodes)
 *   - NEVER writes to the database (db.run / db.exec are never touched)
 *   - flag off ⇒ complete no-op (no timers, no reads, no ring entries)
 *   - empty context / missing signal ⇒ stub advisory after final attempt
 *   - success ⇒ advisory carries selectedDecision / selectedConsensus /
 *     selectedConfidence / selectedRanking / selectedEvidenceId
 *
 * Pure in-memory tests: fake db + fake selectedEngine, no real DB required.
 * Run: node --test --test-reporter=spec telemetry/tests/unit/SelectedAdvisor.test.js
 */

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { SelectedAdvisor } = require("../../managers/SelectedAdvisor");
const { CooperativeManager } = require("../../managers/CooperativeManager");

// Short delays so the whole suite runs in milliseconds.
const FAST_DELAYS = [10, 20, 30];

const silentLog = { info: () => {}, error: () => {} };

function fakeDb({ row } = {}) {
  const calls = { get: 0, run: 0, exec: 0, all: 0 };
  return {
    calls,
    get: async () => { calls.get++; return row === undefined ? null : row; },
    all: async () => { calls.all++; return []; },
    run: async () => { calls.run++; throw new Error("db.run must NEVER be called by the advisor"); },
    exec: async () => { calls.exec++; throw new Error("db.exec must NEVER be called by the advisor"); },
  };
}

function tradeOpenRow(signalId, { ageMs = 0 } = {}) {
  return {
    ts: new Date(Date.now() - ageMs).toISOString(),
    data: JSON.stringify({ type: "trade_open", signalId, symbol: "EUR_USD", side: "buy" }),
  };
}

function fullContext(signalId) {
  return {
    id: "ctx-" + signalId,
    schemaVersion: 1,
    symbol: "EUR_USD",
    consensus: "TRADE",
    agreementScore: 75,
    disagreementScore: 25,
    consensusDetail: { agreeing: ["A", "C"], dissenting: ["B"], abstaining: ["D"], decided: 3 },
    confidence: { tier: "MEDIUM", average: 0.6 },
    ranking: [
      { source: "engine:C", kind: "engine", confidence: 0.8, expectancy: 1.2 },
      { source: "knowledge:expectancy/history", kind: "knowledge", confidence: 0.5, expectancy: null },
      { source: "engine:A", kind: "engine", confidence: 0.4, expectancy: 0.3 },
      { source: "engine:B", kind: "engine", confidence: 0.3, expectancy: 0.1 },
    ],
    selectedReason: "consensus=TRADE (2/3 decided agree, 75%)",
    evidenceTrace: { checksum: "deadbeef" },
  };
}

function emptyContext(signalId) {
  return { id: null, consensus: "NO_DATA", selectedReason: `no signal recorded for id ${signalId}`, ranking: [], evidenceTrace: null };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Success path ───────────────────────────────────────────────────────────
test("full advisory recorded when signal + context exist", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-1") });
  const builds = [];
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async ({ signalId }) => { builds.push(signalId); return fullContext(signalId); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(60);

  assert.deepEqual(builds, ["sig-1"], "buildDecisionContext called once with the exact signalId");
  const advisories = advisor.getAdvisories();
  assert.equal(advisories.length, 1);
  const a = advisories[0];
  assert.equal(a.signalId, "sig-1");
  assert.equal(a.symbol, "EUR_USD");
  assert.equal(a.side, "buy");
  assert.equal(a.selectedDecision, "TRADE");
  assert.equal(a.selectedConsensus.agreementScore, 75);
  assert.deepEqual(a.selectedConsensus.agreeing, ["A", "C"]);
  assert.equal(a.selectedConfidence.tier, "MEDIUM");
  assert.equal(a.selectedRanking.length, 3, "ranking truncated to top 3");
  assert.equal(a.selectedRanking[0].source, "engine:C");
  assert.equal(a.selectedEvidenceId, "deadbeef");
  assert.equal(a.contextId, "ctx-sig-1");
  assert.equal(a.advisor.status, "OK");
  assert.equal(advisor.getStatus().counters.advisories, 1);
  // ADVISOR CONTRACT: zero writes.
  assert.equal(db.calls.run, 0);
  assert.equal(db.calls.exec, 0);
});

// ── 2. Empty context ⇒ retries, then stub ────────────────────────────────────
test("empty context retries and records a stub advisory on the final attempt", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-2") });
  let builds = 0;
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async ({ signalId }) => { builds++; return emptyContext(signalId); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  assert.equal(builds, FAST_DELAYS.length, "one build per scheduled attempt");
  const advisories = advisor.getAdvisories();
  assert.equal(advisories.length, 1, "exactly one stub after the final attempt");
  assert.equal(advisories[0].advisor.status, "EMPTY_CONTEXT");
  assert.match(advisories[0].advisor.note, /no signal recorded/);
  assert.equal(advisories[0].selectedDecision, "NO_DATA");
  assert.equal(advisor.getStatus().counters.stubs, 1);
  assert.equal(db.calls.run, 0);
  assert.equal(db.calls.exec, 0);
});

// ── 3. Selected Engine throws ⇒ NEVER propagates ─────────────────────────────
test("selectedEngine throwing never throws to the caller and records an ERROR stub", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-3") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => { throw new Error("engine exploded"); } },
  });

  assert.doesNotThrow(() => advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" }));
  await wait(120);

  const advisories = advisor.getAdvisories();
  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].advisor.status, "ERROR");
  assert.equal(advisories[0].advisor.note, "engine exploded");
  assert.ok(advisor.getStatus().counters.errors >= 1);
  assert.equal(db.calls.run, 0);
  assert.equal(db.calls.exec, 0);
});

// ── 4. db.get throws ⇒ NEVER propagates ──────────────────────────────────────
test("db.get throwing never throws to the caller", async () => {
  const db = {
    calls: { run: 0, exec: 0 },
    get: async () => { throw new Error("db down"); },
    run: async () => { db.calls.run++; },
    exec: async () => { db.calls.exec++; },
  };
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => fullContext("x") },
  });

  assert.doesNotThrow(() => advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" }));
  await wait(120);
  const advisories = advisor.getAdvisories();
  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].advisor.status, "ERROR");
});

// ── 5. No matching trade_open event ⇒ NO_SIGNAL_ID stub ──────────────────────
test("missing trade_open event records a NO_SIGNAL_ID stub after final attempt", async () => {
  const db = fakeDb({ row: null });
  let builds = 0;
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => { builds++; return fullContext("x"); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  assert.equal(builds, 0, "engine never consulted without a signalId");
  const advisories = advisor.getAdvisories();
  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].advisor.status, "NO_SIGNAL_ID");
  assert.equal(advisories[0].signalId, null);
});

// ── 6. Stale trade_open event rejected ────────────────────────────────────────
test("stale trade_open event (older than staleMs) is rejected — stale-attach guard", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-old", { ageMs: 10_000 }) });
  let builds = 0;
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS, staleMs: 1000,
    selectedEngine: { buildDecisionContext: async () => { builds++; return fullContext("sig-old"); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  assert.equal(builds, 0, "stale signalId never attached");
  assert.equal(advisor.getAdvisories()[0].advisor.status, "NO_SIGNAL_ID");
});

// ── 7. Flag off ⇒ complete no-op ──────────────────────────────────────────────
test("enabled=false is a complete no-op (no reads, no timers, no advisories)", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-off") });
  let builds = 0;
  const advisor = new SelectedAdvisor({
    enabled: false, db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => { builds++; return fullContext("sig-off"); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(60);

  assert.equal(db.calls.get, 0);
  assert.equal(builds, 0);
  assert.equal(advisor.getAdvisories().length, 0);
  assert.equal(advisor.getStatus().pending, 0);
  assert.equal(advisor.getStatus().counters.observed, 0);
});

// ── 8. stop() clears pending timers ───────────────────────────────────────────
test("stop() cancels pending attempts and further opens are ignored", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-stop") });
  let builds = 0;
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: [50, 100],
    selectedEngine: { buildDecisionContext: async () => { builds++; return fullContext("sig-stop"); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  assert.equal(advisor.getStatus().pending, 1);
  advisor.stop();
  assert.equal(advisor.getStatus().pending, 0);
  advisor.onTradeOpen({ symbol: "GBP_USD", side: "sell" });
  await wait(200);

  assert.equal(builds, 0, "no attempt ran after stop()");
  assert.equal(advisor.getAdvisories().length, 0);
});

// ── 9. Ring bound ──────────────────────────────────────────────────────────────
test("advisory ring is bounded", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-ring") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: [1], ringSize: 3,
    selectedEngine: { buildDecisionContext: async () => fullContext("sig-ring") },
  });

  for (let i = 0; i < 6; i++) advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(80);

  assert.equal(advisor.getStatus().ring.size, 3);
  assert.equal(advisor.getAdvisories(10).length, 3);
});

// ── 10. Dual TEXT/JSONB data parsing ──────────────────────────────────────────
test("parseData handles TEXT, JSONB-object, and garbage", () => {
  assert.deepEqual(SelectedAdvisor.parseData('{"a":1}'), { a: 1 });
  assert.deepEqual(SelectedAdvisor.parseData({ a: 2 }), { a: 2 });
  assert.deepEqual(SelectedAdvisor.parseData("not json"), {});
  assert.deepEqual(SelectedAdvisor.parseData(null), {});
});

// ── Sprint 7 Phase 1: observational telemetry fields ─────────────────────────

function fullContextS7(signalId) {
  const ctx = fullContext(signalId);
  ctx.metadata = { knowledgeVersion: 5, snapshotVersion: "snap-3" };
  ctx.explainability = {
    knowledgeVersions: { max: 5, snapshot: "snap-3" },
    evidenceSummary: { marketFingerprint: { session: "EU", volatility: "NORMAL" } },
  };
  return ctx;
}

test("S7P1: advisory carries all Sprint 7 Phase 1 fields on success (status=OK)", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-s7") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async ({ signalId }) => fullContextS7(signalId) },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(60);

  const a = advisor.getAdvisories()[0];
  assert.equal(a.status, "OK", "normalized status");
  assert.deepEqual(a.selectedRankingTop3, a.selectedRanking, "explicit top3 field mirrors selectedRanking");
  assert.equal(a.selectedRankingTop3.length, 3);
  assert.equal(a.knowledgeVersion, 5, "knowledgeVersion from ctx.metadata");
  assert.equal(a.knowledgeSnapshot, "snap-3", "knowledgeSnapshot from ctx.metadata");
  assert.deepEqual(a.marketFingerprint, { session: "EU", volatility: "NORMAL" });
  assert.ok(!Number.isNaN(Date.parse(a.selectedDecisionTime)), "selectedDecisionTime is a valid ISO timestamp");
  assert.ok(a.decisionLatencyMs >= 0, "decision captured after the observed open");
  // legacy fields untouched (payload backward compatibility)
  assert.equal(a.selectedEvidenceId, "deadbeef");
  assert.equal(a.selectedReason, "consensus=TRADE (2/3 decided agree, 75%)");
  assert.equal(a.advisor.status, "OK");
  // ADVISOR CONTRACT: still zero writes.
  assert.equal(db.calls.run, 0);
  assert.equal(db.calls.exec, 0);
});

test("S7P1: knowledgeVersion/knowledgeSnapshot fall back to explainability when metadata is absent", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-s7b") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async ({ signalId }) => {
      const ctx = fullContextS7(signalId);
      delete ctx.metadata;
      return ctx;
    } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(60);

  const a = advisor.getAdvisories()[0];
  assert.equal(a.knowledgeVersion, 5, "fallback to explainability.knowledgeVersions.max");
  assert.equal(a.knowledgeSnapshot, "snap-3", "fallback to explainability.knowledgeVersions.snapshot");
});

test("S7P1: no DecisionContext ⇒ normalized status=NOT_AVAILABLE (empty context)", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-s7c") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async ({ signalId }) => emptyContext(signalId) },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  const a = advisor.getAdvisories()[0];
  assert.equal(a.status, "NOT_AVAILABLE");
  assert.equal(a.advisor.status, "EMPTY_CONTEXT", "detailed status preserved");
  assert.equal(a.knowledgeVersion, null);
  assert.equal(a.knowledgeSnapshot, null);
  assert.equal(a.marketFingerprint, null);
  assert.deepEqual(a.selectedRankingTop3, []);
  assert.ok(!Number.isNaN(Date.parse(a.selectedDecisionTime)));
});

test("S7P1: no signalId ⇒ normalized status=NOT_AVAILABLE (no signal)", async () => {
  const db = fakeDb({ row: null });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => fullContextS7("x") },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  const a = advisor.getAdvisories()[0];
  assert.equal(a.status, "NOT_AVAILABLE");
  assert.equal(a.advisor.status, "NO_SIGNAL_ID", "detailed status preserved");
});

test("S7P1: exception ⇒ normalized status=ERROR", async () => {
  const db = fakeDb({ row: tradeOpenRow("sig-s7e") });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => { throw new Error("boom"); } },
  });

  advisor.onTradeOpen({ symbol: "EUR_USD", side: "buy" });
  await wait(120);

  const a = advisor.getAdvisories()[0];
  assert.equal(a.status, "ERROR");
  assert.equal(a.advisor.status, "ERROR");
  assert.equal(a.advisor.note, "boom");
});

// ── 11. Malformed input never throws ──────────────────────────────────────────
test("onTradeOpen with missing/malformed args never throws", async () => {
  const db = fakeDb({ row: null });
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: { buildDecisionContext: async () => fullContext("x") },
  });
  assert.doesNotThrow(() => advisor.onTradeOpen());
  assert.doesNotThrow(() => advisor.onTradeOpen({}));
  assert.doesNotThrow(() => advisor.onTradeOpen({ side: "buy" }));
  await wait(60);
  assert.equal(advisor.getAdvisories().length, 0, "no symbol ⇒ nothing scheduled");
});

test("entry handshake accepts A/B/C, passes them to Selected Engine, and returns Live context", async () => {
  const db = fakeDb();
  let selectedInput = null;
  const advisor = new SelectedAdvisor({
    db, logger: silentLog, attemptDelaysMs: FAST_DELAYS,
    selectedEngine: {
      evaluateEntry: async (input) => {
        selectedInput = input;
        return {
          decision: "TRADE",
          contextId: "selected-ctx-sig-entry",
          confidenceScore: 0.7,
          confidenceTier: "MEDIUM",
          explanation: "selected context received",
        };
      },
    },
  });
  const shadowAdvisory = {
    advisoryId: "adv-sig-entry",
    advisoryOnly: true,
    outputs: {
      A: { advisoryId: "adv-sig-entry:A", engineId: "ENGINE_A_QUALITY", recommendation: "TRADE", confidence: "HIGH", evaluation: { wouldTrade: true } },
      B: { advisoryId: "adv-sig-entry:B", engineId: "ENGINE_B_CONTEXT", recommendation: "NO_TRADE", confidence: "MEDIUM", evaluation: { wouldTrade: false } },
      C: { advisoryId: "adv-sig-entry:C", engineId: "ENGINE_C_KNN", recommendation: "ABSTAIN", confidence: "NONE", evaluation: { wouldTrade: null } },
      D: { advisoryId: "adv-sig-entry:D", engineId: "ENGINE_D_META", recommendation: "ABSTAIN", confidence: "MEDIUM", evaluation: { action: "WAIT", advisoryOnly: true } },
    },
  };

  const result = await advisor.receiveEntryContext({
    signal: { signalId: "sig-entry", symbol: "EUR_USD", side: "buy", spread: 1.2 },
    shadowAdvisory,
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(Object.keys(result.shadowOutputs).sort(), ["A", "B", "C", "D"]);
  assert.equal(result.shadowConsensus.consensus, "SPLIT");
  assert.equal(result.shadowConsensus.decided, 2);
  assert.equal(result.shadowConsensus.abstain, 2);
  assert.equal(result.selected.decision, "TRADE");
  assert.equal(result.selected.contextId, "selected-ctx-sig-entry");
  assert.equal(selectedInput.signalId, "sig-entry");
  assert.deepEqual(Object.keys(selectedInput.advisoryOutputs).sort(), ["A", "B", "C", "D"]);
  assert.equal(selectedInput.advisoryOutputs.A.engineId, "ENGINE_A_QUALITY");
  assert.equal(result.usedForDecision, false);
  const receiptEvents = SelectedAdvisor.buildLiveReceiptEvents(
    { selectedAdvisorContext: result },
    { signalId: "sig-entry", symbol: "EUR_USD", side: "buy" },
  );
  assert.deepEqual(receiptEvents.map((event) => event.type), [
    "selected_advisor_advisory_delivered",
    "selected_advisor_advisory_read",
  ]);
  assert.equal(receiptEvents[1].readBy, "live_bot");
  assert.equal(receiptEvents[1].cooperationPath, "shadow_abc_selected_live");
  const lifecycleEvents = SelectedAdvisor.buildEntryLifecycleEvents({
    handoff: result,
    signal: { signalId: "sig-entry", symbol: "EUR_USD", side: "buy" },
    shadowAdvisory,
  });
  assert.equal(lifecycleEvents.length, 9, "A/B/C/D delivered+read plus Selected generated");
  assert.deepEqual(lifecycleEvents.slice(0, 8).map((event) => event.type), [
    "shadow_a_advisory_delivered", "shadow_a_advisory_read",
    "shadow_b_advisory_delivered", "shadow_b_advisory_read",
    "shadow_c_advisory_delivered", "shadow_c_advisory_read",
    "shadow_d_advisory_delivered", "shadow_d_advisory_read",
  ]);
  assert.equal(lifecycleEvents[0].deliveredTo, "selected_advisor");
  assert.equal(lifecycleEvents[1].readBy, "selected_advisor");
  assert.equal(lifecycleEvents[8].type, "selected_advisor_advisory_generated");
  assert.equal(lifecycleEvents[8].usedForDecision, false);
  const policy = new CooperativeManager().entryPolicy(result.selected, { highConfidence: 0.8 });
  assert.equal(policy.action, "ADVISORY", "Selected Advisor context does not add a new entry veto");
  assert.equal(advisor.getStatus().counters.entryContexts, 1);
  assert.equal(advisor.getStatus().counters.entryAdvisories, 1);
  assert.equal(advisor.getAdvisories()[0].kind, "entry_handshake");
  assert.equal(db.calls.run, 0);
  assert.equal(db.calls.exec, 0);
});

test("entry handshake OFF is a complete no-op", async () => {
  const db = fakeDb();
  const advisor = new SelectedAdvisor({
    enabled: false,
    db, logger: silentLog, selectedEngine: {
      evaluateEntry: async () => ({ decision: "TRADE", contextId: "must-not-run" }),
    },
  });
  const result = await advisor.receiveEntryContext({
    signal: { signalId: "sig-entry-off", symbol: "EUR_USD", side: "buy" },
    shadowAdvisory: { advisoryId: "adv-off", outputs: { A: { advisoryId: "a", engineId: "A" } } },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "selected_advisor_runtime_off");
  assert.equal(advisor.getStatus().counters.entryContexts, 0);
  assert.equal(advisor.getAdvisories().length, 0);
  assert.equal(db.calls.get, 0);
});

test("each A/B/C runtime OFF is omitted from the Selected Advisor hand-off", async () => {
  const allOutputs = {
    A: { advisoryId: "a", engineId: "ENGINE_A_QUALITY", recommendation: "TRADE" },
    B: { advisoryId: "b", engineId: "ENGINE_B_CONTEXT", recommendation: "NO_TRADE" },
    C: { advisoryId: "c", engineId: "ENGINE_C_KNN", recommendation: "ABSTAIN" },
  };
  for (const off of ["A", "B", "C"]) {
    let selectedInput = null;
    const advisor = new SelectedAdvisor({
      db: fakeDb(), logger: silentLog,
      selectedEngine: {
        evaluateEntry: async (input) => {
          selectedInput = input;
          return { decision: "ABSTAIN", contextId: `ctx-off-${off}` };
        },
      },
    });
    const runtime = { A: true, B: true, C: true, [off]: false };
    const outputs = Object.fromEntries(Object.entries(allOutputs).filter(([letter]) => runtime[letter]));
    const result = await advisor.receiveEntryContext({
      signal: { signalId: `sig-off-${off}`, symbol: "EUR_USD", side: "buy" },
      shadowAdvisory: { advisoryId: `adv-off-${off}`, runtime, outputs },
    });
    assert.equal(result.accepted, true);
    assert.equal(selectedInput.advisoryOutputs[off], undefined);
    assert.deepEqual(Object.keys(result.shadowOutputs).sort(), Object.keys(outputs).sort());
  }
});
