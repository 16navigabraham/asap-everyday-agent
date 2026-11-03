"use strict";

const { defineTool } = require("./define");
const { normalisePhone } = require("./phone");
const sandbox = require("../../fulfilment/sandbox");
const checkout = require("../../orders/checkout");
const store = require("../../orders/store");
const { naira } = require("../../money");

/**
 * Rides. ASAP charges only its own flat booking fee; the fare goes to the
 * driver directly at the end of the trip, in cash or by bank transfer.
 */

const requestRide = defineTool({
  name: "request_ride",
  kind: "money",
  description:
    "Book a ride now. Get the pickup and drop-off first. Returns a fare estimate and ASAP's booking fee to confirm; " +
    "nothing is booked or charged until confirm_purchase. The fare itself is paid to the driver, never through " +
    "ASAP. Only pass name/phone when the ride is for someone else.",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    noteToDriver: { type: "string" },
    riderName: { type: "string" },
    riderPhone: { type: "string" },
  },
  required: ["from", "to"],
  validate: ({ from, to, riderPhone }) => {
    if (from.trim().length < 3 || to.trim().length < 3) return "Ask for a clearer pickup and drop-off.";
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) return "Pickup and drop-off are the same place.";
    if (riderPhone !== undefined && !normalisePhone(riderPhone)) return "That is not a Nigerian mobile number.";
    return null;
  },
  handler: ({ from, to, noteToDriver, riderName, riderPhone }, ctx) => {
    const estimate = sandbox.estimateRide(from, to);
    return checkout.quote({
      ctx,
      kind: "ride",
      params: {
        from: from.trim(),
        to: to.trim(),
        etaMinutes: estimate.etaMinutes,
        noteToDriver: noteToDriver || null,
        riderName: riderName || null,
        phone: riderPhone ? normalisePhone(riderPhone) : null,
      },
      principalKobo: sandbox.RIDE_BOOKING_FEE_KOBO,
      feeKobo: 0,
      summary: `Ride from ${from.trim()} to ${to.trim()}`,
      extra: {
        bookingFee: naira(sandbox.RIDE_BOOKING_FEE_KOBO),
        fareEstimate: `${naira(estimate.fareLowKobo)} to ${naira(estimate.fareHighKobo)}, paid to the driver`,
        distanceKm: estimate.km,
        driverEtaMinutes: estimate.etaMinutes,
      },
    });
  },
});

const cancelRide = defineTool({
  name: "cancel_ride",
  kind: "money",
  description:
    "Cancel a ride booked with request_ride, before pickup. Refunds the booking fee once a driver was assigned. " +
    "After pickup it is refused, and this says so.",
  properties: { orderId: { type: "integer" } },
  required: ["orderId"],
  handler: ({ orderId }, ctx) => checkout.cancelRide({ orderId, ctx }),
});

const payDriver = defineTool({
  name: "pay_driver",
  kind: "money",
  description:
    "Quote paying a ride's driver by bank transfer instead of cash, once a driver is assigned. The account must " +
    "resolve to the assigned driver's name, or this refuses and they should pay cash. Charges nothing by itself.",
  properties: {
    orderId: { type: "integer", description: "The ride's orderId." },
    accountNumber: { type: "string" },
    amountNaira: { type: "integer" },
  },
  required: ["orderId", "accountNumber", "amountNaira"],
  validate: ({ accountNumber, amountNaira }) => {
    if (!/^\d{10}$/.test(accountNumber)) return "Bank account numbers are 10 digits.";
    if (amountNaira < 500 || amountNaira > 100_000) return "A driver payment is NGN 500 to NGN 100,000.";
    return null;
  },
  handler: ({ orderId, accountNumber, amountNaira }, ctx) => {
    const ride = store.get(orderId, ctx.userId);
    if (!ride || ride.kind !== "ride") return { ok: false, reason: "not_found", message: "No such ride for this user." };
    if (!["assigned", "delivered"].includes(ride.status)) {
      return { ok: false, reason: `ride_${ride.status}`, message: "There is no assigned driver on this ride to pay." };
    }

    const driver = ride.result.driver;
    const account = sandbox.resolveAccount(accountNumber);
    if (!account.found || account.name !== driver.name) {
      return {
        ok: false,
        reason: "name_mismatch",
        message: `This account does not belong to the assigned driver, ${driver.name}. Nothing was quoted: tell them to pay cash or check the number with the driver.`,
      };
    }

    return checkout.quote({
      ctx,
      kind: "driver_payment",
      params: { rideOrderId: ride.id, accountNumber, accountName: account.name },
      principalKobo: amountNaira * 100,
      summary: `${naira(amountNaira * 100)} transfer to driver ${account.name}`,
    });
  },
});

module.exports = [requestRide, cancelRide, payDriver];
