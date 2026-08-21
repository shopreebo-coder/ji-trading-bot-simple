"use strict";
/**
 * SNOWBALL LAB — Shadow Engine Framework v2  (FOREX ENGINE PRO v40)
 *
 * STRICT RULES:
 *   - NEVER opens or closes real trades
 *   - NEVER touches index.js  (live bot is READ ONLY)
 *   - NEVER affects live bot logic, risk, execution, or state
 *   - Read-only on: trade_open, trade_close, lab_shadow_*
 *   - Writes only: lab_shadow_a, lab_shadow_b, lab_shadow_c, lab_shadow_d, lab_comparison,
 *                 and the A/B/C entry advisory lifecycle in the shared events stream
 *
 * Engine status:
 *   A (Quality Score)   — FROZEN  (baseline reference)
 *   B (Market Context)  — FROZEN  (baseline reference)
 *   C (KNN Memory)      — REBUILT (similarity search, replaces exact fingerprint)
 *   D (Meta Engine)     — NEW     (dynamic weighting of A+B+C outputs)
 */

const { logEvent, db } = require("./index");
const { getRuntimeEnabled } = require("./runtime-control");
const { ShadowDMetaManager } = require("./managers/ShadowDMetaManager");

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW ENGINE A — Quality Score (0–100)  ★ FROZEN — DO NOT MODIFY ★
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
const SHADOW_MARKET_FIELDS = ["spread", "atrPips", "emaDistance", "candleStrength"];

function hasCompleteShadowMarketEvidence(signal) {
  return !!signal &&
    SHADOW_MARKET_FIELDS.every((key) =>
      Object.prototype.hasOwnProperty.call(signal, key) &&
      signal[key] !== null &&
      signal[key] !== undefined &&
      signal[key] !== "" &&
      Number.isFinite(Number(signal[key]))
    );
}

function abstainForInsufficientEvidence(engineId, reason, extra = {}) {
  return {
    engineId,
    wouldTrade: null,
    confidence: "NONE",
    reason,
    ...extra,
  };
}

class ShadowQualityEngine {
  static ID = "ENGINE_A_QUALITY";

  static evaluate(signal) {
    if (!hasCompleteShadowMarketEvidence(signal) ||
        !signal.conditionMap ||
        Object.keys(WEIGHTS_A).some((key) => typeof signal.conditionMap[key] !== "boolean")) {
      return abstainForInsufficientEvidence(
        this.ID,
        "insufficient_evidence_missing_market_or_condition_fields",
        { score: null, condScore: null },
      );
    }

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
// SHADOW ENGINE B — Market Context  ★ FROZEN — DO NOT MODIFY ★
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
    if (!hasCompleteShadowMarketEvidence(signal)) {
      return abstainForInsufficientEvidence(
        this.ID,
        "insufficient_evidence_missing_market_fields",
        { marketState: "UNKNOWN" },
      );
    }

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
// SHADOW ENGINE C — KNN Statistical Memory  (REBUILT v40)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Replaces the exact-fingerprint approach with K-Nearest-Neighbours similarity.
 *
 * ROOT CAUSE of v1 100% abstain:
 *   OANDA SL/TP exits never emit trade_close events → zero historical closes
 *   available → exact fingerprint lookup always fails → MIN_FP/MIN_COND never met.
 *
 * New architecture:
 *   1. Build historical dataset by joining trade_open + trade_close on signalId
 *      (with fingerprint-time-window fallback for unlinked closes)
 *   2. Extract 15-dim feature vector from each trade_open event
 *   3. Compute weighted similarity for every historical pair
 *   4. Find K nearest neighbours above MIN_SIM threshold
 *   5. Compute win-rate, expectancy, profit-factor from neighbourhood
 *   6. Decision: TRADE ≥55% WR / SKIP ≤45% / ABSTAIN 45–55% or <MIN_K neighbours
 *
 * Target: Trade 20–40%  |  Skip 20–40%  |  Abstain 20–60%
 *
 * Dataset is cached for CACHE_TTL ms to avoid per-signal DB scans.
 */
class ShadowKNNEngine {
  static ID      = "ENGINE_C_KNN";
  static K       = 10;      // max neighbours to use
  static MIN_SIM = 0.70;    // minimum similarity to include as neighbour
  static MIN_K   = 3;       // minimum neighbours for a non-abstain decision
  static CACHE_TTL = 60000; // rebuild dataset every 60 s

  static _cache   = null;
  static _cacheTs = 0;

  // ── 15-dimensional feature vector ─────────────────────────────────────────
  // Indices 0-8:  binary condition flags (conditionMap)
  // Index  9:     passCount normalised to [0,1]
  // Index  10:    entryGate (HARD=1, RELAXED=0)
  // Indices 11-14: normalised continuous market features
  static _COND_KEYS = ["trend","m5close","candle","ema","strength","m1trend","m1candle","m1prev","m1close"];

  // Per-dimension weights for the similarity function
  // Binary conditions weighted 1.3 each (most discriminating for this strategy)
  // passCount weighted 2.0 (best single proxy for signal quality)
  // entryGate weighted 1.5
  // Continuous features weighted 1.0 each
  static _W = [1.3,1.3,1.3,1.3,1.3,1.3,1.3,1.3,1.3, 2.0, 1.5, 1.0,1.0,1.0,1.0];
  static _W_TOTAL = ShadowKNNEngine._W.reduce((s,v)=>s+v,0);

  static _extract(signal) {
    const { conditionMap = {}, passCount = 0, entryGate = "HARD",
            spread = 0, atrPips = 0, emaDistance = 0, candleStrength = 0 } = signal;
    return [
      ...this._COND_KEYS.map(k => conditionMap[k] ? 1 : 0),
      Math.min(passCount / 9, 1),
      entryGate === "HARD" ? 1 : 0,
      Math.min(Math.max(spread,        0) /  3.0,  1),
      Math.min(Math.max(atrPips,       0) / 15.0,  1),
      Math.min(Math.max(emaDistance,   0) /  5.0,  1),
      Math.min(Math.max(candleStrength,0) /  0.3,  1),
    ];
  }

  // Weighted similarity: 1 = identical, 0 = maximally different
  static _sim(a, b) {
    let num = 0;
    for (let i = 0; i < a.length; i++) num += this._W[i] * (1 - Math.abs(a[i] - b[i]));
    return num / this._W_TOTAL;
  }

  // ── Returns cached dataset synchronously (no DB) — used by shadowGate() ───
  // Cache is populated async by ShadowLab._cycle() → _refreshDatasetAsync().
  // On cold start (before first cycle at +8 s): returns [] → engines abstain.
  static _getDataset() {
    return this._cache || [];
  }

  // ── Async cache rebuild — called from ShadowLab._cycle() only ────────────
  static async _refreshDatasetAsync() {
    let dataset = [];
    try {
      const opens = (await db.all(
        "SELECT data FROM events WHERE type='trade_open' ORDER BY id DESC LIMIT 3000"
      )).map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

      const closes = (await db.all(
        "SELECT data FROM events WHERE type='trade_close' ORDER BY id DESC LIMIT 3000"
      )).map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

      // Primary map: signalId → close
      const bySignal = {};
      // Fallback map: fingerprint → sorted list of closes
      const byFP = {};
      for (const c of closes) {
        if (c.signalId)    bySignal[c.signalId] = c;
        if (c.fingerprint) {
          if (!byFP[c.fingerprint]) byFP[c.fingerprint] = [];
          byFP[c.fingerprint].push(c);
        }
      }

      for (const o of opens) {
        let close = null;

        // 1st: exact signalId match
        if (o.signalId && bySignal[o.signalId]) {
          close = bySignal[o.signalId];
        }
        // 2nd: fingerprint + time-window (close must be within 4 h of open)
        else if (o.fingerprint && byFP[o.fingerprint]?.length) {
          const tOpen = new Date(o.ts || o.timestamp || 0).getTime();
          const cand  = byFP[o.fingerprint]
            .filter(c => {
              const t = new Date(c.ts || c.timestamp || 0).getTime();
              return t >= tOpen && t <= tOpen + 14400000; // 4 h window
            })
            .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
          if (cand.length) close = cand[0];
        }

        if (!close) continue;

        const profitPips = close.profitPips || 0;
        dataset.push({
          features:   this._extract(o),
          profitPips,
          isWin:      profitPips >  1.0,
          isLoss:     profitPips <  0,
        });
      }
    } catch (err) {
      console.error("[ENGINE_C] Dataset build error:", err.message);
    }

    this._cache   = dataset;
    this._cacheTs = Date.now();
    if (dataset.length > 0) {
      console.log(`[ENGINE_C] Dataset cached: ${dataset.length} historical pair(s)`);
    }
  }

  // ── Main evaluation ────────────────────────────────────────────────────────
  static evaluate(signal) {
    const features = this._extract(signal);
    const dataset  = this._getDataset();

    // No historical data at all → abstain with explanation
    if (dataset.length === 0) {
      return {
        engineId:             this.ID,
        wouldTrade:           null,
        confidence:           "NONE",
        reason:               "no_historical_pairs_oanda_sl_tp_blind_spot",
        kNeighbours:          0,
        avgSimilarity:        0,
        historicalWinrate:    null,
        historicalExpectancy: null,
        profitFactor:         null,
        datasetSize:          0,
      };
    }

    // Score every historical sample
    const scored = dataset.map(h => ({ ...h, sim: this._sim(features, h.features) }));
    const neighbours = scored
      .filter(h => h.sim >= this.MIN_SIM)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, this.K);

    const n      = neighbours.length;
    const avgSim = n > 0
      ? parseFloat((neighbours.reduce((s, h) => s + h.sim, 0) / n).toFixed(3)) : 0;

    // Too few neighbours → abstain
    if (n < this.MIN_K) {
      return {
        engineId:             this.ID,
        wouldTrade:           null,
        confidence:           "NONE",
        reason:               `low_neighbours_n=${n}_min_sim=${this.MIN_SIM}_dataset=${dataset.length}`,
        kNeighbours:          n,
        avgSimilarity:        avgSim,
        historicalWinrate:    null,
        historicalExpectancy: null,
        profitFactor:         null,
        datasetSize:          dataset.length,
      };
    }

    // Neighbourhood statistics
    const wins   = neighbours.filter(h => h.isWin).length;
    const losses = neighbours.filter(h => h.isLoss).length;
    const wr     = parseFloat(((wins / n) * 100).toFixed(1));
    const exp    = parseFloat((neighbours.reduce((s, h) => s + h.profitPips, 0) / n).toFixed(2));
    const posSum = neighbours.filter(h => h.profitPips > 0).reduce((s, h) => s + h.profitPips, 0);
    const negSum = Math.abs(neighbours.filter(h => h.profitPips < 0).reduce((s, h) => s + h.profitPips, 0));
    const pf     = negSum > 0 ? parseFloat((posSum / negSum).toFixed(2)) : null;

    // Confidence from neighbour quality
    const confidence =
      n >= 8 && avgSim >= 0.85 ? "HIGH"   :
      n >= 5 && avgSim >= 0.75 ? "MEDIUM" : "LOW";

    // Decision: clear zones trade/skip; uncertain zone 45–55% abstains unless HIGH confidence
    let wouldTrade;
    if      (wr >= 55)                         wouldTrade = true;
    else if (wr <= 45)                         wouldTrade = false;
    else if (confidence === "HIGH" && exp > 0) wouldTrade = true;   // 45–55% but high quality
    else if (confidence === "HIGH" && exp < 0) wouldTrade = false;
    else                                       wouldTrade = null;    // uncertain → abstain

    return {
      engineId:             this.ID,
      wouldTrade,
      confidence,
      reason:               `knn_n=${n}_sim=${avgSim}_wr=${wr}%_exp=${exp}p_pf=${pf??'n/a'}`,
      kNeighbours:          n,
      avgSimilarity:        avgSim,
      historicalWinrate:    wr,
      historicalExpectancy: exp,
      profitFactor:         pf,
      datasetSize:          dataset.length,
    };
  }

  static invalidateCache() { this._cache = null; this._cacheTs = 0; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW ENGINE D — Meta Engine  (NEW v40)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Does NOT analyse the market.  Analyses only the outputs of Engines A, B, C.
 *
 * Architecture:
 *   Inputs:  A decision + score + confidence
 *            B decision + marketState + confidence
 *            C decision + knn stats + confidence
 *
 *   Weights: learned from historical accuracy per (symbol, session)
 *            with fallback hierarchy: symbol+session → session → global → equal
 *
 *   Output:  metaVoteScore (0–1), wouldTrade, metaConfidence, currentWeights
 *
 * Weight learning:
 *   For each engine, accuracy = correct_predictions / total_resolved_predictions
 *   where "correct" = (predicted TRADE AND actual WIN) OR (predicted SKIP AND actual LOSS)
 *   Weights are proportional to accuracy; cold-start uses equal weights 1/3.
 *
 * Decision hysteresis:
 *   TRADE if metaVoteScore ≥ 0.55
 *   SKIP  if metaVoteScore ≤ 0.45
 *   ABSTAIN otherwise (uncertain zone)
 */
class ShadowMetaEngine {
  static ID        = "ENGINE_D_META";
  static CACHE_TTL = 120000; // rebuild weight cache every 2 min

  // _wCache: key → { A, B, C, samplesA, samplesB, samplesC }
  static _wCache   = {};
  static _wCacheTs = 0;

  // ── Weight computation ─────────────────────────────────────────────────────
  static _weights(symbol, session) {
    // Cache is refreshed async by ShadowLab._cycle() — no inline synchronous rebuild.
    // Cold start (first 8 s): returns equal defaults (1/3 each) which is safe.
    return (
      this._wCache[`${symbol}__${session}`] ||
      this._wCache[`__${session}`]           ||
      this._wCache["__global"]               ||
      { A: 0.333, B: 0.333, C: 0.334, samplesA: 0, samplesB: 0, samplesC: 0 }
    );
  }

  static async _refreshWeightsAsync() {
    // Build into a local variable — assigned atomically on success only.
    // This prevents the race window where _wCache is empty while awaits are in-flight,
    // and ensures a failed rebuild leaves the previous good weights intact.
    const newCache = {};

    try {
      // Load engine decisions (async parallel) — L-3: parameterised, not template-literal
      const loadEngine = async (type) =>
        (await db.all("SELECT data FROM events WHERE type=? ORDER BY id DESC LIMIT 5000", type))
          .map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

      const [dA, dB, dC] = await Promise.all([
        loadEngine("lab_shadow_a"),
        loadEngine("lab_shadow_b"),
        loadEngine("lab_shadow_c"),
      ]);

      // Build outcome map: signalId → { profitPips, isWin, isLoss }
      const closes = (await db.all(
        "SELECT data FROM events WHERE type='trade_close' ORDER BY id DESC LIMIT 5000"
      )).map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

      const outcomeMap = {};
      for (const c of closes) {
        if (!c.signalId) continue;
        const p = c.profitPips || 0;
        outcomeMap[c.signalId] = { p, isWin: p > 1.0, isLoss: p < 0 };
      }

      // Stats accumulator: key → { A:{c,t}, B:{c,t}, C:{c,t} }
      const acc = {}; // c=correct, t=total

      const bucket = (sym, sess) => [
        `${sym}__${sess}`,  // symbol + session
        `__${sess}`,        // session only
        "__global",         // global
      ];

      const absorb = (decisions, eng) => {
        for (const d of decisions) {
          if (d.wouldTrade === null || d.wouldTrade === undefined) continue;
          const out = outcomeMap[d.signalId];
          if (!out) continue;

          // Correct: engine said TRADE and trade won, or said SKIP and trade lost
          const correct = (d.wouldTrade === true && out.isWin) ||
                          (d.wouldTrade === false && out.isLoss);

          for (const k of bucket(d.symbol, d.session)) {
            if (!acc[k]) acc[k] = { A:{c:0,t:0}, B:{c:0,t:0}, C:{c:0,t:0} };
            acc[k][eng].t++;
            if (correct) acc[k][eng].c++;
          }
        }
      };

      absorb(dA, "A");
      absorb(dB, "B");
      absorb(dC, "C");

      // Convert accuracies → normalised weights into newCache
      for (const [key, s] of Object.entries(acc)) {
        const accA = s.A.t > 0 ? s.A.c / s.A.t : 1/3;
        const accB = s.B.t > 0 ? s.B.c / s.B.t : 1/3;
        const accC = s.C.t > 0 ? s.C.c / s.C.t : 1/3;
        const tot  = accA + accB + accC;
        if (tot < 0.01) continue;
        newCache[key] = {
          A: parseFloat((accA / tot).toFixed(3)),
          B: parseFloat((accB / tot).toFixed(3)),
          C: parseFloat((accC / tot).toFixed(3)),
          samplesA: s.A.t,
          samplesB: s.B.t,
          samplesC: s.C.t,
        };
      }

      // Atomic assignment — only reached when all awaits succeed
      this._wCache   = newCache;
      this._wCacheTs = Date.now();
    } catch (err) {
      console.error("[ENGINE_D] Weight rebuild error:", err.message);
      // _wCache and _wCacheTs are unchanged — old weights remain active until next successful rebuild
    }
  }

  // ── Main evaluation ────────────────────────────────────────────────────────
  static evaluate(signal, engineA, engineB, engineC) {
    const { symbol, session } = signal;
    const regime  = engineB.marketState || "UNKNOWN";
    const weights = this._weights(symbol, session);

    const inputs = [
      { id: "A", decision: engineA.wouldTrade, w: weights.A },
      { id: "B", decision: engineB.wouldTrade, w: weights.B },
      { id: "C", decision: engineC.wouldTrade, w: weights.C },
    ];

    const decided = inputs.filter(e => e.decision !== null && e.decision !== undefined);

    // All engines abstain
    if (decided.length === 0) {
      return {
        engineId:      this.ID,
        wouldTrade:    null,
        confidence:    "NONE",
        reason:        "all_engines_abstain",
        metaVoteScore: null,
        weightA: weights.A, weightB: weights.B, weightC: weights.C,
        samplesA: weights.samplesA, samplesB: weights.samplesB, samplesC: weights.samplesC,
        regime, decidedEngines: 0, agreeCount: 0,
      };
    }

    // Weighted vote score (0 = all SKIP, 1 = all TRADE)
    // Redistribute weight from abstaining engines proportionally
    const totalW = decided.reduce((s, e) => s + e.w, 0);
    let voteScore = 0;
    for (const e of decided) voteScore += (e.decision === true ? 1 : 0) * (e.w / totalW);
    voteScore = parseFloat(voteScore.toFixed(3));

    // Decision with hysteresis
    let wouldTrade;
    if      (voteScore >= 0.55) wouldTrade = true;
    else if (voteScore <= 0.45) wouldTrade = false;
    else                        wouldTrade = null; // uncertain zone

    // Meta confidence
    const agreedWith = decided.filter(e => e.decision === wouldTrade).length;
    const confidence =
      decided.length >= 3 && agreedWith === 3           ? "HIGH"   :
      decided.length >= 2 && agreedWith >= 2            ? "HIGH"   :
      decided.length >= 2 && agreedWith >= 1            ? "MEDIUM" :
      wouldTrade !== null && decided.length === 1       ? "LOW"    : "NONE";

    // Top contributing engine
    const topEng = [...decided].sort((a, b) => b.w - a.w)[0];

    const reasons = [
      `vote=${voteScore}`,
      `decided=${decided.length}/3`,
      `top=${topEng.id}(w=${topEng.w})`,
      `regime=${regime}`,
    ];

    return {
      engineId:      this.ID,
      wouldTrade,
      confidence,
      reason:        reasons.join("|"),
      metaVoteScore: voteScore,
      weightA:       parseFloat((weights.A || 0.333).toFixed(3)),
      weightB:       parseFloat((weights.B || 0.333).toFixed(3)),
      weightC:       parseFloat((weights.C || 0.334).toFixed(3)),
      samplesA:      weights.samplesA || 0,
      samplesB:      weights.samplesB || 0,
      samplesC:      weights.samplesC || 0,
      regime,
      decidedEngines: decided.length,
      agreeCount:     agreedWith,
    };
  }

  // Force weight rebuild on next call (e.g. after dataset grows)
  static invalidateCache() { this._wCache = {}; this._wCacheTs = 0; }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPARISON ENGINE  (updated for 4 engines)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Aggregates all engine decisions vs the live bot (always wouldTrade=true for trade_open).
 * Engine D abstain does NOT count against agreement — it is informational only.
 */
class ComparisonEngine {
  static compare(engineA, engineB, engineC, engineD) {
    const liveDecision = true; // live bot always traded

    const engines = [
      { id: "A", decision: engineA.wouldTrade },
      { id: "B", decision: engineB.wouldTrade },
      { id: "C", decision: engineC.wouldTrade },
      { id: "D", decision: engineD ? engineD.wouldTrade : null },
    ];

    const decided    = engines.filter(e => e.decision !== null && e.decision !== undefined);
    const agreeWith  = decided.filter(e => e.decision === liveDecision);
    const disagreeWith = decided.filter(e => e.decision !== liveDecision);

    const agreementPct    = decided.length > 0
      ? parseFloat(((agreeWith.length / decided.length) * 100).toFixed(1)) : null;
    const disagreementPct = decided.length > 0
      ? parseFloat(((disagreeWith.length / decided.length) * 100).toFixed(1)) : null;

    const allAgree    = decided.length > 0 && disagreeWith.length === 0;
    const cautionFlag = disagreeWith.length >= 2; // ≥2 engines say SKIP

    return {
      liveDecision,
      engineADecision:   engineA.wouldTrade,
      engineBDecision:   engineB.wouldTrade,
      engineCDecision:   engineC.wouldTrade,
      engineDDecision:   engineD ? engineD.wouldTrade : null,
      engineAScore:      engineA.score       ?? null,
      engineAConfidence: engineA.confidence  ?? null,
      engineBState:      engineB.marketState ?? null,
      engineBConfidence: engineB.confidence  ?? null,
      engineCWinrate:    engineC.historicalWinrate ?? null,
      engineCConfidence: engineC.confidence  ?? null,
      engineDVoteScore:  engineD ? (engineD.metaVoteScore ?? null) : null,
      engineDConfidence: engineD ? (engineD.confidence    ?? null) : null,
      agreementPct,
      disagreementPct,
      decidedEngines:    decided.length,
      agreeCount:        agreeWith.length,
      disagreeCount:     disagreeWith.length,
      allAgree,
      majorityAgree:     agreeWith.length > disagreeWith.length,
      cautionFlag,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOWLAB ORCHESTRATOR  (v40 — processes A, B, C, D)
// ══════════════════════════════════════════════════════════════════════════════
class ShadowLab {
  constructor() {
    this._processedIds = new Set(); // signalIds already through full pipeline
    this._initialized  = false;
  }

  // ── Init: load already-processed signalIds from lab_comparison ──────────
  async _init() {
    try {
      const rows = await db.all(
        "SELECT data FROM events WHERE type='lab_comparison' ORDER BY id DESC LIMIT 10000"
      );
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

  // ── Backfill: run Engine D on signals that have A/B/C but not D ─────────
  async _backfillD() {
    try {
      // Find signalIds in lab_comparison that don't have a lab_shadow_d entry
      const compRows = await db.all(
        "SELECT data FROM events WHERE type='lab_comparison' ORDER BY id DESC LIMIT 5000"
      );
      const labDRows = await db.all(
        "SELECT data FROM events WHERE type='lab_shadow_d' ORDER BY id DESC LIMIT 5000"
      );

      const doneD = new Set(
        labDRows.map(r => { try { return JSON.parse(r.data).signalId; } catch (_) { return null; } }).filter(Boolean)
      );

      let backfilled = 0;
      for (const r of compRows) {
        let comp;
        try { comp = JSON.parse(r.data); } catch (_) { continue; }
        if (!comp.signalId || doneD.has(comp.signalId)) continue;
        if (backfilled >= 50) break; // limit per cycle

        // Re-fetch A/B/C results for this signal
        await this._runDForExistingSignal(comp.signalId);
        backfilled++;
      }

      if (backfilled > 0) {
        console.log(`[SHADOWLAB] Backfilled Engine D for ${backfilled} signal(s)`);
      }
    } catch (err) {
      console.error("[SHADOWLAB] Backfill error:", err.message);
    }
  }

  async _runDForExistingSignal(signalId) {
    // Rebuild minimal signal from stored lab events
    const getEngine = async (type) => {
      try {
        const rows = await db.all(
          "SELECT data FROM events WHERE type=? ORDER BY id DESC LIMIT 1000", type
        );
        for (const r of rows) {
          try {
            const d = JSON.parse(r.data);
            if (d.signalId === signalId) return d;
          } catch (_) {}
        }
      } catch (_) {}
      return null;
    };

    const [ea, eb, ec] = await Promise.all([
      getEngine("lab_shadow_a"),
      getEngine("lab_shadow_b"),
      getEngine("lab_shadow_c"),
    ]);
    if (!ea || !eb || !ec) return;

    const signal = {
      signalId: ea.signalId, symbol: ea.symbol,
      session: ea.session, side: ea.side,
    };

    const engineD = ShadowMetaEngine.evaluate(signal, ea, eb, ec);
    logEvent({
      type: "lab_shadow_d",
      symbol: ea.symbol, session: ea.session,
      signalId: ea.signalId, side: ea.side,
      fingerprint: ea.fingerprint, entryGate: ea.entryGate,
      passCount: ea.passCount, spread: ea.spread,
      atrPips: ea.atrPips, emaDistance: ea.emaDistance,
      candleStrength: ea.candleStrength, sourceTs: ea.sourceTs,
      ...engineD,
    });
  }

  // ── Main cycle ───────────────────────────────────────────────────────────
  async _cycle() {
    if (!this._initialized) await this._init();

    // Refresh caches used by shadowGate() synchronously from live bot
    await ShadowKNNEngine._refreshDatasetAsync();
    await ShadowMetaEngine._refreshWeightsAsync();

    let opens;
    try {
      opens = await db.all(
        "SELECT id,ts,symbol,data FROM events WHERE type='trade_open' ORDER BY id DESC LIMIT 500"
      );
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
      if (processed >= 20) break; // throttle

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

    // Run D backfill on every 5th cycle to catch old A/B/C without D
    this._cycleCount = (this._cycleCount || 0) + 1;
    if (this._cycleCount % 5 === 0) await this._backfillD();
  }

  // ── Process one trade_open through all 4 engines ─────────────────────────
  _processSignal(signal, ts, symbolRaw) {
    const {
      signalId, symbol = symbolRaw, session, side, fingerprint,
      spread = 0, atrPips = 0, emaDistance = 0, candleStrength = 0,
      entryGate = "HARD", passCount = 0, conditionMap = {},
      trendBucket, volatilityBucket, spreadBucket,
    } = signal;

    const payload = {
      signalId, symbol, session, side, fingerprint,
      spread, atrPips, emaDistance, candleStrength,
      entryGate, passCount, conditionMap,
      trendBucket, volatilityBucket, spreadBucket,
    };

    // Run engines in dependency order: A, B, C → D uses their outputs
    const engineA = ShadowQualityEngine.evaluate(payload);
    const engineB = ShadowContextEngine.evaluate(payload);
    const engineC = ShadowKNNEngine.evaluate(payload);
    const engineD = ShadowMetaEngine.evaluate(payload, engineA, engineB, engineC);
    const comp    = ComparisonEngine.compare(engineA, engineB, engineC, engineD);

    const base = {
      signalId, symbol, session, side, fingerprint,
      spread, atrPips, emaDistance, candleStrength,
      entryGate, passCount, sourceTs: ts,
    };

    logEvent({ type: "lab_shadow_a",   symbol, session, ...base, ...engineA });
    logEvent({ type: "lab_shadow_b",   symbol, session, ...base, ...engineB });
    logEvent({ type: "lab_shadow_c",   symbol, session, ...base, ...engineC });
    logEvent({ type: "lab_shadow_d",   symbol, session, ...base, ...engineD });
    logEvent({ type: "lab_comparison", symbol, session, ...base, ...comp    });
  }

  // ── Public start ──────────────────────────────────────────────────────────
  start() {
    this._init().catch(err => console.error("[SHADOWLAB] Init error:", err.message));
    // First pass after 8 s; backfill D after 15 s; then every 30 s
    setTimeout(() => this._cycle().catch(err => console.error("[SHADOWLAB] Cycle error:", err.message)),          8000);
    setTimeout(() => this._backfillD().catch(err => console.error("[SHADOWLAB] Backfill error:", err.message)),   15000);
    setInterval(() => this._cycle().catch(err => console.error("[SHADOWLAB] Cycle error:", err.message)),         30000);
    console.log("[SHADOWLAB] v40 started — A+B FROZEN | C=KNN | D=META | polling every 30 s");
  }
}

// ── singleton ──────────────────────────────────────────────────────────────────
const shadowLab = new ShadowLab();

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW MODE — controls whether Meta D can block live execution
// ══════════════════════════════════════════════════════════════════════════════
/**
 * OBSERVE (default / data collection mode):
 *   Meta D runs on every signal and logs its decision, but NEVER blocks execution.
 *   Use during the first 250–300 closed trades to build Shadow Memory.
 *
 * GATE:
 *   Meta D can block execution when wouldTrade===false AND confidence==="HIGH".
 *   All other outcomes (abstain, LOW/MEDIUM, error) always allow.
 *   Switch via POST /api/shadow/mode  { mode: "GATE" } when dataset is mature.
 */
let _shadowMode = (process.env.SHADOW_MODE || "OBSERVE").toUpperCase();
if (_shadowMode !== "GATE") _shadowMode = "OBSERVE"; // enforce valid values

// ── Restore shadow mode from DB on startup ────────────────────────────────────
// setShadowMode() logs every mode change as a shadow_mode_change event.
// On Railway restart the env var resets to OBSERVE, but if an operator switched
// to GATE via the API, we restore it from the last DB event so it survives deploys.
(async function _restoreShadowMode() {
  try {
    const row = await db.get(
      "SELECT data FROM events WHERE type='shadow_mode_change' ORDER BY id DESC LIMIT 1"
    );
    if (row) {
      const d = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      const restored = (d?.to || "").toUpperCase();
      if ((restored === "GATE" || restored === "OBSERVE") && restored !== _shadowMode) {
        _shadowMode = restored;
        console.log(`[SHADOWLAB] Shadow mode restored from DB: ${_shadowMode}`);
      }
    }
  } catch (_) {}
})();

function getShadowMode()  { return _shadowMode; }
function setShadowMode(m) {
  const v = (m || "").toUpperCase();
  if (v !== "OBSERVE" && v !== "GATE") throw new Error(`Invalid shadow mode: ${m}`);
  const prev = _shadowMode;
  _shadowMode = v;
  console.log(`[SHADOWLAB] Mode: ${prev} → ${v}`);
  logEvent({ type: "shadow_mode_change", from: prev, to: v });
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW GATE — called by index.js before every trade execution
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Runs the full A→B→C→D pipeline synchronously.
 * ALWAYS returns an object, NEVER throws (fail-safe by design).
 *
 * Returns: { blocked: boolean, mode, reason, confidence, voteScore? }
 *
 * OBSERVE mode:  blocked = false  (always allows, just logs)
 * GATE mode:     blocked = true   ONLY when D.wouldTrade===false AND D.confidence==="HIGH"
 * Any error:     blocked = false  (fail-safe — live bot must not be stopped)
 */
function shadowGate(signal) {
  try {
    const gateEnabled = getRuntimeEnabled("shadow-gate", true);
    const runtime = {
      A: getRuntimeEnabled("shadow-a", true),
      B: getRuntimeEnabled("shadow-b", true),
      C: getRuntimeEnabled("shadow-c", true),
      D: getRuntimeEnabled("shadow-d", true),
      gate: gateEnabled,
    };
    if (!gateEnabled) {
      return {
        blocked: false,
        mode: "DISABLED",
        reason: "shadow_gate_runtime_off",
        confidence: "NONE",
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        engines: {},
        runtime,
      };
    }

    const disabled = (letter) => ({
      engineId: `ENGINE_${letter}_RUNTIME_DISABLED`,
      wouldTrade: null,
      confidence: "NONE",
      reason: `shadow_${letter.toLowerCase()}_runtime_off`,
      disabled: true,
      marketState: "DISABLED",
      historicalWinrate: null,
      kNeighbours: 0,
    });
    const engineA = runtime.A ? ShadowQualityEngine.evaluate(signal) : disabled("A");
    const engineB = runtime.B ? ShadowContextEngine.evaluate(signal) : disabled("B");
    const engineC = runtime.C ? ShadowKNNEngine.evaluate(signal) : disabled("C");
    const engineD = runtime.D
      ? ShadowMetaEngine.evaluate(signal, engineA, engineB, engineC)
      : disabled("D");

    // ── Shadow D Meta: richer entry advisory with Trading Strategy Knowledge ──
    // Synchronous + fail-safe. Evaluates strategy patterns, conflicts,
    // provenance, and data quality. Advisory only — NEVER influences Live Bot.
    const dMeta = runtime.D
      ? ShadowDMetaManager.analyzeAndLogEntry({ signal, engineA, engineB, engineC })
      : null;

    // Log gate evaluation (always — this feeds Shadow Memory even in OBSERVE)
    try {
      logEvent({
        type:              "shadow_gate_eval",
        symbol:            signal.symbol,  session:          signal.session,
        signalId:          signal.signalId, side:             signal.side,
        mode:              _shadowMode,
        engineADecision:   engineA.wouldTrade,  engineAScore:     engineA.score,
        engineAConfidence: engineA.confidence,
        engineBDecision:   engineB.wouldTrade,  engineBState:     engineB.marketState,
        engineBConfidence: engineB.confidence,
        engineCDecision:   engineC.wouldTrade,  engineCWinrate:   engineC.historicalWinrate,
        engineCKNeigh:     engineC.kNeighbours, engineCConfidence: engineC.confidence,
        engineDDecision:   engineD.wouldTrade,  engineDVoteScore: engineD.metaVoteScore,
        engineDConfidence: engineD.confidence,  engineDReason:    engineD.reason,
        runtime,
      });
    } catch (_) {}

    const advisory = {
      advisoryOnly: true,
      authoritativeLayer: "live_bot",
      channel: "live_entry_decision_context",
      signalId: signal.signalId || null,
      runtime,
      engines: { A: engineA, B: engineB, C: engineC },
      meta: engineD,
      dMeta,    // Shadow D Meta — rich entry suggestion (advisory only)
    };

    const advisoryTimestamp = new Date().toISOString();
    const advisoryId = `${signal.signalId || signal.symbol || "unknown"}:${advisoryTimestamp}`;
    const recommendation = (output) => output.wouldTrade === true
      ? "TRADE"
      : output.wouldTrade === false
        ? "NO_TRADE"
        : "ABSTAIN";
    const outputs = {};
    for (const [letter, output] of Object.entries({ A: engineA, B: engineB, C: engineC })) {
      if (!runtime[letter]) continue;
      outputs[letter] = {
        advisoryId: `${advisoryId}:${letter}`,
        engineId: output.engineId,
        recommendation: recommendation(output),
        confidence: output.confidence || null,
        evaluation: output,
      };
    }
    advisory.advisoryId = advisoryId;
    advisory.generatedAt = advisoryTimestamp;
    advisory.outputs = outputs;
    advisory.delivery = {
      target: "selected_advisor",
      channel: "live_entry_decision_context",
      generated: true,
      delivered: false,
      read: false,
      usedForDecision: false,
    };

    // shadowGate() creates the A/B/C outputs. Delivery and read are recorded
    // only after the Live → Selected Advisor bridge accepts these outputs.
    for (const [letter, output] of Object.entries(outputs)) {
      const lifecycle = {
        advisoryId: output.advisoryId,
        signalId: signal.signalId || null,
        setupId: signal.signalId || null,
        symbol: signal.symbol || null,
        side: signal.side || null,
        engineId: output.engineId,
        recommendation: output.recommendation,
        confidence: output.confidence,
        evaluation: output.evaluation,
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        channel: "live_entry_decision_context",
         cooperationPath: "shadow_abc_selected_live",
        timestamp: advisoryTimestamp,
      };
      try {
        logEvent({ type: `shadow_${letter.toLowerCase()}_advisory_generated`, ...lifecycle });
      } catch (_) {}
    }

    try {
      logEvent({
        type: "shadow_advisory",
        signalId: signal.signalId,
        symbol: signal.symbol,
        side: signal.side,
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        channel: "live_entry_decision_context",
        advisoryId,
        generatedAt: advisoryTimestamp,
        runtime,
        engines: { A: engineA, B: engineB, C: engineC },
        outputs,
        delivery: advisory.delivery,
        meta: engineD,
      });
    } catch (_) {}

    // OBSERVE mode — data collection, never block
    if (_shadowMode === "OBSERVE") {
      return {
        blocked: false,
        mode: "OBSERVE",
        reason: "observe_mode_data_collection",
        confidence: engineD.confidence,
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        advisory,
        runtime,
      };
    }

    // GATE mode — block only on HIGH-confidence SKIP
    if (engineD.wouldTrade === false && engineD.confidence === "HIGH") {
      try {
        logEvent({
          type:      "shadow_gate_block",
          symbol:    signal.symbol,    session:    signal.session,
          signalId:  signal.signalId,  side:       signal.side,
          reason:    engineD.reason,   confidence: engineD.confidence,
          voteScore: engineD.metaVoteScore,
          weightA:   engineD.weightA,  weightB:    engineD.weightB,  weightC: engineD.weightC,
        });
      } catch (_) {}
      return {
        blocked:    true,
        mode:       "GATE",
        reason:     engineD.reason,
        confidence: engineD.confidence,
        voteScore:  engineD.metaVoteScore,
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        advisory,
        runtime,
      };
    }

    // Everything else in GATE mode → allow
    return {
      blocked:    false,
      mode:       "GATE",
      reason:     engineD.wouldTrade === null ? "meta_abstain_allow" :
                  engineD.wouldTrade === true  ? "meta_approved"     : "meta_low_confidence_allow",
      confidence: engineD.confidence,
      voteScore:  engineD.metaVoteScore,
      advisoryOnly: true,
      authoritativeLayer: "live_bot",
      advisory,
      runtime,
    };

  } catch (err) {
    // CRITICAL FAIL-SAFE — shadow error must never stop the live bot
    console.error("[SHADOW_GATE] Error (fail-safe active):", err.message);
    return { blocked: false, mode: "FAILSAFE", reason: "shadow_error_" + err.message.slice(0, 80) };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW MEMORY STATS — for status/health endpoints
// ══════════════════════════════════════════════════════════════════════════════
async function getShadowMemoryStats() {
  try {
    const counts = {};
    const types  = ["lab_shadow_a","lab_shadow_b","lab_shadow_c","lab_shadow_d",
                     "lab_comparison","shadow_gate_eval","shadow_gate_block",
                     "shadow_advisory",
                     "shadow_a_advisory_generated","shadow_a_advisory_delivered","shadow_a_advisory_read",
                     "shadow_b_advisory_generated","shadow_b_advisory_delivered","shadow_b_advisory_read",
                     "shadow_c_advisory_generated","shadow_c_advisory_delivered","shadow_c_advisory_read",
                     "trade_close"];
    for (const t of types) {
      try {
        counts[t] = (await db.get("SELECT COUNT(*) AS n FROM events WHERE type=?", t))?.n ?? 0;
      } catch (_) { counts[t] = 0; }
    }
    const closedTrades = counts["trade_close"] || 0;
    const dataCollectionTarget  = 250;
    const dataCollectionPct     = Math.min(100, Math.round((closedTrades / dataCollectionTarget) * 100));
    const dataCollectionReady   = closedTrades >= dataCollectionTarget;
    return {
      mode: _shadowMode,
      counts,
      closedTrades,
      dataCollectionTarget,
      dataCollectionPct,
      dataCollectionReady,
      gateEvals:  counts["shadow_gate_eval"]  || 0,
      gateBlocks: counts["shadow_gate_block"] || 0,
    };
  } catch (err) {
    return { mode: _shadowMode, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHADOW POSITION ADVISOR — architecture stub (v40.1)
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Architecture placeholder for future Shadow ↔ Live position co-management.
 *
 * Full implementation requires:
 *   - bidirectional IPC between manageTrades() and shadowlab
 *   - Shadow learning which market conditions favor BE/trail/early close
 *   - Sufficient historical position-management data (estimated: 500+ closed trades)
 *
 * Current status: OBSERVER ONLY — logs position snapshots for future training.
 * Live bot manages positions exclusively. No active intervention.
 */
class ShadowPositionAdvisor {
  static ID = "SHADOW_POSITION_ADVISOR_v0";

  /**
   * Called passively from manageTrades() — logs position snapshot for training data.
   * Does NOT affect position management. No exceptions thrown.
   */
  static observe(trade, context = {}) {
    try {
      logEvent({
        type:             "shadow_position_obs",
        tradeId:          trade?.id          ?? "?",
        symbol:           trade?.instrument  ?? "?",
        unrealizedPnlPips: context.unrealizedPnlPips ?? null,
        currentPrice:     context.currentPrice      ?? null,
        session:          context.session           ?? null,
        openPrice:        context.openPrice         ?? null,
        beApplied:        context.beApplied         ?? false,
        trailApplied:     context.trailApplied      ?? false,
        mfe:              context.mfe               ?? null,
      });
    } catch (_) {}
  }

  /**
   * Future: return a position-management recommendation.
   * Currently always returns "none" — live bot handles everything.
   */
  static advise(_trade, _context) {
    return { action: "none", reason: "advisor_not_implemented_v40" };
  }
}

module.exports = {
  shadowLab,
  ShadowQualityEngine,       // A — FROZEN
  ShadowContextEngine,       // B — FROZEN
  ShadowKNNEngine,           // C — rebuilt (KNN)
  ShadowMetaEngine,          // D — meta engine
  ComparisonEngine,
  ShadowPositionAdvisor,     // position management stub
  shadowGate,                // Live+Shadow gate (called from index.js)
  getShadowMode,             // returns current mode string
  setShadowMode,             // switches OBSERVE ↔ GATE
  getShadowMemoryStats,      // memory / data collection status
};
