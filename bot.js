
const http = require("http");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing = [];

if (!BOT_TOKEN) missing.push("BOT_TOKEN");
if (!SUPABASE_URL) missing.push("SUPABASE_URL");
if (!SUPABASE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

if (missing.length) {
  console.error("Не заданы переменные:", missing.join(", "));
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  return body ? JSON.parse(body) : [];
}

async function telegram(method, data) {
  const response = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

async function findUser(telegramId) {
  const params = new URLSearchParams({
    select: "nova_id",
    telegram_id: `eq.${telegramId}`,
    limit: "1"
  });

  const users = await db(`users?${params}`);
  return users.length ? users[0].nova_id : null;
}

async function createUser(telegramId) {
  const oldId = await findUser(telegramId);

  if (oldId) return oldId;

  for (let i = 0; i < 10; i++) {
    const novaId = "+" + crypto.randomInt(10000000, 99999999);

    try {
      const users = await db("users", {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          telegram_id: String(telegramId),
          nova_id: novaId
        })
      });

      if (users.length) return users[0].nova_id;

    } catch (error) {
      if (error.message.includes("409")) {
        const saved = await findUser(telegramId);
        if (saved) return saved;
        continue;
      }

      throw error;
    }
  }

  throw new Error("Не удалось создать NOVA ID");
}

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

async function handleMessage(message) {
  if (!message.text || !message.from) return;

  const chatId = message.chat.id;
  const command = message.text.trim().split(/\s+/)[0];

  if (command === "/start") {
    await sendMessage(
      chatId,
      "🏴‍☠️ Добро пожаловать в NOVA PIRATE!\n\nНапиши /getnumber, чтобы получить свой NOVA ID."
    );
  }

  if (command === "/getnumber" || command === "/myid") {
    const id = await createUser(message.from.id);

    await sendMessage(
      chatId,
      `Твой NOVA ID: ${id}\n\nТвой ID сохранён в базе данных! 🚀`
    );
  }
}

let offset = 0;

async function polling() {
  console.log("Telegram polling started");

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message) {
          try {
            await handleMessage(update.message);
          } catch (error) {
            console.error("Message error:", error.message);
          }
        }
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("NOVA PIRATE is running!");
});

server.listen(process.env.PORT || 10000, "0.0.0.0", () => {
  console.log("NOVA PIRATE server started");
  polling();
});
