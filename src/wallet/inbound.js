"use strict";

const config = require("../config");
const ledger = require("./ledger");
const { notify } = require("../notify");

/**
 * Simulated money arriving from outside: a bank transfer into the user's
 * account number, or a stablecoin deposit landing on-chain. Credited after a
 * delay, like the real thing, and announced by notification.
 */

const pending = new Set();

function simulate({ userId, amountKobo, ref, memo, message }) {
  const run = new Promise((resolve) => {
    setTimeout(async () => {
      const { balanceKobo, replayed } = ledger.credit(userId, amountKobo, ref, memo);
      if (!replayed) await notify(userId, message(balanceKobo));
      resolve();
    }, config.sandbox.latencyMs);
  });
  pending.add(run);
  run.finally(() => pending.delete(run));
  return run;
}

/** Resolves when every in-flight simulated deposit has landed. */
const settled = () => Promise.all([...pending]);

module.exports = { simulate, settled };
