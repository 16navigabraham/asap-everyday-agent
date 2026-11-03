"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, scriptedModel, text } = require("./helpers");
const muse = require("../src/model/muse");
const http = require("../src/channels/http");

/** `fakeFetch` for Chat Completions: plain JSON body, unlike the old ASR
 * endpoint's multipart form. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const { status = 200, json = {} } = handlers.shift()(calls[calls.length - 1]) || {};
    return { ok: status < 400, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

const transcript = (value) => ({ json: { choices: [{ message: { content: value } }] } });
const fakeWav = async () => Buffer.from("fake-wav-bytes");

test("a voice note goes to Muse Spark 1.2 via Chat Completions", async () => {
  const fetchImpl = fakeFetch([() => transcript("Mo fẹ́ ra ìrẹsì")]);
  const result = await muse.transcribe(Buffer.from("opus"), "audio/ogg; codecs=opus", {
    fetchImpl,
    convertImpl: fakeWav,
  });
  const [call] = fetchImpl.calls;

  assert.deepEqual(result, { ok: true, text: "Mo fẹ́ ra ìrẹsì" });
  assert.equal(call.url, "https://api.meta.ai/v1/chat/completions");
  assert.equal(call.body.model, "muse-spark-1.2");
  assert.equal(call.body.max_completion_tokens, 4000, "needs real budget or the transcript comes back empty");

  const [instruction, audio] = call.body.messages[0].content;
  assert.match(instruction.text, /verbatim/);
  assert.match(instruction.text, /Yoruba, Hausa, Igbo/);
  assert.match(instruction.text, /do not translate/);
  assert.deepEqual(audio, { type: "input_audio", input_audio: { data: Buffer.from("fake-wav-bytes").toString("base64"), format: "wav" } });
});

test("if WAV conversion fails, Muse is never called over the network", async () => {
  let calledFetch = false;
  const fetchImpl = async () => { calledFetch = true; return { ok: true, status: 200, json: async () => ({}) }; };

  const result = await muse.transcribe(Buffer.from("x"), "audio/ogg", {
    fetchImpl,
    convertImpl: async () => { throw new Error("ffmpeg exited 1"); },
  });

  assert.deepEqual(result, { ok: false, reason: "conversion_failed" });
  assert.equal(calledFetch, false);
});

test("audio Muse cannot transcribe becomes a polite ask-again, never a crash", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 400 })]);
  assert.deepEqual(
    await muse.transcribe(Buffer.from("x"), "audio/ogg", { fetchImpl, convertImpl: fakeWav }),
    { ok: false, reason: "provider_error" },
  );

  const silent = fakeFetch([() => transcript("")]);
  assert.equal(
    (await muse.transcribe(Buffer.from("x"), "audio/ogg", { fetchImpl: silent, convertImpl: fakeWav })).reason,
    "no_speech",
  );
});

test("convertToWav rejects audio it cannot decode, rather than hanging or passing garbage through", async () => {
  await assert.rejects(() => muse.convertToWav(Buffer.from("not an audio file")), /ffmpeg exited/);
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
