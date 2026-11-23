/**
 * Checks computePlayerEditPricing (src/lib/booking-finalize.ts) — what removing
 * or adding a player on a booking costs. The schedule sheet is faked; nothing
 * real is touched.
 *
 *   npx tsx --test --experimental-test-module-mocks tools/test-player-edit-late.mjs
 *
 * The case that started it (2026-11-23): a parent with two kids in a $50 group
 * removed one inside 24 hours. He was sent to pay a $25 late fee by card and
 * the $50 he'd paid for that child was never credited back: $125 paid for $75
 * of charges. The late fee now comes out of what was paid for that child, the
 * rest is credited, and no new card charge is needed.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let sheetPrice = 50;
mock.module("@/lib/sheets", { namedExports: {
  getWeeklySchedule: async () => [SOON, LATER].map((t) => ({ group: "Middle School", date: t.date, startTime: t.time, price: sheetPrice, maxSpots: 12 })),
  parseTimeToMins: (t) => { const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i); let h = +m[1] % 12; if (/PM/i.test(m[3])) h += 12; return h * 60 + +m[2]; },
} });

// A session a few hours from now (late) and one a week out (on time), in ET.
function etParts(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  return { date, time };
}
const SOON = etParts(Date.now() + 5 * 3600e3);
const LATER = etParts(Date.now() + 7 * 24 * 3600e3);

const { computePlayerEditPricing } = await import("../src/lib/booking-finalize.ts");

const row = (o = {}) => ({
  id: "r", type: "weekly", status: "confirmed", kids: "Alex (10), Sam (12)", total_participants: 2, session_price: 100,
  booked_group: "Middle School", booked_date: SOON.date, booked_start_time: SOON.time, booked_end_time: SOON.time,
  stripe_payment_intent_id: "pi_1", is_paid: false, is_free: false, applied_account_credit: 0,
  created_at: "2026-11-01T00:00:00Z", admin_change_at: null, ...o,
});
const pick = (p) => ({ isLate: p.isLate, lateFeeDue: p.lateFeeDue, owed: p.totalOwedViaCheckout, credit: p.creditDue, covered: p.lateFeeCovered, newPrice: p.newPrice });

test("the reported case: 2 kids at $50, one removed late — no card charge, $25 fee kept, $25 credited", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row(), ["Alex (10)"]);
  assert.deepEqual(pick(p), { isLate: true, lateFeeDue: 25, owed: 0, credit: 25, covered: true, newPrice: 50 });
});

test("same removal on time — no fee, the full $50 credited", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row({ booked_date: LATER.date, booked_start_time: LATER.time }), ["Alex (10)"]);
  assert.equal(p.isLate, false);
  assert.equal(p.totalOwedViaCheckout, 0);
  assert.equal(p.creditDue, 50);
});

test("late removal from a $30 group: fee is 50% ($15), $15 credited — not a flat $25", async () => {
  sheetPrice = 30;
  const p = await computePlayerEditPricing(row({ session_price: 60 }), ["Alex (10)"]);
  assert.deepEqual(pick(p), { isLate: true, lateFeeDue: 15, owed: 0, credit: 15, covered: true, newPrice: 30 });
});

test("late swap (one removed, one added) — the fee is still owed, and charged", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row(), ["Alex (10)", "Jo (9)"]);
  assert.equal(p.totalOwedViaCheckout, 25);
  assert.equal(p.creditDue, 0);
});

test("adding a player (on time) — the extra $50 is charged, nothing credited", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row({ booked_date: LATER.date, booked_start_time: LATER.time, kids: "Alex (10)", total_participants: 1, session_price: 50 }), ["Alex (10)", "Jo (9)"]);
  assert.equal(p.totalOwedViaCheckout, 50);
  assert.equal(p.creditDue, 0);
});

test("unpaid (cash) booking, late removal — fee still shown as owed, no credit", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row({ stripe_payment_intent_id: null }), ["Alex (10)"]);
  assert.equal(p.lateFeeDue, 25);
  assert.equal(p.lateFeeCovered, false);
  assert.equal(p.creditDue, 0);
});

test("partly paid with account credit ($40 credit, $60 card), late removal — credited what was paid minus the fee", async () => {
  sheetPrice = 50;
  const p = await computePlayerEditPricing(row({ applied_account_credit: 40 }), ["Alex (10)"]);
  // oldAmount 60 (card), newAmount 50-40 = 10 → decrease 50, fee 25 → credit 25
  assert.equal(p.totalOwedViaCheckout, 0);
  assert.equal(p.creditDue, 25);
});
