"use strict";

const config = require("./config");
const logger = require("./log");
const http = require("./channels/http");

async function main() {
  if (!config.muse.apiKey) logger.warn("META_API_KEY is not set: every message will fail until it is.");

  await http.start();
  logger.info("API listening", { port: config.port, model: config.muse.model });

  if (config.telegramToken) require("./channels/telegram").start();
}

main();
