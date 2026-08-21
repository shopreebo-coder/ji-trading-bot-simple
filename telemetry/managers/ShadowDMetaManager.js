"use strict";
/**
 * Shadow D — Meta Trade Manager  (FOREX ENGINE PRO v40+)
 *
 * Rebuilt from a static vote aggregator into a full Meta Intelligence layer.
 *
 * Receives:  live A/B/C evaluations + Shadow M advisory + Knowledge context
 * Produces:  structured suggestion objects (ADVISORY ONLY — never executes)
 *
 * SACRED CONSTRAINTS (unchanged from Shadow framework):
 *   - NEVER opens, closes, or modifies any real trade
 *   - NEVER calls OANDA or any broker API
 *   - NEVER has a direct execution path
 *   - NEVER overrides Live Bot risk, SL/TP, lot size, or position sizing
 *   - ALL outputs are advisory-only; Live Bot has final authority
 *
 * Decision objects:
 *   Pre-trade  → ENTER | WAIT | REJECT | INSUFFICIENT_DATA
 *   Post-entry → HOLD  | HOLD_WITH_CAUTION | PROTECT | REDUCE | EXIT
 */

// Lazy — avoids holding open the PostgreSQL pool in test environments.
// In production, telemetry/index.js is already loaded before this module,
// so the cached require() returns the existing logEvent without side effects.
// Set SHADOW_D_META_NO_LOG=1 in test environments to skip all DB writes.
let _logEvent = null;
function _getLogEvent() {
  if (process.env.SHADOW_D_META_NO_LOG === "1") return () => {};
  if (!_logEvent) {
    try { _logEvent = require("../index").logEvent; } catch (_) {}
  }
  return _logEvent || (() => {});
}

// ── Schema version — bump ONLY on breaking shape change (additive fields are free)
const SCHEMA_VERSION = 1;

// ── Provenance tiers — how trustworthy is the underlying evidence ─────────────
const PROVENANCE = Object.freeze({
  LIVE_BROKER:   "LIVE_BROKER",
  HISTORICAL:    "HISTORICAL",
  TEST:          "TEST",
  SYNTHETIC:     "SYNTHETIC",
  RECONSTRUCTED: "RECONSTRUCTED",
  UNKNOWN:       "UNKNOWN",
});

// ── Action sets (exhaustive) ─────────────────────────────────────────────────
const ENTRY_ACTIONS    = Object.freeze(["ENTER", "WAIT", "REJECT", "INSUFFICIENT_DATA"]);
const POSITION_ACTIONS = Object.freeze(["HOLD", "HOLD_WITH_CAUTION", "PROTECT", "REDUCE", "EXIT"]);

// ══════════════════════════════════════════════════════════════════════════════
// TRADING STRATEGY KNOWLEDGE  (embedded — version-controlled here)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Each entry describes a trading pattern this system is designed to trade.
 * D uses this knowledge to:
 *   1. Identify which pattern (if any) is active for the current signal.
 *   2. Apply the pattern's HOLD / EXIT biases during position management.
 *   3. Weight the overall meta score using the pattern's known edge score.
 *
 * This is META KNOWLEDGE — it interprets A/B/C/M outputs, not raw market data.
 * Treat every entry as a hypothesis; prefer live evidence (C, M) over assumptions.
 */
const STRATEGY_KNOWLEDGE = Object.freeze({
  TREND_FOLLOWING: {
    label:       "Trend Following",
    description: "Enter in direction of established EMA trend with M5+M1 alignment",
    conditions:  { required: ["trend", "ema", "strength"], preferred: ["m1trend", "m1candle", "m5close"] },
    regime:      ["TRENDING"],
    minPassCount: 6,
    minScore:     65,
    riskReward:   { min: 1.5, ideal: 2.0 },
    edgeScore:    80,
    invalidation: ["regime=RANGING", "regime=VOLATILE", "regime=DEAD", "A.score<50"],
    holdBias:     "HOLD",
    exitBias:     "PROTECT_EARLY_IF_REGIME_CHANGES",
  },

  MOMENTUM_BREAKOUT: {
    label:       "Momentum Breakout",
    description: "Strong candle + large EMA gap; expect fast follow-through",
    conditions:  { required: ["strength", "ema", "candle"], preferred: ["trend", "m1candle"] },
    regime:      ["TRENDING"],
    minPassCount: 7,
    minScore:     70,
    riskReward:   { min: 1.5, ideal: 2.5 },
    edgeScore:    85,
    invalidation: ["atrPips<4", "spread>2", "candleStrength<0.12"],
    holdBias:     "PROTECT",
    exitBias:     "TIGHT_TRAIL",
  },

  EMA_PULLBACK_CONTINUATION: {
    label:       "EMA Pullback / Continuation",
    description: "Price pulled back to EMA in established trend; M1 confirms re-entry",
    conditions:  { required: ["trend", "m1trend", "m1candle"], preferred: ["ema", "m1close"] },
    regime:      ["TRENDING"],
    minPassCount: 5,
    minScore:     60,
    riskReward:   { min: 1.5, ideal: 2.0 },
    edgeScore:    70,
    invalidation: ["regime=RANGING", "A.score<55"],
    holdBias:     "HOLD",
    exitBias:     "TRAIL_AFTER_MFE",
  },

  RELAXED_GATE_ENTRY: {
    label:       "Relaxed Gate / Partial Alignment",
    description: "passScore >= 6 but missing some hard conditions; lower base confidence",
    conditions:  { required: ["ema", "strength", "candle"], preferred: ["trend", "m1trend"] },
    regime:      ["TRENDING"],
    minPassCount: 6,
    minScore:     55,
    riskReward:   { min: 2.0, ideal: 3.0 },
    edgeScore:    55,
    invalidation: ["A.score<55", "regime!=TRENDING"],
    holdBias:     "HOLD_WITH_CAUTION",
    exitBias:     "EARLIER_EXIT",
    requiresHighKNN: true,   // needs C confirmation more than other patterns
  },

  RANGE_FADE: {
    label:       "Range / Mean Reversion",
    description: "Signal in RANGING regime — fade approach, tight stops",
    conditions:  { required: ["strength", "candle"], preferred: ["ema", "m1candle"] },
    regime:      ["RANGING"],
    minPassCount: 4,
    minScore:     50,
    riskReward:   { min: 1.0, ideal: 1.5 },
    edgeScore:    40,
    invalidation: ["regime=TRENDING", "atrPips>10"],
    holdBias:     "PROTECT",
    exitBias:     "EARLY_TARGET",
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPER FUNCTIONS  (module-private)
// ══════════════════════════════════════════════════════════════════════════════

/** Match active trading strategies given signal and engine A output. */
function _matchStrategies(signal, engineA) {
  const { conditionMap = {}, entryGate = "HARD", passCount = 0 } = signal;
  const score   = typeof engineA?.score === "number" ? engineA.score : 0;
  const matched = [];

  for (const [key, strat] of Object.entries(STRATEGY_KNOWLEDGE)) {
    // Skip RELAXED_GATE_ENTRY unless gate is actually RELAXED
    if (key === "RELAXED_GATE_ENTRY" && entryGate !== "RELAXED") continue;
    if (score     < strat.minScore)     continue;
    if (passCount < strat.minPassCount) continue;
    const reqMet = strat.conditions.required.every(k => conditionMap[k] === true);
    if (!reqMet) continue;
    matched.push({ key, ...strat });
  }

  // Highest edge score first
  matched.sort((a, b) => b.edgeScore - a.edgeScore);
  return matched;
}

/** Detect conflicts between A/B/C/M outputs. */
function _detectConflicts(engineA, engineB, engineC, shadowM) {
  const conflicts = [];
  const aVote  = engineA?.wouldTrade;
  const bVote  = engineB?.wouldTrade;
  const cVote  = engineC?.wouldTrade;
  const regime = engineB?.marketState;
  const mAct   = shadowM?.action;

  if (aVote === true && bVote === false)
    conflicts.push({ type: "quality_regime",      severity: "HIGH",     desc: "A:TRADE but B:SKIP — quality signal in unfavourable regime" });
  if (cVote === true && aVote === false)
    conflicts.push({ type: "memory_quality",      severity: "MEDIUM",   desc: "C:TRADE but A:SKIP — historical memory contradicts current quality score" });
  if (aVote === true && cVote === false && (engineC?.kNeighbours ?? 0) >= 3)
    conflicts.push({ type: "quality_memory",      severity: "MEDIUM",   desc: "A:TRADE but C:SKIP (≥3 neighbours) — quality overrides KNN memory" });
  if (regime === "RANGING" && aVote === true)
    conflicts.push({ type: "trend_in_range",      severity: "HIGH",     desc: "Trend entry in RANGING regime — elevated false-breakout risk" });
  if (regime === "VOLATILE")
    conflicts.push({ type: "unsafe_regime_vol",   severity: "CRITICAL", desc: "Regime=VOLATILE — ATR too extreme for safe entry" });
  if (regime === "DEAD")
    conflicts.push({ type: "unsafe_regime_dead",  severity: "CRITICAL", desc: "Regime=DEAD — no market activity, entry pointless" });
  if (mAct === "REQUEST_CLOSE" || mAct === "EXIT")
    conflicts.push({ type: "behaviour_exit",      severity: "HIGH",     desc: "Shadow M recommends close — open trade behaviour is deteriorating" });
  if (aVote === null && bVote === null && cVote === null)
    conflicts.push({ type: "all_abstain",         severity: "CRITICAL", desc: "A/B/C all abstain — insufficient evidence for any decision" });

  return conflicts;
}

/**
 * Assess provenance of the D meta decision.
 * Based on known signal-ID prefixes from Shadow M and C dataset size.
 */
function _assessProvenance(engineC, shadowM) {
  const flags       = [];
  const datasetSize = engineC?.datasetSize ?? 0;
  let tier          = PROVENANCE.UNKNOWN;

  if (datasetSize === 0) {
    flags.push("c_no_historical_data");
  } else {
    tier = PROVENANCE.HISTORICAL;
  }

  if (shadowM?.evidence?.signalId) {
    const sid = String(shadowM.evidence.signalId);
    if (/^_lifecycle_|^e2e-sim|^e2e-fix|^T6-|^T6R-|^SEL-/.test(sid)) {
      flags.push("shadow_m_synthetic_or_test");
      if (tier === PROVENANCE.UNKNOWN) tier = PROVENANCE.SYNTHETIC;
    } else if (shadowM.evidence.lateStart === true) {
      flags.push("shadow_m_reconstructed_from_snapshot");
      if (tier === PROVENANCE.UNKNOWN || tier === PROVENANCE.HISTORICAL)
        tier = PROVENANCE.RECONSTRUCTED;
    } else if (shadowM.evidence.tracked === true) {
      // Only upgrade to LIVE_BROKER when we have a real signalId and full tracking
      tier = PROVENANCE.LIVE_BROKER;
    }
  }

  return { tier, flags, datasetSize, shadowMTracked: shadowM?.evidence?.tracked === true };
}

/** Assess completeness and reliability of input data for the D decision. */
function _assessDataQuality(signal, engineA, engineB, engineC, shadowM) {
  const signalFields = ["spread", "atrPips", "emaDistance", "candleStrength"];
  const missingFields = signalFields.filter(k => {
    const v = signal[k];
    return v === null || v === undefined || !Number.isFinite(Number(v));
  });
  if (!signal.conditionMap || typeof signal.conditionMap !== "object" || Object.keys(signal.conditionMap).length === 0)
    missingFields.push("conditionMap");
  if (signal.passCount === null || signal.passCount === undefined)
    missingFields.push("passCount");

  const aComplete = !!(engineA?.engineId && engineA?.confidence !== "NONE" && typeof engineA?.score === "number");
  const bComplete = !!(engineB?.engineId && engineB?.marketState && engineB.marketState !== "UNKNOWN");
  const cHasData  = (engineC?.datasetSize ?? 0) > 0;
  const mTracked  = shadowM?.evidence?.tracked === true;

  const completedSources = [aComplete, bComplete, cHasData, mTracked].filter(Boolean).length;

  // Quality score: 60 pts for signal completeness + 40 pts for source availability
  const signalScore  = ((signalFields.length + 2 - missingFields.length) / (signalFields.length + 2)) * 60;
  const sourceScore  = (completedSources / 4) * 40;
  const qualityScore = Math.round(signalScore + sourceScore);

  return {
    complete:         missingFields.length === 0 && completedSources >= 2,
    score:            qualityScore,
    missingFields,
    sourcesReady:     { A: aComplete, B: bComplete, C: cHasData, M: mTracked },
    completedSources,
  };
}

/** Compute the entry meta score (0–100) from A/B/C outputs + strategy + conflicts. */
function _entryMetaScore(engineA, engineB, engineC, strategies, conflicts) {
  let score = 0;

  // A: entry quality contribution (0–30)
  const aScore = typeof engineA?.score === "number" ? Math.min(engineA.score, 100) : 0;
  score += (aScore / 100) * 30;

  // B: regime contribution (0–25, can be negative)
  const regime = engineB?.marketState;
  if      (regime === "TRENDING")  score += engineB?.confidence === "HIGH" ? 25 : 18;
  else if (regime === "RANGING")   score += 0;
  else if (regime === "NOISE")     score += 2;
  else if (regime === "VOLATILE" || regime === "DEAD") score -= 15;
  else                             score += 5;   // UNKNOWN — neutral

  // C: KNN confirmation contribution (0–25)
  const cWR      = engineC?.historicalWinrate ?? null;
  const cDataset = engineC?.datasetSize ?? 0;
  if (cWR !== null && cDataset >= 3) {
    score += (cWR / 100) * 25;
  } else {
    score += 8;  // neutral — not enough data to penalise
  }

  // Strategy edge contribution (0–15)
  if (strategies.length > 0) {
    score += (strategies[0].edgeScore / 100) * 15;
  } else {
    score += 4;
  }

  // Conflict penalties
  for (const c of conflicts) {
    if      (c.severity === "CRITICAL") score -= 25;
    else if (c.severity === "HIGH")     score -= 12;
    else if (c.severity === "MEDIUM")   score -= 6;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Build reasoning and invalidation strings for an entry decision. */
function _buildEntryReasoning(engineA, engineB, engineC, strategies, conflicts, dataQuality, provenance) {
  const reasoning   = [];
  const invalidation = [];

  // A summary
  if (engineA?.wouldTrade === true)
    reasoning.push(`A (Quality): score=${engineA.score} confidence=${engineA.confidence} → TRADE`);
  else if (engineA?.wouldTrade === false)
    reasoning.push(`A (Quality): score=${engineA.score} → NO_TRADE (${engineA.reason})`);
  else
    reasoning.push(`A (Quality): ABSTAIN — ${engineA?.reason || "insufficient_evidence"}`);

  // B summary
  if (engineB?.marketState)
    reasoning.push(`B (Regime): ${engineB.marketState} confidence=${engineB.confidence} — ${engineB.reason}`);
  else
    reasoning.push("B (Regime): state=UNKNOWN");

  // C summary
  if ((engineC?.datasetSize ?? 0) > 0)
    reasoning.push(`C (KNN): ${engineC.kNeighbours}/${engineC.datasetSize} neighbours, WR=${engineC.historicalWinrate}%, exp=${engineC.historicalExpectancy}p`);
  else
    reasoning.push("C (KNN): no historical pairs — abstaining");

  // Strategy
  if (strategies.length > 0)
    reasoning.push(`Strategy: ${strategies.map(s => s.label).join(", ")} (edge=${strategies[0].edgeScore})`);
  else
    reasoning.push("Strategy: no known pattern matched for current conditions");

  // Conflicts
  for (const c of conflicts)
    reasoning.push(`⚠ ${c.severity}[${c.type}]: ${c.desc}`);

  // Data quality
  if (dataQuality.missingFields.length > 0)
    reasoning.push(`DataQuality: missing ${dataQuality.missingFields.join(", ")}`);

  // Provenance flags
  if (provenance.flags.length > 0)
    reasoning.push(`Provenance: ${provenance.tier} — flags: ${provenance.flags.join(", ")}`);

  // Invalidation conditions from matched strategy
  if (strategies.length > 0) {
    for (const inv of strategies[0].invalidation || [])
      invalidation.push(inv);
  }
  if (engineB?.marketState === "RANGING")
    invalidation.push("regime_ranging_invalidates_trend_entry");
  if (engineB?.marketState === "VOLATILE")
    invalidation.push("regime_volatile_risk_too_high");

  return { reasoning, invalidation };
}

// ══════════════════════════════════════════════════════════════════════════════
// DOUBLE-CHECK — two independent questions before confirming HOLD or EXIT
// ══════════════════════════════════════════════════════════════════════════════
function _doubleCheck({ action, engineA, engineB, pips, mfe, minutesOpen, retentionPct, conflicts }) {
  // Only applies to HOLD-family and EXIT
  if (!["HOLD", "HOLD_WITH_CAUTION", "EXIT"].includes(action))
    return { performed: false, reason: "double_check_not_applicable_for_" + action };

  const regime = engineB?.marketState;

  // Question A: Does the primary edge still exist?
  // Edge exists = A would trade AND regime is not hostile
  const edgeStillExists =
    (engineA?.wouldTrade === true || (typeof engineA?.score === "number" && engineA.score >= 60)) &&
    !["VOLATILE", "DEAD"].includes(regime);
  const checkA = {
    question: "Does the primary edge still exist?",
    verdict:   edgeStillExists,
    evidence:  `A.wouldTrade=${engineA?.wouldTrade ?? "n/a"}, A.score=${engineA?.score ?? "n/a"}, regime=${regime ?? "n/a"}`,
  };

  // Question B: Is holding worth the risk given current profit retention?
  // Worth the risk = retaining >= 40% of MFE, positive pips, no critical conflicts
  const criticalConflicts = conflicts.filter(c => c.severity === "CRITICAL").length;
  const holdingWorthRisk =
    retentionPct === null                     ? true   // no MFE data — neutral
    : retentionPct >= 40 && pips >= 0 && criticalConflicts === 0;
  const checkB = {
    question: "Is holding worth the risk given current profit retention?",
    verdict:   holdingWorthRisk,
    evidence:  `retention=${retentionPct !== null ? retentionPct.toFixed(0) + "%" : "n/a"}, pips=${pips.toFixed(1)}, criticalConflicts=${criticalConflicts}`,
  };

  // Override resolution
  let overrideAction     = null;
  let overrideReason     = null;
  let overrideConfidence = null;

  if (action === "HOLD" || action === "HOLD_WITH_CAUTION") {
    if (!edgeStillExists && !holdingWorthRisk) {
      overrideAction     = "PROTECT";
      overrideReason     = "double_check_failed_both_A_and_B";
      overrideConfidence = "MEDIUM";
    } else if (!edgeStillExists) {
      overrideAction     = "HOLD_WITH_CAUTION";
      overrideReason     = "double_check_A_failed_edge_unclear";
      overrideConfidence = "MEDIUM";
    }
    // B failure alone: downgrade HOLD → HOLD_WITH_CAUTION
    else if (!holdingWorthRisk && action === "HOLD") {
      overrideAction     = "HOLD_WITH_CAUTION";
      overrideReason     = "double_check_B_failed_retention_low";
      overrideConfidence = "MEDIUM";
    }
  } else if (action === "EXIT") {
    // If A+B both suggest staying AND we still have profit, soften EXIT → PROTECT
    if (edgeStillExists && holdingWorthRisk && pips > 0) {
      overrideAction     = "PROTECT";
      overrideReason     = "double_check_A_B_pass_exit_softened_to_protect";
      overrideConfidence = "MEDIUM";
    }
  }

  return {
    performed:          true,
    checkA,
    checkB,
    overrideAction,
    overrideReason,
    overrideConfidence,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CLASS  — ShadowDMetaManager
// ══════════════════════════════════════════════════════════════════════════════
class ShadowDMetaManager {
  static SCHEMA_VERSION   = SCHEMA_VERSION;
  static PROVENANCE       = PROVENANCE;
  static ENTRY_ACTIONS    = ENTRY_ACTIONS;
  static POSITION_ACTIONS = POSITION_ACTIONS;
  static STRATEGY_KNOWLEDGE = STRATEGY_KNOWLEDGE;

  // ──────────────────────────────────────────────────────────────────────────
  // PRE-TRADE ENTRY ANALYSIS
  //
  // Called synchronously from shadowGate() immediately after A/B/C evaluate.
  // Returns a structured entry suggestion for the advisory output.
  //
  // Inputs:
  //   signal   — the raw signal object (spread, atrPips, conditionMap, etc.)
  //   engineA  — ShadowQualityEngine.evaluate() result
  //   engineB  — ShadowContextEngine.evaluate() result
  //   engineC  — ShadowKNNEngine.evaluate() result
  //   shadowM  — shadowM.getAdvisory() result, or null if not available
  //   knowledge — knowledge evidence object, or null
  // ──────────────────────────────────────────────────────────────────────────
  static analyzeEntry(opts = {}) {
    const { signal = {}, engineA = {}, engineB = {}, engineC = {}, shadowM = null, knowledge = null } = (opts || {});
    try {
      const dataQuality = _assessDataQuality(signal, engineA, engineB, engineC, shadowM);
      const provenance  = _assessProvenance(engineC, shadowM);
      const strategies  = _matchStrategies(signal, engineA);
      const conflicts   = _detectConflicts(engineA, engineB, engineC, shadowM);
      const metaScore   = _entryMetaScore(engineA, engineB, engineC, strategies, conflicts);
      const { reasoning, invalidation } = _buildEntryReasoning(engineA, engineB, engineC, strategies, conflicts, dataQuality, provenance);

      // ── Action decision ─────────────────────────────────────────────────
      let action, confidence;

      if (!dataQuality.complete || dataQuality.score < 40) {
        // Insufficient signal data to reason safely
        action     = "INSUFFICIENT_DATA";
        confidence = "NONE";
        reasoning.push(`Decision: INSUFFICIENT_DATA — qualityScore=${dataQuality.score} complete=${dataQuality.complete}`);
      } else if (conflicts.some(c => c.severity === "CRITICAL")) {
        // Critical conflicts always veto entry
        action     = "REJECT";
        confidence = "HIGH";
        reasoning.push("Decision: REJECT — critical conflict or unsafe regime detected");
      } else if (metaScore < 35) {
        action     = "REJECT";
        confidence = metaScore < 15 ? "HIGH" : "MEDIUM";
        reasoning.push(`Decision: REJECT — metaScore=${metaScore} below 35`);
      } else if (metaScore < 55 || conflicts.some(c => c.severity === "HIGH")) {
        action     = "WAIT";
        confidence = metaScore < 45 ? "MEDIUM" : "LOW";
        reasoning.push(`Decision: WAIT — metaScore=${metaScore} or HIGH conflict present`);
      } else {
        action     = "ENTER";
        confidence = metaScore >= 78 ? "HIGH" : "MEDIUM";
        reasoning.push(`Decision: ENTER — metaScore=${metaScore}`);
      }

      // ── Edge / Risk status ──────────────────────────────────────────────
      const edgeStatus =
        metaScore >= 75 ? "STRONG"   :
        metaScore >= 58 ? "MODERATE" :
        metaScore >= 38 ? "WEAK"     :
        metaScore >= 18 ? "NEGATIVE" : "UNKNOWN";

      const riskStatus =
        conflicts.some(c => c.severity === "CRITICAL") ? "CRITICAL" :
        conflicts.some(c => c.severity === "HIGH")     ? "HIGH"     :
        conflicts.length > 0                            ? "ELEVATED" : "NORMAL";

      // ── Knowledge context note ──────────────────────────────────────────
      let knowledgeNote = null;
      if (knowledge) {
        const kAvail = knowledge.available === true && Number(knowledge.matchCount) > 0;
        knowledgeNote = kAvail
          ? `Knowledge: ${knowledge.matchCount} resolved matches available`
          : "Knowledge: unavailable or below minimum resolved trades";
      }

      return {
        schemaVersion:   SCHEMA_VERSION,
        action,
        confidence,
        metaScore,
        entryQuality: {
          score:      engineA?.score      ?? null,
          tier:       engineA?.confidence ?? null,
          wouldTrade: engineA?.wouldTrade ?? null,
          reason:     engineA?.reason     ?? null,
        },
        regimeQuality: {
          state:      engineB?.marketState ?? null,
          tier:       engineB?.confidence  ?? null,
          wouldTrade: engineB?.wouldTrade  ?? null,
        },
        confirmation: {
          winrate:     engineC?.historicalWinrate    ?? null,
          expectancy:  engineC?.historicalExpectancy ?? null,
          neighbours:  engineC?.kNeighbours          ?? 0,
          datasetSize: engineC?.datasetSize           ?? 0,
        },
        tradeBehaviour: shadowM
          ? { action: shadowM.action || "HOLD", evidence: shadowM.evidence || {} }
          : null,
        strategyContext: {
          matchedPatterns: strategies.map(s => s.key),
          primaryPattern:  strategies[0]?.key      ?? null,
          edgeScore:       strategies[0]?.edgeScore ?? null,
          holdBias:        strategies[0]?.holdBias  ?? null,
          exitBias:        strategies[0]?.exitBias  ?? null,
        },
        edgeStatus,
        riskStatus,
        conflicts,
        reasoning,
        invalidation,
        dataQuality,
        provenance,
        knowledgeNote,
        advisoryOnly:       true,
        authoritativeLayer: "live_bot",
        generatedAt:        new Date().toISOString(),
      };
    } catch (err) {
      return {
        schemaVersion:      SCHEMA_VERSION,
        action:             "INSUFFICIENT_DATA",
        confidence:         "NONE",
        metaScore:          0,
        error:              err.message,
        advisoryOnly:       true,
        authoritativeLayer: "live_bot",
        generatedAt:        new Date().toISOString(),
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST-ENTRY POSITION ANALYSIS
  //
  // Called from /api/cooperative/advisory after shadowM.getAdvisory().
  // Uses current position state + shadow M + optional stored engine evaluations.
  //
  // Inputs:
  //   signal   — { signalId, symbol, session, side }
  //   engineA  — stored A evaluation for this signalId (or {})
  //   engineB  — stored B evaluation or ad-hoc one (or {})
  //   engineC  — stored C evaluation for this signalId (or {})
  //   shadowM  — shadowM.getAdvisory() result
  //   position — { pips, mfe, mae, minutesOpen, tradeId, liveAction }
  // ──────────────────────────────────────────────────────────────────────────
  static analyzePosition(opts = {}) {
    const { signal = {}, engineA = {}, engineB = {}, engineC = {}, shadowM = null, position = {} } = (opts || {});
    try {
      const pips        = typeof position.pips        === "number" ? position.pips        : 0;
      const mfe         = typeof position.mfe         === "number" ? position.mfe         : 0;
      const mae         = typeof position.mae         === "number" ? position.mae         : 0;
      const minutesOpen = typeof position.minutesOpen === "number" ? position.minutesOpen : 0;
      const liveAction  = String(position.liveAction || "HOLD");

      const reasoning = [];
      const regime    = engineB?.marketState ?? null;
      const conflicts = _detectConflicts(engineA, engineB, engineC, shadowM);
      const strategies = _matchStrategies(signal, engineA);
      const provenance = _assessProvenance(engineC, shadowM);

      // ── Profit retention ────────────────────────────────────────────────
      const retentionPct = mfe > 0.5 ? (pips / mfe) * 100 : null;

      // ── MFE:MAE ratio ───────────────────────────────────────────────────
      const mfeMaeRatio = Math.abs(mae) > 0 ? mfe / Math.abs(mae) : null;

      // ── Build reasoning ─────────────────────────────────────────────────
      if (regime)
        reasoning.push(`B (Regime): ${regime} (${engineB?.confidence ?? "NONE"})`);
      else
        reasoning.push("B (Regime): not available");

      if (retentionPct !== null)
        reasoning.push(`Profit retention: ${retentionPct.toFixed(0)}% of MFE (MFE=${mfe.toFixed(1)}p current=${pips.toFixed(1)}p)`);

      if (mfeMaeRatio !== null)
        reasoning.push(`MFE:MAE ratio: ${mfeMaeRatio.toFixed(2)}`);

      reasoning.push(`Position: ${minutesOpen.toFixed(0)} min open, liveAction=${liveAction}`);

      const triggeredStrats = shadowM?.evidence?.triggeredStrategies || [];
      if (triggeredStrats.length > 0)
        reasoning.push(`Shadow M triggered: ${triggeredStrats.map(s => s.name).join(", ")}`);

      if (shadowM?.action && shadowM.action !== "HOLD")
        reasoning.push(`Shadow M suggestion: ${shadowM.action}`);

      for (const c of conflicts)
        reasoning.push(`⚠ ${c.severity}[${c.type}]: ${c.desc}`);

      // ── Primary action decision ─────────────────────────────────────────
      let action, confidence;

      if (regime === "VOLATILE" || regime === "DEAD") {
        action     = "EXIT";
        confidence = "HIGH";
        reasoning.push(`Decision: EXIT — regime=${regime} makes continued holding unsafe`);
      } else if (shadowM?.action === "REQUEST_CLOSE") {
        action     = "EXIT";
        confidence = "MEDIUM";
        reasoning.push("Decision: EXIT — Shadow M strategies recommend close");
      } else if (retentionPct !== null && retentionPct < 45 && mfe >= 4.0) {
        action     = "PROTECT";
        confidence = "MEDIUM";
        reasoning.push(`Decision: PROTECT — giving back >${(100 - retentionPct).toFixed(0)}% of MFE with MFE>=4p`);
      } else if (regime === "RANGING" && pips >= 2.5) {
        action     = "PROTECT";
        confidence = "MEDIUM";
        reasoning.push("Decision: PROTECT — ranging regime with profit available, protect before mean reversion");
      } else if (conflicts.some(c => c.severity === "HIGH") && pips > 0) {
        action     = "HOLD_WITH_CAUTION";
        confidence = "MEDIUM";
        reasoning.push("Decision: HOLD_WITH_CAUTION — HIGH conflict with positive P&L");
      } else if (shadowM?.action === "MOVE_SL" || shadowM?.action === "MOVE_BE") {
        action     = "HOLD_WITH_CAUTION";
        confidence = "LOW";
        reasoning.push(`Decision: HOLD_WITH_CAUTION — Shadow M advises ${shadowM.action}`);
      } else if (regime === "TRENDING" && retentionPct !== null && retentionPct >= 55) {
        action     = "HOLD";
        confidence = "MEDIUM";
        reasoning.push("Decision: HOLD — trending regime with ≥55% retention");
      } else {
        action     = "HOLD";
        confidence = "LOW";
        reasoning.push(`Decision: HOLD — no clear exit signal (liveAction=${liveAction})`);
      }

      // ── Double-check ─────────────────────────────────────────────────────
      const doubleCheck = _doubleCheck({
        action, engineA, engineB, pips, mfe, minutesOpen, retentionPct, conflicts,
      });

      if (doubleCheck.overrideAction) {
        reasoning.push(`Double-check: ${action} → ${doubleCheck.overrideAction} (${doubleCheck.overrideReason})`);
        action     = doubleCheck.overrideAction;
        confidence = doubleCheck.overrideConfidence || confidence;
      }

      return {
        schemaVersion:  SCHEMA_VERSION,
        action,
        confidence,
        position: {
          pips,
          mfe,
          mae,
          minutesOpen,
          retentionPct: retentionPct !== null ? parseFloat(retentionPct.toFixed(1)) : null,
          mfeMaeRatio:  mfeMaeRatio  !== null ? parseFloat(mfeMaeRatio.toFixed(2))  : null,
        },
        regimeQuality: {
          state: regime                    ?? null,
          tier:  engineB?.confidence       ?? null,
        },
        tradeBehaviour: shadowM ? {
          action:             shadowM.action              || "HOLD",
          triggeredStrategies: triggeredStrats,
          evidence:           shadowM.evidence            || {},
        } : null,
        strategyContext: {
          primaryPattern: strategies[0]?.key      ?? null,
          holdBias:       strategies[0]?.holdBias  ?? null,
          exitBias:       strategies[0]?.exitBias  ?? null,
        },
        conflicts,
        doubleCheck,
        reasoning,
        provenance,
        advisoryOnly:       true,
        authoritativeLayer: "live_bot",
        generatedAt:        new Date().toISOString(),
      };
    } catch (err) {
      return {
        schemaVersion:      SCHEMA_VERSION,
        action:             "HOLD",
        confidence:         "NONE",
        error:              err.message,
        advisoryOnly:       true,
        authoritativeLayer: "live_bot",
        generatedAt:        new Date().toISOString(),
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TELEMETRY HELPERS (fire-and-forget — never awaited by callers)
  // ──────────────────────────────────────────────────────────────────────────

  /** Log a pre-trade meta decision. */
  static logEntryDecision(signal, result) {
    try {
      _getLogEvent()({
        type:               "lab_shadow_d_meta_entry",
        schemaVersion:      result.schemaVersion,
        signalId:           signal.signalId    || null,
        symbol:             signal.symbol       || null,
        session:            signal.session      || null,
        side:               signal.side         || null,
        action:             result.action,
        confidence:         result.confidence,
        metaScore:          result.metaScore,
        edgeStatus:         result.edgeStatus,
        riskStatus:         result.riskStatus,
        primaryPattern:     result.strategyContext?.primaryPattern     ?? null,
        conflictCount:      result.conflicts?.length                    ?? 0,
        provenanceTier:     result.provenance?.tier                    || null,
        dataQualityScore:   result.dataQuality?.score                  ?? null,
        dataComplete:       result.dataQuality?.complete               ?? null,
        advisoryOnly:       true,
        authoritativeLayer: "live_bot",
      });
    } catch (_) {}
  }

  /** Log a post-entry position management decision. */
  static logPositionDecision(signal, position, result) {
    try {
      _getLogEvent()({
        type:                 "lab_shadow_d_meta_position",
        schemaVersion:        result.schemaVersion,
        signalId:             signal.signalId   || null,
        symbol:               signal.symbol     || null,
        session:              signal.session    || null,
        side:                 signal.side       || null,
        tradeId:              position.tradeId  || null,
        action:               result.action,
        confidence:           result.confidence,
        pips:                 result.position?.pips         ?? null,
        mfe:                  result.position?.mfe          ?? null,
        mae:                  result.position?.mae          ?? null,
        retentionPct:         result.position?.retentionPct ?? null,
        minutesOpen:          result.position?.minutesOpen  ?? null,
        regime:               result.regimeQuality?.state   || null,
        conflictCount:        result.conflicts?.length        ?? 0,
        doubleCheckPerformed: result.doubleCheck?.performed   ?? false,
        doubleCheckOverride:  result.doubleCheck?.overrideAction ?? null,
        advisoryOnly:         true,
        authoritativeLayer:   "live_bot",
      });
    } catch (_) {}
  }

  /** Convenience: run analyzeEntry + fire-and-forget telemetry in one call. */
  static analyzeAndLogEntry(opts = {}) {
    const result = this.analyzeEntry(opts);
    this.logEntryDecision(opts.signal || {}, result);
    return result;
  }

  /** Convenience: run analyzePosition + fire-and-forget telemetry in one call. */
  static analyzeAndLogPosition(opts = {}) {
    const result = this.analyzePosition(opts);
    this.logPositionDecision(opts.signal || {}, opts.position || {}, result);
    return result;
  }
}

module.exports = {
  ShadowDMetaManager,
  STRATEGY_KNOWLEDGE,
  PROVENANCE,
  ENTRY_ACTIONS,
  POSITION_ACTIONS,
  SCHEMA_VERSION,
};
