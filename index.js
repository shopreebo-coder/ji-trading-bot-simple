const SYMBOL = "BTC-USD";

console.log("Trading bot start ✅");

let lastPrice = null;

async function getPrice() {
  const res = await fetch(
    `https://api.coinbase.com/v2/prices/${SYMBOL}/spot`
  );

  const data = await res.json();

  if (!data.data.amount) {
    throw new Error("Brak price z API Coinbase");
  }

  return Number(data.data.amount);
}

async function runBot() {
  try {
    const price = await getPrice();

    console.log("Cena BTC:", price);

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
