import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { deletePrivateSessionFromCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendCancellationNotification } from "@/lib/email";
import { getCurrentSheetLocation } from "@/lib/sheets";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { issueStripeRefund, resolvedSessionPrice, describeMoneyOutcome, isLateAction } from "@/lib/booking-finalize";
import {
  addAccountCredit,
  addReferralCredit,
  logLateFeeEvent,
  countPackageSessionsUsed,
  setPackageSessions,
  getCampGroupByReferralCode,
  cancelFullCampByReferralCode,
  cancelRegistration,
  recordCampDayRefund,
} from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE, fmtMoney } from "@/lib/pricing";

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

function parseMinsFromTime(t: string): number {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function calcPrivatePrice(durationMins: number, kidCount: number): number {
  return Math.round((kidCount >= 4 ? 250 : 150) * (durationMins / 60) * 100) / 100;
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
    .select("manage_token, type, email, parent_name, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, kids, session_details, total_participants, phone, sms_consent, is_paid, stripe_payment_intent_id, applied_account_credit, session_price, is_free, used_referral_credit, created_at, admin_change_at, package_id, is_full_camp, referral_code, camp_drop_in_rate")
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

  // A multi-day camp booking is actually SEVERAL rows sharing a referral_code
  // (see getCampGroupByReferralCode), each still carrying the ORIGINAL
  // full-camp price — treating one as a plain single-row cancellation (the
  // path below) would refund/credit the ENTIRE camp price for cancelling
  // just one day, and compound further with every additional day cancelled
  // this way. This mirrors the client-facing DELETE handler's camp handling
  // exactly (src/app/api/booking/[token]/route.ts), just driven by the
  // admin's explicit fee choice instead of an automatic late/on-time split.
  if (reg.type === "camp" && reg.is_full_camp) {
    if (!reg.referral_code) {
      return NextResponse.json({ error: "Cannot cancel — missing camp group reference." }, { status: 500 });
    }
    const campName = reg.booked_group || reg.session_details.split(" — ")[0] || reg.session_details;
    const group = await getCampGroupByReferralCode(reg.referral_code, reg.booked_group);
    const totalOriginalDays = group.length || 1;
    const remainingAfterThis = group.filter((r) => r.status === "confirmed" && r.id !== id).length;

    if (remainingAfterThis === 0) {
      // Last remaining day — cancel the whole (now-empty) group.
      const success = await cancelFullCampByReferralCode(reg.referral_code, reg.booked_group);
      if (!success) {
        return NextResponse.json({ error: "This camp was already cancelled" }, { status: 409 });
      }
      const groupCredit = group.reduce((sum, r) => sum + (r.applied_account_credit || 0), 0);
      if (groupCredit > 0 && reg.email) {
        await addAccountCredit(reg.email, groupCredit).catch(() => {});
      }
      const groupPaymentIntentId = reg.stripe_payment_intent_id || group.find((r) => r.stripe_payment_intent_id)?.stripe_payment_intent_id;
      const wasPaidCamp = reg.is_paid || group.some((r) => r.is_paid) || !!groupPaymentIntentId;
      // Net out both what's already been refunded (priorRefundedTotal) AND
      // what's already been correctly kept as a late fee (priorAccruedFees)
      // from earlier day-cancellations in this same group — see the
      // matching client-side comment for why both are required.
      const priorRefundedTotal = group.reduce((sum, r) => sum + (r.camp_day_refund_issued || 0), 0);
      const priorAccruedFees = group.reduce((sum, r) => sum + (r.camp_day_late_fee || 0), 0);
      let campCancelCredit = 0;
      let campStripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
      if (wasPaidCamp && reg.email) {
        const paidAmount = Math.max(0, resolvedSessionPrice(reg) - groupCredit - priorRefundedTotal - priorAccruedFees);
        if (chargeLateFee) {
          campCancelCredit = Math.round(paidAmount * 0.5);
          if (campCancelCredit > 0) await addAccountCredit(reg.email, campCancelCredit).catch(() => {});
        } else if (paidAmount > 0) {
          if (groupPaymentIntentId) {
            campStripeRefundResult = await issueStripeRefund({
              email: reg.email,
              manageToken: reg.manage_token,
              paymentIntentId: groupPaymentIntentId,
              amountDollars: paidAmount,
              sessionLabel: campName,
            });
          } else {
            await addAccountCredit(reg.email, paidAmount).catch(() => {});
            campCancelCredit = paidAmount;
          }
        }
        if (chargeLateFee) {
          await logLateFeeEvent({
            registrationId: id,
            parentName: reg.parent_name,
            email: reg.email,
            kids: reg.kids,
            sessionType: reg.type,
            sessionDetails: campName,
            bookedDate: reg.booked_date,
            bookedStartTime: reg.booked_start_time,
            action: "cancel",
            initiatedBy: "admin",
            amountKept: Math.round((paidAmount - campCancelCredit) * 100) / 100,
            amountCredited: campCancelCredit,
          });
        }
      }
      try {
        await sendCancellationNotification({
          parentName: reg.parent_name,
          email: reg.email,
          sessionDetails: campName,
          sessionType: reg.type,
          isLateCancel: chargeLateFee,
          cancelCredit: wasPaidCamp && chargeLateFee ? campCancelCredit : undefined,
          stripeRefundResult: campStripeRefundResult,
        });
      } catch (notifyErr) {
        console.error("Cancellation email failed (admin full camp cancel):", notifyErr);
      }
      if (reg.sms_consent && reg.phone) {
        const moneyOutcome = wasPaidCamp ? describeMoneyOutcome(campStripeRefundResult, campCancelCredit, chargeLateFee, false) : "";
        const lateNote = wasPaidCamp
          ? (moneyOutcome ? `\n${moneyOutcome}.` : "\nNothing additional is due — your account credit already covered this.")
          : chargeLateFee ? "\nA late cancellation fee applies." : "";
        await sendSMS(reg.phone, `Mesa Basketball: ${campName} cancelled by your trainer.${lateNote}\nQuestions? mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminCampMoneyOutcome = describeMoneyOutcome(campStripeRefundResult, campCancelCredit, chargeLateFee, true);
      await sendAdminSMS(`CANCELLED (Camp): ${reg.parent_name}\n${campName}${chargeLateFee ? " (late fee charged)" : isLate ? " (late fee waived)" : ""}${adminCampMoneyOutcome ? ` — ${adminCampMoneyOutcome}` : ""}\nPlayers: ${reg.kids}`);
      if (reg.booked_date && reg.booked_start_time) {
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "camp",
            sessionLabel: campName,
            bookedDate: reg.booked_date,
            bookedStartTime: reg.booked_start_time,
            bookedEndTime: reg.booked_end_time || reg.booked_start_time,
            bookedLocation: reg.booked_location || "",
            kidsJustRegistered: reg.kids,
            participantsJustRegistered: reg.total_participants || 1,
          });
        } catch (err) {
          console.error("Calendar sync error (admin camp cancel):", err);
        }
      }
      return NextResponse.json({ ok: true, isLateCancel: chargeLateFee, isFullCamp: true });
    }

    // Partial-day cancel — recompute the capped total and accrue this day's late fee (if any).
    const perDayRate = reg.camp_drop_in_rate ?? Math.round((reg.session_price ?? 0) / totalOriginalDays);
    const thisDayLateFee = chargeLateFee ? Math.round(perDayRate * 0.5) : 0;
    const daySuccess = await cancelRegistration(reg.manage_token, chargeLateFee, thisDayLateFee);
    if (!daySuccess) {
      return NextResponse.json({ error: "This day was already cancelled" }, { status: 409 });
    }
    if (chargeLateFee && thisDayLateFee > 0) {
      await logLateFeeEvent({
        registrationId: id,
        parentName: reg.parent_name,
        email: reg.email,
        kids: reg.kids,
        sessionType: reg.type,
        sessionDetails: campName,
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        action: "cancel",
        initiatedBy: "admin",
        amountKept: thisDayLateFee,
      });
    }
    if (reg.applied_account_credit && reg.email) {
      await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
    }
    const originalAmount = reg.session_price ?? 0;
    const recomputedPrice = Math.min(remainingAfterThis * perDayRate, originalAmount);
    const priorAccruedFeesDay = group
      .filter((r) => r.status === "cancelled" && r.id !== id)
      .reduce((sum, r) => sum + (r.camp_day_late_fee || 0), 0);
    const finalAmount = Math.min(originalAmount, recomputedPrice + priorAccruedFeesDay + thisDayLateFee);
    const isPaidDay = !!reg.is_paid || !!reg.stripe_payment_intent_id;
    const priorRefundedTotalDay = group
      .filter((r) => r.status === "cancelled" && r.id !== id)
      .reduce((sum, r) => sum + (r.camp_day_refund_issued || 0), 0);
    const effectiveAlreadyPaidDay = originalAmount - priorRefundedTotalDay;
    const dayCreditGranted = isPaidDay && effectiveAlreadyPaidDay > finalAmount ? effectiveAlreadyPaidDay - finalAmount : 0;
    let dayStripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
    if (dayCreditGranted > 0 && reg.email) {
      if (reg.stripe_payment_intent_id) {
        dayStripeRefundResult = await issueStripeRefund({
          email: reg.email,
          manageToken: reg.manage_token,
          paymentIntentId: reg.stripe_payment_intent_id,
          amountDollars: dayCreditGranted,
          sessionLabel: campName,
        });
      } else {
        await addAccountCredit(reg.email, dayCreditGranted);
      }
      await recordCampDayRefund(reg.manage_token, dayCreditGranted);
    }
    try {
      await sendCancellationNotification({
        parentName: reg.parent_name,
        email: reg.email,
        sessionDetails: campName,
        sessionType: reg.type,
        isLateCancel: chargeLateFee,
        campAdjustment: { finalAmount, originalAmount, isPaid: isPaidDay, creditGranted: dayCreditGranted, stripeRefundResult: dayStripeRefundResult },
      });
    } catch (notifyErr) {
      console.error("Cancellation email failed (admin camp day cancel):", notifyErr);
    }
    if (reg.phone) {
      const moneyOutcome = isPaidDay ? describeMoneyOutcome(dayStripeRefundResult, dayCreditGranted, false, false) : "";
      const adjustmentLine = isPaidDay
        ? (moneyOutcome ? ` ${moneyOutcome}.` : "")
        : ` Amount due: $${fmtMoney(finalAmount)}.`;
      if (reg.sms_consent) {
        await sendSMS(reg.phone, `Mesa Basketball: ${campName} — ${formatDateWithDay(reg.booked_date || "")} cancelled by your trainer. New total: $${fmtMoney(finalAmount)} (was $${fmtMoney(originalAmount)}).${adjustmentLine}\nReply STOP to opt out.`);
      }
    }
    const adminDayMoneyOutcome = isPaidDay ? describeMoneyOutcome(dayStripeRefundResult, dayCreditGranted, false, true) : "";
    await sendAdminSMS(`CANCELLED (Camp day): ${reg.parent_name}\n${campName} — ${reg.booked_date}\nNew total: $${fmtMoney(finalAmount)} (was $${fmtMoney(originalAmount)})${isPaidDay ? (adminDayMoneyOutcome ? ` — ${adminDayMoneyOutcome}` : "") : ` — due: $${fmtMoney(finalAmount)}`}`);
    if (reg.booked_date && reg.booked_start_time) {
      try {
        await upsertGroupSessionCalendarEvent({
          sessionType: "camp",
          sessionLabel: campName,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids,
          participantsJustRegistered: reg.total_participants || 1,
        });
      } catch (err) {
        console.error("Calendar sync error (admin camp day cancel):", err);
      }
    }
    return NextResponse.json({ ok: true, isLateCancel: chargeLateFee, isPartialDayCancel: true, remainingDays: remainingAfterThis, finalAmount, originalAmount });
  }

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

  // Cancelling a package-covered session frees its slot back — recompute
  // straight from this row's own package_id, same as the client-facing
  // cancel flow. Without this, an admin cancelling a package session on a
  // client's behalf (e.g. over the phone) never returns that session to
  // their package, permanently costing them one of the sessions they paid
  // for with no way to fix it from the admin dashboard.
  if (reg.package_id) {
    try {
      const used = await countPackageSessionsUsed(reg.package_id);
      await setPackageSessions(reg.package_id, used);
    } catch {
      // non-critical — don't fail the cancellation
    }
  }

  // A package-covered session has no Stripe payment on this row (it was
  // covered by the package's lump-sum charge instead) — an on-time cancel
  // needs nothing further (slot already freed above). A LATE cancel the
  // admin chose to CHARGE still needs to cost something, same policy and
  // mechanism as the client-facing flow: a fresh Stripe Checkout for 50% of
  // what a session like this actually costs right now, sent directly to the
  // client (the admin isn't the one paying). Waiving is simply not entering
  // this block at all.
  let packageLateFeeCheckoutUrl: string | undefined;
  let packageLateFeeAmount: number | undefined;
  if (reg.package_id && chargeLateFee && reg.email) {
    const durationMins = reg.booked_start_time && reg.booked_end_time
      ? Math.max(60, parseMinsFromTime(reg.booked_end_time) - parseMinsFromTime(reg.booked_start_time))
      : 60;
    const liveFullPrice = calcPrivatePrice(durationMins, reg.total_participants || 1);
    packageLateFeeAmount = Math.round(liveFullPrice * 0.5 * 100) / 100;
    if (packageLateFeeAmount > 0) {
      try {
        // Logged with no charged amount yet — not real until the client
        // actually pays it via the Checkout below. Filled in by the webhook
        // once payment confirms (finalizePaidCheckoutSession's
        // package_late_fee branch), same as the client-facing equivalent.
        const eventId = await logLateFeeEvent({
          registrationId: id,
          parentName: reg.parent_name,
          email: reg.email,
          kids: reg.kids,
          sessionType: reg.type,
          sessionDetails: reg.session_details,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          action: "cancel",
          initiatedBy: "admin",
        });
        const stripe = getStripe();
        const origin = req.nextUrl.origin;
        const plainDetails = (reg.session_details || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
        const feeSession = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_method_types: ["card"],
          customer_creation: "always",
          customer_email: reg.email,
          metadata: {
            purpose: "package_late_fee",
            action: "cancel",
            parent_name: reg.parent_name,
            session_details: plainDetails,
            late_fee_event_id: eventId || "",
          },
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: `Late Cancellation Fee: ${plainDetails || "Mesa Basketball Training Session"}` },
                unit_amount: Math.round(packageLateFeeAmount * 100),
              },
              quantity: 1,
            },
            {
              price_data: {
                currency: "usd",
                product_data: { name: "Service Fee" },
                unit_amount: Math.round(SERVICE_FEE * 100),
              },
              quantity: 1,
            },
          ],
          success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/my-bookings`,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        });
        packageLateFeeCheckoutUrl = feeSession.url ?? undefined;
      } catch (err) {
        console.error("Failed to create package late-cancellation fee checkout (admin):", err);
      }
    }
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
    if (chargeLateFee) {
      await logLateFeeEvent({
        registrationId: id,
        parentName: reg.parent_name,
        email: reg.email,
        kids: reg.kids,
        sessionType: reg.type,
        sessionDetails: reg.session_details,
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        action: "cancel",
        initiatedBy: "admin",
        amountKept: Math.round((paidAmount - creditIssued) * 100) / 100,
        amountCredited: creditIssued,
      });
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
        const moneyNote = reg.package_id
          ? (packageLateFeeCheckoutUrl
              ? `\nLate cancellation fee: $${fmtMoney((packageLateFeeAmount || 0) + SERVICE_FEE)}. Finish payment here: ${packageLateFeeCheckoutUrl}`
              : "\nYour package session is available for you to rebook.")
          : moneyOutcome ? `\n${moneyOutcome}.` : "";
        await sendSMS(reg.phone, `Mesa Basketball: Session cancelled by your trainer.${sessionLine}\nAthlete: ${reg.kids}${moneyNote}\nQuestions? mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminMoneyOutcome = wasPaid ? describeMoneyOutcome(stripeRefundResult, creditIssued, chargeLateFee, true) : "";
      const adminPackageNote = reg.package_id
        ? packageLateFeeCheckoutUrl
          ? `\nPackage session — late fee checkout sent: $${fmtMoney((packageLateFeeAmount || 0) + SERVICE_FEE)}`
          : "\nPackage session — slot freed"
        : "";
      await sendAdminSMS(`CANCELLED: ${reg.parent_name}\n${sessionDetails}\nPlayers: ${reg.kids}${chargeLateFee ? "\n(Late fee charged)" : isLate ? "\n(Late fee waived)" : ""}${adminMoneyOutcome ? `\n${adminMoneyOutcome}` : ""}${adminPackageNote}`);
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
