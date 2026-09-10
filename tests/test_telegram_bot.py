"""What actually lands in the chat, not just what the agent computed.

Regression for a real bug caught live: the bot replied with the raw
`{'role': 'assistant', 'content': [...], 'metadata': {...}}` structure
instead of the text inside it. `AgentResult` itself already knows how to
pull just the text out (`strands/agent/agent_result.py`'s own
`__str__`); the bug was stringifying `result.message` (the bare dict)
instead of `result` (the object with that extraction logic).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from strands.agent.agent_result import AgentResult
from strands.telemetry.metrics import EventLoopMetrics

import src.telegram_bot as telegram_bot


def _fake_result(text: str) -> AgentResult:
    return AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": text}]},
        metrics=EventLoopMetrics(),
        state={},
    )


def _fake_update(text: str):
    update = MagicMock()
    update.message.text = text
    update.message.reply_text = AsyncMock()
    update.effective_chat.id = "chat-1"
    return update


def _fake_context():
    context = MagicMock()
    context.bot.send_chat_action = AsyncMock()
    return context


def test_only_the_reply_text_is_sent_not_the_raw_result(monkeypatch):
    reply_text = "Hey! I can help you top up airtime for MTN, Airtel, Glo, or 9mobile."

    fake_agent = MagicMock(return_value=_fake_result(reply_text))
    monkeypatch.setattr(telegram_bot, "_agent_for", lambda chat_id: fake_agent)

    update = _fake_update("hey")
    asyncio.run(telegram_bot.handle_message(update, _fake_context()))

    update.message.reply_text.assert_awaited_once_with(reply_text)
    # The exact shape of the live bug: role/content/metadata never reach
    # the chat.
    sent = update.message.reply_text.await_args.args[0]
    assert "role" not in sent
    assert "metadata" not in sent


def test_typing_indicator_fires_while_the_agent_runs(monkeypatch):
    # Real Telegram bubble times out after ~5s and has to be refreshed --
    # this only proves at least one send_chat_action(TYPING) went out for
    # the turn, not the refresh cadence itself, which asyncio.sleep makes
    # awkward to assert deterministically without slowing the suite down.
    fake_agent = MagicMock(return_value=_fake_result("ok"))
    monkeypatch.setattr(telegram_bot, "_agent_for", lambda chat_id: fake_agent)

    update = _fake_update("hey")
    context = _fake_context()
    asyncio.run(telegram_bot.handle_message(update, context))

    context.bot.send_chat_action.assert_awaited_with(
        chat_id=update.effective_chat.id, action=telegram_bot.ChatAction.TYPING
    )


def test_multiple_text_blocks_are_joined_cleanly(monkeypatch):
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "Line one."}, {"text": "Line two."}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    fake_agent = MagicMock(return_value=result)
    monkeypatch.setattr(telegram_bot, "_agent_for", lambda chat_id: fake_agent)

    update = _fake_update("hey")
    asyncio.run(telegram_bot.handle_message(update, _fake_context()))

    sent = update.message.reply_text.await_args.args[0]
    assert sent == "Line one.\nLine two."
