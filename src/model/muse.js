"use strict";

const config = require("../config");
const logger = require("../log");

/**
 * Meta Muse Spark, through the Meta Model API.
 *
 * Meta's API takes the Messages API wire format (system, tools, messages,
 * tool_use / tool_result blocks), so this is a single fetch, no SDK.
 */

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

/**
 * Kept literal on purpose: a summary or a translation of "send 2000 airtime"
 * that drops a zero is a wrong purchase with nothing in the logs to show it.
 * Verbatim keeps the speaker's own words, in their own language, and the
 * agent confirms anything about money before acting on it.
 */
const TRANSCRIBE_INSTRUCTION =
  "Transcribe this voice note verbatim. The speaker may use Yoruba, Hausa, Igbo, Nigerian Pidgin, English, or a mix. " +
  "Keep every word in the language it was spoken, with correct spelling and tone marks; do not translate. Write " +
  "numbers, amounts and phone numbers as digits. Output only the transcript, with no preamble, quotes or commentary. " +
  "If there is no intelligible speech, output nothing.";

function audioBlock(format, mediaType, data) {
  if (format === "input_audio") {
    return { type: "input_audio", input_audio: { data, format: mediaType.split("/")[1] } };
  }
  return { type: "audio", source: { type: "base64", media_type: mediaType, data } };
}

/**
 * A voice note to text, by Muse Spark. Separate from the agent's own turn,
 * so the audio never enters conversation history and the agent reasons over
 * the user's words exactly like typed text.
 *
 * Tries the configured audio block format; if Meta rejects it as a bad
 * request, tries the other once. Returns { ok, text } or { ok: false, reason }.
 */
async function transcribe(buffer, mimeType, { fetchImpl = fetch } = {}) {
  if (!config.muse.apiKey) return { ok: false, reason: "not_configured" };

  const mediaType = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const data = Buffer.from(buffer).toString("base64");
  const formats = config.muse.audioFormat === "input_audio" ? ["input_audio", "source"] : ["source", "input_audio"];

  for (const format of formats) {
    const body = {
      model: config.muse.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: [audioBlock(format, mediaType, data), { type: "text", text: TRANSCRIBE_INSTRUCTION }] }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    };
    try {
      const response = await callOnce(body, fetchImpl);
      const text = (response.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      return text ? { ok: true, text, format } : { ok: false, reason: "no_speech" };
    } catch (error) {
      if (error.status !== 400) return { ok: false, reason: "provider_error" };
      logger.warn("Muse Spark rejected this audio format", { format });
    }
  }
  return { ok: false, reason: "audio_not_accepted" };
}

/**
 * What the agent's turn receives for a voice note: the transcript, marked as
 * speech so the agent double-checks anything it might have mis-heard, or a
 * note that it couldn't be heard.
 */
async function voiceNoteContent(buffer, mimeType, options) {
  const result = await transcribe(buffer, mimeType, options);
  if (result.ok) return `[Voice note] ${result.text}`;
  logger.warn("Voice note not transcribed", { reason: result.reason });
  return (
    "[The user sent a voice note that could not be heard clearly. Apologise briefly, in the language they have been " +
    "using, and ask them to send it again or type it.]"
  );
}

module.exports = { complete, buildRequest, transcribe, voiceNoteContent, isRetryable, ModelError, TRANSCRIBE_INSTRUCTION };
