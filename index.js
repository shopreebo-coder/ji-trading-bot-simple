console.log("FOREX ENGINE PRO v2 starting 🚀");

const TOKEN = process.env.TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const API_KEY = process.env.TWELVEDATA_API_KEY;

if (!TOKEN || !CHAT_ID || !API_KEY) {
  console.log("❌ Missing ENV variables");
  process.exit(1);
}

async function sendTelegram(message) {
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
    console.log("Telegram error:", err.message);
  }
}

async function getPrice(symbol) {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&apikey=${API_KEY}&outputsize=2`
    );

    const data = await res.json();

    if (!data.values) return null;

    return parseFloat(data.values[0].close);

  } catch {
    return null;
  }
}

let lastSignal = {};

async function scan(symbol) {

  const price = await getPrice(symbol);

  if (!price) return;

  console.log(symbol, price);

  if (!lastSignal[symbol]) {
    lastSignal[symbol] = "NONE";
  }

  if (price % 2 === 0 && lastSignal[symbol] !== "BUY") {

    lastSignal[symbol] = "BUY";

    await sendTelegram(
`${symbol} BUY

Entry: ${price}
SL: ${(price - 0.0020).toFixed(5)}
TP: ${(price + 0.0040).toFixed(5)}`
    );
  }

  if (price % 3 === 0 && lastSignal[symbol] !== "SELL") {

    lastSignal[symbol] = "SELL";

    await sendTelegram(
`${symbol} SELL

Entry: ${price}
SL: ${(price + 0.0020).toFixed(5)}
TP: ${(price - 0.0040).toFixed(5)}`
    );
  }
}

const pairs = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "XAU/USD"
];

console.log("Live market connected ✅");

setInterval(() => {

  pairs.forEach(scan);

}, 60000);
