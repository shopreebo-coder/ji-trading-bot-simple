require("dotenv").config();
const axios = require("axios");

console.log("FOREX ENGINE PRO v39.1 (BALANCED MTF)");

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

const MAX_OPEN_TRADES = parseInt(process.env.MAX_OPEN_TRADES || "2");

const MAX_DAILY_TRADES = parseInt(process.env.MAX_DAILY_TRADES || "50");
console.log(`MAX_OPEN_TRADES=${MAX_OPEN_TRADES}`);

console.log(`MAX_DAILY_TRADES=${MAX_DAILY_TRADES}`);

console.log(`SYMBOLS=${SYMBOLS}`);
const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

let dailyTrades = 0;

let lastTradeDay = new Date().getUTCDate();

const cooldownMap = {};
const tradeLocks = {};
const stats = {
  wins: 0,
  losses: 0,
  totalTrades: 0,
  totalPeakPips: 0,
  totalDurationMin: 0,
};

const tradePeak = {};
const tradeBreakEven = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipMultiplier(symbol) {
  return symbol.includes("JPY") ? 0.01 : 0.0001;
}

async function getCandles(symbol, count = 100, granularity = MAIN_TIMEFRAME) {
  try {
    const url = `${BASE_URL}/v3/instruments/${symbol}/candles`;

    const res = await axios.get(url, {
      headers,
      params: {
        granularity,
        count,
        price: "M",
      },
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
    const high = parseFloat(candles[i].mid.h);

    const low = parseFloat(candles[i].mid.l);

    const prevClose = parseFloat(candles[i - 1].mid.c);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
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
async function getSpread(symbol) {
  try {
    const res = await axios.get(
      `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
      {
        headers,
        params: { instruments: symbol },
      },
    );

    const ask = parseFloat(res.data.prices[0].asks[0].price);
    const bid = parseFloat(res.data.prices[0].bids[0].price);

    return (ask - bid) / pipMultiplier(symbol);
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
      balance: parseFloat(res.data.account.balance),

      marginUsed: parseFloat(res.data.account.marginUsed),
    };
  } catch (err) {
    console.log("Account info error", err.message);

    return {
      balance: 100,
      marginUsed: 0,
    };
  }
}

function calculateUnits(balance, stopLossPips, symbol) {
  const riskAmount = balance * RISK_PERCENT;

  const pipValuePerUnit = symbol.includes("JPY") ? 0.01 : 0.0001;

  const units = riskAmount / (stopLossPips * pipValuePerUnit);

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
      {
        headers,
        params: {
          instruments: symbol,
        },
      },
    );

    const price =
      side === "buy"
        ? parseFloat(priceData.data.prices[0].asks[0].price)
        : parseFloat(priceData.data.prices[0].bids[0].price);

    const pipMult = pipMultiplier(symbol);

    const stopLoss =
      side === "buy" ? price - slPips * pipMult : price + slPips * pipMult;

    const takeProfit =
      side === "buy" ? price + tpPips * pipMult : price - tpPips * pipMult;

    const body = {
      order: {
        instrument: symbol,

        units: side === "buy" ? `${units}` : `-${units}`,

        type: "MARKET",

        positionFill: "DEFAULT",

        stopLossOnFill: {
          price: stopLoss.toFixed(5),
        },

        takeProfitOnFill: {
          price: takeProfit.toFixed(5),
        },
      },
    };

    await axios.post(`${BASE_URL}/v3/accounts/${ACCOUNT_ID}/orders`, body, {
      headers,
    });

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

async function manageTrades() {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const symbol = trade.instrument;

      const currentUnits = parseFloat(trade.currentUnits);

      const side = currentUnits > 0 ? "buy" : "sell";

      const openPrice = parseFloat(trade.price);

      const currentPriceData = await axios.get(
        `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/pricing`,
        {
          headers,
          params: {
            instruments: symbol,
          },
        },
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

      const openTime = new Date(trade.openTime).getTime();
      const now = Date.now();
      const minutesOpen = (now - openTime) / 1000 / 60;

      const breakEvenActive = !!tradeBreakEven[trade.id];

      // PEAK PROFIT TRACKER
      if (!tradePeak[trade.id] || pips > tradePeak[trade.id]) {
        tradePeak[trade.id] = pips;
        console.log(`${symbol} PEAK -> ${pips.toFixed(2)}`);
      }

      const peak = tradePeak[trade.id];

      // PROFIT PROTECTION
      if (peak >= 2 && pips < peak - 0.5) {
        const reason = "PROFIT PROTECTION";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        if (pips > 0) stats.wins++;
        else stats.losses++;

        stats.totalTrades++;
        stats.totalPeakPips += peak;
        stats.totalDurationMin += minutesOpen;

        await closeTrade(trade.id);

        delete tradePeak[trade.id];
        delete tradeBreakEven[trade.id];

        cooldownMap[symbol] = Date.now();

        continue;
      }

      // MOMENTUM EXIT
      if (peak >= 8 && peak - pips >= 3) {
        const reason = "MOMENTUM LOST";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        if (pips > 0) {
          stats.wins++;
        } else {
          stats.losses++;
        }

        stats.totalTrades++;
        stats.totalPeakPips += peak;
        stats.totalDurationMin += minutesOpen;

        await closeTrade(trade.id);

        delete tradePeak[trade.id];
        delete tradeBreakEven[trade.id];

        cooldownMap[symbol] = Date.now();

        continue;
      }

      // BREAK EVEN — triggers at +1.5 pips, moves SL to +0.5 pip above entry
      if (pips >= 1.5) {
        const breakEven =
          side === "buy"
            ? openPrice + 0.5 * pipMult
            : openPrice - 0.5 * pipMult;

        const currentSL = parseFloat(trade.stopLossOrder?.price || 0);

        const targetBE = parseFloat(breakEven.toFixed(5));

        const shouldMoveBE =
          side === "buy"
            ? currentSL < targetBE
            : currentSL > targetBE || currentSL === 0;

        if (shouldMoveBE) {
          await axios.put(
            `${BASE_URL}/v3/accounts/${ACCOUNT_ID}/trades/${trade.id}/orders`,
            {
              stopLoss: {
                price: targetBE.toFixed(5),
              },
            },
            { headers },
          );

          tradeBreakEven[trade.id] = true;
          console.log(`${symbol} BREAK EVEN ON`);
        }
      }

      // TRAILING STOP
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
            {
              stopLoss: {
                price: newSL.toFixed(5),
              },
            },
            { headers },
          );

          console.log(`Trailing SL -> ${symbol}`);
        }
      }

      // EARLY EXIT
      if (pips <= -4) {
        const reason = "EARLY EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        await closeTrade(trade.id);
        stats.losses++;
        stats.totalTrades++;
        stats.totalPeakPips += peak;
        stats.totalDurationMin += minutesOpen;

        delete tradePeak[trade.id];
        delete tradeBreakEven[trade.id];

        cooldownMap[symbol] = Date.now();

        continue;
      }

      // MAX TIME EXIT
      if (minutesOpen >= 10 && pips < 2) {
        const reason = "TIME EXIT";
        console.log(
          `EXIT ${symbol}\nreason=${reason}\nprofit=${pips.toFixed(2)}\npeak=${peak.toFixed(2)}\nminutes=${minutesOpen.toFixed(1)}\nbreakEven=${breakEvenActive}`,
        );

        await closeTrade(trade.id);

        stats.totalTrades++;
        stats.totalPeakPips += peak;
        stats.totalDurationMin += minutesOpen;

        if (pips > 0) {
          stats.wins++;
        } else {
          stats.losses++;
        }

        delete tradePeak[trade.id];
        delete tradeBreakEven[trade.id];

        cooldownMap[symbol] = Date.now();
      }
    } catch (err) {
      console.log("Manage trade error", err.message);
    }
  }
}

async function strategy(symbol) {
  try {
    // COOLDOWN
    const cooldown = 10 * 60 * 1000;

    if (cooldownMap[symbol] && Date.now() - cooldownMap[symbol] <= cooldown) {
      console.log(`Cooldown -> ${symbol}`);
      return;
    }

    // OPEN TRADE CHECK
    const existingTrade = await hasOpenTrade(symbol);

    if (existingTrade) {
      return;
    }

    // CORRELATION FILTER
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

        return;
      }
    }

    // REAL SPREAD FILTER
    const spread = await getSpread(symbol);

    console.log(`${symbol} SPREAD -> ${spread.toFixed(2)} pips`);

    if (spread > 1.5) {
      console.log(`SPREAD BLOCK -> ${symbol}`);
      return;
    }

    // M5 ANALYSIS
    const candles = await getCandles(symbol, 100, MAIN_TIMEFRAME);

    if (candles.length < 60) {
      return;
    }

    const closes = candles.map((c) => parseFloat(c.mid.c));

    const emaFast = ema(closes, 20);

    const emaSlow = ema(closes, 50);

    const lastClose = closes[closes.length - 1];

    const lastFast = emaFast[emaFast.length - 1];

    const lastSlow = emaSlow[emaSlow.length - 1];

    const lastCandle = candles[candles.length - 1];

    // ATR
    const atr = calculateATR(candles);

    // EMA DISTANCE
    const emaDistance = Math.abs(lastFast - lastSlow) / pipMultiplier(symbol);

    // CANDLE STRENGTH
    const candleStrength = candleBodySize(lastCandle) / atr;

    // M1 CONFIRMATION
    const m1Candles = await getCandles(symbol, 50, ENTRY_TIMEFRAME);

    if (m1Candles.length < 30) {
      return;
    }

    const m1Closes = m1Candles.map((c) => parseFloat(c.mid.c));

    const m1Fast = ema(m1Closes, 9);

    const m1Slow = ema(m1Closes, 21);

    const m1LastFast = m1Fast[m1Fast.length - 1];

    const m1LastSlow = m1Slow[m1Slow.length - 1];

    const m1LastCandle = m1Candles[m1Candles.length - 1];

    const m1PrevCandle = m1Candles[m1Candles.length - 2];

    const m1Bullish = bullishCandle(m1LastCandle);

    const m1Bearish = bearishCandle(m1LastCandle);

    const m1LastClose = m1Closes[m1Closes.length - 1];

    // RISK
    const stopLossPips = Math.max(
      Math.floor((atr / pipMultiplier(symbol)) * 1.5),
      8,
    );

    const takeProfitPips = Math.floor(stopLossPips * 1.2);

    const account = await getAccountInfo();

    const balance = account.balance;

    const marginPercent = (account.marginUsed / account.balance) * 100;

    console.log(`MARGIN -> ${marginPercent.toFixed(1)}%`);

    if (marginPercent > 50) {
      console.log("MARGIN PROTECTION ACTIVE");

      return;
    }

    // SAFETY CAP — 500 units max for small account
    const units = Math.min(
      calculateUnits(balance, stopLossPips, symbol),
      500,
    );

    // DEBUG
    console.log(`${symbol} EMA DIST -> ${emaDistance.toFixed(1)}`);

    console.log(`${symbol} CANDLE STR -> ${candleStrength.toFixed(2)}`);

    console.log(`${symbol} M1 FAST -> ${m1LastFast.toFixed(5)}`);

    console.log(`${symbol} BUY CHECK:`);

    console.log(
      `trend=${lastFast > lastSlow}
candle=${bullishCandle(lastCandle)}
ema=${emaDistance > 1.8}
strength=${candleStrength > 0.12}
m1trend=${m1LastFast > m1LastSlow}
m1candle=${m1Bullish}
m1prev=${bullishCandle(m1PrevCandle)}
m1close=${m1LastClose > m1LastFast}
spread=${spread.toFixed(2)} pips (limit 1.5)`,
    );

    console.log(`${symbol} SELL CHECK:`);

    console.log(
      `trend=${lastFast < lastSlow}
candle=${bearishCandle(lastCandle)}
ema=${emaDistance > 1.8}
strength=${candleStrength > 0.12}
m1trend=${m1LastFast < m1LastSlow}
m1candle=${m1Bearish}
m1prev=${bearishCandle(m1PrevCandle)}
m1close=${m1LastClose < m1LastFast}
spread=${spread.toFixed(2)} pips (limit 1.5)`,
    );

    // BUY
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
        `=== TRADE OPEN ===\nWHY BUY ${symbol}:\nM5 trend: bullish (fast > slow)\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${(atr / pipMultiplier(symbol)).toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: trend + 2 bullish candles + close above fast EMA\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips} pips\nTP: ${takeProfitPips} pips\nRR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );

      console.log(`MTF BUY CONFIRMED -> ${symbol}`);

      await placeTrade(symbol, "buy", units, stopLossPips, takeProfitPips);
    }

    // SELL
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
        `=== TRADE OPEN ===\nWHY SELL ${symbol}:\nM5 trend: bearish (fast < slow)\nEMA distance: ${emaDistance.toFixed(1)} pips\nATR: ${(atr / pipMultiplier(symbol)).toFixed(1)} pips\nCandle strength: ${candleStrength.toFixed(2)}\nM1 confirmation: trend + 2 bearish candles + close below fast EMA\nSpread: ${spread.toFixed(2)} pips\nRisk: ${(RISK_PERCENT * 100).toFixed(1)}%\nUnits: ${units}\nSL: ${stopLossPips} pips\nTP: ${takeProfitPips} pips\nRR: 1:${(takeProfitPips / stopLossPips).toFixed(1)}`,
      );

      console.log(`MTF SELL CONFIRMED -> ${symbol}`);

      await placeTrade(symbol, "sell", units, stopLossPips, takeProfitPips);
    }
  } catch (err) {
    console.log(`Strategy error ${symbol}`, err.message);
  }
} // strategy()

async function runBot() {
  while (true) {
    try {
      const now = new Date();

      const day = now.getUTCDay();

      const hour = now.getUTCHours();

      if (day === 6 || (day === 0 && hour < 21)) {
        console.log("FOREX CLOSED");

        await sleep(600000);

        continue;
      }

      const currentDay = new Date().getUTCDate();

      if (currentDay !== lastTradeDay) {
        dailyTrades = 0;

        lastTradeDay = currentDay;

        // DAILY STATS RESET — only on new UTC day
        stats.wins = 0;
        stats.losses = 0;
        stats.totalTrades = 0;
        stats.totalPeakPips = 0;
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

        await sleep(60000);

        continue;
      }

      const openTrades = await getOpenTrades();

      if (openTrades.length >= MAX_OPEN_TRADES) {
        await manageTrades();

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

      // MAIN LOOP DELAY
      await sleep(5000);
    } catch (err) {
      console.log("Main loop error", err.message);

      await sleep(10000);
    }
  }
}

runBot();
