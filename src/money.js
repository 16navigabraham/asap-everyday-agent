"use strict";

/** Kobo in, "₦2,500" out. Amounts are kept in integer kobo everywhere else. */
function naira(kobo) {
  const value = Math.round(Number(kobo) || 0) / 100;
  return `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

module.exports = { naira };
