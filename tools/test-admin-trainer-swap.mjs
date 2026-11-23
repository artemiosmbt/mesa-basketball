/**
 * Runs the REAL admin reschedule route (src/app/api/admin/reschedule/route.ts)
 * with the database, Stripe, email/SMS and the schedule sheet faked, and checks
 * what it would charge. Nothing real is touched.
 *
 *   npx tsx --test --experimental-test-module-mocks tools/test-admin-trainer-swap.mjs
 *
 * The case that started it (2026-11-23): a client on Coach Zhaneia's package got
 * sick; Artemios moved her session onto himself as a placeholder from admin.
 * The route unlinked the session from her package (freeing a slot) and charged
 * her card Artemios's $150 rate — "Keep the same price" was ignored. Rule now:
 * a trainer swap made from admin never costs the client more.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state = { reg: null, update: null, charges: [], pkgUsed: 0, pkgType: 4, pkgMonth: "2026-11", setPackageSessions: [], late: false, topups: [] };

function chain(table) {
  const q = { _op: "select", _vals: null };
  const api = {
    select() { return api; },
    eq() { return api; },
    is() { return api; },
    update(v) { q._op = "update"; q._vals = v; return api; },
    single() { return Promise.resolve({ data: state.reg ? { ...state.reg } : null }); },
    then(res, rej) {
      if (table === "registrations" && q._op === "update") {
        if (!("admin_action_claim_token" in q._vals && Object.keys(q._vals).length === 1)) state.update = q._vals;
        return Promise.resolve({ data: [{ id: state.reg.id }], error: null }).then(res, rej);
      }
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    },
  };
  return api;
}
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => ({ from: (t) => chain(t) }) } });
mock.module("@/lib/auth", { namedExports: { verifyAdmin: async () => true, TRAINER_ACCOUNTS: [] } });
mock.module("@/lib/email", { namedExports: { sendRescheduleNotification: async () => {} } });
mock.module("@/lib/sms", { namedExports: { sendSMS: async () => {}, sendAdminSMS: async () => {}, formatDateWithDay: (d) => d, resolveLocationName: (l) => l } });
mock.module("@/lib/sheets", { namedExports: { getWeeklySchedule: async () => [] } });
mock.module("@/lib/trainer-notify", { namedExports: { notifyTrainerOfCancellation: async () => {}, notifyTrainerOfReschedule: async () => {}, notifyTrainerOfNewBooking: async () => {} } });
mock.module("@/lib/new-gym-server", { namedExports: { newGymNotes: async () => ({ sms: "", html: "" }) } });
const noop = async () => {};
mock.module("@/lib/supabase", { namedExports: {
  addAccountCredit: noop, deductAccountCredit: noop, setAppliedAccountCredit: noop, addReferralCredit: noop,
  addRegistration: async () => ({ manageToken: "forfeit" }), cancelRegistration: noop, logLateFeeEvent: noop,
  logRegistrationTopupCharge: async (t) => { state.topups.push(t); },
  getPackageById: async () => ({ id: "pkg", trainer_tier: "other", month_year: state.pkgMonth, package_type: state.pkgType }),
  countPackageSessionsUsed: async () => state.pkgUsed,
  setPackageSessions: async (id, n) => { state.setPackageSessions.push(n); },
  checkGroupSessionCapacity: async () => ({ available: true }), updateRegistrationsPricing: noop,
  claimBulkBatch: async () => "tok", releaseBulkBatch: noop,
} });
mock.module("@/lib/booking-finalize", { namedExports: {
  isLateAction: () => state.late,
  resolveOffSessionPaymentSource: async () => ({ customerId: "cus", paymentMethodId: "pm" }),
  chargeSavedCardOffSession: async (c) => { state.charges.push(c.amountDollars); return { success: true, paymentIntentId: "pi_x" }; },
  issueStripeRefund: async () => ({ failed: false }),
  computeBulkWeeklySettlement: async () => ({ siblingUpdates: [], refundOrCreditAmount: 0 }),
  fullPriceForWeeklyRow: async (r) => r.session_price, rescheduleDiscountPct: async () => 0,
} });

const { POST } = await import("../src/app/api/admin/reschedule/route.ts");

const ZHANEIA = "Zhaneia Smith";
const ARTEMIOS = "Artemios Gavalas";
const base = (o = {}) => ({
  id: "r1", status: "confirmed", type: "private", parent_name: "Parent", email: "p@x.com", phone: "1", kids: "Kid",
  session_details: "Private Session — 11/23/2026 5:00 PM-6:00 PM at Gym", booked_date: "11/23/2026", booked_start_time: "5:00 PM",
  booked_end_time: "6:00 PM", booked_location: "Gym", booked_trainer: ZHANEIA, total_participants: 1, session_price: 125,
  is_free: false, used_referral_credit: false, applied_account_credit: 0, stripe_payment_intent_id: null, is_paid: false,
  package_id: null, manage_token: "t", created_at: "2026-11-01T00:00:00Z", admin_change_at: null, ...o,
});
async function run(reg, body, { late = false, pkgUsed = 0, pkgMonth = "2026-11" } = {}) {
  Object.assign(state, { reg, update: null, charges: [], late, pkgUsed, pkgMonth, setPackageSessions: [], topups: [] });
  const req = { json: async () => ({ id: reg.id, bookedDate: "11/27/2026", bookedStartTime: "5:00 PM", bookedEndTime: "6:00 PM", bookedLocation: "Gym", suppressNotification: true, ...body }), headers: new Headers() };
  const res = await POST(req);
  return { status: res.status, body: await res.json(), update: state.update, charges: state.charges, setPackageSessions: state.setPackageSessions };
}

test("the reported case: package session on Zhaneia moved to Artemios from admin — still covered, nothing charged", async () => {
  const r = await run(base({ package_id: "pkg" }), { bookedTrainer: ARTEMIOS }, { pkgUsed: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.package_id, undefined, "package link must be kept (not cleared)");
  assert.equal(r.update.booked_trainer, ARTEMIOS);
  assert.equal(r.update.session_price, 125, "priced at the lower (Zhaneia) rate");
  assert.deepEqual(r.setPackageSessions, [], "no package slot freed");
});

test("then moved back from the Artemios placeholder to Zhaneia — still covered, nothing charged", async () => {
  const r = await run(base({ package_id: "pkg", booked_trainer: ARTEMIOS, session_price: 125 }), { bookedTrainer: ZHANEIA }, { pkgUsed: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.package_id, undefined);
  assert.equal(r.update.session_price, 125);
});

test("a FULL package (every session booked) still covers the moved session (it isn't counted against itself)", async () => {
  const r = await run(base({ package_id: "pkg" }), { bookedTrainer: ARTEMIOS }, { pkgUsed: 3 /* 4 booked, this one excluded */ });
  assert.deepEqual(r.charges, []);
});

test("package session moved to ANOTHER month still leaves the package and is charged the regular (lower) rate — unchanged policy", async () => {
  const r = await run(base({ package_id: "pkg" }), { bookedTrainer: ARTEMIOS, bookedDate: "12/2/2026" }, { pkgUsed: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.charges.length, 1);
  assert.equal(r.update.package_id, null);
  assert.equal(r.update.session_price, 125, "Zhaneia's rate, not Artemios's");
});

test("'Keep the same price' on a package session moved to another month: stays in the package, no charge", async () => {
  const r = await run(base({ package_id: "pkg" }), { bookedTrainer: ARTEMIOS, bookedDate: "12/2/2026", keepPriceUnchanged: true }, { pkgUsed: 3 });
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.package_id, undefined);
  assert.equal(r.update.session_price, undefined, "price untouched");
});

test("individually paid private: admin swap Zhaneia -> Artemios charges nothing", async () => {
  const r = await run(base({ stripe_payment_intent_id: "pi_orig" }), { bookedTrainer: ARTEMIOS });
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.session_price, 125);
});

test("individually paid private booked with Artemios, admin swaps to Zhaneia: price drops to $125 (the saving is passed on as before)", async () => {
  const r = await run(base({ stripe_payment_intent_id: "pi_orig", booked_trainer: ARTEMIOS, session_price: 150 }), { bookedTrainer: ZHANEIA });
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.session_price, 125);
});

test("'Keep the same price' on a paid private: price untouched even when the session gets longer", async () => {
  const r = await run(base({ stripe_payment_intent_id: "pi_orig" }), { bookedTrainer: ARTEMIOS, bookedEndTime: "6:30 PM", keepPriceUnchanged: true });
  assert.deepEqual(r.charges, []);
  assert.equal(r.update.session_price, undefined);
});

test("same trainer, longer session (paid): still charged the extra time — unchanged", async () => {
  const r = await run(base({ stripe_payment_intent_id: "pi_orig" }), { bookedEndTime: "6:30 PM" });
  assert.equal(r.charges.length, 1);
  assert.equal(r.update.session_price, 187.5);
});
