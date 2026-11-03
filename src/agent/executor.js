"use strict";

const logger = require("../log");
const { getTool } = require("./tools");

/**
 * Runs the tool calls from one model response, under four rules:
 *
 *  1. Unknown tools and bad arguments are answered, never thrown, so the
 *     model can correct itself.
 *  2. At most one money tool per turn. Two in one pass means the user never
 *     saw the second, and one misread message costs twice.
 *  3. A thrown handler never leaks its error text to the model. It gets a
 *     fixed, explicit instruction instead, so it cannot paraphrase a crash
 *     into "done!" or into a confident "it failed".
 *  4. Every call has a timeout, so a hung provider cannot hold a chat hostage.
 */

const TIMEOUT_MS = { read: 10_000, money: 20_000 };

const NOT_EXECUTED =
  "FAILED: this did not run. No money moved and nothing was sent. Do not say it worked. " +
  "Tell the user plainly it did not go through, and offer to try again.";

const UNKNOWN_RESULT =
  "FAILED: this check could not run, so you do not know the answer. Do not claim anything " +
  "happened or did not happen. Tell the user you cannot check right now and offer to try again shortly.";

const result = (id, payload, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content: JSON.stringify(payload),
  ...(isError ? { is_error: true } : {}),
});

function timeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function executeTools(calls, ctx, { lookup = getTool, timeouts = TIMEOUT_MS } = {}) {
  const results = [];
  let moneyUsed = false;

  for (const call of calls) {
    const tool = lookup(call.name);

    if (!tool) {
      results.push(result(call.id, { ok: false, reason: "unknown_tool" }, true));
      continue;
    }

    if (tool.kind === "money") {
      if (moneyUsed) {
        results.push(result(call.id, { ok: false, reason: "one_money_action_per_turn", message: NOT_EXECUTED }, true));
        continue;
      }
      moneyUsed = true;
    }

    const input = call.input || {};
    const complaint = tool.check(input);
    if (complaint) {
      results.push(result(call.id, { ok: false, reason: "invalid_arguments", message: complaint }, true));
      continue;
    }

    const started = Date.now();
    try {
      const payload = await timeout(Promise.resolve().then(() => tool.handler(input, ctx)), timeouts[tool.kind], tool.name);
      results.push(result(call.id, payload));
      logger.info("Tool ran", { tool: tool.name, ms: Date.now() - started, ok: payload?.ok !== false });
    } catch (error) {
      logger.error("Tool threw", { tool: tool.name, ms: Date.now() - started, error: error.message });
      results.push(
        result(call.id, { ok: false, reason: "tool_failed", message: tool.kind === "money" ? NOT_EXECUTED : UNKNOWN_RESULT }, true),
      );
    }
  }

  return results;
}

module.exports = { executeTools, NOT_EXECUTED, UNKNOWN_RESULT };
