"use strict";

// Must run before anything requires src/config.js.
process.env.SANDBOX_LATENCY_MS = "0";
process.env.STARTER_BALANCE_KOBO = "500000";
process.env.META_API_KEY ||= "test-meta-key";

const ledger = require("../src/wallet/ledger");
const store = require("../src/orders/store");
const profile = require("../src/users/profile");
const conversations = require("../src/conversations");

function resetAll() {
  ledger.reset();
  store.reset();
  profile.reset();
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
function scriptedModel(steps) {
  const seen = [];
  let index = 0;
  const call = async ({ messages }) => {
    seen.push(messages);
    const step = steps[index++];
    if (!step) throw new Error(`Scripted model ran out of steps at call ${index}`);
    const content = step(messages);
    const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    return { response: { content, stop_reason }, model: "muse-spark-1.1" };
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

/**
 * Run one tool in its own turn, as Muse Spark would call it, and return the
 * tool's result. Separate calls are separate turns, like separate messages.
 */
async function useTool(userId, name, input) {
  const { handleMessage } = conversations;
  let result;
  await handleMessage(userId, `(test) ${name}`, {
    call: scriptedModel([
      () => [toolUse(name, input)],
      (messages) => {
        result = lastToolResult(messages);
        return [text("ok")];
      },
    ]),
  });
  return result;
}

module.exports = { resetAll, toolUse, text, scriptedModel, lastToolResult, useTool };
