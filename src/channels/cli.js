"use strict";

const readline = require("node:readline/promises");

const notify = require("../notify");
const modelSwitch = require("../model/switch");
const { getProvider } = require("../model/providers");
const { handleMessage } = require("../conversations");

/** Chat with the agent in a terminal. "/model muse" or "/model claude" flips the switch. */

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  notify.register("cli", (_userId, text) => console.log(`\n[update] ${text}\n`));

  console.log(`ASAP sandbox. Model: ${getProvider(modelSwitch.current()).label}. Type /model <muse|claude>, or /quit.\n`);

  for (;;) {
    const text = (await rl.question("you › ")).trim();
    if (!text) continue;
    if (text === "/quit") break;
    if (text.startsWith("/model ")) {
      const outcome = modelSwitch.set(text.slice(7).trim());
      console.log(outcome.ok ? `Switched to ${getProvider(outcome.provider).label}.` : `Cannot switch: ${outcome.reason}.`);
      continue;
    }
    const { reply, providers, failedOver } = await handleMessage("cli:local", text);
    const by = providers.map((id) => getProvider(id).label).join(" + ") || "no model";
    console.log(`asap › ${reply}\n       (${by}${failedOver ? ", failed over" : ""})\n`);
  }
  rl.close();
}

if (require.main === module) main();
