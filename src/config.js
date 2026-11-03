"use strict";

const env = process.env;

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== "" && value !== undefined ? parsed : fallback;
}

module.exports = {
  port: number(env.PORT, 3000),

  models: {
    // Which provider answers by default. Switchable at runtime, see src/model/switch.js.
    defaultProvider: env.MODEL_PROVIDER || "muse",
    // Retry a failed call once on the other provider, when it is configured.
    failover: env.MODEL_FAILOVER !== "false",
    timeoutMs: number(env.MODEL_TIMEOUT_MS, 45_000),
    maxTokens: number(env.MODEL_MAX_TOKENS, 2048),

    muse: {
      apiKey: env.META_API_KEY || null,
      model: env.META_MODEL || "muse-spark-1.1",
      baseUrl: env.META_BASE_URL || "https://api.meta.ai",
      // Muse Spark always reasons; "low" leaves room in the budget for an actual reply.
      effort: env.META_REASONING_EFFORT || "low",
    },

    claude: {
      apiKey: env.ANTHROPIC_API_KEY || null,
      model: env.CLAUDE_MODEL || "claude-sonnet-5",
      baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    },
  },

  // Required to flip the model switch over HTTP. Unset means the switch is read-only.
  adminToken: env.ADMIN_TOKEN || null,

  telegramToken: env.TELEGRAM_BOT_TOKEN || null,

  wallet: {
    // Sandbox credit every new chat starts with. 500000 kobo = NGN 5,000.
    starterKobo: number(env.STARTER_BALANCE_KOBO, 500_000),
  },

  orders: {
    quoteTtlMs: number(env.QUOTE_TTL_MINUTES, 10) * 60_000,
    // Simulated fulfilment latency, so the async delivery path is visible in a demo.
    sandboxLatencyMs: number(env.SANDBOX_LATENCY_MS, 1500),
  },
};
