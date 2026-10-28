/**
 * Checks on rescheduleDiscountPct — a session from a discounted bundle
 * (4+ sessions 10% off, 8+ 15% off) keeps its discount when it's moved to
 * another group session, so moving it costs nothing extra.
 *
 * Rows here have no booking_batch_id, so no database is touched:
 *   npx tsx tools/test-bulk-reschedule-discount.mjs
 *
 * The case that started it (2026-10-28): clients rescheduling one session of
 * a discounted bundle were charged "the rest of the price". The bundle was
 * re-counted at reschedule time; once one of its sessions had been
 * no-showed or cancelled by the trainer, the count fell below 4 and the
 * discount vanished.
 */
import { rescheduleDiscountPct, computeRescheduleMoney } from "../src/lib/booking-finalize.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
const row = (o) => ({ id: "r", type: "weekly", session_price: 45, full_session_price: 50, is_bulk_discounted: true, booking_batch_id: null, total_participants: 1, booked_group: "Varsity", booked_date: "11/4/2026", booked_start_time: "6:00 PM", is_free: false, ...o });
// What an on-time move to another session at `newFull` costs (card-paid).
const move = async (r, newFull) => {
  const pct = await rescheduleDiscountPct(r);
  const newPrice = Math.round(newFull * (1 - pct) * 100) / 100;
  const m = computeRescheduleMoney({ stripePaidAmount: r.session_price, creditPaidAmount: 0, oldFullPrice: r.full_session_price ?? r.session_price, isLate: false, newPriceKnown: true, newEffectivePrice: newPrice, bulkBasisAmount: null });
  return { pct, kind: m.kind, amount: m.amount };
};

console.log("\nkeeps the discount it was bought at");
check("10% bundle ($45 of $50) moved to another $50 session: nothing owed", await move(row({}), 50), { pct: 0.1, kind: "none", amount: 0 });
check("15% bundle ($42.50 of $50) moved to another $50 session: nothing owed", await move(row({ session_price: 42.5 }), 50), { pct: 0.15, kind: "none", amount: 0 });
check("old booking with no full price stored: still at least 10%, nothing owed", await move(row({ full_session_price: null }), 50), { pct: 0.1, kind: "none", amount: 0 });
check("2 kids, 10% ($90 of $100): nothing owed", await move(row({ session_price: 90, full_session_price: 100, total_participants: 2 }), 100), { pct: 0.1, kind: "none", amount: 0 });

console.log("\na different group's price still counts (at the same discount)");
check("10% bundle moved to a $30 session: refund the difference ($45 -> $27)", await move(row({}), 30), { pct: 0.1, kind: "refund", amount: 18 });

console.log("\nnot from a discounted bundle: unchanged");
check("single $50 session: no discount, nothing owed for a $50 move", await move(row({ session_price: 50, is_bulk_discounted: false }), 50), { pct: 0, kind: "none", amount: 0 });

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
