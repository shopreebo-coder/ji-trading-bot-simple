"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SelectedEngineManager } = require("../../managers/SelectedEngineManager");

function makeKnowledge() {
  return {
    exportActive: async () => [
      {
        id: 1,
        domain: "patterns",
        artifact: "validated",
        version: 1,
        value: {
          patterns: [{
            validated: true,
            resolved: 42,
            symbol: "EUR_USD",
            side: "buy",
            trendBucket: "UP",
            volatilityBucket: "MED",
            spreadBucket: "TIGHT",
            expectancyPips: 2.4,
          }],
        },
      },
    ],
    listSnapshots: async () => [{ id: 1, manifest_checksum: "snapshot-checksum" }],
  };
}

function makeManager() {
  const evaluations = [
    { id: 1, engine_id: "A", engine_version: "test", would_trade: true, score: 0.9, confidence: "HIGH", eval: { reason: "A" } },
    { id: 2, engine_id: "B", engine_version: "test", would_trade: true, score: 0.9, confidence: "HIGH", eval: { reason: "B" } },
    { id: 3, engine_id: "C", engine_version: "test", would_trade: true, score: 0.9, confidence: "HIGH", eval: { reason: "C" } },
  ];
  const db = {
    async all(sql) {
      if (sql.includes("GROUP BY engine_id")) {
        return evaluations.map((row) => ({ engine_id: row.engine_id, engine_version: row.engine_version }));
      }
      if (sql.includes("FROM shadow_engine_evals WHERE signal_id")) return evaluations;
      return [];
    },
    async get(sql) {
      if (sql.includes("FROM shadow_outcomes")) return null;
      return null;
    },
  };
  return new SelectedEngineManager({
    db,
    knowledge: makeKnowledge(),
    ringSize: 10,
  });
}

function signal(advisoryOutputs) {
  return {
    signalId: "sig-controlled",
    symbol: "EUR_USD",
    side: "buy",
    trendBucket: "UP",
    volatilityBucket: "MED",
    spreadBucket: "TIGHT",
    passCount: 8,
    spread: 1.0,
    atrPips: 8,
    advisoryOutputs,
  };
}

test("Selected Engine consumes current A/B/C opinions and matched Knowledge evidence", async () => {
  const result = await makeManager().evaluateEntry(signal({
    A: { recommendation: "TRADE", confidence: "HIGH" },
    B: { recommendation: "TRADE", confidence: "HIGH" },
    C: { recommendation: "TRADE", confidence: "HIGH" },
  }));

  assert.equal(result.decision, "TRADE");
  assert.equal(result.shadowConsensus, "TRADE");
  assert.equal(result.shadowConfidence, "HIGH");
  assert.equal(result.decisionSource, "live_shadow_outputs");
  assert.equal(result.knowledgeEvidence.available, true);
  assert.ok(result.knowledgeEvidence.matchCount > 0);
});

test("Selected Engine abstains on same-signal Shadow conflict or malformed output", async () => {
  const conflict = await makeManager().evaluateEntry(signal({
    A: { recommendation: "TRADE", confidence: "HIGH" },
    B: { recommendation: "NO_TRADE", confidence: "HIGH" },
  }));
  assert.equal(conflict.shadowConsensus, "SPLIT");
  assert.equal(conflict.decision, "ABSTAIN");

  const malformed = await makeManager().evaluateEntry(signal({
    A: { recommendation: "BROKEN", confidence: "HIGH" },
  }));
  assert.equal(malformed.shadowConsensus, "ABSTAIN");
  assert.equal(malformed.decision, "ABSTAIN");
});

test("Selected Engine rejects incomplete or out-of-scope inline evidence", async () => {
  const missing = await makeManager().evaluateEntry(signal({
    A: { recommendation: "TRADE", confidence: "HIGH" },
  }));
  assert.equal(missing.decision, "ABSTAIN");
  assert.equal(missing.confidenceScore, null);
  assert.equal(missing.decisionSource, "controlled_shadow_incomplete");

  const extra = await makeManager().evaluateEntry(signal({
    A: { recommendation: "TRADE", confidence: "HIGH" },
    B: { recommendation: "TRADE", confidence: "HIGH" },
    C: { recommendation: "TRADE", confidence: "HIGH" },
    D: { recommendation: "TRADE", confidence: "HIGH" },
  }));
  assert.equal(extra.decision, "ABSTAIN");
  assert.equal(extra.decisionSource, "controlled_shadow_incomplete");
});