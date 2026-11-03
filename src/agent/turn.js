"use strict";

const crypto = require("node:crypto");

const logger = require("../log");
const { SYSTEM_PROMPT } = require("./prompt");
const { definitions } = require("./tools");
const { executeTools } = require("./executor");
const { complete } = require("../model/client");

/**
 * One user message in, one reply out, with as many model <-> tool round trips
 * in between as the errand needs (capped).
 *
 * Returns the new messages to append to the conversation, so history keeps
 * every tool call and result rather than just the final text. Assistant
 * messages are tagged with the provider that wrote them.
 */

const MAX_STEPS = 6;
const EMPTY_REPLY = "Sorry, I didn't catch that. Could you say it another way?";
const STUCK_REPLY = "Sorry, I'm struggling to finish that one. Please try again in a moment.";

const textOf = (response) =>
  (response.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

async function runTurn({ history, userText, userId, call = complete }) {
  const ctx = { userId, turnId: crypto.randomUUID() };
  const added = [{ role: "user", content: userText }];
  const working = [...history, ...added];
  const providers = new Set();
  let failedOver = false;
  let toolsRan = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const { response, provider, failedOver: switched } = await call({
      system: SYSTEM_PROMPT,
      tools: definitions(),
      messages: [...working],
      allowFailover: !toolsRan,
    });
    providers.add(provider);
    failedOver ||= Boolean(switched);

    const assistant = { role: "assistant", content: response.content || [], by: provider };
    working.push(assistant);
    added.push(assistant);

    const meta = { providers: [...providers], failedOver };

    if (response.stop_reason === "refusal") {
      return { reply: textOf(response) || "Sorry, I can't help with that one.", added, ...meta };
    }

    const calls = (response.content || []).filter((block) => block.type === "tool_use");
    if (calls.length === 0) {
      return { reply: textOf(response) || EMPTY_REPLY, added, ...meta };
    }

    toolsRan = true;
    const results = await executeTools(calls, ctx);
    const toolMessage = { role: "user", content: results };
    working.push(toolMessage);
    added.push(toolMessage);

    const ask = calls.find((c) => c.name === "ask_user");
    const askResult = ask && results.find((r) => r.tool_use_id === ask.id);
    if (askResult && !askResult.is_error && calls.length === 1) {
      added.push(closing(ask.input.question, provider));
      return { reply: ask.input.question, added, ...meta };
    }
  }

  logger.warn("Turn hit the step cap", { channel: ctx.userId.split(":")[0] });
  added.push(closing(STUCK_REPLY, [...providers].pop()));
  return { reply: STUCK_REPLY, added, providers: [...providers], failedOver };
}

// A turn that stops on a tool result still has to end on an assistant
// message, or the next user message breaks user/assistant alternation.
function closing(text, provider) {
  return { role: "assistant", content: [{ type: "text", text }], by: provider };
}

module.exports = { runTurn, MAX_STEPS, EMPTY_REPLY, STUCK_REPLY };
