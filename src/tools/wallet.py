"""The wallet-balance tool: read-only, so the agent can check funds
before deciding whether to attempt a purchase or tell the user their
shortfall.
"""

from __future__ import annotations

from strands import tool

from src.wallet import store


def _naira(kobo: int) -> str:
    return f"₦{kobo / 100:,.2f}"


@tool
def check_wallet_balance(chat_id: str) -> dict:
    """Check the user's current wallet balance.

    Call this before attempting any purchase, or whenever the user asks
    how much they have -- every single time, even if you already called
    it earlier in this same conversation, even if you already told the
    user a number a moment ago. A purchase changes the balance, and a
    figure you said earlier in the chat is not proof of what it is now.
    Never answer a balance question from memory.

    Args:
        chat_id: The Telegram chat id this wallet belongs to.
    """
    kobo = store.balance_kobo(chat_id)
    return {"balance_kobo": kobo, "balance_naira": _naira(kobo)}
