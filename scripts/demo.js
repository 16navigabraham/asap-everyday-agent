"use strict";

/**
 * A live walkthrough: a scripted customer talks to the real agent on Meta
 * Muse Spark, and every reply and delivery notification is printed. Muse
 * writes the replies, so the wording differs from run to run; the money
 * rules do not.
 *
 *   npm run demo
 */

const config = require("../src/config");
const notify = require("../src/notify");
const ledger = require("../src/wallet/ledger");
const { handleMessage } = require("../src/conversations");
const { naira } = require("../src/money");

const USER = "demo:walkthrough";

const SCRIPT = [
  "Hi! Call me Tobi.",
  "What's my balance?",
  "Buy ₦500 MTN airtime for 08031234567",
  "Yes, go ahead",
  "I'm in Yaba. What jollof rice can I get?",
  "Get me a ride from Yaba to Lekki Phase 1",
  "Yes, book it",
  "Actually cancel the ride",
  "Buy ₦300 Airtel airtime for 08031239999",
  "Yes",
  "Did my airtime go through? What's my balance now?",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

async function main() {
  if (!config.muse.apiKey) {
    console.error("Set META_API_KEY in .env first: this demo talks to the real Muse Spark.");
    process.exit(1);
  }

  const updates = [];
  notify.register("demo", (_userId, text) => updates.push(text));

  console.log(bold(`ASAP walkthrough on Meta Muse Spark (${config.muse.model})`));
  console.log(dim(`Sandbox wallet starts at ${naira(ledger.balanceKobo(USER))}. Numbers ending 9999 are declined by the sandbox provider.\n`));

  for (const text of SCRIPT) {
    console.log(`${bold("Tobi ›")} ${text}`);
    const started = Date.now();
    const { reply, attachments } = await handleMessage(USER, text);
    console.log(`${bold("ASAP ›")} ${reply}`);
    for (const a of attachments) console.log(dim(`       [photo: ${a.caption}]`));
    console.log(dim(`       (${((Date.now() - started) / 1000).toFixed(1)}s)`));

    // Give the sandbox time to deliver, then show what arrived out of band.
    await sleep(config.sandbox.latencyMs + 500);
    while (updates.length) console.log(`${bold("  ↳ update:")} ${updates.shift()}`);
    console.log();
  }

  console.log(dim(`Final wallet balance: ${naira(ledger.balanceKobo(USER))}`));
  process.exit(0);
}

main();
