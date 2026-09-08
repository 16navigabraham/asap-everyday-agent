import os

import pytest

os.environ["WALLET_DB_PATH"] = ":memory:"  # overridden per-test below anyway

from src.wallet import store  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db(tmp_path, monkeypatch):
    """Each test gets its own SQLite file — state must never leak between
    tests the way it would with a single shared :memory: connection reused
    across store._connect() calls.
    """
    db_path = tmp_path / "wallet.db"
    monkeypatch.setattr(store, "DB_PATH", str(db_path))
    yield


def test_new_chat_is_seeded_with_the_default_balance():
    assert store.balance_kobo("chat-1") == store.DEFAULT_SEED_KOBO


def test_debit_reduces_balance_and_records_the_entry():
    starting = store.balance_kobo("chat-2")
    new_balance = store.debit("chat-2", 50_00, reference="ref-1")
    assert new_balance == starting - 5000
    assert store.balance_kobo("chat-2") == starting - 5000


def test_debit_beyond_balance_raises_insufficient_funds_and_charges_nothing():
    starting = store.balance_kobo("chat-3")
    with pytest.raises(store.InsufficientFunds) as excinfo:
        store.debit("chat-3", starting + 1, reference="ref-2")

    assert excinfo.value.shortfall_kobo == 1
    assert store.balance_kobo("chat-3") == starting  # untouched


def test_debit_is_idempotent_on_reference():
    store.debit("chat-4", 1000, reference="same-ref")
    balance_after_first = store.balance_kobo("chat-4")

    balance_after_second = store.debit("chat-4", 1000, reference="same-ref")

    assert balance_after_second == balance_after_first  # not debited twice


def test_fund_increases_balance():
    starting = store.balance_kobo("chat-5")
    new_balance = store.fund("chat-5", 2000)
    assert new_balance == starting + 2000
