import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { deletePrivateSessionFromCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendCancellationNotification } from "@/lib/email";
import { getCurrentSheetLocation } from "@/lib/sheets";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { issueStripeRefund, resolvedSessionPrice, describeMoneyOutcome, isLateAction } from "@/lib/booking-finalize";
import { addAccountCredit, addReferralCredit } from "@/lib/supabase";

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

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, feeChoice } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  if (feeChoice && feeChoice !== "waive" && feeChoice !== "charge") {
    return NextResponse.json({ error: "Invalid feeChoice" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch registration details before cancelling — includes everything
  // needed to refund the client, and to determine whether this counts as
  // a late cancellation the same way a client-initiated one would.
  const { data: reg } = await supabase
    .from("registrations")
    .select("manage_token, type, email, parent_name, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, kids, session_details, total_participants, phone, sms_consent, is_paid, stripe_payment_intent_id, applied_account_credit, session_price, is_free, used_referral_credit, created_at, admin_change_at")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

  // Same lateness rule a client-initiated cancellation uses. Unlike a
  // client cancelling their own booking, the admin gets to CHOOSE how to
  // handle a late one rather than it being automatic — sometimes it's
  // waiving the fee to help someone out with a real issue, sometimes it's
  // charging the normal fee on the client's behalf (e.g. they're having
  // trouble using the site themselves but still owe it). An on-time
  // cancellation never needs a choice — it's always a full refund, same as
  // if the client had done it themselves.
  const isLate = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));

  if (isLate && !feeChoice) {
    return NextResponse.json(
      { error: "This booking is within the 24-hour window — choose how to handle the fee.", needsFeeChoice: true, isLateCancel: true },
      { status: 400 }
    );
  }

  const chargeLateFee = isLate && feeChoice === "charge";

  // Only flips a row still actually confirmed — guards against double-cancelling
  // (double click, retry) from running the refund flow below twice.
  // applied_account_credit is zeroed here (refunded back separately below)
  // to match cancelRegistration's convention, preventing it from being
  // double-refunded if this row is ever swept up elsewhere.
  const { data: updated, error } = await supabase
    .from("registrations")
    .update({ status: "cancelled", is_late_cancel: chargeLateFee, applied_account_credit: 0 })
    .eq("id", id)
    .eq("status", "confirmed")
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "This booking is no longer confirmed — it may have already been cancelled" }, { status: 409 });
  }

  // Give back a redeemed referral credit — the client didn't choose to
  // cancel, so they shouldn't lose it.
  if (reg.used_referral_credit && reg.email) {
    await addReferralCredit(reg.email).catch(() => {});
  }

  // Give back any account credit that was applied at booking time.
  if (reg.applied_account_credit && reg.email) {
    await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
  }

  // Full refund/credit unless the admin explicitly chose to charge the
  // standard late fee — in which case it's exactly the client-initiated
  // late-cancellation policy: half kept (no refund needed, it's already
  // been captured), half credited. No new Stripe charge is ever needed
  // here either way — this only decides how much of the EXISTING captured
  // payment gets refunded back vs kept.
  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;
  let stripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
  let creditIssued = 0;
  if (wasPaid && reg.email) {
    const paidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));
    if (chargeLateFee) {
      creditIssued = Math.round(paidAmount * 0.5);
      if (creditIssued > 0) await addAccountCredit(reg.email, creditIssued).catch(() => {});
    } else if (paidAmount > 0) {
      if (reg.stripe_payment_intent_id) {
        stripeRefundResult = await issueStripeRefund({
          email: reg.email,
          manageToken: reg.manage_token,
          paymentIntentId: reg.stripe_payment_intent_id,
          amountDollars: paidAmount,
          sessionLabel: reg.session_details || "",
        });
      } else {
        await addAccountCredit(reg.email, paidAmount).catch(() => {});
        creditIssued = paidAmount;
      }
    }
  }

  // Sync calendar after DB is updated
  if (reg?.booked_date && reg?.booked_start_time) {
    const isPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (isPrivate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date });
      } else {
        // Use the stored booked_group rather than re-parsing session_details — group
        // labels can themselves contain " — " (e.g. "High School Girls — Grades 9-12"),
        // which would truncate the label and miss the calendar event's tag.
        const sessionLabel = reg.booked_group || reg.session_details?.split(" — ")[0] || "Group Session";
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids || "",
          participantsJustRegistered: reg.total_participants || 1,
        });
      }
    } catch (err) {
      console.error("Calendar sync error (admin cancel):", err);
    }
  }

  // Notify parent of admin-initiated cancellation
  if (reg?.email && reg?.parent_name) {
    try {
      let sessionDetails = reg.session_details || "";
      let bookedLocation = reg.booked_location || "";
      if (reg.booked_date && reg.booked_start_time) {
        const sheetLocation = await getCurrentSheetLocation(reg.booked_date, reg.booked_start_time).catch(() => null);
        if (sheetLocation && sheetLocation !== bookedLocation) {
          if (bookedLocation) sessionDetails = sessionDetails.replaceAll(bookedLocation, sheetLocation);
          bookedLocation = sheetLocation;
        }
      }
      await sendCancellationNotification({
        parentName: reg.parent_name,
        email: reg.email,
        sessionDetails,
        sessionType: reg.type,
        isLateCancel: chargeLateFee,
        stripeRefundResult,
        cancelCredit: !stripeRefundResult && creditIssued > 0 ? creditIssued : undefined,
      });
      if (reg.sms_consent && reg.phone) {
        const sessionLine = reg.booked_date && reg.booked_start_time
          ? `\n${formatDateWithDay(reg.booked_date)} | ${reg.booked_start_time}${reg.booked_end_time ? `-${reg.booked_end_time}` : ""}${bookedLocation ? `\nLocation: ${resolveLocationName(bookedLocation)}` : ""}`
          : "";
        const moneyOutcome = wasPaid ? describeMoneyOutcome(stripeRefundResult, creditIssued, chargeLateFee, false) : "";
        const moneyNote = moneyOutcome ? `\n${moneyOutcome}.` : "";
        await sendSMS(reg.phone, `Mesa Basketball: Session cancelled by your trainer.${sessionLine}\nAthlete: ${reg.kids}${moneyNote}\nQuestions? mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminMoneyOutcome = wasPaid ? describeMoneyOutcome(stripeRefundResult, creditIssued, chargeLateFee, true) : "";
      await sendAdminSMS(`CANCELLED: ${reg.parent_name}\n${sessionDetails}\nPlayers: ${reg.kids}${chargeLateFee ? "\n(Late fee charged)" : isLate ? "\n(Late fee waived)" : ""}${adminMoneyOutcome ? `\n${adminMoneyOutcome}` : ""}`);
    } catch (err) {
      console.error("Email/SMS notification error (admin cancel):", err);
    }
  }

  return NextResponse.json({
    ok: true,
    isLateCancel: chargeLateFee,
    wasPaid,
    refundedAmount: stripeRefundResult?.refundedAmount ?? 0,
    creditedAmount: (stripeRefundResult?.creditedAmount ?? 0) + creditIssued,
    refundFailed: !!stripeRefundResult?.failed,
  });
}
