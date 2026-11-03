<p align="center">
  <img src="docs/assets/icon.svg" width="96" height="96" alt="ASAP icon">
</p>

<h1 align="center">ASAP Everyday Agent</h1>

<p align="center">
  Everyday errands in Nigeria over plain chat, powered by <strong>Meta Muse Spark</strong>.
  <br>
  Airtime, data, electricity and TV, with no app, no menus, and no money moving until you say yes.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/model-Meta%20Muse%20Spark-0866ff" alt="Model: Meta Muse Spark">
  <img src="https://img.shields.io/badge/node-22%2B-339933" alt="Node 22+">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies">
</p>

<p align="center">Built for the Meta Global AI Developer Hackathon, theme: <em>Build for Your World</em>.</p>

---

## The problem

Paying for everyday things in Nigeria means a different app, menu or USSD code for every errand: topping up your mum's line, buying a data bundle, paying the light bill before NEPA takes the light, renewing GOtv. All of it is small, frequent and fiddly, and a wrong digit on a meter number sends your money to a stranger's account with no way to get it back.

ASAP turns each of these into one chat message: *"Pay ₦3,000 on my Ikeja prepaid meter 45031234567"*. The agent works out what you mean, looks up the account name so you can check it, shows you the total, and only charges you once you say yes.

This repository is the open-source core of ASAP's agent: the model integration, tool layer, money-safety rules and order lifecycle. It runs on its own against a built-in sandbox, so anyone can try it without real money or third-party accounts.

## What it does

| Errand | How it works |
|---|---|
| Airtime | MTN, Airtel, Glo, 9mobile, ₦50 to ₦50,000 |
| Data bundles | Live plan list per network, quoted by plan id |
| Electricity | Ikeja, Eko, Abuja, Ibadan, Enugu; prepaid gets a 20-digit token |
| TV | DStv, GOtv, StarTimes, with the account name confirmed first |
| Wallet | Balance, recent activity with live order status, sandbox top-ups |

It works in English and Pidgin, and it asks exactly one question when something is missing instead of guessing.

## Meta Muse Spark at the centre

Every turn is answered by **Muse Spark** through the **Meta Model API**. Meta's API uses the Messages API wire format, so the agent calls it with plain `fetch` (see [`src/model/providers.js`](src/model/providers.js)):

```js
POST https://api.meta.ai/v1/messages
authorization: Bearer $META_API_KEY

{ model: "muse-spark-1.1", system, tools, messages,
  thinking: { type: "adaptive" }, output_config: { effort: "low" } }
```

Muse Spark plans each errand as a chain of tool calls (look up the meter, show the name, quote, wait, confirm) and reasons before each step. Muse always reasons, so the effort is pinned to `low`; left unbounded, it can spend the whole token budget thinking and return no text.

**Live model switch and failover.** Claude can be configured as a second provider. The web page has a Muse Spark / Claude switch (behind an admin token) that takes effect on the very next message, and if a Muse call fails with an outage, rate limit or credit error, that call is retried once on the other provider. Every reply in the UI is labelled with the model that wrote it, failovers included. Failover is only allowed before a turn has run any tools, so two models never split one errand between them.

## Money safety, enforced in code

The model never moves money on its own judgement. Each rule below is enforced by code and covered by a test:

1. **Purchase tools only quote.** `buy_airtime`, `buy_data`, `pay_electricity` and `pay_tv` price the request and store an order in `quoted`. Nothing is charged.
2. **Quote and confirmation can't happen in the same turn.** `confirm_purchase` refuses an order quoted earlier in the same turn, so the user always sees the total before the debit.
3. **One money action per model response.** If the model asks for two at once, the second is refused.
4. **Arguments are validated in-process** against each tool's schema plus semantic bounds (amount limits, valid Nigerian numbers, meter formats) before any handler runs.
5. **An idempotent ledger.** Every debit and refund has a unique reference, so a retried confirmation charges once.
6. **Refunds need proof of failure.** A provider decline refunds automatically. An unknown outcome (a timeout) holds the money in `needs_review`, because refunding something that might have been delivered pays out twice.
7. **Failures are reported honestly.** When a tool throws, the model never sees the raw error. It gets a fixed instruction saying the action did not run and must not be described as successful, or, for a failed lookup, that it doesn't know the answer and must say so.
8. **Bill payments check the account name first.** The prompt requires `lookup_customer` and the user's confirmation of the name before any electricity or TV quote.

## Try it

```bash
git clone https://github.com/16navigabraham/asap-everyday-agent.git
cd asap-everyday-agent
cp .env.example .env        # add META_API_KEY
npm start                   # http://localhost:3000
```

There is nothing to install: it has zero npm dependencies and needs only Node 22+.

- **Web chat:** `npm start`, then open http://localhost:3000.
- **Terminal:** `npm run cli`. Type `/model claude` or `/model muse` to switch.
- **Telegram:** set `TELEGRAM_BOT_TOKEN` and `npm start` serves the bot too.

To enable the live switch on the web page, set both `META_API_KEY` and `ANTHROPIC_API_KEY`, plus an `ADMIN_TOKEN`.

### Sandbox numbers

Every chat starts with ₦5,000 of demo credit. Deliveries are simulated by [`src/fulfilment/sandbox.js`](src/fulfilment/sandbox.js), and the last four digits of a phone, meter or smartcard number trigger the failure paths:

| Ends in | Outcome |
|---|---|
| anything else | Delivered, with a reference (and a token for prepaid electricity) |
| `0000` | Account not found on lookup |
| `9999` | Provider declines, order refunded automatically |
| `7777` | Provider times out, money held for review, not refunded |

A good demo script: ask for your balance, buy ₦500 MTN airtime for `08031234567`, then buy airtime for `08031239999` and watch the refund land in your wallet.

## Architecture

```
web chat / Telegram / CLI
          │
   conversations.js ── per-user history, one turn at a time per user
          │
     agent/turn.js ──── model ⇄ tools loop, max 6 steps
       │        │
model/client.js  agent/executor.js ── validation, one-money-action rule, timeouts
 Muse ⇄ Claude          │
 switch + failover   agent/tools/* ── quote-only purchase tools, reads, confirm
                        │
               orders/checkout.js ── quote → confirm (debit) → fulfil → deliver / refund / review
                │               │
        wallet/ledger.js   fulfilment/sandbox.js
```

More detail in [docs/architecture.md](docs/architecture.md).

## Tests

```bash
npm test
```

34 tests on Node's built-in runner. The model is stubbed and there is no network access: the full purchase lifecycle, same-turn confirmation refusal, double-confirm idempotency, refunds, the review path, cross-user isolation, executor rules, the Muse request shape, the switch, failover, and the HTTP surface.

## Scope

This is the agent core, not the whole ASAP product. The production service runs on WhatsApp with real payment and fulfilment partners, identity verification and account controls, and these are intentionally not part of this repository. Here fulfilment is simulated, wallets live in memory, and no real money moves.

## License

MIT, see [LICENSE](LICENSE).
