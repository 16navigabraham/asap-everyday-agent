<p align="center">
  <img src="docs/assets/icon.svg" width="96" height="96" alt="ASAP icon">
</p>

<h1 align="center">ASAP Everyday Agent</h1>

<p align="center">
  Everyday errands in Nigeria over plain chat, built on <strong>Meta Muse Spark</strong>.
  <br>
  Airtime, bills, food, rides, flights and payments, with no app, no menus, and no money moving until you say yes.
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

Daily life in Nigeria runs on a pile of small, separate errands, each with its own app, USSD code or phone call: topping up your mum's line, buying data, paying the light bill before the power goes, renewing GOtv, ordering lunch, booking a ride, paying the driver, getting a flight to Abuja. They're frequent and fiddly, and a single wrong digit on a meter number sends your money to a stranger with no way back.

ASAP turns each of these into one chat message to an agent running on **Meta Muse Spark**. Muse works out what you mean, checks what needs checking (whose meter, which merchant delivers to you, whether that account really belongs to your driver), shows you the total, and only charges you once you say yes.

This repository is the open-source core of ASAP's agent. It runs end to end against a built-in sandbox, so anyone can try every errand without real money or partner accounts.

## What it does

| Errand | What you say | What happens |
|---|---|---|
| Airtime and data | *"₦500 MTN for 08031234567"* | Quote, confirm, delivered. The number is saved for next time |
| Electricity | *"Pay ₦3,000 on my Ikeja prepaid meter"*, or send a **photo** of the meter | Account name checked first; prepaid returns a 20-digit token |
| TV | *"Renew my GOtv Jinja"* | Smartcard name checked, plan from the live list |
| Food and goods | *"I'm in Yaba, I want jollof rice"* | Merchants who deliver to you, photos, a one-merchant basket, one delivery fee |
| Rides | *"Ride from Yaba to Lekki Phase 1"* | Fare estimate and booking fee, a driver assigned, cancellable before pickup |
| Paying the driver | *"Pay the driver ₦4,000 by transfer"* | Only to an account that resolves to *your* assigned driver's name |
| Flights | *"Lagos to Abuja next Friday, 2 of us"* | Numbered options, pick one, confirm, booking reference |
| Sending credit | *"Send ₦1,000 to 08012345678"* | Only to existing ASAP users, with its own confirmation step |
| Funding | *"Add ₦5,000"* or *"Can I pay with USDC?"* | Bank transfer to your account number, or a USDC address on Base, Solana or Polygon |
| Your money | *"What did I spend this month?"* | Live order status, wallet movements, spending by category |

It handles English and Pidgin, remembers your name, area and saved numbers ("my usual", "Mum's line"), and asks exactly one question when something is missing instead of guessing.

## Built on Meta Muse Spark

Every turn is answered by **Muse Spark** through the **Meta Model API**. Meta's API uses the Messages wire format, so the agent calls it with plain `fetch`, no SDK (see [`src/model/muse.js`](src/model/muse.js)):

```js
POST https://api.meta.ai/v1/messages
authorization: Bearer $META_API_KEY

{ model: "muse-spark-1.1", system, tools, messages,
  thinking: { type: "adaptive" }, output_config: { effort: "low" } }
```

What Muse Spark does in this agent:

- **Plans multi-step errands as tool calls.** Paying a light bill is: look up the meter, show the name, wait for a yes, quote, wait for another yes, confirm. A food order is: search, add items, ask for the address, price, confirm. Muse chooses and sequences 29 tools.
- **Reads photos.** Send a picture of a meter, bill or smartcard and Muse reads the number off it, repeats it back, and uses it once you confirm. The image goes to Muse as an image block in that turn only; history keeps a note instead of the bytes.
- **Reasons before acting.** Muse Spark always reasons, so the effort is pinned to `low`. Left unbounded, it can spend the whole token budget thinking and return no text.

A transient failure (network, timeout, 429, 5xx) is retried once. A failed call produced no tool calls, so a retry can never repeat an action.

## Money safety, enforced in code

Muse decides *what* the user wants. The code decides whether money moves. Every rule below is enforced in code and covered by a test:

1. **Tools that cost money only quote.** Airtime, data, bills, `place_order`, `request_ride`, `pay_driver`, `choose_option` and `share_credits` all store an order in `quoted` and charge nothing.
2. **Quote and confirmation can never happen in the same turn.** The user always sees the total before the debit, even if the model tries to chain them.
3. **One money action per model response.** If the model asks for a second, it is refused.
4. **Separate confirmation for sending credit.** `confirm_purchase` cannot send a share, and `confirm_share` cannot charge a purchase.
5. **Arguments are validated in-process** against each tool's schema plus bounds (amount limits, Nigerian numbers, meter and account formats) before any handler runs.
6. **An idempotent ledger.** Every debit, refund and deposit has a unique reference, so a retried confirmation charges once.
7. **Refunds need proof of failure.** A provider decline refunds automatically. An unknown outcome holds the money in `needs_review`, because refunding something that might have been delivered pays out twice.
8. **Checks before paying a person.** Electricity and TV show the registered name first, driver transfers must resolve to the assigned driver's name, and shares only go to real ASAP users.
9. **Honest failure reporting.** When a tool throws, Muse never sees the raw error. It gets a fixed instruction: the action did not run and must not be described as successful, or, for a lookup, it doesn't know the answer and must say so.
10. **Masked saved numbers.** Saved phone and meter numbers reach the model masked. A purchase resolves the real number from its id, server-side.

## Try it

```bash
git clone https://github.com/16navigabraham/asap-everyday-agent.git
cd asap-everyday-agent
cp .env.example .env        # add META_API_KEY
npm start                   # http://localhost:3000
```

There is nothing to install: it has zero npm dependencies and needs only Node 22+.

- **Web chat** (best for trying everything, including photos): `npm start`, then open http://localhost:3000.
- **Terminal:** `npm run cli`.
- **Telegram:** set `TELEGRAM_BOT_TOKEN`, and `npm start` serves the bot too, photos included.

### The sandbox

Every chat starts with ₦10,000 of demo credit. Merchants, drivers, flights, names and references are invented by [`src/fulfilment/sandbox.js`](src/fulfilment/sandbox.js). The last four digits of a phone, meter, smartcard or account number trigger the failure paths:

| Ends in | Outcome |
|---|---|
| anything else | Delivered, with a reference (and a token for prepaid electricity) |
| `0000` | Not found on lookup |
| `9999` | Provider declines, order refunded automatically |
| `7777` | Provider times out, money held for review, not refunded |

Other sandbox details: merchants deliver to Yaba, Surulere, Ikeja, Lekki, VI, Ikoyi and Ajah. Credit can be shared with `08012345678`, `08098765432` or `07011112222`. Flights cover Lagos, Abuja, Port Harcourt, Kano, Enugu, Owerri, Calabar, Uyo, Benin and Asaba.

**Demo script:** check the balance; buy ₦500 airtime for `08031234567`; send a photo of a meter and pay it; order jollof rice in Yaba and ask for a photo; book a ride and cancel it to see the fee refunded; buy airtime for `08031239999` to see an automatic refund.

## Architecture

```
web chat (text + photos) / Telegram / CLI
          │
   conversations.js ── per-user history, one turn at a time per user, photos dropped after their turn
          │
     agent/turn.js ──── Muse Spark ⇄ tools loop, max 8 steps
       │        │
 model/muse.js  agent/executor.js ── validation, one-money-action rule, timeouts, safe errors
 Meta Model API         │
                  agent/tools/ ── account · bills · shop · rides · travel · orders
                        │
               orders/checkout.js ── quote → confirm (debit) → fulfil → delivered / assigned / refunded / review
                │          │            │
        wallet/ledger.js  users/profile.js  fulfilment/sandbox.js
```

More detail in [docs/architecture.md](docs/architecture.md).

## Tests

```bash
npm test
```

51 tests on Node's built-in runner, with Muse stubbed and no network access. They cover every errand end to end, same-turn confirmation refusal, double-confirm idempotency, refunds and the review path, ride cancellation rules, driver-name checks, share isolation, saved-number masking, simulated deposits, photo handling, the Muse request shape and retry, executor rules, and the HTTP surface.

## Scope

This is the agent core, not the whole ASAP product. The production service runs on WhatsApp with real payment and fulfilment partners, identity verification, account security and internal operations tooling, none of which is part of this repository. Here fulfilment is simulated, data lives in memory, and no real money moves.

## License

MIT, see [LICENSE](LICENSE).
