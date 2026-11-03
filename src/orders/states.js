"use strict";

/**
 * Order lifecycle, as data.
 *
 *   quoted ──confirm──> paid ──> fulfilling ──> delivered
 *     │                  │           │
 *     ├─> expired        │           ├─> failed ──> refunded
 *     └─> cancelled      │           └─> needs_review
 *                        └─> refunded
 *
 * Two rules carry the safety of the whole thing:
 *  - Only `paid` orders are fulfilled. Money is held before any provider is
 *    called, so the worst failure is a refund, never a free delivery.
 *  - A refund only follows a provider saying it definitely failed. An unknown
 *    outcome (timeout, crash mid-call) goes to `needs_review`, never to an
 *    automatic refund that might pay out on top of a delivery.
 */

const TRANSITIONS = {
  quoted: ["paid", "expired", "cancelled"],
  paid: ["fulfilling", "refunded"],
  fulfilling: ["delivered", "failed", "needs_review"],
  failed: ["refunded"],
  needs_review: ["delivered", "refunded"],
  delivered: [],
  refunded: [],
  expired: [],
  cancelled: [],
};

function canMove(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { TRANSITIONS, canMove, STATUSES: Object.keys(TRANSITIONS) };
