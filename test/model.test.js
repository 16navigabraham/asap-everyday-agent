"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

require("./helpers");
const muse = require("../src/model/muse");

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const handler = handlers.shift();
    const { status = 200, json = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } } = handler(call) || {};
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  fn.calls = calls;
  return fn;
}

const request = { system: "sys", tools: [], messages: [{ role: "user", content: "hi" }], retryDelayMs: 0 };

test("every turn goes to Muse Spark through Meta's Messages endpoint", async () => {
  const fetchImpl = fakeFetch([() => {}]);
  const { model } = await muse.complete({ ...request, fetchImpl });
  const [call] = fetchImpl.calls;

  assert.equal(model, "muse-spark-1.1");
  assert.equal(call.url, "https://api.meta.ai/v1/messages");
  assert.equal(call.headers.authorization, "Bearer test-meta-key");
  assert.equal(call.body.model, "muse-spark-1.1");
  assert.deepEqual(call.body.thinking, { type: "adaptive" });
  assert.deepEqual(call.body.output_config, { effort: "low" });
  assert.doesNotMatch(JSON.stringify(call.body), /cache_control/);
});

test("a transient Muse failure is retried once", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 503, json: {} }), () => {}]);
  const { response } = await muse.complete({ ...request, fetchImpl });
  assert.equal(response.content[0].text, "ok");
  assert.equal(fetchImpl.calls.length, 2);
});

test("a second failure is reported, not retried forever", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 503, json: {} }), () => ({ status: 503, json: {} })]);
  await assert.rejects(muse.complete({ ...request, fetchImpl }), { status: 503 });
  assert.equal(fetchImpl.calls.length, 2);
});

test("a 400 is not retried: the request itself is wrong", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 400, json: {} })]);
  await assert.rejects(muse.complete({ ...request, fetchImpl }), { status: 400 });
  assert.equal(fetchImpl.calls.length, 1);
});

test("a network error is retried", async () => {
  let first = true;
  const fetchImpl = async () => {
    if (first) {
      first = false;
      throw new TypeError("fetch failed");
    }
    return { ok: true, status: 200, json: async () => ({ content: [], stop_reason: "end_turn" }) };
  };
  const { response } = await muse.complete({ ...request, fetchImpl });
  assert.equal(response.stop_reason, "end_turn");
});
