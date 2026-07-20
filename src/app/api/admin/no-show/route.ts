import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { sendNoShowNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS } from "@/lib/sms";
import { countPackageSessionsUsed, setPackageSessions } from "@/lib/supabase";
import { fmtMoney } from "@/lib/pricing";

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email === ADMIN_EMAIL;
}

// Full-price fallback by session type if session_price is not stored
function fullPriceForType(type: string): number {
  if (type === "group-private") return 250;
  if (type === "private") return 150;
  return 50; // weekly group
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
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
    .select("parent_name, email, session_details, type, session_price, is_free, phone, sms_consent, is_paid, stripe_payment_intent_id, applied_account_credit, package_id")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

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
      if (reg.sms_consent && reg.phone) {
        const noShowLabel = reg.session_details.split(" — ")[0] || "session";
        await sendSMS(reg.phone, `Mesa Basketball: You were marked as a no-show for today's ${noShowLabel}. No payment is due — this session has been used from your package. Reply here with any questions. Reply STOP to opt out.`);
      }
      await sendAdminSMS(`NO-SHOW (package session): ${reg.parent_name} — ${reg.session_details} | No fee — session used from package`);
    } catch (err) {
      console.error("No-show notification error (package session):", err);
    }

    return NextResponse.json({ ok: true, feeAmount: 0, wasPaid: false, packageSession: true });
  }

  const isPrivateType = reg.type === "private" || reg.type === "group-private";
  const basePrice = reg.session_price != null ? reg.session_price : fullPriceForType(reg.type);
  const fullFeeAmount = reg.is_free && isPrivateType ? Math.round(basePrice * 0.5) : basePrice;

  // A no-show keeps the FULL charge per policy — if they already paid
  // (Stripe or the old manual cash toggle), nothing further is due and they
  // must not be told to pay again. If they never paid, the fee still due is
  // net of any account credit already applied at booking time — that credit
  // reduced what they actually owe, same as every other fee calculation in
  // this codebase.
  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;
  const feeAmount = wasPaid ? fullFeeAmount : Math.max(0, fullFeeAmount - (reg.applied_account_credit || 0));

  await sendNoShowNotification({
    parentName: reg.parent_name,
    email: reg.email,
    sessionDetails: reg.session_details,
    sessionType: reg.type,
    feeAmount,
    wasPaid,
  });

  if (reg.sms_consent && reg.phone) {
    const noShowLabel = reg.session_details.split(" — ")[0] || "session";
    const message = wasPaid
      ? `Mesa Basketball: You were marked as a no-show for today's ${noShowLabel}. Per our policy, your $${fmtMoney(feeAmount)} payment is being kept as the session fee — no refund applies, nothing further is due. Reply here with any questions. Reply STOP to opt out.`
      : `Mesa Basketball: You were marked as a no-show for today's ${noShowLabel}. The full session fee of $${fmtMoney(feeAmount)} is due. Reply here with any questions. Reply STOP to opt out.`;
    await sendSMS(reg.phone, message);
  }
  await sendAdminSMS(`NO-SHOW: ${reg.parent_name} — ${reg.session_details} | ${wasPaid ? "Already paid — fee kept" : "Fee due"}: $${fmtMoney(feeAmount)}`);

  return NextResponse.json({ ok: true, feeAmount, wasPaid });
}
