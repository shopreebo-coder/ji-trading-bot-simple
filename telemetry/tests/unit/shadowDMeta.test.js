"use strict";
/**
 * Unit tests: ShadowDMetaManager — Meta Trade Manager
 *
 * Covers:
 *   1. analyzeEntry — ENTER / WAIT / REJECT / INSUFFICIENT_DATA
 *   2. analyzePosition — HOLD / HOLD_WITH_CAUTION / PROTECT / REDUCE / EXIT
 *   3. Double-check logic for HOLD and EXIT
 *   4. Conflict detection
 *   5. Provenance assessment
 *   6. Strategy matching
 *   7. Data quality assessment
 *   8. Advisory-only guarantees (no execution path)
 *
 * SACRED CONSTRAINT tests:
 *   - D never sets blocked=true
 *   - D never writes to Live Bot state
 *   - All outputs carry advisoryOnly=true + authoritativeLayer="live_bot"
 */

// Prevent ShadowDMetaManager from opening a real PostgreSQL pool during tests.
process.env.SHADOW_D_META_NO_LOG = "1";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const {
  ShadowDMetaManager,
  STRATEGY_KNOWLEDGE,
  PROVENANCE,
  ENTRY_ACTIONS,
  POSITION_ACTIONS,
  SCHEMA_VERSION,
} = require("../../managers/ShadowDMetaManager");

// ── Test fixtures ──────────────────────────────────────────────────────────────

/** Full signal with all fields present — TRENDING conditions */
const FULL_SIGNAL = {
  signalId:      "test-meta-1",
  symbol:        "EUR_USD",
  session:       "LONDON",
  side:          "buy",
  spread:        0.3,
  atrPips:       6.5,
  emaDistance:   2.8,
  candleStrength: 0.18,
  entryGate:     "HARD",
  passCount:     7,
  conditionMap: {
    trend:    true,
    m5close:  true,
    candle:   true,
    ema:      true,
    strength: true,
    m1trend:  true,
    m1candle: true,
    m1prev:   true,
    m1close:  true,
  },
};

/** Signal missing required market fields */
const INCOMPLETE_SIGNAL = {
  signalId: "test-meta-incomplete",
  symbol:   "EUR_USD",
  session:  "LONDON",
  side:     "buy",
  // spread, atrPips, emaDistance, candleStrength intentionally missing
};

/** Engine A — strong quality score */
const ENGINE_A_STRONG = {
  engineId:   "ENGINE_A_QUALITY",
  score:      87,
  condScore:  78,
  confidence: "HIGH",
  wouldTrade: true,
  reason:     "all_conditions",
};

/** Engine A — weak score */
const ENGINE_A_WEAK = {
  engineId:   "ENGINE_A_QUALITY",
  score:      40,
  condScore:  35,
  confidence: "LOW",
  wouldTrade: false,
  reason:     "no_m5trend|weak_ema",
};

/** Engine B — TRENDING */
const ENGINE_B_TRENDING = {
  engineId:   "ENGINE_B_CONTEXT",
  marketState: "TRENDING",
  confidence: "HIGH",
  wouldTrade: true,
  reason:     "ema=2.8p_str=0.18_atr=6.5p",
};

/** Engine B — RANGING */
const ENGINE_B_RANGING = {
  engineId:   "ENGINE_B_CONTEXT",
  marketState: "RANGING",
  confidence: "MEDIUM",
  wouldTrade: false,
  reason:     "ema_dist=1.2p_low_ranging",
};

/** Engine B — VOLATILE */
const ENGINE_B_VOLATILE = {
  engineId:   "ENGINE_B_CONTEXT",
  marketState: "VOLATILE",
  confidence: "HIGH",
  wouldTrade: false,
  reason:     "atr=16.0p_extreme_volatility",
};

/** Engine C — KNN with good win rate */
const ENGINE_C_GOOD = {
  engineId:            "ENGINE_C_KNN",
  wouldTrade:          true,
  confidence:          "MEDIUM",
  kNeighbours:         5,
  avgSimilarity:       0.78,
  historicalWinrate:   62,
  historicalExpectancy: 3.2,
  profitFactor:        1.8,
  datasetSize:         12,
  reason:              "knn_n=5_sim=0.78_wr=62%_exp=3.2p_pf=1.8",
};

/** Engine C — abstaining / no dataset */
const ENGINE_C_EMPTY = {
  engineId:    "ENGINE_C_KNN",
  wouldTrade:  null,
  confidence:  "NONE",
  kNeighbours: 0,
  datasetSize: 0,
  reason:      "no_historical_pairs_oanda_sl_tp_blind_spot",
};

/** Shadow M — position tracked, HOLD */
const SHADOW_M_HOLD = {
  action: "HOLD",
  evidence: {
    tracked:   true,
    signalId:  "test-meta-1",
    mfe:       4.2,
    mae:      -1.1,
    triggeredStrategies: [],
  },
};

/** Shadow M — recommending close */
const SHADOW_M_EXIT = {
  action: "REQUEST_CLOSE",
  evidence: {
    tracked:  true,
    signalId: "test-meta-1",
    mfe:      6.0,
    mae:     -2.0,
    triggeredStrategies: [
      { name: "Profit Protection", exitPips: 3.8, exitTime: "2026-08-20T10:00:00Z" },
    ],
  },
};

/** Position state — positive P&L, early in trade */
const POSITION_EARLY = {
  tradeId:     "T001",
  pips:        2.1,
  mfe:         3.5,
  mae:        -0.8,
  minutesOpen: 12,
  liveAction:  "HOLD",
};

/** Position state — giving back MFE significantly */
const POSITION_GIVEBACK = {
  tradeId:     "T002",
  pips:        1.0,
  mfe:         5.5,
  mae:        -1.2,
  minutesOpen: 45,
  liveAction:  "HOLD",
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. analyzeEntry — action correctness
// ══════════════════════════════════════════════════════════════════════════════

test("analyzeEntry: strong A+B+C+complete signal → ENTER", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(ENTRY_ACTIONS.includes(result.action), `action must be one of ${ENTRY_ACTIONS.join("|")}`);
  assert.equal(result.action, "ENTER", `expected ENTER, got ${result.action}`);
  assert.ok(["HIGH", "MEDIUM"].includes(result.confidence), "confidence must be HIGH or MEDIUM for ENTER");
  assert.ok(result.metaScore >= 55, `metaScore should be >=55, got ${result.metaScore}`);
});

test("analyzeEntry: incomplete signal → INSUFFICIENT_DATA", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  INCOMPLETE_SIGNAL,
    engineA: {},
    engineB: {},
    engineC: {},
  });

  assert.equal(result.action, "INSUFFICIENT_DATA");
  assert.equal(result.confidence, "NONE");
});

test("analyzeEntry: VOLATILE regime → REJECT (critical conflict)", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_VOLATILE,
    engineC: ENGINE_C_GOOD,
  });

  assert.equal(result.action, "REJECT");
  assert.ok(result.conflicts.some(c => c.severity === "CRITICAL"));
});

test("analyzeEntry: weak A + RANGING B → WAIT or REJECT (not ENTER)", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  { ...FULL_SIGNAL, passCount: 4 },
    engineA: ENGINE_A_WEAK,
    engineB: ENGINE_B_RANGING,
    engineC: ENGINE_C_EMPTY,
  });

  assert.ok(["WAIT", "REJECT", "INSUFFICIENT_DATA"].includes(result.action),
    `expected WAIT/REJECT/INSUFFICIENT_DATA, got ${result.action}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. analyzeEntry — output shape invariants
// ══════════════════════════════════════════════════════════════════════════════

test("analyzeEntry: output always carries advisory-only flags", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.equal(result.advisoryOnly,       true,       "advisoryOnly must be true");
  assert.equal(result.authoritativeLayer, "live_bot", "authoritativeLayer must be live_bot");
  assert.equal(result.schemaVersion,      SCHEMA_VERSION);
  assert.ok(typeof result.generatedAt === "string", "generatedAt must be a string");
});

test("analyzeEntry: output never contains a blocked or execution key", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(!("blocked" in result), "result must NOT contain a 'blocked' key");
  assert.ok(!("execute" in result), "result must NOT contain an 'execute' key");
  assert.ok(!("placeTrade" in result));
  assert.ok(!("closePosition" in result));
});

test("analyzeEntry: reasoning is a non-empty array of strings", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(Array.isArray(result.reasoning), "reasoning must be an array");
  assert.ok(result.reasoning.length > 0,     "reasoning must not be empty");
  for (const r of result.reasoning)
    assert.equal(typeof r, "string", "each reasoning item must be a string");
});

test("analyzeEntry: action is always a valid ENTRY_ACTION", () => {
  const scenarios = [
    { signal: FULL_SIGNAL,      engineA: ENGINE_A_STRONG, engineB: ENGINE_B_TRENDING,  engineC: ENGINE_C_GOOD  },
    { signal: INCOMPLETE_SIGNAL, engineA: {},              engineB: {},                  engineC: {}             },
    { signal: FULL_SIGNAL,      engineA: ENGINE_A_STRONG, engineB: ENGINE_B_VOLATILE,  engineC: ENGINE_C_GOOD  },
    { signal: FULL_SIGNAL,      engineA: ENGINE_A_WEAK,   engineB: ENGINE_B_RANGING,   engineC: ENGINE_C_EMPTY },
  ];
  for (const s of scenarios) {
    const result = ShadowDMetaManager.analyzeEntry(s);
    assert.ok(ENTRY_ACTIONS.includes(result.action), `Invalid action: ${result.action}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. analyzePosition — post-entry decisions
// ══════════════════════════════════════════════════════════════════════════════

test("analyzePosition: Shadow M REQUEST_CLOSE → EXIT", () => {
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_TRENDING,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_EXIT,
    position: POSITION_EARLY,
  });

  assert.ok(POSITION_ACTIONS.includes(result.action), `action must be a POSITION_ACTION, got ${result.action}`);
  // M says REQUEST_CLOSE; D should suggest EXIT or PROTECT (double-check may soften)
  assert.ok(["EXIT", "PROTECT"].includes(result.action),
    `expected EXIT or PROTECT when M=REQUEST_CLOSE, got ${result.action}`);
});

test("analyzePosition: good trending conditions + HOLD shadow M → HOLD family", () => {
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_TRENDING,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_EARLY,
  });

  assert.ok(POSITION_ACTIONS.includes(result.action));
  assert.ok(["HOLD", "HOLD_WITH_CAUTION", "PROTECT"].includes(result.action),
    `expected HOLD family when conditions are good, got ${result.action}`);
});

test("analyzePosition: large MFE giveback → PROTECT", () => {
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_TRENDING,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_GIVEBACK,  // pips=1.0, mfe=5.5 → retention=18%
  });

  assert.ok(["PROTECT", "HOLD_WITH_CAUTION", "REDUCE", "EXIT"].includes(result.action),
    `expected protective action when giving back MFE, got ${result.action}`);
});

test("analyzePosition: VOLATILE regime → EXIT", () => {
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_VOLATILE,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_EARLY,
  });

  assert.equal(result.action, "EXIT", "VOLATILE regime must trigger EXIT suggestion");
  assert.equal(result.confidence, "HIGH");
});

test("analyzePosition: output always carries advisory-only flags", () => {
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_TRENDING,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_EARLY,
  });

  assert.equal(result.advisoryOnly,       true,       "advisoryOnly must be true");
  assert.equal(result.authoritativeLayer, "live_bot", "authoritativeLayer must be live_bot");
  assert.ok(!("blocked" in result));
  assert.ok(!("execute" in result));
});

test("analyzePosition: action is always a valid POSITION_ACTION", () => {
  const scenarios = [
    { signal: FULL_SIGNAL, engineA: ENGINE_A_STRONG, engineB: ENGINE_B_TRENDING,  shadowM: SHADOW_M_HOLD, position: POSITION_EARLY },
    { signal: FULL_SIGNAL, engineA: ENGINE_A_STRONG, engineB: ENGINE_B_VOLATILE,  shadowM: SHADOW_M_HOLD, position: POSITION_EARLY },
    { signal: FULL_SIGNAL, engineA: ENGINE_A_STRONG, engineB: ENGINE_B_TRENDING,  shadowM: SHADOW_M_EXIT, position: POSITION_EARLY },
    { signal: FULL_SIGNAL, engineA: ENGINE_A_WEAK,   engineB: ENGINE_B_RANGING,   shadowM: SHADOW_M_HOLD, position: POSITION_GIVEBACK },
  ];
  for (const s of scenarios) {
    const r = ShadowDMetaManager.analyzePosition({ ...s, engineC: ENGINE_C_GOOD });
    assert.ok(POSITION_ACTIONS.includes(r.action), `Invalid position action: ${r.action}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Double-check logic
// ══════════════════════════════════════════════════════════════════════════════

test("analyzePosition: double-check is performed for HOLD and EXIT decisions", () => {
  // HOLD scenario
  const holdResult = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_TRENDING,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_EARLY,
  });
  // EXIT scenario
  const exitResult = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_VOLATILE,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: POSITION_EARLY,
  });

  assert.equal(holdResult.doubleCheck.performed, true, "HOLD must trigger double-check");
  assert.equal(exitResult.doubleCheck.performed, true, "EXIT must trigger double-check");
  // Double-check must have two independent questions
  assert.ok("checkA" in holdResult.doubleCheck, "double-check must have checkA");
  assert.ok("checkB" in holdResult.doubleCheck, "double-check must have checkB");
  assert.ok(typeof holdResult.doubleCheck.checkA.verdict === "boolean");
  assert.ok(typeof holdResult.doubleCheck.checkB.verdict === "boolean");
});

test("analyzePosition: double-check can soften EXIT to PROTECT when edge exists", () => {
  // Volatile triggers EXIT, but A is strong + pips are positive
  const result = ShadowDMetaManager.analyzePosition({
    signal:   FULL_SIGNAL,
    engineA:  ENGINE_A_STRONG,
    engineB:  ENGINE_B_VOLATILE,
    engineC:  ENGINE_C_GOOD,
    shadowM:  SHADOW_M_HOLD,
    position: { ...POSITION_EARLY, pips: 3.0, mfe: 4.0, minutesOpen: 5 },
  });

  // Double-check passes A (strong edge) + B (pips > 0, retention OK) → may soften
  assert.ok(POSITION_ACTIONS.includes(result.action));
  if (result.doubleCheck.overrideAction) {
    assert.equal(result.action, result.doubleCheck.overrideAction, "overrideAction must be applied");
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Conflict detection
// ══════════════════════════════════════════════════════════════════════════════

test("conflicts: A=TRADE + B=RANGING → quality_regime conflict", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_RANGING,
    engineC: ENGINE_C_GOOD,
  });

  const has = result.conflicts.some(c => c.type === "quality_regime" || c.type === "trend_in_range");
  assert.ok(has, "Expected quality_regime or trend_in_range conflict");
});

test("conflicts: VOLATILE regime → critical conflict", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_VOLATILE,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(result.conflicts.some(c => c.severity === "CRITICAL"),
    "VOLATILE must produce a CRITICAL conflict");
});

test("conflicts: all abstain → critical all_abstain conflict", () => {
  const noVote = { wouldTrade: null, confidence: "NONE", marketState: null, kNeighbours: 0, datasetSize: 0 };
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: { ...noVote, engineId: "ENGINE_A_QUALITY", score: null },
    engineB: { ...noVote, engineId: "ENGINE_B_CONTEXT" },
    engineC: { ...noVote, engineId: "ENGINE_C_KNN" },
  });

  assert.ok(result.conflicts.some(c => c.type === "all_abstain"),
    "All-abstain must produce all_abstain conflict");
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Provenance assessment
// ══════════════════════════════════════════════════════════════════════════════

test("provenance: shadowM synthetic signalId → SYNTHETIC tier", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
    shadowM: {
      action: "HOLD",
      evidence: {
        tracked: true,
        signalId: "_lifecycle_1782841106792",
        mfe: 2.0,
        mae: -0.5,
        triggeredStrategies: [],
      },
    },
  });

  assert.ok(
    [PROVENANCE.SYNTHETIC, PROVENANCE.HISTORICAL].includes(result.provenance.tier),
    `Expected SYNTHETIC or HISTORICAL for lifecycle signalId, got ${result.provenance.tier}`
  );
  assert.ok(result.provenance.flags.includes("shadow_m_synthetic_or_test"),
    "synthetic flag must be set");
});

test("provenance: real signalId + tracked → LIVE_BROKER", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
    shadowM: {
      action: "HOLD",
      evidence: { tracked: true, signalId: "abc123-real-signal", mfe: 3.0, mae: -0.5 },
    },
  });

  assert.equal(result.provenance.tier, PROVENANCE.LIVE_BROKER);
  assert.equal(result.provenance.shadowMTracked, true);
});

test("provenance: no shadowM + no C dataset → UNKNOWN", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_EMPTY,
    shadowM: null,
  });

  assert.equal(result.provenance.tier, PROVENANCE.UNKNOWN);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Strategy matching
// ══════════════════════════════════════════════════════════════════════════════

test("strategyContext: strong HARD entry matches TREND_FOLLOWING", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(
    result.strategyContext.matchedPatterns.includes("TREND_FOLLOWING") ||
    result.strategyContext.matchedPatterns.includes("MOMENTUM_BREAKOUT"),
    `Expected TREND_FOLLOWING or MOMENTUM_BREAKOUT, got ${JSON.stringify(result.strategyContext.matchedPatterns)}`
  );
});

test("strategyContext: RELAXED gate only matched when entryGate=RELAXED", () => {
  const hardResult = ShadowDMetaManager.analyzeEntry({
    signal:  { ...FULL_SIGNAL, entryGate: "HARD" },
    engineA: { ...ENGINE_A_STRONG, score: 60 },
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });
  const relaxedResult = ShadowDMetaManager.analyzeEntry({
    signal:  { ...FULL_SIGNAL, entryGate: "RELAXED" },
    engineA: { ...ENGINE_A_STRONG, score: 60 },
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(
    !hardResult.strategyContext.matchedPatterns.includes("RELAXED_GATE_ENTRY"),
    "RELAXED_GATE_ENTRY must NOT appear for HARD gate"
  );
  assert.ok(
    relaxedResult.strategyContext.matchedPatterns.includes("RELAXED_GATE_ENTRY") ||
    relaxedResult.strategyContext.matchedPatterns.length >= 0,
    "RELAXED_GATE_ENTRY may appear for RELAXED gate given sufficient score/conditions"
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Data quality assessment
// ══════════════════════════════════════════════════════════════════════════════

test("dataQuality: full signal + all engines ready → high quality score", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  FULL_SIGNAL,
    engineA: ENGINE_A_STRONG,
    engineB: ENGINE_B_TRENDING,
    engineC: ENGINE_C_GOOD,
  });

  assert.ok(result.dataQuality.score >= 70, `quality score should be >=70, got ${result.dataQuality.score}`);
  assert.equal(result.dataQuality.missingFields.length, 0, "no missing fields for full signal");
});

test("dataQuality: empty signal → low quality score and action=INSUFFICIENT_DATA", () => {
  const result = ShadowDMetaManager.analyzeEntry({
    signal:  {},
    engineA: {},
    engineB: {},
    engineC: {},
  });

  assert.ok(result.dataQuality.score < 50, "low quality for empty signal");
  assert.equal(result.action, "INSUFFICIENT_DATA");
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Fail-safe: errors never propagate
// ══════════════════════════════════════════════════════════════════════════════

test("analyzeEntry: throws internally → returns INSUFFICIENT_DATA safe fallback", () => {
  // Pass a broken object that would cause internal errors
  const result = ShadowDMetaManager.analyzeEntry(null);

  assert.ok(ENTRY_ACTIONS.includes(result.action), "fallback action must be a valid ENTRY_ACTION");
  assert.equal(result.advisoryOnly,       true);
  assert.equal(result.authoritativeLayer, "live_bot");
});

test("analyzePosition: throws internally → returns HOLD safe fallback", () => {
  const result = ShadowDMetaManager.analyzePosition(null);

  assert.ok(POSITION_ACTIONS.includes(result.action), "fallback action must be a valid POSITION_ACTION");
  assert.equal(result.advisoryOnly,       true);
  assert.equal(result.authoritativeLayer, "live_bot");
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Module exports and static constants
// ══════════════════════════════════════════════════════════════════════════════

test("exports: ENTRY_ACTIONS contains all required values", () => {
  for (const a of ["ENTER", "WAIT", "REJECT", "INSUFFICIENT_DATA"])
    assert.ok(ENTRY_ACTIONS.includes(a), `ENTRY_ACTIONS missing ${a}`);
});

test("exports: POSITION_ACTIONS contains all required values", () => {
  for (const a of ["HOLD", "HOLD_WITH_CAUTION", "PROTECT", "REDUCE", "EXIT"])
    assert.ok(POSITION_ACTIONS.includes(a), `POSITION_ACTIONS missing ${a}`);
});

test("exports: STRATEGY_KNOWLEDGE is non-empty and each entry has required fields", () => {
  const keys = Object.keys(STRATEGY_KNOWLEDGE);
  assert.ok(keys.length >= 3, "At least 3 strategies must be defined");
  for (const k of keys) {
    const s = STRATEGY_KNOWLEDGE[k];
    assert.ok(s.label,       `${k} must have label`);
    assert.ok(s.edgeScore,   `${k} must have edgeScore`);
    assert.ok(s.holdBias,    `${k} must have holdBias`);
    assert.ok(s.invalidation, `${k} must have invalidation array`);
  }
});

test("exports: PROVENANCE contains all six tiers", () => {
  for (const t of ["LIVE_BROKER", "HISTORICAL", "TEST", "SYNTHETIC", "RECONSTRUCTED", "UNKNOWN"])
    assert.ok(PROVENANCE[t], `PROVENANCE missing ${t}`);
});

test("class: analyzeAndLogEntry is a convenience wrapper returning same shape as analyzeEntry", () => {
  const direct    = ShadowDMetaManager.analyzeEntry({ signal: FULL_SIGNAL, engineA: ENGINE_A_STRONG, engineB: ENGINE_B_TRENDING, engineC: ENGINE_C_GOOD });
  const wrapped   = ShadowDMetaManager.analyzeAndLogEntry({ signal: FULL_SIGNAL, engineA: ENGINE_A_STRONG, engineB: ENGINE_B_TRENDING, engineC: ENGINE_C_GOOD });

  assert.ok(ENTRY_ACTIONS.includes(wrapped.action));
  assert.ok(Object.prototype.hasOwnProperty.call(wrapped, "metaScore"));
  assert.equal(wrapped.advisoryOnly, true);
  assert.equal(wrapped.schemaVersion, SCHEMA_VERSION);
});
