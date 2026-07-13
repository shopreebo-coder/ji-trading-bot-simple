"use strict";
/**
 * Selected Engine — unit tests for the pure ranking + consensus math.
 *
 * These are 100% pure (no DB, no I/O) and always run. They lock the two
 * invariants the Selected Engine depends on:
 *   1. Intelligence ranks by confidence → expectancy → trainingEvents →
 *      version → freshness (NEVER by win rate), with nulls sorted last.
 *   2. Consensus is TRI-STATE: an abstaining engine (wouldTrade=null) is
 *      excluded from BOTH the numerator and denominator — never coerced to a
 *      "no" vote.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  numOrNull,
  boolOrNull,
  confidenceToScore,
  scoreToTier,
  rankIntelligence,
  computeConsensus,
  cmpDescNullsLast,
} = require("../../managers/selected/ranking");

test("numOrNull never fabricates a zero", () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull("abc"), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull("5"), 5);
  assert.equal(numOrNull(-2.5), -2.5);
});

test("boolOrNull preserves abstention (tri-state)", () => {
  assert.equal(boolOrNull(true), true);
  assert.equal(boolOrNull(false), false);
  assert.equal(boolOrNull(null), null);
  assert.equal(boolOrNull(undefined), null);
  assert.equal(boolOrNull(""), null);
  assert.equal(boolOrNull(1), true);
  assert.equal(boolOrNull("0"), false);
  assert.equal(boolOrNull("true"), true);
  assert.equal(boolOrNull("f"), false);
});

test("confidenceToScore / scoreToTier map tiers, null-safe", () => {
  assert.equal(confidenceToScore("HIGH"), 1.0);
  assert.equal(confidenceToScore("medium"), 0.6);
  assert.equal(confidenceToScore("Low"), 0.3);
  assert.equal(confidenceToScore(null), null);
  assert.equal(confidenceToScore("???"), null);
  assert.equal(scoreToTier(1.0), "HIGH");
  assert.equal(scoreToTier(0.6), "MEDIUM");
  assert.equal(scoreToTier(0.3), "LOW");
  assert.equal(scoreToTier(null), null);
});

test("cmpDescNullsLast sorts high→low with nulls last", () => {
  const arr = [3, null, 1, 10, undefined, 5].slice().sort(cmpDescNullsLast);
  assert.deepEqual(arr, [10, 5, 3, 1, null, undefined]);
});

test("rankIntelligence orders by the full key chain (not win rate)", () => {
  const records = [
    { source: "low-conf",   confidence: 0.3, expectancy: 99, trainingEvents: 99, version: 9, freshness: 9 },
    { source: "high-conf",  confidence: 0.9, expectancy: 1,  trainingEvents: 1,  version: 1, freshness: 1 },
    { source: "mid-a",      confidence: 0.6, expectancy: 2.0, trainingEvents: 5, version: 3, freshness: 100 },
    { source: "mid-b",      confidence: 0.6, expectancy: 2.0, trainingEvents: 5, version: 3, freshness: 200 },
    { source: "mid-lowexp", confidence: 0.6, expectancy: 1.0, trainingEvents: 99, version: 9, freshness: 999 },
    { source: "null-conf",  confidence: null, expectancy: 100, trainingEvents: 100, version: 100, freshness: 100 },
  ];
  const ranked = rankIntelligence(records).map((r) => r.source);
  // confidence dominates; null confidence sinks to the bottom.
  assert.equal(ranked[0], "high-conf");
  assert.equal(ranked[ranked.length - 1], "null-conf");
  // within equal confidence (0.6): higher expectancy first, then freshness tiebreak.
  const idxA = ranked.indexOf("mid-a");
  const idxB = ranked.indexOf("mid-b");
  const idxLowExp = ranked.indexOf("mid-lowexp");
  assert.ok(idxA < idxLowExp && idxB < idxLowExp, "higher expectancy ranks above lower");
  assert.ok(idxB < idxA, "fresher (200 > 100) breaks the tie once conf/exp/events/version match");
  // input array not mutated
  assert.equal(records[0].source, "low-conf");
});

test("computeConsensus: unanimous TRADE", () => {
  const c = computeConsensus([
    { engineId: "A", wouldTrade: true },
    { engineId: "B", wouldTrade: true },
    { engineId: "C", wouldTrade: true },
  ]);
  assert.equal(c.consensus, "TRADE");
  assert.equal(c.votesFor, 3);
  assert.equal(c.votesAgainst, 0);
  assert.equal(c.abstain, 0);
  assert.equal(c.agreementScore, 100);
  assert.equal(c.disagreementScore, 0);
});

test("computeConsensus: abstention excluded from both numerator and denominator", () => {
  const c = computeConsensus([
    { engineId: "A", wouldTrade: true },
    { engineId: "B", wouldTrade: true },
    { engineId: "C", wouldTrade: false },
    { engineId: "D", wouldTrade: null },  // abstain — must NOT count as a "no"
  ]);
  assert.equal(c.decided, 3, "only committed engines are counted");
  assert.equal(c.abstain, 1);
  assert.equal(c.consensus, "TRADE");
  assert.equal(c.agreementScore, 66.7, "2 of 3 decided agree — abstainer not in denominator");
  assert.deepEqual(c.abstaining, ["D"]);
  assert.deepEqual(c.agreeing.sort(), ["A", "B"]);
  assert.deepEqual(c.dissenting, ["C"]);
});

test("computeConsensus: all abstain ⇒ ABSTAIN with null scores", () => {
  const c = computeConsensus([
    { engineId: "A", wouldTrade: null },
    { engineId: "B", wouldTrade: null },
  ]);
  assert.equal(c.consensus, "ABSTAIN");
  assert.equal(c.decided, 0);
  assert.equal(c.agreementScore, null);
  assert.equal(c.disagreementScore, null);
});

test("computeConsensus: tie ⇒ SPLIT", () => {
  const c = computeConsensus([
    { engineId: "A", wouldTrade: true },
    { engineId: "B", wouldTrade: false },
  ]);
  assert.equal(c.consensus, "SPLIT");
  assert.equal(c.agreementScore, 50);
  assert.equal(c.disagreementScore, 50);
});

test("computeConsensus: majority NO_TRADE", () => {
  const c = computeConsensus([
    { engineId: "A", wouldTrade: false },
    { engineId: "B", wouldTrade: false },
    { engineId: "C", wouldTrade: true },
  ]);
  assert.equal(c.consensus, "NO_TRADE");
  assert.deepEqual(c.agreeing.sort(), ["A", "B"]);
});
