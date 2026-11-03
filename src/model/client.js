"use strict";

const config = require("../config");
const logger = require("../log");
const { getProvider } = require("./providers");
const modelSwitch = require("./switch");

class ModelError extends Error {
  constructor(message, { status = null, provider = null } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.provider = provider;
  }
}

/**
 * Worth retrying on the other provider: no response at all, a timeout, rate
 * limiting, an outage, or the account being out of credit (the two providers
 * bill separately, so the other one may well be fine). A 400 is never retried:
 * the request itself is wrong and will be wrong on both.
 */
function isRetryable(error) {
  const status = error?.status;
  if (status === null || status === undefined) return true;
  return status === 402 || status === 408 || status === 429 || status >= 500;
}

const THINKING = new Set(["thinking", "redacted_thinking"]);

/**
 * Messages as one provider should see them.
 *
 * Assistant turns are tagged with the provider that wrote them (`by`). A
 * thinking block is signed by the model that produced it and is rejected by
 * any other, so after a switch, foreign thinking blocks are dropped. The tag
 * itself never leaves this process.
 */
function messagesFor(providerId, messages) {
  return messages.map(({ by, ...message }) => {
    if (!by || by === providerId || !Array.isArray(message.content)) return message;
    const content = message.content.filter((block) => !THINKING.has(block.type));
    return { ...message, content: content.length ? content : [{ type: "text", text: "..." }] };
  });
}

async function callProvider(providerId, { system, tools, messages }, fetchImpl) {
  const provider = getProvider(providerId);
  if (!provider) throw new ModelError(`Unknown provider ${providerId}`, { status: 0, provider: providerId });
  if (!provider.isConfigured()) {
    throw new ModelError(`${provider.label} is not configured`, { status: 0, provider: providerId });
  }

  const settings = provider.settings();
  const body = provider.shape(
    {
      model: settings.model,
      max_tokens: config.models.maxTokens,
      system,
      tools,
      messages: messagesFor(providerId, messages),
    },
    settings,
  );

  let res;
  try {
    res = await fetchImpl(`${settings.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers(settings) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.models.timeoutMs),
    });
  } catch (error) {
    throw new ModelError(`${provider.label} unreachable: ${error.name}`, { provider: providerId });
  }

  if (!res.ok) {
    // Logged, never returned to the user or the model: provider error bodies
    // can carry request ids and account details.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    logger.warn("Model call rejected", { provider: providerId, status: res.status, detail });
    throw new ModelError(`${provider.label} returned ${res.status}`, { status: res.status, provider: providerId });
  }

  return res.json();
}

/**
 * One model call on the active provider, failing over once to the other.
 *
 * `allowFailover` is false once a turn has started running tools. Replaying
 * the rest of a tool loop on a different model is safe for money (charges
 * only happen through confirm_purchase, behind its own checks), but the
 * second model has not seen the first one's reasoning, so it is cleaner to
 * fail that turn honestly than to stitch two models' halves together.
 */
async function complete({ system, tools, messages, allowFailover = true, fetchImpl = fetch }) {
  const primary = modelSwitch.current();

  try {
    const response = await callProvider(primary, { system, tools, messages }, fetchImpl);
    return { response, provider: primary, failedOver: false };
  } catch (error) {
    const backup = primary === "muse" ? "claude" : "muse";
    const canFailover =
      config.models.failover && allowFailover && isRetryable(error) && getProvider(backup).isConfigured();

    if (!canFailover) throw error;

    logger.warn("Primary model failed, failing over", { from: primary, to: backup, status: error.status });
    const response = await callProvider(backup, { system, tools, messages }, fetchImpl);
    return { response, provider: backup, failedOver: true };
  }
}

module.exports = { complete, messagesFor, isRetryable, ModelError };
