"""Telegram as the chat interface for this submission. One Strands agent
per chat, kept in memory for the process's lifetime, so one user's
conversation never bleeds into another's the way a single shared agent
instance would.
"""

from __future__ import annotations

import asyncio
import logging
import os

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import Application, ContextTypes, MessageHandler, filters

from src.agent import build_agent
from src.tools import purchase

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


# Telegram's own "typing..." bubble times out after about five seconds
# and has to be re-sent to stay up, unlike a spinner the client keeps
# showing on its own until told to stop.
_TYPING_REFRESH_SECONDS = 4.0


async def _keep_typing(context: ContextTypes.DEFAULT_TYPE, chat_id: int) -> None:
    """Re-send the typing action until cancelled, run as a background task
    alongside the (blocking) agent call below."""
    while True:
        await context.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
        await asyncio.sleep(_TYPING_REFRESH_SECONDS)


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

    typing_task = asyncio.create_task(_keep_typing(context, update.effective_chat.id))

    try:
        # Strands' Agent.__call__ is a blocking call, not async -- run
        # off the event loop so it can't stall every other chat's
        # messages while one turn (a tool call, a slow model response)
        # is still working, and so the typing task above actually gets
        # to run instead of being starved by the same loop.
        result = await asyncio.to_thread(agent, prompt)
        # AgentResult itself has a __str__ that pulls just the text blocks
        # out of result.message (see strands/agent/agent_result.py) --
        # str(result.message) instead stringifies the raw message dict,
        # which is what was actually landing in Telegram: the whole
        # {'role': ..., 'content': [...], 'metadata': {...}} structure,
        # readable to nobody. .strip() drops the trailing newline
        # __str__ leaves after its last text block.
        reply = str(result).strip()
    except Exception:  # noqa: BLE001 - a broken turn should still answer, not vanish
        logger.exception("Agent turn failed", extra={"chat_id": chat_id})
        reply = "Something went wrong on my end. Try that again in a moment."
    finally:
        typing_task.cancel()

    # Popped after the turn regardless of outcome text, buy_airtime only
    # ever sets this on a confirmed delivered purchase for this chat.
    receipt_path = purchase.pop_receipt(chat_id)
    if receipt_path:
        with open(receipt_path, "rb") as receipt_file:
            await update.message.reply_photo(photo=receipt_file, caption=reply)
    else:
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
