"use strict";
/**
 * SNOWBALL LAB — Shadow Engine Framework v1
 *
 * Processes every trade_open event through 3 independent virtual engines.
 *
 * STRICT RULES:
 *   - NEVER opens or closes real trades
 *   - NEVER touches index.js
 *   - NEVER affects live bot logic, risk, execution, or state
 *   - Read-only access to existing trade events (trade_open, trade_close)
 *   - Writes only: lab_shadow_a, lab_shadow_b, lab_shadow_c, lab_comparison
 *
 * Data flow:
 *   trade_open (from live bot)
 *     → ShadowQualityEngine   → lab_shadow_a
 *     → ShadowContextEngine   → lab_shadow_b
 *     → ShadowStatisticalEngine → lab_shadow_c
 *     → ComparisonEngine      → lab_comparison
 */

const { logEvent, db } = require("./index");

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW ENGINE A — Quality Score (0–100)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Evaluates signal quality using weighted condition scoring plus market bonuses.
 *
 * Condition weights (sum = 100):
 *   M5 trend       = 15  (most important — directional conviction)
 *   M5 close       = 12  (price above/below EMA)
 *   M5 candle      = 10  (candle direction)
 *   EMA distance   = 12  (momentum gap)
 *   M5 strength    = 12  (candle body size)
 *   M1 trend       = 10  (short-term alignment)
 *   M1 candle      =  9  (current M1 candle)
 *   M1 prev        =  9  (previous M1 candle)
 *   M1 close       = 11  (M1 price above/below EMA9)
 *
 * Market bonuses (up to ±20): EMA distance, candle strength, ATR, gate type, spread penalty
 * wouldTrade threshold: score >= 65
 */
const WEIGHTS_A = {
  trend:    15,
  m5close:  12,
  candle:   10,
  ema:      12,
  strength: 12,
  m1trend:  10,
  m1candle:  9,
  m1prev:    9,
  m1close:  11,
};
const WEIGHT_TOTAL = Object.values(WEIGHTS_A).reduce((s, v) => s + v, 0); // 100

class ShadowQualityEngine {
  static ID = "ENGINE_A_QUALITY";

  static evaluate(signal) {
    const {
      conditionMap = {}, entryGate = "HARD",
      spread = 0, atrPips = 0, emaDistance = 0, candleStrength = 0,
    } = signal;

    // Base condition score (0–80)
    let condScore = 0;
    for (const [k, w] of Object.entries(WEIGHTS_A)) {
      if (conditionMap[k]) condScore += w;
    }
    const condPct  = WEIGHT_TOTAL > 0 ? condScore / WEIGHT_TOTAL : 0;
    let   score    = condPct * 80;

    // Market quality adjustments (±20)
    if (emaDistance >= 3.5)      score += 8;
    else if (emaDistance >= 2.0) score += 4;
    if (candleStrength >= 0.20)  score += 5;
    else if (candleStrength >= 0.10) score += 2;
    if (atrPips >= 6.0)          score += 4;
    if (entryGate === "HARD")    score += 5;
    if (spread > 0) {
      const pen = Math.min((spread / 2.0), 1.5) * 8; // up to -12 for spread>2.0
      score -= pen;
    }

    score = Math.max(0, Math.min(100, score));
    const scoreRnd = parseFloat(score.toFixed(1));
    const wouldTrade = scoreRnd >= 65;
    const confidence = scoreRnd >= 80 ? "HIGH" : scoreRnd >= 65 ? "MEDIUM" : "LOW";

    const reasons = [];
    if (!conditionMap.trend)    reasons.push("no_m5trend");
    if (!conditionMap.ema)      reasons.push("weak_ema");
    if (!conditionMap.m1trend)  reasons.push("no_m1trend");
    if (!conditionMap.strength) reasons.push("no_m5strength");
    if (spread > 1.5)           reasons.push(`spread_${spread.toFixed(2)}`);
    if (emaDistance < 1.5)      reasons.push(`ema_dist_${emaDistance.toFixed(1)}`);
    if (reasons.length === 0)   reasons.push("all_conditions");

    return {
      engineId:       this.ID,
      score:          scoreRnd,
      condScore:      parseFloat((condPct * 100).toFixed(1)),
      confidence,
      wouldTrade,
      reason:         reasons.join("|"),
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW ENGINE B — Market Context
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Classifies the market environment at time of signal.
 *
 * States:
 *   TRENDING  — strong directional move; ideal for this strategy
 *   RANGING   — price stuck in band; avoid
 *   VOLATILE  — extreme ATR; risk too high
 *   NOISE     — weak structure; low signal reliability
 *   DEAD      — no activity (off-hours or holiday)
 *
 * wouldTrade: only in TRENDING state
 */
class ShadowContextEngine {
  static ID = "ENGINE_B_CONTEXT";

  static evaluate(signal) {
    const {
      atrPips = 0, emaDistance = 0, candleStrength = 0, spread = 0, session,
    } = signal;

    let marketState, confidence, wouldTrade, reason;

    if (atrPips < 2.5 || (emaDistance < 0.5 && atrPips < 4.0)) {
      marketState = "DEAD";
      confidence  = "HIGH";
      wouldTrade  = false;
      reason      = `atr=${atrPips.toFixed(1)}p_ema=${emaDistance.toFixed(1)}p_no_activity`;

    } else if (atrPips > 14.0) {
      marketState = "VOLATILE";
      confidence  = "HIGH";
      wouldTrade  = false;
      reason      = `atr=${atrPips.toFixed(1)}p_extreme_volatility`;

    } else if (spread > 0 && atrPips > 0 && (spread / atrPips) > 0.35) {
      // spread:ATR ratio > 35 % — noise eats too much of the range
      marketState = "NOISE";
      confidence  = "MEDIUM";
      wouldTrade  = false;
      reason      = `spread_atr_ratio=${(spread / atrPips).toFixed(2)}_too_high`;

    } else if (emaDistance >= 2.0 && candleStrength >= 0.07 && atrPips >= 4.0) {
      marketState = "TRENDING";
      confidence  = (emaDistance >= 3.5 && candleStrength >= 0.15) ? "HIGH" : "MEDIUM";
      wouldTrade  = true;
      reason      = `ema=${emaDistance.toFixed(1)}p_str=${candleStrength.toFixed(2)}_atr=${atrPips.toFixed(1)}p`;

    } else if (emaDistance < 1.8 && atrPips >= 3.0 && atrPips < 14.0) {
      marketState = "RANGING";
      confidence  = "MEDIUM";
      wouldTrade  = false;
      reason      = `ema_dist=${emaDistance.toFixed(1)}p_low_ranging`;

    } else {
      marketState = "NOISE";
      confidence  = "LOW";
      wouldTrade  = false;
      reason      = `mixed_str=${candleStrength.toFixed(2)}_ema=${emaDistance.toFixed(1)}`;
    }

    return {
      engineId:    this.ID,
      marketState,
      confidence,
      wouldTrade,
      reason,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW ENGINE C — Statistical Memory
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Uses historical trade outcomes to make decisions.
 *
 * Primary key:   fingerprint (exact market fingerprint)
 * Fallback key:  passCount   (condition count pattern)
 * Min samples:   5 (fingerprint), 10 (pattern)
 *
 * wouldTrade: historicalWinrate >= 52 % AND historicalExpectancy > 0
 * Abstains (wouldTrade=null) when insufficient data
 */
class ShadowStatisticalEngine {
  static ID       = "ENGINE_C_STATS";
  static MIN_FP   = 5;
  static MIN_COND = 10;

  static evaluate(signal) {
    const { fingerprint, conditionMap = {} } = signal;
    const passCount = Object.values(conditionMap).filter(Boolean).length;

    // Query historical closes once (limit 3000 most recent)
    let allCloses = [];
    try {
      allCloses = db.prepare(
        "SELECT data FROM events WHERE type='trade_close' ORDER BY id DESC LIMIT 3000"
      ).all().map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { allCloses = []; }

    // ── Fingerprint lookup ────────────────────────────────────────────────
    const fpCloses = fingerprint
      ? allCloses.filter(d => d.fingerprint === fingerprint)
      : [];

    let fpWinrate = null, fpExpectancy = null;
    if (fpCloses.length >= this.MIN_FP) {
      const wins = fpCloses.filter(d => (d.profitPips || 0) > 1.0).length;
      fpWinrate    = parseFloat(((wins / fpCloses.length) * 100).toFixed(1));
      fpExpectancy = parseFloat((fpCloses.reduce((s, d) => s + (d.profitPips || 0), 0) / fpCloses.length).toFixed(2));
    }

    // ── Condition-pattern lookup ──────────────────────────────────────────
    const cpCloses = allCloses.filter(d => (d.passCount || 0) === passCount);

    let cpWinrate = null, cpExpectancy = null;
    if (cpCloses.length >= this.MIN_COND) {
      const wins = cpCloses.filter(d => (d.profitPips || 0) > 1.0).length;
      cpWinrate    = parseFloat(((wins / cpCloses.length) * 100).toFixed(1));
      cpExpectancy = parseFloat((cpCloses.reduce((s, d) => s + (d.profitPips || 0), 0) / cpCloses.length).toFixed(2));
    }

    // ── Decision ─────────────────────────────────────────────────────────
    let wouldTrade, confidence, reason, historicalWinrate, historicalExpectancy;

    if (fpCloses.length >= this.MIN_FP) {
      historicalWinrate    = fpWinrate;
      historicalExpectancy = fpExpectancy;
      wouldTrade  = fpWinrate >= 52 && fpExpectancy > 0;
      confidence  = fpCloses.length >= 15 ? "HIGH" : "MEDIUM";
      reason      = `fp_wr=${fpWinrate}%_exp=${fpExpectancy}p_n=${fpCloses.length}`;
    } else if (cpCloses.length >= this.MIN_COND) {
      historicalWinrate    = cpWinrate;
      historicalExpectancy = cpExpectancy;
      wouldTrade  = cpWinrate >= 52 && cpExpectancy > 0;
      confidence  = "LOW";
      reason      = `cond_wr=${cpWinrate}%_exp=${cpExpectancy}p_n=${cpCloses.length}_no_fp_data`;
    } else {
      wouldTrade  = null; // abstain — not enough data
      confidence  = "NONE";
      historicalWinrate    = null;
      historicalExpectancy = null;
      reason      = `insufficient_data_fp_n=${fpCloses.length}_cond_n=${cpCloses.length}`;
    }

    return {
      engineId:             this.ID,
      wouldTrade,
      confidence,
      reason,
      historicalWinrate,
      historicalExpectancy,
      fpSamples:            fpCloses.length,
      cpSamples:            cpCloses.length,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPARISON ENGINE
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Aggregates all engine decisions vs the live bot's decision.
 * The live bot always decided "wouldTrade=true" for trade_open events.
 */
class ComparisonEngine {
  static compare(engineA, engineB, engineC) {
    // Live bot: always traded (this is a trade_open event)
    const liveDecision = true;

    const engines = [
      { id: "A", decision: engineA.wouldTrade },
      { id: "B", decision: engineB.wouldTrade },
      { id: "C", decision: engineC.wouldTrade },
    ];

    const decided   = engines.filter(e => e.decision !== null);
    const agreeWith = decided.filter(e => e.decision === liveDecision);
    const disagreeWith = decided.filter(e => e.decision !== liveDecision);

    const agreementPct    = decided.length > 0
      ? parseFloat(((agreeWith.length / decided.length) * 100).toFixed(1)) : null;
    const disagreementPct = decided.length > 0
      ? parseFloat(((disagreeWith.length / decided.length) * 100).toFixed(1)) : null;

    const allAgree      = decided.length > 0 && disagreeWith.length === 0;
    const majorityAgree = agreeWith.length > disagreeWith.length;

    // Unanimous abstain from live = "caution flag"
    const cautionFlag = disagreeWith.length >= 2;

    return {
      liveDecision,
      engineADecision:   engineA.wouldTrade,
      engineBDecision:   engineB.wouldTrade,
      engineCDecision:   engineC.wouldTrade,
      engineAScore:      engineA.score  ?? null,
      engineAConfidence: engineA.confidence ?? null,
      engineBState:      engineB.marketState ?? null,
      engineBConfidence: engineB.confidence ?? null,
      engineCWinrate:    engineC.historicalWinrate ?? null,
      engineCConfidence: engineC.confidence ?? null,
      agreementPct,
      disagreementPct,
      decidedEngines:    decided.length,
      agreeCount:        agreeWith.length,
      disagreeCount:     disagreeWith.length,
      allAgree,
      majorityAgree,
      cautionFlag,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOWLAB ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════
class ShadowLab {
  constructor() {
    this._processedIds = new Set();
    this._initialized  = false;
  }

  // ── Initialization — load already-processed signalIds ───────────────────
  _init() {
    try {
      const rows = db.prepare(
        "SELECT data FROM events WHERE type='lab_comparison' ORDER BY id DESC LIMIT 10000"
      ).all();
      for (const r of rows) {
        try {
          const d = JSON.parse(r.data);
          if (d.signalId) this._processedIds.add(d.signalId);
        } catch (_) {}
      }
    } catch (_) {}
    this._initialized = true;
    console.log(`[SHADOWLAB] Init — already processed: ${this._processedIds.size} signal(s)`);
  }

  // ── Main processing cycle ───────────────────────────────────────────────
  _cycle() {
    if (!this._initialized) this._init();

    let opens;
    try {
      opens = db.prepare(
        "SELECT id,ts,symbol,data FROM events WHERE type='trade_open' ORDER BY id DESC LIMIT 500"
      ).all();
    } catch (err) {
      console.error("[SHADOWLAB] DB read error:", err.message);
      return;
    }

    let processed = 0;
    for (const row of opens) {
      let signal;
      try { signal = JSON.parse(row.data); } catch (_) { continue; }

      const signalId = signal.signalId;
      if (!signalId || this._processedIds.has(signalId)) continue;
      if (processed >= 20) break; // throttle: max 20 per cycle

      try {
        this._processSignal(signal, row.ts, row.symbol);
        this._processedIds.add(signalId);
        processed++;
      } catch (err) {
        console.error(`[SHADOWLAB] Signal error ${signalId}:`, err.message);
      }
    }

    if (processed > 0) {
      console.log(`[SHADOWLAB] Processed ${processed} new signal(s). Total: ${this._processedIds.size}`);
    }
  }

  // ── Process a single trade_open event through all engines ───────────────
  _processSignal(signal, ts, symbolRaw) {
    const {
      signalId, symbol = symbolRaw, session, side, fingerprint,
      spread = 0, atrPips = 0, emaDistance = 0, candleStrength = 0,
      entryGate = "HARD", passCount = 0, conditionMap = {},
      trendBucket, volatilityBucket, spreadBucket,
    } = signal;

    const evalPayload = {
      signalId, symbol, session, side, fingerprint,
      spread, atrPips, emaDistance, candleStrength,
      entryGate, passCount, conditionMap,
      trendBucket, volatilityBucket, spreadBucket,
    };

    // Run all three engines
    const engineA = ShadowQualityEngine.evaluate(evalPayload);
    const engineB = ShadowContextEngine.evaluate(evalPayload);
    const engineC = ShadowStatisticalEngine.evaluate(evalPayload);
    const comp    = ComparisonEngine.compare(engineA, engineB, engineC);

    const base = {
      signalId, symbol, session, side, fingerprint,
      spread, atrPips, emaDistance, candleStrength,
      entryGate, passCount,
      sourceTs: ts,
    };

    // ── Store shadow decisions ───────────────────────────────────────────
    logEvent({ type: "lab_shadow_a", symbol, session, ...base, ...engineA });
    logEvent({ type: "lab_shadow_b", symbol, session, ...base, ...engineB });
    logEvent({ type: "lab_shadow_c", symbol, session, ...base, ...engineC });
    logEvent({ type: "lab_comparison", symbol, session, ...base, ...comp });
  }

  // ── Public start ────────────────────────────────────────────────────────
  start() {
    this._init();
    // First run after 8 s (let server fully boot), then every 30 s
    setTimeout(() => this._cycle(), 8000);
    setInterval(() => this._cycle(), 30000);
    console.log("[SHADOWLAB] Started — polling every 30 s");
  }
}

// ── singleton ─────────────────────────────────────────────────────────────────
const shadowLab = new ShadowLab();

module.exports = {
  shadowLab,
  ShadowQualityEngine,
  ShadowContextEngine,
  ShadowStatisticalEngine,
  ComparisonEngine,
};
