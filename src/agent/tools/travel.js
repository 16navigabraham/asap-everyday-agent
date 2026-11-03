"use strict";

const { defineTool } = require("./define");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const profile = require("../../users/profile");
const { naira } = require("../../money");

/** Flights: search, show numbered options, quote the one they pick. */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPTIONS_TTL_MS = 30 * 60_000;

const requestService = defineTool({
  name: "request_service",
  kind: "read",
  description:
    "Search flights within Nigeria. Needs origin city, destination city and date (YYYY-MM-DD); ask for whatever " +
    "is missing. Returns numbered options with prices; nothing is booked or charged. Hotels are not available: " +
    "say so. Never use this for a ride; that is request_ride.",
  properties: {
    kind: { type: "string", enum: ["flight", "hotel"] },
    from: { type: "string" },
    to: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD" },
    passengers: { type: "integer" },
  },
  required: ["kind"],
  validate: ({ date, passengers }) => {
    if (date !== undefined && !DATE.test(date)) return "Dates are YYYY-MM-DD.";
    if (date !== undefined && Date.parse(`${date}T23:59:59Z`) < Date.now()) return "That date has already passed.";
    if (passengers !== undefined && (passengers < 1 || passengers > 6)) return "Between 1 and 6 passengers.";
    return null;
  },
  handler: ({ kind, from, to, date, passengers = 1 }, ctx) => {
    if (kind === "hotel") return { ok: false, reason: "unavailable", message: "Hotel booking is not available yet. Say so plainly." };
    const missing = [!from && "origin city", !to && "destination city", !date && "date"].filter(Boolean);
    if (missing.length) return { ok: false, reason: "missing_details", message: `Ask for: ${missing.join(", ")}.` };

    const flights = sandbox.searchFlights({ from, to, date });
    if (!flights) return { ok: false, reason: "route_not_served", message: "No flights between those cities. Domestic routes only." };

    profile.get(ctx.userId).options = { kind: "flight", passengers, items: flights, expiresAt: Date.now() + OPTIONS_TTL_MS };
    return {
      ok: true,
      passengers,
      options: flights.map((f, i) => ({
        position: i + 1,
        airline: f.airline,
        route: f.route,
        date: f.date,
        departs: f.depart,
        arrives: f.arrive,
        pricePerPassenger: naira(f.priceKobo),
      })),
      message: "Show these as a numbered list. When they pick one, call choose_option with its position.",
    };
  },
});

const chooseOption = defineTool({
  name: "choose_option",
  kind: "money",
  description:
    "The user clearly picked one of the numbered flight options ('the second one', 'the Air Peace one'). Pass its " +
    "position. Produces a quote they still have to confirm; charges nothing. If they are still asking questions, answer instead.",
  properties: { position: { type: "integer" } },
  required: ["position"],
  handler: ({ position }, ctx) => {
    const options = profile.get(ctx.userId).options;
    if (!options || Date.now() > options.expiresAt) {
      return { ok: false, reason: "no_options", message: "Those options have expired or were never shown. Search again." };
    }
    const flight = options.items[position - 1];
    if (!flight) return { ok: false, reason: "bad_position", message: `Pick a number from 1 to ${options.items.length}.` };

    const pax = options.passengers;
    return checkout.quote({
      ctx,
      kind: "flight",
      params: { ...flight, passengers: pax },
      principalKobo: flight.priceKobo * pax,
      summary: `${flight.airline} ${flight.route}, ${flight.date} ${flight.depart}, ${pax} passenger${pax > 1 ? "s" : ""}`,
    });
  },
});

module.exports = [requestService, chooseOption];
