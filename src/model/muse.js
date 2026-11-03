"use strict";

const config = require("../config");
const logger = require("../log");

/**
 * Meta Muse Spark, through the Meta Model API.
 *
 * Meta's API takes the Messages API wire format (system, tools, messages,
 * tool_use / tool_result blocks), so this is a single fetch, no SDK.
 */

// Version header of the Messages wire format, which Meta's endpoint speaks.
const MESSAGES_API_VERSION = "2023-06-01";

class ModelError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ModelError";
    this.status = status;
  }
}

/** No response, timeout, rate limit or outage: worth one more try. A 4xx is not. */
function isRetryable(error) {
  const status = error?.status;
  return status === null || status === undefined || status === 408 || status === 429 || status >= 500;
}

function buildRequest({ system, tools, messages }) {
  return {
    model: config.muse.model,
    max_tokens: config.muse.maxTokens,
    system,
    tools,
    messages,
    // Muse Spark reasons on every call. Unbounded, it can spend the whole
    // max_tokens budget thinking and return no text, so depth is pinned.
    thinking: { type: "adaptive" },
    output_config: { effort: config.muse.effort },
  };
}

async function callOnce(body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${config.muse.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.muse.apiKey}`,
        "anthropic-version": MESSAGES_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.muse.timeoutMs),
    });
  } catch (error) {
    throw new ModelError(`Muse Spark unreachable: ${error.name}`);
  }

  if (!res.ok) {
    // Logged, never shown to the user or the model.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    logger.warn("Muse Spark rejected the call", { status: res.status, detail });
    throw new ModelError(`Muse Spark returned ${res.status}`, res.status);
  }
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Muse Spark call, retried once on a transient failure. A failed call
 * produced no tool calls, so retrying it can never repeat an action.
 */
async function complete({ system, tools, messages, fetchImpl = fetch, retryDelayMs = 700 }) {
  if (!config.muse.apiKey) throw new ModelError("META_API_KEY is not set", 0);

  const body = buildRequest({ system, tools, messages });
  try {
    return { response: await callOnce(body, fetchImpl), model: config.muse.model };
  } catch (error) {
    if (!isRetryable(error)) throw error;
    logger.warn("Muse Spark call failed, retrying once", { status: error.status });
    await sleep(retryDelayMs);
    return { response: await callOnce(body, fetchImpl), model: config.muse.model };
  }
}

module.exports = { complete, buildRequest, isRetryable, ModelError };
