const SYMBOL = "BTCUSDT";

console.log("Trading bot start ✅");

let lastPrice = null;

async function runBot() {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
    );

    const data = await res.json();
    const price = Number(data.price);

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

// uruchom natychmiast
runBot();

// loop co minutę
setInterval(runBot, 60000);

// utrzymuj kontener aktywny (Railway workaround)
setInterval(() => {
  console.log("heartbeat ❤️");
}, 30000);
