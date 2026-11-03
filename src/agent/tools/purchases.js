"use strict";

const { defineTool } = require("./define");
const { normalisePhone } = require("./phone");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const store = require("../../orders/store");
const { naira } = require("../../money");

/**
 * Every purchase tool here only quotes. None of them charges anything: they
 * price the request, store an order in `quoted`, and hand the model a summary
 * to show. Money moves only through confirm_purchase.
 */

const NETWORK_IDS = Object.keys(sandbox.NETWORKS);
const QUOTE_ONLY = "This only prepares a quote; nothing is charged until confirm_purchase.";

const lastFour = (value) => String(value).slice(-4);

const listPlans = defineTool({
  name: "list_plans",
  kind: "read",
  description:
    "Available plans and their prices, for data bundles (provider = network) or TV (provider = dstv, gotv, startimes). " +
    "Always call this before quoting data or TV, and use only plan ids and prices it returns.",
  properties: {
    service: { type: "string", enum: ["data", "tv"] },
    provider: { type: "string", enum: [...NETWORK_IDS, ...Object.keys(sandbox.TV)] },
  },
  required: ["service", "provider"],
  handler: ({ service, provider }) => {
    const plans = sandbox.listPlans(service, provider);
    if (!plans) return { ok: false, reason: "no_such_provider", message: `${provider} has no ${service} plans.` };
    return { ok: true, plans: plans.map((plan) => ({ planId: plan.planId, label: plan.label, price: naira(plan.priceKobo) })) };
  },
});

const lookupCustomer = defineTool({
  name: "lookup_customer",
  kind: "read",
  description:
    "Look up the registered name on an electricity meter or TV smartcard. Required before every bill payment: " +
    "show the name to the user and get them to confirm it is the right account before quoting.",
  properties: {
    service: { type: "string", enum: ["electricity", "tv"] },
    provider: { type: "string", enum: [...Object.keys(sandbox.DISCOS), ...Object.keys(sandbox.TV)] },
    number: { type: "string", description: "Meter or smartcard number exactly as the user gave it." },
  },
  required: ["service", "provider", "number"],
  validate: ({ number }) => (/^\d{8,13}$/.test(number.replace(/\s/g, "")) ? null : "Meter and smartcard numbers are 8 to 13 digits."),
  handler: ({ service, provider, number }) => {
    const valid = service === "electricity" ? sandbox.DISCOS[provider] : sandbox.TV[provider];
    if (!valid) return { ok: false, reason: "wrong_provider", message: `${provider} is not a ${service} provider.` };
    const customer = sandbox.lookupCustomer(service, provider, number.replace(/\s/g, ""));
    if (!customer.found) return { ok: true, found: false, message: "No account with that number. Ask them to check it." };
    return { ok: true, found: true, name: customer.name, address: customer.address };
  },
});

const buyAirtime = defineTool({
  name: "buy_airtime",
  kind: "money",
  description: `Quote airtime for a Nigerian mobile number. ${QUOTE_ONLY} Never guess the network from the number.`,
  properties: {
    network: { type: "string", enum: NETWORK_IDS },
    phone: { type: "string", description: "e.g. 08031234567 or +2348031234567" },
    amountNaira: { type: "integer", description: "Naira, as the user said it. Not kobo." },
  },
  required: ["network", "phone", "amountNaira"],
  validate: ({ phone, amountNaira }) => {
    if (!normalisePhone(phone)) return "That is not a Nigerian mobile number.";
    if (amountNaira < 50) return "The smallest airtime top-up is NGN 50.";
    if (amountNaira > 50_000) return "The largest airtime top-up is NGN 50,000.";
    return null;
  },
  handler: ({ network, phone, amountNaira }, ctx) => {
    const number = normalisePhone(phone);
    return checkout.quote({
      ctx,
      kind: "airtime",
      params: { network, phone: number },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} ${sandbox.NETWORKS[network]} airtime to number ending ${lastFour(number)}`,
    });
  },
});

const buyData = defineTool({
  name: "buy_data",
  kind: "money",
  description: `Quote a data bundle. Use a planId from list_plans for that same network. ${QUOTE_ONLY}`,
  properties: {
    network: { type: "string", enum: NETWORK_IDS },
    phone: { type: "string" },
    planId: { type: "string" },
  },
  required: ["network", "phone", "planId"],
  validate: ({ phone }) => (normalisePhone(phone) ? null : "That is not a Nigerian mobile number."),
  handler: ({ network, phone, planId }, ctx) => {
    const plan = sandbox.findPlan("data", network, planId);
    if (!plan) return { ok: false, reason: "unknown_plan", message: "Not a plan for this network. Call list_plans and pick again." };
    const number = normalisePhone(phone);
    return checkout.quote({
      ctx,
      kind: "data",
      params: { network, phone: number, planId },
      principalKobo: plan.priceKobo,
      summary: `${sandbox.NETWORKS[network]} ${plan.label} data to number ending ${lastFour(number)}`,
    });
  },
});

const payElectricity = defineTool({
  name: "pay_electricity",
  kind: "money",
  description:
    `Quote an electricity payment. Only after lookup_customer and after the user confirmed the name. ${QUOTE_ONLY}`,
  properties: {
    disco: { type: "string", enum: Object.keys(sandbox.DISCOS) },
    meter: { type: "string" },
    meterType: { type: "string", enum: ["prepaid", "postpaid"] },
    amountNaira: { type: "integer" },
  },
  required: ["disco", "meter", "meterType", "amountNaira"],
  validate: ({ meter, amountNaira }) => {
    if (!/^\d{8,13}$/.test(meter.replace(/\s/g, ""))) return "Meter numbers are 8 to 13 digits.";
    if (amountNaira < 1_000) return "The smallest electricity payment is NGN 1,000.";
    if (amountNaira > 200_000) return "The largest electricity payment is NGN 200,000.";
    return null;
  },
  handler: ({ disco, meter, meterType, amountNaira }, ctx) => {
    const number = meter.replace(/\s/g, "");
    return checkout.quote({
      ctx,
      kind: "electricity",
      params: { disco, meter: number, meterType },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} ${sandbox.DISCOS[disco]} ${meterType} for meter ending ${lastFour(number)}`,
    });
  },
});

const payTv = defineTool({
  name: "pay_tv",
  kind: "money",
  description:
    `Quote a TV subscription. Only after lookup_customer, the user confirming the name, and a planId from list_plans. ${QUOTE_ONLY}`,
  properties: {
    provider: { type: "string", enum: Object.keys(sandbox.TV) },
    smartcard: { type: "string" },
    planId: { type: "string" },
  },
  required: ["provider", "smartcard", "planId"],
  validate: ({ smartcard }) => (/^\d{8,13}$/.test(smartcard.replace(/\s/g, "")) ? null : "Smartcard numbers are 8 to 13 digits."),
  handler: ({ provider, smartcard, planId }, ctx) => {
    const plan = sandbox.findPlan("tv", provider, planId);
    if (!plan) return { ok: false, reason: "unknown_plan", message: "Not a plan for this provider. Call list_plans and pick again." };
    const number = smartcard.replace(/\s/g, "");
    return checkout.quote({
      ctx,
      kind: "tv",
      params: { provider, smartcard: number, planId },
      principalKobo: plan.priceKobo,
      summary: `${plan.label} for smartcard ending ${lastFour(number)}`,
    });
  },
});

const confirmPurchase = defineTool({
  name: "confirm_purchase",
  kind: "money",
  description:
    "Charge the user for a quoted order they have ALREADY agreed to, in their own words, after seeing the total. " +
    "Never in the same turn as the quote. If you are not sure they said yes, ask.",
  properties: { orderId: { type: "integer", description: "The orderId from the quote." } },
  required: ["orderId"],
  handler: ({ orderId }, ctx) => checkout.confirm({ orderId, ctx }),
});

const cancelOrder = defineTool({
  name: "cancel_order",
  kind: "read",
  description: "Cancel a quote the user no longer wants. Only unconfirmed quotes can be cancelled.",
  properties: { orderId: { type: "integer" } },
  required: ["orderId"],
  handler: ({ orderId }, ctx) => {
    if (!store.get(orderId, ctx.userId)) return { ok: false, reason: "not_found" };
    return checkout.cancel({ orderId, ctx });
  },
});

module.exports = [listPlans, lookupCustomer, buyAirtime, buyData, payElectricity, payTv, confirmPurchase, cancelOrder];
