"""The airtime purchase tool: the one thing this agent is actually
trusted to do without asking permission first, once network, phone, and
amount are all clear and the wallet can cover it.

**Debit-then-pay, not pay-then-debit.** The wallet debit happens first,
keyed by a deterministic `reference` derived from the purchase's own
inputs, so a model that calls this tool twice for what it thinks is the
same request (a retry, a duplicate turn) debits at most once, the same
guarantee `wallet.store.debit`'s own idempotency gives a retried job in
the source system it was ported from. If VTpass then fails in a way its
own response proves cost nothing (091, or "unknown request id" on a
resend), the debit is reversed, never assumed, only acted on when
VTpass says so outright, same rule the ported `proven_uncharged` logic
encodes.
"""

from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone

from strands import tool

from src.providers.vtpass import VtpassClient, request_id_for
from src.receipts import render as render_receipt
from src.wallet import store

_client = VtpassClient()

# A flat, small per-purchase fee: this submission's own choice, not
# VTpass's. Kept separate from what VTpass actually charges (costKobo on
# the response) so the two are never confused with each other.
PLATFORM_FEE_KOBO = 0

# How long to actually wait for a "pending" purchase to resolve before
# reporting it as pending. VTpass's sandbox often settles within a few
# seconds of the initial call, seen live, so a short poll here turns
# what would otherwise read as a stuck or broken purchase into a clean
# confirmed outcome most of the time.
_PENDING_POLL_ATTEMPTS = 4
_PENDING_POLL_INTERVAL_SECONDS = 3.0

# chat_id -> receipt image path, for the most recent delivered purchase.
# Deliberately not part of the tool's return value: a server file path
# is not something to hand the model to narrate, telegram_bot.py pops
# this directly after a turn to attach the image to the reply.
_pending_receipts: dict[str, str] = {}


def pop_receipt(chat_id: str) -> str | None:
    return _pending_receipts.pop(chat_id, None)


def _reference(chat_id: str, network: str, phone: str, amount_naira: float) -> str:
    """Same inputs, same reference, within the same minute, so a model
    retrying the exact same purchase in the same turn can't double-debit.
    A genuinely new purchase a minute later gets a fresh reference, same
    per-minute pattern the ported request-id logic uses.
    """
    minute_stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    raw = f"{chat_id}:{network}:{phone}:{amount_naira}:{minute_stamp}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@tool
def buy_airtime(chat_id: str, network: str, phone: str, amount_naira: float) -> dict:
    """Buy airtime for a phone number, debiting the user's wallet.

    Only call this once the network, phone number, and amount are all
    unambiguous and you've confirmed the wallet can cover it, this tool
    executes the purchase immediately, it does not ask for confirmation
    itself.

    Report the outcome using ONLY the fields this tool actually returns,
    never a status it didn't return. Specifically:
    - ok is True and pending is missing or False: it succeeded, say so
      plainly with the transaction_id.
    - ok is True and pending is True: still processing after this tool
      already waited and re-checked for it to resolve, so it is
      genuinely, not just momentarily, still in progress. This is the
      only case where "pending" is the right word. The debit stands,
      say so.
    - ok is False and reversed is True: it was declined and the debit
      was put back, the user was not charged. Never call this "pending",
      it is a failure that has already been undone.
    - ok is False and reversed is False: it was declined and the debit
      was NOT put back (needs_review is True), tell the user plainly
      that money was held pending manual review, never say it "hasn't
      been debited" when reversed is False.
    - ok is False and reason is insufficient_funds: state the shortfall
      from shortfall_naira, do not attempt the purchase.
    - ok is False and reason is provider_unconfirmed: the request timed
      out and VTpass's own record couldn't be checked either, tell the
      user plainly that this is unresolved and money may be held, do
      not call it "pending" (that implies a known in-progress status)
      or "reversed" (nothing was put back).

    An unrecognized failure code from VTpass is checked once against its
    own record before any of the above is decided, its first answer on
    a code this module doesn't recognize is not treated as final.

    Args:
        chat_id: The Telegram chat id whose wallet gets debited.
        network: One of mtn, airtel, glo, 9mobile.
        phone: The phone number to top up, in local Nigerian format.
        amount_naira: How much airtime to buy, in naira.
    """
    amount_kobo = round(amount_naira * 100)
    reference = _reference(chat_id, network, phone, amount_naira)

    try:
        new_balance = store.debit(chat_id, amount_kobo, reference)
    except store.InsufficientFunds as shortfall:
        return {
            "ok": False,
            "reason": "insufficient_funds",
            "balance_naira": shortfall.balance_kobo / 100,
            "shortfall_naira": shortfall.shortfall_kobo / 100,
        }

    request_id = request_id_for(datetime.now(timezone.utc), reference)
    result = _client.pay(
        request_id=request_id,
        network=network,
        phone=phone,
        amount_naira=amount_naira,
    )

    if not result.ok:
        reason = result.reason or "provider_unreachable"
        if not reason.startswith("unreachable:"):
            # Never reached VTpass at all: bad network name or an
            # unconfigured client, rejected before any HTTP call went
            # out. Nothing to prove was uncharged because nothing was
            # ever sent. Safe to reverse outright.
            store.fund(chat_id, amount_kobo)
            return {"ok": False, "reason": reason, "reversed": True}

        # A request WAS sent, we just stopped waiting for the response.
        # VTpass may well have kept processing it after our client gave
        # up, so a timeout is not proof nothing was charged, the same
        # trap the module docstring's `091` note warns about. Ask
        # VTpass's own record of this request_id before deciding
        # anything, rather than guessing it must be safe to reverse.
        requery = _client.requery(request_id)
        if requery.ok and requery.decision:
            result, decision = requery, requery.decision
        else:
            # Couldn't confirm either way: leave the debit in place for
            # manual review, never reverse on a guess.
            return {
                "ok": False,
                "reason": "provider_unconfirmed",
                "needs_review": True,
                "reversed": False,
                "new_balance_naira": new_balance / 100,
            }
    else:
        decision = result.decision

    if decision and decision.failed and not decision.recognized:
        # VTpass returned a failure code this module has no catalogued
        # meaning for. Seen live: an unrecognized code on the first call
        # resolved to a clean success on requery moments later, the
        # sandbox's first answer isn't necessarily its last one, and an
        # unrecognized code is exactly the case where we can't trust it
        # as final. One requery, same as the timeout path above.
        requeried = _client.requery(request_id)
        if requeried.ok and requeried.decision:
            result, decision = requeried, requeried.decision

    if decision and decision.pending:
        # Give VTpass a real chance to settle before reporting this as
        # pending at all, seen live to resolve within a few seconds of
        # the initial call. The debit already stands either way, this
        # only affects what gets said, never whether money moved.
        for _ in range(_PENDING_POLL_ATTEMPTS):
            time.sleep(_PENDING_POLL_INTERVAL_SECONDS)
            requeried = _client.requery(request_id)
            if requeried.ok and requeried.decision and not requeried.decision.pending:
                result, decision = requeried, requeried.decision
                break

    if decision and decision.delivered:
        new_balance_naira = new_balance / 100
        try:
            # Cosmetic only: a rendering problem must never take down a
            # confirmed purchase's own confirmation.
            _pending_receipts[chat_id] = render_receipt(
                network=network,
                phone=phone,
                amount_naira=amount_naira,
                transaction_id=result.transaction_id or request_id,
                new_balance_naira=new_balance_naira,
            )
        except Exception:
            pass
        return {
            "ok": True,
            "transaction_id": result.transaction_id,
            "amount_naira": amount_naira,
            "network": network,
            "phone": phone,
            "new_balance_naira": new_balance_naira,
        }

    if decision and decision.pending:
        # Still pending even after polling: the debit stands (money
        # genuinely left, VTpass is processing), told to the user as
        # in-progress rather than either "done" or "failed".
        return {
            "ok": True,
            "pending": True,
            "transaction_id": result.transaction_id,
            "amount_naira": amount_naira,
            "network": network,
            "phone": phone,
            "new_balance_naira": new_balance / 100,
        }

    # Failed. Only reverse the debit when VTpass's own response proves
    # nothing was charged, never on an assumption, same rule the ported
    # settle() logic enforces.
    reversed_ = bool(decision and decision.proven_uncharged)
    if reversed_:
        new_balance = store.fund(chat_id, amount_kobo)

    return {
        "ok": False,
        "reason": "provider_declined",
        "code": decision.code if decision else None,
        "needs_review": bool(decision and decision.needs_review),
        "reversed": reversed_,
        "new_balance_naira": new_balance / 100,
    }
