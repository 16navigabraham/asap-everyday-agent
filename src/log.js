"use strict";

// JSON lines to stdout. Callers pass ids and outcomes, never message text,
// phone numbers or meter numbers.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function threshold() {
  if (LEVELS[process.env.LOG_LEVEL]) return LEVELS[process.env.LOG_LEVEL];
  return process.env.NODE_TEST_CONTEXT ? LEVELS.error + 1 : LEVELS.info;
}

function write(level, message, fields = {}) {
  if (LEVELS[level] < threshold()) return;
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...fields })}\n`);
}

module.exports = {
  debug: (m, f) => write("debug", m, f),
  info: (m, f) => write("info", m, f),
  warn: (m, f) => write("warn", m, f),
  error: (m, f) => write("error", m, f),
};
