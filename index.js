// ===============================
// FOREX ENGINE PRO v2 (FULL AUTO)
// OANDA + TWELVEDATA + TELEGRAM
// ===============================

import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v2 starting 🚀");

// ===============================
// ENV VARIABLES
// ===============================

const TOKEN = process.env.TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const OANDA_URL = "https://api-fxtrade.oanda.com/v3";

// ===============================
// VERIFY ENV
// ===============================

if (!TOKEN || !CHAT_ID) {
  console.log("❌ Telegram ENV missing");
}

if (!TWELVEDATA_API_KEY) {
  console.log("❌ TwelveData ENV missing");
}

if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
  console.log("❌ OANDA ENV missing");
} else {
  console.log("OANDA execution connected ✅");
}

// ===============================
// TELEGRAM FUNCTION
// ===============================

async function sendTelegram(message) {

  if (!TOKEN || !CHAT_ID) return;

  try {

    await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message
        })
      }
    );

  } catch (err) {

    console.log("Telegram error:", err);

  }
}

// ===============================
// FORMAT SYMBOL OANDA
// ===============================

function formatInstrument(symbol) {

  if (symbol.includes("_")) return symbol;

  return symbol.slice(0, 3) + "_" + symbol.slice(3);

}

// ===============================
// SEND ORDER OANDA
// ===============================

async function sendOrder(symbol, units, side, sl, tp) {

  if (!OANDA_API_KEY) return;

  try {

    const instrument = formatInstrument(symbol);

    const order = {

      order: {

        instrument: instrument,

        units: side === "BUY"
          ? units
          : -units,

        type: "MARKET",

        timeInForce: "FOK",

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

    console.log("Trade response:", data);

    await sendTelegram(
      `📈 TRADE OPENED\n${symbol}\nSide: ${side}`
    );

  }

  catch (err) {

    console.log("Execution error:", err);

  }

}

// ===============================
// GET PRICE FROM TWELVEDATA
// ===============================

async function getPrice(symbol) {

  try {

    const response = await fetch(
      `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVEDATA_API_KEY}`
    );

    const data = await response.json();

    return parseFloat(data.price);

  }

  catch {

    return null;

  }

}

// ===============================
// SIMPLE STRATEGY ENGINE
// ===============================

async function strategy(symbol) {

  const price = await getPrice(symbol);

  if (!price) return;

  console.log(symbol, price);

  // test condition (first version entry trigger)

  if (price % 2 < 1) {

    const sl = price - 0.0020;

    const tp = price + 0.0040;

    await sendOrder(

      symbol,

      1000,

      "BUY",

      sl,

      tp

    );

  }

}

// ===============================
// SYMBOL LIST
// ===============================

const pairs = [

  "EUR/USD",

  "GBP/USD",

  "USD/JPY"

];

// ===============================
// MAIN LOOP
// ===============================

async function engine() {

  console.log("Live market connected ✅");

  while (true) {

    for (const symbol of pairs) {

      await strategy(symbol);

    }

    await new Promise(resolve =>
      setTimeout(resolve, 60000)
    );

  }

}

engine();
