"""A standalone demo wallet, kobo-denominated like the production ledger
this submission's purchase logic was ported from.

**Deliberately not a connection to any production database.** This
submission ports the *business logic* (the VTpass integration, the
crash-safe purchase flow, the autonomy rule) from an existing system,
it does not, and must never, read or write real customer balances from
it. Each Telegram chat gets its own row here, seeded with a small demo
balance, in a SQLite file this repo owns outright.

Kobo, not naira, for the same reason the source ledger uses it: naira
has a fractional unit, and float arithmetic on money is how a balance
quietly drifts by a kobo here and there until nothing reconciles.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass

DB_PATH = os.environ.get("WALLET_DB_PATH", "wallet.db")

# New chats start funded so a demo doesn't dead-end on "insufficient
# funds" before anyone's typed a real message. Override via env for a
# live judged demo where you want a specific number on screen.
DEFAULT_SEED_KOBO = int(os.environ.get("WALLET_SEED_KOBO", "500000"))  # NGN 5,000


@dataclass
class InsufficientFunds(Exception):
    balance_kobo: int
    shortfall_kobo: int


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        create table if not exists wallet (
            chat_id text primary key,
            balance_kobo integer not null
        )
        """
    )
    conn.execute(
        """
        create table if not exists ledger_entry (
            id integer primary key autoincrement,
            chat_id text not null,
            kind text not null,
            amount_kobo integer not null,
            reference text,
            created_at text default (datetime('now'))
        )
        """
    )
    conn.commit()
    return conn


@contextmanager
def _cursor():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _ensure_wallet(conn: sqlite3.Connection, chat_id: str) -> None:
    conn.execute(
        "insert or ignore into wallet (chat_id, balance_kobo) values (?, ?)",
        (chat_id, DEFAULT_SEED_KOBO),
    )


def balance_kobo(chat_id: str) -> int:
    with _cursor() as conn:
        _ensure_wallet(conn, chat_id)
        row = conn.execute("select balance_kobo from wallet where chat_id = ?", (chat_id,)).fetchone()
        return int(row[0])


def debit(chat_id: str, amount_kobo: int, reference: str) -> int:
    """Debit the wallet, atomically checked against the current balance.

    Raises `InsufficientFunds` rather than silently going negative, the
    agent's own tool wrapper is what turns this into the "tell them the
    shortfall, don't attempt the purchase" behaviour the autonomy rule
    requires.

    Idempotent on `reference`: the same reference debits at most once,
    the same protection an `on conflict (reference) do nothing` clause
    gives a webhook redelivery in the source system, applied here to a
    retried tool call.
    """
    with _cursor() as conn:
        _ensure_wallet(conn, chat_id)

        already = conn.execute(
            "select 1 from ledger_entry where chat_id = ? and reference = ? and kind = 'debit'",
            (chat_id, reference),
        ).fetchone()
        if already:
            row = conn.execute("select balance_kobo from wallet where chat_id = ?", (chat_id,)).fetchone()
            return int(row[0])

        row = conn.execute("select balance_kobo from wallet where chat_id = ?", (chat_id,)).fetchone()
        current = int(row[0])

        if current < amount_kobo:
            raise InsufficientFunds(balance_kobo=current, shortfall_kobo=amount_kobo - current)

        new_balance = current - amount_kobo
        conn.execute("update wallet set balance_kobo = ? where chat_id = ?", (new_balance, chat_id))
        conn.execute(
            "insert into ledger_entry (chat_id, kind, amount_kobo, reference) values (?, 'debit', ?, ?)",
            (chat_id, amount_kobo, reference),
        )
        return new_balance


def fund(chat_id: str, amount_kobo: int) -> int:
    """Top up a demo wallet: for setting up a live judged demo with a
    specific balance on screen, not a real payment rail.
    """
    with _cursor() as conn:
        _ensure_wallet(conn, chat_id)
        conn.execute(
            "update wallet set balance_kobo = balance_kobo + ? where chat_id = ?",
            (amount_kobo, chat_id),
        )
        conn.execute(
            "insert into ledger_entry (chat_id, kind, amount_kobo, reference) values (?, 'fund', ?, NULL)",
            (chat_id, amount_kobo),
        )
        row = conn.execute("select balance_kobo from wallet where chat_id = ?", (chat_id,)).fetchone()
        return int(row[0])
