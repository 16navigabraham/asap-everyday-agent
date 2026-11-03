"use strict";

const crypto = require("node:crypto");

const config = require("../config");

/**
 * A simulated fulfilment provider.
 *
 * It stands in for a real bills/airtime aggregator so this repo runs end to
 * end with no third-party credentials. Its catalogue, customer names and
 * tokens are invented. A real provider replaces this module by implementing
 * the same four functions: listPlans, lookupCustomer, vend, and the
 * NETWORKS/DISCOS/TV maps.
 *
 * Magic numbers, so failure paths can be shown on demand:
 *   phone / meter / smartcard ending 0000  -> customer not found
 *   phone / meter / smartcard ending 9999  -> provider declines (order is refunded)
 *   phone / meter / smartcard ending 7777  -> provider times out (order goes to review)
 */

const NETWORKS = { mtn: "MTN", airtel: "Airtel", glo: "Glo", "9mobile": "9mobile" };

const DISCOS = {
  ikeja: "Ikeja Electric",
  eko: "Eko Electric",
  abuja: "Abuja Electric",
  ibadan: "Ibadan Electric",
  enugu: "Enugu Electric",
};

const TV = { dstv: "DStv", gotv: "GOtv", startimes: "StarTimes" };

const DATA_PLANS = [
  ["1d-500mb", "500MB, 1 day", 20_000],
  ["1d-1gb", "1GB, 1 day", 35_000],
  ["7d-2gb", "2GB, 7 days", 75_000],
  ["30d-5gb", "5GB, 30 days", 250_000],
  ["30d-12gb", "12GB, 30 days", 500_000],
];

const TV_PLANS = {
  dstv: [["padi", "DStv Padi", 440_000], ["yanga", "DStv Yanga", 600_000], ["confam", "DStv Confam", 1_100_000]],
  gotv: [["smallie", "GOtv Smallie", 190_000], ["jinja", "GOtv Jinja", 390_000], ["max", "GOtv Max", 850_000]],
  startimes: [["nova", "StarTimes Nova", 210_000], ["basic", "StarTimes Basic", 400_000]],
};

const NAMES = ["Adaeze Okafor", "Tunde Bakare", "Halima Musa", "Chinedu Eze", "Funmi Adeyemi", "Ibrahim Sani", "Ngozi Obi"];

function listPlans(service, provider) {
  if (service === "data") {
    if (!NETWORKS[provider]) return null;
    return DATA_PLANS.map(([id, label, priceKobo]) => ({ planId: `${provider}-${id}`, label, priceKobo }));
  }
  if (service === "tv") {
    if (!TV_PLANS[provider]) return null;
    return TV_PLANS[provider].map(([id, label, priceKobo]) => ({ planId: `${provider}-${id}`, label, priceKobo }));
  }
  return null;
}

function findPlan(service, provider, planId) {
  return (listPlans(service, provider) || []).find((plan) => plan.planId === planId) || null;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/** A stable invented account holder for a meter or smartcard number. */
function lookupCustomer(service, provider, number) {
  if (String(number).endsWith("0000")) return { found: false };
  const name = NAMES[digest(`${service}:${provider}:${number}`)[0] % NAMES.length];
  const address = service === "electricity" ? "12 Sandbox Close, Lagos" : null;
  return { found: true, name, address };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver a paid order. Resolves with { status: "delivered" | "declined" }.
 * Throws when the outcome is unknown, which callers must not treat as a decline.
 */
async function vend(order) {
  await sleep(config.orders.sandboxLatencyMs);
  const target = String(order.params.phone || order.params.meter || order.params.smartcard || "");

  if (target.endsWith("7777")) throw new Error("Sandbox provider timed out");
  if (target.endsWith("9999")) return { status: "declined" };

  const reference = `SBX-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const result = { status: "delivered", reference };

  if (order.kind === "electricity" && order.params.meterType === "prepaid") {
    const digits = BigInt(`0x${digest(reference).toString("hex").slice(0, 16)}`).toString().padStart(20, "0").slice(-20);
    result.token = digits.match(/.{4}/g).join("-");
  }
  return result;
}

module.exports = { NETWORKS, DISCOS, TV, listPlans, findPlan, lookupCustomer, vend };
