"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll } = require("./helpers");
const ledger = require("../src/wallet/ledger");
const { canMove } = require("../src/orders/states");

beforeEach(resetAll);

test("a new wallet starts with the sandbox credit", () => {
  assert.equal(ledger.balanceKobo("test:a"), 500_000);
});

test("the same debit reference moves money once", () => {
  ledger.debit("test:a", 10_000, "order:1", "x");
  const again = ledger.debit("test:a", 10_000, "order:1", "x");
  assert.equal(again.replayed, true);
  assert.equal(ledger.balanceKobo("test:a"), 490_000);
});

test("the same refund reference credits once", () => {
  ledger.credit("test:a", 10_000, "refund:1", "x");
  ledger.credit("test:a", 10_000, "refund:1", "x");
  assert.equal(ledger.balanceKobo("test:a"), 510_000);
});

test("overdrawing throws with the shortfall and moves nothing", () => {
  assert.throws(
    () => ledger.debit("test:a", 600_000, "order:2", "x"),
    (error) => error instanceof ledger.InsufficientFunds && error.shortfallKobo === 100_000,
  );
  assert.equal(ledger.balanceKobo("test:a"), 500_000);
});

test("non-integer and negative amounts are refused", () => {
  assert.throws(() => ledger.debit("test:a", 10.5, "r1", "x"));
  assert.throws(() => ledger.credit("test:a", -1, "r2", "x"));
});

test("order states only move along the table", () => {
  assert.equal(canMove("quoted", "paid"), true);
  assert.equal(canMove("quoted", "delivered"), false);
  assert.equal(canMove("fulfilling", "refunded"), false, "an unknown outcome must not refund directly");
  assert.equal(canMove("delivered", "refunded"), false);
});
