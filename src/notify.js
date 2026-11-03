"use strict";

const logger = require("./log");

/**
 * Out-of-turn messages to a user, e.g. "your airtime has landed".
 *
 * User ids are "<channel>:<id>". Each channel registers a sender for its own
 * prefix, so the order worker never needs to know which channel a user is on.
 */

const senders = new Map();

function register(channel, send) {
  senders.set(channel, send);
}

async function notify(userId, text) {
  const channel = String(userId).split(":")[0];
  const send = senders.get(channel);
  if (!send) return;
  try {
    await send(userId, text);
  } catch (error) {
    logger.warn("Notification failed", { channel, error: error.message });
  }
}

module.exports = { register, notify };
