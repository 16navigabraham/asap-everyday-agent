"use strict";

const { defineTool } = require("./define");
const ledger = require("../../wallet/ledger");
const store = require("../../orders/store");
const { naira } = require("../../money");

const MAX_TOPUP_NAIRA = 20_000;

const checkBalance = defineTool({
  name: "check_balance",
  kind: "read",
  description:
    "The user's current wallet balance. Call it every time the balance matters, including right " +
    "after a purchase. Never answer a balance question from an earlier message.",
  handler: (_input, ctx) => ({ ok: true, balance: naira(ledger.balanceKobo(ctx.userId)) }),
});

const recentActivity = defineTool({
  name: "recent_activity",
  kind: "read",
  description:
    "The user's recent orders with their live status, plus recent wallet movements. Use it when " +
    "they ask whether something went through, what they bought, or where their money went.",
  handler: (_input, ctx) => ({
    ok: true,
    orders: store.forUser(ctx.userId, 8).map((order) => ({
      orderId: order.id,
      summary: order.summary,
      total: naira(order.totalKobo),
      status: order.status,
      reference: order.result?.reference || null,
      token: order.result?.token || null,
    })),
    wallet: ledger.entries(ctx.userId, 8).map((entry) => ({
      memo: entry.memo,
      amount: `${entry.amountKobo < 0 ? "-" : "+"}${naira(Math.abs(entry.amountKobo))}`,
      at: entry.at,
    })),
    statusGuide:
      "quoted = waiting for their yes, nothing charged; paid/fulfilling = charged, on its way; " +
      "delivered = done; refunded = failed and money returned; needs_review = money held while it is checked; " +
      "expired/cancelled = never charged.",
  }),
});

const addMoney = defineTool({
  name: "add_money",
  kind: "money",
  description:
    `Add sandbox credit to the user's wallet, up to NGN ${MAX_TOPUP_NAIRA.toLocaleString()} at a time. ` +
    "This is a demo wallet with no real money. Only when the user asks to add or fund money.",
  properties: {
    amountNaira: { type: "integer", description: "Naira to add, as the user said it." },
  },
  required: ["amountNaira"],
  validate: ({ amountNaira }) => {
    if (amountNaira < 100) return "The smallest top-up is NGN 100.";
    if (amountNaira > MAX_TOPUP_NAIRA) return `The largest sandbox top-up is NGN ${MAX_TOPUP_NAIRA.toLocaleString()}.`;
    return null;
  },
  handler: ({ amountNaira }, ctx) => {
    const { balanceKobo } = ledger.credit(ctx.userId, amountNaira * 100, `topup:${ctx.turnId}`, "Sandbox top-up");
    return { ok: true, added: naira(amountNaira * 100), balance: naira(balanceKobo) };
  },
});

const askUser = defineTool({
  name: "ask_user",
  kind: "read",
  description:
    "Ask the user one question when something needed is missing or unclear: which network, which " +
    "number, how much, which plan, which meter. Use it instead of guessing. The question is sent as your reply.",
  properties: {
    question: { type: "string", description: "One short question, in the user's own register." },
  },
  required: ["question"],
  validate: ({ question }) => (question.trim() ? null : "The question is empty."),
  handler: () => ({ ok: true, asked: true }),
});

module.exports = [checkBalance, recentActivity, addMoney, askUser];
