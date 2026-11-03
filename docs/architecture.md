# Architecture

## A turn

1. A message arrives on a channel (web, Telegram, CLI) as `"<channel>:<id>"` plus text.
2. `conversations.js` takes that user's lock, so two quick messages can't both act on the same quote, and loads their history.
3. `agent/turn.js` sends the system prompt, the tool definitions and the history to the active model through `model/client.js`.
4. If the model asks for tools, `agent/executor.js` validates and runs them, and the results go back to the model. This repeats up to six times.
5. The turn ends with the model's text, or with an `ask_user` question. Every message it produced, including tool calls and results, is appended to history.

Each assistant message is tagged in memory with the provider that wrote it. When the conversation is later sent to a different provider, that provider's foreign thinking blocks are removed, because thinking blocks are signed and only accepted by the model that produced them. The tag itself is stripped before every request.

## Models

`model/providers.js` describes each provider as a base URL, an auth header and a request-shaping function:

| | Muse Spark (default) | Claude (optional) |
|---|---|---|
| Endpoint | `https://api.meta.ai/v1/messages` | `https://api.anthropic.com/v1/messages` |
| Auth | `Authorization: Bearer` | `x-api-key` |
| Extra | `thinking: adaptive`, `output_config.effort: low` | none |

`model/switch.js` holds the active provider. It is read on every call, so a switch flipped from the web page or the CLI applies to the very next message.

`model/client.js` retries a failed call once on the other provider when the failure is retryable (no response, timeout, 402, 408, 429, 5xx) and the turn hasn't run any tools yet. A 400 is never retried, because the request is malformed and would fail on both providers.

## Orders

```
quoted ──confirm──> paid ──> fulfilling ──> delivered
  ├─> expired          └─> refunded    ├─> failed ──> refunded
  └─> cancelled                        └─> needs_review ──> delivered | refunded
```

The table lives in `orders/states.js`, and every change goes through `store.move`, which throws on an illegal transition.

- **quote:** prices the order, records which turn produced it, and charges nothing.
- **confirm:** refuses same-turn and other users' orders and expired quotes. It then debits the ledger with reference `order:<id>` and schedules fulfilment off the request path.
- **fulfil:** delivers, or refunds on a definite decline (reference `refund:<id>`), or parks the order in `needs_review` when the outcome is unknown. Each outcome is sent to the user as a notification on their channel.

Quotes expire after `QUOTE_TTL_MINUTES`. An expired quote is marked the moment anything reads it.

## Replacing the sandbox

`fulfilment/sandbox.js` is the only module that knows about fulfilment. A real provider implements `listPlans`, `findPlan`, `lookupCustomer` and `vend`. `vend` must resolve `{ status: "delivered", reference }` or `{ status: "declined" }`, and throw only when the outcome is genuinely unknown, because a throw routes the order to review rather than to a refund.

## Storage

Wallets, orders and histories are in memory, which is enough for a sandbox demo. The ledger is append-only and idempotent on reference, so moving it to a database means one table with a unique constraint on `(user_id, ref)`.
