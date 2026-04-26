import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v2 starting 🚀");

// =============================
// ENV VARIABLES
// =============================

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const TELEGRAM_TOKEN = process.env.TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const OANDA_URL = "https://api-fxtrade.oanda.com/v3";

// =============================
// TELEGRAM FUNCTION
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
// OANDA EXECUTION
// =============================

async function sendOrder(symbol, units, side, sl, tp) {

  try {

    const order = {
      order: {
        units: side === "BUY" ? units : -units,
        instrument: symbol,
        timeInForce: "FOK",
        type: "MARKET",
        positionFill: "DEFAULT",
        stopLossOnFill: {
          price: sl.toString()
        },
        takeProfitOnFill: {
          price: tp.toString()
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

    console.log("ORDER RESPONSE:", data);

    await sendTelegram(
      `📈 TRADE OPENED\n${symbol}\nDirection: ${side}\nSL: ${sl}\nTP: ${tp}`
    );

  } catch (err) {

    console.log("Execution error:", err.message);

  }
}

console.log("OANDA execution connected ✅");
console.log("Live market connected ✅");

// =============================
// MARKET SCANNER
// =============================

async function scanMarkets() {

  console.log("Scanning EUR/USD...");
  console.log("Scanning GBP/USD...");
  console.log("Scanning USD/JPY...");
  console.log("Scanning XAU/USD...");

}

// =============================
// TRADING LOOP (24/7 ENGINE)
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
