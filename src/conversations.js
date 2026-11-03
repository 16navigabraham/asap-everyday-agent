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

const isPlainUserMessage = (message) =>
  message.role === "user" &&
  (typeof message.content === "string" || !message.content.some((block) => block.type === "tool_result"));

/**
 * Drop old messages, but only ever cut just before a plain user message, so
 * no tool_use is ever separated from its tool_result.
 */
function trim(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  for (let i = messages.length - MAX_MESSAGES; i < messages.length; i += 1) {
    if (isPlainUserMessage(messages[i])) return messages.slice(i);
  }
  return messages.slice(-2);
}

/**
 * A photo is read once, in the turn it was sent. History keeps a note of it
 * instead of the image bytes, so memory and every later request stay small.
 */
function withoutImages(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) return message;
  if (!message.content.some((block) => block.type === "image")) return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "image" ? { type: "text", text: "[The user sent a photo here, already read in that turn.]" } : block,
    ),
  };
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
function handleMessage(userId, content, { call } = {}) {
  return withLock(userId, async () => {
    const history = histories.get(userId) || [];
    try {
      const result = await runTurn({ history, userContent: content, userId, call });
      histories.set(userId, trim([...history, ...result.added.map(withoutImages)]));
      return { reply: result.reply, attachments: result.attachments, model: result.model };
    } catch (error) {
      // History is left as it was. Anything a tool did is still visible to the
      // next turn through transaction_history, which reads live state.
      logger.error("Turn failed", { channel: userId.split(":")[0], error: error.message, status: error.status });
      return { reply: FAILED_REPLY, attachments: [], model: null, error: true };
    }
  });
}

function reset() {
  histories.clear();
  locks.clear();
}

module.exports = { handleMessage, trim, reset, FAILED_REPLY };
