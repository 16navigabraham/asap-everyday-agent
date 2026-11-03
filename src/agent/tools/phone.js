"use strict";

/** "0803 123 4567", "+2348031234567", "2348031234567" -> "08031234567", else null. */
function normalisePhone(raw) {
  const digits = String(raw || "").replace(/[\s()-]/g, "").replace(/^\+/, "");
  let local = digits;
  if (/^234\d{10}$/.test(digits)) local = `0${digits.slice(3)}`;
  return /^0[789][01]\d{8}$/.test(local) ? local : null;
}

module.exports = { normalisePhone };
