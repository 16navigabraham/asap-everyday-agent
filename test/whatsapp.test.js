"use strict";

process.env.WHATSAPP_TOKEN = "wa-test-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
process.env.WHATSAPP_APP_SECRET = "app-secret";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { resetAll, scriptedModel, toolUse, text, lastToolResult } = require("./helpers");
const http = require("../src/channels/http");
const whatsapp = require("../src/channels/whatsapp");

let server;
let base;
const graphCalls = [];

before(async () => {
  whatsapp.start();
  server = await http.start(0);
  base = `http://127.0.0.1:${server.address().port}/whatsapp/webhook`;
});
after(() => server.close());
beforeEach(() => {
  resetAll();
  graphCalls.length = 0;
  whatsapp.deps.fetch = async (url, init = {}) => {
    graphCalls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (url === "https://lookaside.example/media-1") return { ok: true, arrayBuffer: async () => new TextEncoder().encode("jpeg").buffer };
    if (url.endsWith("/media-1")) return { ok: true, json: async () => ({ url: "https://lookaside.example/media-1", mime_type: "image/jpeg", file_size: 4 }) };
    return { ok: true, json: async () => ({ messages: [{ id: "wamid.out" }] }) };
  };
});

const sign = (raw) => `sha256=${crypto.createHmac("sha256", "app-secret").update(raw).digest("hex")}`;

function payload(message) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }] }],
  });
}

const textMessage = (body, id = `wamid.${Math.random()}`) => ({ from: "2348031234567", id, timestamp: "1", type: "text", text: { body } });

const sentTexts = () => graphCalls.filter((c) => c.body?.type === "text").map((c) => c.body.text.body);

test("the subscription handshake echoes the challenge only for the right verify token", async () => {
  const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
});

test("a delivery without a valid signature is refused", async () => {
  const raw = payload(textMessage("hi"));
  const unsigned = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  assert.equal(unsigned.status, 401);
  const forged = await fetch(base, { method: "POST", headers: { "x-hub-signature-256": sign(`${raw} `) }, body: raw });
  assert.equal(forged.status, 401);
});

test("a text message runs a Muse turn and the reply goes back through the Cloud API", async () => {
  whatsapp.deps.call = scriptedModel([
    () => [toolUse("check_balance", {})],
    (messages) => [text(`You have ${lastToolResult(messages).balance}.`)],
  ]);

  const raw = Buffer.from(payload(textMessage("what's my balance?")));
  const { status, done } = whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) });
  assert.equal(status, 200);
  await done;

  const send = graphCalls.find((c) => c.body?.type === "text");
  assert.equal(send.url, "https://graph.facebook.com/v21.0/1234567890/messages");
  assert.equal(send.headers.authorization, "Bearer wa-test-token");
  assert.equal(send.body.to, "2348031234567");
  assert.equal(send.body.text.body, "You have ₦5,000.");
  assert.ok(graphCalls.some((c) => c.body?.status === "read" && c.body.typing_indicator), "read receipt + typing indicator");
});

test("Meta's retries of the same message are answered once", async () => {
  whatsapp.deps.call = scriptedModel([() => [text("once")], () => [text("twice")]]);
  const raw = Buffer.from(payload(textMessage("hi", "wamid.same")));
  await whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) }).done;
  await whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) }).done;
  assert.deepEqual(sentTexts(), ["once"]);
});

test("a photo is downloaded through the Graph API and handed to Muse as an image", async () => {
  let seen;
  whatsapp.deps.call = scriptedModel([
    (messages) => {
      seen = messages.at(-1).content;
      return [text("I can see the meter number. Is it 45031234567?")];
    },
  ]);
  const message = { from: "2348031234567", id: "wamid.photo", type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "pay this" } };
  const raw = Buffer.from(payload(message));
  await whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) }).done;

  assert.equal(seen[0].type, "image");
  assert.equal(seen[0].source.data, Buffer.from("jpeg").toString("base64"));
  assert.deepEqual(seen[1], { type: "text", text: "pay this" });
});

test("unsupported message types get a short, honest reply without calling Muse", async () => {
  whatsapp.deps.call = async () => {
    throw new Error("should not be called");
  };
  const raw = Buffer.from(payload({ from: "2348031234567", id: "wamid.video", type: "video", video: { id: "v1" } }));
  await whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) }).done;
  assert.match(sentTexts()[0], /voice note/);
});

test("a voice note is downloaded, transcribed by Muse, and answered like typed words", async () => {
  whatsapp.deps.fetch = async (url, init = {}) => {
    graphCalls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (url === "https://lookaside.example/voice-1") return { ok: true, arrayBuffer: async () => new TextEncoder().encode("opus").buffer };
    if (url.endsWith("/voice-1")) return { ok: true, json: async () => ({ url: "https://lookaside.example/voice-1", mime_type: "audio/ogg; codecs=opus", file_size: 4 }) };
    return { ok: true, json: async () => ({}) };
  };
  let heard;
  whatsapp.deps.voiceNote = async (bytes, mimeType) => {
    heard = { bytes: bytes.toString(), mimeType };
    return "[Voice note] Ẹ jọ̀ọ́, ra ₦500 MTN fún 08031234567";
  };
  let seen;
  whatsapp.deps.call = scriptedModel([
    (messages) => {
      seen = messages.at(-1).content;
      return [text("Ṣé ₦500 MTN fún 08031234567 ni? Ẹ fèsì bẹ́ẹ̀ni.")];
    },
  ]);

  const raw = Buffer.from(payload({ from: "2348031234567", id: "wamid.voice", type: "audio", audio: { id: "voice-1", voice: true } }));
  await whatsapp.receive(raw, { "x-hub-signature-256": sign(raw) }).done;

  assert.deepEqual(heard, { bytes: "opus", mimeType: "audio/ogg" });
  assert.equal(seen, "[Voice note] Ẹ jọ̀ọ́, ra ₦500 MTN fún 08031234567");
  assert.match(sentTexts().at(-1), /bẹ́ẹ̀ni/);
});
