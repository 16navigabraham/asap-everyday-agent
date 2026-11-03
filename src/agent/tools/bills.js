"use strict";

const { defineTool } = require("./define");
const { normalisePhone } = require("./phone");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const profile = require("../../users/profile");
const { naira } = require("../../money");

/**
 * Airtime, data, electricity and TV. Every purchase tool here only quotes;
 * money moves through confirm_purchase in a later turn.
 */

const NETWORK_IDS = Object.keys(sandbox.NETWORKS);
const QUOTE_ONLY = "This only prepares a quote; nothing is charged until confirm_purchase.";
const lastFour = (value) => String(value).slice(-4);
const digitsOnly = (value) => String(value).replace(/\s/g, "");
const isAccountNumber = (value) => /^\d{8,13}$/.test(digitsOnly(value));

/**
 * The number to act on: typed, or resolved from a saved entry. A saved
 * entry's provider fills in a missing network/disco/TV provider, never
 * overrides one the model gave.
 */
function resolveTarget(ctx, { typed, savedId, kind, provider, normalise }) {
  if (typed !== undefined) {
    const value = normalise(typed);
    return value ? { ok: true, value, provider } : { ok: false, reason: "invalid_number" };
  }
  const saved = profile.resolveSaved(ctx.userId, savedId, kind);
  if (!saved.ok) return saved;
  return { ok: true, value: saved.value, provider: provider || saved.provider };
}

const needProvider = (what) => ({
  ok: false,
  reason: "provider_required",
  message: `Nothing was quoted. Ask which ${what} this is for, then call again with it.`,
});

const eitherNumberOrSaved = (typed, savedId, noun) =>
  typed === undefined && savedId === undefined ? `Ask for the ${noun}, or use a saved one (savedId).` : null;

const listPlans = defineTool({
  name: "list_plans",
  kind: "read",
  description:
    "Plans and prices for data bundles (provider = network) or TV (provider = dstv, gotv, startimes). Always call " +
    "this before quoting data or TV, and use only the plan ids and prices it returns.",
  properties: {
    service: { type: "string", enum: ["data", "tv"] },
    provider: { type: "string", enum: [...NETWORK_IDS, ...Object.keys(sandbox.TV)] },
  },
  required: ["service", "provider"],
  handler: ({ service, provider }) => {
    const plans = sandbox.listPlans(service, provider);
    if (!plans) return { ok: false, reason: "no_such_provider", message: `${provider} has no ${service} plans.` };
    return { ok: true, plans: plans.map((p) => ({ planId: p.planId, label: p.label, price: naira(p.priceKobo) })) };
  },
});

const lookupCustomer = defineTool({
  name: "lookup_customer",
  kind: "read",
  description:
    "The registered name on an electricity meter or TV smartcard. Required before every bill payment: tell the " +
    "user the name and get them to confirm it is the right account before quoting.",
  properties: {
    service: { type: "string", enum: ["electricity", "tv"] },
    provider: { type: "string", enum: [...Object.keys(sandbox.DISCOS), ...Object.keys(sandbox.TV)] },
    number: { type: "string", description: "Meter or smartcard number exactly as given." },
  },
  required: ["service", "provider", "number"],
  validate: ({ number }) => (isAccountNumber(number) ? null : "Meter and smartcard numbers are 8 to 13 digits."),
  handler: ({ service, provider, number }) => {
    const valid = service === "electricity" ? sandbox.DISCOS[provider] : sandbox.TV[provider];
    if (!valid) return { ok: false, reason: "wrong_provider", message: `${provider} is not a ${service} provider.` };
    const customer = sandbox.lookupCustomer(service, provider, digitsOnly(number));
    if (!customer.found) return { ok: true, found: false, message: "No account with that number. Ask them to check it." };
    return { ok: true, found: true, name: customer.name, address: customer.address };
  },
});

const buyAirtime = defineTool({
  name: "buy_airtime",
  kind: "money",
  description:
    `Quote airtime for a Nigerian mobile number, typed or saved (savedId from saved_details). ${QUOTE_ONLY} ` +
    "Never guess the network from the number; a saved number already carries its own.",
  properties: {
    network: { type: "string", enum: NETWORK_IDS },
    phone: { type: "string", description: "e.g. 08031234567 or +2348031234567. Leave out when using savedId." },
    savedId: { type: "integer" },
    amountNaira: { type: "integer", description: "Naira, as the user said it. Not kobo." },
  },
  required: ["amountNaira"],
  validate: ({ phone, savedId, network, amountNaira }) => {
    if (amountNaira < 50) return "The smallest airtime top-up is NGN 50.";
    if (amountNaira > 50_000) return "The largest airtime top-up is NGN 50,000.";
    if (phone !== undefined && !normalisePhone(phone)) return "That is not a Nigerian mobile number.";
    if (phone !== undefined && !network) return "Ask which network; it cannot be inferred from a typed number.";
    return eitherNumberOrSaved(phone, savedId, "number to top up");
  },
  handler: ({ network, phone, savedId, amountNaira }, ctx) => {
    const target = resolveTarget(ctx, { typed: phone, savedId, kind: "phone", provider: network, normalise: normalisePhone });
    if (!target.ok) return target;
    if (!target.provider) return needProvider("network");
    return checkout.quote({
      ctx,
      kind: "airtime",
      params: { network: target.provider, phone: target.value },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} ${sandbox.NETWORKS[target.provider]} airtime to number ending ${lastFour(target.value)}`,
    });
  },
});

const buyData = defineTool({
  name: "buy_data",
  kind: "money",
  description: `Quote a data bundle, using a planId from list_plans for that same network. ${QUOTE_ONLY}`,
  properties: {
    network: { type: "string", enum: NETWORK_IDS },
    phone: { type: "string" },
    savedId: { type: "integer" },
    planId: { type: "string" },
  },
  required: ["planId"],
  validate: ({ phone, savedId, network }) => {
    if (phone !== undefined && !normalisePhone(phone)) return "That is not a Nigerian mobile number.";
    if (phone !== undefined && !network) return "Ask which network; it cannot be inferred from a typed number.";
    return eitherNumberOrSaved(phone, savedId, "number");
  },
  handler: ({ network, phone, savedId, planId }, ctx) => {
    const target = resolveTarget(ctx, { typed: phone, savedId, kind: "phone", provider: network, normalise: normalisePhone });
    if (!target.ok) return target;
    if (!target.provider) return needProvider("network");
    const plan = sandbox.findPlan("data", target.provider, planId);
    if (!plan) return { ok: false, reason: "unknown_plan", message: "Not a plan on this network. Call list_plans and pick again." };
    return checkout.quote({
      ctx,
      kind: "data",
      params: { network: target.provider, phone: target.value, planId },
      principalKobo: plan.priceKobo,
      summary: `${sandbox.NETWORKS[target.provider]} ${plan.label} data to number ending ${lastFour(target.value)}`,
    });
  },
});

const payElectricity = defineTool({
  name: "pay_electricity",
  kind: "money",
  description: `Quote an electricity payment, only after lookup_customer and the user confirming the name. ${QUOTE_ONLY}`,
  properties: {
    disco: { type: "string", enum: Object.keys(sandbox.DISCOS) },
    meter: { type: "string" },
    savedId: { type: "integer" },
    meterType: { type: "string", enum: ["prepaid", "postpaid"] },
    amountNaira: { type: "integer" },
  },
  required: ["meterType", "amountNaira"],
  validate: ({ meter, savedId, amountNaira }) => {
    if (meter !== undefined && !isAccountNumber(meter)) return "Meter numbers are 8 to 13 digits.";
    if (amountNaira < 1_000) return "The smallest electricity payment is NGN 1,000.";
    if (amountNaira > 200_000) return "The largest electricity payment is NGN 200,000.";
    return eitherNumberOrSaved(meter, savedId, "meter number");
  },
  handler: ({ disco, meter, savedId, meterType, amountNaira }, ctx) => {
    const target = resolveTarget(ctx, { typed: meter, savedId, kind: "meter", provider: disco, normalise: digitsOnly });
    if (!target.ok) return target;
    if (!target.provider) return needProvider("electricity company");
    return checkout.quote({
      ctx,
      kind: "electricity",
      params: { disco: target.provider, meter: target.value, meterType },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} ${sandbox.DISCOS[target.provider]} ${meterType} for meter ending ${lastFour(target.value)}`,
    });
  },
});

const payTv = defineTool({
  name: "pay_tv",
  kind: "money",
  description:
    `Quote a TV subscription, only after lookup_customer, the user confirming the name, and a planId from list_plans. ${QUOTE_ONLY}`,
  properties: {
    provider: { type: "string", enum: Object.keys(sandbox.TV) },
    smartcard: { type: "string" },
    savedId: { type: "integer" },
    planId: { type: "string" },
  },
  required: ["planId"],
  validate: ({ smartcard, savedId }) => {
    if (smartcard !== undefined && !isAccountNumber(smartcard)) return "Smartcard numbers are 8 to 13 digits.";
    return eitherNumberOrSaved(smartcard, savedId, "smartcard number");
  },
  handler: ({ provider, smartcard, savedId, planId }, ctx) => {
    const target = resolveTarget(ctx, { typed: smartcard, savedId, kind: "smartcard", provider, normalise: digitsOnly });
    if (!target.ok) return target;
    if (!target.provider) return needProvider("TV provider");
    const plan = sandbox.findPlan("tv", target.provider, planId);
    if (!plan) return { ok: false, reason: "unknown_plan", message: "Not a plan for this provider. Call list_plans and pick again." };
    return checkout.quote({
      ctx,
      kind: "tv",
      params: { provider: target.provider, smartcard: target.value, planId },
      principalKobo: plan.priceKobo,
      summary: `${plan.label} for smartcard ending ${lastFour(target.value)}`,
    });
  },
});

module.exports = [listPlans, lookupCustomer, buyAirtime, buyData, payElectricity, payTv];
