"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateTradeHealth,
  calculateMomentum,
  calculateExpectedFutureValue,
  decideExit,
  calculateExitIQ,
  stageFor,
  calculateKnowledgeConfidence,
  calculateContextMemory,
  calculateRegretMemory,
  compareWithLiveExit,
  ExitEngineX,
} = require("../../exit-engine-x");

test("trade health is bounded and includes all requested dimensions", () => {
  const result = calculateTradeHealth({
    pips: 4,
    mfe: 6,
    mae: -2,
    atrPips: 8,
    spreadPips: 0.4,
    minutesOpen: 3,
    trendStrength: 5,
    entryQuality: 0.8,
    volatilityBucket: "MEDIUM_VOL",
  });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.deepEqual(Object.keys(result.components).sort(), [
    "age", "entryQuality", "excursion", "profit", "spread", "trend", "volatility",
  ]);
});

test("momentum distinguishes acceleration and exhaustion", () => {
  assert.equal(calculateMomentum({ pips: 3, previousPips: 2, previousDelta: 0.2 }).state, "ACCELERATION");
  assert.equal(calculateMomentum({ pips: 3, previousPips: 3.2, previousDelta: 0.1, minutesOpen: 2 }).state, "EXHAUSTION");
});

test("EFV is remaining value, not current profit", () => {
  const result = calculateExpectedFutureValue({
    pips: 8,
    mfe: 10,
    atrPips: 5,
    momentum: { continuation: true, exhaustion: false, deceleration: false },
  });
  assert.ok(result.pips < 8);
  assert.ok(result.observedGiveback > 0);
});

test("decision engine is the only place that resolves module votes", () => {
  assert.equal(decideExit([
    { decision: "CLOSE" },
    { decision: "CLOSE" },
    { decision: "CLOSE" },
    { decision: "HOLD" },
  ]).finalDecision, "CLOSE");
  assert.equal(decideExit([
    { decision: "REDUCE" },
    { decision: "REDUCE" },
    { decision: "HOLD" },
  ]).finalDecision, "REDUCE");
});

test("knowledge confidence is UNKNOWN below the minimum sample and never blocks", () => {
  assert.equal(calculateKnowledgeConfidence({ sampleSize: 4, matched: true }).level, "UNKNOWN");
  assert.equal(calculateKnowledgeConfidence({ sampleSize: 30, matched: true, artifactConfidence: 0.8 }).level, "LOW");
  assert.equal(calculateKnowledgeConfidence({ sampleSize: 300, matched: true, artifactConfidence: 0.8 }).level, "HIGH");
});

test("context and regret memory produce bounded, auditable scores", () => {
  const context = calculateContextMemory({
    context: {
      symbol: "EUR_USD",
      side: "buy",
      session: "LONDON",
      trendBucket: "STRONG_TREND",
      volatilityBucket: "MEDIUM_VOL",
      fingerprint: "fp-a",
      atrPips: 5,
      spreadPips: 0.4,
    },
    similarity: { topScore: 0.8 },
    knowledge: { matchedFingerprint: true },
  });
  const regret = calculateRegretMemory({
    history: [{ mfe: 8, profitPips: 4 }],
    mfe: 6,
    pips: 2,
  });
  assert.ok(context.score >= 0 && context.score <= 100);
  assert.equal(context.matchedFingerprint, true);
  assert.equal(regret.currentRegret, 4);
  assert.equal(regret.averageRegret, 4);
  assert.equal(compareWithLiveExit("CLOSE", "REQUEST_CLOSE").same, true);
  assert.equal(compareWithLiveExit("HOLD", "REQUEST_CLOSE").difference, "CLOSE_VS_HOLD");
});

test("lifecycle and Exit IQ are deterministic", () => {
  assert.equal(stageFor({ minutesOpen: 0.2 }), "BIRTH");
  assert.equal(stageFor({ minutesOpen: 1 }), "DISCOVERY");
  assert.equal(stageFor({ minutesOpen: 3, pips: 1, mfe: 4 }), "EXPANSION");
  assert.equal(stageFor({ minutesOpen: 3, pips: 3, mfe: 4 }), "HARVEST");
  assert.equal(stageFor({ closed: true }), "DEATH");
  assert.equal(calculateExitIQ(10, 5), 50);
  assert.equal(calculateExitIQ(0, -2), 0);
});

test("Exit Engine X is shadow-only and cannot execute broker actions", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../exit-engine-x.js"), "utf8");
  assert.doesNotMatch(source, /closeTrade|axios|stopLoss|orders/);
});

test("state is idempotent and knowledge/history are scoped to the exact signal", async () => {
  const events = [];
  const engine = new ExitEngineX({
    logEvent: (event) => events.push(event),
    db: {
      all: async (sql) => {
        if (sql.includes("knowledge_artifacts")) {
          return [{
            value: JSON.stringify({ fingerprint: "fp-a", expectancyPips: 3 }),
          }];
        }
        return [{
          data: JSON.stringify({ signalId: "signal-a", fingerprint: "fp-a", profitPips: 4 }),
        }];
      },
    },
  });

  await engine.onTradeOpen({ signalId: "signal-a", symbol: "EUR_USD", side: "buy" });
  await engine.onTradeOpen({ signalId: "signal-a", symbol: "EUR_USD", side: "buy" });
  assert.equal(events.filter((event) => event.type === "exit_engine_x_open").length, 1);

  const first = await engine.evaluate({
    signalId: "signal-a",
    symbol: "EUR_USD",
    side: "buy",
    fingerprint: "fp-a",
    pips: 2,
    mfe: 3,
    atrPips: 5,
  });
  const second = await engine.evaluate({
    signalId: "signal-b",
    symbol: "EUR_USD",
    side: "buy",
    fingerprint: "fp-b",
    pips: 2,
    mfe: 3,
    atrPips: 5,
  });
  assert.equal(first.knowledgeResult.matchedFingerprint, true);
  assert.equal(second.knowledgeResult.matchedFingerprint, false);
  assert.equal(first.knowledgeConfidence.level, "UNKNOWN");
  assert.equal(first.votes.length, 11);
  assert.ok(first.votes.every((vote) => ["HOLD", "REDUCE", "CLOSE"].includes(vote.decision)));
  assert.equal(first.liveExitComparison.difference, "SAME");

  await engine.onTradeClose({ signalId: "signal-a", actualExitPips: 2, mfe: 3 });
  await engine.onTradeClose({ signalId: "signal-a", actualExitPips: 2, mfe: 3 });
  assert.equal(engine._states.has("signal-a"), false);
  assert.equal(engine._states.has("signal-b"), true);
  assert.equal(events.filter((event) => event.type === "exit_engine_x_close").length, 1);
});