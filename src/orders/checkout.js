"use strict";

const config = require("../config");
const logger = require("../log");
const ledger = require("../wallet/ledger");
const sandbox = require("../fulfilment/sandbox");
const profile = require("../users/profile");
const store = require("./store");
const { notify } = require("../notify");
const { naira } = require("../money");

/**
 * Quote, confirm, fulfil, for every kind of order.
 *
 * Tools that lead to money only ever call `quote`: it prices the request and
 * stores an order in `quoted`, and nothing is charged. Money moves in
 * `confirm`, which the model reaches through confirm_purchase or
 * confirm_share in a later turn, after the user has seen the total.
 * Fulfilment then runs off the request path and reports back by notification.
 */

const FEES_KOBO = {
  airtime: 0,
  data: 0,
  electricity: 10_000,
  tv: 10_000,
  merchant_order: 0,
  ride: 0,
  driver_payment: 5_000,
  flight: 200_000,
  share: 0,
};

const runs = new Map();

function quote({ ctx, kind, params, principalKobo, feeKobo, summary, extra = {} }) {
  const fee = feeKobo ?? FEES_KOBO[kind] ?? 0;
  const balance = ledger.balanceKobo(ctx.userId);
  const order = store.create({ userId: ctx.userId, kind, params, summary, principalKobo, feeKobo: fee, turnId: ctx.turnId });
  const canAfford = balance >= order.totalKobo;
  const confirmWith = kind === "share" ? "confirm_share" : "confirm_purchase";

  return {
    ok: true,
    status: "quoted",
    orderId: order.id,
    summary,
    price: naira(principalKobo),
    fee: naira(fee),
    total: naira(order.totalKobo),
    balance: naira(balance),
    canAfford,
    ...extra,
    message:
      `Nothing has been charged. Show the user this summary and the total, and ask them to confirm. ` +
      `Only call ${confirmWith} after they say yes in a later message.` +
      (canAfford ? "" : " Their balance does not cover it: say how much is missing and suggest add_money."),
  };
}

function confirm({ orderId, ctx, kinds = null, exceptKinds = [] }) {
  const order = store.get(orderId, ctx.userId);
  if (!order || (kinds && !kinds.includes(order.kind)) || exceptKinds.includes(order.kind)) {
    return { ok: false, reason: "not_found", message: "No such order for this user and tool. Nothing was charged." };
  }

  store.expireIfStale(order);

  if (["paid", "fulfilling", "assigned", "delivered"].includes(order.status)) {
    return { ok: true, alreadyConfirmed: true, status: order.status, message: "Already confirmed. Do not charge again." };
  }
  if (order.status !== "quoted") {
    return { ok: false, reason: `order_${order.status}`, message: `This quote is ${order.status}. Nothing was charged. Offer to quote it again.` };
  }

  // Enforced here, not only asked for in a prompt: a quote and its own
  // confirmation can never happen in the same turn, so the user always sees
  // the total before money moves.
  if (order.quotedInTurn && order.quotedInTurn === ctx.turnId) {
    return { ok: false, reason: "awaiting_user", message: "Nothing was charged. The user has not seen this quote yet. Show it and wait for their yes." };
  }

  let debit;
  try {
    debit = ledger.debit(ctx.userId, order.totalKobo, `order:${order.id}`, order.summary);
  } catch (error) {
    if (!(error instanceof ledger.InsufficientFunds)) throw error;
    return {
      ok: false,
      reason: "insufficient_funds",
      balance: naira(error.balanceKobo),
      shortfall: naira(error.shortfallKobo),
      message: "Nothing was charged. Tell them how much is missing and offer add_money.",
    };
  }

  store.move(order, "paid");
  runs.set(order.id, new Promise((resolve) => setImmediate(() => fulfil(order).finally(resolve))));

  return {
    ok: true,
    status: "paid",
    orderId: order.id,
    charged: naira(order.totalKobo),
    balance: naira(debit.balanceKobo),
    message: "Charged and sent off. It is not delivered yet: the user gets a message here when it lands. Do not claim it is done.",
  };
}

function cancel({ orderId, ctx }) {
  const order = store.get(orderId, ctx.userId);
  if (!order) return { ok: false, reason: "not_found" };
  store.expireIfStale(order);
  if (order.status !== "quoted") return { ok: false, reason: `order_${order.status}`, message: "Only an unconfirmed quote can be cancelled this way." };
  store.move(order, "cancelled");
  return { ok: true, status: "cancelled", message: "Cancelled. Nothing was charged." };
}

/** Cancel a ride: free before confirmation, booking fee refunded once a driver is assigned, refused after pickup. */
function cancelRide({ orderId, ctx }) {
  const order = store.get(orderId, ctx.userId);
  if (!order || order.kind !== "ride") return { ok: false, reason: "not_found", message: "No such ride for this user." };
  store.expireIfStale(order);

  switch (order.status) {
    case "quoted":
      return cancel({ orderId, ctx });
    case "assigned": {
      const refund = ledger.credit(order.userId, order.totalKobo, `refund:${order.id}`, `Refund: ${order.summary}`);
      store.move(order, "refunded", { cancelledByUser: true });
      return { ok: true, status: "cancelled", refunded: naira(order.totalKobo), balance: naira(refund.balanceKobo) };
    }
    case "paid":
    case "fulfilling":
      return { ok: false, reason: "still_matching", message: "A driver is still being matched. Nothing to cancel yet: ask them to try again in a moment." };
    case "delivered":
      return { ok: false, reason: "already_completed", message: "This ride has already happened, so it cannot be cancelled." };
    default:
      return { ok: false, reason: `order_${order.status}`, message: `This ride is ${order.status}; there is nothing to cancel.` };
  }
}

// What a successful purchase is remembered as, so "same number as last time" works.
function rememberTarget(order) {
  const p = order.params;
  const entry =
    order.kind === "airtime" || order.kind === "data"
      ? { kind: "phone", value: p.phone, provider: p.network }
      : order.kind === "electricity"
        ? { kind: "meter", value: p.meter, provider: p.disco }
        : order.kind === "tv"
          ? { kind: "smartcard", value: p.smartcard, provider: p.provider }
          : null;
  if (entry) profile.remember(order.userId, entry);
}

function deliveredMessage(order, outcome) {
  switch (order.kind) {
    case "merchant_order":
      return `${order.params.merchantName} accepted order #${order.id}. A rider is on the way, about ${outcome.etaMinutes} minutes. Ref ${outcome.reference}.`;
    case "flight":
      return `Booked: ${order.summary}. Booking reference ${outcome.reference}. Have a safe flight.`;
    case "driver_payment":
      return `Sent ${naira(order.principalKobo)} to ${order.params.accountName}. Ref ${outcome.reference}.`;
    case "share":
      return `Sent ${naira(order.principalKobo)} of credit to ${order.params.recipientName}.`;
    default:
      return `Done: ${order.summary}. Ref ${outcome.reference}.${outcome.token ? ` Token: ${outcome.token}.` : ""}`;
  }
}

async function fulfil(order) {
  store.move(order, "fulfilling");

  if (order.kind === "share") {
    // Internal transfer: the recipient is credited in the same ledger.
    ledger.credit(order.params.recipientUserId, order.principalKobo, `share:${order.id}`, `Credit from a friend`);
    store.move(order, "delivered", { result: { reference: `SHARE-${order.id}` } });
    await notify(order.userId, deliveredMessage(order, order.result));
    return order;
  }

  let outcome;
  try {
    outcome = await sandbox.vend(order);
  } catch (error) {
    // Unknown outcome. The provider may have delivered, so the money stays
    // held and a person looks at it; refunding here could pay out twice.
    logger.warn("Fulfilment outcome unknown", { orderId: order.id, kind: order.kind, error: error.message });
    store.move(order, "needs_review");
    await notify(order.userId, `Order #${order.id} (${order.summary}) is taking longer than usual. Your ${naira(order.totalKobo)} is safe; it is being checked and you'll get an update here.`);
    return order;
  }

  if (outcome.status === "assigned") {
    const d = outcome.driver;
    store.move(order, "assigned", { result: outcome });
    const timer = setTimeout(() => completeRide(order), config.sandbox.rideMs);
    timer.unref?.();
    await notify(
      order.userId,
      `Driver found: ${d.name}, ${d.car} (${d.plate}), about ${order.params.etaMinutes} minutes away. ` +
        `Pay the fare to the driver at the end of the trip, in cash or by transfer (${d.bankName} ${d.accountNumber}, ${d.name}). Ref ${outcome.reference}.`,
    );
    return order;
  }

  if (outcome.status === "delivered") {
    store.move(order, "delivered", { result: outcome });
    rememberTarget(order);
    await notify(order.userId, deliveredMessage(order, outcome));
    return order;
  }

  store.move(order, "failed");
  const refund = ledger.credit(order.userId, order.totalKobo, `refund:${order.id}`, `Refund: ${order.summary}`);
  store.move(order, "refunded");
  await notify(order.userId, `Order #${order.id} (${order.summary}) did not go through. ${naira(order.totalKobo)} is back in your wallet. Balance: ${naira(refund.balanceKobo)}.`);
  return order;
}

function completeRide(order) {
  if (order.status !== "assigned") return;
  store.move(order, "delivered");
  notify(order.userId, `Your ride (${order.summary}) is complete. Thanks for riding with ASAP.`);
}

/** Resolves once a confirmed order's fulfilment step has finished. For tests and the CLI. */
function settled(orderId) {
  return runs.get(orderId) || Promise.resolve();
}

module.exports = { quote, confirm, cancel, cancelRide, settled, completeRide, FEES_KOBO };
