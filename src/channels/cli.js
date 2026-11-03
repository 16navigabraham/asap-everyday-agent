"use strict";

const readline = require("node:readline/promises");

const config = require("../config");
const notify = require("../notify");
const { handleMessage } = require("../conversations");

/** Chat with the agent in a terminal. */

async function main() {
  if (!config.muse.apiKey) {
    console.error("Set META_API_KEY in .env first.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  notify.register("cli", (_userId, text) => console.log(`\n[update] ${text}\n`));

  console.log(`ASAP sandbox on Meta Muse Spark (${config.muse.model}). Type /quit to exit.\n`);

  for (;;) {
    const text = (await rl.question("you › ")).trim();
    if (!text) continue;
    if (text === "/quit") break;
    const { reply, attachments } = await handleMessage("cli:local", text);
    console.log(`asap › ${reply}`);
    for (const a of attachments) console.log(`       [photo] ${a.caption}: http://localhost:${config.port}${a.url} (needs npm start)`);
    console.log();
  }
  rl.close();
}

if (require.main === module) main();
