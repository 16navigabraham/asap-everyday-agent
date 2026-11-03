<p align="center">
  <img src="docs/assets/icon.svg" width="96" height="96" alt="ASAP icon">
</p>

<h1 align="center">ASAP</h1>

<p align="center">
  <strong>Making AI agents accessible through local languages.</strong>
  <br>
  Send a voice note or a text in Yoruba, Hausa, Igbo, Pidgin or English, and an agent built on <strong>Meta Muse Spark</strong> gets the errand done.
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

AI agents can now do real things: buy, order, book and pay. But almost every agent experience assumes you can comfortably type instructions in English. Across Africa, millions of people live their lives in Yoruba, Hausa, Igbo, Pidgin and hundreds of other languages. Many understand some English but struggle to type a request, explain something complex, or talk to an AI system at all. They aren't short of needs or ideas. The technology just hasn't adapted to the way they speak.

Language should not be the barrier to AI.

## What ASAP does

ASAP lets people speak naturally, in their own language, on platforms they already use, starting with WhatsApp, and hand everyday tasks to an AI agent. Someone records a voice note in Yoruba asking for rice to be delivered, or types in Hausa to top up a line. **Muse Spark** understands the request in that language, works out the intent, uses ASAP's connected tools and services to carry it out, and answers in the same language.

Every task that costs money follows the same path: Muse checks what needs checking (whose meter, which merchant delivers to you, whether an account really belongs to your driver), shows the total in your language, and only charges your prepaid ASAP wallet once you say yes, in any language.

We want AI that does more than understand and respond: AI that understands people in the languages they naturally speak, and takes meaningful action on their behalf.

## ASAP today

ASAP is a live product by ZELABS LTD ([useasap.xyz](https://useasap.xyz)), and it reaches people wherever they already are:

- **WhatsApp:** the main channel. Chat with ASAP like any other contact.
- **Telegram:** the same agent as a Telegram bot.
- **Web app:** an installable app at app.useasap.xyz, for chatting with ASAP from any browser.
- **Your own AI assistant:** an MCP server, so Claude, ChatGPT or any MCP-capable assistant can run ASAP errands for you.

Behind the chat is a two-sided marketplace. Local merchants (restaurants, bakeries, grocers, gadget shops) list what they sell on the ASAP merchant dashboard, receive orders, deliver, and get paid out. Affiliates earn by referring new users.

## This repository

This is ASAP's agent server, rebuilt on Muse Spark for this hackathon. Every channel above sits on top of what this repo contains: one agent, one set of tools, and one set of money rules. This server serves the same agent on:

- **WhatsApp**, through Meta's WhatsApp Cloud API: Muse Spark answering on WhatsApp, Meta's model on Meta's messaging platform.
- **MCP**, so Claude, ChatGPT or any MCP-capable assistant can run ASAP errands, with confirming a charge marked as an action that needs the person's approval.
- **Telegram**, as a bot.
- **An HTTP API** for any other client (a mobile app, a web app), and a terminal CLI.

It ships with a built-in test mode, so judges can run every errand themselves in minutes: no sign-up, no bank account and no partner keys, just a Meta API key.

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
| Funding the wallet | *"Add ₦5,000"* | Bank transfer to your own account number. A stablecoin deposit is also accepted and converted to naira on arrival |
| Your money | *"What did I spend this month?"* | Live order status, wallet movements, spending by category |

It speaks the way people here speak: Yoruba, Hausa, Igbo, Nigerian Pidgin and English, or a mix, replying in the user's own language while keeping every amount and number in digits. It remembers your name, area and saved numbers ("my usual", "Mum's line"), and asks exactly one question when something is missing instead of guessing.

## Built on Meta Muse Spark

Every turn is answered by **Muse Spark** through the **Meta Model API**. Meta's API uses the Messages wire format, so the agent calls it with plain `fetch`, no SDK (see [`src/model/muse.js`](src/model/muse.js)):

```js
POST https://api.meta.ai/v1/messages
authorization: Bearer $META_API_KEY

{ model: "muse-spark-1.1", system, tools, messages,
  thinking: { type: "adaptive" }, output_config: { effort: "low" } }
```

What Muse Spark does in this agent:

- **Understands local languages.** Yoruba, Hausa, Igbo, Nigerian Pidgin and English, or a mix in one message. Muse replies in the language the user is using, switches when they switch, and never asks them to use English. Amounts and numbers always stay in digits, and before money moves Muse states the amount and the recipient and waits for a clear yes ("bẹ́ẹ̀ni", "eh", "ee", "toh", "na so", "yes").
- **Hears voice notes.** A voice note from WhatsApp, Telegram or the API goes to Muse Spark with a strict instruction: transcribe verbatim, keep the language it was spoken in, don't translate, write numbers as digits. The transcript then enters the agent's turn as the user's own words, marked as speech, so Muse repeats back any amount or number it heard and confirms it before quoting. Transcription is a separate call with no tools, so audio can never trigger an action on its own.
- **Finds products by their local names.** *Ìrẹsì*, *shinkafa* and *osikapa* all find rice, with or without tone marks.
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

This repository is the server only. There is nothing to install: it has zero npm dependencies and needs only Node 22+.

```bash
git clone https://github.com/16navigabraham/asap-everyday-agent.git
cd asap-everyday-agent
cp .env.example .env        # add META_API_KEY
npm run demo                # watch a customer run errands on Muse Spark
```

**`npm run demo`** plays a scripted customer against the live agent on Muse Spark: they set a name, check the balance, buy airtime and confirm it, shop for jollof rice in Yaba, book a ride and cancel it, and try a number the provider declines. It prints every reply and every delivery or refund notification as it lands. Muse writes the replies, so the wording changes between runs; the money rules don't.

**`npm start`** serves the HTTP API on port 3000, which any client can use:

```bash
curl -s localhost:3000/          # service info: model, endpoints

curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"judge-0001","text":"Buy ₦500 MTN airtime for 08031234567"}'

curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"judge-0001","text":"Yes, go ahead"}'

curl -s 'localhost:3000/api/updates?sessionId=judge-0001'   # the delivery notification
```

To send a photo of a meter or bill, add `"image": {"mediaType": "image/jpeg", "data": "<base64>"}` to the chat body. To send a voice note, add `"audio": {"mediaType": "audio/ogg", "data": "<base64>"}` instead.

### Channels

**WhatsApp.** Create an app with the WhatsApp product in the Meta developer dashboard, then set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` and a `WHATSAPP_VERIFY_TOKEN` of your choice. Run `npm start` behind a public HTTPS URL, set the callback URL to `https://<your-host>/whatsapp/webhook` with the same verify token, and subscribe to the `messages` field. Text, voice notes and photos all work. Every delivery's `X-Hub-Signature-256` is checked against the app secret before anything runs, and Meta's retries of the same message are answered once.

**MCP.** `npm start` serves an MCP server at `/mcp` (Streamable HTTP). In Claude or ChatGPT, add a custom connector with the URL `https://<your-host>/mcp`. For a local check, any MCP client works:

```bash
npx @modelcontextprotocol/inspector   # connect to http://localhost:3000/mcp
```

The assistant gets the same tools ASAP's own agent uses, plus `get_updates` for deliveries and refunds. Read tools are annotated read-only, and `confirm_purchase`, `confirm_share` and `cancel_ride` are annotated destructive, so the assistant's host asks the person before money moves. Each session is its own test wallet; send `Authorization: Bearer <any key of 16+ characters>` to keep the same wallet across sessions.

**Telegram.** Set `TELEGRAM_BOT_TOKEN`, and `npm start` also serves the agent as a Telegram bot, photos included.

**Terminal.** `npm run cli`.

### Test mode

In test mode every chat starts with ₦10,000 of test credit, and the provider side (merchants, drivers, airlines, bill payments) is served by [`src/fulfilment/sandbox.js`](src/fulfilment/sandbox.js) instead of live partners. The agent, the money rules and the order lifecycle are the same either way. To see the failure handling on demand, the last four digits of a phone, meter, smartcard or account number pick the outcome:

| Ends in | Outcome |
|---|---|
| anything else | Delivered, with a reference (and a token for prepaid electricity) |
| `0000` | Not found on lookup |
| `9999` | Provider declines, order refunded automatically |
| `7777` | Provider times out, money held for review, not refunded |

Test-mode details: merchants deliver to Yaba, Surulere, Ikeja, Lekki, VI, Ikoyi and Ajah. Credit can be shared with `08012345678`, `08098765432` or `07011112222`. Flights cover Lagos, Abuja, Port Harcourt, Kano, Enugu, Owerri, Calabar, Uyo, Benin and Asaba.

## Architecture

```
WhatsApp (Cloud API) · MCP (Claude, ChatGPT, …) · Telegram · HTTP API · CLI
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

69 tests on Node's built-in runner, with Muse stubbed and no network access. They cover every errand end to end, voice notes (the Muse transcription request, the audio-format fallback, failure handling, WhatsApp and API voice paths), local-language product search, the WhatsApp webhook (handshake, signature check, retries, photos) and the MCP server (session, tool annotations, a full quote-confirm-deliver run, wallet isolation), same-turn confirmation refusal, double-confirm idempotency, refunds and the review path, ride cancellation rules, driver-name checks, share isolation, saved-number masking, wallet top-ups, photo handling, the Muse request shape and retry, executor rules, and the HTTP surface.

## Built during the hackathon

This repository existed before the hackathon as an earlier Python prototype (the October 2026 commit). Everything in the current code was written during the Meta Global AI Developer Hackathon: the rebuild on Muse Spark and the Meta Model API, the tool layer, every errand, the money-safety rules, the test mode, the demo and the tests. The commit history shows the full change.

## License

MIT, see [LICENSE](LICENSE).
