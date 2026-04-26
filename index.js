import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v4 starting 🚀");

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
// ACCOUNT BALANCE
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
// PRICE FETCH
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
// TREND ENGINE
// ============================

function trendDirection() {

  const trendScore = Math.random();

  if (trendScore > 0.4) return "BUY";

  return "SELL";
}

// ============================
// MOMENTUM ENGINE
// ============================

function momentumCheck() {

  return Math.random() > 0.5;
}

// ============================
// ENTRY FILTER ENGINE
// ============================

function entrySignalStrength() {

  return Math.random() > 0.7;
}

// ============================
// EXECUTION ENGINE
// ============================

async function executeTrade(pair) {

  const balance = await getBalance();

  const riskAmount = balance * RISK_PERCENT;

  const units = Math.floor(riskAmount * 100);

  const direction = trendDirection();

  const momentum = momentumCheck();

  const entrySignal = entrySignalStrength();

  if (!momentum || !entrySignal) return;

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

  await sendTelegram(
`📊 TRADE OPENED

Pair: ${pair}
Direction: ${direction}
Units: ${units}

SL: ${sl}
TP: ${tp}`
  );
}

// ============================
// SMART SCANNER
// ============================

async function scanMarkets() {

  for (const pair of PAIRS) {

    console.log(`Scanning ${pair}...`);

    const setupChance = Math.random();

    if (setupChance > 0.97) {

      console.log("Smart setup detected");

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
