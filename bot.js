
const http = require("http");

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  throw new Error("BOT_TOKEN не настроен!");
}

const API = `https://api.telegram.org/bot${TOKEN}`;

const users = new Map();
let offset = 0;

async function telegram(method, data = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description);
  }

  return result.result;
}

function createNovaId() {
  let id;

  do {
    id = "+" + Math.floor(
      10000000 + Math.random() * 90000000
    );
  } while ([...users.values()].some(u => u.id === id));

  return id;
}

async function handleMessage(message) {
  if (!message.text || !message.from) return;

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const command = message.text.split(" ")[0];

  if (command === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "🏴‍☠️ Добро пожаловать в NOVA PIRATE!\n\n" +
        "Твой собственный мир общения.\n\n" +
        "Команды:\n" +
        "/getnumber — получить NOVA ID\n" +
        "/myid — посмотреть свой ID"
    });
  }

  else if (command === "/getnumber") {
    if (users.has(telegramId)) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "У тебя уже есть NOVA ID: " +
          users.get(telegramId).id
      });
      return;
    }

    const id = createNovaId();

    users.set(telegramId, {
      id: id,
      createdAt: new Date().toISOString()
    });

    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "🎉 Твой NOVA ID создан!\n\n" +
        "🏴‍☠️ " + id +
        "\n\nСохрани его для NOVA PIRATE!"
    });
  }

  else if (command === "/myid") {
    const user = users.get(telegramId);

    await telegram("sendMessage", {
      chat_id: chatId,
      text: user
        ? "Твой NOVA ID: " + user.id
        : "У тебя ещё нет NOVA ID. Напиши /getnumber"
    });
  }
}

async function startBot() {
  console.log("NOVA PIRATE запущен!");

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: offset,
        timeout: 25
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          if (update.message) {
            await handleMessage(update.message);
          }
        } catch (error) {
          console.error("Ошибка сообщения:", error.message);
        }
      }
    } catch (error) {
      console.error("Ошибка Telegram:", error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });
  res.end("NOVA PIRATE is alive! 🏴‍☠️");
}).listen(process.env.PORT || 3000);

startBot();
  
