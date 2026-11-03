"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

require("./helpers");
const { complete, messagesFor } = require("../src/model/client");
const modelSwitch = require("../src/model/switch");

beforeEach(() => modelSwitch.set("muse"));

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const handler = handlers.shift();
    const { status = 200, json = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } } = handler(call) || {};
    return {
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
  fn.calls = calls;
  return fn;
}

const request = { system: "sys", tools: [], messages: [{ role: "user", content: "hi" }] };

test("Muse Spark is the default and is called through Meta's Messages endpoint", async () => {
  const fetchImpl = fakeFetch([() => {}]);
  const { provider } = await complete({ ...request, fetchImpl });
  const [call] = fetchImpl.calls;

  assert.equal(provider, "muse");
  assert.equal(call.url, "https://api.meta.ai/v1/messages");
  assert.equal(call.headers.authorization, "Bearer test-meta-key");
  assert.equal(call.body.model, "muse-spark-1.1");
  assert.deepEqual(call.body.thinking, { type: "adaptive" });
  assert.deepEqual(call.body.output_config, { effort: "low" });
  assert.doesNotMatch(JSON.stringify(call.body), /cache_control/);
});

test("the switch sends the next call to Claude with Anthropic's auth", async () => {
  assert.equal(modelSwitch.set("claude").ok, true);
  const fetchImpl = fakeFetch([() => {}]);
  const { provider } = await complete({ ...request, fetchImpl });
  const [call] = fetchImpl.calls;

  assert.equal(provider, "claude");
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.headers["x-api-key"], "test-anthropic-key");
  assert.equal(call.body.thinking, undefined);
});

test("an outage on Muse fails over to Claude once", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 503, json: {} }), () => {}]);
  const result = await complete({ ...request, fetchImpl });
  assert.equal(result.provider, "claude");
  assert.equal(result.failedOver, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test("a 400 is not failed over: the request is wrong, not the provider", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 400, json: {} })]);
  await assert.rejects(complete({ ...request, fetchImpl }), { status: 400 });
  assert.equal(fetchImpl.calls.length, 1);
});

test("no failover once a turn has started running tools", async () => {
  const fetchImpl = fakeFetch([() => ({ status: 503, json: {} })]);
  await assert.rejects(complete({ ...request, fetchImpl, allowFailover: false }), { status: 503 });
  assert.equal(fetchImpl.calls.length, 1);
});

test("an unconfigured provider cannot be switched to", () => {
  assert.equal(modelSwitch.set("gpt").ok, false);
});

test("thinking blocks from another provider are stripped, and the provider tag never leaves", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", by: "muse", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "hello" }] },
    { role: "user", content: "again" },
  ];
  const forClaude = messagesFor("claude", history);
  const forMuse = messagesFor("muse", history);

  assert.deepEqual(forClaude[1].content, [{ type: "text", text: "hello" }]);
  assert.equal(forMuse[1].content.length, 2);
  assert.ok(forClaude.every((m) => !("by" in m)) && forMuse.every((m) => !("by" in m)));
});
