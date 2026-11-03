"use strict";

const config = require("../config");
const { getProvider } = require("./providers");

/**
 * The live model switch. Read on every model call, so flipping it takes
 * effect on the very next message, no restart.
 */

let active = getProvider(config.models.defaultProvider) ? config.models.defaultProvider : "muse";

function current() {
  return active;
}

function set(id) {
  const provider = getProvider(id);
  if (!provider) return { ok: false, reason: "unknown_provider" };
  if (!provider.isConfigured()) return { ok: false, reason: "not_configured" };
  active = id;
  return { ok: true, provider: id };
}

module.exports = { current, set };
