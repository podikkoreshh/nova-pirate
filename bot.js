
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

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text
  });
}

async function getUser(telegramId) {
  const params = new URLSearchParams({
    select: "telegram_id,nova_id,display_name",
    telegram_id: `eq.${telegramId}`,
    limit: "1"
  });

  const users = await db(`users?${params}`);
  return users.length ? users[0] : null;
}

async function findByNovaId(novaId) {
  const params = new URLSearchParams({
    select: "telegram_id,nova_id,display_name",
    nova_id: `eq.${novaId}`,
    limit: "1"
  });

  const users = await db(`users?${params}`);
  return users.length ? users[0] : null;
}

async function createUser(telegramId) {
  const oldUser = await getUser(telegramId);
  if (oldUser) return oldUser.nova_id;

  for (let i = 0; i < 10; i++) {
    const novaId = "+" + crypto.randomInt(10000000, 99999999);

    try {
      const users = await db("users", {
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
        const saved = await getUser(telegramId);
        if (saved) return saved.nova_id;
        continue;
      }
      throw error;
    }
  }

  throw new Error("Не удалось создать NOVA ID");
}

async function setUserName(telegramId, name) {
  const params = new URLSearchParams({
    telegram_id: `eq.${telegramId}`
  });

  await db(`users?${params}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ display_name: name })
  });
}

async function saveMessage(senderId, recipientId, text) {
  await db("messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      sender_telegram_id: String(senderId),
      recipient_telegram_id: String(recipientId),
      message_text: text
    })
  });
}

async function getInbox(telegramId) {
  const params = new URLSearchParams({
    select: "sender_telegram_id,message_text,created_at",
    recipient_telegram_id: `eq.${telegramId}`,
    order: "created_at.desc",
    limit: "10"
  });

  return db(`messages?${params}`);
}

async function handleMessage(message) {
  if (!message.text || !message.from) return;

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const parts = message.text.trim().split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    await createUser(telegramId);

    await sendMessage(
      chatId,
      "🏴‍☠️ NOVA PIRATE\n\n" +
      "/getnumber — получить NOVA ID\n" +
      "/setname Имя — сохранить имя\n" +
      "/profile — мой профиль\n" +
      "/find +12345678 — найти пользователя\n" +
      "/message +12345678 Текст — отправить сообщение\n" +
      "/inbox — входящие сообщения"
    );
    return;
  }

  if (command === "/getnumber" || command === "/myid") {
    const id = await createUser(telegramId);
    await sendMessage(chatId, `Твой NOVA ID: ${id}`);
    return;
  }

  if (command === "/setname") {
    const name = parts.slice(1).join(" ").trim();

    if (!name || name.length > 40) {
      await sendMessage(chatId, "Пример: /setname Иван. Максимум 40 символов.");
      return;
    }

    await createUser(telegramId);
    await setUserName(telegramId, name);
    await sendMessage(chatId, `✅ Имя сохранено: ${name}`);
    return;
  }

  if (command === "/profile") {
    await createUser(telegramId);
    const user = await getUser(telegramId);

    await sendMessage(
      chatId,
      "👤 ТВОЙ ПРОФИЛЬ\n\n" +
      `Имя: ${user.display_name || "Не указано"}\n` +
      `NOVA ID: ${user.nova_id}`
    );
    return;
  }

  if (command === "/find") {
    const novaId = parts[1];

    if (!novaId || !/^\+\d{8}$/.test(novaId)) {
      await sendMessage(chatId, "Пример: /find +12345678");
      return;
    }

    const user = await findByNovaId(novaId);

    if (!user) {
      await sendMessage(chatId, "❌ Пользователь не найден.");
      return;
    }

    await sendMessage(
      chatId,
      `👤 Имя: ${user.display_name || "Не указано"}\nNOVA ID: ${user.nova_id}`
    );
    return;
  }

  if (command === "/message") {
    const novaId = parts[1];
    const text = parts.slice(2).join(" ").trim();

    if (!novaId || !/^\+\d{8}$/.test(novaId) || !text) {
      await sendMessage(
        chatId,
        "Пример:\n/message +12345678 Привет!"
      );
      return;
    }

    if (text.length > 3000) {
      await sendMessage(chatId, "Сообщение слишком длинное. Максимум 3000 символов.");
      return;
    }

    const recipient = await findByNovaId(novaId);

    if (!recipient) {
      await sendMessage(chatId, "❌ Получатель не найден.");
      return;
    }

    if (String(recipient.telegram_id) === String(telegramId)) {
      await sendMessage(chatId, "Нельзя отправить сообщение самому себе.");
      return;
    }

    const sender = await getUser(telegramId);

    try {
      await sendMessage(
        recipient.telegram_id,
        "💬 НОВОЕ СООБЩЕНИЕ NOVA PIRATE\n\n" +
        `От: ${sender?.display_name || "Пользователь"}\n` +
        `NOVA ID: ${sender?.nova_id || "Неизвестен"}\n\n` +
        text
      );
    } catch (error) {
      await sendMessage(
        chatId,
        "❌ Не удалось доставить сообщение. Получатель должен открыть бота и нажать /start."
      );
      return;
    }

    await saveMessage(telegramId, recipient.telegram_id, text);
    await sendMessage(chatId, "✅ Сообщение отправлено!");
    return;
  }

  if (command === "/inbox") {
    const messages = await getInbox(telegramId);

    if (!messages.length) {
      await sendMessage(chatId, "📭 Входящих сообщений пока нет.");
      return;
    }

    const lines = messages.map((item, index) =>
      `${index + 1}. От Telegram ID ${item.sender_telegram_id}\n${item.message_text}`
    );

    await sendMessage(
      chatId,
      "📬 ПОСЛЕДНИЕ СООБЩЕНИЯ\n\n" + lines.join("\n\n")
    );
    return;
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
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("NOVA PIRATE is running!");
});

server.listen(process.env.PORT || 10000, "0.0.0.0", () => {
  console.log("NOVA PIRATE server started");
  polling();
});
