
const http = require("http");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Не заданы необходимые переменные окружения!");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0;

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function getNovaId(telegramId) {
  const query = new URLSearchParams({
    select: "nova_id",
    telegram_id: `eq.${telegramId}`,
    limit: "1"
  });

  const users = await supabaseRequest(`users?${query}`);

  return users.length ? users[0].nova_id : null;
}

async function createNovaId(telegramId) {
  const existing = await getNovaId(telegramId);
  if (existing) return existing;

  for (let attempt = 0; attempt < 10; attempt++) {
    const novaId = "+" + crypto.randomInt(10000000, 99999999);

    try {
      const users = await supabaseRequest("users", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          telegram_id: String(telegramId),
          nova_id: novaId
        })
      });

      if (users.length) return users[0].nova_id;
    } catch (error) {
      if (error.message.includes("409")) {
        const saved = await getNovaId(telegramId);
        if (saved) return saved;
        continue;
      }
      throw error;
    }
  }

  throw new Error("Не удалось создать уникальный NOVA ID");
}

async function telegram(method, data) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();
  if (!result.ok) throw new Error(result.description);
  return result.result;
}

async function handleMessage(message) {
  if (!message.text) return;

  const chatId = message.chat.id;
  const command = message.text.split(" ")[0];

  if (command === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Добро пожаловать в NOVA PIRATE! 🏴‍☠️\n\nНапиши /getnumber, чтобы получить свой NOVA ID."
    });
  }

  if (command === "/getnumber" || command === "/myid") {
    const id = await createNovaId(message.from.id);

    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Твой NOVA ID: ${id}\n\nСохрани его! 🚀`
    });
  }
}

async function polling() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          if (update.message) await handleMessage(update.message);
        } catch (error) {
          console.error("Ошибка обработки сообщения:", error.message);
        }
      }
    } catch (error) {
      console.error("Ошибка Telegram:", error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("NOVA PIRATE is running!");
}).listen(process.env.PORT || 3000, () => {
  console.log("NOVA PIRATE server started");
  polling();
});
