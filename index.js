

const SYMBOL = "BTCUSDT";
const INTERVAL = 60000;

console.log("Trading bot start ✅");

async function getPrice() {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
  );
  const data = await res.json();
  return parseFloat(data.price);
}

let lastPrice = null;

setInterval(async () => {
  try {
    const price = await getPrice();

    console.log("Cena:", price);

    if (lastPrice) {
      if (price > lastPrice) {
        console.log("Trend rośnie 📈 BUY signal");
      } else if (price < lastPrice) {
        console.log("Trend spada 📉 SELL signal");
      } else {
        console.log("Brak zmiany");
      }
    }

    lastPrice = price;
  } catch (err) {
    console.log("Błąd:", err.message);
  }
}, INTERVAL);
