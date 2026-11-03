"use strict";

const crypto = require("node:crypto");

/**
 * What ASAP remembers about a user between messages: what to call them,
 * roughly where they are, numbers they've used before, an open basket, and
 * the last set of options they were shown. In memory.
 */

const profiles = new Map();

function get(userId) {
  let profile = profiles.get(userId);
  if (!profile) {
    const seed = crypto.createHash("sha256").update(userId).digest();
    profile = {
      name: null,
      area: null,
      accountNumber: `90${String(seed.readUInt32BE(0)).padStart(10, "0").slice(-8)}`,
      inviteCode: seed.toString("hex").slice(0, 6).toUpperCase(),
      referrals: 0,
      saved: [],
      nextSavedId: 1,
      basket: null,
      options: null,
    };
    profiles.set(userId, profile);
  }
  return profile;
}

const mask = (value) => (value.length > 4 ? `${"•".repeat(Math.min(4, value.length - 4))}${value.slice(-4)}` : value);

/** Remember a number after a successful purchase. Same kind + value is updated, not duplicated. */
function remember(userId, { kind, value, provider }) {
  const profile = get(userId);
  let entry = profile.saved.find((s) => s.kind === kind && s.value === value);
  if (!entry) {
    entry = { id: profile.nextSavedId++, kind, value, provider, label: null };
    profile.saved.push(entry);
  }
  entry.provider = provider || entry.provider;
  entry.lastUsed = new Date().toISOString();
  return entry;
}

/** Masked, for showing back to the user. The real value never goes to the model. */
function listSaved(userId, kind) {
  return get(userId)
    .saved.filter((s) => !kind || s.kind === kind)
    .map((s) => ({ id: s.id, kind: s.kind, label: s.label, value: mask(s.value), provider: s.provider }));
}

function resolveSaved(userId, savedId, kind) {
  const entry = get(userId).saved.find((s) => s.id === savedId);
  if (!entry) return { ok: false, reason: "unknown_saved_id", message: "No saved entry with that id. Call saved_details." };
  if (kind && entry.kind !== kind) return { ok: false, reason: "wrong_kind", message: `That saved entry is a ${entry.kind}, not a ${kind}.` };
  return { ok: true, value: entry.value, provider: entry.provider };
}

function labelSaved(userId, savedId, label) {
  const entry = get(userId).saved.find((s) => s.id === savedId);
  if (!entry) return false;
  entry.label = label;
  return true;
}

function forgetSaved(userId, savedId) {
  const profile = get(userId);
  const before = profile.saved.length;
  profile.saved = profile.saved.filter((s) => s.id !== savedId);
  return profile.saved.length < before;
}

function reset() {
  profiles.clear();
}

module.exports = { get, remember, listSaved, resolveSaved, labelSaved, forgetSaved, reset };
