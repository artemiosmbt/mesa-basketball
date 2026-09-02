// READ-ONLY audit for the phantom-credit bug on abandoned reschedule topups.
//
// Before the fix, a late reschedule that needed a Stripe topup stamped the
// PREVIEW of its 50% carry-forward onto the pending row's
// applied_account_credit, even though nothing had been deducted from the
// family's balance (the old booking is deliberately left untouched until the
// topup is paid). If the client then abandoned the Checkout,
// expireAbandonedBookingBatch "gave back" that never-deducted amount as real,
// spendable account credit.
//
// This finds every family that was handed such a credit, so the balances can
// be reconciled by hand. It writes NOTHING — only SELECTs and Stripe
// Checkout Session retrievals.
//
// Run with: node --env-file=.env.local scripts/audit-phantom-reschedule-credits.mjs

import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// Abandoned rows that claim credit was applied. A normal booking's abandoned
// row legitimately looks like this too (its credit really WAS deducted at
// insert time), so each one is confirmed against its Checkout Session's
// metadata — only purpose=reschedule_topup rows are phantoms.
const { data: rows, error } = await supabase
  .from("registrations")
  .select("id, email, parent_name, kids, session_details, booked_date, status, applied_account_credit, stripe_checkout_session_id, created_at")
  .eq("status", "payment_abandoned")
  .gt("applied_account_credit", 0)
  .order("created_at", { ascending: false });

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

console.log(`Abandoned rows claiming applied credit: ${rows.length}\n`);

const phantoms = [];
const legit = [];
const unknown = [];

for (const row of rows) {
  if (!row.stripe_checkout_session_id) {
    unknown.push({ row, reason: "no checkout session id on the row" });
    continue;
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
    if (session.metadata?.purpose === "reschedule_topup") phantoms.push({ row, session });
    else legit.push(row);
  } catch (err) {
    unknown.push({ row, reason: `Stripe lookup failed: ${err.message}` });
  }
}

if (phantoms.length === 0) {
  console.log("No phantom credits found.\n");
} else {
  console.log(`PHANTOM CREDITS — ${phantoms.length} family/families were credited money they never paid:\n`);
  const byEmail = new Map();
  for (const { row } of phantoms) {
    byEmail.set(row.email, (byEmail.get(row.email) || 0) + Number(row.applied_account_credit));
  }
  for (const { row, session } of phantoms) {
    console.log(`  ${row.parent_name} <${row.email}>`);
    console.log(`    phantom credit : ${money(row.applied_account_credit)}`);
    console.log(`    abandoned      : ${row.created_at}`);
    console.log(`    was moving to  : ${row.session_details} (${row.booked_date})`);
    console.log(`    original booking token in metadata: ${session.metadata?.original_manage_token || "—"}`);
    console.log("");
  }

  console.log("Current balances for those families:\n");
  for (const [email, phantomTotal] of byEmail) {
    const { data: bal } = await supabase
      .from("account_credits")
      .select("balance, updated_at")
      .eq("email", email)
      .maybeSingle();
    // What the phantom credit was actually spent on, if anything.
    const { data: spentRegs } = await supabase
      .from("registrations")
      .select("session_details, booked_date, applied_account_credit, status, created_at")
      .eq("email", email)
      .gt("applied_account_credit", 0)
      .neq("status", "payment_abandoned")
      .order("created_at", { ascending: false })
      .limit(10);
    const { data: spentPkgs } = await supabase
      .from("monthly_packages")
      .select("package_type, month_year, applied_account_credit, status, created_at")
      .eq("email", email)
      .gt("applied_account_credit", 0)
      .order("created_at", { ascending: false })
      .limit(10);

    console.log(`  ${email}`);
    console.log(`    phantom credit issued : ${money(phantomTotal)}`);
    console.log(`    balance now           : ${money(bal?.balance ?? 0)} (updated ${bal?.updated_at || "never"})`);
    for (const r of spentRegs || []) {
      console.log(`    credit spent on booking: ${money(r.applied_account_credit)} — ${r.session_details} (${r.booked_date}) [${r.status}] ${r.created_at}`);
    }
    for (const p of spentPkgs || []) {
      console.log(`    credit spent on package: ${money(p.applied_account_credit)} — ${p.package_type} ${p.month_year} [${p.status}] ${p.created_at}`);
    }
    console.log("");
  }
}

if (legit.length > 0) {
  console.log(`(${legit.length} abandoned row(s) had genuinely-deducted credit restored — correct, not affected.)`);
}
for (const { row, reason } of unknown) {
  console.log(`UNVERIFIED: ${row.email} ${money(row.applied_account_credit)} on ${row.created_at} — ${reason}`);
}
