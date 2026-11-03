"use strict";

const config = require("../config");
const { canMove } = require("./states");

/** Orders, in memory. Every status change goes through `move`. */

const orders = new Map();
let nextId = 1;

function create({ userId, kind, params, summary, principalKobo, feeKobo, turnId }) {
  const now = Date.now();
  const order = {
    id: nextId++,
    userId,
    kind,
    params,
    summary,
    principalKobo,
    feeKobo,
    totalKobo: principalKobo + feeKobo,
    status: "quoted",
    quotedInTurn: turnId || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + config.orders.quoteTtlMs,
    history: [{ status: "quoted", at: new Date(now).toISOString() }],
    result: null,
  };
  orders.set(order.id, order);
  return order;
}

/** An order, but only to its owner. Someone else's id reads as not found. */
function get(id, userId) {
  const order = orders.get(id);
  if (!order || (userId !== undefined && order.userId !== userId)) return null;
  return order;
}

function move(order, to, patch = {}) {
  if (!canMove(order.status, to)) {
    throw new Error(`Order ${order.id}: illegal move ${order.status} -> ${to}`);
  }
  order.status = to;
  Object.assign(order, patch);
  order.history.push({ status: to, at: new Date().toISOString() });
  return order;
}

/** Expire a quote lazily, the moment anything looks at it past its deadline. */
function expireIfStale(order, now = Date.now()) {
  if (order.status === "quoted" && now > order.expiresAt) move(order, "expired");
  return order;
}

function forUser(userId, limit = 10) {
  return [...orders.values()]
    .filter((order) => order.userId === userId)
    .slice(-limit)
    .reverse()
    .map((order) => expireIfStale(order));
}

function reset() {
  orders.clear();
  nextId = 1;
}

module.exports = { create, get, move, expireIfStale, forUser, reset };
