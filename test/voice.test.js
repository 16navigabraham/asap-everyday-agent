"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, scriptedModel, text } = require("./helpers");
const muse = require("../src/model/muse");
const http = require("../src/channels/http");

/** `fakeFetch` for the ASR endpoint: body is multipart FormData, not JSON,
 * so calls are recorded with the raw body for tests that need to inspect
 * the `request` part themselves. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init.body });
    const { status = 200, json = {} } = handlers.shift()(calls[calls.length - 1]) || {};
    return { ok: status < 400, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

async function requestPartOf(formData) {
  for (const [key, value] of formData.entries()) {
    if (key === "request") return JSON.parse(await value.text());
  }
  return undefined;
}

const transcript = (value) => ({ json: { transcript: value } });
const fakeWav = async () => Buffer.from("fake-wav-bytes");

test("a voice note goes to Muse Voice Transcribe, not Muse Spark's chat endpoint", async () => {
  const fetchImpl = fakeFetch([() => transcript("Mo fẹ́ ra ìrẹsì")]);
  const result = await muse.transcribe(Buffer.from("opus"), "audio/ogg; codecs=opus", {
    fetchImpl,
    convertImpl: fakeWav,
  });
  const [call] = fetchImpl.calls;

  assert.deepEqual(result, { ok: true, text: "Mo fẹ́ ra ìrẹsì" });
  assert.equal(call.url, "https://api.meta.ai/v1/asr/transcribe");
  assert.ok(call.body instanceof FormData, "sends multipart form data, not JSON");

  const requestPart = await requestPartOf(call.body);
  assert.equal(requestPart.model, "muse-voice-transcribe-1.0");
  assert.equal(requestPart.audioEncoding, "WAV");
  assert.equal(requestPart.languageBias, undefined, "forcing English would only hurt the other 4 languages this repo targets");
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
