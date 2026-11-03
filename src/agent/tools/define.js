"use strict";

/**
 * A tool is one object: what the model reads, the argument schema, extra
 * checks, and the handler. The registry derives both the API tool list and
 * the dispatch table from the same objects, so they cannot disagree.
 *
 * Arguments are validated here, in-process, before any handler runs. The
 * model's own schema adherence is treated as a hint, not a guarantee.
 */

const KINDS = new Set(["read", "money"]);
const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
};

function validateAgainst(schema, input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "arguments must be an object";

  for (const key of schema.required || []) {
    if (input[key] === undefined) return `"${key}" is required`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key];
    if (!property) return `"${key}" is not a known argument`;
    if (!TYPES[property.type](value)) return `"${key}" must be ${property.type === "integer" ? "a whole number" : `a ${property.type}`}`;
    if (property.enum && !property.enum.includes(value)) return `"${key}" must be one of ${property.enum.join(", ")}`;
  }
  return null;
}

function defineTool({ name, kind, description, properties = {}, required = [], validate, handler }) {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(name)) throw new Error(`Bad tool name: ${name}`);
  if (!KINDS.has(kind)) throw new Error(`${name}: kind must be read or money`);
  if (typeof handler !== "function") throw new Error(`${name}: missing handler`);
  for (const [key, property] of Object.entries(properties)) {
    if (!TYPES[property.type]) throw new Error(`${name}.${key}: unsupported type ${property.type}`);
  }
  for (const key of required) {
    if (!properties[key]) throw new Error(`${name}: requires undefined argument ${key}`);
  }

  const schema = { type: "object", properties, required, additionalProperties: false };

  return {
    name,
    kind,
    definition: { name, description, input_schema: schema },

    /** Returns a complaint string, or null when the arguments are acceptable. */
    check(input) {
      return validateAgainst(schema, input) || (validate ? validate(input) || null : null);
    },

    handler,
  };
}

module.exports = { defineTool };
