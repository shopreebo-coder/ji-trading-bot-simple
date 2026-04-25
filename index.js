const TELEGRAM_TOKEN = process.env.TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"];

let tradeState = {
  EURUSD: "NONE",
  GBPUSD: "NONE",
  USDJPY: "NONE",
  XAUUSD: "NONE"
};

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message
    })
  });
}

async function getPrice(symbol) {
  const res = await fetch(
    `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${process.env.TWELVEDATA_API_KEY}`
  );

  const data = await res.json();

  return parseFloat(data.price);
}

function detectTrendMock(price) {
  return price % 2 > 1 ? "UP" : "DOWN";
}

function detectMomentumMock(price) {
  return price % 5 > 2;
}

function detectEntryMock(price) {
  return price % 3 > 1;
}

async function analyzePair(pair) {
  const price = await getPrice(pair);

  const trend = detectTrendMock(price);
  const momentum = detectMomentumMock(price);
  const entry = detectEntryMock(price);

  if (trend === "UP" && momentum && entry) {
    if (tradeState[pair] !== "LONG") {
      tradeState[pair] = "LONG";

      await sendTelegram(
`TRADE OPENED 📈

PAIR: ${pair}
TYPE: LONG
ENTRY: ${price}
RISK: 1.5%
CONFIDENCE: HIGH`
      );
    }
  }

  else if (trend === "DOWN" && momentum && entry) {
    if (tradeState[pair] !== "SHORT") {
      tradeState[pair] = "SHORT";

      await sendTelegram(
`TRADE OPENED 📉

PAIR: ${pair}
TYPE: SHORT
ENTRY: ${price}
RISK: 1.5%
CONFIDENCE: HIGH`
      );
    }
  }

  else {
    if (tradeState[pair] !== "NONE") {
      await sendTelegram(
`TRADE CLOSED ✅

PAIR: ${pair}
STATUS: EXIT SIGNAL`
      );

      tradeState[pair] = "NONE";
    }
  }
}

async function runEngine() {
  for (const pair of PAIRS) {
    await analyzePair(pair);
  }
}

setInterval(runEngine, 60000);

console.log("Forex Engine PRO running ✅");
