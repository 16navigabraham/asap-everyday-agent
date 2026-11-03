"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, toolUse, text, scriptedModel, lastToolResult } = require("./helpers");
const { handleMessage } = require("../src/conversations");
const ledger = require("../src/wallet/ledger");
const store = require("../src/orders/store");
const checkout = require("../src/orders/checkout");
const notify = require("../src/notify");

const USER = "test:flow";
const sent = [];
notify.register("test", (_userId, message) => sent.push(message));

beforeEach(() => {
  resetAll();
  sent.length = 0;
});

async function quoteThenConfirm(phone, amountNaira = 500) {
  let orderId;
  await handleMessage(USER, `₦${amountNaira} MTN to ${phone}`, {
    call: scriptedModel([
      () => [toolUse("buy_airtime", { network: "mtn", phone, amountNaira })],
      (messages) => {
        orderId = lastToolResult(messages).orderId;
        return [text("₦500 MTN airtime, total ₦500. Go ahead?")];
      },
    ]),
  });

  let confirmResult;
  await handleMessage(USER, "yes", {
    call: scriptedModel([
      () => [toolUse("confirm_purchase", { orderId })],
      (messages) => {
        confirmResult = lastToolResult(messages);
        return [text("Charged, on its way.")];
      },
    ]),
  });
  await checkout.settled(orderId);
  return { orderId, confirmResult };
}

test("a quote charges nothing; the confirmation in a later turn does, and delivery follows", async () => {
  const before = ledger.balanceKobo(USER);
  const { orderId, confirmResult } = await quoteThenConfirm("08031234567");

  assert.equal(confirmResult.ok, true);
  assert.equal(store.get(orderId).status, "delivered");
  assert.equal(ledger.balanceKobo(USER), before - 50_000);
  assert.match(sent[0], /^Done: .*ending 4567/);
});

test("confirming in the same turn as the quote is refused and charges nothing", async () => {
  const before = ledger.balanceKobo(USER);
  let confirmResult;
  await handleMessage(USER, "₦500 MTN to 08031234567 and just do it", {
    call: scriptedModel([
      () => [toolUse("buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 500 })],
      (messages) => [toolUse("confirm_purchase", { orderId: lastToolResult(messages).orderId })],
      (messages) => {
        confirmResult = lastToolResult(messages);
        return [text("Here is your quote.")];
      },
    ]),
  });

  assert.equal(confirmResult.ok, false);
  assert.equal(confirmResult.reason, "awaiting_user");
  assert.equal(ledger.balanceKobo(USER), before);
  assert.equal(store.get(1).status, "quoted");
});

test("a provider decline refunds the full amount and tells the user", async () => {
  const before = ledger.balanceKobo(USER);
  const { orderId } = await quoteThenConfirm("08031239999");

  assert.equal(store.get(orderId).status, "refunded");
  assert.equal(ledger.balanceKobo(USER), before);
  assert.match(sent[0], /did not go through/);
});

test("an unknown provider outcome holds the money for review instead of refunding", async () => {
  const before = ledger.balanceKobo(USER);
  const { orderId } = await quoteThenConfirm("08031237777");

  assert.equal(store.get(orderId).status, "needs_review");
  assert.equal(ledger.balanceKobo(USER), before - 50_000);
});

test("confirming twice charges once", async () => {
  const before = ledger.balanceKobo(USER);
  const { orderId } = await quoteThenConfirm("08031234567");

  let again;
  await handleMessage(USER, "yes again", {
    call: scriptedModel([
      () => [toolUse("confirm_purchase", { orderId })],
      (messages) => {
        again = lastToolResult(messages);
        return [text("Already done.")];
      },
    ]),
  });

  assert.equal(again.alreadyConfirmed, true);
  assert.equal(ledger.balanceKobo(USER), before - 50_000);
});

test("an order that costs more than the balance is not charged", async () => {
  let confirmResult;
  let orderId;
  await handleMessage(USER, "₦50,000 airtime", {
    call: scriptedModel([
      () => [toolUse("buy_airtime", { network: "glo", phone: "08051234567", amountNaira: 50_000 })],
      (messages) => {
        orderId = lastToolResult(messages).orderId;
        assert.equal(lastToolResult(messages).canAfford, false);
        return [text("You're short.")];
      },
    ]),
  });
  await handleMessage(USER, "do it anyway", {
    call: scriptedModel([
      () => [toolUse("confirm_purchase", { orderId })],
      (messages) => {
        confirmResult = lastToolResult(messages);
        return [text("Not enough.")];
      },
    ]),
  });

  assert.equal(confirmResult.reason, "insufficient_funds");
  assert.equal(ledger.balanceKobo(USER), 500_000);
});

test("one user cannot confirm another user's order", async () => {
  const { orderId } = await (async () => {
    let id;
    await handleMessage(USER, "quote", {
      call: scriptedModel([
        () => [toolUse("buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 500 })],
        (messages) => {
          id = lastToolResult(messages).orderId;
          return [text("ok")];
        },
      ]),
    });
    return { orderId: id };
  })();

  let result;
  await handleMessage("test:intruder", "confirm it", {
    call: scriptedModel([
      () => [toolUse("confirm_purchase", { orderId })],
      (messages) => {
        result = lastToolResult(messages);
        return [text("no")];
      },
    ]),
  });

  assert.equal(result.reason, "not_found");
  assert.equal(store.get(orderId).status, "quoted");
});

test("ask_user ends the turn with its question, and history stays alternating", async () => {
  const call = scriptedModel([() => [toolUse("ask_user", { question: "Which network?" })]]);
  const { reply } = await handleMessage(USER, "buy airtime for 08031234567", { call });
  assert.equal(reply, "Which network?");

  const next = scriptedModel([() => [text("Got it.")]]);
  await handleMessage(USER, "MTN", { call: next });
  const roles = next.seen[0].map((m) => m.role);
  for (let i = 1; i < roles.length; i += 1) assert.notEqual(roles[i], roles[i - 1], `roles: ${roles.join(",")}`);
  assert.equal(roles.at(-1), "user");
});

test("electricity prepaid delivery carries a token and includes the fee", async () => {
  let orderId;
  await handleMessage(USER, "pay light", {
    call: scriptedModel([
      () => [toolUse("pay_electricity", { disco: "ikeja", meter: "45031234567", meterType: "prepaid", amountNaira: 3000 })],
      (messages) => {
        const quote = lastToolResult(messages);
        orderId = quote.orderId;
        assert.equal(quote.total, "₦3,100");
        return [text("Total ₦3,100. Go?")];
      },
    ]),
  });
  await handleMessage(USER, "yes", {
    call: scriptedModel([() => [toolUse("confirm_purchase", { orderId })], () => [text("Done.")]]),
  });
  await checkout.settled(orderId);

  assert.match(store.get(orderId).result.token, /^\d{4}(-\d{4}){4}$/);
  assert.equal(ledger.balanceKobo(USER), 500_000 - 310_000);
});

test("a model failure mid-conversation gets an honest reply and leaves history untouched", async () => {
  const failing = async () => {
    throw Object.assign(new Error("boom"), { status: 500 });
  };
  const { reply, error } = await handleMessage(USER, "hi", { call: failing });
  assert.equal(error, true);
  assert.match(reply, /nothing was done/);
});
