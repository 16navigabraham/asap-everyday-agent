"use strict";

const logger = require("./log");
const { runTurn } = require("./agent/turn");

/**
 * Conversation history per user, in memory, with one turn at a time per user.
 *
 * The lock matters for money: two messages sent in quick succession must not
 * both read the same history and both act on the same quote.
 */

const MAX_MESSAGES = 40;
const FAILED_REPLY = "Something went wrong on my side and nothing was done. Please try again in a moment.";

const histories = new Map();
const locks = new Map();

/**
 * Drop old messages, but only ever cut just before a plain user message, so
 * no tool_use is ever separated from its tool_result.
 */
function trim(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  for (let i = messages.length - MAX_MESSAGES; i < messages.length; i += 1) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") return messages.slice(i);
  }
  return messages.slice(-2);
}

function withLock(userId, fn) {
  const previous = locks.get(userId) || Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(userId, tail);
  tail.then(() => {
    if (locks.get(userId) === tail) locks.delete(userId);
  });
  return next;
}

/** Handle one inbound message. Never throws: a failed turn still gets a reply. */
function handleMessage(userId, text, { call } = {}) {
  return withLock(userId, async () => {
    const history = histories.get(userId) || [];
    try {
      const result = await runTurn({ history, userText: text, userId, call });
      histories.set(userId, trim([...history, ...result.added]));
      return { reply: result.reply, providers: result.providers, failedOver: result.failedOver };
    } catch (error) {
      // History is left as it was. Anything a tool did is still visible to the
      // next turn through recent_activity, which reads live state.
      logger.error("Turn failed", { channel: userId.split(":")[0], error: error.message, status: error.status });
      return { reply: FAILED_REPLY, providers: [], failedOver: false, error: true };
    }
  });
}

function reset() {
  histories.clear();
  locks.clear();
}

module.exports = { handleMessage, trim, reset, FAILED_REPLY };
