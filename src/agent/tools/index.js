"use strict";

const TOOLS = [
  ...require("./account"),
  ...require("./bills"),
  ...require("./shop"),
  ...require("./rides"),
  ...require("./travel"),
  ...require("./orders"),
];

const byName = new Map();
for (const tool of TOOLS) {
  if (byName.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
  byName.set(tool.name, tool);
}

const definitions = () => TOOLS.map((tool) => tool.definition);
const getTool = (name) => byName.get(name) || null;

module.exports = { TOOLS, definitions, getTool };
