console.log("BTC BOT START 🚀");

const TOKEN = process.env.TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";


console.log("ENV TOKEN:", TOKEN ? "OK" : "MISSING");
console.log("ENV CHAT_ID:", CHAT_ID ? "OK" : "MISSING");


async function sendTelegram(message) {

  if (!TOKEN || !CHAT_ID) {
    console.log("❌ Missing ENV variables");
    return;
  }

  try {

    const response = await fetch(
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

    const data = await response.json();

    console.log("Telegram:", data);

  } catch (error) {

    console.log("Telegram ERROR:", error.message);

  }

}


async function getBTCPrice() {

  try {

    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );

    const data = await response.json();

    return data.bitcoin.usd;

  } catch {

    return null;

  }

}


let lastPrice = null;


setTimeout(async () => {

  await sendTelegram("Bot działa ✅ Railway OK");

}, 5000);


setInterval(async () => {

  const price = await getBTCPrice();

  if (!price) return;

  console.log("BTC:", price);

  await sendTelegram("BTC price: " + price);

  if (lastPrice !== null) {

    if (price > lastPrice)
      await sendTelegram("📈 BUY signal");

    if (price < lastPrice)
      await sendTelegram("📉 SELL signal");

  }

  lastPrice = price;

}, 60000);


setInterval(() => {

  console.log("heartbeat ❤️ bot alive");

}, 30000);
