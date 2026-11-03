"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

require("./helpers");
const http = require("../src/channels/http");

let server;
let base;

before(async () => {
  server = await http.start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("the chat page is served", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Muse Spark/);
});

test("the model view lists both providers with Muse active", async () => {
  const view = await (await fetch(`${base}/api/models`)).json();
  assert.equal(view.active, "muse");
  assert.deepEqual(view.providers.map((p) => p.id), ["muse", "claude"]);
  assert.equal(view.switchable, true);
});

test("switching models needs the admin token", async () => {
  const post = (headers) =>
    fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ provider: "claude" }),
    });

  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong-token" })).status, 401);

  const ok = await post({ authorization: "Bearer test-admin" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).active, "claude");
});

test("chat input is validated before any model is called", async () => {
  const chat = (body) =>
    fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await chat({ sessionId: "../../etc", text: "hi" })).status, 400);
  assert.equal((await chat({ sessionId: "abcdefgh-1234", text: "" })).status, 400);
  assert.equal((await chat({ sessionId: "abcdefgh-1234", text: "x".repeat(1001) })).status, 400);
});

test("oversized bodies are rejected", async () => {
  const res = await fetch(`${base}/api/chat`, { method: "POST", body: "x".repeat(20_000) });
  assert.equal(res.status, 413);
});
