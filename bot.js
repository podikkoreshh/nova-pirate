
const http = require("http");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_SESSION_DAYS = 30;
const MAX_BODY = 10000;
const rateLimits = new Map();

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

// ===============================
// PASSWORDS AND APP AUTHENTICATION
// ===============================

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, originalHash] = stored.split(":");

    if (!salt || !originalHash) return false;

    const calculated = Buffer.from(
      crypto.scryptSync(password, salt, 64).toString("hex"),
      "hex"
    );

    const original = Buffer.from(originalHash, "hex");

    return calculated.length === original.length &&
      crypto.timingSafeEqual(calculated, original);
  } catch {
    return false;
  }
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function createAppSession(accountId) {
  const token = createToken();

  const tokenHash = crypto.createHash("sha256")
    .update(token)
    .digest("hex");

  const expires = new Date(
    Date.now() + APP_SESSION_DAYS * 86400000
  ).toISOString();

  await db("app_auth_sessions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      account_id: accountId,
      token_hash: tokenHash,
      expires_at: expires
    })
  });

  return token;
}

async function getAppAccount(token) {
  if (!token) return null;

  const tokenHash = crypto.createHash("sha256")
    .update(token)
    .digest("hex");

  const params = new URLSearchParams({
    select: "account_id,expires_at",
    token_hash: `eq.${tokenHash}`,
    limit: "1"
  });

  const sessions = await db(`app_auth_sessions?${params}`);

  if (!sessions.length) return null;

  if (new Date(sessions[0].expires_at).getTime() < Date.now()) {
    return null;
  }

  const accountParams = new URLSearchParams({
    select: "id,nova_id,display_name",
    id: `eq.${sessions[0].account_id}`,
    limit: "1"
  });

  const accounts = await db(`app_accounts?${accountParams}`);

  return accounts[0] || null;
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer ([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}

// ===============================
// APP API
// ===============================

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > MAX_BODY) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", reject);
  });
}

function checkRateLimit(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const old = rateLimits.get(ip);

  if (!old || now - old.time > 60000) {
    rateLimits.set(ip, { time: now, count: 1 });
    return true;
  }

  old.count++;
  return old.count <= 20;
}

async function handleApi(req, res, pathname) {
  if (req.method !== "POST" && pathname !== "/api/me") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (
    pathname === "/api/register" ||
    pathname === "/api/login"
  ) {
    if (!checkRateLimit(req)) {
      return sendJson(res, 429, {
        error: "Слишком много запросов. Попробуй позже."
      });
    }
  }

  if (pathname === "/api/register") {
    const data = await readBody(req);

    const name = String(data.name || "").trim();
    const password = String(data.password || "");

    if (name.length < 2 || name.length > 40) {
      return sendJson(res, 400, {
        error: "Имя должно содержать от 2 до 40 символов."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return sendJson(res, 400, {
        error: "Пароль должен содержать от 8 до 128 символов."
      });
    }

    for (let attempt = 0; attempt < 10; attempt++) {
      const novaId = "+" + crypto.randomInt(10000000, 99999999);

      try {
        const accounts = await db("app_accounts", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            nova_id: novaId,
            display_name: name,
            password_hash: createPasswordHash(password)
          })
        });

        if (!accounts.length) {
          throw new Error("Account was not created");
        }

        const account = accounts[0];
        const token = await createAppSession(account.id);

        return sendJson(res, 201, {
          success: true,
          message: "Аккаунт создан",
          nova_id: account.nova_id,
          display_name: account.display_name,
          token: token
        });

      } catch (error) {
        if (error.message.includes("409")) continue;
        throw error;
      }
    }

    return sendJson(res, 500, {
      error: "Не удалось создать NOVA ID. Попробуй ещё раз."
    });
  }

  if (pathname === "/api/login") {
    const data = await readBody(req);

    const novaId = String(data.nova_id || "").trim();
    const password = String(data.password || "");

    if (!/^\+\d{8}$/.test(novaId)) {
      return sendJson(res, 400, {
        error: "Неверный формат NOVA ID."
      });
    }

    const params = new URLSearchParams({
      select: "id,nova_id,display_name,password_hash",
      nova_id: `eq.${novaId}`,
      limit: "1"
    });

    const accounts = await db(`app_accounts?${params}`);
    const account = accounts[0];

    if (!account || !verifyPassword(password, account.password_hash)) {
      return sendJson(res, 401, {
        error: "Неверный NOVA ID или пароль."
      });
    }

    const token = await createAppSession(account.id);

    return sendJson(res, 200, {
      success: true,
      message: "Вход выполнен",
      nova_id: account.nova_id,
      display_name: account.display_name,
      token: token
    });
  }

  if (pathname === "/api/me") {
    const account = await getAppAccount(getBearer(req));

    if (!account) {
      return sendJson(res, 401, {
        error: "Сессия недействительна или истекла."
      });
    }

    return sendJson(res, 200, {
      success: true,
      nova_id: account.nova_id,
      display_name: account.display_name
    });
  }

  return sendJson(res, 404, {
    error: "API endpoint not found"
  });
}

// ===============================
// TELEGRAM BOT DATABASE FUNCTIONS
// ===============================

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

// ===============================
// TELEGRAM COMMANDS
// ===============================

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
      await sendMessage(chatId, "Пример:\n/message +12345678 Привет!");
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

// ===============================
// HTTP SERVER
// ===============================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("NOVA PIRATE is running!");
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url.pathname);
    } catch (error) {
      console.error("API error:", error.message);

      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "Внутренняя ошибка сервера."
        });
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ===============================
// TELEGRAM POLLING
// ===============================

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

server.listen(process.env.PORT || 10000, "0.0.0.0", () => {
  console.log("NOVA PIRATE server started");
  polling();
});
