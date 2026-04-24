console.log("BTC BOT START 🚀");

const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

const SYMBOL = "BTCUSDT";

async function sendTelegram(message) {

  try {

    await fetch(
      "https://api.telegram.org/bot" +
      TOKEN +
      "/sendMessage",
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


async async function getPrice() {

  try {

    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const data = await response.json();

    console.log("BTC:", data.price);

    return parseFloat(data.price);

  } catch (error) {

    console.log("Binance error:", error.message);

    return null;

  }

}

  try {

    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const data = await response.json();

    console.log("BTC:", data.price);

    return parseFloat(data.price);

  } catch (error) {

    console.log("Binance error:", error.message);

    return null;

  }

}

  try {

    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=" +
      SYMBOL
    );

    const data = await response.json();

    return parseFloat(data.price);

  } catch (error) {

    console.log("Binance error:", error.message);

    return null;

  }

}


let lastPrice = null;


setInterval(async function () {

  const price = await getPrice();

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


setInterval(function () {

  console.log("heartbeat ❤️ bot alive");

}, 30000);
