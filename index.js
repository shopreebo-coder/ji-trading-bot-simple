import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v2 AUTO EXECUTION MODE 🚀");

// =============================
// ENV VARIABLES
// =============================

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const TELEGRAM_TOKEN = process.env.TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const OANDA_URL = "https://api-fxtrade.oanda.com/v3";

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD"];

let tradeOpen = false;

// =============================
// TELEGRAM ALERT
// =============================

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

// =============================
// GET PRICE
// =============================

async function getPrice(symbol) {
  const pair = symbol.replace("/", "");

  const response = await fetch(
    `https://api.twelvedata.com/price?symbol=${pair}&apikey=${TWELVEDATA_API_KEY}`
  );

  const data = await response.json();

  return parseFloat(data.price);
}

// =============================
// ACCOUNT BALANCE
// =============================

async function getBalance() {

  const response = await fetch(
    `${OANDA_URL}/accounts/${OANDA_ACCOUNT_ID}`,
    {
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`
      }
    }
  );

  const data = await response.json();

  return parseFloat(data.account.balance);
}

// =============================
// POSITION SIZE CALCULATION
// =============================

async function calculateUnits(symbol, slDistance) {

  const balance = await getBalance();

  const risk = balance * 0.01;

  const units = Math.floor(risk / slDistance);

  return units;
}

// =============================
// SEND ORDER
// =============================

async function sendOrder(symbol, direction) {

  try {

    const price = await getPrice(symbol);

    const slDistance = price * 0.002;

    const tpDistance = price * 0.004;

    const sl =
      direction === "BUY"
        ? price - slDistance
        : price + slDistance;

    const tp =
      direction === "BUY"
        ? price + tpDistance
        : price - tpDistance;

    const units = await calculateUnits(symbol, slDistance);

    if (units < 1) {
      console.log("Units too small");
      return;
    }

    const order = {
      order: {
        units: direction === "BUY" ? units : -units,
        instrument: symbol,
        timeInForce: "FOK",
        type: "MARKET",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: sl.toFixed(5) },
        takeProfitOnFill: { price: tp.toFixed(5) }
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

    console.log("ORDER RESPONSE:", data);

    tradeOpen = true;

    await sendTelegram(
      `📈 TRADE OPENED\n${symbol}\nDirection: ${direction}\nUnits: ${units}`
    );

  } catch (err) {

    console.log("Execution error:", err.message);

  }
}

// =============================
// SIMPLE ENTRY LOGIC
// =============================

async function checkEntry(symbol) {

  if (tradeOpen) return;

  const price = await getPrice(symbol);

  const randomSignal = Math.random();

  if (randomSignal > 0.995) {

    console.log("Signal detected:", symbol);

    const direction = Math.random() > 0.5 ? "BUY" : "SELL";

    await sendOrder(symbol, direction);

  }
}

// =============================
// MARKET SCANNER
// =============================

async function scanMarkets() {

  for (let pair of PAIRS) {

    console.log("Scanning", pair);

    await checkEntry(pair);

  }
}

// =============================
// TRADING LOOP
// =============================

async function startTradingLoop() {

  console.log("Trading loop started 🔁");

  while (true) {

    try {

      console.log("Heartbeat:", new Date().toISOString());

      await scanMarkets();

    } catch (err) {

      console.log("Loop error:", err.message);

    }

    await new Promise(resolve => setTimeout(resolve, 60000));

  }
}

// =============================
// START ENGINE
// =============================

startTradingLoop();
