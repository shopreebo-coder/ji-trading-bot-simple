const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

const SYMBOL = "BTCUSDT";
const INTERVAL = 60000;

console.log("Trading bot start ✅");

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
    }),
  });
}

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

    console.log("Cena BTC:", price);

    await sendTelegram(`Cena BTC: ${price}`);

    if (lastPrice) {
      if (price > lastPrice) {
        console.log("Trend rośnie 📈 BUY signal");
        await sendTelegram("📈 BUY signal");
      } else if (price < lastPrice) {
        console.log("Trend spada 📉 SELL signal");
        await sendTelegram("📉 SELL signal");
      } else {
        console.log("Brak zmiany");
      }
    }

    lastPrice = price;

  } catch (err) {
    console.log("Błąd:", err.message);
  }
}, INTERVAL);

setInterval(() => {
  console.log("heartbeat ❤️ bot alive");
}, 30000);
