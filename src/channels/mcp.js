"use strict";

const crypto = require("node:crypto");

const notify = require("../notify");
const { TOOLS } = require("../agent/tools");
const { executeTools } = require("../agent/executor");

/**
 * ASAP as an MCP server, so a person's own AI assistant (Claude, ChatGPT,
 * any MCP client) can run ASAP errands for them.
 *
 * Streamable HTTP transport, JSON responses: POST /mcp with one JSON-RPC
 * message. `initialize` opens a session (Mcp-Session-Id header), which
 * identifies the test wallet; a Bearer token, when sent, identifies it
 * instead, so the same wallet survives reconnects.
 *
 * The tools are the agent's own tools, run through the same executor and
 * the same order rules. Purchase tools still only quote, and confirming is
 * a separate call marked destructive, so the assistant's host asks the
 * person before money moves.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Inside ASAP's own chat these make sense; over MCP the assistant asks its
// user directly and shows images its own way.
const HIDDEN = new Set(["ask_user", "send_listing_photo"]);

const READ_ONLY = new Set([
  "check_balance", "transaction_history", "show_account", "saved_details",
  "list_plans", "lookup_customer", "find_listings", "request_service", "get_updates",
]);
const DESTRUCTIVE = new Set(["confirm_purchase", "confirm_share", "cancel_ride"]);

const INSTRUCTIONS =
  "ASAP runs everyday errands in Nigeria from a prepaid wallet: airtime, data, electricity, TV, food from local " +
  "merchants, rides, flights and sending credit. Tools that cost money only return a quote. Always show the user " +
  "the quote's summary and total and get their explicit yes before calling confirm_purchase (or confirm_share). " +
  "For electricity and TV, call lookup_customer first and have the user confirm the account name. Never guess a " +
  "phone, meter or smartcard number, a network or an amount: ask the user. Call get_updates to see deliveries, " +
  "refunds and driver details after confirming. This server runs in test mode with test credit.";

const sessions = new Map();
const inbox = new Map();
const SESSION_TTL_MS = 24 * 60 * 60_000;

notify.register("mcp", (userId, text) => {
  const queue = inbox.get(userId) || [];
  queue.push({ text, at: new Date().toISOString() });
  inbox.set(userId, queue.slice(-20));
});

const getUpdates = {
  name: "get_updates",
  kind: "read",
  definition: {
    name: "get_updates",
    description:
      "Deliveries, refunds, driver details and deposits that have arrived since the last call. Check this after " +
      "confirming something, before telling the user it is done.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  check: () => null,
  handler: (_input, ctx) => {
    const updates = inbox.get(ctx.userId) || [];
    inbox.delete(ctx.userId);
    return { ok: true, updates };
  },
};

const EXPOSED = [...TOOLS.filter((tool) => !HIDDEN.has(tool.name)), getUpdates];
const BY_NAME = new Map(EXPOSED.map((tool) => [tool.name, tool]));

const title = (name) => name.split("_").map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

function listTools() {
  return EXPOSED.map((tool) => ({
    name: tool.name,
    title: title(tool.name),
    description: tool.definition.description,
    inputSchema: tool.definition.input_schema,
    annotations: {
      readOnlyHint: READ_ONLY.has(tool.name),
      destructiveHint: DESTRUCTIVE.has(tool.name),
      idempotentHint: READ_ONLY.has(tool.name),
      openWorldHint: false,
    },
  }));
}

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const respond = (status, body, headers = {}) => ({ status, body, headers });

function bearerIdentity(headers) {
  const token = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (token.length < 16) return null;
  return `mcp:k-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

function sessionFor(headers) {
  const id = headers["mcp-session-id"];
  const session = id && sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

async function callTool(params, userId) {
  const tool = BY_NAME.get(params?.name);
  if (!tool) return null;

  const ctx = { userId, turnId: crypto.randomUUID(), attachments: [] };
  const block = { type: "tool_use", id: "mcp-call", name: tool.name, input: params.arguments || {} };
  const [result] = await executeTools([block], ctx, { lookup: (name) => BY_NAME.get(name) || null });
  const payload = JSON.parse(result.content);

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: Boolean(result.is_error),
  };
}

/**
 * Handle one POST /mcp body. Returns { status, headers, body }, where a
 * null body means "202 Accepted, nothing to say" (notifications).
 */
async function handle(message, headers) {
  if (Array.isArray(message)) return respond(400, failure(null, -32600, "Batches are not supported"));
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return respond(400, failure(message?.id, -32600, "Invalid JSON-RPC request"));
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  if (method === "initialize") {
    const sessionId = crypto.randomUUID();
    const userId = bearerIdentity(headers) || `mcp:s-${sessionId}`;
    sessions.set(sessionId, { userId, lastSeen: Date.now() });
    const asked = params?.protocolVersion;
    return respond(
      200,
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "asap", title: "ASAP", version: "2.0.0" },
        instructions: INSTRUCTIONS,
      }),
      { "mcp-session-id": sessionId },
    );
  }

  if (isNotification) return respond(202, null);
  if (method === "ping") return respond(200, reply(id, {}));

  const session = sessionFor(headers);
  if (!session) return respond(404, failure(id, -32001, "Unknown or expired session: initialize again"));

  if (method === "tools/list") return respond(200, reply(id, { tools: listTools() }));

  if (method === "tools/call") {
    const result = await callTool(params, session.userId);
    if (!result) return respond(200, failure(id, -32602, `Unknown tool: ${params?.name}`));
    return respond(200, reply(id, result));
  }

  return respond(200, failure(id, -32601, `Method not found: ${method}`));
}

function endSession(headers) {
  return sessions.delete(headers["mcp-session-id"]);
}

function reset() {
  sessions.clear();
  inbox.clear();
}

module.exports = { handle, endSession, listTools, reset, INSTRUCTIONS };
