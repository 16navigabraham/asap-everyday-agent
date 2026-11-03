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

const chat = (body) =>
  fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the root is a JSON description of the API, not a web page", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const info = await res.json();
  assert.equal(info.model, "Meta Muse Spark");
  assert.equal(info.modelId, "muse-spark-1.1");
  assert.ok(info.endpoints["POST /api/chat"]);
});

test("there is no model switch or admin endpoint", async () => {
  assert.equal((await fetch(`${base}/api/models`)).status, 404);
  assert.equal((await fetch(`${base}/api/models`, { method: "POST" })).status, 404);
});

test("chat input is validated before Muse is called", async () => {
  assert.equal((await chat({ sessionId: "../../etc", text: "hi" })).status, 400);
  assert.equal((await chat({ sessionId: "abcdefgh-1234", text: "" })).status, 400);
  assert.equal((await chat({ sessionId: "abcdefgh-1234", text: "x".repeat(1001) })).status, 400);
});

test("only real image types and base64 are accepted as photos", async () => {
  const bad = [
    { mediaType: "text/html", data: "aGk=" },
    { mediaType: "image/png", data: "<script>" },
    { mediaType: "image/png" },
  ];
  for (const image of bad) {
    const res = await chat({ sessionId: "abcdefgh-1234", text: "meter", image });
    assert.equal(res.status, 400);
  }
});

test("a photo becomes an image block followed by the caption", () => {
  const content = http.userContent("pay this", { mediaType: "image/jpeg", data: "aGk=" });
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.media_type, "image/jpeg");
  assert.deepEqual(content[1], { type: "text", text: "pay this" });
});

test("listing photos are served as SVG, unknown ones 404", async () => {
  const ok = await fetch(`${base}/media/listing/101.svg`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await ok.text(), /Jollof/);
  assert.equal((await fetch(`${base}/media/listing/999.svg`)).status, 404);
});

test("oversized bodies are rejected", async () => {
  const res = await fetch(`${base}/api/chat`, { method: "POST", body: "x".repeat(6 * 1024 * 1024) });
  assert.equal(res.status, 413);
});
