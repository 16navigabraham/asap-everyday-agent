"use strict";

const { defineTool } = require("./define");
const { normalisePhone } = require("./phone");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const { naira } = require("../../money");

const confirmPurchase = defineTool({
  name: "confirm_purchase",
  kind: "money",
  description:
    "Charge the user for a quoted order they have ALREADY agreed to, in their own words, after seeing the total. " +
    "Never in the same turn as the quote. If you are not sure they said yes to this exact quote, ask.",
  properties: { orderId: { type: "integer", description: "The orderId from the quote." } },
  required: ["orderId"],
  handler: ({ orderId }, ctx) => checkout.confirm({ orderId, ctx, exceptKinds: ["share"] }),
});

const cancelOrder = defineTool({
  name: "cancel_order",
  kind: "read",
  description: "Drop a quote the user no longer wants. Only unconfirmed quotes; for a booked ride use cancel_ride.",
  properties: { orderId: { type: "integer" } },
  required: ["orderId"],
  handler: ({ orderId }, ctx) => checkout.cancel({ orderId, ctx }),
});

const shareCredits = defineTool({
  name: "share_credits",
  kind: "money",
  description:
    "Quote sending some of the user's credit to another ASAP user, by their phone number. Checks the recipient " +
    "uses ASAP; never assume. Charges nothing; confirm_share sends it after they agree.",
  properties: {
    recipientPhone: { type: "string" },
    amountNaira: { type: "integer" },
  },
  required: ["recipientPhone", "amountNaira"],
  validate: ({ recipientPhone, amountNaira }) => {
    if (!normalisePhone(recipientPhone)) return "That is not a Nigerian mobile number.";
    if (amountNaira < 100 || amountNaira > 50_000) return "Shares are NGN 100 to NGN 50,000.";
    return null;
  },
  handler: ({ recipientPhone, amountNaira }, ctx) => {
    const phone = normalisePhone(recipientPhone);
    const recipient = sandbox.findAsapUser(phone);
    if (!recipient) {
      return { ok: false, reason: "not_on_asap", message: "That number is not on ASAP yet. Nothing was quoted. Suggest they invite them." };
    }
    if (recipient.userId === ctx.userId) return { ok: false, reason: "self", message: "They cannot share credit with themselves." };
    return checkout.quote({
      ctx,
      kind: "share",
      params: { recipientUserId: recipient.userId, recipientName: recipient.displayName, phone },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} credit to ${recipient.displayName} (number ending ${phone.slice(-4)})`,
    });
  },
});

const confirmShare = defineTool({
  name: "confirm_share",
  kind: "money",
  description:
    "Send credit for a share the user has ALREADY agreed to after seeing the amount and recipient. Never in the " +
    "same turn as share_credits.",
  properties: { shareId: { type: "integer", description: "The orderId from share_credits." } },
  required: ["shareId"],
  handler: ({ shareId }, ctx) => checkout.confirm({ orderId: shareId, ctx, kinds: ["share"] }),
});

module.exports = [confirmPurchase, cancelOrder, shareCredits, confirmShare];
