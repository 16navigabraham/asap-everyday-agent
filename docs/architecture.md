# Architecture

```mermaid
flowchart LR
    U[Telegram user] -- message --> B[Telegram Bot\nsrc/telegram_bot.py]
    B -- per-chat Agent instance --> A[Strands Agent\nsrc/agent.py]
    A -- system prompt: autonomy rule --> A
    A -- calls --> WT[check_wallet_balance tool]
    A -- calls --> PT[buy_airtime tool]
    WT --> WS[(Wallet store\nSQLite, this repo's own)]
    PT --> WS
    PT --> VT[VtpassClient\nsrc/providers/vtpass.py]
    VT -- HTTPS --> VP[VTpass API\nreal Nigerian billing aggregator]
    A -. model calls, ANTHROPIC_API_KEY set .-> AN[Anthropic API]
    A -. model calls, unset .-> BR[Amazon Bedrock\nClaude, via AWS credentials]
```

Strands is model-agnostic: `_build_model()` in `src/agent.py` picks
between the two providers above at startup, based on whether
`ANTHROPIC_API_KEY` is set. Everything else — the tools, the autonomy
rule, the Telegram interface — is identical either way.

## What was ported from an existing system, and what's new

The purchase logic here is reimplemented from a production WhatsApp
money agent the author previously built (JavaScript/Node.js), disclosed
per this hackathon's rules on incorporating pre-existing work. No
production credential, database, or user data from that system is used
anywhere in this repo.

| Piece | Source |
| --- | --- |
| VTpass response-code classification (`classify()`), the "000 isn't delivered" trap, idempotency handling | Ported from the source system's provider client, reimplemented in Python |
| Debit-then-pay, reverse-only-when-proven-uncharged purchase safety | Ported from the source system's crash-safety logic, adapted from a queued-job model to a synchronous tool call |
| Wallet balance / debit / fund, kobo-denominated | New: a standalone SQLite store for this submission, not a connection to any production database |
| Autonomy rule (system prompt) | New: this is the actual hackathon deliverable, a plain-language rule the model follows, not scattered checks |
| Telegram bot, per-chat agent instances | New: the chat interface for this submission |
| Strands `Agent` + `@tool` wiring | New: this submission's actual use of the Strands Agents SDK |

## Why a synchronous tool call instead of a job queue

The source system's real purchase flow is asynchronous: a job gets
queued, a worker claims it, and can retry a crashed attempt because the
request id was recorded before the provider call ever went out. That
two-process design solves a problem this submission doesn't have:
there's no separate worker here to crash independently of the tool call
itself. The purchase tool keeps the part of that design that still
matters at this scale (a deterministic, idempotent reference so a
retried tool call can't double-debit) without the queue infrastructure
that would exist purely to satisfy a judging checklist item rather than
solve a real problem here.

## Deployment

Runs anywhere Python does. For AWS Bedrock AgentCore deployment (the
hackathon's suggested path, strengthens the Technical Implementation
score), see the AWS credentials section in `.env.example`. The agent
code itself doesn't change between local and AgentCore deployment, only
how the process gets hosted.
