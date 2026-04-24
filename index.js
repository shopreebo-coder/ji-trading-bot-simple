const SYMBOL = "BTCUSDT";
const INTERVAL = 60000;

console.log("Trading bot start ✅");

async function getPrice() {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
  );

  const data = await res.json();
  return Number(data.price);
}

let lastPrice = null;

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

setInterval(runBot, INTERVAL);

// uruchom od razu po starcie
runBot();
