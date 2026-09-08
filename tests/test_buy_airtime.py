from unittest.mock import patch

import pytest

from src.providers.vtpass import Decision, PurchaseResult
from src.tools import purchase
from src.wallet import store


@pytest.fixture(autouse=True)
def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DB_PATH", str(tmp_path / "wallet.db"))
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
    assert store.balance_kobo("chat-e") == starting - 50_000  # NOT reversed
