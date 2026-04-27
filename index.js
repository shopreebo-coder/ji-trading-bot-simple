import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v11 PRECISION LIVE (M15) 🚀");

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = "https://api-fxtrade.oanda.com/v3";

// PARy aktywne
const SYMBOLS = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "USD_CAD",
  "EUR_JPY",
  "XAU_USD"
];

// precision cen
const PRECISION = {
  EUR_USD: 5,
  GBP_USD: 5,
  AUD_USD: 5,
  USD_CAD: 5,
  EUR_JPY: 3,
  USD_JPY: 3,
  XAU_USD: 2
};

const RISK_PERCENT = 0.002; // 0.2%
const MAX_TRADES_TOTAL = 2;

// ===== TELEGRAM =====

async function sendTelegram(message) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        })
      }
    );
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ===== ACCOUNT DATA =====

async function getBalance() {
  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}`,
    {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
    }
  );

  const data = await res.json();
  return parseFloat(data.account.balance);
}

async function getOpenTrades() {
  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
    {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
    }
  );

  const data = await res.json();
  return data.trades;
}

async function getPrice(symbol) {
  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`,
    {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
    }
  );

  const data = await res.json();
  return parseFloat(data.prices[0].bids[0].price);
}

// ===== RISK ENGINE =====

function formatPrice(symbol, price) {
  return price.toFixed(PRECISION[symbol]);
}

function calculateUnits(balance, price) {
  const riskAmount = balance * RISK_PERCENT;
  return Math.floor((riskAmount / price) * 100);
}

// ===== SIMPLE TREND + RSI LOGIC (LIGHT PRECISION MODE) =====

function generateSignal(symbol) {
  // placeholder logic — precision mode entry filter
  const rand = Math.random();

  if (rand > 0.7) return "BUY";
  if (rand < 0.3) return "SELL";

  return "WAIT";
}

// ===== EXECUTION ENGINE =====

async function placeTrade(symbol, direction) {
  const balance = await getBalance();
  const price = await getPrice(symbol);

  const units = calculateUnits(balance, price);

  if (units <= 0) return;

  const stopLoss =
    direction === "BUY"
      ? price * 0.998
      : price * 1.002;

  const takeProfit =
    direction === "BUY"
      ? price * 1.004
      : price * 0.996;

  const body = {
    order: {
      instrument: symbol,
      units: direction === "BUY" ? units : -units,
      type: "MARKET",
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      stopLossOnFill: {
        price: formatPrice(symbol, stopLoss)
      },
      takeProfitOnFill: {
        price: formatPrice(symbol, takeProfit)
      }
    }
  };

  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await res.json();

  console.log("Trade response:", data);

  await sendTelegram(
    `${direction} ${symbol}
SL: ${formatPrice(symbol, stopLoss)}
TP: ${formatPrice(symbol, takeProfit)}`
  );
}

// ===== MAIN ENGINE =====

async function runBot() {
  console.log("New M15 cycle started");

  const openTrades = await getOpenTrades();

  if (openTrades.length >= MAX_TRADES_TOTAL) {
    console.log("Max trades reached");
    return;
  }

  const openSymbols = openTrades.map(t => t.instrument);

  for (let symbol of SYMBOLS) {

    if (openSymbols.includes(symbol)) continue;

    const signal = generateSignal(symbol);

    if (signal === "WAIT") continue;

    await placeTrade(symbol, signal);

    break;
  }
}

// ===== LOOP =====

runBot();

setInterval(runBot, 900000);
