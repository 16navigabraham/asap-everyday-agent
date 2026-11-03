"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, scriptedModel, text } = require("./helpers");
const muse = require("../src/model/muse");
const http = require("../src/channels/http");

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, body: JSON.parse(init.body) };
    calls.push(call);
    const { status = 200, json = {} } = handlers.shift()(call) || {};
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  fn.calls = calls;
  return fn;
}

const transcript = (value) => ({ json: { content: [{ type: "text", text: value }], stop_reason: "end_turn" } });

test("a voice note goes to Muse Spark with a verbatim, keep-the-language instruction", async () => {
  const fetchImpl = fakeFetch([() => transcript("Mo fẹ́ ra ìrẹsì")]);
  const result = await muse.transcribe(Buffer.from("opus"), "audio/ogg; codecs=opus", { fetchImpl });
  const [call] = fetchImpl.calls;

  assert.deepEqual(result, { ok: true, text: "Mo fẹ́ ra ìrẹsì", format: "source" });
  assert.equal(call.url, "https://api.meta.ai/v1/messages");
  assert.equal(call.body.model, "muse-spark-1.1");
  const [audio, instruction] = call.body.messages[0].content;
  assert.deepEqual(audio, { type: "audio", source: { type: "base64", media_type: "audio/ogg", data: Buffer.from("opus").toString("base64") } });
  assert.match(instruction.text, /Yoruba, Hausa, Igbo/);
  assert.match(instruction.text, /do not translate/);
  assert.match(instruction.text, /digits/);
  assert.equal(call.body.tools, undefined, "transcription can never call a tool");
});

test("if Meta rejects one audio format, the other is tried once", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 400 }), () => transcript("Ina son shinkafa")]);
  const result = await muse.transcribe(Buffer.from("x"), "audio/ogg", { fetchImpl });
  assert.equal(result.text, "Ina son shinkafa");
  assert.equal(result.format, "input_audio");
  assert.equal(fetchImpl.calls[1].body.messages[0].content[0].type, "input_audio");
});

test("audio Muse cannot take becomes a polite ask-again, never a crash", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 400 }), () => ({ status: 400 })]);
  assert.deepEqual(await muse.transcribe(Buffer.from("x"), "audio/ogg", { fetchImpl }), { ok: false, reason: "audio_not_accepted" });

  const silent = fakeFetch([() => transcript("")]);
  assert.equal((await muse.transcribe(Buffer.from("x"), "audio/ogg", { fetchImpl: silent })).reason, "no_speech");
});

let server;
let base;
before(async () => {
  resetAll();
  server = await http.start(0);
  base = `http://127.0.0.1:${server.address().port}/api/chat`;
});
after(() => server.close());

test("the HTTP API accepts a voice note and the turn sees the transcript", async () => {
  http.deps.voiceNote = async () => "[Voice note] Abeg buy ₦200 Glo for 08051234567";
  const model = scriptedModel([() => [text("Na ₦200 Glo for 08051234567? Make I go ahead?")]]);
  http.deps.call = model;

  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "voice-test-1", audio: { mediaType: "audio/ogg", data: Buffer.from("opus").toString("base64") } }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).reply, /Make I go ahead/);
  assert.equal(model.seen[0].at(-1).content, "[Voice note] Abeg buy ₦200 Glo for 08051234567");

  const bad = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "voice-test-1", audio: { mediaType: "video/mp4", data: "aGk=" } }),
  });
  assert.equal(bad.status, 400);
});
