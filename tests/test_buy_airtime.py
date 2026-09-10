from unittest.mock import patch

import pytest

from src import receipts
from src.providers.vtpass import Decision, PurchaseResult
from src.tools import purchase
from src.wallet import store


@pytest.fixture(autouse=True)
def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "wallet.db"))
    monkeypatch.setattr(receipts, "RECEIPTS_DIR", tmp_path / "receipts")
    monkeypatch.setattr(purchase, "_PENDING_POLL_INTERVAL_SECONDS", 0)
    yield


def _delivered(request_id: str) -> PurchaseResult:
    return PurchaseResult(
        ok=True,
        request_id=request_id,
        code="000",
        status="delivered",
        transaction_id="vtpass-tx-123",
        decision=Decision(code="000", delivered=True),
    )


def test_successful_purchase_debits_the_wallet_and_confirms():
    starting = store.balance_kobo("chat-a")

    with patch.object(purchase._client, "pay", return_value=_delivered("req-1")):
        result = purchase.buy_airtime(chat_id="chat-a", network="mtn", phone="08012345678", amount_naira=500)

    assert result["ok"] is True
    assert result["transaction_id"] == "vtpass-tx-123"
    assert store.balance_kobo("chat-a") == starting - 50_000  # NGN 500 in kobo


def test_a_delivered_purchase_stashes_a_receipt_for_the_chat():
    with patch.object(purchase._client, "pay", return_value=_delivered("req-1")):
        purchase.buy_airtime(chat_id="chat-a", network="mtn", phone="08012345678", amount_naira=500)

    path = purchase.pop_receipt("chat-a")
    assert path is not None
    assert path.endswith(".png")
    from pathlib import Path

    assert Path(path).exists()
    # popped once, gone the second time
    assert purchase.pop_receipt("chat-a") is None


def test_pop_receipt_is_none_when_nothing_was_stashed():
    assert purchase.pop_receipt("no-such-chat") is None


def test_insufficient_funds_is_reported_without_calling_the_provider():
    huge_amount = store.DEFAULT_SEED_KOBO / 100 + 1000  # far beyond the seeded balance

    with patch.object(purchase._client, "pay") as mock_pay:
        result = purchase.buy_airtime(chat_id="chat-b", network="mtn", phone="08012345678", amount_naira=huge_amount)

    assert result["ok"] is False
    assert result["reason"] == "insufficient_funds"
    assert result["shortfall_naira"] > 0
    mock_pay.assert_not_called()  # never reached the provider, the wallet check happens first
    assert store.balance_kobo("chat-b") == store.DEFAULT_SEED_KOBO  # untouched


def test_unsupported_network_is_rejected_before_debiting():
    starting = store.balance_kobo("chat-c")

    result = purchase.buy_airtime(chat_id="chat-c", network="visafone", phone="08012345678", amount_naira=500)

    assert result["ok"] is False
    assert "unsupported_network" in result["reason"]
    assert store.balance_kobo("chat-c") == starting  # debited then reversed, net zero


def test_a_failure_vtpass_proves_uncharged_reverses_the_debit():
    starting = store.balance_kobo("chat-d")
    not_processed = PurchaseResult(
        ok=True,
        request_id="req-2",
        code="091",
        decision=Decision(code="091", failed=True, retryable=True, proven_uncharged=True),
    )

    with patch.object(purchase._client, "pay", return_value=not_processed):
        result = purchase.buy_airtime(chat_id="chat-d", network="mtn", phone="08012345678", amount_naira=500)

    assert result["ok"] is False
    assert result["reason"] == "provider_declined"
    assert result["reversed"] is True
    assert store.balance_kobo("chat-d") == starting  # reversed, not left debited


def test_a_failure_vtpass_does_not_prove_uncharged_leaves_the_debit_in_place():
    """Mirrors the source system's own rule: refunding on an assumption
    is how the ledger and the provider stop agreeing, an ambiguous
    failure needs a human, not an automatic reversal.
    """
    starting = store.balance_kobo("chat-e")
    ambiguous_failure = PurchaseResult(
        ok=True,
        request_id="req-3",
        code="999",
        decision=Decision(code="999", failed=True, needs_review=True, proven_uncharged=False),
    )

    with patch.object(purchase._client, "pay", return_value=ambiguous_failure):
        result = purchase.buy_airtime(chat_id="chat-e", network="mtn", phone="08012345678", amount_naira=500)

    assert result["ok"] is False
    assert result["needs_review"] is True
    assert result["reversed"] is False
    assert store.balance_kobo("chat-e") == starting - 50_000  # NOT reversed


def test_unsupported_network_reason_still_reverses_unconditionally():
    # Rejected before any HTTP call went out, nothing to requery.
    starting = store.balance_kobo("chat-f")
    never_sent = PurchaseResult(ok=False, request_id="req-4", reason="unsupported_network:visafone")

    with patch.object(purchase._client, "pay", return_value=never_sent):
        result = purchase.buy_airtime(chat_id="chat-f", network="mtn", phone="08012345678", amount_naira=500)

    assert result["ok"] is False
    assert result["reversed"] is True
    assert store.balance_kobo("chat-f") == starting


def test_a_timeout_is_checked_with_requery_before_reversing():
    """Caught live: a read timeout was being treated as proof nothing was
    charged and reversed immediately. It isn't proof, the request may
    have kept processing after the client gave up waiting, so a timeout
    now gets checked against VTpass's own record via requery() before
    anything is decided.
    """
    starting = store.balance_kobo("chat-g")
    timed_out = PurchaseResult(ok=False, request_id="req-5", reason="unreachable:ReadTimeout")
    confirmed_delivered = PurchaseResult(
        ok=True,
        request_id="req-5",
        code="000",
        status="delivered",
        transaction_id="vtpass-tx-999",
        decision=Decision(code="000", delivered=True),
    )

    with patch.object(purchase._client, "pay", return_value=timed_out), \
         patch.object(purchase._client, "requery", return_value=confirmed_delivered) as mock_requery:
        result = purchase.buy_airtime(chat_id="chat-g", network="mtn", phone="08012345678", amount_naira=500)

    mock_requery.assert_called_once()
    assert result["ok"] is True
    assert result["transaction_id"] == "vtpass-tx-999"
    assert store.balance_kobo("chat-g") == starting - 50_000  # correctly stayed debited


def test_a_timeout_that_requery_also_cannot_confirm_stays_debited_for_review():
    starting = store.balance_kobo("chat-h")
    timed_out = PurchaseResult(ok=False, request_id="req-6", reason="unreachable:ReadTimeout")
    also_unreachable = PurchaseResult(ok=False, request_id="req-6", reason="unreachable:ReadTimeout")

    with patch.object(purchase._client, "pay", return_value=timed_out), \
         patch.object(purchase._client, "requery", return_value=also_unreachable):
        result = purchase.buy_airtime(chat_id="chat-h", network="mtn", phone="08012345678", amount_naira=500)

    assert result["ok"] is False
    assert result["reason"] == "provider_unconfirmed"
    assert result["needs_review"] is True
    assert result["reversed"] is False
    assert store.balance_kobo("chat-h") == starting - 50_000  # left debited, never guessed uncharged


def test_an_unrecognized_failure_code_is_checked_with_requery_before_finalizing():
    """Caught live: VTpass's sandbox returned an unrecognized code (007)
    on the first call, and a requery moments later showed the purchase
    had actually gone through. Trusting the first answer on a code this
    module doesn't catalogue would have reported a false decline.
    """
    starting = store.balance_kobo("chat-i")
    unrecognized = PurchaseResult(
        ok=True,
        request_id="req-7",
        code="007",
        decision=Decision(code="007", failed=True, recognized=False),
    )
    confirmed_delivered = PurchaseResult(
        ok=True,
        request_id="req-7",
        code="000",
        status="delivered",
        transaction_id="vtpass-tx-777",
        decision=Decision(code="000", delivered=True),
    )

    with patch.object(purchase._client, "pay", return_value=unrecognized), \
         patch.object(purchase._client, "requery", return_value=confirmed_delivered) as mock_requery:
        result = purchase.buy_airtime(chat_id="chat-i", network="mtn", phone="08012345678", amount_naira=500)

    mock_requery.assert_called_once()
    assert result["ok"] is True
    assert result["transaction_id"] == "vtpass-tx-777"
    assert store.balance_kobo("chat-i") == starting - 50_000


def test_a_recognized_failure_code_is_not_requeried():
    """A well-catalogued decline (like 087, invalid credentials) is a
    certain, terminal answer, requerying it wastes a call and can't
    change an account-level problem into a success.
    """
    starting = store.balance_kobo("chat-j")
    invalid_credentials = PurchaseResult(
        ok=True,
        request_id="req-8",
        code="087",
        decision=Decision(code="087", failed=True, needs_review=True, recognized=True),
    )

    with patch.object(purchase._client, "pay", return_value=invalid_credentials), \
         patch.object(purchase._client, "requery") as mock_requery:
        result = purchase.buy_airtime(chat_id="chat-j", network="mtn", phone="08012345678", amount_naira=500)

    mock_requery.assert_not_called()
    assert result["ok"] is False
    assert result["needs_review"] is True
    assert store.balance_kobo("chat-j") == starting - 50_000


def test_a_pending_purchase_is_polled_and_resolves_to_delivered():
    """Reported live: a "pending" reply left a reviewer unsure whether
    the purchase actually went through. buy_airtime now re-checks a
    pending result a few times before reporting it as pending at all.
    """
    pending = PurchaseResult(ok=True, request_id="req-9", code="099", decision=Decision(code="099", pending=True))
    now_delivered = PurchaseResult(
        ok=True,
        request_id="req-9",
        code="000",
        status="delivered",
        transaction_id="vtpass-tx-555",
        decision=Decision(code="000", delivered=True),
    )

    with patch.object(purchase._client, "pay", return_value=pending), \
         patch.object(purchase._client, "requery", return_value=now_delivered) as mock_requery:
        result = purchase.buy_airtime(chat_id="chat-k", network="mtn", phone="08012345678", amount_naira=500)

    mock_requery.assert_called_once()
    assert result["ok"] is True
    assert "pending" not in result
    assert result["transaction_id"] == "vtpass-tx-555"
    assert purchase.pop_receipt("chat-k") is not None


def test_a_purchase_still_pending_after_polling_is_reported_pending():
    pending = PurchaseResult(ok=True, request_id="req-10", code="099", decision=Decision(code="099", pending=True))

    with patch.object(purchase._client, "pay", return_value=pending), \
         patch.object(purchase._client, "requery", return_value=pending) as mock_requery:
        result = purchase.buy_airtime(chat_id="chat-l", network="mtn", phone="08012345678", amount_naira=500)

    assert mock_requery.call_count == purchase._PENDING_POLL_ATTEMPTS
    assert result["ok"] is True
    assert result["pending"] is True
    assert purchase.pop_receipt("chat-l") is None


def test_buy_airtime_docstring_forbids_inventing_a_status_the_tool_did_not_return():
    doc = (purchase.buy_airtime.__doc__ or "").lower()
    assert "only the fields this tool actually returns" in doc
    assert "never call this \"pending\"" in doc or 'never call this "pending"' in doc
