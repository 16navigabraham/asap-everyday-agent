"use strict";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll } = require("./helpers");
const http = require("../src/channels/http");
const mcp = require("../src/channels/mcp");
const checkout = require("../src/orders/checkout");

let server;
let base;

before(async () => {
  server = await http.start(0);
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(() => server.close());
beforeEach(() => {
  resetAll();
  mcp.reset();
});

let nextId = 1;
async function rpc(method, params, headers = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
}

async function connect(headers = {}) {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, headers);
  return { ...headers, "mcp-session-id": init.headers.get("mcp-session-id"), init };
}

async function call(session, name, args) {
  const { body } = await rpc("tools/call", { name, arguments: args }, session);
  return body.result ? body.result.structuredContent : body;
}

test("initialize opens a session and tells the assistant to confirm with the user", async () => {
  const { init, ...session } = await connect();
  assert.equal(init.status, 200);
  assert.ok(session["mcp-session-id"]);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "asap");
  assert.match(init.body.result.instructions, /explicit yes before calling confirm_purchase/);
});

test("tools are listed with annotations: reads are read-only, confirming money is destructive", async () => {
  const session = await connect();
  const { body } = await rpc("tools/list", {}, session);
  const tools = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));

  assert.equal(tools.check_balance.annotations.readOnlyHint, true);
  assert.equal(tools.confirm_purchase.annotations.destructiveHint, true);
  assert.equal(tools.confirm_share.annotations.destructiveHint, true);
  assert.equal(tools.buy_airtime.annotations.destructiveHint, false, "quoting moves no money");
  assert.ok(tools.get_updates);
  assert.equal(tools.ask_user, undefined);
  assert.equal(tools.buy_airtime.inputSchema.additionalProperties, false);
});

test("an assistant can quote, confirm, and see the delivery, with the same money rules", async () => {
  const session = await connect();
  const quote = await call(session, "buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 500 });
  assert.equal(quote.status, "quoted");
  assert.equal((await call(session, "check_balance", {})).balance, "₦5,000", "a quote charges nothing");

  const confirmed = await call(session, "confirm_purchase", { orderId: quote.orderId });
  assert.equal(confirmed.status, "paid");
  await checkout.settled(quote.orderId);

  const { updates } = await call(session, "get_updates", {});
  assert.match(updates[0].text, /^Done: ₦500 MTN airtime/);
  assert.equal((await call(session, "check_balance", {})).balance, "₦4,500");
});

test("bad arguments are rejected by the same validation as chat", async () => {
  const session = await connect();
  const { body } = await rpc("tools/call", { name: "buy_airtime", arguments: { network: "mtn", phone: "123", amountNaira: 500 } }, session);
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.reason, "invalid_arguments");
});

test("a session is one wallet; a bearer token keeps the same wallet across sessions", async () => {
  const a = await connect();
  const b = await connect();
  await call(a, "add_money", { amountNaira: 1000 });
  const quoteA = await call(a, "buy_airtime", { network: "glo", phone: "08051234567", amountNaira: 100 });
  const stolen = await call(b, "confirm_purchase", { orderId: quoteA.orderId });
  assert.equal(stolen.reason, "not_found", "another session cannot confirm this wallet's order");

  const key = { authorization: "Bearer a-long-personal-test-key" };
  const first = await connect(key);
  await call(first, "set_name", { name: "Tobi" });
  const second = await connect(key);
  assert.equal((await call(second, "show_account", { what: "account_number" })).accountName, "ASAP / Tobi");
});

test("protocol edges: no session, unknown tool, unknown method, notifications, ping", async () => {
  assert.equal((await rpc("tools/list", {})).status, 404);

  const session = await connect();
  assert.equal((await rpc("tools/call", { name: "launch_rocket", arguments: {} }, session)).body.error.code, -32602);
  assert.equal((await rpc("resources/list", {}, session)).body.error.code, -32601);
  assert.deepEqual((await rpc("ping", {}, session)).body.result, {});

  const note = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202);
  assert.equal((await fetch(base)).status, 405);
});
