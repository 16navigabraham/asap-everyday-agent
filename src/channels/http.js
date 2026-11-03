"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const config = require("../config");
const logger = require("../log");
const notify = require("../notify");
const modelSwitch = require("../model/switch");
const { listProviders, getProvider } = require("../model/providers");
const { handleMessage } = require("../conversations");

/**
 * The web channel: a chat page, a JSON chat endpoint, a poll endpoint for
 * delivery notifications, and the model switch.
 */

const PAGE = path.join(__dirname, "..", "..", "public", "index.html");
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 1000;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;

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
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > LIMIT;
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
    req.on("end", () => {
      if (overflow) return reject(tooLarge());
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("bad_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isAdmin(req) {
  if (!config.adminToken) return false;
  const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(config.adminToken);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function modelsView() {
  return { active: modelSwitch.current(), providers: listProviders(), switchable: Boolean(config.adminToken) };
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const client = req.socket.remoteAddress || "unknown";

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, fs.readFileSync(PAGE), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(req);
    const sessionId = String(body.sessionId || "");
    const text = String(body.text || "").trim();
    if (!SESSION.test(sessionId)) return send(res, 400, { error: "bad_session" });
    if (!text || text.length > MAX_TEXT_CHARS) return send(res, 400, { error: "bad_text" });
    if (rateLimited(client)) return send(res, 429, { error: "slow_down" });

    const result = await handleMessage(`web:${sessionId}`, text);
    const answeredBy = result.providers.map((id) => getProvider(id)?.label).filter(Boolean);
    return send(res, 200, { reply: result.reply, answeredBy, failedOver: result.failedOver });
  }

  if (req.method === "GET" && url.pathname === "/api/updates") {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!SESSION.test(sessionId)) return send(res, 400, { error: "bad_session" });
    const updates = inbox.get(sessionId) || [];
    inbox.delete(sessionId);
    return send(res, 200, { updates });
  }

  if (url.pathname === "/api/models") {
    if (req.method === "GET") return send(res, 200, modelsView());
    if (req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "admin_token_required" });
      const body = await readJson(req);
      const outcome = modelSwitch.set(String(body.provider || ""));
      if (!outcome.ok) return send(res, 400, { error: outcome.reason });
      logger.info("Model switched", { provider: outcome.provider });
      return send(res, 200, modelsView());
    }
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

module.exports = { start, route };
