const SYMBOL = "BTCUSDT";

console.log("Trading bot start ✅");

let lastPrice = null;

async function getPrice() {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }
  );

  const data = await res.json();

  if (!data.price) {
    throw new Error("Brak price z API Binance");
  }

  return Number(data.price);
}

async function runBot() {
  try {
    const price = await getPrice();

    console.log("Cena:", price);

    if (lastPrice !== null) {
      if (price > lastPrice) {
        console.log("Trend rośnie 📈 BUY signal");
      } else if (price < lastPrice) {
        console.log("Trend spada 📉 SELL signal");
      } else {
        console.log("Brak zmiany ➖");
      }
    }

    lastPrice = price;

  } catch (err) {
    console.log("Błąd:", err.message);
  }
}

runBot();

setInterval(runBot, 60000);

setInterval(() => {
  console.log("heartbeat ❤️");
}, 30000);
