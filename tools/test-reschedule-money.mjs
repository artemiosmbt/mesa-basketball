/**
 * Checks on computeRescheduleMoney — the math that decides what a client owes
 * (or gets back) when they move a session.
 *
 * Pure function, so this runs with no database, no Stripe and no mocks:
 *   npx tsx tools/test-reschedule-money.mjs
 *
 * The case that started it (2026-09-18): a $50 weekly group paid entirely with
 * account credit, switched to a $125 private. The old code collected nothing
 * because there was no card charge on the row, and handed the $50 back on top.
 */
import { computeRescheduleMoney } from "../src/lib/booking-finalize.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
const shape = (r) => ({ kind: r.kind, amount: r.amount, carried: r.creditCarriedForward });

console.log("\nthe real case: $50 group paid with account credit -> $125 private");
check(
  "on time: charge the $75 difference and carry the $50 forward",
  shape(computeRescheduleMoney({
    stripePaidAmount: 0, creditPaidAmount: 50, oldFullPrice: 50,
    isLate: false, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "charge", amount: 75, carried: 50 }
);
check(
  "late: $25 fee kept, $25 credited on, so $100 is owed",
  shape(computeRescheduleMoney({
    stripePaidAmount: 0, creditPaidAmount: 50, oldFullPrice: 50,
    isLate: true, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "charge", amount: 100, carried: 0 }
);

console.log("\ncard-paid bookings behave as they always did");
check(
  "same price, same type: nothing moves",
  shape(computeRescheduleMoney({
    stripePaidAmount: 125, creditPaidAmount: 0, oldFullPrice: 125,
    isLate: false, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "none", amount: 0, carried: 0 }
);
check(
  "cheaper session on time: the difference goes back",
  shape(computeRescheduleMoney({
    stripePaidAmount: 125, creditPaidAmount: 0, oldFullPrice: 125,
    isLate: false, newPriceKnown: true, newEffectivePrice: 50,
  })),
  { kind: "refund", amount: 75, carried: 0 }
);
check(
  "pricier session on time: charge the difference",
  shape(computeRescheduleMoney({
    stripePaidAmount: 50, creditPaidAmount: 0, oldFullPrice: 50,
    isLate: false, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "charge", amount: 75, carried: 0 }
);
check(
  "late, card-paid: half the old full price is kept, the rest credits on",
  shape(computeRescheduleMoney({
    stripePaidAmount: 125, creditPaidAmount: 0, oldFullPrice: 125,
    isLate: true, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "charge", amount: 62.5, carried: 0 }
);

console.log("\npart card, part credit");
check(
  "$75 card + $50 credit on a $125 session -> free move to another $125",
  shape(computeRescheduleMoney({
    stripePaidAmount: 75, creditPaidAmount: 50, oldFullPrice: 125,
    isLate: false, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "none", amount: 0, carried: 50 }
);
check(
  "same, moving to a $50 group: $75 back, $50 still riding on the session",
  shape(computeRescheduleMoney({
    stripePaidAmount: 75, creditPaidAmount: 50, oldFullPrice: 125,
    isLate: false, newPriceKnown: true, newEffectivePrice: 50,
  })),
  { kind: "refund", amount: 75, carried: 50 }
);

console.log("\na cheaper session, paid with credit");
check(
  "$50 credit group -> $30 pickup: nothing handed back, $30 rides on the session",
  shape(computeRescheduleMoney({
    stripePaidAmount: 0, creditPaidAmount: 50, oldFullPrice: 50,
    isLate: false, newPriceKnown: true, newEffectivePrice: 30,
  })),
  { kind: "none", amount: 0, carried: 30 }
);
check(
  "the leftover stays spendable, it is not credited twice",
  (() => {
    const r = computeRescheduleMoney({
      stripePaidAmount: 0, creditPaidAmount: 50, oldFullPrice: 50,
      isLate: false, newPriceKnown: true, newEffectivePrice: 30,
    });
    // settlement returns the old $50, we take back only what the new session uses
    const balanceAfter = 50 - r.creditCarriedForward + (r.kind === "refund" ? r.amount : 0);
    return { balanceAfter, onTheSession: r.creditCarriedForward };
  })(),
  { balanceAfter: 20, onTheSession: 30 }
);

console.log("\nnothing was ever collected");
check(
  "unpaid group -> private: the whole new price is owed",
  shape(computeRescheduleMoney({
    stripePaidAmount: 0, creditPaidAmount: 0, oldFullPrice: 50,
    isLate: false, newPriceKnown: true, newEffectivePrice: 125,
  })),
  { kind: "charge", amount: 125, carried: 0 }
);
check(
  "unknown new price (camp): nothing is decided here",
  shape(computeRescheduleMoney({
    stripePaidAmount: 50, creditPaidAmount: 0, oldFullPrice: 50,
    isLate: false, newPriceKnown: false,
  })),
  { kind: "none", amount: 0, carried: 0 }
);

console.log("\nbulk-discount settlement overrides the collected total");
check(
  "settlement says $30 is the baseline, new session is $50",
  shape(computeRescheduleMoney({
    stripePaidAmount: 45, creditPaidAmount: 0, oldFullPrice: 50, bulkBasisAmount: 30,
    isLate: false, newPriceKnown: true, newEffectivePrice: 50,
  })),
  { kind: "charge", amount: 20, carried: 0 }
);

console.log("\nno free upgrades, ever");
for (const creditPaid of [0, 25, 50, 125]) {
  for (const stripePaid of [0, 50, 125]) {
    for (const isLate of [false, true]) {
      const r = computeRescheduleMoney({
        stripePaidAmount: stripePaid, creditPaidAmount: creditPaid, oldFullPrice: 50,
        isLate, newPriceKnown: true, newEffectivePrice: 125,
      });
      const covered = isLate ? r.lateFeeCreditApplied : Math.min(stripePaid + creditPaid, 125);
      const owed = Math.round((125 - covered) * 100) / 100;
      const collecting = r.kind === "charge" ? r.amount : 0;
      if (Math.abs(collecting - owed) > 0.005) {
        failures++;
        console.log(`  FAIL credit ${creditPaid}, card ${stripePaid}, late ${isLate}: collecting ${collecting}, should be ${owed}`);
      }
    }
  }
}
console.log("  ok   every combination of card/credit/late collects exactly what is left owing");

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
