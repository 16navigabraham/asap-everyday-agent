"use strict";

const { spawn } = require("node:child_process");

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
 * A voice note to text, by **Muse Voice Transcribe**, not Muse Spark.
 *
 * Muse Spark's `/v1/messages` endpoint has no audio content block at all
 * (text, image, video, document only, confirmed against Meta's own docs) --
 * an earlier version of this guessed two shapes and both came back 400 on
 * every real call. Audio transcription on Meta Model API is a separate,
 * dedicated model at a separate endpoint: `POST /v1/asr/transcribe`. It
 * requires mono 16-bit PCM WAV at 16 or 24 kHz; voice notes arrive as
 * OGG/Opus, so ffmpeg converts first -- the one thing in this repo that
 * isn't zero-install, see README.
 *
 * Separate from the agent's own turn, so the audio never enters
 * conversation history and the agent reasons over the user's words exactly
 * like typed text.
 */
const MUSE_ASR_MODEL = "muse-voice-transcribe-1.0";

/** Mono 16-bit PCM WAV at 24kHz -- the one container this endpoint accepts.
 * Piped through stdin/stdout: a voice note is a few seconds of audio,
 * nowhere near worth temp-file I/O and cleanup. */
function convertToWav(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "24000",
      "-c:a", "pcm_s16le",
      "-map_metadata", "-1",
      "-f", "wav",
      "pipe:1",
    ]);

    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stderr.on("data", (chunk) => { stderr += chunk; });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      resolve(Buffer.concat(chunks));
    });

    ff.stdin.on("error", () => {}); // ffmpeg can close stdin early on a bad/short input; the exit code is the real signal
    ff.stdin.end(Buffer.from(buffer));
  });
}

/**
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string}>}
 * `fetchImpl` and `convertImpl` are injectable for tests, matching
 * `complete`'s own `fetchImpl` convention above.
 */
async function transcribe(buffer, mimeType, { fetchImpl = fetch, convertImpl = convertToWav } = {}) {
  if (!config.muse.apiKey) return { ok: false, reason: "not_configured" };

  let wav;
  try {
    wav = await convertImpl(buffer);
  } catch (error) {
    logger.warn("Voice note WAV conversion failed", { error: error.message, mimeType });
    return { ok: false, reason: "conversion_failed" };
  }

  const form = new FormData();
  form.append(
    "request",
    new Blob(
      [JSON.stringify({
        mode: "PUSH_TO_TALK",
        model: MUSE_ASR_MODEL,
        audioEncoding: "WAV",
        // No languageBias: Muse Voice Transcribe's 25 supported languages
        // don't include Yoruba, Hausa, Igbo or Pidgin, so biasing toward
        // English would only hurt the audio this repo actually expects.
        // Auto-detect gives every supported language its real shot.
      })],
      { type: "application/json" },
    ),
  );
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "voice-note.wav");

  let res;
  try {
    res = await fetchImpl(`${config.muse.baseUrl}/v1/asr/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.muse.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.muse.timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: "unreachable" };
  }

  if (!res.ok) {
    logger.warn("Muse Voice Transcribe rejected the call", { status: res.status });
    return { ok: false, reason: res.status === 429 ? "rate_limited" : "provider_error" };
  }

  const body = await res.json();
  const text = String(body?.transcript || "").trim();
  return text ? { ok: true, text } : { ok: false, reason: "no_speech" };
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

module.exports = { complete, buildRequest, transcribe, voiceNoteContent, isRetryable, ModelError, convertToWav };
