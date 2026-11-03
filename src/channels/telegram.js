"use strict";

const config = require("../config");
const logger = require("../log");
const notify = require("../notify");
const { handleMessage } = require("../conversations");

/**
 * Telegram over long polling, with plain fetch. The bot token is part of
 * every Bot API URL, so URLs are never logged.
 */

const api = (method) => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.error_code}`);
  return json.result;
}

const sendText = (chatId, text) => call("sendMessage", { chat_id: chatId, text });

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;
  const isStart = message.text.startsWith("/start");
  if (message.text.startsWith("/") && !isStart) return;

  const chatId = message.chat.id;
  const text = isStart ? "Hi" : message.text.slice(0, 1000);

  const typing = setInterval(() => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4000);
  call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  try {
    const { reply } = await handleMessage(`tg:${chatId}`, text);
    await sendText(chatId, reply);
  } finally {
    clearInterval(typing);
  }
}

async function start() {
  notify.register("tg", (userId, text) => sendText(userId.slice("tg:".length), text));

  let offset = 0;
  logger.info("Telegram polling started");
  for (;;) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        // Not awaited: one slow chat must not hold up everyone else's.
        handleUpdate(update).catch((error) => logger.error("Telegram update failed", { error: error.message }));
      }
    } catch (error) {
      logger.warn("Telegram poll failed", { error: error.message });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

module.exports = { start };
