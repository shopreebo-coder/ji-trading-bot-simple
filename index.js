console.log("BTC BOT START 🚀");

const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

async function sendTelegram(message) {

  try {

    await fetch(
      "https://api.telegram.org/bot" + TOKEN + "/sendMessage",
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

  } catch (error) {

    console.log("Telegram error:", error.message);

  }

}


async function getBTC() {

  try {

    const res = await fetch(
      "https://api.coinbase.com/v2/prices/BTC-USD/spot"
    );

    const data = await res.json();

    const price = parseFloat(data.data.amount);

    console.log("BTC:", price);

    return price;

  } catch (error) {

    console.log("PRICE ERROR:", error.message);

    return null;

  }

}


let lastPrice = null;


setInterval(async () => {

  const price = await getBTC();

  if (!price) return;

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


setInterval(() => {

  console.log("heartbeat ❤️ bot alive");

}, 30000);
