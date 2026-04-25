console.log("BTC BOT START 🚀");

const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";


// funkcja wysyłania wiadomości do Telegram
async function sendTelegram(message) {
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


// pobieranie ceny BTC
async function getBTCPrice() {
  try {

    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );

    const data = await response.json();

    return data.bitcoin.usd;

  } catch (error) {

    console.log("PRICE ERROR:", error.message);

    return null;

  }
}


let lastPrice = null;


// wiadomość startowa
setTimeout(() => {
  sendTelegram("Bot działa ✅");
}, 4000);


// główny loop co 60 sekund
setInterval(async () => {

  const price = await getBTCPrice();

  if (!price) return;

  console.log("BTC:", price);

  await sendTelegram("BTC price: " + price);


  if (lastPrice !== null) {

    if (price > lastPrice) {
      await sendTelegram("📈 BUY signal");
    }

    if (price < lastPrice) {
      await sendTelegram("📉 SELL signal");
    }

  }

  lastPrice = price;

}, 60000);


// heartbeat Railway keep-alive
setInterval(() => {

  console.log("heartbeat ❤️ bot alive");

}, 30000);
