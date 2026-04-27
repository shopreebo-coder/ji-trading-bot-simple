import fetch from "node-fetch";

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

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

const RISK_PERCENT = 0.01;

async function getAccountBalance() {
  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}`,
    {
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`
      }
    }
  );

  const data = await res.json();
  return parseFloat(data.account.balance);
}

async function getPrice(symbol) {
  const res = await fetch(
    `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`,
    {
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`
      }
    }
  );

  const data = await res.json();
  return parseFloat(data.prices[0].bids[0].price);
}

function calculateUnits(balance, price) {
  const riskAmount = balance * RISK_PERCENT;
  return Math.floor(riskAmount / price * 1000);
}

async function placeTrade(symbol, side) {
  const balance = await getAccountBalance();
  const price = await getPrice(symbol);

  const units = calculateUnits(balance, price);

  const stopLoss =
    side === "BUY"
      ? price * 0.997
      : price * 1.003;

  const takeProfit =
    side === "BUY"
      ? price * 1.006
      : price * 0.994;

  const body = {
    order: {
      instrument: symbol,
      units: side === "BUY" ? units : -units,
      type: "MARKET",
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      stopLossOnFill: {
        price: stopLoss.toFixed(5)
      },
      takeProfitOnFill: {
        price: takeProfit.toFixed(5)
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
  console.log("Trade placed:", data);
}

async function runBot() {
  console.log("FOREX ENGINE v10 LIVE running");

  for (let symbol of SYMBOLS) {
    const randomSignal =
      Math.random() > 0.5 ? "BUY" : "SELL";

    await placeTrade(symbol, randomSignal);
  }
}

setInterval(runBot, 300000);
