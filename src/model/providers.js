"use strict";

const config = require("../config");

/**
 * Model providers. Both speak the Messages API wire format: Meta's Model API
 * accepts the same request and response shape as Anthropic's, so a provider
 * here is a base URL, an auth header, and whatever request options that model
 * needs. No SDK, just fetch.
 */

const ANTHROPIC_VERSION = "2023-06-01";

const PROVIDERS = {
  muse: {
    id: "muse",
    label: "Meta Muse Spark",
    settings: () => config.models.muse,
    isConfigured: () => Boolean(config.models.muse.apiKey),
    headers: (s) => ({
      authorization: `Bearer ${s.apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
    }),
    // Muse Spark reasons on every call. Unbounded, it can spend the whole
    // max_tokens budget thinking and return no text, so depth is pinned.
    // No cache_control: the TTL form is rejected on Meta's endpoint.
    shape: (body, s) => ({
      ...body,
      thinking: { type: "adaptive" },
      output_config: { effort: s.effort },
    }),
  },

  claude: {
    id: "claude",
    label: "Anthropic Claude",
    settings: () => config.models.claude,
    isConfigured: () => Boolean(config.models.claude.apiKey),
    headers: (s) => ({
      "x-api-key": s.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    }),
    shape: (body) => body,
  },
};

function getProvider(id) {
  return PROVIDERS[id] || null;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    model: p.settings().model,
    configured: p.isConfigured(),
  }));
}

module.exports = { PROVIDERS, getProvider, listProviders };
