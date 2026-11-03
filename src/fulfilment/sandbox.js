"use strict";

const crypto = require("node:crypto");

const config = require("../config");

/**
 * The simulated world this repo runs against: bill providers, local
 * merchants, a ride network, airlines, a bank-name lookup and a stablecoin
 * on-ramp. Every catalogue entry, name, fare and reference here is invented.
 *
 * A real integration replaces this module behind the same functions. Each
 * `vend` resolves with a definite outcome, or throws when the outcome is
 * genuinely unknown.
 *
 * Magic last-four digits on a phone, meter, smartcard or account number:
 *   0000 -> not found      9999 -> provider declines (refund)
 *   7777 -> provider times out (money held for review)
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
const pick = (list, seed) => list[digest(seed)[0] % list.length];
const ref = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const NAMES = ["Adaeze Okafor", "Tunde Bakare", "Halima Musa", "Chinedu Eze", "Funmi Adeyemi", "Ibrahim Sani", "Ngozi Obi", "Segun Alabi"];

// ---------------------------------------------------------------- bills

const NETWORKS = { mtn: "MTN", airtel: "Airtel", glo: "Glo", "9mobile": "9mobile" };
const DISCOS = { ikeja: "Ikeja Electric", eko: "Eko Electric", abuja: "Abuja Electric", ibadan: "Ibadan Electric", enugu: "Enugu Electric" };
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

function listPlans(service, provider) {
  const rows = service === "data" ? (NETWORKS[provider] ? DATA_PLANS : null) : service === "tv" ? TV_PLANS[provider] : null;
  if (!rows) return null;
  return rows.map(([id, label, priceKobo]) => ({ planId: `${provider}-${id}`, label, priceKobo }));
}

function findPlan(service, provider, planId) {
  return (listPlans(service, provider) || []).find((plan) => plan.planId === planId) || null;
}

function lookupCustomer(service, provider, number) {
  if (String(number).endsWith("0000")) return { found: false };
  return {
    found: true,
    name: pick(NAMES, `${service}:${provider}:${number}`),
    address: service === "electricity" ? "12 Sandbox Close, Lagos" : null,
  };
}

// ------------------------------------------------------------ merchants

const MERCHANTS = [
  { id: 1, name: "Mama Put Express", areas: ["yaba", "surulere", "ikeja"], deliveryFeeKobo: 80_000 },
  { id: 2, name: "Lekki Bakehouse", areas: ["lekki", "vi", "ikoyi", "ajah"], deliveryFeeKobo: 120_000 },
  { id: 3, name: "Gadget Corner", areas: ["ikeja", "yaba", "lekki", "surulere"], deliveryFeeKobo: 150_000 },
  { id: 4, name: "Fresh Basket Groceries", areas: ["yaba", "lekki", "ikeja", "surulere", "ajah"], deliveryFeeKobo: 100_000 },
];

const LISTINGS = [
  { id: 101, merchantId: 1, name: "Jollof rice and chicken", priceKobo: 350_000, tags: "food jollof rice chicken lunch" },
  { id: 102, merchantId: 1, name: "Amala, ewedu and assorted", priceKobo: 300_000, tags: "food amala ewedu swallow" },
  { id: 103, merchantId: 1, name: "Pounded yam and egusi", priceKobo: 380_000, tags: "food pounded yam egusi swallow" },
  { id: 104, merchantId: 1, name: "Suya (large)", priceKobo: 250_000, tags: "food suya meat snack" },
  { id: 201, merchantId: 2, name: "Red velvet cake, 8 inch", priceKobo: 2_500_000, tags: "cake birthday red velvet" },
  { id: 202, merchantId: 2, name: "Meat pie (box of 6)", priceKobo: 450_000, tags: "snack meat pie pastry" },
  { id: 203, merchantId: 2, name: "Chocolate cupcakes (6)", priceKobo: 600_000, tags: "cake cupcake chocolate" },
  { id: 301, merchantId: 3, name: "20W fast charger, USB-C", priceKobo: 850_000, tags: "gadget charger phone usb" },
  { id: 302, merchantId: 3, name: "Wireless earbuds", priceKobo: 1_800_000, tags: "gadget earbuds headphones audio" },
  { id: 303, merchantId: 3, name: "10000mAh power bank", priceKobo: 1_500_000, tags: "gadget power bank battery" },
  { id: 401, merchantId: 4, name: "Rice, 5kg bag", priceKobo: 750_000, tags: "grocery rice foodstuff" },
  { id: 402, merchantId: 4, name: "Tomatoes and pepper mix", priceKobo: 200_000, tags: "grocery tomato pepper vegetables" },
  { id: 403, merchantId: 4, name: "Eggs, crate of 30", priceKobo: 550_000, tags: "grocery eggs" },
];

const normaliseArea = (area) => String(area || "").toLowerCase().replace(/[^a-z]/g, "");

function findListings(query, area) {
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const where = normaliseArea(area);
  return LISTINGS.map((listing) => {
    const merchant = MERCHANTS.find((m) => m.id === listing.merchantId);
    const haystack = `${listing.name} ${listing.tags}`.toLowerCase();
    const score = words.filter((w) => haystack.includes(w) || haystack.includes(w.replace(/s$/, ""))).length;
    return { listing, merchant, score };
  })
    .filter(({ score, merchant }) => score > 0 && (!where || merchant.areas.includes(where)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

const getListing = (id) => LISTINGS.find((l) => l.id === id) || null;
const getMerchant = (id) => MERCHANTS.find((m) => m.id === id) || null;

const PHOTO_COLOURS = ["#e8a33d", "#d0573f", "#4f8a5b", "#3f6fb5", "#8a5bb0"];
const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A generated stand-in product photo, as SVG. */
function listingPhotoSvg(listing) {
  const colour = PHOTO_COLOURS[listing.id % PHOTO_COLOURS.length];
  const merchant = getMerchant(listing.merchantId);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
<rect width="480" height="320" fill="${colour}"/><circle cx="380" cy="80" r="120" fill="#fff" opacity=".12"/>
<circle cx="90" cy="280" r="90" fill="#000" opacity=".08"/>
<text x="32" y="150" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="#fff">${escapeXml(listing.name)}</text>
<text x="32" y="192" font-family="system-ui,sans-serif" font-size="20" fill="#fff" opacity=".9">${escapeXml(merchant.name)}</text>
<text x="32" y="270" font-family="system-ui,sans-serif" font-size="26" font-weight="700" fill="#fff">₦${(listing.priceKobo / 100).toLocaleString("en-NG")}</text>
<text x="448" y="300" text-anchor="end" font-family="system-ui,sans-serif" font-size="12" fill="#fff" opacity=".7">sandbox photo</text></svg>`;
}

// ---------------------------------------------------------------- rides

const RIDE_BOOKING_FEE_KOBO = 20_000;
const CARS = ["Toyota Corolla", "Kia Rio", "Honda Accord", "Hyundai Elantra"];

function estimateRide(from, to) {
  const seed = digest(`${from}|${to}`);
  const km = 4 + (seed[1] % 22);
  const lowKobo = Math.round((700 + km * 260) / 50) * 5_000;
  return { km, etaMinutes: 3 + (seed[2] % 9), fareLowKobo: lowKobo, fareHighKobo: lowKobo + 150_000 };
}

function driverFor(orderId) {
  const seed = digest(`driver:${orderId}`);
  const name = pick(NAMES, `driver:${orderId}`);
  return {
    name,
    car: pick(CARS, `car:${orderId}`),
    plate: `LND-${100 + (seed[3] % 900)}${String.fromCharCode(65 + (seed[4] % 26))}${String.fromCharCode(65 + (seed[5] % 26))}`,
    bankName: "Sandbox Bank",
    accountNumber: `30${String(1e8 + (seed.readUInt32BE(6) % 9e7)).slice(0, 8)}`,
  };
}

const driverAccounts = new Map();
// Disjoint from NAMES, so an account that isn't the driver's can never match a driver's name by chance.
const ACCOUNT_HOLDERS = ["Kemi Johnson", "Uche Nwosu", "Bola Ahmed", "Yusuf Bello", "Grace Etim"];

/** Account name lookup, as a bank-verification service would answer it. */
function resolveAccount(accountNumber) {
  const number = String(accountNumber);
  if (!/^\d{10}$/.test(number) || number.endsWith("0000")) return { found: false };
  return { found: true, name: driverAccounts.get(number) || pick(ACCOUNT_HOLDERS, `acct:${number}`) };
}

// -------------------------------------------------------------- flights

const AIRPORTS = {
  lagos: "LOS", abuja: "ABV", "port harcourt": "PHC", kano: "KAN", enugu: "ENU",
  owerri: "QOW", calabar: "CBQ", uyo: "QUO", benin: "BNI", asaba: "ABB",
};
const AIRLINES = ["Air Peace", "Ibom Air", "United Nigeria", "Overland Airways"];

function airportCode(city) {
  const key = String(city || "").toLowerCase().trim();
  if (AIRPORTS[key]) return AIRPORTS[key];
  const code = key.toUpperCase();
  return Object.values(AIRPORTS).includes(code) ? code : null;
}

function searchFlights({ from, to, date }) {
  const origin = airportCode(from);
  const destination = airportCode(to);
  if (!origin || !destination || origin === destination) return null;
  return [7, 12, 17].map((hour, i) => {
    const seed = digest(`${origin}${destination}${date}${i}`);
    const minutes = (seed[0] % 4) * 15;
    const duration = 55 + (seed[1] % 50);
    const depart = `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    const arriveTotal = hour * 60 + minutes + duration;
    const arrive = `${String(Math.floor(arriveTotal / 60)).padStart(2, "0")}:${String(arriveTotal % 60).padStart(2, "0")}`;
    return {
      airline: AIRLINES[(seed[2] + i) % AIRLINES.length],
      route: `${origin} → ${destination}`,
      date,
      depart,
      arrive,
      priceKobo: (95 + (seed[3] % 90)) * 100_000,
    };
  });
}

// ------------------------------------------------------- ASAP directory

/** Other ASAP users that sandbox credits can be shared with. */
const DIRECTORY = { "08012345678": "Tobi A.", "08098765432": "Amaka O.", "07011112222": "Musa K." };

const findAsapUser = (phone) => (DIRECTORY[phone] ? { userId: `phone:${phone}`, displayName: DIRECTORY[phone] } : null);

// ------------------------------------------------------------ stablecoin

const USDC_RATE_KOBO = 155_000;
const MAX_USDC = 500;
const CHAINS = { base: "Base", solana: "Solana", polygon: "Polygon" };

function depositAddress(userId, chain) {
  const hex = digest(`deposit:${chain}:${userId}`).toString("hex");
  return chain === "solana" ? `So1${hex.slice(0, 40)}` : `0x${hex.slice(0, 40)}`;
}

// ---------------------------------------------------------------- vend

function targetOf(order) {
  const p = order.params;
  return String(p.phone || p.meter || p.smartcard || p.accountNumber || "");
}

/**
 * Deliver a paid order. Resolves with
 *   { status: "delivered", reference, ...details } | { status: "declined" }
 *   | { status: "assigned", driver }   (rides: a driver is on the way)
 * and throws when the outcome is unknown.
 */
async function vend(order) {
  await sleep(config.sandbox.latencyMs);
  const target = targetOf(order);
  if (target.endsWith("7777")) throw new Error("Sandbox provider timed out");
  if (target.endsWith("9999")) return { status: "declined" };

  switch (order.kind) {
    case "ride": {
      const driver = driverFor(order.id);
      driverAccounts.set(driver.accountNumber, driver.name);
      return { status: "assigned", reference: ref("RIDE"), driver };
    }
    case "flight":
      return { status: "delivered", reference: crypto.randomBytes(3).toString("hex").toUpperCase() };
    case "merchant_order":
      return { status: "delivered", reference: ref("ORD"), etaMinutes: 35 };
    case "electricity": {
      const result = { status: "delivered", reference: ref("SBX") };
      if (order.params.meterType === "prepaid") {
        const digits = BigInt(`0x${digest(result.reference).toString("hex").slice(0, 16)}`).toString().padStart(20, "0").slice(-20);
        result.token = digits.match(/.{4}/g).join("-");
      }
      return result;
    }
    default:
      return { status: "delivered", reference: ref("SBX") };
  }
}

module.exports = {
  NETWORKS, DISCOS, TV, CHAINS, USDC_RATE_KOBO, MAX_USDC, RIDE_BOOKING_FEE_KOBO,
  listPlans, findPlan, lookupCustomer,
  findListings, getListing, getMerchant, listingPhotoSvg, normaliseArea,
  estimateRide, resolveAccount,
  airportCode, searchFlights,
  findAsapUser,
  depositAddress,
  vend,
};
