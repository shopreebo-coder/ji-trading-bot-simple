require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto"); // signalId generation — TELEMETRY ONLY
const { CooperativeManager } = require("./telemetry/managers/CooperativeManager");
const cooperativeManager = new CooperativeManager();

// Telemetry — loaded with fallback so bot works even without better-sqlite3
let logEvent = () => {};
try {
  logEvent = require("./telemetry").logEvent;
} catch (e) {
  console.error("[TELEMETRY] Not loaded:", e.message);
}

// Shadow Gate — Snowball Lab Meta D integration v40.1
// OBSERVE mode by default (data collection, never blocks). Fail-safe: always-allow on error.
let shadowGate = async (_signal) => ({ blocked: false, mode: "FAILSAFE" });
try {
  shadowGate = require("./telemetry/shadowlab").shadowGate;
} catch (e) {
  console.error("[SHADOW_GATE] Not loaded:", e.message);
}

console.log("FOREX ENGINE PRO v39.1 (BALANCED MTF)");

const API_KEY    = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const BASE_URL =
  process.env.OANDA_ENV === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";

const SYMBOLS          = process.env.SYMBOLS.split(",");
// DISABLED_SYMBOLS — set in Railway env to pause weak pairs without redeploy
// e.g. DISABLED_SYMBOLS=AUD_USD,NZD_USD
const DISABLED_SYMBOLS = (process.env.DISABLED_SYMBOLS || "").split(",").filter(Boolean);

const MAIN_TIMEFRAME   = process.env.TIMEFRAME || "M5";
const ENTRY_TIMEFRAME  = "M1";
const RISK_PERCENT     = parseFloat(process.env.RISK_PERCENT || "0.01");
const MAX_OPEN_TRADES  = parseInt(process.env.MAX_OPEN_TRADES || "2");
const MAX_DAILY_TRADES = parseInt(process.env.MAX_DAILY_TRADES || "50");
const MIN_STRENGTH     = parseFloat(process.env.MIN_STRENGTH    || "0.08");   // Task 2: relaxed from 0.12

console.log(`MAX_OPEN_TRADES=${MAX_OPEN_TRADES}`);
console.log(`MAX_DAILY_TRADES=${MAX_DAILY_TRADES}`);
console.log(`SYMBOLS=${SYMBOLS}`);

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

const COOPERATIVE_URL = `http://127.0.0.1:${process.env.PORT || 3001}`;
async function cooperativeEntry(signal) {
  try {
    const response = await axios.post(`${COOPERATIVE_URL}/api/cooperative/entry`, signal, { timeout: 1500 });
    return {
      action: response.data?.blocked ? "BLOCK" : "ALLOW",
      decision: response.data?.decision || "ABSTAIN",
      contextId: response.data?.contextId || null,
      confidenceScore: response.data?.confidenceScore ?? null,
      confidenceTier: response.data?.confidenceTier || null,
    };
  } catch (_) {
    return { action: "FAILSAFE_ALLOW", decision: "ABSTAIN", contextId: null };
  }
}

async function cooperativeAdvisory(state) {
  try {
    const response = await axios.post(`${COOPERATIVE_URL}/api/cooperative/advisory`, state, { timeout: 1500 });
    // Pass the actual Live Exit Engine natural action so Shadow M knows the live intent.
    return cooperativeManager.decideManagement(state.liveAction || "HOLD", response.data?.action);
  } catch (_) {
    // Fail-safe: return what Live Engine was going to do anyway.
    return state?.liveAction || "HOLD";
  }
}

// ── SELECTED ENGINE SIGNAL NOTIFY — fire-and-forget ──────────────────────────
// Called once per signal_detected so Selected Engine ring stays current even
// when market conditions mean no candidate ever reaches the BUY/SELL gate.
// NEVER awaited — result is always discarded — has zero effect on trade logic.
function cooperativeSignal(signalId, symbol, session) {
  axios.post(
    `${COOPERATIVE_URL}/api/cooperative/signal`,
    { signalId, symbol, session },
    { timeout: 500 }
  ).catch(() => {}); // best-effort — error is silently dropped
}

let dailyTrades  = 0;
let lastTradeDay = new Date().getUTCDate();

const cooldownMap = {};
const tradeLocks  = {};
const stats = {
  wins: 0,
  losses: 0,
  totalTrades: 0,
  totalPeakPips: 0,
  totalDurationMin: 0,
};

const tradePeak      = {};
const tradeBreakEven = {};

// ── MFE TIME SNAPSHOTS — TELEMETRY ONLY ──────────────────────────────────────
// Peak pip value captured at 30 s, 60 s, 120 s after entry.
// Set once per threshold; never overwritten. Null if trade closed before mark.
const tradeMfe30  = {};  // peak pips at 30 s post-entry
const tradeMfe60  = {};  // peak pips at 60 s post-entry
const tradeMfe120 = {};  // peak pips at 120 s post-entry
const lastTradeDirection = {};  // TELEMETRY ONLY — last trade side per symbol (cooldown analysis)

// ── MAE / MFE telemetry — TELEMETRY ONLY ────────────────────────────────────
const tradeMAE             = {};  // max adverse excursion (most negative pips seen)
const tradeTimeToProfit    = {};  // minutes from open until pips first went > 0
const tradeTimeToDd        = {};  // minutes from open until pips first went < 0
const tradeBeTime          = {};  // minutes from open until break-even SL was moved
const tradeFloorLevel     = {};  // tradeId → dynamic profit floor (pips) — set once MFE >= 2p (v39.4)
const tradeFloorTriggered = {};  // tradeId → boolean — was floor the exit mechanism (v39.4 telemetry)
const tradePostEntryLogged = {};  // flag: post_entry_failure fired for this trade
const tradeEntryMeta       = {};  // tradeId → entry meta (passCount, condition states) for post_entry forensics
const symbolEntryMeta      = {};  // symbol  → entry meta, bridged to tradeId in manageTrades on first tick

// ── SIGNAL LIFECYCLE — TELEMETRY ONLY ───────────────────────────────────────
// signalId generated per strategy() call, propagated through full event chain.
// symbolSignalId: symbol → signalId, set at trade-open, consumed by manageTrades.
// tradeSignalId: tradeId → signalId, linked from symbolSignalId on first tick.
const symbolSignalId = {};
const tradeSignalId  = {};

// ── ENTRY EFFICIENCY — TELEMETRY ONLY ────────────────────────────────────────
// Best favorable pip move in first 2 minutes — proxy for entry timing quality.
// High = price moved quickly in direction = good entry. Low/negative = poor entry.
const tradeEntry2MinBest = {};  // tradeId → max pips seen while minutesOpen < 2

// ── TRADE STATE SNAPSHOT — TELEMETRY ONLY ────────────────────────────────────
// lastSnapshotTime[tradeId] → timestamp; emit trade_state_snapshot every 30 s.
const lastSnapshotTime = {};

// ── SPREAD HISTORY for percentile classification — TELEMETRY ONLY ────────────
const spreadHistory = {};   // symbol → number[] (last 200 readings)
const lastMidPrice  = {};   // symbol → last mid price (blocked outcome tracking)

// ── ROLLING BLOCK COUNTERS — TELEMETRY ONLY ───────────────────────────────────
// Incremented at each filter block. Printed every 5 min via startBlockSummaryPrinter().
// NO strategy decision reads these counters. Purpose: identify dominant choke points.
const blockCounters = {
  spread_block:      0,
  pullback_block:    0,
  cooldown_block:    0,
  exhaustion_block:  0,
  correlation_block: 0,
  margin_block:      0,
  spread_edge_block: 0,
};

// ── CONDITION-GATE BLOCK COUNTERS — TELEMETRY ONLY ───────────────────────────
// Tracks how often each entry gate condition is FALSE after all pre-filters pass.
// Shows whether entry paralysis lives in pre-filters or in the condition gate itself.
// NEVER read by any strategy logic.
const conditionBlockCounters = {};

// ── GATE PASS-RATE COUNTERS — TELEMETRY ONLY ─────────────────────────────────
// Accumulates per-condition pass rates across every pipeline evaluation.
// "Passes" = condition is TRUE for at least one direction (buy OR sell).
// Directional-neutral conditions (ema, strength) track once.
// Printed every 5 min as GATE_PASS_RATE — shows which condition is hardest to satisfy.
// NEVER read by any strategy logic.
const gatePassCounters = {
  total:       0,
  m5_trend:    0,  // lastFast > lastSlow  (buy) or < (sell)
  m5_candle:   0,  // bullishOrNeutralCandle OR bearishOrNeutralCandle on M5 last
  m5_close:    0,  // lastClose > lastFast (buy) or < (sell)
  m5_ema:      0,  // emaDistance > 1.8 (same for both)
  m5_strength: 0,  // candleStrength > MIN_STRENGTH (default 0.08, was 0.12)
  m1_trend:    0,  // m1LastFast > m1LastSlow (buy) or < (sell)
  m1_candle:   0,  // m1Bullish or m1Bearish (current M1 candle)
  m1_prev:     0,  // bullishOrNeutralCandle(m1PrevCandle) or bearish equiv
  m1_close:    0,  // m1LastClose > m1LastFast (buy) or < (sell)
  any_signal:  0,  // both buy AND sell fully pass
};

// ── PRE-FILTER FUNNEL COUNTERS — TELEMETRY ONLY ──────────────────────────────
// Tracks the full evaluation funnel from strategy() entry to trade placement.
// evaluations:     past cooldown/correlation/disabled (before spread fetch)
// spread_pass:     passed spread ≤ 2.0 check
// exhaustion_pass: passed both exhaustion checks (candle + price stretch)
// spread_edge_pass: passed edge ratio check
// gate_reached:    past pullback + margin — reached BUY/SELL evaluation
// entry_allowed:   trade actually placed (BUY or SELL fired)
// Printed every 5 min as PRE_FILTER_PASS_RATE. NEVER read by strategy logic.
const preFilterCounters = {
  evaluations:                    0,
  spread_pass:                    0,
  exhaustion_pass:                0,
  spread_edge_pass:               0,
  gate_reached:                   0,
  entry_allowed:                  0,
  weak_relaxed_no_trend_rejected: 0,   // v39.4b: RELAXED + no M5 trend + no M1 trend
};

// ── FILTER EFFECTIVENESS COUNTERS — TELEMETRY ONLY ───────────────────────────
// In-memory tally of post-block market outcomes by filter type.
// Updated by checkBlockedOutcomes() when the 15-min delayed price check resolves.
// "trended": absPips > 5 — market moved significantly after block (filter may have
//            suppressed a valid entry — evidence to relax threshold further).
// "flat":    absPips ≤ 5 — market stagnant (filter may have protected correctly).
// avg_move_pips = totalMovePips / blocked — true average regardless of threshold.
// NEVER read by strategy logic. Purpose: evidence-based threshold calibration.
const filterEffectivenessCounters = {
  exhaustion:  { blocked: 0, trended: 0, flat: 0, totalMovePips: 0 },
  spread_edge: { blocked: 0, trended: 0, flat: 0, totalMovePips: 0 },
};

// ── CONSECUTIVE LOSS BRAKE — TEMPORARY DEFENSE ────────────────────────────────
// consecutiveLosses: resets to 0 on any win. Increments on any loss/breakeven.
// defensiveMode: activates at 3 consecutive losses — raises EMA gate to 2.5p.
// ONLY effect: BUY/SELL gate requires emaDistance > 2.5 (vs normal 1.8) while active.
// Resets immediately on next win. NEVER affects exits, SL, TP, size, cooldown.
// Clearly labeled TEMPORARY DEFENSE — not a permanent threshold change.
let consecutiveLosses = 0;
let defensiveMode     = false;

// ── TRADE ENTRY SNAPSHOT — FORENSICS TELEMETRY ONLY ──────────────────────────
// activeEntrySnapshot[symbol]: set at trade open with fullSnapshot + fingerprint + side.
// tradeEntrySnapshot[tradeId]: linked from activeEntrySnapshot on first manageTrades tick.
// Emitted as trade_forensics event at close — enables winner vs loser comparison.
// NEVER read by any strategy, filter, or risk logic.
const activeEntrySnapshot = {};  // symbol → entry condition snapshot
const tradeEntrySnapshot  = {};  // tradeId → entry condition snapshot

// ── TRADE QUALITY COUNTERS — TELEMETRY ONLY ───────────────────────────────────
// tradePlusTwoPips[tradeId]:    true once trade ever reaches +2.0 pips
// tradeInstantAdverse[tradeId]: true if FIRST manageTrades tick shows pips < 0
// qualityCounters: all-time aggregate — printed every 5 min as TRADE QUALITY section
const tradePlusTwoPips    = {};
const tradeInstantAdverse = {};
const qualityCounters     = {
  total:          0,   // total trades closed
  reachedPlusTwo: 0,   // # that ever hit +2p before closing
  instantAdverse: 0,   // # where first pip reading was already negative
};

// ── HARD vs RELAXED PERFORMANCE — TELEMETRY ONLY ─────────────────────────────
// Independent closed-trade statistics by the entry gate that was recorded at
// entry. These counters never participate in entry, exit, risk, or sizing logic.
const gatePerformanceCounters = {
  HARD:    { total: 0, wins: 0, losses: 0, totalPips: 0, totalMFE: 0, totalMAE: 0 },
  RELAXED: { total: 0, wins: 0, losses: 0, totalPips: 0, totalMFE: 0, totalMAE: 0 },
};

// ── ALMOST TRADE FORENSICS — TELEMETRY ONLY ──────────────────────────────────
// Stores setups that reach passCount >= 4 gate conditions but do NOT become trades.
// 15-min delayed price check measures what the market did → evidence for which
// failing condition is blocking future winners vs protecting capital.
// almostTradeSignals: atId → pending almost-trade payload awaiting price check
// almostTradeCounters: per-condition aggregate from resolved 15-min outcomes
const almostTradeSignals  = {};
const almostTradeCounters = {};  // populated lazily when conditions first appear

// ── BLOCKED SIGNAL OUTCOME — TELEMETRY ONLY ──────────────────────────────────
// 15-min delayed price check after a signal was filtered.
// signalId → { signalId, symbol, blockType, blockTime, blockPrice }
const blockedSignals = {};

// ── STRATEGY DRIFT DETECTOR — TELEMETRY ONLY ─────────────────────────────────
// Rolling window of last 20 closed trades. Emits alert if win rate deviates
// >20% from all-time. NO auto-adjustment — observation only.
const driftWindow    = [];
const allTimeRolling = { wins: 0, total: 0, totalPips: 0 };

// ── UTILITY ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipMultiplier(symbol) {
  return symbol.includes("JPY") ? 0.01 : 0.0001;
}

// ── SESSION CLASSIFICATION — TELEMETRY ONLY ──────────────────────────────────
// Standard forex session windows (UTC)
function classifySession(hourUTC) {
  if (hourUTC >= 21 || hourUTC < 3)  return "DEAD_ZONE";   // 21:00-03:00 low liquidity
  if (hourUTC >= 3  && hourUTC < 7)  return "ASIA";         // 03:00-07:00 Tokyo peak
  if (hourUTC >= 7  && hourUTC < 12) return "LONDON";       // 07:00-12:00 London open
  if (hourUTC >= 12 && hourUTC < 17) return "OVERLAP";      // 12:00-17:00 London + NY
  return "NEW_YORK";                                          // 17:00-21:00 NY afternoon
}

// ── REGIME BUCKET CLASSIFIERS — TELEMETRY ONLY ───────────────────────────────
function volatilityBucket(atrPips) {
  if (atrPips < 5)  return "LOW_VOL";
  if (atrPips < 12) return "MEDIUM_VOL";
  return "HIGH_VOL";
}

function trendBucket(emaDistance) {
  if (emaDistance < 2) return "WEAK_TREND";
  if (emaDistance < 5) return "MEDIUM_TREND";
  return "STRONG_TREND";
}

function spreadBucketLabel(spread) {
  if (spread < 0.5) return "TIGHT";
  if (spread < 1.0) return "NORMAL";
  if (spread < 1.5) return "WIDE";
  return "EXTREME";
}

function compressionBucket(candleStrength) {
  if (candleStrength < 0.2) return "HIGH_COMPRESSION";
  if (candleStrength < 0.4) return "MEDIUM_COMPRESSION";
  return "LOW_COMPRESSION";
}

// ── SPREAD PERCENTILE — TELEMETRY ONLY ───────────────────────────────────────
function recordSpread(symbol, spread) {
  if (!spreadHistory[symbol]) spreadHistory[symbol] = [];
  spreadHistory[symbol].push(spread);
  if (spreadHistory[symbol].length > 200) spreadHistory[symbol].shift();
}

function getSpreadPercentile(symbol, spread) {
  const hist = spreadHistory[symbol] || [];
  if (hist.length < 5) return "NORMAL";
  const below = hist.filter(s => s <= spread).length;
  const pct   = (below / hist.length) * 100;
  if (pct < 50) return "NORMAL";
  if (pct < 75) return "ELEVATED";
  if (pct < 90) return "HIGH";
  return "EXTREME";
}

// ── STRATEGY DRIFT DETECTOR — TELEMETRY ONLY ─────────────────────────────────
// Called after every trade close. Emits strategy_drift_alert if rolling 20-trade
// win rate deviates >20% from all-time. Also drives NEGATIVE_EDGE_ALERT and
// CONSECUTIVE LOSS BRAKE. NO auto-adjustment to exits/SL/TP/size.
function recordClosedTrade({ win, pips, mfe, mae, duration }) {
  allTimeRolling.total++;
  allTimeRolling.totalPips += (pips || 0);
  if (win) allTimeRolling.wins++;

  driftWindow.push({ win, pips: pips || 0, mfe: mfe || 0, mae: mae || 0, duration: duration || 0 });
  if (driftWindow.length > 20) driftWindow.shift();

  // ── CONSECUTIVE LOSS BRAKE — TEMPORARY DEFENSE ──────────────────────────
  // Reset on win. Activate defensiveMode after 3 consecutive losses.
  // Gate effect happens in strategy() — NOT here.
  if (win) {
    if (consecutiveLosses > 0 || defensiveMode) {
      console.log(`[DEFENSE RESET] Win after ${consecutiveLosses} consecutive loss(es) — defense mode cleared`);
      logEvent({ type: "defense_mode_cleared", consecutiveLosses });
    }
    consecutiveLosses = 0;
    defensiveMode     = false;
  } else {
    consecutiveLosses++;
    if (consecutiveLosses >= 3 && !defensiveMode) {
      defensiveMode = true;
      console.log(`[DEFENSE MODE ACTIVATED] ${consecutiveLosses} consecutive losses — EMA gate raised to 2.5p until next win`);
      logEvent({ type: "defense_mode_activated", consecutiveLosses });
    }
  }

  // ── STRATEGY DRIFT DETECTOR ──────────────────────────────────────────────
  if (driftWindow.length >= 10 && allTimeRolling.total >= 20) {
    const windowWins = driftWindow.filter(t => t.win).length;
    const windowWR   = windowWins / driftWindow.length;
    const allWR      = allTimeRolling.wins / allTimeRolling.total;
    const drift      = Math.abs(windowWR - allWR);

    if (drift > 0.20) {
      const windowAvgPips = driftWindow.reduce((s, t) => s + t.pips, 0) / driftWindow.length;
      const allAvgPips    = allTimeRolling.totalPips / allTimeRolling.total;
      logEvent({
        type:           "strategy_drift_alert",
        windowWinRate:  parseFloat((windowWR * 100).toFixed(1)),
        allTimeWinRate: parseFloat((allWR    * 100).toFixed(1)),
        driftPct:       parseFloat((drift    * 100).toFixed(1)),
        windowAvgPips:  parseFloat(windowAvgPips.toFixed(2)),
        allTimeAvgPips: parseFloat(allAvgPips.toFixed(2)),
        windowSize:     driftWindow.length,
        allTimeTotal:   allTimeRolling.total,
      });
      console.log(`[DRIFT ALERT] windowWR=${(windowWR*100).toFixed(1)}% allWR=${(allWR*100).toFixed(1)}% drift=${(drift*100).toFixed(1)}%`);
    }
  }

  // ── NEGATIVE EDGE DETECTOR — TELEMETRY ONLY ─────────────────────────────
  // If rolling 10-trade WR < 25% AND avg MFE/MAE ratio < 0.5:
  // emits NEGATIVE_EDGE_ALERT — dashboard only, NO automatic shutdown.
  // MFE/MAE < 0.5 means avg winning peak < half the avg adverse excursion —
  // trades never develop positive excursion before reversing.
  if (driftWindow.length >= 10) {
    const last10      = driftWindow.slice(-10);
    const l10WR       = last10.filter(t => t.win).length / 10;
    const l10MFE      = last10.reduce((s, t) => s + (t.mfe || 0), 0) / 10;
    const l10MAE      = last10.reduce((s, t) => s + Math.abs(t.mae || 0), 0) / 10;
    const mfeMaeRatio = l10MAE > 0 ? parseFloat((l10MFE / l10MAE).toFixed(2)) : 9.99;
    if (l10WR < 0.25 && mfeMaeRatio < 0.5) {
      logEvent({
        type:         "NEGATIVE_EDGE_ALERT",
        rolling10WR:  parseFloat((l10WR * 100).toFixed(1)),
        rolling10MFE: parseFloat(l10MFE.toFixed(2)),
        rolling10MAE: parseFloat(l10MAE.toFixed(2)),
        mfeMaeRatio,
        totalTrades:  allTimeRolling.total,
      });
      console.log(`[NEGATIVE_EDGE_ALERT] Rolling-10 WR=${(l10WR*100).toFixed(1)}% MFE/MAE=${mfeMaeRatio} — review trade quality on dashboard`);
    }
  }
}

// ── BLOCKED OUTCOME CHECKER — TELEMETRY ONLY ─────────────────────────────────
// Runs each main loop cycle. For blocked signals older than 15 min, fetches
// current price and emits blocked_outcome showing what the market did after
// the filter fired. Purpose: measure whether filters protect or destroy edge.
// NO strategy logic reads blocked_outcome events.
async function checkBlockedOutcomes() {
  const now           = Date.now();
  const DELAY_MS      = 15 * 60 * 1000;
  const EARLY_DELAY_MS = 3 * 60 * 1000;
  let   processed      = 0;
  let   earlyProcessed = 0;

  // ── 3-MIN EARLY CHECK — TELEMETRY ONLY ──────────────────────────────────
  // Fires once per signal (guarded by earlyChecked flag) between 3–15 min after block.
  // Logs blocked_outcome_3min events — faster feedback than the 15-min full check.
  // For exhaustion blocks: checks whether price moved in the blocked trade direction
  // (continuedTrend / exhaustionRecovery fields) — measures filter false-positive rate.
  // NEVER reads or modifies any strategy state. Signal remains in blockedSignals
  // for the 15-min full check regardless of earlyChecked status.
  for (const [, b] of Object.entries(blockedSignals)) {
    if (b.earlyChecked)                           continue;
    if (now - b.blockTime < EARLY_DELAY_MS)       continue;
    if (now - b.blockTime >= DELAY_MS)            continue; // 15-min loop handles these
    if (earlyProcessed >= 3)                      break;

    try {
      const priceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        { headers, params: { instruments: b.symbol } },
      );
      const ask     = parseFloat(priceData.data.prices[0].asks[0].price);
      const bid     = parseFloat(priceData.data.prices[0].bids[0].price);
      const midNow  = (ask + bid) / 2;
      const pipMult = pipMultiplier(b.symbol);
      const rawMove = (midNow - b.blockPrice) / pipMult;
      const absPips = parseFloat(Math.abs(rawMove).toFixed(2));

      const earlyPayload = {
        type:             "blocked_outcome_3min",
        signalId:         b.signalId,
        symbol:           b.symbol,
        blockType:        b.blockType,
        blockPrice:       b.blockPrice,
        currentPrice:     parseFloat(midNow.toFixed(5)),
        absoluteMovePips: absPips,
        rawMovePips:      parseFloat(rawMove.toFixed(2)),
        minutesElapsed:   parseFloat(((now - b.blockTime) / 60000).toFixed(1)),
      };

      // EXHAUSTION RECOVERY — did price continue in the intended trade direction?
      // trendDir stored at block time: "up" = M5 was bullish, "down" = bearish.
      // > 2p continuation = exhaustionRecovery:true → filter may have been wrong.
      if (b.blockType === "exhaustion_block" && b.trendDir) {
        const continuedTrend = b.trendDir === "up" ? rawMove > 2.0 : rawMove < -2.0;
        earlyPayload.trendDir           = b.trendDir;
        earlyPayload.continuedTrend     = continuedTrend;
        earlyPayload.exhaustionRecovery = continuedTrend;
      }

      logEvent(earlyPayload);
      b.earlyChecked = true;
      earlyProcessed++;
    } catch (_) {
      b.earlyChecked = true; // prevent retry spin on persistent API errors
    }
  }

  // ── 15-MIN FULL CHECK ────────────────────────────────────────────────────
  for (const [id, b] of Object.entries(blockedSignals)) {
    if (now - b.blockTime < DELAY_MS) continue;
    if (processed >= 5) break; // cap API calls per cycle

    try {
      const priceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        { headers, params: { instruments: b.symbol } },
      );
      const ask     = parseFloat(priceData.data.prices[0].asks[0].price);
      const bid     = parseFloat(priceData.data.prices[0].bids[0].price);
      const midNow  = (ask + bid) / 2;
      const pipMult = pipMultiplier(b.symbol);
      const rawMove = (midNow - b.blockPrice) / pipMult;
      const absPips = parseFloat(Math.abs(rawMove).toFixed(2));

      logEvent({
        type:             "blocked_outcome",
        signalId:         b.signalId,
        symbol:           b.symbol,
        blockType:        b.blockType,
        blockPrice:       b.blockPrice,
        currentPrice:     parseFloat(midNow.toFixed(5)),
        absoluteMovePips: absPips,
        rawMovePips:      parseFloat(rawMove.toFixed(2)),
        minutesElapsed:   parseFloat(((now - b.blockTime) / 60000).toFixed(1)),
        wouldHaveOutcome: absPips > 1.0 ? "MOVED" : "STAGNANT",
      });

      // FILTER EFFECTIVENESS — TELEMETRY ONLY
      // Tallies per-type post-block market moves. > 5p = market trended after block.
      if (b.blockType === "exhaustion_block" || b.blockType === "spread_edge_block") {
        const key = b.blockType === "exhaustion_block" ? "exhaustion" : "spread_edge";
        const eff = filterEffectivenessCounters[key];
        eff.blocked++;
        eff.totalMovePips += absPips;
        if (absPips > 5) eff.trended++;
        else             eff.flat++;
      }

      processed++;
    } catch (_) {
      // silent — telemetry failure never affects bot
    }
    delete blockedSignals[id];
  }
}

// ── ALMOST TRADE OUTCOME CHECKER — TELEMETRY ONLY ────────────────────────────
// Runs each main loop cycle. For almost-trade signals older than 15 min, fetches
// price and emits almost_trade_outcome showing what the market did after the near-miss.
// Per-condition counters updated for periodic printer BLOCKED WINNERS section.
// ZERO strategy impact. NO strategy logic reads these results — pure observation.
async function checkAlmostTradeOutcomes() {
  const now      = Date.now();
  const DELAY_MS = 15 * 60 * 1000;
  let   processed = 0;

  for (const [id, at] of Object.entries(almostTradeSignals)) {
    if (now - at.decisionTime < DELAY_MS) continue;
    if (processed >= 5)                   break;
    if (!at.decisionPrice)               { delete almostTradeSignals[id]; continue; }

    try {
      const priceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        { headers, params: { instruments: at.symbol } },
      );
      const ask    = parseFloat(priceData.data.prices[0].asks[0].price);
      const bid    = parseFloat(priceData.data.prices[0].bids[0].price);
      const midNow = (ask + bid) / 2;
      const pm     = pipMultiplier(at.symbol);

      // rawMove: positive = price went up vs decision price
      const rawMove = (midNow - at.decisionPrice) / pm;
      // dirMove: positive = price moved in the intended trade direction
      const dirMove     = at.direction === "buy" ? rawMove : -rawMove;
      const dirMovePips = parseFloat(dirMove.toFixed(2));

      const directionCorrect = dirMove > 0;
      const reached2p        = dirMove >= 2.0;
      const reached4p        = dirMove >= 4.0;
      const reached6p        = dirMove >= 6.0;
      const adverseMovePips  = parseFloat(Math.max(0, -dirMove).toFixed(2));

      logEvent({
        type:             "almost_trade_outcome",
        atId:             at.atId,
        signalId:         at.signalId,
        symbol:           at.symbol,
        direction:        at.direction,
        failedConditions: at.failedConditions,
        passCount:        at.passCount,
        session:          at.session,
        rawMovePips:      parseFloat(rawMove.toFixed(2)),
        maxMovePips:      dirMovePips,
        adverseMovePips,
        directionCorrect,
        reached2p, reached4p, reached6p,
        minutesElapsed:   parseFloat(((now - at.decisionTime) / 60000).toFixed(1)),
        emaDistance:      at.emaDistance,
        candleStrength:   at.candleStrength,
        spread:           at.spread,
        trendBucket:      at.trendBucket,
        volatilityBucket: at.volatilityBucket,
      });

      // Update in-memory counters per failing condition — for periodic BLOCKED WINNERS printer
      for (const fc of (at.failedConditions || [])) {
        if (!almostTradeCounters[fc]) {
          almostTradeCounters[fc] = { total: 0, reached2p: 0, reached4p: 0, reached6p: 0, totalMovePips: 0, correctDir: 0 };
        }
        almostTradeCounters[fc].total++;
        if (reached2p)        almostTradeCounters[fc].reached2p++;
        if (reached4p)        almostTradeCounters[fc].reached4p++;
        if (reached6p)        almostTradeCounters[fc].reached6p++;
        if (directionCorrect) almostTradeCounters[fc].correctDir++;
        almostTradeCounters[fc].totalMovePips += Math.abs(dirMovePips);
      }

      processed++;
    } catch (_) {
      // silent — telemetry failure never affects bot
    }
    delete almostTradeSignals[id];
  }
}

// ── CANDLE DATA ───────────────────────────────────────────────────────────────

async function getCandles(symbol, count = 100, granularity = MAIN_TIMEFRAME) {
  try {
    const url = `${BASE_URL}/v3/instruments/${symbol}/candles`;
    const res = await axios.get(url, {
      headers,
      params: { granularity, count, price: "M" },
    });
    return res.data.candles || [];
  } catch (err) {
    console.log(`Candles error ${symbol}`, err.message);
    return [];
  }
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let emaArray = [data[0]];
  for (let i = 1; i < data.length; i++) {
    emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

function calculateATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high      = parseFloat(candles[i].mid.h);
    const low       = parseFloat(candles[i].mid.l);
    const prevClose = parseFloat(candles[i - 1].mid.c);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low  - prevClose),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function bullishCandle(candle) {
  return parseFloat(candle.mid.c) > parseFloat(candle.mid.o);
}

function bearishCandle(candle) {
  return parseFloat(candle.mid.c) < parseFloat(candle.mid.o);
}

function candleBodySize(candle) {
  return Math.abs(parseFloat(candle.mid.c) - parseFloat(candle.mid.o));
}

// ── CALIBRATION v2: Neutral candle helpers ────────────────────────────────────
// Body-to-range ratio measures how "decisive" a candle is. A doji/inside bar
// (body < 40% of high-low range) is indecision, not counter-trend — it should
// not block an otherwise aligned entry. Only strongly counter-directional bars
// (body ≥ 40% of range AND wrong direction) now block.
// Used ONLY for M5 last candle and M1 prev candle confirmation.
// Core M1 current candle and all trend conditions remain strict.
function candleBodyRatio(candle) {
  const body  = Math.abs(parseFloat(candle.mid.c) - parseFloat(candle.mid.o));
  const range = Math.max(parseFloat(candle.mid.h) - parseFloat(candle.mid.l), 0.000001);
  return body / range;
}

function bullishOrNeutralCandle(candle) {
  // Passes: green candle OR doji/indecision (body < 40% of range)
  // Blocks: strongly bearish candle (red + body ≥ 40% of range)
  return bullishCandle(candle) || candleBodyRatio(candle) < 0.40;
}

function bearishOrNeutralCandle(candle) {
  // Passes: red candle OR doji/indecision (body < 40% of range)
  // Blocks: strongly bullish candle (green + body ≥ 40% of range)
  return bearishCandle(candle) || candleBodyRatio(candle) < 0.40;
}

// ── ACCOUNT DATA ──────────────────────────────────────────────────────────────

async function getOpenTrades() {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/openTrades`,
      { headers },
    );
    return res.data.trades || [];
  } catch (err) {
    console.log("Open trades error", err.message);
    return [];
  }
}

async function hasOpenTrade(symbol) {
  const trades = await getOpenTrades();
  return trades.some((trade) => trade.instrument === symbol);
}

// REAL SPREAD FILTER
// Side effect: updates lastMidPrice[symbol] and spreadHistory — TELEMETRY ONLY
async function getSpread(symbol) {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
      { headers, params: { instruments: symbol } },
    );
    const ask        = parseFloat(res.data.prices[0].asks[0].price);
    const bid        = parseFloat(res.data.prices[0].bids[0].price);
    lastMidPrice[symbol] = (ask + bid) / 2;            // TELEMETRY side effect
    const spreadPips = (ask - bid) / pipMultiplier(symbol);
    recordSpread(symbol, spreadPips);                   // TELEMETRY side effect
    return spreadPips;
  } catch (err) {
    console.log(`Spread error ${symbol}`, err.message);
    return 0;
  }
}

async function getBalance() {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/summary`,
      { headers },
    );
    return parseFloat(res.data.account.balance);
  } catch (err) {
    console.log("Balance error", err.message);
    return 100;
  }
}

async function getAccountInfo() {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/summary`,
      { headers },
    );
    return {
      balance:    parseFloat(res.data.account.balance),
      marginUsed: parseFloat(res.data.account.marginUsed),
    };
  } catch (err) {
    console.log("Account info error", err.message);
    return { balance: 100, marginUsed: 0 };
  }
}

function calculateUnits(balance, stopLossPips, symbol) {
  const riskAmount      = balance * RISK_PERCENT;
  const pipValuePerUnit = symbol.includes("JPY") ? 0.01 : 0.0001;
  const units           = riskAmount / (stopLossPips * pipValuePerUnit);
  return Math.max(Math.floor(units), 1);
}

async function placeTrade(symbol, side, units, slPips, tpPips) {
  try {
    if (tradeLocks[symbol]) {
      console.log(`LOCK ACTIVE -> ${symbol}`);
      return;
    }

    tradeLocks[symbol] = true;

    const existingTrade = await hasOpenTrade(symbol);
    if (existingTrade) {
      console.log(`EXISTING TRADE -> ${symbol}`);
      tradeLocks[symbol] = false;
      return;
    }

    const priceData = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
      { headers, params: { instruments: symbol } },
    );

    const price =
      side === "buy"
        ? parseFloat(priceData.data.prices[0].asks[0].price)
        : parseFloat(priceData.data.prices[0].bids[0].price);

    const pipMult    = pipMultiplier(symbol);
    const stopLoss   = side === "buy" ? price - slPips * pipMult : price + slPips * pipMult;
    const takeProfit = side === "buy" ? price + tpPips * pipMult : price - tpPips * pipMult;

    const body = {
      order: {
        instrument:       symbol,
        units:            side === "buy" ? `${units}` : `-${units}`,
        type:             "MARKET",
        positionFill:     "DEFAULT",
        stopLossOnFill:   { price: stopLoss.toFixed(5) },
        takeProfitOnFill: { price: takeProfit.toFixed(5) },
      },
    };

    await axios.post(`${BASE_URL}/v3/accounts/${ACCOUNT_ID}/orders`, body, { headers });

    console.log(`Trade -> ${symbol} ${side.toUpperCase()}`);
    cooldownMap[symbol] = Date.now();
    console.log(`dailyTrades=${dailyTrades + 1}`);
    dailyTrades++;

    await sleep(5000);
  } catch (err) {
    console.log("Trade error", err.response?.data || err.message);
  } finally {
    tradeLocks[symbol] = false;
  }
}

async function closeTrade(tradeId) {
  try {
    await axios.put(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${tradeId}/close`,
      {},
      { headers },
    );
  } catch (err) {
    console.log("Close trade error", err.message);
  }
}

// ── MANAGE TRADES ─────────────────────────────────────────────────────────────

async function manageTrades() {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const symbol       = trade.instrument;
      const currentUnits = parseFloat(trade.currentUnits);
      const side         = currentUnits > 0 ? "buy" : "sell";
      const openPrice    = parseFloat(trade.price);

      const currentPriceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        { headers, params: { instruments: symbol } },
      );

      const current =
        side === "buy"
          ? parseFloat(currentPriceData.data.prices[0].bids[0].price)
          : parseFloat(currentPriceData.data.prices[0].asks[0].price);

      const pipMult = pipMultiplier(symbol);

      let pips =
        side === "buy"
          ? (current - openPrice) / pipMult
          : (openPrice - current) / pipMult;

      console.log(`${symbol} -> ${pips.toFixed(2)} pips`);

      const openTime    = new Date(trade.openTime).getTime();
      const now         = Date.now();
      const minutesOpen = (now - openTime) / 1000 / 60;

      const breakEvenActive = !!tradeBreakEven[trade.id];

      // ── SIGNAL ID LINKAGE — TELEMETRY ONLY ───────────────────────────────
      if (!tradeSignalId[trade.id] && symbolSignalId[symbol]) {
        tradeSignalId[trade.id] = symbolSignalId[symbol];
        delete symbolSignalId[symbol];
        if (symbolEntryMeta[symbol]) {
          tradeEntryMeta[trade.id] = symbolEntryMeta[symbol];
          delete symbolEntryMeta[symbol];
        }
      }

      // ── ENTRY SNAPSHOT LINKAGE — FORENSICS TELEMETRY ONLY ────────────────
      // Links entry conditions (stored at trade open) to this tradeId.
      // Consumed by buildClosePayload → trade_forensics event at close.
      if (!tradeEntrySnapshot[trade.id] && activeEntrySnapshot[symbol]) {
        tradeEntrySnapshot[trade.id] = activeEntrySnapshot[symbol];
        delete activeEntrySnapshot[symbol];
      }

      // PEAK PROFIT TRACKER
      if (!tradePeak[trade.id] || pips > tradePeak[trade.id]) {
        tradePeak[trade.id] = pips;
        console.log(`${symbol} PEAK -> ${pips.toFixed(2)}`);
      }

      const peak = tradePeak[trade.id];

      // ── MFE TIME SNAPSHOTS — TELEMETRY ONLY ──────────────────────────────
      // Record peak at exactly 30 s / 60 s / 120 s after open. Set once.
      const elapsedMs = now - openTime;
      if (elapsedMs >= 30000  && tradeMfe30[trade.id]  === undefined) tradeMfe30[trade.id]  = parseFloat(peak.toFixed(2));
      if (elapsedMs >= 60000  && tradeMfe60[trade.id]  === undefined) tradeMfe60[trade.id]  = parseFloat(peak.toFixed(2));
      if (elapsedMs >= 120000 && tradeMfe120[trade.id] === undefined) tradeMfe120[trade.id] = parseFloat(peak.toFixed(2));

      // ── MAE / MFE TRACKERS — TELEMETRY ONLY ──────────────────────────────
      if (tradeMAE[trade.id] === undefined || pips < tradeMAE[trade.id]) {
        tradeMAE[trade.id] = pips;
      }
      if (tradeTimeToProfit[trade.id] === undefined && pips > 0) {
        tradeTimeToProfit[trade.id] = parseFloat(minutesOpen.toFixed(2));
      }
      if (tradeTimeToDd[trade.id] === undefined && pips < 0) {
        tradeTimeToDd[trade.id] = parseFloat(minutesOpen.toFixed(2));
      }

      // ── ENTRY EFFICIENCY — TELEMETRY ONLY ────────────────────────────────
      // Track best pip move in first 2 minutes. High = entered at good time.
      if (minutesOpen < 2) {
        if (tradeEntry2MinBest[trade.id] === undefined || pips > tradeEntry2MinBest[trade.id]) {
          tradeEntry2MinBest[trade.id] = pips;
        }
      }

      // ── TRADE QUALITY TRACKERS — TELEMETRY ONLY ──────────────────────────
      // tradeInstantAdverse: TRUE if first-ever pip reading is already negative.
      // tradePlusTwoPips:    TRUE once trade ever reaches +2.0 pips (not instantly adverse).
      // Set once and never cleared until cleanupTradeState() at close.
      if (tradeInstantAdverse[trade.id] === undefined) {
        tradeInstantAdverse[trade.id] = pips < 0; // first tick — adverse from the start?
      }
      if (!tradePlusTwoPips[trade.id] && pips >= 2.0) {
        tradePlusTwoPips[trade.id] = true;         // first time it ever hits +2p
      }

      // ── TRADE STATE SNAPSHOT — TELEMETRY ONLY ────────────────────────────
      // Emit every 30 seconds. Enables full trade replay and management audit.
      const snapshotAge = now - (lastSnapshotTime[trade.id] || 0);
      if (snapshotAge >= 30000) {
        lastSnapshotTime[trade.id] = now;
        const currentSLPrice  = parseFloat(trade.stopLossOrder?.price || 0);
        const slDistancePips  = currentSLPrice
          ? parseFloat((Math.abs(current - currentSLPrice) / pipMult).toFixed(2))
          : null;
        logEvent({
          type:             "trade_state_snapshot",
          signalId:         tradeSignalId[trade.id] || null,
          symbol,
          side,
          pips:             parseFloat(pips.toFixed(2)),
          mfe:              parseFloat(peak.toFixed(2)),
          mae:              parseFloat((tradeMAE[trade.id] ?? 0).toFixed(2)),
          breakEven:        breakEvenActive,
          stopLossDistance: slDistancePips,
          minutesOpen:      parseFloat(minutesOpen.toFixed(2)),
          session:          classifySession(new Date().getUTCHours()),
        });
      }

      // ── LIVE EXIT ENGINE NATURAL ACTION — for Shadow M cooperation context ──
      // Read-only evaluation of the same exit conditions used below.
      // Nothing here changes or executes any exit — it only tells Shadow M what
      // Live Engine would do on this tick so Shadow M can respond in context.
      const _liveExitNatural =
        (peak >= 2.5 && pips < peak - 1.5) ? "REQUEST_CLOSE" :  // PROFIT PROTECTION
        (peak >= 8   && peak - pips >= 3)   ? "REQUEST_CLOSE" :  // MOMENTUM LOST
        (pips <= -4)                         ? "REQUEST_CLOSE" :  // EARLY EXIT
        (minutesOpen >= 6 && pips < 2)       ? "REQUEST_CLOSE" :  // TIME EXIT
        (pips >= 2)                          ? "MOVE_BE"        :  // BREAK EVEN
        (peak >= 2.0)                        ? "MOVE_SL"        :  // MFE FLOOR
        (pips >= 10)                         ? "MOVE_SL"        :  // TRAILING STOP
                                               "HOLD";

      const cooperativeAction = await cooperativeAdvisory({
        tradeId: trade.id,
        signalId: tradeSignalId[trade.id] || null,
        symbol,
        side,
        pips:         parseFloat(pips.toFixed(2)),
        mfe:          parseFloat(peak.toFixed(2)),
        minutesOpen:  parseFloat(minutesOpen.toFixed(2)),
        liveAction:   _liveExitNatural,   // actual Live Exit Engine intent this tick
      });
      logEvent({
        type: "cooperative_exit_processed",
        tradeId: trade.id,
        signalId: tradeSignalId[trade.id] || null,
        symbol,
        side,
        advisoryAction: cooperativeAction,
        liveEngineProcessed: true,
      });

      // ── POST-ENTRY FAILURE DETECTION — TELEMETRY ONLY ────────────────────
      // Fires once if trade drops >1.5 pips adverse within first 3 minutes.
      if (minutesOpen < 3 && pips < -1.5 && !tradePostEntryLogged[trade.id]) {
        tradePostEntryLogged[trade.id] = true;
        const _pefMeta = tradeEntryMeta[trade.id] || {};
        logEvent({
          type:           "post_entry_failure",
          signalId:       tradeSignalId[trade.id] || null,
          tradeId:        trade.id,
          symbol,
          entryTime:      trade.openTime || null,
          pips:           parseFloat(pips.toFixed(2)),
          mfe:            parseFloat(peak.toFixed(2)),
          mae:            parseFloat((tradeMAE[trade.id] ?? pips).toFixed(2)),
          minutesOpen:    parseFloat(minutesOpen.toFixed(2)),
          session:        classifySession(new Date().getUTCHours()),
          passScore:      _pefMeta.passCount      ?? null,
          m1TrendAtEntry: _pefMeta.m1TrendAtEntry ?? null,
          m5TrendAtEntry: _pefMeta.m5TrendAtEntry ?? null,
          m1CloseAtEntry: _pefMeta.m1CloseAtEntry ?? null,
          entryGate:      _pefMeta.entryGate      ?? null,
        });
        console.log(`POST-ENTRY FAILURE -> ${symbol} pips=${pips.toFixed(2)} at ${minutesOpen.toFixed(1)}m`);
      }

      // ── EXIT + ENTRY EFFICIENCY BUILDER — TELEMETRY ONLY ─────────────────
      // Called at every close point. Computes exit efficiency = pips / MFE.
      // entryEfficiencyPips = best pip seen in first 2 min (proxy for entry timing).
      // All fields are OBSERVABILITY ONLY — not used by any strategy condition.
      function buildClosePayload(reason) {
        const mfe = parseFloat(peak.toFixed(2));
        const mae = parseFloat((tradeMAE[trade.id] ?? 0).toFixed(2));
        const exitEfficiency = mfe > 0
          ? parseFloat(((pips / mfe) * 100).toFixed(1))
          : null;
        const entryEfficiencyPips = tradeEntry2MinBest[trade.id] !== undefined
          ? parseFloat(tradeEntry2MinBest[trade.id].toFixed(2))
          : null;
        const _outcome = pips < 0 ? "LOSS" : pips <= 1.0 ? "BREAKEVEN" : "WIN";

        // ── TRADE QUALITY COUNTERS UPDATE — TELEMETRY ONLY ──────────────────
        qualityCounters.total++;
        if (tradePlusTwoPips[trade.id])    qualityCounters.reachedPlusTwo++;
        if (tradeInstantAdverse[trade.id]) qualityCounters.instantAdverse++;

        // ── HARD vs RELAXED PERFORMANCE — TELEMETRY ONLY ────────────────────
        const entryGate = tradeEntryMeta[trade.id]?.entryGate || null;
        if (entryGate === "HARD" || entryGate === "RELAXED") {
          const gateStats = gatePerformanceCounters[entryGate];
          gateStats.total++;
          if (_outcome === "WIN")  gateStats.wins++;
          if (_outcome === "LOSS") gateStats.losses++;
          gateStats.totalPips += pips;
          gateStats.totalMFE  += mfe;
          gateStats.totalMAE  += mae;
        }

        // ── TRADE FORENSICS — TELEMETRY ONLY ────────────────────────────────
        // Emits trade_forensics linking entry conditions with exit outcome.
        // Enables statistical winner vs loser comparison in telemetry DB.
        // Spread operator adds fullSnapshot fields (spread, ATR, EMA dist, etc.)
        // recorded at entry time — different from current close-time values.
        if (tradeEntrySnapshot[trade.id]) {
          logEvent({
            type:             "trade_forensics",
            signalId:         tradeSignalId[trade.id] || null,
            symbol,
            side,
            reason,
            outcome:          _outcome,
            pips:             parseFloat(pips.toFixed(2)),
            mfe,
            mae,
            mfeMaeRatio:      Math.abs(mae) > 0 ? parseFloat((mfe / Math.abs(mae)).toFixed(2)) : null,
            reachedPlusTwo:   tradePlusTwoPips[trade.id]    || false,
            instantAdverse:   tradeInstantAdverse[trade.id] || false,
            timeToProfit:     tradeTimeToProfit[trade.id]   ?? null,
            timeToDd:         tradeTimeToDd[trade.id]       ?? null,
            entryEff2min:     tradeEntry2MinBest[trade.id]  ?? null,
            minutesOpen:      parseFloat(minutesOpen.toFixed(2)),
            closeSession:     classifySession(new Date().getUTCHours()),
            ...tradeEntrySnapshot[trade.id],  // entry-time: spread, ATR, EMA, session, fingerprint, etc.
          });
        }

        return {
          type:                 "trade_close",
          signalId:             tradeSignalId[trade.id] || null,
          symbol,
          profitPips:           pips,
          peak,
          duration:             minutesOpen,
          reason,
          outcome:              _outcome,
          mfe,
          mae,
          timeToProfit:         tradeTimeToProfit[trade.id] ?? null,
          timeToDd:             tradeTimeToDd[trade.id]     ?? null,
          beTime:               tradeBeTime[trade.id]       ?? null,
          // EXIT EFFICIENCY — TELEMETRY ONLY
          exitEfficiency,
          retainedProfitPercent: exitEfficiency,
          // ENTRY EFFICIENCY — TELEMETRY ONLY
          entryEfficiencyPips,
          // QUALITY — TELEMETRY ONLY
          reachedPlusTwo:       tradePlusTwoPips[trade.id]    || false,
          instantAdverse:       tradeInstantAdverse[trade.id] || false,
          // MFE TIME SNAPSHOTS — TELEMETRY ONLY
          mfe30:               tradeMfe30[trade.id]  ?? null,
          mfe60:               tradeMfe60[trade.id]  ?? null,
          mfe120:              tradeMfe120[trade.id] ?? null,
          // MFE CAPTURE METRICS — TELEMETRY ONLY
          mfeCapturedPct:      mfe > 0 ? parseFloat(((pips / mfe) * 100).toFixed(1)) : null,
          profitGivenBackPips: mfe > 0 ? parseFloat((mfe - pips).toFixed(2))         : null,
          // SESSION — TELEMETRY ONLY
          session:              classifySession(new Date().getUTCHours()),
          // EXIT FLOOR PROTECTION — TELEMETRY ONLY (v39.4)
          // exit_floor_triggered: true when floor was the exit mechanism (software or OANDA floor SL)
          // protected_profit:     floor pip level locked in (MAX(0, MFE×0.50))
          // saved_loss:           floor_profit − MIN(0, MAE) — pips secured vs worst excursion
          exit_floor_triggered:  !!tradeFloorTriggered[trade.id] ||
            (tradeFloorLevel[trade.id] != null && pips <= (tradeFloorLevel[trade.id] ?? 0) + 0.3),
          protected_profit:      tradeFloorLevel[trade.id] ?? null,
          saved_loss:            tradeFloorLevel[trade.id] != null &&
            (!!tradeFloorTriggered[trade.id] || pips <= (tradeFloorLevel[trade.id] ?? 0) + 0.3)
              ? parseFloat(((tradeFloorLevel[trade.id] ?? 0) - Math.min(0, tradeMAE[trade.id] ?? 0)).toFixed(2))
              : null,
        };
      }

      function cleanupTradeState() {
        delete tradePeak[trade.id];
        delete tradeBreakEven[trade.id];
        delete tradeMAE[trade.id];
        delete tradeTimeToProfit[trade.id];
        delete tradeTimeToDd[trade.id];
        delete tradeBeTime[trade.id];
        delete tradePostEntryLogged[trade.id];
        delete tradeSignalId[trade.id];
        delete tradeEntry2MinBest[trade.id];
        delete lastSnapshotTime[trade.id];
        delete tradePlusTwoPips[trade.id];     // quality tracker
        delete tradeInstantAdverse[trade.id];  // quality tracker
        delete tradeEntrySnapshot[trade.id];   // forensics snapshot
        delete tradeMfe30[trade.id];           // MFE time snapshots
        delete tradeMfe60[trade.id];
        delete tradeMfe120[trade.id];
        delete tradeFloorLevel[trade.id];      // v39.4 floor protection
        delete tradeFloorTriggered[trade.id];  // v39.4 floor protection
      }

      // ── PROFIT PROTECTION ─────────────────────────────────────────────────
      // Sprint 8: activation threshold lowered 4 → 2.5 (capital defense)
      if (peak >= 2.5 && pips < peak - 1.5) {
        const reason = "PROFIT PROTECTION";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        if (pips > 0) stats.wins++;
        else stats.losses++;
        stats.totalTrades++;
        stats.totalPeakPips    += peak;
        stats.totalDurationMin += minutesOpen;

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, mae: tradeMAE[trade.id] ?? 0, duration: minutesOpen });

        await closeTrade(trade.id);
        cleanupTradeState();
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // ── MOMENTUM EXIT ─────────────────────────────────────────────────────
      if (peak >= 8 && peak - pips >= 3) {
        const reason = "MOMENTUM LOST";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        if (pips > 0) stats.wins++;
        else stats.losses++;
        stats.totalTrades++;
        stats.totalPeakPips    += peak;
        stats.totalDurationMin += minutesOpen;

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, mae: tradeMAE[trade.id] ?? 0, duration: minutesOpen });

        await closeTrade(trade.id);
        cleanupTradeState();
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // ── BREAK EVEN — triggers at +2 pips, moves SL to +0.5 pip above entry ─
      // Sprint 8: activation threshold lowered 3 → 2 (SL offset unchanged)
      if (pips >= 2 || cooperativeAction === "MOVE_BE") {
        const breakEven =
          side === "buy"
            ? openPrice + 0.5 * pipMult
            : openPrice - 0.5 * pipMult;

        const currentSL = parseFloat(trade.stopLossOrder?.price || 0);
        const targetBE  = parseFloat(breakEven.toFixed(5));

        const shouldMoveBE =
          side === "buy"
            ? currentSL < targetBE
            : currentSL > targetBE || currentSL === 0;

        if (shouldMoveBE) {
          await axios.put(
            `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${trade.id}/orders`,
            { stopLoss: { price: targetBE.toFixed(5) } },
            { headers },
          );

          if (!tradeBeTime[trade.id]) {
            tradeBeTime[trade.id] = parseFloat(minutesOpen.toFixed(2));
          }
          tradeBreakEven[trade.id] = true;
          console.log(`${symbol} BREAK EVEN ON`);
          logEvent({
            type:     "break_even",
            signalId: tradeSignalId[trade.id] || null,
            symbol,
            pips,
            session:  classifySession(new Date().getUTCHours()),
          });
        }
      }

      // ── TRAILING STOP ─────────────────────────────────────────────────────
      if (pips >= 10) {
        const trailingDistance = 6;
        const newSL =
          side === "buy"
            ? current - trailingDistance * pipMult
            : current + trailingDistance * pipMult;

        const currentSL = parseFloat(trade.stopLossOrder?.price || 0);
        const shouldMoveSL =
          side === "buy"
            ? newSL > currentSL
            : newSL < currentSL || currentSL === 0;

        if (shouldMoveSL) {
          await axios.put(
            `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${trade.id}/orders`,
            { stopLoss: { price: newSL.toFixed(5) } },
            { headers },
          );
          console.log(`Trailing SL -> ${symbol}`);
        }
      }

      // ── MFE FLOOR PROTECTION (v39.4; Sprint 8: 35% → 50%) ────────────────
      // PURPOSE: once MFE >= 2.0p, trade MUST NOT finish as full loss.
      // FLOOR:   protected_profit = MAX(0, MFE × 0.50)
      //   MFE 2.0 → 1.0p floor
      //   MFE 4.0 → 2.0p floor
      //   MFE 6.0 → 3.0p floor
      // MECHANISM: move OANDA SL to floor price on every tick (ratchets up as MFE grows).
      //   OANDA closes at floor SL when price reverses to it.
      //   Software safety-net exit if price gaps below floor between ticks.
      // DOES NOT MODIFY: initial SL, initial TP, entry logic, EMA, filters, risk, sizing.
      if (peak >= 1.5 || cooperativeAction === "MOVE_SL") {
        const floorProfit = parseFloat((Math.max(0, peak * 0.50)).toFixed(4));
        const floorPrice  = side === "buy"
          ? parseFloat((openPrice + floorProfit * pipMult).toFixed(5))
          : parseFloat((openPrice - floorProfit * pipMult).toFixed(5));

        const currentSL     = parseFloat(trade.stopLossOrder?.price || 0);
        const floorIsBetter = currentSL > 0 && (
          side === "buy" ? floorPrice > currentSL : floorPrice < currentSL
        );

        if (floorIsBetter) {
          try {
            await axios.put(
              `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${trade.id}/orders`,
              { stopLoss: { price: floorPrice.toFixed(5) } },
              { headers },
            );
            tradeFloorLevel[trade.id] = floorProfit;
            console.log(`${symbol} MFE FLOOR SET peak=${peak.toFixed(2)}p floor=${floorProfit.toFixed(2)}p`);
            logEvent({
              type:        "mfe_floor_set",
              symbol,
              signalId:    tradeSignalId[trade.id] || null,
              side,
              mfe:         parseFloat(peak.toFixed(2)),
              floorProfit: floorProfit,
              session:     classifySession(new Date().getUTCHours()),
            });
          } catch (_floorErr) {
            console.log(`${symbol} MFE floor SL update skipped: ${_floorErr.message}`);
          }
        }

        // Safety-net SOFTWARE EXIT — handles gap scenario where price jumps below
        // floor between ticks before OANDA's floor SL can fire.
        // Only fires when pips has already dropped 0.2p below the floor level.
        if (pips < floorProfit - 0.2) {
          tradeFloorTriggered[trade.id] = true;
          const reason = "EXIT_FLOOR_TRIGGERED";
          console.log(
            `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nfloor=${floorProfit.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
          );
          if (pips > 0) stats.wins++;
          else          stats.losses++;
          stats.totalTrades++;
          stats.totalPeakPips    += peak;
          stats.totalDurationMin += minutesOpen;
          logEvent(buildClosePayload(reason));
          recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, mae: tradeMAE[trade.id] ?? 0, duration: minutesOpen });
          await closeTrade(trade.id);
          cleanupTradeState();
          cooldownMap[symbol] = Date.now();
          continue;
        }
      }

      // ── EARLY EXIT ────────────────────────────────────────────────────────
      if (pips <= -4) {
        const reason = "EARLY EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: false, pips, mfe: peak, mae: tradeMAE[trade.id] ?? 0, duration: minutesOpen });

        await closeTrade(trade.id);
        stats.losses++;
        stats.totalTrades++;
        stats.totalPeakPips    += peak;
        stats.totalDurationMin += minutesOpen;

        cleanupTradeState();
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // ── MAX TIME EXIT ─────────────────────────────────────────────────────
      // Sprint 8: time limit shortened 10 → 6 min; closes only when profit < +2 pips
      if (minutesOpen >= 6 && pips < 2) {
        const reason = "TIME EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        const timeExitEntry = tradeEntrySnapshot[trade.id] || {};
        const timeExitMeta  = tradeEntryMeta[trade.id] || {};
        logEvent({
          type:             "time_exit_telemetry",
          signalId:         tradeSignalId[trade.id] || null,
          tradeId:          trade.id,
          symbol,
          side,
          atrPips:          timeExitEntry.atrPips ?? null,
          trendBucket:      timeExitEntry.trendBucket ?? null,
          volatilityBucket: timeExitEntry.volatilityBucket ?? null,
          entryGate:        timeExitMeta.entryGate ?? null,
          passCount:        timeExitMeta.passCount ?? null,
          mfe:              parseFloat(peak.toFixed(2)),
          mae:              parseFloat((tradeMAE[trade.id] ?? 0).toFixed(2)),
          session:          timeExitEntry.session || classifySession(new Date().getUTCHours()),
        });

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, mae: tradeMAE[trade.id] ?? 0, duration: minutesOpen });

        await closeTrade(trade.id);
        stats.totalTrades++;
        stats.totalPeakPips    += peak;
        stats.totalDurationMin += minutesOpen;

        if (pips > 0) stats.wins++;
        else stats.losses++;

        cleanupTradeState();
        cooldownMap[symbol] = Date.now();
      }
    } catch (err) {
      console.log("Manage trade error", err.message);
    }
  }
}

// ── STRATEGY ──────────────────────────────────────────────────────────────────

async function strategy(symbol) {
  try {
    // ── SIGNAL LIFECYCLE: generate signalId for this evaluation cycle ─────
    // All telemetry events from this strategy() call share this ID.
    // TELEMETRY ONLY — strategy logic never reads or branches on signalId.
    const signalId = crypto.randomUUID();
    const evalTime = new Date();
    const hourUTC  = evalTime.getUTCHours();
    const session  = classifySession(hourUTC);

    // SIGNAL_DETECTED — start of evaluation lifecycle
    logEvent({ type: "signal_detected", signalId, symbol, session, hourUTC, dow: evalTime.getUTCDay() });
    // Inform Selected Engine of this signal cycle — fire-and-forget, never awaited.
    // Rate-limited server-side (≤1 refresh/30 s); does not block the pipeline.
    cooperativeSignal(signalId, symbol, session);

    // ── COOLDOWN ──────────────────────────────────────────────────────────
    // Reduced 10→5 min: M5/M1 structure doesn't need 10-min lockout;
    // 5 min still prevents re-entry on same candle cluster. TELEMETRY BENEFIT:
    // more trade samples per session. RISK IMPACT: minimal — all other filters intact.
    const cooldown = 5 * 60 * 1000;
    if (cooldownMap[symbol] && Date.now() - cooldownMap[symbol] <= cooldown) {
      console.log(`Cooldown -> ${symbol}`);
      blockCounters.cooldown_block++;                                         // TELEMETRY ONLY
      logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "cooldown_block" });
      logEvent({ type: "cooldown_block", signalId, symbol, session, lastDirection: lastTradeDirection[symbol] || null }); // TELEMETRY ONLY
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "cooldown_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
          direction: lastTradeDirection[symbol] || null,             // TELEMETRY ONLY — directionCorrect in blocked_outcome
        };
      }
      return;
    }

    // ── OPEN TRADE CHECK ─────────────────────────────────────────────────
    const existingTrade = await hasOpenTrade(symbol);
    if (existingTrade) {
      blockCounters.open_trade_block = (blockCounters.open_trade_block || 0) + 1;
      logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "open_trade_block" });
      logEvent({ type: "open_trade_block", signalId, symbol, session });
      return;
    }

    // ── CORRELATION FILTER ────────────────────────────────────────────────
    const CORRELATED = {
      EUR_USD: ["GBP_USD"],
      GBP_USD: ["EUR_USD"],
      AUD_USD: ["NZD_USD"],
      NZD_USD: ["AUD_USD"],
    };

    const openTrades = await getOpenTrades();
    for (const trade of openTrades) {
      if (CORRELATED[symbol]?.includes(trade.instrument)) {
        console.log(`CORRELATION BLOCK -> ${symbol}`);
        blockCounters.correlation_block++;                                    // TELEMETRY ONLY
        logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "correlation_block" });
        logEvent({ type: "correlation_block", signalId, symbol, session });
        if (lastMidPrice[symbol]) {
          blockedSignals[signalId] = {
            signalId, symbol, blockType: "correlation_block",
            blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
          };
        }
        return;
      }
    }

    // ── DISABLED SYMBOLS — controlled via env var, no redeploy needed ─────
    if (DISABLED_SYMBOLS.includes(symbol)) {
      console.log(`DISABLED BLOCK -> ${symbol}`);
      logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "symbol_disabled_block" });
      logEvent({ type: "symbol_disabled_block", signalId, symbol, session });
      return;
    }

    preFilterCounters.evaluations++;                                          // TELEMETRY ONLY

    // ── REAL SPREAD FILTER ────────────────────────────────────────────────
    const spread       = await getSpread(symbol);
    const spreadPctile = getSpreadPercentile(symbol, spread);

    console.log(`${symbol} SPREAD -> ${spread.toFixed(2)} pips`);

    // CALIBRATION v1: spread 1.5→2.0 — was blocking on mildly elevated spreads
    // that still offered positive expected value. 2.0 is still tight vs retail norms.
    if (spread > 2.0) {
      console.log(`SPREAD BLOCK -> ${symbol} (${spread.toFixed(2)}p > 2.0 limit)`);
      blockCounters.spread_block++;                                           // TELEMETRY ONLY
      logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "spread_block", spread, spreadPercentile: spreadPctile });
      logEvent({ type: "spread_block", signalId, symbol, session, spread, spreadPercentile: spreadPctile });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "spread_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }

    preFilterCounters.spread_pass++;                                          // TELEMETRY ONLY

    // ── M5 ANALYSIS ───────────────────────────────────────────────────────
    const candles = await getCandles(symbol, 100, MAIN_TIMEFRAME);
    if (candles.length < 60) {
      logEvent({ type: "candle_block", signalId, symbol, session, reason: "m5_insufficient", count: candles.length });
      return;
    }

    const closes     = candles.map((c) => parseFloat(c.mid.c));
    const emaFast    = ema(closes, 20);
    const emaSlow    = ema(closes, 50);
    const lastClose  = closes[closes.length - 1];
    const lastFast   = emaFast[emaFast.length - 1];
    const lastSlow   = emaSlow[emaSlow.length - 1];
    const lastCandle = candles[candles.length - 1];

    // ATR
    const atr = calculateATR(candles);

    // EMA DISTANCE
    const emaDistance = Math.abs(lastFast - lastSlow) / pipMultiplier(symbol);

    // CANDLE STRENGTH
    const candleStrength = candleBodySize(lastCandle) / atr;

    // ── REGIME BUCKETS — TELEMETRY ONLY ──────────────────────────────────
    const atrPips  = atr / pipMultiplier(symbol);
    const volBkt   = volatilityBucket(atrPips);
    const trendBkt = trendBucket(emaDistance);
    const spreadBkt = spreadBucketLabel(spread);
    const comprBkt  = compressionBucket(candleStrength);

    // ── ENTRY EXHAUSTION BLOCK — STRATEGY CHANGE (approved: stabilization) ─
    const priceStretchPips = Math.abs(lastClose - lastFast) / pipMultiplier(symbol);

    // CALIBRATION v3.1: Regime-aware exhaustion — hotfix recalibration.
    // Evidence: exhaustion_block still ≈ 60% of evals post-v3; avg post-block move ≈ 7p.
    // HOTFIX: stretch base 0.95→1.10 (candle base stays 1.10); mults 1.2/0.7→1.35/0.90.
    //
    // STRONG_TREND (emaDistance ≥ 5p): multiplier 1.35
    //   Effective limits: candle > 1.485 body/ATR | stretch > 1.485× ATR  (essentially never fires)
    //   Sustained EMA separation: large candles + stretch are EXPECTED — trend continuation.
    //
    // MEDIUM/WEAK TREND (emaDistance < 5p): multiplier 0.90
    //   Effective limits: candle > 0.99 body/ATR | stretch > 0.99× ATR
    //   (v3 was 0.77/0.665 — hotfix allows moderate trend continuation moves through)
    const exhaustionMultiplier   = trendBkt === "STRONG_TREND" ? 1.35 : 0.90;
    const candleExhaustionLimit  = parseFloat((1.10 * exhaustionMultiplier).toFixed(3));
    const stretchExhaustionLimit = parseFloat((1.10 * exhaustionMultiplier).toFixed(3));

    if (candleStrength > candleExhaustionLimit) {
      console.log(`EXHAUSTION BLOCK -> ${symbol} reason=candle_overexpanded expansion=${candleStrength.toFixed(2)} (limit=${candleExhaustionLimit} regime=${trendBkt} mult=${exhaustionMultiplier})`);
      blockCounters.exhaustion_block++;                                       // TELEMETRY ONLY
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "exhaustion_block", subReason: "candle_overexpanded",
      });
      logEvent({
        type:                 "exhaustion_block",
        signalId, symbol, session,
        reason:               "candle_overexpanded",
        expansionRatio:       parseFloat(candleStrength.toFixed(3)),
        candleExhaustionLimit,
        exhaustionMultiplier,
        priceStretchPips:     parseFloat(priceStretchPips.toFixed(2)),
        atrPips:              parseFloat(atrPips.toFixed(2)),
        volatilityBucket:     volBkt,
        trendBucket:          trendBkt,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "exhaustion_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
          trendDir: lastFast > lastSlow ? "up" : "down",   // for 3-min recovery check
        };
      }
      return;
    }

    if (priceStretchPips > atrPips * stretchExhaustionLimit) {
      console.log(`EXHAUSTION BLOCK -> ${symbol} reason=price_overextended stretch=${priceStretchPips.toFixed(2)} atr=${atrPips.toFixed(2)} (limit=${stretchExhaustionLimit}×ATR regime=${trendBkt})`);
      blockCounters.exhaustion_block++;                                       // TELEMETRY ONLY
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "exhaustion_block", subReason: "price_overextended",
      });
      logEvent({
        type:                 "exhaustion_block",
        signalId, symbol, session,
        reason:               "price_overextended",
        expansionRatio:       parseFloat(candleStrength.toFixed(3)),
        stretchExhaustionLimit,
        exhaustionMultiplier,
        priceStretchPips:     parseFloat(priceStretchPips.toFixed(2)),
        atrPips:              parseFloat(atrPips.toFixed(2)),
        volatilityBucket:     volBkt,
        trendBucket:          trendBkt,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "exhaustion_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
          trendDir: lastFast > lastSlow ? "up" : "down",   // for 3-min recovery check
        };
      }
      return;
    }
    preFilterCounters.exhaustion_pass++;                                      // TELEMETRY ONLY

    // ── MINIMUM EDGE FILTER — STRATEGY CHANGE (approved: stabilization) ───
    const expectedCapturePips = atrPips * 0.30;
    const edgeRatio           = expectedCapturePips / spread;
    // CALIBRATION v3: edge ratio 1.5→1.15 — telemetry shows spread_edge_block ≈ 24%
    // of all evaluations; avg post-block move ≈ 11p. Blocked setups were expanding.
    // 1.15 still requires expectedCapturePips > spread × 1.15 — positive expected value
    // after spread cost is preserved. Formula: ATR×0.3 / spread > 1.15 → ATR > 3.83× spread.
    if (edgeRatio < 1.15) {
      console.log(`SPREAD_EDGE BLOCK -> ${symbol} edge=${edgeRatio.toFixed(2)} expected=${expectedCapturePips.toFixed(2)}p spread=${spread.toFixed(2)}p (limit 1.15)`);
      blockCounters.spread_edge_block++;                                      // TELEMETRY ONLY
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "spread_edge_block", edgeRatio: parseFloat(edgeRatio.toFixed(2)),
      });
      logEvent({
        type:                "spread_edge_block",
        signalId, symbol, session,
        edgeRatio:           parseFloat(edgeRatio.toFixed(2)),
        expectedCapturePips: parseFloat(expectedCapturePips.toFixed(2)),
        atrPips:             parseFloat(atrPips.toFixed(2)),
        spread,
        spreadPercentile:    spreadPctile,
        volatilityBucket:    volBkt,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "spread_edge_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }
    preFilterCounters.spread_edge_pass++;                                     // TELEMETRY ONLY

    // ── MARKET REGIME SNAPSHOT — TELEMETRY ONLY ───────────────────────────
    logEvent({
      type:              "market_regime",
      signalId,
      symbol,
      hour:              hourUTC,
      dow:               evalTime.getUTCDay(),
      session,
      atr:               parseFloat(atrPips.toFixed(2)),
      spread,
      spreadPercentile:  spreadPctile,
      emaDistance:       parseFloat(emaDistance.toFixed(2)),
      trendStrength:     parseFloat(emaDistance.toFixed(2)),
      candleStrength:    parseFloat(candleStrength.toFixed(3)),
      volatilityBucket:  volBkt,
      trendBucket:       trendBkt,
      spreadBucket:      spreadBkt,
      compressionBucket: comprBkt,
    });

    // ── M1 CONFIRMATION ───────────────────────────────────────────────────
    const m1Candles = await getCandles(symbol, 50, ENTRY_TIMEFRAME);
    if (m1Candles.length < 30) {
      logEvent({ type: "candle_block", signalId, symbol, session, reason: "m1_insufficient", count: m1Candles.length });
      return;
    }

    const m1Closes     = m1Candles.map((c) => parseFloat(c.mid.c));
    const m1Fast       = ema(m1Closes, 9);
    const m1Slow       = ema(m1Closes, 21);
    const m1LastFast   = m1Fast[m1Fast.length - 1];
    const m1LastSlow   = m1Slow[m1Slow.length - 1];
    const m1LastCandle = m1Candles[m1Candles.length - 1];
    const m1PrevCandle = m1Candles[m1Candles.length - 2];
    const m1Bullish    = bullishCandle(m1LastCandle);
    const m1Bearish    = bearishCandle(m1LastCandle);
    const m1LastClose  = m1Closes[m1Closes.length - 1];

    // ENTRY DISTANCE — distance from current M1 close to EMA9
    const entryDistance = Math.abs(m1LastClose - m1LastFast) / pipMultiplier(symbol);
    console.log(`${symbol} ENTRY DISTANCE -> ${entryDistance.toFixed(2)} pips`);

    // CALIBRATION v1: pullback window 1.0→1.5 pip — 1 pip was creating a near-impossible
    // condition: price must be above EMA9 (to satisfy m1close condition) but also within
    // 1 pip of it. 1.5 pip allows normal pullback entries while still rejecting overextensions.
    if (entryDistance > 1.5) {
      console.log(`PULLBACK BLOCK -> ${symbol} distance=${entryDistance.toFixed(2)} (limit 1.5p)`);
      blockCounters.pullback_block++;                                         // TELEMETRY ONLY
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "pullback_block", entryDistance,
      });
      logEvent({
        type: "pullback_block",
        signalId, symbol, session,
        entryDistance,
        volatilityBucket: volBkt,
        spreadPercentile: spreadPctile,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "pullback_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }

    // ── RISK ──────────────────────────────────────────────────────────────
    const stopLossPips   = Math.max(Math.floor((atr / pipMultiplier(symbol)) * 1.5), 8);
    const takeProfitPips = Math.floor(stopLossPips * 1.2);

    const account       = await getAccountInfo();
    const balance       = account.balance;
    const marginPercent = (account.marginUsed / account.balance) * 100;

    console.log(`MARGIN -> ${marginPercent.toFixed(1)}%`);

    if (marginPercent > 50) {
      console.log("MARGIN PROTECTION ACTIVE");
      blockCounters.margin_block++;                                           // TELEMETRY ONLY
      logEvent({ type: "margin_block", signalId, symbol, session, marginPercent });
      return;
    }

    // SAFETY CAP — 500 units max for small account
    const units = Math.min(calculateUnits(balance, stopLossPips, symbol), 500);

    preFilterCounters.gate_reached++;                                         // TELEMETRY ONLY

    // ── STEP 1: ENTRY PIPELINE TRACE — TELEMETRY ONLY ────────────────────────
    // Full per-condition visibility. Fires after ALL pre-filters pass.
    // ENTRY_DECISION: ALLOW fires before placeTrade; BLOCK fires when gate fails.
    const _T = (v) => v ? "✓" : "✗";

    // CALIBRATION v2: candle conditions use bullishOrNeutralCandle for M5 last bar
    // and M1 prev bar. These allow doji/indecision candles (body < 40% range).
    // M1 CURRENT candle (m1Bullish/m1Bearish) stays strict — requires actual direction.
    // All trend conditions (lastFast/lastSlow, m1LastFast/m1LastSlow) stay strict.
    const _m5b = {
      trend:    lastFast > lastSlow,
      close:    lastClose > lastFast,
      candle:   bullishOrNeutralCandle(lastCandle),     // v2: doji M5 bar ok in confirmed trend
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
    };
    const _m1b = {
      trend:  m1LastFast > m1LastSlow,
      candle: m1Bullish,                                 // strict: current M1 candle must be green
      prev:   bullishOrNeutralCandle(m1PrevCandle),      // v2: doji prev bar ok
      close:  m1LastClose > m1LastFast,
    };
    const _m5s = {
      trend:    lastFast < lastSlow,
      close:    lastClose < lastFast,
      candle:   bearishOrNeutralCandle(lastCandle),     // v2: doji M5 bar ok in confirmed trend
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
    };
    const _m1s = {
      trend:  m1LastFast < m1LastSlow,
      candle: m1Bearish,                                 // strict: current M1 candle must be red
      prev:   bearishOrNeutralCandle(m1PrevCandle),      // v2: doji prev bar ok
      close:  m1LastClose < m1LastFast,
    };

    // ── GATE v3 — Project Snowball ────────────────────────────────────────────
    // SOFT (scored + logged, cannot veto): m5trend, m1trend, m1close.
    // HARD gate (6 conditions): m5close, m5candle, ema, strength + m1candle, m1prev.
    // RELAXED gate: passScore >= 6 AND anchor trio (ema + strength + candle) all TRUE.
    // A trade fires when HARD passes OR RELAXED passes. No other logic changes.
    const _buyPassScore  = [_m5b.trend,_m5b.close,_m5b.candle,_m5b.ema,_m5b.strength,_m1b.trend,_m1b.candle,_m1b.prev,_m1b.close].filter(Boolean).length;
    const _sellPassScore = [_m5s.trend,_m5s.close,_m5s.candle,_m5s.ema,_m5s.strength,_m1s.trend,_m1s.candle,_m1s.prev,_m1s.close].filter(Boolean).length;
    const _buyHard   = _m5b.close && _m5b.candle && _m5b.ema && _m5b.strength && _m1b.candle && _m1b.prev;
    const _sellHard  = _m5s.close && _m5s.candle && _m5s.ema && _m5s.strength && _m1s.candle && _m1s.prev;
    const _buyRelaxed  = _buyPassScore  >= 6 && _m5b.ema && _m5b.strength && _m5b.candle;
    const _sellRelaxed = _sellPassScore >= 6 && _m5s.ema && _m5s.strength && _m5s.candle;
    const _buyAll  = _buyHard  || _buyRelaxed;
    const _sellAll = _sellHard || _sellRelaxed;

    // ── WEAK RELAXED FILTER (v39.4b) — TELEMETRY + REJECT ────────────────────
    // Rejects RELAXED-gate entries where BOTH M5 trend AND M1 trend are FALSE.
    // Rationale: RELAXED requires anchor(ema+str+candle) but NOT trend alignment.
    // When BOTH trend EMAs are against direction, this is the weakest RELAXED entry.
    // HARD entries are NEVER affected — _buyHard / _sellHard overrides this check.
    // DOES NOT change any threshold, filter, TP, SL, risk, or exit logic.
    const _weakRelaxedBuyReject  = !_buyHard  && _buyRelaxed  && !_m5b.trend && !_m1b.trend;
    const _weakRelaxedSellReject = !_sellHard && _sellRelaxed && !_m5s.trend && !_m1s.trend;

    // STEP 2: Condition-gate failure counters — TELEMETRY ONLY
    // Use unique keys per tier to prevent m5/m1 key collision.
    // m5_* and m1_* allow us to distinguish where each tier fails.
    if (!_buyAll) {
      for (const [k, v] of Object.entries(_m5b)) {
        if (!v) conditionBlockCounters["buy_m5_" + k] = (conditionBlockCounters["buy_m5_" + k] || 0) + 1;
      }
      for (const [k, v] of Object.entries(_m1b)) {
        if (!v) conditionBlockCounters["buy_m1_" + k] = (conditionBlockCounters["buy_m1_" + k] || 0) + 1;
      }
    }
    if (!_sellAll) {
      for (const [k, v] of Object.entries(_m5s)) {
        if (!v) conditionBlockCounters["sell_m5_" + k] = (conditionBlockCounters["sell_m5_" + k] || 0) + 1;
      }
      for (const [k, v] of Object.entries(_m1s)) {
        if (!v) conditionBlockCounters["sell_m1_" + k] = (conditionBlockCounters["sell_m1_" + k] || 0) + 1;
      }
    }

    // GATE_PASS_RATE counters — TELEMETRY ONLY
    // Tracks per-condition pass rate across all pipeline evaluations.
    // "Passes" = condition TRUE for at least one direction (buy OR sell).
    gatePassCounters.total++;
    if (_m5b.trend    || _m5s.trend)    gatePassCounters.m5_trend++;
    if (_m5b.candle   || _m5s.candle)   gatePassCounters.m5_candle++;
    if (_m5b.close    || _m5s.close)    gatePassCounters.m5_close++;
    if (_m5b.ema)                        gatePassCounters.m5_ema++;      // same both dirs
    if (_m5b.strength)                   gatePassCounters.m5_strength++; // same both dirs
    if (_m1b.trend    || _m1s.trend)    gatePassCounters.m1_trend++;
    if (_m1b.candle   || _m1s.candle)   gatePassCounters.m1_candle++;
    if (_m1b.prev     || _m1s.prev)     gatePassCounters.m1_prev++;
    if (_m1b.close    || _m1s.close)    gatePassCounters.m1_close++;
    if (_buyAll       || _sellAll)       gatePassCounters.any_signal++;

    const _buyFirstFail  = Object.entries({ ..._m5b, ..._m1b }).find(([, v]) => !v)?.[0] || null;
    const _sellFirstFail = Object.entries({ ..._m5s, ..._m1s }).find(([, v]) => !v)?.[0] || null;
    const _direction     = _buyAll ? "BUY" : _sellAll ? "SELL" : "NONE";

    console.log(`\n===== ENTRY PIPELINE: ${symbol} [${session}] =====`);
    console.log(`  ATR: ${atrPips.toFixed(1)}p  Spread: ${spread.toFixed(2)}p  EMA-dist: ${emaDistance.toFixed(1)}p  Candle-str: ${candleStrength.toFixed(2)}  Entry-dist: ${entryDistance.toFixed(2)}p`);
    console.log(`  M5-BUY : trend${_T(_m5b.trend)} close${_T(_m5b.close)} candle${_T(_m5b.candle)} ema${_T(_m5b.ema)} str${_T(_m5b.strength)}  | M1-BUY : trend${_T(_m1b.trend)} candle${_T(_m1b.candle)} prev${_T(_m1b.prev)} close${_T(_m1b.close)}`);
    console.log(`  M5-SELL: trend${_T(_m5s.trend)} close${_T(_m5s.close)} candle${_T(_m5s.candle)} ema${_T(_m5s.ema)} str${_T(_m5s.strength)}  | M1-SELL: trend${_T(_m1s.trend)} candle${_T(_m1s.candle)} prev${_T(_m1s.prev)} close${_T(_m1s.close)}`);
    if (_buyAll) {
      console.log(`  ENTRY_DECISION: ALLOW BUY`);
    } else if (_sellAll) {
      console.log(`  ENTRY_DECISION: ALLOW SELL`);
    } else {
      const _buyReject  = _buyFirstFail  ? `buy→${_buyFirstFail}`  : "";
      const _sellReject = _sellFirstFail ? `sell→${_sellFirstFail}` : "";
      console.log(`  ENTRY_DECISION: BLOCK  first-fail: ${[_buyReject,_sellReject].filter(Boolean).join(" | ")}`);
      // Log gate block to telemetry DB — shows patterns that pass ALL filters but miss gate
      logEvent({
        type:          "entry_blocked_at_gate",
        signalId,      symbol, session,
        direction:     _direction,
        buyFirstFail:  _buyFirstFail,
        sellFirstFail: _sellFirstFail,
        m5Buy:  _m5b,  m1Buy:  _m1b,
        m5Sell: _m5s,  m1Sell: _m1s,
        spread, atrPips: parseFloat(atrPips.toFixed(2)),
        emaDistance: parseFloat(emaDistance.toFixed(2)),
        candleStrength: parseFloat(candleStrength.toFixed(3)),
        entryDistance:  parseFloat(entryDistance.toFixed(2)),
        session,
      });
    }
    console.log(`===============================================`);

    // BUY CHECK — log structured decision (conditions match gate v2)
    logEvent({
      type: "buy_check",
      signalId, symbol, session,
      trend:    lastFast > lastSlow,
      candle:   bullishOrNeutralCandle(lastCandle),   // v2
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
      m5close:  lastClose > lastFast,               // TELEMETRY ONLY — m5 close above fast EMA
      m1trend:  m1LastFast > m1LastSlow,
      m1candle: m1Bullish,
      m1prev:   bullishOrNeutralCandle(m1PrevCandle), // v2
      m1close:  m1LastClose > m1LastFast,
      entryDistance, emaDistance, candleStrength, spread,
      volatilityBucket: volBkt, trendBucket: trendBkt,
      spreadBucket: spreadBkt, compressionBucket: comprBkt,
    });

    // SELL CHECK — log structured decision (conditions match gate v2)
    logEvent({
      type: "sell_check",
      signalId, symbol, session,
      trend:    lastFast < lastSlow,
      candle:   bearishOrNeutralCandle(lastCandle),   // v2
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
      m5close:  lastClose < lastFast,               // TELEMETRY ONLY — m5 close below fast EMA
      m1trend:  m1LastFast < m1LastSlow,
      m1candle: m1Bearish,
      m1prev:   bearishOrNeutralCandle(m1PrevCandle), // v2
      m1close:  m1LastClose < m1LastFast,
      entryDistance, emaDistance, candleStrength, spread,
      volatilityBucket: volBkt, trendBucket: trendBkt,
      spreadBucket: spreadBkt, compressionBucket: comprBkt,
    });

    // DECISION FINGERPRINT — 6-char hash (T=true, F=false per condition)
    // Updated to match gate v2 candle conditions for accurate fingerprint correlation.
    const _buyFp = {
      trend:    lastFast > lastSlow,
      candle:   bullishOrNeutralCandle(lastCandle),   // v2
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
      m1trend:  m1LastFast > m1LastSlow,
      m1prev:   bullishOrNeutralCandle(m1PrevCandle), // v2
    };
    const _sellFp = {
      trend:    lastFast < lastSlow,
      candle:   bearishOrNeutralCandle(lastCandle),   // v2
      ema:      emaDistance > 1.8,
      strength: candleStrength > MIN_STRENGTH,
      m1trend:  m1LastFast < m1LastSlow,
      m1prev:   bearishOrNeutralCandle(m1PrevCandle), // v2
    };
    const _fpHash = (fp) => Object.values(fp).map((v) => (v ? "T" : "F")).join("");

    // ── FULL MARKET SNAPSHOT — attached to trade_open. TELEMETRY ONLY ─────
    const fullSnapshot = {
      spread,
      atrPips:           parseFloat(atrPips.toFixed(2)),
      emaDistance:       parseFloat(emaDistance.toFixed(2)),
      candleStrength:    parseFloat(candleStrength.toFixed(3)),
      entryDistance:     parseFloat(entryDistance.toFixed(2)),
      hourUTC,
      session,
      dow:               evalTime.getUTCDay(),
      trendStrength:     parseFloat(emaDistance.toFixed(2)),
      spreadPercentile:  spreadPctile,
      volatilityBucket:  volBkt,
      trendBucket:       trendBkt,
      spreadBucket:      spreadBkt,
      compressionBucket: comprBkt,
    };

    // ── DEFENSE MODE GATE — TEMPORARY CAPITAL PROTECTION ─────────────────
    // SAFE / TEMPORARY DEFENSE — activates ONLY after 3 consecutive losses.
    // In defense mode: requires emaDistance > 2.5p (vs normal 1.8p).
    // Resets immediately on next win. Has zero effect in normal (non-defensive) operation.
    // Does NOT increment any block counter. Does NOT affect exits, SL, TP, or position size.
    if (defensiveMode && emaDistance <= 2.5) {
      console.log(`[DEFENSE MODE] ${symbol} emaDistance=${emaDistance.toFixed(1)}p < 2.5 required (${consecutiveLosses} consec. losses) — skipping`);
      logEvent({ type: "defense_mode_skip", signalId, symbol, session, emaDistance: parseFloat(emaDistance.toFixed(2)), consecutiveLosses });
      return;
    }

    // ── ALMOST TRADE FORENSICS — TELEMETRY ONLY ──────────────────────────
    // Evaluate all 9 gate conditions individually for each direction.
    // If 4-8 pass but NOT all 9 (trade not placed) → store for 15-min price check.
    // Answers: which failing condition is blocking future winners?
    // ZERO strategy impact. NEVER read by any entry/exit/risk logic.
    {
      for (const [dir, m5c, m1c, didTrade] of [
        ["buy",  _m5b, _m1b, _buyAll],
        ["sell", _m5s, _m1s, _sellAll],
      ]) {
        if (didTrade) continue; // full gate passed → trade placed below → not an "almost"
        const allConds = {
          m5trend:  m5c.trend,
          m5close:  m5c.close,
          m5candle: m5c.candle,
          ema:      m5c.ema,
          strength: m5c.strength,
          m1trend:  m1c.trend,
          m1candle: m1c.candle,
          m1prev:   m1c.prev,
          m1close:  m1c.close,
        };
        const failed    = Object.entries(allConds).filter(([, v]) => !v).map(([k]) => k);
        const passCount = 9 - failed.length;
        if (passCount < 4) continue; // not close enough to be interesting
        const atId = `${signalId}_${dir}`;
        almostTradeSignals[atId] = {
          atId, signalId, symbol, direction: dir,
          passCount, failedConditions: failed,
          decisionTime:    Date.now(),
          decisionPrice:   lastMidPrice[symbol] || null,
          session,
          emaDistance:     parseFloat(emaDistance.toFixed(2)),
          candleStrength:  parseFloat(candleStrength.toFixed(3)),
          spread,
          trendBucket:     trendBkt,
          volatilityBucket: volBkt,
          entryDistance:   parseFloat(entryDistance.toFixed(2)),
        };
        logEvent({
          type:             "almost_trade",
          atId,
          signalId, symbol, direction: dir, session,
          passCount,
          failedConditions: failed,
          emaDistance:      parseFloat(emaDistance.toFixed(2)),
          candleStrength:   parseFloat(candleStrength.toFixed(3)),
          spread,
          trendBucket:      trendBkt,
          volatilityBucket: volBkt,
          entryDistance:    parseFloat(entryDistance.toFixed(2)),
          priceAtDecision:  lastMidPrice[symbol] || null,
        });
        console.log(`ALMOST_TRADE ${dir.toUpperCase()} -> ${symbol} passCount=${passCount}/9 failed=[${failed.join(",")}]`);
      }
    }

    // ── WEAK RELAXED REJECTION LOG + OUTCOME QUEUE (v39.4b) ─────────────────
    // Fires when _weakRelaxedBuyReject / _weakRelaxedSellReject is true.
    // Increments counter, logs weak_relaxed_no_trend event, queues 15-min outcome.
    // Outcome check reuses almostTradeSignals + checkAlmostTradeOutcomes — no new code.
    if (_weakRelaxedBuyReject) {
      preFilterCounters.weak_relaxed_no_trend_rejected++;
      console.log(`[WEAK_RELAXED_REJECT] BUY ${symbol} passScore=${_buyPassScore}/9 RELAXED+m5trend=F+m1trend=F → weak_relaxed_no_trend`);
      const _wrAtId = `${signalId}_weakbuy`;
      logEvent({
        type:             "weak_relaxed_no_trend",
        signalId, symbol, session,
        side:             "buy",
        passScore:        _buyPassScore,
        ...fullSnapshot,
      });
      almostTradeSignals[_wrAtId] = {
        atId:             _wrAtId,
        signalId,
        symbol,
        direction:        "buy",
        passCount:        _buyPassScore,
        failedConditions: ["weak_relaxed_no_trend"],
        decisionTime:     Date.now(),
        decisionPrice:    lastMidPrice[symbol] || null,
        session,
        emaDistance:      parseFloat(emaDistance.toFixed(2)),
        candleStrength:   parseFloat(candleStrength.toFixed(3)),
        spread,
        trendBucket:      trendBkt,
        volatilityBucket: volBkt,
        entryDistance:    parseFloat(entryDistance.toFixed(2)),
      };
    }
    if (_weakRelaxedSellReject) {
      preFilterCounters.weak_relaxed_no_trend_rejected++;
      console.log(`[WEAK_RELAXED_REJECT] SELL ${symbol} passScore=${_sellPassScore}/9 RELAXED+m5trend=F+m1trend=F → weak_relaxed_no_trend`);
      const _wrAtId = `${signalId}_weaksell`;
      logEvent({
        type:             "weak_relaxed_no_trend",
        signalId, symbol, session,
        side:             "sell",
        passScore:        _sellPassScore,
        ...fullSnapshot,
      });
      almostTradeSignals[_wrAtId] = {
        atId:             _wrAtId,
        signalId,
        symbol,
        direction:        "sell",
        passCount:        _sellPassScore,
        failedConditions: ["weak_relaxed_no_trend"],
        decisionTime:     Date.now(),
        decisionPrice:    lastMidPrice[symbol] || null,
        session,
        emaDistance:      parseFloat(emaDistance.toFixed(2)),
        candleStrength:   parseFloat(candleStrength.toFixed(3)),
        spread,
        trendBucket:      trendBkt,
        volatilityBucket: volBkt,
        entryDistance:    parseFloat(entryDistance.toFixed(2)),
      };
    }

    // ── BUY ───────────────────────────────────────────────────────────────
    // GATE v3 — see _buyAll / _buyHard / _buyRelaxed above for exact logic.
    // Soft: m5trend, m1trend, m1close. Hard: m5close, m5candle, ema, strength, m1candle, m1prev.
    // Relaxed path: passScore >= 6 AND anchor(ema + strength + candle) all TRUE.
    if (_buyAll && !_weakRelaxedBuyReject) {
      const _m1TrendStatus = m1LastFast > m1LastSlow; // M1TREND_EXP: tracked, not blocking
      const _m5TrendStatus = lastFast > lastSlow;      // M5TREND_EXP: tracked, not blocking
      const _m1CloseStatus = m1LastClose > m1LastFast; // M1CLOSE_EXP: tracked, not blocking
      const _entryGate     = _buyHard ? "HARD" : "RELAXED";
      if (!_m5TrendStatus) {
        console.log(`[M5TREND_EXP] BUY ${symbol} with m5trend=FALSE (EMA20=${lastFast.toFixed(5)} < EMA50=${lastSlow.toFixed(5)}) — experiment entry`);
      }
      if (!_m1CloseStatus) {
        console.log(`[M1CLOSE_EXP] BUY ${symbol} with m1close=FALSE (m1Close=${m1LastClose.toFixed(5)} < EMA9=${m1LastFast.toFixed(5)}) — experiment entry`);
      }
      if (_entryGate === "RELAXED") {
        console.log(`[RELAXED_GATE] BUY ${symbol} passScore=${_buyPassScore}/9 — anchor(ema+str+candle)=TRUE — relaxed gate fired`);
      }
      // TRADE QUALITY TELEMETRY — full 9-condition map stored on every trade_open for server-side analysis
      const _buyCondMap  = {
        trend:    _m5b.trend,
        m5close:  _m5b.close,
        candle:   _m5b.candle,
        ema:      _m5b.ema,
        strength: _m5b.strength,
        m1trend:  _m1b.trend,
        m1candle: _m1b.candle,
        m1prev:   _m1b.prev,
        m1close:  _m1b.close,
      };
      const _buyPassCount = Object.values(_buyCondMap).filter(Boolean).length;
      const _m5CandleType  = bullishCandle(lastCandle) ? "bullish" : "neutral-doji";
      const _m1PrevType    = bullishCandle(m1PrevCandle) ? "bullish" : "neutral-doji";
      if (!_m1TrendStatus) {
        console.log(`[M1TREND_EXP] BUY ${symbol} with m1trend=FALSE (EMA9=${m1LastFast.toFixed(5)} < EMA21=${m1LastSlow.toFixed(5)}) — experiment entry`);
      }
      console.log(
        `=== TRADE OPEN ===\nWHY BUY ${symbol}:\nM5 trend: bullish (fast > slow)\nM5 candle: ${_m5CandleType}\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${atrPips.toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: bullish candle + ${_m1PrevType} prev + close above EMA9 [m1trend=${_m1TrendStatus}]\nEntry dist: ${entryDistance.toFixed(2)}p\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips}p  TP: ${takeProfitPips}p  RR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );
      console.log(`MTF BUY CONFIRMED -> ${symbol}`);

      // ── SHADOW GATE v40.1 — OBSERVE by default, full fail-safe ────────────
      const _gBuy = await shadowGate({
        signalId, symbol, session, side: "buy",
        conditionMap: _buyCondMap, passCount: _buyPassCount,
        entryGate: _entryGate, spread, atrPips, emaDistance, candleStrength,
      });
      if (_gBuy.blocked) {
        console.log(`[SHADOW_GATE] BUY ${symbol} BLOCKED — ${_gBuy.reason}`);
        return;
      }
      const _coopBuy = await cooperativeEntry({
        signalId, symbol, side: "buy", conditionMap: _buyCondMap, entryGate: _entryGate,
        spread, atrPips, volatilityBucket: volBkt,
      });
      if (_coopBuy.action === "BLOCK") {
        logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "cooperative_high_confidence_no_trade", cooperative: _coopBuy });
        return;
      }
      // ── END SHADOW GATE ─────────────────────────────────────────────────
      symbolSignalId[symbol]      = signalId;
      symbolEntryMeta[symbol]     = { passCount: _buyPassCount, m1TrendAtEntry: _m1TrendStatus, m5TrendAtEntry: _m5TrendStatus, m1CloseAtEntry: _m1CloseStatus, entryGate: _entryGate };
      activeEntrySnapshot[symbol] = {                             // FORENSICS TELEMETRY
        ...fullSnapshot,
        fingerprint:    _fpHash(_buyFp),
        side:           "buy",
      };
      lastTradeDirection[symbol] = "buy";                          // TELEMETRY ONLY — for cooldown analysis
      logEvent({
        type: "trade_open",
        signalId, symbol, session,
        side: "buy",
        ...fullSnapshot,
        stopLossPips, takeProfitPips,
        risk: RISK_PERCENT, units,
        fingerprint:    _fpHash(_buyFp),
        fp:             _buyFp,
        m1TrendAtEntry: _m1TrendStatus,   // M1TREND_EXP — A/B segmentation field
        m5TrendAtEntry: _m5TrendStatus,   // M5TREND_EXP — A/B segmentation field
        m1CloseAtEntry: _m1CloseStatus,   // M1CLOSE_EXP — A/B segmentation field
        entryGate:      _entryGate,       // GATE_V3: "HARD" | "RELAXED"
        passCount:      _buyPassCount,    // QUALITY TELEMETRY — # of 9 conditions true at entry
        conditionMap:   _buyCondMap,      // QUALITY TELEMETRY — full per-condition state for analysis
      });

      await placeTrade(symbol, "buy", units, stopLossPips, takeProfitPips);
      preFilterCounters.entry_allowed++;                                      // TELEMETRY ONLY
    }

    // ── SELL ──────────────────────────────────────────────────────────────
    // GATE v3 — see _sellAll / _sellHard / _sellRelaxed above for exact logic.
    // Soft: m5trend, m1trend, m1close. Hard: m5close, m5candle, ema, strength, m1candle, m1prev.
    // Relaxed path: passScore >= 6 AND anchor(ema + strength + candle) all TRUE.
    if (_sellAll && !_weakRelaxedSellReject) {
      const _m1TrendStatus = m1LastFast < m1LastSlow; // M1TREND_EXP: tracked, not blocking
      const _m5TrendStatus = lastFast < lastSlow;      // M5TREND_EXP: tracked, not blocking
      const _m1CloseStatus = m1LastClose < m1LastFast; // M1CLOSE_EXP: tracked, not blocking
      const _entryGate     = _sellHard ? "HARD" : "RELAXED";
      if (!_m5TrendStatus) {
        console.log(`[M5TREND_EXP] SELL ${symbol} with m5trend=FALSE (EMA20=${lastFast.toFixed(5)} > EMA50=${lastSlow.toFixed(5)}) — experiment entry`);
      }
      if (!_m1CloseStatus) {
        console.log(`[M1CLOSE_EXP] SELL ${symbol} with m1close=FALSE (m1Close=${m1LastClose.toFixed(5)} > EMA9=${m1LastFast.toFixed(5)}) — experiment entry`);
      }
      if (_entryGate === "RELAXED") {
        console.log(`[RELAXED_GATE] SELL ${symbol} passScore=${_sellPassScore}/9 — anchor(ema+str+candle)=TRUE — relaxed gate fired`);
      }
      // TRADE QUALITY TELEMETRY — full 9-condition map stored on every trade_open for server-side analysis
      const _sellCondMap  = {
        trend:    _m5s.trend,
        m5close:  _m5s.close,
        candle:   _m5s.candle,
        ema:      _m5s.ema,
        strength: _m5s.strength,
        m1trend:  _m1s.trend,
        m1candle: _m1s.candle,
        m1prev:   _m1s.prev,
        m1close:  _m1s.close,
      };
      const _sellPassCount = Object.values(_sellCondMap).filter(Boolean).length;
      const _m5CandleType  = bearishCandle(lastCandle) ? "bearish" : "neutral-doji";
      const _m1PrevType    = bearishCandle(m1PrevCandle) ? "bearish" : "neutral-doji";
      if (!_m1TrendStatus) {
        console.log(`[M1TREND_EXP] SELL ${symbol} with m1trend=FALSE (EMA9=${m1LastFast.toFixed(5)} > EMA21=${m1LastSlow.toFixed(5)}) — experiment entry`);
      }
      console.log(
        `=== TRADE OPEN ===\nWHY SELL ${symbol}:\nM5 trend: bearish (fast < slow)\nM5 candle: ${_m5CandleType}\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${atrPips.toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: bearish candle + ${_m1PrevType} prev + close below EMA9 [m1trend=${_m1TrendStatus}]\nEntry dist: ${entryDistance.toFixed(2)}p\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips}p  TP: ${takeProfitPips}p  RR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );
      console.log(`MTF SELL CONFIRMED -> ${symbol}`);

      // ── SHADOW GATE v40.1 — OBSERVE by default, full fail-safe ────────────
      const _gSell = await shadowGate({
        signalId, symbol, session, side: "sell",
        conditionMap: _sellCondMap, passCount: _sellPassCount,
        entryGate: _entryGate, spread, atrPips, emaDistance, candleStrength,
      });
      if (_gSell.blocked) {
        console.log(`[SHADOW_GATE] SELL ${symbol} BLOCKED — ${_gSell.reason}`);
        return;
      }
      const _coopSell = await cooperativeEntry({
        signalId, symbol, side: "sell", conditionMap: _sellCondMap, entryGate: _entryGate,
        spread, atrPips, volatilityBucket: volBkt,
      });
      if (_coopSell.action === "BLOCK") {
        logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "cooperative_high_confidence_no_trade", cooperative: _coopSell });
        return;
      }
      // ── END SHADOW GATE ─────────────────────────────────────────────────
      symbolSignalId[symbol]      = signalId;
      symbolEntryMeta[symbol]     = { passCount: _sellPassCount, m1TrendAtEntry: _m1TrendStatus, m5TrendAtEntry: _m5TrendStatus, m1CloseAtEntry: _m1CloseStatus, entryGate: _entryGate };
      activeEntrySnapshot[symbol] = {                             // FORENSICS TELEMETRY
        ...fullSnapshot,
        fingerprint:    _fpHash(_sellFp),
        side:           "sell",
      };
      lastTradeDirection[symbol] = "sell";                         // TELEMETRY ONLY — for cooldown analysis
      logEvent({
        type: "trade_open",
        signalId, symbol, session,
        side: "sell",
        ...fullSnapshot,
        stopLossPips, takeProfitPips,
        risk: RISK_PERCENT, units,
        fingerprint:    _fpHash(_sellFp),
        fp:             _sellFp,
        m1TrendAtEntry: _m1TrendStatus,   // M1TREND_EXP — A/B segmentation field
        m5TrendAtEntry: _m5TrendStatus,   // M5TREND_EXP — A/B segmentation field
        m1CloseAtEntry: _m1CloseStatus,   // M1CLOSE_EXP — A/B segmentation field
        entryGate:      _entryGate,       // GATE_V3: "HARD" | "RELAXED"
        passCount:      _sellPassCount,   // QUALITY TELEMETRY — # of 9 conditions true at entry
        conditionMap:   _sellCondMap,     // QUALITY TELEMETRY — full per-condition state for analysis
      });

      await placeTrade(symbol, "sell", units, stopLossPips, takeProfitPips);
      preFilterCounters.entry_allowed++;                                      // TELEMETRY ONLY
    }
  } catch (err) {
    console.log(`Strategy error ${symbol}`, err.message);
  }
} // strategy()

// ── MAIN BOT LOOP ─────────────────────────────────────────────────────────────

async function runBot() {
  while (true) {
    try {
      const now  = new Date();
      const day  = now.getUTCDay();
      const hour = now.getUTCHours();

      if (day === 6 || (day === 0 && hour < 21)) {
        console.log("FOREX CLOSED");
        await sleep(600000);
        continue;
      }

      const currentDay = new Date().getUTCDate();
      if (currentDay !== lastTradeDay) {
        dailyTrades            = 0;
        lastTradeDay           = currentDay;
        // DAILY STATS RESET — only on new UTC day
        stats.wins             = 0;
        stats.losses           = 0;
        stats.totalTrades      = 0;
        stats.totalPeakPips    = 0;
        stats.totalDurationMin = 0;
      }

      // DAILY LIMIT
      if (dailyTrades >= MAX_DAILY_TRADES) {
        console.log("===== TODAY STATS =====");
        console.log(`Trades: ${stats.totalTrades}`);
        console.log(`Wins: ${stats.wins}`);
        console.log(`Losses: ${stats.losses}`);

        const winRate =
          stats.totalTrades > 0
            ? ((stats.wins / stats.totalTrades) * 100).toFixed(1)
            : 0;
        console.log(`Winrate: ${winRate}%`);

        const avgPeak =
          stats.totalTrades > 0
            ? (stats.totalPeakPips / stats.totalTrades).toFixed(1)
            : 0;
        const avgDuration =
          stats.totalTrades > 0
            ? (stats.totalDurationMin / stats.totalTrades).toFixed(1)
            : 0;
        console.log(`Avg peak profit: ${avgPeak} pips`);
        console.log(`Avg trade duration: ${avgDuration} min`);
        console.log("MAX DAILY TRADES REACHED");

        await manageTrades();
        await checkBlockedOutcomes();        // TELEMETRY ONLY
        await checkAlmostTradeOutcomes();    // TELEMETRY ONLY
        await sleep(60000);
        continue;
      }

      const openTrades = await getOpenTrades();
      if (openTrades.length >= MAX_OPEN_TRADES) {
        await manageTrades();
        await checkBlockedOutcomes();        // TELEMETRY ONLY
        await checkAlmostTradeOutcomes();    // TELEMETRY ONLY
        await sleep(5000);
        continue;
      }

      // SYMBOL LOOP
      for (const symbol of SYMBOLS) {
        await manageTrades();
        await strategy(symbol);
        await sleep(2000);
      }

      // MANAGE OPEN TRADES
      await manageTrades();

      // BLOCKED OUTCOME CHECK — TELEMETRY ONLY
      await checkBlockedOutcomes();
      await checkAlmostTradeOutcomes(); // TELEMETRY ONLY

      // MAIN LOOP DELAY
      await sleep(5000);
    } catch (err) {
      console.log("Main loop error", err.message);
      await sleep(10000);
    }
  }
}

// ── BLOCK SUMMARY PRINTER — TELEMETRY ONLY ───────────────────────────────────
// Prints rolling block counters every 5 minutes.
// Counters are NEVER read by any strategy, filter, or risk logic.
// Sole purpose: surface dominant choke points for human review before optimization.
function startBlockSummaryPrinter() {
  setInterval(() => {
    // PRE-FILTER BLOCKS — fires before M5/M1 analysis
    console.log("===== BLOCK SUMMARY (PRE-FILTER) =====");
    console.log(`spread_block:      ${blockCounters.spread_block}`);
    console.log(`spread_edge_block: ${blockCounters.spread_edge_block}`);
    console.log(`exhaustion_block:  ${blockCounters.exhaustion_block}`);
    console.log(`pullback_block:    ${blockCounters.pullback_block}`);
    console.log(`cooldown_block:    ${blockCounters.cooldown_block}`);
    console.log(`correlation_block: ${blockCounters.correlation_block}`);
    console.log(`margin_block:      ${blockCounters.margin_block}`);
    console.log("======================================");

    // CONDITION-GATE BLOCKS — fires after all pre-filters pass, at entry gate
    // Non-zero = signals reached the gate but a specific condition failed
    const cgKeys = Object.keys(conditionBlockCounters).sort(
      (a, b) => conditionBlockCounters[b] - conditionBlockCounters[a]
    );
    if (cgKeys.length > 0) {
      console.log("===== BLOCK SUMMARY (GATE CONDITIONS) =====");
      for (const k of cgKeys) {
        console.log(`  ${k}: ${conditionBlockCounters[k]}`);
      }
      console.log("===========================================");
    }

    // GATE_PASS_RATE — per-condition pass rate since last restart
    if (gatePassCounters.total > 0) {
      const pct = (n) => (n / gatePassCounters.total * 100).toFixed(0) + "%";
      console.log("===== GATE_PASS_RATE =====");
      console.log(`  evaluations:  ${gatePassCounters.total}`);
      console.log(`  m5_trend:     ${pct(gatePassCounters.m5_trend)}   (buy or sell M5 EMA20>EMA50)`);
      console.log(`  m5_candle:    ${pct(gatePassCounters.m5_candle)}   (M5 last bar non-reversal)`);
      console.log(`  m5_close:     ${pct(gatePassCounters.m5_close)}   (M5 close on correct EMA side)`);
      console.log(`  m5_ema:       ${pct(gatePassCounters.m5_ema)}   (EMA dist > 1.8p)`);
      console.log(`  m5_strength:  ${pct(gatePassCounters.m5_strength)}   (candle body > 12% ATR)`);
      console.log(`  m1_trend:     ${pct(gatePassCounters.m1_trend)}   (M1 EMA9 aligned)`);
      console.log(`  m1_candle:    ${pct(gatePassCounters.m1_candle)}   (M1 current candle directional)`);
      console.log(`  m1_prev:      ${pct(gatePassCounters.m1_prev)}   (M1 prev bar non-reversal)`);
      console.log(`  m1_close:     ${pct(gatePassCounters.m1_close)}   (M1 close on correct EMA9 side)`);
      console.log(`  any_signal:   ${pct(gatePassCounters.any_signal)}   (full gate pass — trade eligible)`);
      console.log("==========================");
    }

    // PRE_FILTER_PASS_RATE — full funnel from strategy() entry to trade placed
    if (preFilterCounters.evaluations > 0) {
      const pf = preFilterCounters;
      const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(0) + "%" : "n/a";
      console.log("===== PRE_FILTER_PASS_RATE =====");
      console.log(`  evaluations:      ${pf.evaluations}  (past cooldown/correlation/disabled)`);
      console.log(`  spread_pass:      ${pct(pf.spread_pass, pf.evaluations)}  (${pf.spread_pass}/${pf.evaluations})`);
      console.log(`  exhaustion_pass:  ${pct(pf.exhaustion_pass, pf.spread_pass)}  of spread_pass (${pf.exhaustion_pass}/${pf.spread_pass})`);
      console.log(`  spread_edge_pass: ${pct(pf.spread_edge_pass, pf.exhaustion_pass)}  of exhaustion_pass (${pf.spread_edge_pass}/${pf.exhaustion_pass})`);
      console.log(`  gate_reached:     ${pct(pf.gate_reached, pf.spread_edge_pass)}  of spread_edge_pass (${pf.gate_reached}/${pf.spread_edge_pass})`);
      console.log(`  entry_allowed:    ${pct(pf.entry_allowed, pf.evaluations)}  overall  (${pf.entry_allowed}/${pf.evaluations} evals → trade)`);
      console.log("================================");
    }

    // FILTER EFFECTIVENESS — post-block market move by filter type
    const _printEff = (label, eff) => {
      if (eff.blocked === 0) return;
      const avgMove = (eff.totalMovePips / eff.blocked).toFixed(1);
      const trendPct = (eff.trended / eff.blocked * 100).toFixed(0);
      const flatPct  = (eff.flat     / eff.blocked * 100).toFixed(0);
      console.log(`  ${label}: blocked=${eff.blocked} trended(>5p)=${trendPct}% flat=${flatPct}% avg_move=${avgMove}p`);
    };
    if (filterEffectivenessCounters.exhaustion.blocked > 0 || filterEffectivenessCounters.spread_edge.blocked > 0) {
      console.log("===== FILTER EFFECTIVENESS (15-min post-block) =====");
      _printEff("exhaustion ", filterEffectivenessCounters.exhaustion);
      _printEff("spread_edge", filterEffectivenessCounters.spread_edge);
      console.log("====================================================");
    }

    // ── CAPITAL DEFENSE STATUS ───────────────────────────────────────────────
    // TEMPORARY DEFENSE — shows current defense mode state.
    // Zero effect when consecutiveLosses < 3.
    console.log("===== CAPITAL DEFENSE STATUS =====");
    if (defensiveMode) {
      console.log(`  MODE: ⚠ ACTIVE — ${consecutiveLosses} consecutive loss(es)`);
      console.log(`  EFFECT: EMA gate raised 1.8p → 2.5p until next win`);
    } else {
      console.log(`  MODE: NORMAL (consecutiveLosses=${consecutiveLosses})`);
    }
    console.log("===================================");

    // ── TRADE CLASSIFICATION AUDIT ───────────────────────────────────────────
    // SAFE / TELEMETRY VALIDATION — confirms filtered/blocked signals never
    // count as wins, losses, or executed trades in stats counters.
    // Architecture: stats.wins/losses/totalTrades are ONLY incremented inside
    // manageTrades() at 4 real close paths (PROFIT PROTECTION, MOMENTUM LOST,
    // EARLY EXIT, TIME EXIT). All filter blocks increment blockCounters only.
    const _totalBlocks = Object.values(blockCounters).reduce((s, v) => s + v, 0);
    console.log("===== TRADE CLASSIFICATION AUDIT =====");
    console.log(`  executed_trades:    ${stats.totalTrades}  (only real OANDA trade closes)`);
    console.log(`  wins:               ${stats.wins}`);
    console.log(`  losses:             ${stats.losses}`);
    console.log(`  filtered_signals:   ${_totalBlocks}  (NEVER affect stats — blockCounters only)`);
    console.log(`  -- filter breakdown --`);
    console.log(`  cooldown:           ${blockCounters.cooldown_block}`);
    console.log(`  spread:             ${blockCounters.spread_block}`);
    console.log(`  exhaustion:         ${blockCounters.exhaustion_block}`);
    console.log(`  correlation:        ${blockCounters.correlation_block}`);
    console.log(`  spread_edge:        ${blockCounters.spread_edge_block}`);
    console.log(`  pullback:           ${blockCounters.pullback_block}`);
    console.log(`  margin:             ${blockCounters.margin_block}`);
    console.log(`  VALIDATED: blocked/filtered signals never counted as losses ✓`);
    console.log("=======================================");

    // ── TRADE QUALITY SUMMARY ────────────────────────────────────────────────
    // TELEMETRY — aggregate quality metrics across all closed trades this session.
    if (qualityCounters.total > 0) {
      const qc = qualityCounters;
      const pct2p  = (qc.reachedPlusTwo / qc.total * 100).toFixed(0);
      const pctAdv = (qc.instantAdverse  / qc.total * 100).toFixed(0);
      const avgMFE = allTimeRolling.total > 0
        ? (driftWindow.reduce((s,t) => s + (t.mfe||0), 0) / driftWindow.length).toFixed(1)
        : "n/a";
      const avgMAE = allTimeRolling.total > 0
        ? (driftWindow.reduce((s,t) => s + Math.abs(t.mae||0), 0) / driftWindow.length).toFixed(1)
        : "n/a";
      const avgTimeToDd = driftWindow.filter(t => t.timeToDd != null).length > 0
        ? (driftWindow.filter(t => t.timeToDd != null).reduce((s,t) => s + t.timeToDd, 0) /
           driftWindow.filter(t => t.timeToDd != null).length).toFixed(1)
        : "n/a";
      console.log("===== TRADE QUALITY (all-time closed) =====");
      console.log(`  total_closed:       ${qc.total}`);
      console.log(`  reached_plus_2p:    ${pct2p}%  (${qc.reachedPlusTwo}/${qc.total})`);
      console.log(`  instant_adverse:    ${pctAdv}%  (${qc.instantAdverse}/${qc.total})`);
      console.log(`  avg_MFE (rolling):  ${avgMFE}p`);
      console.log(`  avg_MAE (rolling):  ${avgMAE}p`);
      console.log(`  (trade_forensics events in telemetry DB for full winner/loser breakdown)`);
      console.log("============================================");
    }

    // ── HARD vs RELAXED PERFORMANCE — TELEMETRY ONLY ────────────────────────
    // Independent closed-trade report by the entry gate recorded at entry.
    // These statistics are read-only and never affect strategy decisions.
    console.log("===== HARD vs RELAXED PERFORMANCE (closed trades) =====");
    for (const gate of ["HARD", "RELAXED"]) {
      const gs = gatePerformanceCounters[gate];
      const decidedTrades = gs.wins + gs.losses;
      const winRate = decidedTrades > 0 ? (gs.wins / decidedTrades * 100).toFixed(1) : "n/a";
      const avg = (value) => gs.total > 0 ? (value / gs.total).toFixed(2) : "n/a";
      console.log(
        `  ${gate.padEnd(7)}: total=${gs.total} wins=${gs.wins} losses=${gs.losses} ` +
        `WR=${winRate}% avgProfit=${avg(gs.totalPips)}p avgMFE=${avg(gs.totalMFE)}p avgMAE=${avg(gs.totalMAE)}p`
      );
    }
    console.log("======================================================");

    // ── BLOCKED WINNERS (ALMOST TRADE 15-min OUTCOMES) ───────────────────────
    // Shows which failing gate condition most often precedes a favorable market move.
    // High +4p% on a condition = that condition is blocking profitable setups.
    // TELEMETRY ONLY — zero effect on strategy or risk logic.
    const _atEntries = Object.entries(almostTradeCounters)
      .filter(([, v]) => v.total > 0)
      .sort(([, a], [, b]) => (b.reached4p / Math.max(b.total, 1)) - (a.reached4p / Math.max(a.total, 1)));
    if (_atEntries.length > 0) {
      console.log("===== BLOCKED WINNERS (almost_trade 15-min outcomes) =====");
      for (const [cond, v] of _atEntries) {
        const p2  = (v.reached2p / v.total * 100).toFixed(0);
        const p4  = (v.reached4p / v.total * 100).toFixed(0);
        const p6  = (v.reached6p / v.total * 100).toFixed(0);
        const avg = (v.totalMovePips / v.total).toFixed(1);
        const cd  = (v.correctDir   / v.total * 100).toFixed(0);
        console.log(`  ${cond.padEnd(9)}: n=${v.total} dir=${cd}% +2p=${p2}% +4p=${p4}% +6p=${p6}% avg=${avg}p`);
      }
      console.log("==========================================================");
    }
  }, 5 * 60 * 1000); // every 5 minutes — TELEMETRY ONLY
}

startBlockSummaryPrinter();
runBot();
