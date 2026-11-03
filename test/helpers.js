"use strict";

// Must run before anything requires src/config.js.
process.env.SANDBOX_LATENCY_MS = "0";
process.env.META_API_KEY ||= "test-meta-key";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.ADMIN_TOKEN ||= "test-admin";

const ledger = require("../src/wallet/ledger");
const store = require("../src/orders/store");
const conversations = require("../src/conversations");

function resetAll() {
  ledger.reset();
  store.reset();
  conversations.reset();
}

const toolUse = (name, input, id = `tu_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (value) => ({ type: "text", text: value });

/**
 * A scripted model. Each step is a function of the messages it was sent and
 * returns content blocks; stop_reason is derived from whether a tool was used.
 */
function scriptedModel(steps, provider = "muse") {
  const seen = [];
  let index = 0;
  const call = async ({ messages }) => {
    seen.push(messages);
    const step = steps[index++];
    if (!step) throw new Error(`Scripted model ran out of steps at call ${index}`);
    const content = step(messages);
    const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    return { response: { content, stop_reason }, provider, failedOver: false };
  };
  call.seen = seen;
  return call;
}

/** The parsed payload of the last tool_result in a message list. */
function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content;
    if (Array.isArray(content)) {
      const block = [...content].reverse().find((b) => b.type === "tool_result");
      if (block) return { ...JSON.parse(block.content), is_error: Boolean(block.is_error) };
    }
  }
  return null;
}

module.exports = { resetAll, toolUse, text, scriptedModel, lastToolResult };
