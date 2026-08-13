import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyDashboardAccess } from "@/lib/auth";
import { sendAdminSMS } from "@/lib/sms";
import { countPackageSessionsUsed, setPackageSessions } from "@/lib/supabase";
import { fmtMoney, fullPriceForType, getTrainerTier, effectiveSessionPrice } from "@/lib/pricing";
import { trainerNamesMatch } from "@/lib/trainers";

// The one write action every trainer tier (not just full admin) can take —
// they're the one who'd actually know a client didn't show up.
export async function POST(req: NextRequest) {
  const ctx = await verifyDashboardAccess(req);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: reg } = await supabase
    .from("registrations")
    .select("parent_name, email, session_details, type, session_price, is_free, used_referral_credit, phone, sms_consent, is_paid, stripe_payment_intent_id, applied_account_credit, package_id, booked_trainer")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

  // A plain trainer account can only ever mark no-show on their own
  // sessions — the UI already only ever shows them their own, but this is
  // the actual enforcement (a crafted request with someone else's id must
  // not work just because the caller is a recognized trainer account).
  // The explicit !ctx.trainerName check matters on its own, separate from
  // trainerNamesMatch: a misconfigured TRAINER_ACCOUNTS row (role "trainer"
  // with no trainerName set) must fail closed here — without it,
  // trainerNamesMatch(null, undefined) normalizes both sides to "" and
  // returns true, wrongly authorizing that account against any registration
  // whose booked_trainer also happens to be null (e.g. a legacy/camp row).
  if (ctx.role === "trainer" && (!ctx.trainerName || !trainerNamesMatch(reg.booked_trainer, ctx.trainerName))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Only flip a row still actually confirmed — guards against double-marking
  // the same booking (double click, retry) from running this whole flow twice.
  const { data: updated, error } = await supabase
    .from("registrations")
    .update({ status: "no_show" })
    .eq("id", id)
    .eq("status", "confirmed")
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "This booking is no longer confirmed (already cancelled or already marked)" }, { status: 409 });
  }

  // A package-covered no-show keeps sessions_used counted against it (the
  // penalty for a no-show is losing that session, unlike a late cancel/
  // reschedule which keeps the slot but costs a fresh fee instead) — no
  // Stripe payment exists on this row to keep or ask for, so no fee applies
  // at all. Recompute now so the package's remaining count is accurate
  // immediately, not just on next admin dashboard load.
  if (reg.package_id) {
    try {
      const used = await countPackageSessionsUsed(reg.package_id);
      await setPackageSessions(reg.package_id, used);
    } catch (err) {
      console.error("Package session recompute failed (no-show):", err);
    }

    try {
      await sendAdminSMS(`NO-SHOW (package session): ${reg.parent_name} — ${reg.session_details} | No fee — session used from package`);
    } catch (err) {
      console.error("No-show notification error (package session):", err);
    }

    return NextResponse.json({ ok: true, feeAmount: 0, wasPaid: false, packageSession: true });
  }

  const isPrivateType = reg.type === "private" || reg.type === "group-private";
  const basePrice = reg.session_price != null ? reg.session_price : fullPriceForType(reg.type, getTrainerTier(reg.booked_trainer));
  const fullFeeAmount = effectiveSessionPrice(basePrice, reg.is_free, isPrivateType, !!reg.used_referral_credit);

  // A no-show keeps the FULL charge per policy — if they already paid
  // (Stripe or the old manual cash toggle), nothing further is due and they
  // must not be told to pay again. If they never paid, the fee still due is
  // net of any account credit already applied at booking time — that credit
  // reduced what they actually owe, same as every other fee calculation in
  // this codebase.
  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;
  const feeAmount = wasPaid ? fullFeeAmount : Math.max(0, fullFeeAmount - (reg.applied_account_credit || 0));

  await sendAdminSMS(`NO-SHOW: ${reg.parent_name} — ${reg.session_details} | ${wasPaid ? "Already paid — fee kept" : "Fee due"}: $${fmtMoney(feeAmount)}`);

  return NextResponse.json({ ok: true, feeAmount, wasPaid });
}
