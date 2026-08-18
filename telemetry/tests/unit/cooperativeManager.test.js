"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CooperativeManager } = require("../../managers/CooperativeManager");

test("entry policy is advisory-only and never owns execution", () => {
  const manager = new CooperativeManager();
  assert.equal(manager.entryPolicy({ decision: "NO_TRADE", confidenceScore: 0.8 }).action, "ADVISORY");
  assert.equal(manager.entryPolicy({ decision: "NO_TRADE", confidenceScore: 0.6 }).suggestedAction, "ABSTAIN");
  assert.equal(manager.entryPolicy({ decision: "TRADE", confidenceScore: 0.9 }).action, "ADVISORY");
  assert.equal(manager.entryPolicy({ decision: "ABSTAIN" }).action, "ADVISORY");
});

test("management policy preserves advisory-only evidence", () => {
  const manager = new CooperativeManager();
  const result = manager.managementPolicy({ action: "MOVE_SL", evidence: { mfe: 4 } });
  assert.equal(result.action, "MOVE_SL");
  assert.equal(result.advisoryOnly, true);
  assert.deepEqual(result.evidence, { mfe: 4 });
});

function completeGateInput(overrides = {}) {
  return {
    liveEvidence: {
      signalId: "sig-capital",
      symbol: "EUR_USD",
      side: "buy",
      spread: 1.1,
      atrPips: 4.2,
    },
    shadowConsensus: {
      consensus: "TRADE",
      votesFor: 3,
      votesAgainst: 0,
      abstain: 0,
      decided: 3,
      engineIds: ["A", "B", "C"],
      recommendations: { A: "TRADE", B: "TRADE", C: "TRADE" },
    },
    shadowSignalId: "sig-capital",
    shadowConfidence: "HIGH",
    selectedEngineDecision: "TRADE",
    selectedEngineConfidence: "HIGH",
    knowledgeEvidence: {
      available: true,
      matchCount: 2,
      source: "knowledge_layer",
    },
    ...overrides,
  };
}

test("capital gate ALLOW requires complete high-confidence agreement and evidence", () => {
  const manager = new CooperativeManager();
  assert.deepEqual(manager.capitalGate(completeGateInput()), {
    decision: "ALLOW",
    reason: "complete_high_confidence_agreement_no_capital_problem",
    evidenceComplete: true,
  });
});

test("capital gate ABSTAIN covers conflict, low confidence, and missing knowledge", () => {
  const manager = new CooperativeManager();
  assert.equal(manager.capitalGate(completeGateInput({
    shadowConsensus: {
      consensus: "TRADE",
      votesFor: 2,
      votesAgainst: 1,
      abstain: 0,
      decided: 3,
      engineIds: ["A", "B", "C"],
      recommendations: { A: "TRADE", B: "NO_TRADE", C: "TRADE" },
    },
  })).decision, "ABSTAIN");
  assert.equal(manager.capitalGate(completeGateInput({
    selectedEngineConfidence: "LOW",
  })).decision, "ABSTAIN");
  assert.equal(manager.capitalGate(completeGateInput({
    knowledgeEvidence: { available: false, matchCount: 0 },
  })).decision, "ABSTAIN");
});

test("capital gate BLOCK is reserved for high-confidence NO_TRADE agreement", () => {
  const manager = new CooperativeManager();
  const result = manager.capitalGate(completeGateInput({
    shadowConsensus: {
      consensus: "NO_TRADE",
      votesFor: 0,
      votesAgainst: 3,
      abstain: 0,
      decided: 3,
      engineIds: ["A", "B", "C"],
      recommendations: { A: "NO_TRADE", B: "NO_TRADE", C: "NO_TRADE" },
    },
    selectedEngineDecision: "NO_TRADE",
  }));
  assert.deepEqual(result, {
    decision: "BLOCK",
    reason: "high_confidence_shadow_selected_no_trade",
    evidenceComplete: true,
  });
});

test("capital gate failures never become ALLOW", () => {
  const manager = new CooperativeManager();
  for (const overrides of [
    { shadowConsensus: null },
    { selectedEngineDecision: "ABSTAIN" },
    { knowledgeEvidence: null },
    { liveEvidence: { signalId: "sig-capital", symbol: "EUR_USD", side: "buy", spread: NaN, atrPips: 4 } },
    { shadowSignalId: "different-signal" },
  ]) {
    assert.notEqual(manager.capitalGate(completeGateInput(overrides)).decision, "ALLOW");
  }
});