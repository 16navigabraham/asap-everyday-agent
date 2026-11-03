"use strict";

const config = require("./config");
const logger = require("./log");
const http = require("./channels/http");
const modelSwitch = require("./model/switch");
const { listProviders } = require("./model/providers");

async function main() {
  const providers = listProviders();
  if (!providers.some((p) => p.configured)) {
    logger.warn("No model provider configured. Set META_API_KEY (and optionally ANTHROPIC_API_KEY).");
  }

  await http.start();
  logger.info("Web chat listening", {
    port: config.port,
    model: modelSwitch.current(),
    configured: providers.filter((p) => p.configured).map((p) => p.id),
  });

  if (config.telegramToken) require("./channels/telegram").start();
}

main();
