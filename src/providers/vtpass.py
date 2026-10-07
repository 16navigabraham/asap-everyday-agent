"""VTpass: Nigerian airtime, paid in naira.

Reimplemented from an existing production system's JavaScript client:
same response-code handling, same crash-safety guarantees, rebuilt in
Python here against a separate VTpass credential (never a production one).

**Their response codes need care, and one of them is a trap.**

`000` does NOT mean delivered. It means "transaction processed", and the
actual outcome lives in `content.transactions.status`, which may be
initiated, pending, delivered or reversed. Reading `000` as success tells
a user their airtime arrived while it is still queued.

`014` is the idempotency signal rather than a failure: it means the
request id has been used already, so a retry that sees it should ask what
happened to the first attempt instead of giving up.

`091` is the one failure that is safe to retry, because it states plainly
that no charge was applied.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

LAGOS = ZoneInfo("Africa/Lagos")
TIMEOUT_SECONDS = 12.0

# VTpass service ids for airtime. 9mobile is `etisalat`, they never
# renamed it after the rebrand, and sending `9mobile` returns a
# does-not-exist error.
SERVICE_IDS = {
    "mtn": "mtn",
    "airtel": "airtel",
    "glo": "glo",
    "9mobile": "etisalat",
}

DELIVERED_STATUS = {"delivered"}
FAILED_STATUS = {"reversed", "failed"}

CODE = {
    "PROCESSED": "000",
    "PROCESSING": "099",
    "QUERY": "001",
    "STILL_PROCESSING": "089",
    "ALREADY_USED": "014",  # not a failure, the request id was already sent
    "LIKELY_DUPLICATE": "019",
    "NOT_PROCESSED": "091",  # proves no charge was applied
    "UNKNOWN_REQUEST_ID": "015",
    "REVERSAL": "040",
    "RESOLVED": "044",
    "BAD_REQUEST_ID": "085",
    "LOW_WALLET_BALANCE": "018",
    "IP_NOT_WHITELISTED": "027",
}

RETRYABLE_CODES = {CODE["NOT_PROCESSED"], "030", "083"}

# Codes that are our problem, not the user's, and that a refund does not
# fix: an empty VTpass wallet, a suspended account, an un-allowlisted
# server IP all fail every purchase, not one.
NEEDS_REVIEW_CODES = {
    CODE["LOW_WALLET_BALANCE"],
    "021",  # account locked
    "022",  # account suspended
    "023",  # API access not enabled
    "024",  # account inactive
    CODE["IP_NOT_WHITELISTED"],
    "028",  # product not whitelisted
    "034",  # service suspended
    "035",  # service inactive
    "087",  # invalid credentials
    CODE["RESOLVED"],
    CODE["BAD_REQUEST_ID"],
}


# Every failure code this module actually understands. A code outside
# this set on a `failed` decision means VTpass told us something we
# don't have a catalogued meaning for, not that we know it's a hard,
# final failure.
KNOWN_FAILURE_CODES = RETRYABLE_CODES | NEEDS_REVIEW_CODES | {
    CODE["NOT_PROCESSED"],
    CODE["UNKNOWN_REQUEST_ID"],
    CODE["REVERSAL"],
}


@dataclass
class Decision:
    code: str
    delivered: bool = False
    failed: bool = False
    pending: bool = False
    retryable: bool = False
    needs_review: bool = False
    # Whether we can state, rather than assume, the user was not charged.
    proven_uncharged: bool = False
    # False means this failure code isn't one this module has a
    # catalogued meaning for. Seen live: VTpass's sandbox returned an
    # unrecognized code on the initial call that a requery moments later
    # resolved to a clean success, an unrecognized code is a reason to
    # check again, not a reason to trust it as final.
    recognized: bool = True


def classify(data: dict[str, Any]) -> Decision:
    """Turn a VTpass response into a decision, see module docstring."""
    code = str(data.get("code", ""))
    content = data.get("content") or {}
    transactions = content.get("transactions") or {}
    status = str(transactions.get("status") or data.get("transaction_status") or "").lower()

    if code in (CODE["PROCESSED"], CODE["QUERY"]):
        delivered = status in DELIVERED_STATUS
        failed = status in FAILED_STATUS
        return Decision(
            code=code,
            delivered=delivered,
            failed=failed,
            pending=not delivered and not failed,
            proven_uncharged=failed,  # a reversal means the money came back
        )

    if code in (CODE["PROCESSING"], CODE["STILL_PROCESSING"], CODE["ALREADY_USED"], CODE["LIKELY_DUPLICATE"]):
        return Decision(code=code, pending=True)

    return Decision(
        code=code,
        failed=True,
        retryable=code in RETRYABLE_CODES,
        needs_review=code in NEEDS_REVIEW_CODES,
        proven_uncharged=code in (CODE["NOT_PROCESSED"], CODE["UNKNOWN_REQUEST_ID"], CODE["REVERSAL"]),
        recognized=code in KNOWN_FAILURE_CODES,
    )


def request_id_for(created_at: datetime, job_id: str) -> str:
    """Same-attempt-same-id, so a retry cannot double-charge. VTpass checks
    the date portion against today's Lagos date, see `still_valid_today`.
    """
    stamp = created_at.astimezone(LAGOS).strftime("%Y%m%d%H%M")
    return f"{stamp}asapagent{job_id}"


def still_valid_today(created_at: datetime, now: datetime | None = None) -> bool:
    """A request id whose date portion isn't today gets rejected by VTpass
    (085): checking first turns a confusing rejection into a decision we
    make deliberately, rather than a surprise.
    """
    now = now or datetime.now(LAGOS)
    return created_at.astimezone(LAGOS).date() == now.astimezone(LAGOS).date()


def _extract_token(data: dict[str, Any]) -> str | None:
    """Unused for airtime (no token), kept for parity with the ported
    normalise() shape. Electricity is out of scope for this submission.
    """
    raw = data.get("token") or data.get("purchased_code")
    if not raw:
        return None
    cleaned = re.sub(r"^\s*token\s*:?\s*", "", str(raw), flags=re.IGNORECASE).strip()
    return cleaned or None


@dataclass
class PurchaseResult:
    ok: bool
    request_id: str
    code: str = ""
    status: str = ""
    transaction_id: str | None = None
    cost_kobo: int | None = None
    amount_naira: float | None = None
    decision: Decision | None = None
    reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class VtpassClient:
    """Airtime purchase only, the scope this submission ships. Data,
    electricity, and TV exist in the source system's own provider client
    but aren't ported here (see the repo's README "Out of scope").
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        secret_key: str | None = None,
    ) -> None:
        self.base_url = base_url or os.environ.get("VTPASS_BASE_URL", "")
        self.api_key = api_key or os.environ.get("VTPASS_API_KEY", "")
        self.secret_key = secret_key or os.environ.get("VTPASS_SECRET_KEY", "")

    def is_configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.secret_key)

    def _headers(self) -> dict[str, str]:
        # /api/pay and /api/requery are both POST, which VTpass's docs say
        # takes the secret-key credential.
        return {
            "api-key": self.api_key,
            "secret-key": self.secret_key,
            "Content-Type": "application/json",
        }

    def pay(
        self,
        *,
        request_id: str,
        network: str,
        phone: str,
        amount_naira: float,
    ) -> PurchaseResult:
        service_id = SERVICE_IDS.get(network.lower())
        if not service_id:
            return PurchaseResult(ok=False, request_id=request_id, reason=f"unsupported_network:{network}")

        if not self.is_configured():
            return PurchaseResult(ok=False, request_id=request_id, reason="provider_unconfigured")

        body = {
            "request_id": request_id,
            "serviceID": service_id,
            "phone": phone,
            "amount": amount_naira,
        }

        try:
            response = httpx.post(
                f"{self.base_url}/api/pay",
                json=body,
                headers=self._headers(),
                timeout=TIMEOUT_SECONDS,
            )
        except httpx.RequestError as error:
            return PurchaseResult(ok=False, request_id=request_id, reason=f"unreachable:{error}")

        data = response.json() if response.content else {}
        return self._normalise(data, request_id)

    def requery(self, request_id: str) -> PurchaseResult:
        if not self.is_configured():
            return PurchaseResult(ok=False, request_id=request_id, reason="provider_unconfigured")

        try:
            response = httpx.post(
                f"{self.base_url}/api/requery",
                json={"request_id": request_id},
                headers=self._headers(),
                timeout=TIMEOUT_SECONDS,
            )
        except httpx.RequestError as error:
            return PurchaseResult(ok=False, request_id=request_id, reason=f"unreachable:{error}")

        data = response.json() if response.content else {}
        return self._normalise(data, request_id)

    def _normalise(self, data: dict[str, Any], request_id: str) -> PurchaseResult:
        content = data.get("content") or {}
        transaction = content.get("transactions") or {}
        decision = classify(data)

        total_amount = transaction.get("total_amount")
        return PurchaseResult(
            ok=True,
            request_id=request_id,
            code=str(data.get("code", "")),
            status=str(transaction.get("status", "")).lower(),
            transaction_id=transaction.get("transactionId") or data.get("requestId"),
            cost_kobo=round(float(total_amount) * 100) if total_amount is not None else None,
            amount_naira=float(transaction["amount"]) if transaction.get("amount") is not None else None,
            decision=decision,
            raw=data,
        )
