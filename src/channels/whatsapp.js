"use strict";

const crypto = require("node:crypto");

const config = require("../config");
const logger = require("../log");
const notify = require("../notify");
const muse = require("../model/muse");
const { handleMessage } = require("../conversations");

/**
 * WhatsApp, through Meta's WhatsApp Cloud API: text, voice notes and photos.
 *
 *   GET  /whatsapp/webhook  Meta's subscription handshake (hub.verify_token)
 *   POST /whatsapp/webhook  message delivery, signed with the app secret
 *
 * The POST answers 200 as soon as the signature checks out, and the turn
 * runs afterwards: Meta retries a slow webhook, and a retry is a duplicate
 * message. Message ids are remembered for a while, so a retry that does
 * arrive is dropped instead of answered twice.
 */

const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 4000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Swappable in tests.
const deps = {
  fetch: (...args) => fetch(...args),
  call: undefined,
  voiceNote: (bytes, mimeType) => muse.voiceNoteContent(bytes, mimeType),
};

const isConfigured = () => {
  const w = config.whatsapp;
  return Boolean(w.token && w.phoneNumberId && w.verifyToken && w.appSecret);
};

const graph = (path) => `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;
const auth = () => ({ authorization: `Bearer ${config.whatsapp.token}` });

async function graphPost(path, body) {
  const res = await deps.fetch(graph(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${path} failed: ${res.status}`);
  return res.json();
}

async function sendText(to, text) {
  for (let i = 0; i < text.length; i += MAX_TEXT) {
    await graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(i, i + MAX_TEXT) },
    });
  }
}

/** Blue ticks plus the typing bubble while Muse works. Cosmetic: failures are ignored. */
function markReadAndTyping(messageId) {
  return graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  }).catch(() => {});
}

/** Download sent media through the Graph API: { bytes, mimeType }, or null. */
async function downloadMedia(mediaId, { accept, maxBytes }) {
  const metaRes = await deps.fetch(graph(mediaId), { headers: auth(), signal: AbortSignal.timeout(15_000) });
  if (!metaRes.ok) return null;
  const media = await metaRes.json();
  const mimeType = String(media.mime_type || "").split(";")[0].trim();
  if (!accept(mimeType) || Number(media.file_size) > maxBytes) return null;

  const file = await deps.fetch(media.url, { headers: auth(), signal: AbortSignal.timeout(30_000) });
  if (!file.ok) return null;
  const bytes = Buffer.from(await file.arrayBuffer());
  return bytes.length > maxBytes ? null : { bytes, mimeType };
}

async function photoBlock(mediaId) {
  const media = await downloadMedia(mediaId, { accept: (t) => IMAGE_TYPES.has(t), maxBytes: MAX_PHOTO_BYTES });
  if (!media) return null;
  return { type: "image", source: { type: "base64", media_type: media.mimeType, data: media.bytes.toString("base64") } };
}

async function voiceContent(mediaId) {
  const media = await downloadMedia(mediaId, { accept: (t) => t.startsWith("audio/"), maxBytes: MAX_AUDIO_BYTES });
  if (!media) return "[The user sent a voice note that could not be downloaded. Ask them to send it again or type it.]";
  return deps.voiceNote(media.bytes, media.mimeType);
}

/** Constant-time check of X-Hub-Signature-256 over the raw body. Fails closed. */
function validSignature(rawBody, header) {
  if (!config.whatsapp.appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const seen = new Map();
const SEEN_TTL_MS = 60 * 60_000;
function firstTime(id) {
  const now = Date.now();
  if (seen.size > 5000) for (const [key, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(key);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

/** The messages in a webhook payload, ignoring delivery and read statuses. */
function messagesIn(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) out.push(message);
    }
  }
  return out;
}

async function handleIncoming(message) {
  if (!message?.id || !message.from || !firstTime(message.id)) return;
  const from = message.from;

  const supported = ["text", "image", "audio"].includes(message.type);
  if (supported) markReadAndTyping(message.id);

  let content;
  if (message.type === "text") {
    content = String(message.text?.body || "").slice(0, 1000);
  } else if (message.type === "audio") {
    content = await voiceContent(message.audio?.id).catch(() => "[The user sent a voice note that could not be heard. Ask them to send it again or type it.]");
  } else if (message.type === "image") {
    const caption = String(message.image?.caption || "").slice(0, 1000);
    const image = await photoBlock(message.image?.id).catch(() => null);
    content = image
      ? [image, { type: "text", text: caption || "(The user sent this photo without a caption.)" }]
      : `${caption}\n(The user sent a photo that could not be read. Ask them to type the details.)`.trim();
  } else {
    await sendText(from, "Send me a text, a voice note or a photo of the bill or meter, and I'll take it from there.");
    return;
  }
  if (!content) return;

  const { reply, attachments } = await handleMessage(`wa:${from}`, content, { call: deps.call });
  await sendText(from, reply);
  for (const attachment of attachments) await sendText(from, `📷 ${attachment.caption}`);
}

/** GET /whatsapp/webhook. Returns [status, body]. */
function verify(url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";
  const expected = config.whatsapp.verifyToken || "";
  const matches =
    token.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  return mode === "subscribe" && matches ? [200, challenge] : [403, "forbidden"];
}

/**
 * POST /whatsapp/webhook. Checks the signature and returns at once; the
 * returned promise (`done`) settles when the messages have been answered.
 */
function receive(rawBody, headers) {
  if (!validSignature(rawBody, headers["x-hub-signature-256"])) return { status: 401, done: Promise.resolve() };

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400, done: Promise.resolve() };
  }

  const done = Promise.all(
    messagesIn(payload).map((message) =>
      handleIncoming(message).catch((error) => logger.error("WhatsApp message failed", { error: error.message })),
    ),
  );
  return { status: 200, done };
}

function start() {
  notify.register("wa", (userId, text) => sendText(userId.slice("wa:".length), text));
  logger.info("WhatsApp channel on", { webhook: "/whatsapp/webhook" });
}

module.exports = { isConfigured, verify, receive, start, validSignature, deps };
