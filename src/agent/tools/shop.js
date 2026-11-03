"use strict";

const { defineTool } = require("./define");
const { normalisePhone } = require("./phone");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const profile = require("../../users/profile");
const { naira } = require("../../money");

/**
 * Ordering from local merchants: search, build a basket from one merchant,
 * then price the whole order once with one delivery fee. Prices always come
 * from the catalogue, never from the model.
 */

const MAX_QUANTITY = 20;

function basketView(basket) {
  const merchant = sandbox.getMerchant(basket.merchantId);
  let subtotal = 0;
  const items = basket.items.map((item) => {
    const listing = sandbox.getListing(item.listingId);
    subtotal += listing.priceKobo * item.quantity;
    return { listingId: listing.id, name: listing.name, quantity: item.quantity, lineTotal: naira(listing.priceKobo * item.quantity), note: item.note || null };
  });
  return { merchant: merchant.name, items, subtotalKobo: subtotal, subtotal: naira(subtotal), deliveryFee: naira(merchant.deliveryFeeKobo) };
}

const findListings = defineTool({
  name: "find_listings",
  kind: "read",
  description:
    "Search goods local merchants sell: food, groceries, cakes, gadgets. Goods only, never services. Pass simple " +
    "English item words (translate first: ìrẹsì / shinkafa / osikapa -> rice); common Yoruba, Hausa and Igbo item names " +
    "also match. Filters to merchants delivering to their saved area when one is known. Charges nothing.",
  properties: {
    query: { type: "string" },
    area: { type: "string", description: "Only if they just said where they are; otherwise the saved area is used." },
  },
  required: ["query"],
  handler: ({ query, area }, ctx) => {
    const where = area || profile.get(ctx.userId).area;
    const results = sandbox.findListings(query, where);
    if (results.length === 0) {
      return { ok: true, results: [], message: where ? `Nothing matching delivers to ${where} right now.` : "Nothing matching right now." };
    }
    return {
      ok: true,
      area: where || null,
      results: results.map(({ listing, merchant }) => ({
        listingId: listing.id,
        name: listing.name,
        price: naira(listing.priceKobo),
        merchant: merchant.name,
      })),
      ...(where ? {} : { note: "Area unknown: ask where they are before ordering, so delivery can be checked." }),
    };
  },
});

const sendListingPhoto = defineTool({
  name: "send_listing_photo",
  kind: "read",
  description: "Show the user a listing's photo when they ask to see it. Pass a listingId from find_listings. Never paste an image link yourself.",
  properties: { listingId: { type: "integer" } },
  required: ["listingId"],
  handler: ({ listingId }, ctx) => {
    const listing = sandbox.getListing(listingId);
    if (!listing) return { ok: false, reason: "not_found", message: "No listing with that id." };
    ctx.attachments.push({ type: "image", url: `/media/listing/${listing.id}.svg`, caption: listing.name });
    return { ok: true, sent: true, message: "The photo has been sent. Do not describe a link." };
  },
});

const addToOrder = defineTool({
  name: "add_to_order",
  kind: "read",
  description:
    "Add an item from find_listings to the user's basket. One basket is one merchant, because it is one delivery. " +
    "Call once per different item. Charges nothing; place_order prices the whole basket when they are done.",
  properties: {
    listingId: { type: "integer" },
    quantity: { type: "integer" },
    note: { type: "string", description: "e.g. 'extra pepper', 'write Happy Birthday Ada'." },
    startNew: { type: "boolean", description: "Only after the user agreed to drop a basket from another merchant." },
  },
  required: ["listingId"],
  validate: ({ quantity }) => (quantity !== undefined && (quantity < 1 || quantity > MAX_QUANTITY) ? `Quantity must be 1 to ${MAX_QUANTITY}.` : null),
  handler: ({ listingId, quantity = 1, note, startNew }, ctx) => {
    const listing = sandbox.getListing(listingId);
    if (!listing) return { ok: false, reason: "not_found", message: "No listing with that id. Search again." };

    const p = profile.get(ctx.userId);
    if (p.basket && p.basket.merchantId !== listing.merchantId && !startNew) {
      return {
        ok: false,
        reason: "different_merchant",
        message: `Their basket is from ${sandbox.getMerchant(p.basket.merchantId).name}. Ask if they want to start a new basket from ${sandbox.getMerchant(listing.merchantId).name} instead.`,
      };
    }
    if (!p.basket || startNew) p.basket = { merchantId: listing.merchantId, items: [] };

    const existing = p.basket.items.find((item) => item.listingId === listingId);
    if (existing) {
      existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
      if (note) existing.note = note;
    } else {
      p.basket.items.push({ listingId, quantity, note });
    }
    const view = basketView(p.basket);
    return { ok: true, basket: { merchant: view.merchant, items: view.items, subtotal: view.subtotal } };
  },
});

const placeOrder = defineTool({
  name: "place_order",
  kind: "money",
  description:
    "Price the whole basket as one order with one delivery fee, once the user is done adding. Ask for the delivery " +
    "address first, and a phone number the rider can call. This only produces a total; confirm_purchase charges it.",
  properties: {
    address: { type: "string" },
    phone: { type: "string" },
  },
  required: ["address", "phone"],
  validate: ({ address, phone }) => {
    if (address.trim().length < 5) return "Ask for a full delivery address.";
    return normalisePhone(phone) ? null : "That is not a Nigerian mobile number.";
  },
  handler: ({ address, phone }, ctx) => {
    const p = profile.get(ctx.userId);
    if (!p.basket || p.basket.items.length === 0) return { ok: false, reason: "empty_basket", message: "The basket is empty. Add items first." };

    const merchant = sandbox.getMerchant(p.basket.merchantId);
    const view = basketView(p.basket);
    const items = p.basket.items.map((item) => ({ ...item }));
    p.basket = null;

    return checkout.quote({
      ctx,
      kind: "merchant_order",
      params: { merchantId: merchant.id, merchantName: merchant.name, items, address: address.trim(), phone: normalisePhone(phone) },
      principalKobo: view.subtotalKobo,
      feeKobo: merchant.deliveryFeeKobo,
      summary: `${view.items.map((i) => `${i.quantity}x ${i.name}`).join(", ")} from ${merchant.name}`,
      extra: { deliveryFee: naira(merchant.deliveryFeeKobo), deliverTo: address.trim() },
    });
  },
});

module.exports = [findListings, sendListingPhoto, addToOrder, placeOrder];
