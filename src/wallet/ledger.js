"use strict";

const config = require("../config");

/**
 * The wallet: an append-only ledger per user, in memory.
 *
 * Every movement is an entry with a unique reference, and writing the same
 * reference twice returns the first entry instead of moving money again. That
 * is what makes a retried confirm or a re-run refund harmless.
 *
 * The balance is always the sum of the entries, never a separately stored
 * number that can drift from them.
 */

class InsufficientFunds extends Error {
  constructor(balanceKobo, neededKobo) {
    super("Insufficient funds");
    this.name = "InsufficientFunds";
    this.balanceKobo = balanceKobo;
    this.shortfallKobo = neededKobo - balanceKobo;
  }
}

const accounts = new Map();

function account(userId) {
  let acct = accounts.get(userId);
  if (!acct) {
    acct = { entries: [], byRef: new Map() };
    accounts.set(userId, acct);
    if (config.wallet.starterKobo > 0) {
      append(acct, { amountKobo: config.wallet.starterKobo, ref: "starter", memo: "Sandbox starter credit" });
    }
  }
  return acct;
}

function append(acct, { amountKobo, ref, memo }) {
  const entry = { ref, amountKobo, memo, at: new Date().toISOString() };
  acct.entries.push(entry);
  acct.byRef.set(ref, entry);
  return entry;
}

function sum(acct) {
  return acct.entries.reduce((total, entry) => total + entry.amountKobo, 0);
}

function balanceKobo(userId) {
  return sum(account(userId));
}

function assertAmount(amountKobo) {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw new Error("Amount must be a positive whole number of kobo");
  }
}

/** Take money out. Throws InsufficientFunds; idempotent on `ref`. */
function debit(userId, amountKobo, ref, memo) {
  assertAmount(amountKobo);
  const acct = account(userId);
  const existing = acct.byRef.get(ref);
  if (existing) return { entry: existing, balanceKobo: sum(acct), replayed: true };

  const balance = sum(acct);
  if (balance < amountKobo) throw new InsufficientFunds(balance, amountKobo);

  const entry = append(acct, { amountKobo: -amountKobo, ref, memo });
  return { entry, balanceKobo: sum(acct), replayed: false };
}

/** Put money in. Idempotent on `ref`. */
function credit(userId, amountKobo, ref, memo) {
  assertAmount(amountKobo);
  const acct = account(userId);
  const existing = acct.byRef.get(ref);
  if (existing) return { entry: existing, balanceKobo: sum(acct), replayed: true };

  const entry = append(acct, { amountKobo, ref, memo });
  return { entry, balanceKobo: sum(acct), replayed: false };
}

/** Most recent first. */
function entries(userId, limit = 10) {
  return account(userId).entries.slice(-limit).reverse();
}

function reset() {
  accounts.clear();
}

module.exports = { balanceKobo, debit, credit, entries, reset, InsufficientFunds };
