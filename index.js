console.log("BOT VERSION TELEGRAM ACTIVE 🚀");

const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

const SYMBOL = "BTCUSDT";

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

async function getPrice() {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`
  );

  const data = await res.json();
  return
