const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

const SYMBOL = "BTCUSDT";

console.log("Trading bot start ✅");

async function sendTelegram(message) {
  try {
    const res = await fetch(
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

    console.log("Telegram status:", res.status);
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

async function getPrice() {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
    );

    const data = await res.json();

    return parseFloat(data.price);
  } catch (err) {
    console.log("Binance error:", err.message);
  }
}

let lastPrice = null;

setInterval(async () => {

  const price = await getPrice();

  if (!price) return;

  console.log("Cena BTC:", price);

  await sendTelegram("Cena BTC: " + price);

  if (lastPrice) {

    if (price > lastPrice) {
      await sendTelegram("📈 BUY signal");
    }

    if (price < lastPrice) {
      await sendTelegram("📉 SELL signal");
    }

  }

  lastPrice = price;

}, 60000);


setInterval(() => {
  console.log("heartbeat ❤️ bot alive");
}, 30000);
