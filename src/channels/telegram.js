"use strict";

const config = require("../config");
const logger = require("../log");
const notify = require("../notify");
const { handleMessage } = require("../conversations");

/**
 * Telegram over long polling, with plain fetch. The bot token is part of
 * every Bot API URL, so URLs are never logged.
 */

const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
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

/** The largest size of a sent photo, as a base64 image block. */
async function photoBlock(photos) {
  const best = photos[photos.length - 1];
  if (best.file_size && best.file_size > MAX_PHOTO_BYTES) return null;
  const file = await call("getFile", { file_id: best.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) return null;
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bytes.toString("base64") } };
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;
  const text = message.text || message.caption || "";
  const isStart = text.startsWith("/start");
  if (text.startsWith("/") && !isStart) return;
  if (!text && !message.photo) return;

  const chatId = message.chat.id;
  const typing = setInterval(() => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4000);
  call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    let content = isStart ? "Hi" : text.slice(0, 1000);
    if (message.photo) {
      const image = await photoBlock(message.photo).catch(() => null);
      content = image
        ? [image, { type: "text", text: content || "(The user sent this photo without a caption.)" }]
        : `${content}\n(The user sent a photo that could not be read. Ask them to type the details.)`.trim();
    }

    const { reply, attachments } = await handleMessage(`tg:${chatId}`, content);
    await sendText(chatId, reply);
    for (const attachment of attachments) {
      // Listing photos are SVG, which Telegram can't show as a photo; name it instead.
      await sendText(chatId, `📷 ${attachment.caption}`);
    }
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
