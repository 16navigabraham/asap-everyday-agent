"use strict";

const crypto = require("node:crypto");

const logger = require("../log");
const { SYSTEM_PROMPT } = require("./prompt");
const { definitions } = require("./tools");
const { executeTools } = require("./executor");
const muse = require("../model/muse");

/**
 * One user message in, one reply out, with as many Muse Spark <-> tool round
 * trips in between as the errand needs (capped).
 *
 * `userContent` is a string, or content blocks when the user sent a photo
 * (a bill, a meter, a receipt) for Muse Spark to read directly.
 *
 * Returns the new messages to append to the conversation, so history keeps
 * every tool call and result, not only the final text, plus anything a tool
 * attached for the channel to show (listing photos).
 */

const MAX_STEPS = 8;
const EMPTY_REPLY = "Sorry, I didn't catch that. Could you say it another way?";
const STUCK_REPLY = "Sorry, I'm struggling to finish that one. Please try again in a moment.";

const textOf = (response) =>
  (response.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

const closing = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

function systemPrompt() {
  const d = today();
  return `${SYSTEM_PROMPT}\n\nToday is ${d.weekday}, ${d.year}-${d.month}-${d.day} (Lagos time).`;
}

async function runTurn({ history, userContent, userId, call = muse.complete }) {
  const ctx = { userId, turnId: crypto.randomUUID(), attachments: [] };
  const added = [{ role: "user", content: userContent }];
  const working = [...history, ...added];
  const done = (reply, model) => ({ reply, added, attachments: ctx.attachments, model });
  let model = null;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await call({ system: systemPrompt(), tools: definitions(), messages: [...working] });
    const response = result.response;
    model = result.model || model;

    const assistant = { role: "assistant", content: response.content || [] };
    working.push(assistant);
    added.push(assistant);

    if (response.stop_reason === "refusal") return done(textOf(response) || "Sorry, I can't help with that one.", model);

    const calls = (response.content || []).filter((block) => block.type === "tool_use");
    if (calls.length === 0) return done(textOf(response) || EMPTY_REPLY, model);

    const results = await executeTools(calls, ctx);
    const toolMessage = { role: "user", content: results };
    working.push(toolMessage);
    added.push(toolMessage);

    // ask_user is the model saying it needs one thing before it can act: its
    // question is the reply. The turn still ends on an assistant message so
    // the next user message keeps user/assistant alternation.
    const ask = calls.find((c) => c.name === "ask_user");
    const askResult = ask && results.find((r) => r.tool_use_id === ask.id);
    if (askResult && !askResult.is_error && calls.length === 1) {
      added.push(closing(ask.input.question));
      return done(ask.input.question, model);
    }
  }

  logger.warn("Turn hit the step cap", { channel: userId.split(":")[0] });
  added.push(closing(STUCK_REPLY));
  return done(STUCK_REPLY, model);
}

module.exports = { runTurn, MAX_STEPS, EMPTY_REPLY, STUCK_REPLY };
