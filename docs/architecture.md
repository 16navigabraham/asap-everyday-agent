# Architecture

## A turn

1. A message arrives on a channel (web, Telegram, CLI) as `"<channel>:<id>"`, plus text or a photo with a caption.
2. `conversations.js` takes that user's lock, so two quick messages can't both act on the same quote, and loads their history.
3. `agent/turn.js` sends the system prompt (with today's date in Lagos), the 29 tool definitions and the history to Muse Spark through `model/muse.js`.
4. If Muse asks for tools, `agent/executor.js` validates and runs them, and the results go back to Muse. This repeats up to eight times.
5. The turn ends with Muse's text, or with an `ask_user` question. Every message it produced, including tool calls and results, is appended to history. A photo is replaced by a short note once its turn is over.

Tools can attach media for the channel to show (listing photos). These are returned alongside the reply, never pasted into it as links.

## Muse Spark

`model/muse.js` is one `fetch` to `https://api.meta.ai/v1/messages` with `Authorization: Bearer`, `thinking: { type: "adaptive" }` and `output_config.effort: "low"`. Caching headers are not sent. A call that fails with no response, a timeout, 408, 429 or 5xx is retried once; a 4xx is not, because the request is wrong and would fail again.

## Tools

| File | Tools |
|---|---|
| `account.js` | check_balance, transaction_history, show_account, add_money, deposit_stablecoin, set_name, set_area, saved_details, manage_saved_detail, ask_user |
| `bills.js` | list_plans, lookup_customer, buy_airtime, buy_data, pay_electricity, pay_tv |
| `shop.js` | find_listings, send_listing_photo, add_to_order, place_order |
| `rides.js` | request_ride, cancel_ride, pay_driver |
| `travel.js` | request_service, choose_option |
| `orders.js` | confirm_purchase, cancel_order, share_credits, confirm_share |

Each tool is one `defineTool` object: description, argument schema, extra checks, and a handler, with a kind of `read` or `money`. The executor allows one `money` tool per model response.

## Orders

```
quoted ──confirm──> paid ──> fulfilling ──> delivered
  ├─> expired          └─> refunded    ├─> assigned ──> delivered | refunded    (rides)
  └─> cancelled                        ├─> failed ──> refunded
                                       └─> needs_review ──> delivered | refunded
```

The table lives in `orders/states.js`, and every change goes through `store.move`, which throws on an illegal transition.

- **quote:** prices the order (fees per kind in `checkout.js`), records which turn produced it, and charges nothing.
- **confirm:** refuses same-turn confirmation, other users' orders, the wrong confirm tool for the kind, and expired quotes. It then debits the ledger with reference `order:<id>` and schedules fulfilment off the request path.
- **fulfil:** delivers, refunds on a definite decline (`refund:<id>`), parks an unknown outcome in `needs_review`, or, for rides, moves to `assigned` with driver details, then completes after the trip. A share is an internal ledger transfer. Each outcome is sent to the user as a notification on their channel.

## Profile

`users/profile.js` holds the user's name, area, account number, saved numbers (with their network, disco or TV provider), open basket and the last flight options shown. Saved numbers reach the model masked, and purchases resolve them by id.

## Inbound money

`wallet/inbound.js` simulates a bank transfer into the user's account number, or a USDC deposit on Base, Solana or Polygon at a fixed sandbox rate. Both are credited after a delay, idempotently on the turn that requested them, and announced by notification.

## Replacing the sandbox

`fulfilment/sandbox.js` is the only module that knows about providers. A real integration replaces it behind the same functions. Each `vend` resolves `delivered`, `declined` or (for rides) `assigned`, and throws only when the outcome is genuinely unknown, because a throw routes the order to review rather than to a refund.

## Storage

Wallets, orders, profiles and histories are in memory, which is enough for a sandbox demo. The ledger is append-only and idempotent on reference, so moving it to a database means one table with a unique constraint on `(user_id, ref)`.
