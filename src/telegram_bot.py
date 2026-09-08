"""Telegram as the chat interface for this submission. One Strands agent
per chat, kept in memory for the process's lifetime, so one user's
conversation never bleeds into another's the way a single shared agent
instance would.
"""

from __future__ import annotations

import logging
import os

from telegram import Update
from telegram.ext import Application, ContextTypes, MessageHandler, filters

from src.agent import build_agent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("asap-agent-telegram")

# httpx logs the full request URL at INFO, and python-telegram-bot's Bot API
# calls embed the bot token directly in that URL (api.telegram.org/bot<TOKEN>/...).
# Left at INFO, the token ends up in plaintext in every log line.
logging.getLogger("httpx").setLevel(logging.WARNING)

# chat_id -> Agent. Strands agents carry their own conversation history
# internally, so reusing the same instance across a chat's messages is
# what gives the agent memory of earlier turns.
_agents: dict[str, "Agent"] = {}


def _agent_for(chat_id: str):
    if chat_id not in _agents:
        _agents[chat_id] = build_agent()
    return _agents[chat_id]


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.text:
        return

    chat_id = str(update.effective_chat.id)
    text = update.message.text

    agent = _agent_for(chat_id)

    # The agent's tools take chat_id as an explicit argument rather than
    # reading it from ambient state. Strands tools are plain functions,
    # so there's no per-call request context to thread it through
    # implicitly. The system prompt doesn't mention this; it's routed in
    # via the message itself so the model always has it in context.
    prompt = f"[chat_id={chat_id}] {text}"

    try:
        result = agent(prompt)
        reply = str(result.message) if hasattr(result, "message") else str(result)
    except Exception:  # noqa: BLE001 - a broken turn should still answer, not vanish
        logger.exception("Agent turn failed", extra={"chat_id": chat_id})
        reply = "Something went wrong on my end. Try that again in a moment."

    await update.message.reply_text(reply)


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set. See .env.example")

    app = Application.builder().token(token).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot starting (polling)")
    app.run_polling()


if __name__ == "__main__":
    main()
