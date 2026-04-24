console.log("BOT TEST START 🚀");

const TOKEN = "8659223122:AAFvSZw6wnAPOuEUZMhuufw0Xu4QzZ8BEeOo";
const CHAT_ID = "7209483091";

async function run() {

  try {

    const response = await fetch(
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
          text: "Bot działa ✅"
        })
      }
    );

    const data = await response.text();

    console.log("Telegram response:", data);

  } catch (err) {

    console.log("ERROR:", err.message);

  }

}

run();

setInterval(() => {

  console.log("heartbeat ❤️");

}, 30000);
