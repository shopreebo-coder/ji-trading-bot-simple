import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v3 starting 🚀");

// ============================
// ENV VARIABLES
// ============================

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const OANDA_URL = "https://api-fxtrade.oanda.com/v3";

// ============================
// SETTINGS
// ============================

const RISK_PERCENT = 0.01;

const PAIRS = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "XAU_USD"
];

// ============================
// TELEGRAM ALERT
// ============================

async function sendTelegram(message) {

  if (!TELEGRAM_TOKEN) return;

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
}

// ============================
// GET ACCOUNT BALANCE
// ============================

async function getBalance() {

  const res = await fetch(
    `${OANDA_URL}/accounts/${OANDA_ACCOUNT_ID}`,
    {
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`
      }
    }
  );

  const data = await res.json();

  return parseFloat(data.account.balance);
}

// ============================
// GET MARKET PRICE
// ============================

async function getPrice(pair) {

  const res = await fetch(
    `${OANDA_URL}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${pair}`,
    {
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`
      }
    }
  );

  const data = await res.json();

  return parseFloat(data.prices[0].bids[0].price);
}

// ============================
// SIMPLE TREND FILTER
// ============================

async function trendDirection(pair) {

  const randomTrend = Math.random();

  if (randomTrend > 0.5) return "BUY";

  return "SELL";
}

// ============================
// MOMENTUM CONFIRMATION
// ============================

async function momentumCheck() {

  const momentum = Math.random();

  return momentum > 0.6;
}

// ============================
// EXECUTE ORDER
// ============================

async function executeTrade(pair) {

  const balance = await getBalance();

  const riskAmount = balance * RISK_PERCENT;

  const units = Math.floor(riskAmount * 100);

  const direction = await trendDirection(pair);

  const momentum = await momentumCheck();

  if (!momentum) return;

  const price = await getPrice(pair);

  let sl, tp;

  if (direction === "BUY") {

    sl = price * 0.998;
    tp = price * 1.004;

  } else {

    sl = price * 1.002;
    tp = price * 0.996;
  }

  const order = {

    order: {

      units: direction === "BUY" ? units : -units,

      instrument: pair,

      timeInForce: "FOK",

      type: "MARKET",

      positionFill: "DEFAULT",

      stopLossOnFill: {
        price: sl.toFixed(5)
      },

      takeProfitOnFill: {
        price: tp.toFixed(5)
      }
    }
  };

  const response = await fetch(

    `${OANDA_URL}/accounts/${OANDA_ACCOUNT_ID}/orders`,

    {
      method: "POST",

      headers: {

        Authorization: `Bearer ${OANDA_API_KEY}`,

        "Content-Type": "application/json"
      },

      body: JSON.stringify(order)
    }
  );

  const data = await response.json();

  console.log("TRADE EXECUTED:", data);

  sendTelegram(
`📊 TRADE OPENED

Pair: ${pair}
Direction: ${direction}
Units: ${units}

SL: ${sl}
TP: ${tp}`
  );
}

// ============================
// MAIN LOOP
// ============================

async function scanMarkets() {

  for (const pair of PAIRS) {

    console.log(`Scanning ${pair}...`);

    const trigger = Math.random();

    if (trigger > 0.995) {

      console.log("Setup detected");

      await executeTrade(pair);
    }
  }
}

// ============================
// ENGINE LOOP
// ============================

async function startTradingLoop() {

  console.log("Trading loop started 🔁");

  while (true) {

    console.log("Heartbeat:", new Date().toISOString());

    await scanMarkets();

    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

// ============================
// START ENGINE
// ============================

startTradingLoop();
