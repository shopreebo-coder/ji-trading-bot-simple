import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v10.2 LIVE running 🚀");

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = "https://api-fxtrade.oanda.com/v3";

const SYMBOLS = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "XAU_USD",
  "AUD_USD",
  "USD_CAD",
  "EUR_JPY"
];

const PRECISION = {
  EUR_USD: 5,
  GBP_USD: 5,
  AUD_USD: 5,
  USD_CAD: 5,
  EUR_JPY: 3,
  USD_JPY: 3,
  XAU_USD: 2
};

const RISK_PERCENT = 0.01;

function formatPrice(symbol, price) {
  return price.toFixed(PRECISION[symbol]);
}

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

function calculateUnits(balance, price) {
  const riskAmount = balance * RISK_PERCENT;
  return Math.floor((riskAmount / price) * 1000);
}

async function placeTrade(symbol, direction) {
  const balance = await getBalance();
  const price = await getPrice(symbol);

  const units = calculateUnits(balance, price);

  const stopLoss =
    direction === "BUY"
      ? price * 0.997
      : price * 1.003;

  const takeProfit =
    direction === "BUY"
      ? price * 1.006
      : price * 0.994;

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
    `${direction} ${symbol}\nSL: ${formatPrice(
      symbol,
      stopLoss
    )}\nTP: ${formatPrice(symbol, takeProfit)}`
  );
}

async function runBot() {
  console.log("Trading cycle started");

  for (let symbol of SYMBOLS) {
    const signal =
      Math.random() > 0.5 ? "BUY" : "SELL";

    await placeTrade(symbol, signal);
  }
}

setInterval(runBot, 300000);
