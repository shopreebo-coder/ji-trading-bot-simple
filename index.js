require("dotenv").config();
const axios = require("axios");

console.log("FOREX ENGINE PRO v39.1 (BALANCED MTF)");

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const BASE_URL =
  process.env.OANDA_ENV === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";

const SYMBOLS = process.env.SYMBOLS.split(",");

const MAIN_TIMEFRAME = process.env.TIMEFRAME || "M5";
const ENTRY_TIMEFRAME = "M1";

const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || "0.01");
const MAX_OPEN_TRADES = parseInt(process.env.MAX_OPEN_TRADES || "1");
const MAX_DAILY_TRADES = parseInt(process.env.MAX_DAILY_TRADES || "3");

console.log(`MAX_OPEN_TRADES=${MAX_OPEN_TRADES}`);
console.log(`MAX_DAILY_TRADES=${MAX_DAILY_TRADES}`);
console.log(`SYMBOLS=${SYMBOLS}`);

// ─── CORRELATION MAP ─────────────────────────────────────────────────────────

const CORRELATED = {
  EUR_USD: ["GBP_USD"],
  GBP_USD: ["EUR_USD"],
  AUD_USD: ["NZD_USD"],
  NZD_USD: ["AUD_USD"]
};

// ─── HEADERS ─────────────────────────────────────────────────────────────────

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

// ─── STATE ────────────────────────────────────────────────────────────────────

let dailyTrades = 0;
let lastTradeDay = new Date().getUTCDate();
const cooldownMap = {};
const tradeLocks = {};
const tradePeak = {};
const stats = { wins: 0, losses: 0, totalTrades: 0 };

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pipMultiplier(symbol) {
  return symbol.includes("JPY") ? 0.01 : 0.0001;
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────

function ema(data, period) {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  let emaArray = [data[0]];
  for (let i = 1; i < data.length; i++) {
    emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].mid.h);
    const low = parseFloat(candles[i].mid.l);
    const prevClose = parseFloat(candles[i - 1].mid.c);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ─── CANDLE HELPERS ───────────────────────────────────────────────────────────

function bullishCandle(candle) {
  return parseFloat(candle.mid.c) > parseFloat(candle.mid.o);
}

function bearishCandle(candle) {
  return parseFloat(candle.mid.c) < parseFloat(candle.mid.o);
}

function candleBodySize(candle) {
  return Math.abs(parseFloat(candle.mid.c) - parseFloat(candle.mid.o));
}

// ─── OANDA API ────────────────────────────────────────────────────────────────

async function getCandles(symbol, count = 100, granularity = MAIN_TIMEFRAME) {
  try {
    const url = `${BASE_URL}/v3/instruments/${symbol}/candles`;
    const res = await axios.get(url, {
      headers,
      params: { granularity, count, price: "M" }
    });
    return res.data.candles || [];
  } catch (err) {
    console.log(`Candles error ${symbol}`, err.message);
    return [];
  }
}

async function getOpenTrades() {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/openTrades`,
      { headers }
    );
    return res.data.trades || [];
  } catch (err) {
    console.log("Open trades error", err.message);
    return [];
  }
}

async function hasOpenTrade(symbol) {
  const trades = await getOpenTrades();
  return trades.some(trade => trade.instrument === symbol);
}

async function getAccountInfo() {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/summary`,
      { headers }
    );
    return {
      balance: parseFloat(res.data.account.balance),
      marginUsed: parseFloat(res.data.account.marginUsed)
    };
  } catch (err) {
    console.log("Account info error", err.message);
    return { balance: 100, marginUsed: 0 };
  }
}

// ─── RISK CALCULATION ─────────────────────────────────────────────────────────

function calculateUnits(balance, stopLossPips, symbol) {
  const riskAmount = balance * RISK_PERCENT;
  const pipValuePerUnit = pipMultiplier(symbol);
  const units = riskAmount / (stopLossPips * pipValuePerUnit);
  return Math.max(Math.floor(units), 1);
}

// ─── TRADE EXECUTION ──────────────────────────────────────────────────────────

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
      { headers, params: { instruments: symbol } }
    );

    const price =
      side === "buy"
        ? parseFloat(priceData.data.prices[0].asks[0].price)
        : parseFloat(priceData.data.prices[0].bids[0].price);

    const pipMult = pipMultiplier(symbol);

    const stopLoss =
      side === "buy"
        ? price - slPips * pipMult
        : price + slPips * pipMult;

    const takeProfit =
      side === "buy"
        ? price + tpPips * pipMult
        : price - tpPips * pipMult;

    const body = {
      order: {
        instrument: symbol,
        units: side === "buy" ? `${units}` : `-${units}`,
        type: "MARKET",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: stopLoss.toFixed(5) },
        takeProfitOnFill: { price: takeProfit.toFixed(5) }
      }
    };

    await axios.post(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/orders`,
      body,
      { headers }
    );

    console.log(`Trade -> ${symbol} ${side.toUpperCase()}`);

    cooldownMap[symbol] = Date.now();
    dailyTrades++;
    console.log(`dailyTrades=${dailyTrades}`);

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
      { headers }
    );
  } catch (err) {
    console.log("Close trade error", err.message);
  }
}

// ─── TRADE MANAGEMENT ─────────────────────────────────────────────────────────

async function manageTrades() {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const symbol = trade.instrument;
      const currentUnits = parseFloat(trade.currentUnits);
      const side = currentUnits > 0 ? "buy" : "sell";
      const openPrice = parseFloat(trade.price);
      const pipMult = pipMultiplier(symbol);

      const currentPriceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        { headers, params: { instruments: symbol } }
      );

      const current =
        side === "buy"
          ? parseFloat(currentPriceData.data.prices[0].bids[0].price)
          : parseFloat(currentPriceData.data.prices[0].asks[0].price);

      let pips =
        side === "buy"
          ? (current - openPrice) / pipMult
          : (openPrice - current) / pipMult;

      console.log(`${symbol} -> ${pips.toFixed(1)} pips`);

      // PEAK PROFIT TRACKER
      if (!tradePeak[trade.id] || pips > tradePeak[trade.id]) {
        tradePeak[trade.id] = pips;
      }
      const peak = tradePeak[trade.id];

      // MOMENTUM LOSS EXIT
      if (peak >= 2 && peak - pips >= 0.5) {
        console.log(`MOMENTUM LOST -> ${symbol}`);
        if (pips > 0) { stats.wins++; } else { stats.losses++; }
        stats.totalTrades++;
        await closeTrade(trade.id);
        delete tradePeak[trade.id];
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // BREAK EVEN at +5 pips
      if (pips >= 5) {
        const breakEven =
          side === "buy"
            ? openPrice + 2 * pipMult
            : openPrice - 2 * pipMult;

        const currentSL = parseFloat(trade.stopLossOrder?.price || 0);
        const targetBE = parseFloat(breakEven.toFixed(5));

        const shouldMoveBE =
          side === "buy"
            ? currentSL < targetBE
            : currentSL > targetBE || currentSL === 0;

        if (shouldMoveBE) {
          await axios.put(
            `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${trade.id}/orders`,
            { stopLoss: { price: targetBE.toFixed(5) } },
            { headers }
          );
          console.log(`BREAK EVEN -> ${symbol}`);
        }
      }

      // TRAILING STOP at +10 pips
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
            { headers }
          );
          console.log(`Trailing SL -> ${symbol}`);
        }
      }

      // EARLY EXIT at -4 pips
      if (pips <= -4) {
        console.log(`EARLY EXIT -> ${symbol}`);
        await closeTrade(trade.id);
        stats.losses++;
        stats.totalTrades++;
        cooldownMap[symbol] = Date.now();
        continue;
      }

      // MAX TIME EXIT: 5 min open with < 2 pips profit
      const openTime = new Date(trade.openTime).getTime();
      const minutesOpen = (Date.now() - openTime) / 1000 / 60;

      if (minutesOpen >= 5 && pips < 2) {
        console.log(`MAX TIME EXIT -> ${symbol}`);
        await closeTrade(trade.id);
        cooldownMap[symbol] = Date.now();
      }
    } catch (err) {
      console.log("Manage trade error", err.message);
    }
  }
}

// ─── SIGNAL EVALUATION ────────────────────────────────────────────────────────

/**
 * Evaluates buy/sell signals for a single symbol.
 * Returns { signal: "buy"|"sell"|null, reason: string }
 */
function evaluateSignal(params) {
  const {
    symbol,
    lastFast, lastSlow, lastClose, lastCandle,
    emaDistance, candleStrength,
    m1LastFast, m1LastSlow, m1LastClose,
    m1Bullish, m1Bearish
  } = params;

  const pipMult = pipMultiplier(symbol);
  const m1Spread = m1LastFast - m1LastSlow;

  // ── BUY CONDITIONS ──────────────────────────────────────────────────────
  const buyConditions = {
    "M5 trend up (EMA20 > EMA50)": lastFast > lastSlow,
    "M5 close above EMA20":        lastClose > lastFast,
    "M5 bullish candle":           bullishCandle(lastCandle),
    "EMA distance > 1 pip":        emaDistance > 1,
    "Candle strength > 0.04":      candleStrength > 0.04,
    "M1 trend up (EMA9 > EMA21)":  m1LastFast > m1LastSlow,
    "M1 bullish candle":           m1Bullish,
    "M1 close above M1 EMA9":      m1LastClose > m1LastFast,
    "M1 EMA spread > 0.1 pip":     m1Spread > 0.1 * pipMult
  };

  // ── SELL CONDITIONS ─────────────────────────────────────────────────────
  const sellConditions = {
    "M5 trend down (EMA20 < EMA50)": lastFast < lastSlow,
    "M5 close below EMA20":          lastClose < lastFast,
    "M5 bearish candle":             bearishCandle(lastCandle),
    "EMA distance > 1 pip":          emaDistance > 1,
    "Candle strength > 0.04":        candleStrength > 0.04,
    "M1 trend down (EMA9 < EMA21)":  m1LastFast < m1LastSlow,
    "M1 bearish candle":             m1Bearish,
    "M1 close below M1 EMA9":        m1LastClose < m1LastFast,
    "M1 EMA spread > 0.1 pip":      -m1Spread > 0.1 * pipMult
  };

  const allBuy  = Object.values(buyConditions).every(Boolean);
  const allSell = Object.values(sellConditions).every(Boolean);

  if (allBuy) {
    return { signal: "buy", reason: null };
  }

  if (allSell) {
    return { signal: "sell", reason: null };
  }

  // Log which conditions blocked entry
  const failedBuy  = Object.entries(buyConditions).filter(([, v]) => !v).map(([k]) => k);
  const failedSell = Object.entries(sellConditions).filter(([, v]) => !v).map(([k]) => k);

  const bestFit =
    failedBuy.length <= failedSell.length ? "BUY" : "SELL";

  const failed = bestFit === "BUY" ? failedBuy : failedSell;

  return {
    signal: null,
    reason: `${bestFit} blocked — failed: [${failed.join(", ")}]`
  };
}

// ─── STRATEGY ─────────────────────────────────────────────────────────────────

async function strategy(symbol) {
  try {
    // COOLDOWN CHECK
    const cooldown = 20 * 60 * 1000;
    if (cooldownMap[symbol] && Date.now() - cooldownMap[symbol] <= cooldown) {
      console.log(`Cooldown active -> ${symbol}`);
      return;
    }

    // OPEN TRADE CHECK
    const existingTrade = await hasOpenTrade(symbol);
    if (existingTrade) {
      return;
    }

    // CORRELATION FILTER
    const openTrades = await getOpenTrades();
    for (const trade of openTrades) {
      if (CORRELATED[symbol]?.includes(trade.instrument)) {
        console.log(`CORRELATION BLOCK -> ${symbol} (open: ${trade.instrument})`);
        return;
      }
    }

    // M5 CANDLE DATA
    const candles = await getCandles(symbol, 100, MAIN_TIMEFRAME);
    if (candles.length < 60) {
      console.log(`Not enough M5 candles -> ${symbol} (got ${candles.length})`);
      return;
    }

    const closes   = candles.map(c => parseFloat(c.mid.c));
    const emaFast  = ema(closes, 20);
    const emaSlow  = ema(closes, 50);

    if (emaFast.length < 1 || emaSlow.length < 1) {
      console.log(`EMA calculation failed -> ${symbol}`);
      return;
    }

    const lastClose = closes[closes.length - 1];
    const lastFast  = emaFast[emaFast.length - 1];
    const lastSlow  = emaSlow[emaSlow.length - 1];
    const lastCandle = candles[candles.length - 1];

    // ATR
    const atr = calculateATR(candles);
    if (!atr || atr === 0) {
      console.log(`ATR calculation failed -> ${symbol}`);
      return;
    }

    const emaDistance   = Math.abs(lastFast - lastSlow) / pipMultiplier(symbol);
    const candleStrength = candleBodySize(lastCandle) / atr;

    // M1 CANDLE DATA
    const m1Candles = await getCandles(symbol, 50, ENTRY_TIMEFRAME);
    if (m1Candles.length < 30) {
      console.log(`Not enough M1 candles -> ${symbol} (got ${m1Candles.length})`);
      return;
    }

    const m1Closes  = m1Candles.map(c => parseFloat(c.mid.c));
    const m1Fast    = ema(m1Closes, 9);
    const m1Slow    = ema(m1Closes, 21);

    if (m1Fast.length < 1 || m1Slow.length < 1) {
      console.log(`M1 EMA calculation failed -> ${symbol}`);
      return;
    }

    const m1LastFast   = m1Fast[m1Fast.length - 1];
    const m1LastSlow   = m1Slow[m1Slow.length - 1];
    const m1LastCandle = m1Candles[m1Candles.length - 1];
    const m1LastClose  = m1Closes[m1Closes.length - 1];
    const m1Bullish    = bullishCandle(m1LastCandle);
    const m1Bearish    = bearishCandle(m1LastCandle);

    // RISK PARAMETERS
    const stopLossPips =
      Math.max(Math.floor((atr / pipMultiplier(symbol)) * 1.5), 12);
    const takeProfitPips = Math.floor(stopLossPips * 1.8);

    // ACCOUNT / MARGIN CHECK
    const account = await getAccountInfo();
    const balance = account.balance;
    const marginPercent = (account.marginUsed / account.balance) * 100;

    console.log(`MARGIN -> ${marginPercent.toFixed(1)}%`);

    if (marginPercent > 50) {
      console.log(`MARGIN PROTECTION ACTIVE -> ${symbol}`);
      return;
    }

    const units = calculateUnits(balance, stopLossPips, symbol);

    // SIGNAL DEBUG SUMMARY
    console.log(
      `${symbol} | EMA_DIST=${emaDistance.toFixed(1)} | ` +
      `CANDLE_STR=${candleStrength.toFixed(2)} | ` +
      `ATR=${atr.toFixed(5)} | ` +
      `M1_FAST=${m1LastFast.toFixed(5)} | ` +
      `M1_SLOW=${m1LastSlow.toFixed(5)} | ` +
      `M1_CLOSE=${m1LastClose.toFixed(5)}`
    );

    // SIGNAL EVALUATION
    const { signal, reason } = evaluateSignal({
      symbol,
      lastFast, lastSlow, lastClose, lastCandle,
      emaDistance, candleStrength,
      m1LastFast, m1LastSlow, m1LastClose,
      m1Bullish, m1Bearish
    });

    if (!signal) {
      console.log(`NO SIGNAL -> ${symbol} | ${reason}`);
      return;
    }

    console.log(`MTF ${signal.toUpperCase()} CONFIRMED -> ${symbol}`);

    await placeTrade(symbol, signal, units, stopLossPips, takeProfitPips);

  } catch (err) {
    console.log(`Strategy error ${symbol}`, err.message);
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function runBot() {
  while (true) {
    try {
      const now = new Date();
      const day  = now.getUTCDay();
      const hour = now.getUTCHours();

      // MARKET HOURS CHECK (closed Saturday + Sunday before 21:00 UTC)
      if (day === 6 || (day === 0 && hour < 21)) {
        console.log("FOREX CLOSED");
        await sleep(600000);
        continue;
      }

      // DAILY TRADE COUNTER RESET
      const currentDay = new Date().getUTCDate();
      if (currentDay !== lastTradeDay) {
        dailyTrades = 0;
        lastTradeDay = currentDay;
      }

      // DAILY LIMIT CHECK
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
        stats.wins = 0;
        stats.losses = 0;
        stats.totalTrades = 0;
        console.log("MAX DAILY TRADES REACHED");
        await manageTrades();
        await sleep(60000);
        continue;
      }

      // MAX OPEN TRADES CHECK
      const openTrades = await getOpenTrades();
      if (openTrades.length >= MAX_OPEN_TRADES) {
        await manageTrades();
        await sleep(5000);
        continue;
      }

      // SYMBOL LOOP
      for (const symbol of SYMBOLS) {
        await strategy(symbol);
        await sleep(5000);
      }

      // MANAGE OPEN TRADES
      await manageTrades();

      // MAIN LOOP DELAY
      await sleep(5000);
    } catch (err) {
      console.log("Main loop error", err.message);
      await sleep(10000);
    }
  }
}

runBot();
