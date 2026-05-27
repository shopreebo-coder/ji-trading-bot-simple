require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto"); // signalId generation — TELEMETRY ONLY

// Telemetry — loaded with fallback so bot works even without better-sqlite3
let logEvent = () => {};
try {
  logEvent = require("./telemetry").logEvent;
} catch (e) {
  console.error("[TELEMETRY] Not loaded:", e.message);
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

console.log(`MAX_OPEN_TRADES=${MAX_OPEN_TRADES}`);
console.log(`MAX_DAILY_TRADES=${MAX_DAILY_TRADES}`);
console.log(`SYMBOLS=${SYMBOLS}`);

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

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

// ── MAE / MFE telemetry — TELEMETRY ONLY ────────────────────────────────────
const tradeMAE             = {};  // max adverse excursion (most negative pips seen)
const tradeTimeToProfit    = {};  // minutes from open until pips first went > 0
const tradeTimeToDd        = {};  // minutes from open until pips first went < 0
const tradeBeTime          = {};  // minutes from open until break-even SL was moved
const tradePostEntryLogged = {};  // flag: post_entry_failure fired for this trade

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
// win rate deviates >20% from all-time. NO auto-adjustment.
function recordClosedTrade({ win, pips, mfe, duration }) {
  allTimeRolling.total++;
  allTimeRolling.totalPips += (pips || 0);
  if (win) allTimeRolling.wins++;

  driftWindow.push({ win, pips: pips || 0, mfe: mfe || 0, duration: duration || 0 });
  if (driftWindow.length > 20) driftWindow.shift();

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
}

// ── BLOCKED OUTCOME CHECKER — TELEMETRY ONLY ─────────────────────────────────
// Runs each main loop cycle. For blocked signals older than 15 min, fetches
// current price and emits blocked_outcome showing what the market did after
// the filter fired. Purpose: measure whether filters protect or destroy edge.
// NO strategy logic reads blocked_outcome events.
async function checkBlockedOutcomes() {
  const now      = Date.now();
  const DELAY_MS = 15 * 60 * 1000;
  let   processed = 0;

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
      processed++;
    } catch (_) {
      // silent — telemetry failure never affects bot
    }
    delete blockedSignals[id];
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
      }

      // PEAK PROFIT TRACKER
      if (!tradePeak[trade.id] || pips > tradePeak[trade.id]) {
        tradePeak[trade.id] = pips;
        console.log(`${symbol} PEAK -> ${pips.toFixed(2)}`);
      }

      const peak = tradePeak[trade.id];

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

      // ── POST-ENTRY FAILURE DETECTION — TELEMETRY ONLY ────────────────────
      // Fires once if trade drops >1.5 pips adverse within first 3 minutes.
      if (minutesOpen < 3 && pips < -1.5 && !tradePostEntryLogged[trade.id]) {
        tradePostEntryLogged[trade.id] = true;
        logEvent({
          type:        "post_entry_failure",
          signalId:    tradeSignalId[trade.id] || null,
          symbol,
          pips:        parseFloat(pips.toFixed(2)),
          minutesOpen: parseFloat(minutesOpen.toFixed(2)),
          mae:         parseFloat((tradeMAE[trade.id] ?? pips).toFixed(2)),
          session:     classifySession(new Date().getUTCHours()),
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
        return {
          type:                 "trade_close",
          signalId:             tradeSignalId[trade.id] || null,
          symbol,
          profitPips:           pips,
          peak,
          duration:             minutesOpen,
          reason,
          outcome:              pips < 0 ? "LOSS" : pips <= 1.0 ? "BREAKEVEN" : "WIN",
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
          // SESSION — TELEMETRY ONLY
          session:              classifySession(new Date().getUTCHours()),
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
      }

      // ── PROFIT PROTECTION ─────────────────────────────────────────────────
      if (peak >= 6 && pips < peak - 3) {
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
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, duration: minutesOpen });

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
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, duration: minutesOpen });

        await closeTrade(trade.id);
        cleanupTradeState();
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // ── BREAK EVEN — triggers at +3 pips, moves SL to +0.5 pip above entry ─
   if (pips >= 5) {
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

      // ── EARLY EXIT ────────────────────────────────────────────────────────
      if (pips <= -4) {
        const reason = "EARLY EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: false, pips, mfe: peak, duration: minutesOpen });

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
      if (minutesOpen >= 10 && pips < 2) {
        const reason = "TIME EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        logEvent(buildClosePayload(reason));
        recordClosedTrade({ win: pips > 1.0, pips, mfe: peak, duration: minutesOpen });

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

    // ── COOLDOWN ──────────────────────────────────────────────────────────
    const cooldown = 10 * 60 * 1000;
    if (cooldownMap[symbol] && Date.now() - cooldownMap[symbol] <= cooldown) {
      console.log(`Cooldown -> ${symbol}`);
      logEvent({ type: "signal_filtered", signalId, symbol, session, reason: "cooldown_block" });
      logEvent({ type: "cooldown_block", signalId, symbol, session });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "cooldown_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }

    // ── OPEN TRADE CHECK ─────────────────────────────────────────────────
    const existingTrade = await hasOpenTrade(symbol);
    if (existingTrade) {
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

    // ── REAL SPREAD FILTER ────────────────────────────────────────────────
    const spread       = await getSpread(symbol);
    const spreadPctile = getSpreadPercentile(symbol, spread);

    console.log(`${symbol} SPREAD -> ${spread.toFixed(2)} pips`);

    if (spread > 1.5) {
      console.log(`SPREAD BLOCK -> ${symbol}`);
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

    // ── M5 ANALYSIS ───────────────────────────────────────────────────────
    const candles = await getCandles(symbol, 100, MAIN_TIMEFRAME);
    if (candles.length < 60) {
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

    if (candleStrength > 0.65) {
      console.log(`EXHAUSTION BLOCK -> ${symbol} reason=candle_overexpanded expansion=${candleStrength.toFixed(2)}`);
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "exhaustion_block", subReason: "candle_overexpanded",
      });
      logEvent({
        type:             "exhaustion_block",
        signalId, symbol, session,
        reason:           "candle_overexpanded",
        expansionRatio:   parseFloat(candleStrength.toFixed(3)),
        priceStretchPips: parseFloat(priceStretchPips.toFixed(2)),
        atrPips:          parseFloat(atrPips.toFixed(2)),
        volatilityBucket: volBkt,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "exhaustion_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }

    if (priceStretchPips > atrPips * 0.5) {
      console.log(`EXHAUSTION BLOCK -> ${symbol} reason=price_overextended stretch=${priceStretchPips.toFixed(2)} atr=${atrPips.toFixed(2)}`);
      logEvent({
        type: "signal_filtered", signalId, symbol, session,
        reason: "exhaustion_block", subReason: "price_overextended",
      });
      logEvent({
        type:             "exhaustion_block",
        signalId, symbol, session,
        reason:           "price_overextended",
        expansionRatio:   parseFloat(candleStrength.toFixed(3)),
        priceStretchPips: parseFloat(priceStretchPips.toFixed(2)),
        atrPips:          parseFloat(atrPips.toFixed(2)),
        volatilityBucket: volBkt,
      });
      if (lastMidPrice[symbol]) {
        blockedSignals[signalId] = {
          signalId, symbol, blockType: "exhaustion_block",
          blockTime: Date.now(), blockPrice: lastMidPrice[symbol],
        };
      }
      return;
    }

    // ── MINIMUM EDGE FILTER — STRATEGY CHANGE (approved: stabilization) ───
    const expectedCapturePips = atrPips * 0.30;
    const edgeRatio           = expectedCapturePips / spread;
    if (edgeRatio < 1.8) {
      console.log(`SPREAD_EDGE BLOCK -> ${symbol} edge=${edgeRatio.toFixed(2)} expected=${expectedCapturePips.toFixed(2)}p spread=${spread.toFixed(2)}p`);
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

    // PULLBACK FILTER — reject entries where price is more than 1 pip from EMA9
    if (entryDistance > 1) {
      console.log(`PULLBACK BLOCK -> ${symbol} distance=${entryDistance.toFixed(2)}`);
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
      logEvent({ type: "margin_block", signalId, symbol, session, marginPercent });
      return;
    }

    // SAFETY CAP — 500 units max for small account
    const units = Math.min(calculateUnits(balance, stopLossPips, symbol), 500);

    // DEBUG
    console.log(`${symbol} EMA DIST -> ${emaDistance.toFixed(1)}`);
    console.log(`${symbol} CANDLE STR -> ${candleStrength.toFixed(2)}`);
    console.log(`${symbol} M1 FAST -> ${m1LastFast.toFixed(5)}`);

    console.log(`${symbol} BUY CHECK:`);
    console.log(
      `trend=${lastFast > lastSlow}\ncandle=${bullishCandle(lastCandle)}\nema=${emaDistance > 1.8}\nstrength=${candleStrength > 0.12}\nm1trend=${m1LastFast > m1LastSlow}\nm1candle=${m1Bullish}\nm1prev=${bullishCandle(m1PrevCandle)}\nm1close=${m1LastClose > m1LastFast}\nspread=${spread.toFixed(2)} pips (limit 1.5)`,
    );

    console.log(`${symbol} SELL CHECK:`);
    console.log(
      `trend=${lastFast < lastSlow}\ncandle=${bearishCandle(lastCandle)}\nema=${emaDistance > 1.8}\nstrength=${candleStrength > 0.12}\nm1trend=${m1LastFast < m1LastSlow}\nm1candle=${m1Bearish}\nm1prev=${bearishCandle(m1PrevCandle)}\nm1close=${m1LastClose < m1LastFast}\nspread=${spread.toFixed(2)} pips (limit 1.5)`,
    );

    // BUY CHECK — log structured decision
    logEvent({
      type: "buy_check",
      signalId, symbol, session,
      trend:    lastFast > lastSlow,
      candle:   bullishCandle(lastCandle),
      ema:      emaDistance > 1.8,
      strength: candleStrength > 0.12,
      m1trend:  m1LastFast > m1LastSlow,
      m1candle: m1Bullish,
      m1prev:   bullishCandle(m1PrevCandle),
      m1close:  m1LastClose > m1LastFast,
      entryDistance, emaDistance, candleStrength, spread,
      volatilityBucket: volBkt, trendBucket: trendBkt,
      spreadBucket: spreadBkt, compressionBucket: comprBkt,
    });

    // SELL CHECK — log structured decision
    logEvent({
      type: "sell_check",
      signalId, symbol, session,
      trend:    lastFast < lastSlow,
      candle:   bearishCandle(lastCandle),
      ema:      emaDistance > 1.8,
      strength: candleStrength > 0.12,
      m1trend:  m1LastFast < m1LastSlow,
      m1candle: m1Bearish,
      m1prev:   bearishCandle(m1PrevCandle),
      m1close:  m1LastClose < m1LastFast,
      entryDistance, emaDistance, candleStrength, spread,
      volatilityBucket: volBkt, trendBucket: trendBkt,
      spreadBucket: spreadBkt, compressionBucket: comprBkt,
    });

    // DECISION FINGERPRINT — 6-char hash (T=true, F=false per condition)
    const _buyFp = {
      trend:    lastFast > lastSlow,
      candle:   bullishCandle(lastCandle),
      ema:      emaDistance > 1.8,
      strength: candleStrength > 0.12,
      m1trend:  m1LastFast > m1LastSlow,
      m1prev:   bullishCandle(m1PrevCandle),
    };
    const _sellFp = {
      trend:    lastFast < lastSlow,
      candle:   bearishCandle(lastCandle),
      ema:      emaDistance > 1.8,
      strength: candleStrength > 0.12,
      m1trend:  m1LastFast < m1LastSlow,
      m1prev:   bearishCandle(m1PrevCandle),
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

    // ── BUY ───────────────────────────────────────────────────────────────
    if (
      lastFast > lastSlow &&
      lastClose > lastFast &&
      bullishCandle(lastCandle) &&
      emaDistance > 1.8 &&
      candleStrength > 0.12 &&
      m1LastFast > m1LastSlow &&
      m1Bullish &&
      bullishCandle(m1PrevCandle) &&
      m1LastClose > m1LastFast
    ) {
      console.log(
        `=== TRADE OPEN ===\nWHY BUY ${symbol}:\nM5 trend: bullish (fast > slow)\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${atrPips.toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: trend + 2 bullish candles + close above fast EMA\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips} pips\nTP: ${takeProfitPips} pips\nRR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );
      console.log(`MTF BUY CONFIRMED -> ${symbol}`);

      symbolSignalId[symbol] = signalId;
      logEvent({
        type: "trade_open",
        signalId, symbol, session,
        side: "buy",
        ...fullSnapshot,
        stopLossPips, takeProfitPips,
        risk: RISK_PERCENT, units,
        fingerprint: _fpHash(_buyFp),
        fp: _buyFp,
      });

      await placeTrade(symbol, "buy", units, stopLossPips, takeProfitPips);
    }

    // ── SELL ──────────────────────────────────────────────────────────────
    if (
      lastFast < lastSlow &&
      lastClose < lastFast &&
      bearishCandle(lastCandle) &&
      emaDistance > 1.8 &&
      candleStrength > 0.12 &&
      m1LastFast < m1LastSlow &&
      m1Bearish &&
      bearishCandle(m1PrevCandle) &&
      m1LastClose < m1LastFast
    ) {
      console.log(
        `=== TRADE OPEN ===\nWHY SELL ${symbol}:\nM5 trend: bearish (fast < slow)\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${atrPips.toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: trend + 2 bearish candles + close below fast EMA\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips} pips\nTP: ${takeProfitPips} pips\nRR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );
      console.log(`MTF SELL CONFIRMED -> ${symbol}`);

      symbolSignalId[symbol] = signalId;
      logEvent({
        type: "trade_open",
        signalId, symbol, session,
        side: "sell",
        ...fullSnapshot,
        stopLossPips, takeProfitPips,
        risk: RISK_PERCENT, units,
        fingerprint: _fpHash(_sellFp),
        fp: _sellFp,
      });

      await placeTrade(symbol, "sell", units, stopLossPips, takeProfitPips);
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
        await checkBlockedOutcomes(); // TELEMETRY ONLY
        await sleep(60000);
        continue;
      }

      const openTrades = await getOpenTrades();
      if (openTrades.length >= MAX_OPEN_TRADES) {
        await manageTrades();
        await checkBlockedOutcomes(); // TELEMETRY ONLY
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

      // MAIN LOOP DELAY
      await sleep(5000);
    } catch (err) {
      console.log("Main loop error", err.message);
      await sleep(10000);
    }
  }
}

runBot();
