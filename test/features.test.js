"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { resetAll, useTool, scriptedModel, toolUse, text } = require("./helpers");
const { handleMessage } = require("../src/conversations");
const ledger = require("../src/wallet/ledger");
const inbound = require("../src/wallet/inbound");
const store = require("../src/orders/store");
const checkout = require("../src/orders/checkout");
const notify = require("../src/notify");

const USER = "test:features";
const sent = [];
notify.register("test", (_userId, message) => sent.push(message));

beforeEach(() => {
  resetAll();
  sent.length = 0;
});

async function confirmAndSettle(orderId, tool = "confirm_purchase", key = "orderId") {
  const result = await useTool(USER, tool, { [key]: orderId });
  await checkout.settled(orderId);
  return result;
}

const STARTER = 500_000;

test("a number bought for once is saved, masked, and reusable with its network", async () => {
  const q = await useTool(USER, "buy_airtime", { network: "glo", phone: "08051234567", amountNaira: 200 });
  await confirmAndSettle(q.orderId);

  const { saved } = await useTool(USER, "saved_details", { what: "phone" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].provider, "glo");
  assert.doesNotMatch(saved[0].value, /0805123/, "the full number is never shown to the model");

  const again = await useTool(USER, "buy_airtime", { savedId: saved[0].id, amountNaira: 300 });
  assert.equal(again.ok, true);
  assert.match(again.summary, /Glo airtime to number ending 4567/);

  await useTool(USER, "manage_saved_detail", { action: "label", savedId: saved[0].id, label: "Mum" });
  assert.equal((await useTool(USER, "saved_details", { what: "all" })).saved[0].label, "Mum");
});

test("a typed number without a network is refused rather than guessed", async () => {
  const r = await useTool(USER, "buy_airtime", { phone: "08031234567", amountNaira: 500 });
  assert.equal(r.reason, "invalid_arguments");
});

test("shopping: search by area, one-merchant basket, one delivery fee, then delivery", async () => {
  await useTool(USER, "set_area", { area: "Yaba" });
  const found = await useTool(USER, "find_listings", { query: "jollof rice" });
  assert.equal(found.results[0].name, "Jollof rice and chicken");

  await useTool(USER, "add_to_order", { listingId: 101, quantity: 2, note: "extra pepper" });
  await useTool(USER, "add_to_order", { listingId: 104 });

  const otherMerchant = await useTool(USER, "add_to_order", { listingId: 201 });
  assert.equal(otherMerchant.reason, "different_merchant");

  const q = await useTool(USER, "place_order", { address: "5 Herbert Macaulay Way, Yaba", phone: "08031234567" });
  assert.equal(q.total, "₦10,300", "2x3,500 + 2,500 + 800 delivery");
  assert.equal(q.canAfford, false);

  ledger.credit(USER, 1_000_000, "test-topup", "test");
  await confirmAndSettle(q.orderId);

  assert.equal(store.get(q.orderId).status, "delivered");
  assert.equal(ledger.balanceKobo(USER), STARTER + 1_000_000 - 1_030_000);
  assert.match(sent.at(-1), /Mama Put Express accepted order/);
});

test("merchants that don't deliver to the user's area are not offered", async () => {
  await useTool(USER, "set_area", { area: "Lekki" });
  const found = await useTool(USER, "find_listings", { query: "jollof" });
  assert.equal(found.results.length, 0);
});

test("listing photos are attached for the channel to show", async () => {
  const { attachments } = await handleMessage(USER, "show me", {
    call: scriptedModel([() => [toolUse("send_listing_photo", { listingId: 201 })], () => [text("Here it is.")]]),
  });
  assert.deepEqual(attachments, [{ type: "image", url: "/media/listing/201.svg", caption: "Red velvet cake, 8 inch" }]);
});

test("rides: only the booking fee is charged, a driver is assigned, and cancelling refunds it", async () => {
  const q = await useTool(USER, "request_ride", { from: "Yaba", to: "Lekki Phase 1" });
  assert.equal(q.total, "₦200");
  assert.match(q.fareEstimate, /paid to the driver/);

  await confirmAndSettle(q.orderId);
  const ride = store.get(q.orderId);
  assert.equal(ride.status, "assigned");
  assert.match(sent.at(-1), /Driver found/);
  assert.equal(ledger.balanceKobo(USER), STARTER - 20_000);

  const cancelled = await useTool(USER, "cancel_ride", { orderId: q.orderId });
  assert.equal(cancelled.ok, true);
  assert.equal(ledger.balanceKobo(USER), STARTER);
});

test("a completed ride cannot be cancelled", async () => {
  const q = await useTool(USER, "request_ride", { from: "Ikeja", to: "Surulere" });
  await confirmAndSettle(q.orderId);
  checkout.completeRide(store.get(q.orderId));

  const r = await useTool(USER, "cancel_ride", { orderId: q.orderId });
  assert.equal(r.reason, "already_completed");
  assert.equal(ledger.balanceKobo(USER), STARTER - 20_000);
});

test("paying a driver only works to the assigned driver's own account", async () => {
  const q = await useTool(USER, "request_ride", { from: "Yaba", to: "Ikoyi" });
  await confirmAndSettle(q.orderId);
  const driver = store.get(q.orderId).result.driver;

  const wrong = await useTool(USER, "pay_driver", { orderId: q.orderId, accountNumber: "3011111111", amountNaira: 4000 });
  assert.equal(wrong.reason, "name_mismatch");

  const right = await useTool(USER, "pay_driver", { orderId: q.orderId, accountNumber: driver.accountNumber, amountNaira: 4000 });
  assert.equal(right.total, "₦4,050");
  await confirmAndSettle(right.orderId);
  assert.match(sent.at(-1), new RegExp(`Sent ₦4,000 to ${driver.name}`));
});

test("flights: search, numbered options, choose, confirm, booking reference", async () => {
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  const missing = await useTool(USER, "request_service", { kind: "flight", from: "Lagos" });
  assert.equal(missing.reason, "missing_details");
  assert.equal((await useTool(USER, "request_service", { kind: "hotel" })).reason, "unavailable");

  const search = await useTool(USER, "request_service", { kind: "flight", from: "Lagos", to: "Abuja", date: future, passengers: 2 });
  assert.equal(search.options.length, 3);
  assert.equal(search.options[0].route, "LOS → ABV");

  const q = await useTool(USER, "choose_option", { position: 2 });
  assert.match(q.summary, /2 passengers/);
  assert.equal(q.fee, "₦2,000");

  ledger.credit(USER, 100_000_000, "test-topup", "test");
  await confirmAndSettle(q.orderId);
  assert.equal(store.get(q.orderId).status, "delivered");
  assert.match(sent.at(-1), /Booking reference [0-9A-F]{6}/);
});

test("sharing credit: only to ASAP users, only via confirm_share, and the recipient is credited", async () => {
  assert.equal((await useTool(USER, "share_credits", { recipientPhone: "08055555555", amountNaira: 1000 })).reason, "not_on_asap");

  const q = await useTool(USER, "share_credits", { recipientPhone: "08012345678", amountNaira: 1000 });
  assert.equal(q.ok, true);

  const viaPurchase = await useTool(USER, "confirm_purchase", { orderId: q.orderId });
  assert.equal(viaPurchase.reason, "not_found", "confirm_purchase cannot send a share");

  await confirmAndSettle(q.orderId, "confirm_share", "shareId");
  assert.equal(ledger.balanceKobo(USER), STARTER - 100_000);
  assert.equal(ledger.balanceKobo("phone:08012345678"), STARTER + 100_000);
});

test("confirm_share cannot charge an ordinary purchase", async () => {
  const q = await useTool(USER, "buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 500 });
  const r = await useTool(USER, "confirm_share", { shareId: q.orderId });
  assert.equal(r.reason, "not_found");
  assert.equal(ledger.balanceKobo(USER), STARTER);
});

test("add_money returns the account number and the simulated transfer lands later", async () => {
  const r = await useTool(USER, "add_money", { amountNaira: 2000 });
  assert.match(r.transferTo.accountNumber, /^\d{10}$/);
  assert.equal(ledger.balanceKobo(USER), STARTER, "not credited until the transfer arrives");
  await inbound.settled();
  assert.equal(ledger.balanceKobo(USER), STARTER + 200_000);
  assert.match(sent.at(-1), /Received ₦2,000/);
});

test("a USDC deposit gives an address on the chosen network and credits at the sandbox rate", async () => {
  const info = await useTool(USER, "deposit_stablecoin", { chain: "base" });
  assert.match(info.address, /^0x[0-9a-f]{40}$/);
  assert.equal(ledger.balanceKobo(USER), STARTER);

  const over = await useTool(USER, "deposit_stablecoin", { chain: "base", amountUsdc: 501 });
  assert.equal(over.reason, "invalid_arguments");

  await useTool(USER, "deposit_stablecoin", { chain: "solana", amountUsdc: 10 });
  await inbound.settled();
  assert.equal(ledger.balanceKobo(USER), STARTER + 1_550_000);
});

test("spending summary counts what was actually spent, not refunds or open quotes", async () => {
  const delivered = await useTool(USER, "buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 500 });
  await confirmAndSettle(delivered.orderId);
  const declined = await useTool(USER, "buy_airtime", { network: "mtn", phone: "08031239999", amountNaira: 700 });
  await confirmAndSettle(declined.orderId);
  await useTool(USER, "buy_airtime", { network: "mtn", phone: "08031234567", amountNaira: 900 });

  const summary = await useTool(USER, "transaction_history", { view: "summary" });
  assert.equal(summary.totalSpent, "₦500");
});

test("profile and account questions", async () => {
  await useTool(USER, "set_name", { name: "Tobi" });
  const acct = await useTool(USER, "show_account", { what: "account_number" });
  assert.equal(acct.accountName, "ASAP / Tobi");
  const invite = await useTool(USER, "show_account", { what: "invite_link" });
  assert.ok(invite.inviteLink);
  assert.equal(invite.accountNumber, undefined, "only the thing asked for comes back");
});

test("a photo is sent to Muse in its turn but kept out of later history", async () => {
  const photo = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } }, { type: "text", text: "pay this meter" }];
  const first = scriptedModel([() => [text("I can see meter 45031234567. Is that right?")]]);
  await handleMessage(USER, photo, { call: first });
  assert.equal(first.seen[0].at(-1).content[0].type, "image");

  const second = scriptedModel([() => [text("ok")]]);
  await handleMessage(USER, "yes", { call: second });
  assert.doesNotMatch(JSON.stringify(second.seen[0]), /"type":"image"/);
});

test("product search understands Yoruba, Hausa and Igbo item names, with or without tone marks", async () => {
  for (const query of ["ìrẹsì", "iresi", "shinkafa", "osikapa"]) {
    const found = await useTool(USER, "find_listings", { query });
    assert.ok(found.results.some((r) => /rice/i.test(r.name)), `${query} should find rice`);
  }
  const eggs = await useTool(USER, "find_listings", { query: "kwai" });
  assert.equal(eggs.results[0].name, "Eggs, crate of 30");
});

test("the agent is told to reply in the user's own language and keep money in digits", () => {
  const { SYSTEM_PROMPT } = require("../src/agent/prompt");
  for (const language of ["Yoruba", "Hausa", "Igbo", "Pidgin"]) assert.match(SYSTEM_PROMPT, new RegExp(language));
  assert.match(SYSTEM_PROMPT, /Reply in the language the user is using/);
  assert.match(SYSTEM_PROMPT, /in digits/);
});
