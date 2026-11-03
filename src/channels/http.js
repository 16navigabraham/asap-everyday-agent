"use strict";

const http = require("node:http");

const config = require("../config");
const logger = require("../log");
const notify = require("../notify");
const sandbox = require("../fulfilment/sandbox");
const whatsapp = require("./whatsapp");
const mcp = require("./mcp");
const { handleMessage } = require("../conversations");

/**
 * The HTTP API: a chat endpoint (text and optional photo), a poll endpoint
 * for delivery notifications, and listing photos. Any client can sit on top:
 * a mobile app, a WhatsApp bridge, curl.
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 1000;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const inbox = new Map();
notify.register("web", (userId, text) => {
  const session = userId.slice("web:".length);
  const queue = inbox.get(session) || [];
  queue.push({ text, at: new Date().toISOString() });
  inbox.set(session, queue.slice(-20));
});

// 20 messages a minute per client address, so a public demo cannot be used
// to burn model credit in a loop.
const WINDOW_MS = 60_000;
const LIMIT = 20;
// An assistant makes several tool calls for one request, so MCP gets more room.
const MCP_LIMIT = 120;
const hits = new Map();
function rateLimited(key, limit = LIMIT) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > limit;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readJson(req) {
  return readBody(req).then((raw) => {
    try {
      return JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      throw Object.assign(new Error("bad_json"), { status: 400 });
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error("too_large"), { status: 413 });
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      reject(tooLarge());
      return;
    }

    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) overflow = true;
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => (overflow ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/** Text, or a photo block followed by the caption, as Muse Spark reads them. */
function userContent(text, image) {
  if (!image) return text;
  const blocks = [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }];
  blocks.push({ type: "text", text: text || "(The user sent this photo without a caption.)" });
  return blocks;
}

function checkImage(image) {
  if (image === undefined || image === null) return null;
  if (typeof image !== "object" || !IMAGE_TYPES.has(image.mediaType) || typeof image.data !== "string") return "bad_image";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return "bad_image";
  if ((image.data.length * 3) / 4 > MAX_IMAGE_BYTES) return "image_too_large";
  return null;
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const client = req.socket.remoteAddress || "unknown";

  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api/info")) {
    return send(res, 200, {
      service: "asap-everyday-agent",
      model: "Meta Muse Spark",
      modelId: config.muse.model,
      configured: Boolean(config.muse.apiKey),
      channels: {
        api: true,
        mcp: true,
        whatsapp: whatsapp.isConfigured(),
        telegram: Boolean(config.telegramToken),
      },
      endpoints: {
        "POST /api/chat": "{ sessionId, text, image?: { mediaType, data(base64) } } -> { reply, attachments }",
        "GET /api/updates?sessionId=": "delivery notifications since the last poll",
        "POST /mcp": "MCP server (Streamable HTTP) for Claude, ChatGPT and other AI assistants",
        "GET|POST /whatsapp/webhook": "WhatsApp Cloud API webhook",
        "GET /media/listing/:id.svg": "listing photo",
      },
    });
  }

  if (url.pathname === "/whatsapp/webhook") {
    if (!whatsapp.isConfigured()) return send(res, 404, { error: "whatsapp_not_configured" });
    if (req.method === "GET") {
      const [status, body] = whatsapp.verify(url);
      return send(res, status, body, "text/plain; charset=utf-8");
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      const { status } = whatsapp.receive(raw, req.headers);
      return send(res, status, { ok: status === 200 });
    }
  }

  if (url.pathname === "/mcp") {
    if (req.method === "GET") return send(res, 405, { error: "no_server_stream" });
    if (req.method === "DELETE") {
      mcp.endSession(req.headers);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST") {
      if (rateLimited(`mcp:${client}`, MCP_LIMIT)) return send(res, 429, { error: "slow_down" });
      const result = await mcp.handle(await readJson(req), req.headers);
      if (result.body === null) {
        res.writeHead(202, result.headers);
        return res.end();
      }
      res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...result.headers });
      return res.end(JSON.stringify(result.body));
    }
  }

  const photo = url.pathname.match(/^\/media\/listing\/(\d+)\.svg$/);
  if (req.method === "GET" && photo) {
    const listing = sandbox.getListing(Number(photo[1]));
    if (!listing) return send(res, 404, { error: "not_found" });
    return send(res, 200, sandbox.listingPhotoSvg(listing), "image/svg+xml; charset=utf-8");
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(req);
    const sessionId = String(body.sessionId || "");
    const text = String(body.text || "").trim();
    if (!SESSION.test(sessionId)) return send(res, 400, { error: "bad_session" });
    if (text.length > MAX_TEXT_CHARS || (!text && !body.image)) return send(res, 400, { error: "bad_text" });
    const imageProblem = checkImage(body.image);
    if (imageProblem) return send(res, 400, { error: imageProblem });
    if (rateLimited(client)) return send(res, 429, { error: "slow_down" });

    const result = await handleMessage(`web:${sessionId}`, userContent(text, body.image));
    return send(res, 200, { reply: result.reply, attachments: result.attachments, model: result.model });
  }

  if (req.method === "GET" && url.pathname === "/api/updates") {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!SESSION.test(sessionId)) return send(res, 400, { error: "bad_session" });
    const updates = inbox.get(sessionId) || [];
    inbox.delete(sessionId);
    return send(res, 200, { updates });
  }

  return send(res, 404, { error: "not_found" });
}

function start(port = config.port) {
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      logger.error("HTTP handler failed", { error: error.message });
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "server_error" });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { start, route, userContent };
