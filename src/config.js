"use strict";

const env = process.env;

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== "" && value !== undefined ? parsed : fallback;
}

module.exports = {
  port: number(env.PORT, 3000),

  muse: {
    apiKey: env.META_API_KEY || null,
    model: env.META_MODEL || "muse-spark-1.1",
    baseUrl: env.META_BASE_URL || "https://api.meta.ai",
    // Muse Spark always reasons; "low" leaves room in the budget for an actual reply.
    effort: env.META_REASONING_EFFORT || "low",
    maxTokens: number(env.META_MAX_TOKENS, 2048),
    timeoutMs: number(env.META_TIMEOUT_MS, 45_000),
  },

  telegramToken: env.TELEGRAM_BOT_TOKEN || null,

  wallet: {
    // Sandbox credit every new chat starts with. 1000000 kobo = NGN 10,000.
    starterKobo: number(env.STARTER_BALANCE_KOBO, 1_000_000),
  },

  sandbox: {
    quoteTtlMs: number(env.QUOTE_TTL_MINUTES, 10) * 60_000,
    // Simulated provider latency, so the async delivery path is visible in a demo.
    latencyMs: number(env.SANDBOX_LATENCY_MS, 1500),
    // How long a sandbox ride takes from driver assigned to drop-off.
    rideMs: number(env.SANDBOX_RIDE_SECONDS, 90) * 1000,
  },
};
