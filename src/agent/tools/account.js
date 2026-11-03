"use strict";

const { defineTool } = require("./define");
const ledger = require("../../wallet/ledger");
const inbound = require("../../wallet/inbound");
const profile = require("../../users/profile");
const store = require("../../orders/store");
const sandbox = require("../../fulfilment/sandbox");
const { naira } = require("../../money");

const MAX_TOPUP_NAIRA = 50_000;
const SPENDING = new Set(["paid", "fulfilling", "assigned", "delivered", "needs_review"]);

const checkBalance = defineTool({
  name: "check_balance",
  kind: "read",
  description:
    "The user's current wallet balance. Call it every time the balance matters, including right after a " +
    "purchase or top-up. Never answer a balance question from an earlier message.",
  handler: (_input, ctx) => ({ ok: true, balance: naira(ledger.balanceKobo(ctx.userId)) }),
});

const transactionHistory = defineTool({
  name: "transaction_history",
  kind: "read",
  description:
    "Everything about the user's own money: recent orders with their live status, wallet movements, or a " +
    "spending summary over the last N days. Call it whenever they ask what they spent, whether something " +
    "went through, or for a reference again. Never answer those from memory.",
  properties: {
    view: { type: "string", enum: ["recent", "summary"], description: "recent: latest orders and movements. summary: totals by category." },
    days: { type: "integer", description: "For summary: how many days back. Defaults to 30." },
  },
  required: ["view"],
  validate: ({ days }) => (days !== undefined && (days < 1 || days > 365) ? "days must be between 1 and 365." : null),
  handler: ({ view, days = 30 }, ctx) => {
    const orders = store.forUser(ctx.userId, 50);
    if (view === "summary") {
      const since = Date.now() - days * 86_400_000;
      const totals = {};
      for (const order of orders) {
        if (!SPENDING.has(order.status) || Date.parse(order.createdAt) < since) continue;
        totals[order.kind] = (totals[order.kind] || 0) + order.totalKobo;
      }
      const all = Object.values(totals).reduce((a, b) => a + b, 0);
      return {
        ok: true,
        days,
        totalSpent: naira(all),
        byCategory: Object.fromEntries(Object.entries(totals).map(([kind, kobo]) => [kind, naira(kobo)])),
      };
    }
    return {
      ok: true,
      orders: orders.slice(0, 8).map((order) => ({
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
        "quoted = waiting for their yes, nothing charged; paid/fulfilling = charged, on its way; assigned = driver on " +
        "the way; delivered = done; refunded = did not go through, money returned; needs_review = money held while it " +
        "is checked; expired/cancelled = never charged.",
    };
  },
});

const showAccount = defineTool({
  name: "show_account",
  kind: "read",
  description:
    "Answer exactly one of: 'what's my account number' (to fund the wallet by bank transfer), 'what's my invite " +
    "link', or 'how many people have I referred'. Return only the one that was asked.",
  properties: { what: { type: "string", enum: ["account_number", "invite_link", "referrals"] } },
  required: ["what"],
  handler: ({ what }, ctx) => {
    const p = profile.get(ctx.userId);
    if (what === "account_number") return { ok: true, bank: "Sandbox Bank", accountNumber: p.accountNumber, accountName: `ASAP / ${p.name || "Customer"}` };
    if (what === "invite_link") return { ok: true, inviteLink: `https://example.com/join/${p.inviteCode}` };
    return { ok: true, referrals: p.referrals };
  },
});

const addMoney = defineTool({
  name: "add_money",
  kind: "money",
  description:
    "Fund the wallet. Ask how much first. Returns the user's own account number to transfer to. In this sandbox " +
    "the transfer is simulated and arrives a moment later with a notification; do not say it has arrived until then.",
  properties: { amountNaira: { type: "integer", description: "Naira they want to add, as they said it." } },
  required: ["amountNaira"],
  validate: ({ amountNaira }) => {
    if (amountNaira < 100) return "The smallest top-up is NGN 100.";
    if (amountNaira > MAX_TOPUP_NAIRA) return `The largest single top-up is NGN ${MAX_TOPUP_NAIRA.toLocaleString()}.`;
    return null;
  },
  handler: ({ amountNaira }, ctx) => {
    const p = profile.get(ctx.userId);
    const amountKobo = amountNaira * 100;
    inbound.simulate({
      userId: ctx.userId,
      amountKobo,
      ref: `topup:${ctx.turnId}`,
      memo: "Bank transfer in",
      message: (balance) => `Received ${naira(amountKobo)} by transfer. New balance: ${naira(balance)}.`,
    });
    return {
      ok: true,
      transferTo: { bank: "Sandbox Bank", accountNumber: p.accountNumber },
      amount: naira(amountKobo),
      message: "Give them the account details. The sandbox simulates their transfer; it lands shortly with its own message.",
    };
  },
});

const depositStablecoin = defineTool({
  name: "deposit_stablecoin",
  kind: "money",
  description:
    "Top up with USDC instead of a bank transfer, only when the user asks to pay with crypto or stablecoins. " +
    "Returns a deposit address, the naira rate and the most they can send. If they say how much they are " +
    "sending, pass amountUsdc and the sandbox simulates it arriving.",
  properties: {
    chain: { type: "string", enum: Object.keys(sandbox.CHAINS) },
    amountUsdc: { type: "number", description: "Only if they said how much they are sending." },
  },
  required: ["chain"],
  validate: ({ amountUsdc }) => {
    if (amountUsdc === undefined) return null;
    if (amountUsdc < 1) return "The smallest deposit is 1 USDC.";
    if (amountUsdc > sandbox.MAX_USDC) return `The most that can be credited right now is ${sandbox.MAX_USDC} USDC.`;
    return null;
  },
  handler: ({ chain, amountUsdc }, ctx) => {
    const address = sandbox.depositAddress(ctx.userId, chain);
    const result = {
      ok: true,
      asset: "USDC",
      network: sandbox.CHAINS[chain],
      address,
      rate: `1 USDC = ${naira(sandbox.USDC_RATE_KOBO)}`,
      maxUsdc: sandbox.MAX_USDC,
      warning: "Only send USDC on this exact network. Anything above the maximum is held, not credited.",
    };
    if (amountUsdc !== undefined) {
      const amountKobo = Math.floor(amountUsdc * sandbox.USDC_RATE_KOBO);
      inbound.simulate({
        userId: ctx.userId,
        amountKobo,
        ref: `usdc:${ctx.turnId}`,
        memo: `USDC deposit (${sandbox.CHAINS[chain]})`,
        message: (balance) => `${amountUsdc} USDC arrived on ${sandbox.CHAINS[chain]}: ${naira(amountKobo)} credited. New balance: ${naira(balance)}.`,
      });
      result.expectedCredit = naira(amountKobo);
      result.message = "The sandbox is simulating this deposit; it is credited shortly with its own message.";
    }
    return result;
  },
});

const setName = defineTool({
  name: "set_name",
  kind: "read",
  description:
    "Save what the user wants to be called, in their spelling ('call me Tobi' -> 'Tobi'). Only when they tell you " +
    "a name for themselves. Never for labelling a saved number (that is manage_saved_detail).",
  properties: { name: { type: "string" } },
  required: ["name"],
  validate: ({ name }) => (name.trim().length >= 1 && name.trim().length <= 40 ? null : "A name is 1 to 40 characters."),
  handler: ({ name }, ctx) => {
    profile.get(ctx.userId).name = name.trim();
    return { ok: true, name: name.trim() };
  },
});

const setArea = defineTool({
  name: "set_area",
  kind: "read",
  description:
    "Save roughly where the user is (e.g. Yaba, Lekki), so shopping only shows merchants who deliver there. " +
    "Only when they have said where they are in their own words.",
  properties: { area: { type: "string" } },
  required: ["area"],
  handler: ({ area }, ctx) => {
    profile.get(ctx.userId).area = area.trim();
    return { ok: true, area: area.trim() };
  },
});

const savedDetails = defineTool({
  name: "saved_details",
  kind: "read",
  description:
    "Phone numbers, meters and smartcards the user has bought for before, masked. Call it before asking for a " +
    "number whenever they might mean a repeat ('my usual', 'same as last time', 'my mum's line'). Pass the chosen " +
    "entry's id as savedId to the purchase tool; its network or provider is filled in automatically.",
  properties: { what: { type: "string", enum: ["phone", "meter", "smartcard", "all"] } },
  required: ["what"],
  handler: ({ what }, ctx) => ({ ok: true, saved: profile.listSaved(ctx.userId, what === "all" ? null : what) }),
});

const manageSavedDetail = defineTool({
  name: "manage_saved_detail",
  kind: "read",
  description:
    "Name a saved entry ('save it as Mum') or forget one. Get the id from saved_details first. Only 'forget' on an " +
    "explicit request to remove it.",
  properties: {
    action: { type: "string", enum: ["label", "forget"] },
    savedId: { type: "integer" },
    label: { type: "string", description: "For action=label." },
  },
  required: ["action", "savedId"],
  validate: ({ action, label }) => (action === "label" && !label?.trim() ? "A label is needed to name it." : null),
  handler: ({ action, savedId, label }, ctx) => {
    const done = action === "label" ? profile.labelSaved(ctx.userId, savedId, label.trim()) : profile.forgetSaved(ctx.userId, savedId);
    return done ? { ok: true, action } : { ok: false, reason: "unknown_saved_id", message: "No saved entry with that id." };
  },
});

const askUser = defineTool({
  name: "ask_user",
  kind: "read",
  description:
    "Ask one question when something needed is missing or unclear: which network, which number, how much, which " +
    "plan, which meter, where to. Use it instead of guessing. The question is sent as your reply.",
  properties: { question: { type: "string", description: "One short question, in the user's own register." } },
  required: ["question"],
  validate: ({ question }) => (question.trim() ? null : "The question is empty."),
  handler: () => ({ ok: true, asked: true }),
});

module.exports = [
  checkBalance, transactionHistory, showAccount, addMoney, depositStablecoin,
  setName, setArea, savedDetails, manageSavedDetail, askUser,
];
