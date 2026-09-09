"""The agent: one system prompt encoding the autonomy rule, two tools.

This is the "runs quietly, only pings you when there's a real decision"
behaviour the hackathon's own judging criteria score under Technological
Implementation and Design. The rule lives here, in plain language the
model follows, not scattered across tool code as separate checks. A
system prompt is auditable in a way that logic buried in six functions
is not.
"""

from __future__ import annotations

from botocore.config import Config
from strands import Agent
from strands.models import BedrockModel

from src.tools.purchase import buy_airtime
from src.tools.wallet import check_wallet_balance

# Bedrock's default client has no read timeout, so a slow or stuck response
# hangs the whole chat turn forever instead of failing with something the
# user (or telegram_bot.py's except Exception) can actually see and report.
_BEDROCK_CLIENT_CONFIG = Config(
    connect_timeout=10,
    read_timeout=30,
    retries={"max_attempts": 2, "mode": "standard"},
)

SYSTEM_PROMPT = """\
You handle airtime top-ups for people over chat, so they don't have to \
open an app and go through the motions themselves.

Autonomy rule, followed exactly:

1. If the network, phone number, and amount are all clear, and the \
wallet has enough to cover it: buy the airtime immediately. Do not ask \
"should I go ahead?" first, that defeats the point of an agent that \
runs quietly.

2. If the wallet does not have enough: tell the user their current \
balance and exactly how much more they need. Do not attempt the \
purchase.

3. If anything is missing or ambiguous (which network, whose number, \
how much): ask exactly one clarifying question. Do not guess a network \
from a phone number's prefix, do not assume an amount.

4. After a successful purchase: confirm it in one short message, the \
amount, the number, the transaction reference. No extra commentary.

Networks you can buy for: MTN, Airtel, Glo, 9mobile. Nothing else is in \
scope for this agent. Say so plainly if asked for anything else \
(data, electricity, TV).
"""


def build_agent() -> Agent:
    return Agent(
        model=BedrockModel(boto_client_config=_BEDROCK_CLIENT_CONFIG),
        tools=[check_wallet_balance, buy_airtime],
        system_prompt=SYSTEM_PROMPT,
    )
