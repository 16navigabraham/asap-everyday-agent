"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, toolUse } = require("./helpers");
const { executeTools, NOT_EXECUTED, UNKNOWN_RESULT } = require("../src/agent/executor");
const { defineTool } = require("../src/agent/tools/define");

beforeEach(resetAll);

const ctx = { userId: "test:exec", turnId: "turn-1" };
const parse = (block) => JSON.parse(block.content);

function registry(...tools) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return (name) => map.get(name) || null;
}

test("an unknown tool is answered with an error result, not thrown", async () => {
  const [result] = await executeTools([toolUse("make_coffee", {})], ctx);
  assert.equal(result.is_error, true);
  assert.equal(parse(result).reason, "unknown_tool");
});

test("arguments failing the schema never reach the handler", async () => {
  let ran = false;
  const tool = defineTool({
    name: "spend",
    kind: "money",
    description: "test",
    properties: { amountNaira: { type: "integer" } },
    required: ["amountNaira"],
    handler: () => {
      ran = true;
      return { ok: true };
    },
  });

  for (const input of [{}, { amountNaira: "500" }, { amountNaira: 1.5 }, { amountNaira: 5, extra: true }]) {
    const [result] = await executeTools([toolUse("spend", input)], ctx, { lookup: registry(tool) });
    assert.equal(parse(result).reason, "invalid_arguments");
  }
  assert.equal(ran, false);
});

test("only one money tool runs per model response", async () => {
  const calls = [
    toolUse("buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 100 }),
    toolUse("buy_airtime", { network: "glo", phone: "08051234567", amountNaira: 100 }),
  ];
  const [first, second] = await executeTools(calls, ctx);
  assert.equal(parse(first).ok, true);
  assert.equal(parse(second).reason, "one_money_action_per_turn");
  assert.equal(parse(second).message, NOT_EXECUTED);
});

test("a thrown handler never leaks its error text, and money vs read get different instructions", async () => {
  const boom = (kind) =>
    defineTool({
      name: `boom_${kind}`,
      kind,
      description: "test",
      handler: () => {
        throw new Error("SELECT secret_column FROM internal_table");
      },
    });

  const lookup = registry(boom("money"), boom("read"));
  const [money] = await executeTools([toolUse("boom_money", {})], ctx, { lookup });
  const [read] = await executeTools([toolUse("boom_read", {})], ctx, { lookup });

  assert.equal(parse(money).message, NOT_EXECUTED);
  assert.equal(parse(read).message, UNKNOWN_RESULT);
  assert.doesNotMatch(money.content + read.content, /secret_column/);
});

test("a hung tool times out", async () => {
  const slow = defineTool({ name: "slow_read", kind: "read", description: "test", handler: () => new Promise(() => {}) });
  const [result] = await executeTools([toolUse("slow_read", {})], ctx, {
    lookup: registry(slow),
    timeouts: { read: 20, money: 20 },
  });
  assert.equal(parse(result).reason, "tool_failed");
});

test("Nigerian phone numbers are normalised and junk is rejected", () => {
  const { normalisePhone } = require("../src/agent/tools/phone");
  assert.equal(normalisePhone("+234 803 123 4567"), "08031234567");
  assert.equal(normalisePhone("2348031234567"), "08031234567");
  assert.equal(normalisePhone("0803-123-4567"), "08031234567");
  assert.equal(normalisePhone("12345"), null);
  assert.equal(normalisePhone("06031234567"), null);
});
