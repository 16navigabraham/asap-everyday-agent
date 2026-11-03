"use strict";

const logger = require("../log");
const ledger = require("../wallet/ledger");
const sandbox = require("../fulfilment/sandbox");
const store = require("./store");
const { notify } = require("../notify");
const { naira } = require("../money");

/**
 * Quote, confirm, fulfil.
 *
 * A purchase tool only ever calls `quote`: it prices the request and stores an
 * order in `quoted`, nothing is charged. The money moves in `confirm`, which
 * the model can only reach through confirm_purchase, in a later turn, after
 * the user has seen the total. Fulfilment then runs off the request path.
 */

const FEES_KOBO = { airtime: 0, data: 0, electricity: 10_000, tv: 10_000 };

const runs = new Map();

function quote({ ctx, kind, params, principalKobo, summary }) {
  const feeKobo = FEES_KOBO[kind] ?? 0;
  const balance = ledger.balanceKobo(ctx.userId);
  const order = store.create({ userId: ctx.userId, kind, params, summary, principalKobo, feeKobo, turnId: ctx.turnId });

  return {
    ok: true,
    status: "quoted",
    orderId: order.id,
    summary,
    price: naira(principalKobo),
    fee: naira(feeKobo),
    total: naira(order.totalKobo),
    balance: naira(balance),
    canAfford: balance >= order.totalKobo,
    message:
      "Nothing has been charged. Show the user this summary and total, and ask them to confirm. " +
      "Only call confirm_purchase after they say yes in a later message." +
      (balance >= order.totalKobo ? "" : " Their balance does not cover it: say so and suggest adding money first."),
  };
}

function confirm({ orderId, ctx }) {
  const order = store.get(orderId, ctx.userId);
  if (!order) return { ok: false, reason: "not_found", message: "No such order for this user. Nothing was charged." };

  store.expireIfStale(order);

  if (["paid", "fulfilling", "delivered"].includes(order.status)) {
    return { ok: true, alreadyConfirmed: true, status: order.status, message: "This order was already confirmed. Do not charge again." };
  }
  if (order.status !== "quoted") {
    return {
      ok: false,
      reason: `order_${order.status}`,
      message: `This quote is ${order.status}. Nothing was charged. Offer to quote it again.`,
    };
  }

  // Enforced here, not only asked for in a prompt: a quote and its own
  // confirmation can never happen in the same turn, so the user always sees
  // the total before money moves.
  if (order.quotedInTurn && order.quotedInTurn === ctx.turnId) {
    return {
      ok: false,
      reason: "awaiting_user",
      message: "Nothing was charged. The user has not seen this quote yet. Show it and wait for their yes.",
    };
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
      message: "Nothing was charged. Tell them the shortfall.",
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
    message: "Charged and sent for delivery. Delivery is not confirmed yet; the user gets a message when it lands.",
  };
}

function cancel({ orderId, ctx }) {
  const order = store.get(orderId, ctx.userId);
  if (!order) return { ok: false, reason: "not_found" };
  store.expireIfStale(order);
  if (order.status !== "quoted") return { ok: false, reason: `order_${order.status}`, message: "Only an unconfirmed quote can be cancelled." };
  store.move(order, "cancelled");
  return { ok: true, status: "cancelled", message: "Cancelled. Nothing was charged." };
}

async function fulfil(order) {
  store.move(order, "fulfilling");

  let outcome;
  try {
    outcome = await sandbox.vend(order);
  } catch (error) {
    // Unknown outcome. The provider may have delivered, so the money stays
    // held and a person looks at it; refunding here could pay out twice.
    logger.warn("Fulfilment outcome unknown", { orderId: order.id, error: error.message });
    store.move(order, "needs_review");
    await notify(order.userId, `Order #${order.id} (${order.summary}) is taking longer than usual. Your ${naira(order.totalKobo)} is safe; we are checking with the provider and will update you.`);
    return order;
  }

  if (outcome.status === "delivered") {
    store.move(order, "delivered", { result: outcome });
    const token = outcome.token ? ` Token: ${outcome.token}.` : "";
    await notify(order.userId, `Done: ${order.summary}. Ref ${outcome.reference}.${token}`);
    return order;
  }

  store.move(order, "failed");
  const refund = ledger.credit(order.userId, order.totalKobo, `refund:${order.id}`, `Refund: ${order.summary}`);
  store.move(order, "refunded");
  await notify(order.userId, `Order #${order.id} (${order.summary}) did not go through. ${naira(order.totalKobo)} is back in your wallet. Balance: ${naira(refund.balanceKobo)}.`);
  return order;
}

/** Resolves once a confirmed order's fulfilment has finished. For tests and the CLI. */
function settled(orderId) {
  return runs.get(orderId) || Promise.resolve();
}

module.exports = { quote, confirm, cancel, settled, FEES_KOBO };
