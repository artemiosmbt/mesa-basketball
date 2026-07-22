import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationByToken,
  cancelRegistration,
  cancelFullCampByReferralCode,
  getCampGroupByReferralCode,
  addRegistration,
  setPackageSessions,
  countPackageSessionsUsed,
  getPackageById,
  updateRegistrationPlayers,
  addReferralCredit,
  getReferralCredits,
  decrementReferralCredit,
  addAccountCredit,
  deductAccountCredit,
  attachStripeCheckoutSession,
  logLateFeeEvent,
  recordCampDayRefund,
} from "@/lib/supabase";
import { issueStripeRefund, resolvedSessionPrice, describeMoneyOutcome, isLateAction, parseSessionDateTimeET } from "@/lib/booking-finalize";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE, fmtMoney, calcPrivatePrice } from "@/lib/pricing";
import {
  sendCancellationNotification,
  sendRescheduleNotification,
  sendPlayerUpdateNotification,
} from "@/lib/email";
import { getCurrentSheetLocation, getWeeklySchedule } from "@/lib/sheets";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";

// GET — fetch booking details
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  let sessionDetails = reg.session_details;
  let bookedLocation = reg.booked_location;
  if (reg.booked_date && reg.booked_start_time) {
    const sheetLocation = await getCurrentSheetLocation(reg.booked_date, reg.booked_start_time).catch(() => null);
    if (sheetLocation && sheetLocation !== bookedLocation) {
      if (bookedLocation && sessionDetails) sessionDetails = sessionDetails.replaceAll(bookedLocation, sheetLocation);
      bookedLocation = sheetLocation;
    }
  }

  let campGroupDays: { token: string; bookedDate: string | null; bookedStartTime: string | null; status: string }[] | undefined;
  if (reg.is_full_camp && reg.referral_code) {
    const group = await getCampGroupByReferralCode(reg.referral_code, reg.booked_group);
    campGroupDays = group.map((r) => ({
      token: r.manage_token,
      bookedDate: r.booked_date,
      bookedStartTime: r.booked_start_time,
      status: r.status,
    }));
  }

  return NextResponse.json({
    id: reg.id,
    parentName: reg.parent_name,
    email: reg.email,
    phone: reg.phone ?? "",
    kids: reg.kids,
    type: reg.type,
    sessionDetails,
    bookedDate: reg.booked_date,
    bookedStartTime: reg.booked_start_time,
    bookedEndTime: reg.booked_end_time,
    bookedLocation,
    bookedTrainer: reg.booked_trainer,
    bookedGroup: reg.booked_group,
    status: reg.status,
    createdAt: reg.created_at,
    isFullCamp: reg.is_full_camp ?? false,
    usedReferralCredit: reg.used_referral_credit ?? false,
    sessionPrice: reg.session_price,
    totalParticipants: reg.total_participants,
    campGroupDays,
  });
}

// DELETE — cancel booking
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json(
      { error: "Booking is already cancelled" },
      { status: 400 }
    );
  }

  // Block cancellation of group sessions that were volume-discounted at
  // booking time (e.g. booking several sessions together nets a lower
  // per-session rate) — those get rescheduled instead so the discount math
  // isn't disturbed. Compare against the group's actual live sheet rate, not
  // a flat $50 — some groups (e.g. "HS Pickup") are normally priced below
  // $50, and that's not a discount, just their regular rate.
  if (reg.type === "weekly" && reg.session_price !== null && reg.booked_date && reg.booked_start_time) {
    try {
      const sessions = await getWeeklySchedule({ noCache: true });
      const groupLabel = reg.booked_group || reg.session_details.split(" — ")[0] || "";
      const match = sessions.find((s) => s.group === groupLabel && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
      if (match) {
        const standardRate = match.price * (reg.total_participants || 1);
        if (reg.session_price < standardRate) {
          return NextResponse.json(
            { error: "Cancellation is not available for sessions booked at a discounted rate. Please use the reschedule option instead." },
            { status: 403 }
          );
        }
      }
    } catch {
      // Sheet lookup failed — don't block cancellation on an unverifiable guess.
    }
  }

  // Block cancelling a camp day once that specific day's start time has passed.
  // Each day locks independently — other days in the same camp are unaffected.
  if (reg.type === "camp" && reg.booked_date && reg.booked_start_time) {
    const timeMatch = reg.booked_start_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      const sessionDateTime = parseSessionDateTimeET(reg.booked_date, hours, mins);
      if (Date.now() >= sessionDateTime.getTime()) {
        return NextResponse.json(
          { error: "This day has already started — cancellations are no longer accepted for it. The full amount is due." },
          { status: 400 }
        );
      }
    }
  }

  // Check 24-hour policy with 15-min grace period
  let isLateCancel = false;
  if (reg.booked_date && reg.booked_start_time) {
    isLateCancel = isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at);
  }

  // Full camp: cancelling one day recalculates the group; cancelling the last
  // remaining day falls back to the original whole-camp cancellation rule.
  if (reg.type === "camp" && reg.is_full_camp) {
    if (!reg.referral_code) {
      return NextResponse.json({ error: "Cannot cancel — missing camp group reference." }, { status: 500 });
    }
    const campName = reg.booked_group || reg.session_details.split(" — ")[0] || reg.session_details;
    const group = await getCampGroupByReferralCode(reg.referral_code, reg.booked_group);
    const totalOriginalDays = group.length || 1;
    const remainingAfterThis = group.filter((r) => r.status === "confirmed" && r.id !== reg.id).length;

    if (remainingAfterThis === 0) {
      // Last remaining day — cancel the whole (now-empty) group, same rule as before.
      const success = await cancelFullCampByReferralCode(reg.referral_code, reg.booked_group);
      if (!success) {
        // Zero rows matched — another request (double-click, retry) already
        // cancelled this. Bail out here so the refund logic below never runs twice.
        return NextResponse.json({ error: "This camp was already cancelled" }, { status: 409 });
      }
      // Refund any account credit that was applied to any day in this group
      const groupCredit = group.reduce((sum, r) => sum + (r.applied_account_credit || 0), 0);
      if (groupCredit > 0 && reg.email) {
        await addAccountCredit(reg.email, groupCredit).catch(() => {});
      }
      // If they already paid: full Stripe refund with 24+ hours notice, 50%
      // account credit (charge kept) if cancelled late — the real-money
      // version of the policy, now that Stripe charges exist. Bookings paid
      // the old manual/cash way (is_paid, no Stripe charge on file) still
      // fall back to account credit since there's no card to refund.
      const groupPaymentIntentId = reg.stripe_payment_intent_id || group.find((r) => r.stripe_payment_intent_id)?.stripe_payment_intent_id;
      const wasPaid = reg.is_paid || group.some((r) => r.is_paid) || !!groupPaymentIntentId;
      // Every day in this group still carries the ORIGINAL full-camp
      // session_price (cancelling a day never rewrites it) — so anything
      // computed against it must net out BOTH whatever earlier individual
      // day-cancellations in this same group already refunded/credited
      // (priorRefundedTotal) AND whatever they already correctly kept as a
      // late fee (priorAccruedFees) — missing either one would either
      // refund the same money twice, or hand back a late fee that was
      // already permanently forfeited on an earlier day's cancellation.
      const priorRefundedTotal = group.reduce((sum, r) => sum + (r.camp_day_refund_issued || 0), 0);
      const priorAccruedFees = group.reduce((sum, r) => sum + (r.camp_day_late_fee || 0), 0);
      let cancelCredit = 0;
      let stripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
      if (wasPaid && reg.email) {
        const paidAmount = Math.max(0, resolvedSessionPrice(reg) - groupCredit - priorRefundedTotal - priorAccruedFees);
        if (isLateCancel) {
          cancelCredit = Math.round(paidAmount * 0.5 * 100) / 100;
          if (cancelCredit > 0) await addAccountCredit(reg.email, cancelCredit).catch(() => {});
        } else {
          cancelCredit = paidAmount;
          if (paidAmount > 0) {
            if (groupPaymentIntentId) {
              stripeRefundResult = await issueStripeRefund({
                email: reg.email,
                manageToken: token,
                paymentIntentId: groupPaymentIntentId,
                amountDollars: paidAmount,
                sessionLabel: campName,
              });
            } else {
              await addAccountCredit(reg.email, paidAmount).catch(() => {});
            }
          }
        }
      }
      // Late fee wording only makes sense when nothing was paid — someone who
      // already paid is being refunded/credited (possibly $0 if their existing
      // account credit already covered the whole thing), never asked for more.
      // Also subtract any credit already applied at booking time, so the fee
      // reflects what's actually still owed, not the full sticker price.
      const lateFeeAmount = isLateCancel && !wasPaid
        ? Math.round(Math.max(0, resolvedSessionPrice(reg) - groupCredit) * 0.5 * 100) / 100
        : undefined;
      if (wasPaid && isLateCancel) {
        const paidAmount = Math.max(0, resolvedSessionPrice(reg) - groupCredit - priorRefundedTotal);
        await logLateFeeEvent({
          registrationId: reg.id,
          parentName: reg.parent_name,
          email: reg.email,
          kids: reg.kids,
          sessionType: reg.type,
          sessionDetails: campName,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          action: "cancel",
          initiatedBy: "client",
          amountKept: Math.round((paidAmount - cancelCredit) * 100) / 100,
          amountCredited: cancelCredit,
        });
      }
      // Wrapped so an email provider hiccup can't crash the request after a
      // real refund has already been issued — the SMS/calendar sync below
      // must still run either way.
      try {
        await sendCancellationNotification({
          parentName: reg.parent_name,
          email: reg.email,
          sessionDetails: campName,
          sessionType: reg.type,
          isLateCancel,
          lateFeeAmount,
          cancelCredit: wasPaid && isLateCancel ? cancelCredit : undefined,
          stripeRefundResult,
        });
      } catch (notifyErr) {
        console.error("Cancellation email failed (full camp cancel, cancel/refund already applied):", notifyErr);
      }
      if (reg.sms_consent && reg.phone) {
        const moneyOutcome = wasPaid ? describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, false) : "";
        const lateNote = wasPaid
          ? (moneyOutcome ? `\n${moneyOutcome}.` : "\nNothing additional is due — your account credit already covered this.")
          : isLateCancel ? "\nA late cancellation fee applies." : "";
        await sendSMS(reg.phone, `Mesa Basketball: ${campName} cancelled.${lateNote}\nmesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminMoneyOutcome = describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, true);
      await sendAdminSMS(`CANCELLED (Camp): ${reg.parent_name}\n${campName}${isLateCancel ? " (late)" : ""}${adminMoneyOutcome ? ` — ${adminMoneyOutcome}` : ""}\nPlayers: ${reg.kids}`);
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
          console.error("Calendar sync error (camp cancel):", err);
        }
      }
      return NextResponse.json({ success: true, isLateCancel, isFullCamp: true });
    }

    // Partial-day cancel — recompute the capped total and accrue this day's late fee (if any).
    const perDayRate = reg.camp_drop_in_rate ?? Math.round((reg.session_price ?? 0) / totalOriginalDays);
    const thisDayLateFee = isLateCancel ? Math.round(perDayRate * 0.5 * 100) / 100 : 0;
    const success = await cancelRegistration(token, isLateCancel, thisDayLateFee);
    if (!success) {
      // Zero rows matched — another request already cancelled this day.
      // Bail out here so the refund logic below never runs twice.
      return NextResponse.json({ error: "This day was already cancelled" }, { status: 409 });
    }
    if (isLateCancel && thisDayLateFee > 0) {
      // This day's own late fee, cleanly attributable — the actual
      // refund/credit below reflects the WHOLE camp's recomputed total
      // (which can also include fees from other already-cancelled days), so
      // it isn't a clean "kept vs credited" split for just this one day.
      await logLateFeeEvent({
        registrationId: reg.id,
        parentName: reg.parent_name,
        email: reg.email,
        kids: reg.kids,
        sessionType: reg.type,
        sessionDetails: campName,
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        action: "cancel",
        initiatedBy: "client",
        amountKept: thisDayLateFee,
      });
    }

    // If this specific day was the one account credit was applied to, refund it —
    // otherwise it would sit stranded on a cancelled row until the whole camp is cancelled.
    if (reg.applied_account_credit && reg.email) {
      await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
    }

    const originalAmount = reg.session_price ?? 0;
    const recomputedPrice = Math.min(remainingAfterThis * perDayRate, originalAmount);
    const priorAccruedFees = group
      .filter((r) => r.status === "cancelled" && r.id !== reg.id)
      .reduce((sum, r) => sum + (r.camp_day_late_fee || 0), 0);
    // Late fees can never push the total above the original full-week price —
    // the family never pays more than they would have by keeping the full week.
    const finalAmount = Math.min(originalAmount, recomputedPrice + priorAccruedFees + thisDayLateFee);
    const isPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;

    // How much has ALREADY been refunded/credited from previously-cancelled
    // days in this same camp group — the incremental refund due right now is
    // measured from there, never from the original full-camp price again.
    // Diffing straight against originalAmount every time (the old bug) would
    // re-refund ground already covered on every subsequent day cancelled:
    // e.g. a $500/5-day camp cancelling one day at a time would compute
    // "$500 -> $400" (refund $100), then "$500 -> $300" (refund $200) instead
    // of the correct incremental $100 — a real, compounding over-refund.
    const priorRefundedTotal = group
      .filter((r) => r.status === "cancelled" && r.id !== reg.id)
      .reduce((sum, r) => sum + (r.camp_day_refund_issued || 0), 0);
    const effectiveAlreadyPaid = originalAmount - priorRefundedTotal;
    const creditGranted = isPaid && effectiveAlreadyPaid > finalAmount ? effectiveAlreadyPaid - finalAmount : 0;
    let stripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
    if (creditGranted > 0) {
      if (reg.stripe_payment_intent_id) {
        stripeRefundResult = await issueStripeRefund({
          email: reg.email,
          manageToken: token,
          paymentIntentId: reg.stripe_payment_intent_id,
          amountDollars: creditGranted,
          sessionLabel: campName,
        });
      } else {
        await addAccountCredit(reg.email, creditGranted);
      }
      await recordCampDayRefund(token, creditGranted);
    }

    try {
      await sendCancellationNotification({
        parentName: reg.parent_name,
        email: reg.email,
        sessionDetails: campName,
        sessionType: reg.type,
        isLateCancel,
        campAdjustment: { finalAmount, originalAmount, isPaid, creditGranted, stripeRefundResult },
      });
    } catch (notifyErr) {
      console.error("Cancellation email failed (camp day cancel, cancel/refund already applied):", notifyErr);
    }
    if (reg.phone) {
      const moneyOutcome = isPaid ? describeMoneyOutcome(stripeRefundResult, creditGranted, false, false) : "";
      const adjustmentLine = isPaid
        ? (moneyOutcome ? ` ${moneyOutcome}.` : "")
        : ` Amount due: $${fmtMoney(finalAmount)}.`;
      await sendSMS(reg.phone, `Mesa Basketball: ${campName} — ${formatDateWithDay(reg.booked_date || "")} cancelled. New total: $${fmtMoney(finalAmount)} (was $${fmtMoney(originalAmount)}).${adjustmentLine}\nReply STOP to opt out.`);
    }
    const adminMoneyOutcome = isPaid ? describeMoneyOutcome(stripeRefundResult, creditGranted, false, true) : "";
    await sendAdminSMS(`CAMP DAY CANCELLED: ${reg.parent_name}\n${campName} — ${reg.booked_date}\nNew total: $${fmtMoney(finalAmount)} (was $${fmtMoney(originalAmount)})${isPaid ? (adminMoneyOutcome ? ` — ${adminMoneyOutcome}` : "") : ` — due: $${fmtMoney(finalAmount)}`}`);

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
        console.error("Calendar sync error (camp day cancel):", err);
      }
    }

    return NextResponse.json({
      success: true,
      isLateCancel,
      isFullCamp: true,
      isPartialDayCancel: true,
      remainingDays: remainingAfterThis,
      finalAmount,
      originalAmount,
      isPaid,
      creditGranted,
    });
  }

  const success = await cancelRegistration(token, isLateCancel);
  if (!success) {
    // Zero rows matched — another request (double-click, retry) already
    // cancelled this. Bail out here so the refund logic below never runs twice.
    return NextResponse.json(
      { error: "This booking was already cancelled" },
      { status: 409 }
    );
  }

  // Refund referral credit if one was used for this session
  if (reg.used_referral_credit && reg.email) {
    await addReferralCredit(reg.email).catch(() => {});
  }

  // Refund account credit if any was applied to this booking
  if (reg.applied_account_credit && reg.email) {
    await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
  }

  // If they already paid: full Stripe refund with 24+ hours notice, 50%
  // account credit (charge kept) if cancelled late. Bookings paid the old
  // manual/cash way (is_paid, no Stripe charge on file) still fall back to
  // account credit since there's no card to refund.
  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;
  let cancelCredit = 0;
  let stripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
  if (wasPaid && reg.email) {
    const paidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));
    if (isLateCancel) {
      cancelCredit = Math.round(paidAmount * 0.5 * 100) / 100;
      if (cancelCredit > 0) await addAccountCredit(reg.email, cancelCredit).catch(() => {});
    } else {
      cancelCredit = paidAmount;
      if (paidAmount > 0) {
        if (reg.stripe_payment_intent_id) {
          stripeRefundResult = await issueStripeRefund({
            email: reg.email,
            manageToken: token,
            paymentIntentId: reg.stripe_payment_intent_id,
            amountDollars: paidAmount,
            sessionLabel: reg.session_details,
          });
        } else {
          await addAccountCredit(reg.email, paidAmount).catch(() => {});
        }
      }
    }
  }
  if (wasPaid && isLateCancel) {
    const paidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));
    await logLateFeeEvent({
      registrationId: reg.id,
      parentName: reg.parent_name,
      email: reg.email,
      kids: reg.kids,
      sessionType: reg.type,
      sessionDetails: reg.session_details,
      bookedDate: reg.booked_date,
      bookedStartTime: reg.booked_start_time,
      action: "cancel",
      initiatedBy: "client",
      amountKept: Math.round((paidAmount - cancelCredit) * 100) / 100,
      amountCredited: cancelCredit,
    });
  }

  // Cancelling a package-covered session frees its slot back — recompute
  // straight from this row's own package_id (set only when this exact
  // package covered it), not by re-deriving "the active package this email
  // has this month," which could drift from what actually covered this row.
  if (reg.package_id) {
    try {
      const used = await countPackageSessionsUsed(reg.package_id);
      await setPackageSessions(reg.package_id, used);
    } catch {
      // non-critical — don't fail the cancellation
    }
  }

  // A package-covered session has no Stripe payment on this row to credit
  // or refund (it was covered by the package's lump-sum charge instead), so
  // wasPaid above is always false for it — that's exactly right for an
  // on-time cancel (nothing owed, slot already freed above). But a LATE
  // cancel still needs to cost something, per policy: a fresh charge for
  // 50% of what a session like this actually costs right now — live
  // pricing, not whatever happened to be true when they originally booked
  // — sent to real Stripe Checkout like every other charge in this system,
  // never off-session. The session slot itself isn't taken away (only a
  // no-show does that) — it's already been freed back above.
  let packageLateFeeCheckoutUrl: string | undefined;
  let packageLateFeeAmount: number | undefined;
  if (reg.package_id && isLateCancel && reg.email) {
    const durationMins = reg.booked_start_time && reg.booked_end_time
      ? Math.max(60, parseMins(reg.booked_end_time) - parseMins(reg.booked_start_time))
      : 60;
    const liveFullPrice = calcPrivatePrice(durationMins, reg.total_participants || 1);
    packageLateFeeAmount = Math.round(liveFullPrice * 0.5 * 100) / 100;
    if (packageLateFeeAmount > 0) {
      try {
        // Logged BEFORE the checkout exists, deliberately with no charged
        // amount yet — this fee isn't real until the client actually pays
        // it via the separate Checkout below. The event gets updated with
        // the real amount only once the webhook confirms that payment
        // (finalizePaidCheckoutSession's package_late_fee branch), so an
        // abandoned checkout never shows up in the admin activity feed as
        // money that was never actually collected.
        const eventId = await logLateFeeEvent({
          registrationId: reg.id,
          parentName: reg.parent_name,
          email: reg.email,
          kids: reg.kids,
          sessionType: reg.type,
          sessionDetails: reg.session_details,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          action: "cancel",
          initiatedBy: "client",
        });
        const stripe = getStripe();
        const origin = req.nextUrl.origin;
        const plainDetails = reg.session_details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
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
        console.error("Failed to create package late-cancellation fee checkout:", err);
      }
    }
  }

  // Late fee wording only makes sense when nothing was paid — someone who
  // already paid is being credited (possibly $0 if their existing account
  // credit already covered the whole thing), never asked for more. Also
  // subtract any credit already applied at booking time, so the fee
  // reflects what's actually still owed, not the full sticker price. A
  // package-covered session uses the live fee computed above instead (a
  // fresh Stripe charge, not a stored-price estimate).
  const lateFeeAmount = reg.package_id
    ? packageLateFeeAmount
    : isLateCancel && !wasPaid
      ? Math.round(Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0)) * 0.5 * 100) / 100
      : undefined;

  let cancelSessionDetails = reg.session_details;
  let cancelLocation = reg.booked_location || "";
  if (reg.booked_date && reg.booked_start_time) {
    const sheetLocation = await getCurrentSheetLocation(reg.booked_date, reg.booked_start_time).catch(() => null);
    if (sheetLocation && sheetLocation !== cancelLocation) {
      if (cancelLocation) cancelSessionDetails = cancelSessionDetails.replaceAll(cancelLocation, sheetLocation);
      cancelLocation = sheetLocation;
    }
  }

  try {
    await sendCancellationNotification({
      parentName: reg.parent_name,
      email: reg.email,
      sessionDetails: cancelSessionDetails,
      sessionType: reg.type,
      isLateCancel,
      lateFeeAmount,
      cancelCredit: wasPaid && isLateCancel ? cancelCredit : undefined,
      stripeRefundResult,
    });
  } catch (notifyErr) {
    console.error("Cancellation email failed (cancel/refund already applied):", notifyErr);
  }

  if (reg.sms_consent && reg.phone) {
    const cancelLabel = cancelSessionDetails.split(" — ")[0] || "Session";
    const sessionLine = reg.booked_date && reg.booked_start_time
      ? `\n${formatDateWithDay(reg.booked_date)} | ${reg.booked_start_time}${reg.booked_end_time ? `-${reg.booked_end_time}` : ""}${cancelLocation ? `\nLocation: ${resolveLocationName(cancelLocation)}` : ""}`
      : "";
    const moneyOutcome = wasPaid ? describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, false) : "";
    const lateNote = reg.package_id
      ? (packageLateFeeCheckoutUrl
          ? `\nLate cancellation fee: $${fmtMoney((packageLateFeeAmount || 0) + SERVICE_FEE)}. Finish payment here: ${packageLateFeeCheckoutUrl}`
          : isLateCancel ? "\nA late cancellation fee applies — we'll be in touch." : "\nYour package session is available for you to rebook.")
      : wasPaid
        ? (moneyOutcome ? `\n${moneyOutcome}.` : "\nNothing additional is due — your account credit already covered this.")
        : isLateCancel ? "\nA late cancellation fee applies." : "";
    await sendSMS(reg.phone, `Mesa Basketball: ${cancelLabel} cancelled.${sessionLine}\nAthlete: ${reg.kids}${lateNote}\nmesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }
  const adminMoneyOutcome = describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, true);
  const adminPackageNote = reg.package_id
    ? packageLateFeeCheckoutUrl
      ? `\nPackage session — late fee checkout sent: $${fmtMoney((packageLateFeeAmount || 0) + SERVICE_FEE)}`
      : "\nPackage session — on-time, no fee, slot freed"
    : "";
  await sendAdminSMS(`CANCELLED: ${reg.parent_name}\n${cancelSessionDetails}${isLateCancel ? " (late)" : ""}${adminMoneyOutcome ? `\n${adminMoneyOutcome}` : ""}${adminPackageNote}\nPlayers: ${reg.kids}`);

  // Sync calendar after cancellation
  if (reg.booked_date && reg.booked_start_time) {
    const isPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (isPrivate) {
        await deletePrivateSessionFromCalendar({
          email: reg.email,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
        });
      } else {
        // Group/weekly: update the event count (DB already reflects cancellation)
        // Use the stored booked_group rather than re-parsing session_details — group
        // labels can themselves contain " — " (e.g. "High School Girls — Grades 9-12"),
        // which would truncate the label and miss the calendar event's tag.
        const sessionLabel = reg.booked_group || reg.session_details.split(" — ")[0] || "Group Session";
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids,
          participantsJustRegistered: reg.total_participants || 1,
        });
      }
    } catch (err) {
      console.error("Calendar sync error (cancel):", err);
    }
  }

  return NextResponse.json({ success: true, isLateCancel, checkoutUrl: packageLateFeeCheckoutUrl });
}

// Helpers for PATCH
function parseKidsList(kidsStr: string): string[] {
  if (!kidsStr.trim()) return [];
  if (kidsStr.includes("(")) {
    return kidsStr.split("), ").map((p, i, arr) =>
      i < arr.length - 1 ? p + ")" : p
    ).filter((s) => s.trim());
  }
  return kidsStr.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseMins(t: string): number {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function playerLabel(playerStr: string): string {
  const idx = playerStr.indexOf(" (");
  return idx > -1 ? playerStr.substring(0, idx).trim() : playerStr.trim();
}

// PATCH — update player list
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (reg.status !== "confirmed") return NextResponse.json({ error: "Booking is not active" }, { status: 400 });
  if (reg.type === "camp") return NextResponse.json({ error: "Player edits are not available for camp bookings" }, { status: 400 });

  const body = await req.json();
  const { players } = body as { players: string[] };

  if (!Array.isArray(players) || players.filter((p) => p.trim()).length === 0) {
    return NextResponse.json({ error: "At least one player is required" }, { status: 400 });
  }

  const newPlayers = players.filter((p) => p.trim());
  const oldPlayers = parseKidsList(reg.kids);
  const newKidsStr = newPlayers.join(", ");
  const newCount = newPlayers.length;
  const oldCount = oldPlayers.length;

  const removedPlayers = oldPlayers.filter((op) => !newPlayers.includes(op)).map(playerLabel);
  const addedPlayers = newPlayers.filter((np) => !oldPlayers.includes(np)).map(playerLabel);

  const isLate = !!(reg.booked_date && reg.booked_start_time &&
    isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));

  // Price calculation
  let newPrice: number | null = reg.session_price;
  let lateFeeDue: number | undefined;
  let priceChanged = false;
  // A late weekly removal owes this as a SEPARATE fee on top of whatever the
  // roster-size price change works out to (unlike private, where the late
  // penalty is already baked directly into newPrice via the blended tier
  // price below) — this is what actually gets collected via Stripe for it.
  let additionalLateFee = 0;
  const isPrivate = reg.type === "private" || reg.type === "group-private";

  if (isPrivate && reg.booked_start_time && reg.booked_end_time) {
    const duration = Math.max(60, parseMins(reg.booked_end_time) - parseMins(reg.booked_start_time));
    const oldTierHigh = oldCount >= 4;
    const newTierHigh = newCount >= 4;
    if (oldTierHigh !== newTierHigh) {
      const lowPrice = calcPrivatePrice(duration, 1);
      const highPrice = calcPrivatePrice(duration, 4);
      if (!newTierHigh) {
        // 4+ → 1-3: dropping tier
        newPrice = isLate ? Math.round((lowPrice + highPrice) * 100 / 2) / 100 : lowPrice;
        if (isLate) lateFeeDue = Math.round((newPrice - lowPrice) * 100) / 100;
      } else {
        // 1-3 → 4+: gaining tier (no fee)
        newPrice = highPrice;
      }
      priceChanged = true;
    }
  } else if (reg.type === "weekly" && reg.booked_group && reg.booked_date && reg.booked_start_time) {
    // Live per-player price for THIS one session, looked up from the sheet
    // — a flat $50/head estimate ignored the group's actual rate (e.g. a $30
    // Pickup slot), the same bug class already fixed for reschedule. No
    // volume-discount tier applies here — that discount is for booking
    // several DIFFERENT sessions together in one order, not for how many
    // players attend this one single session.
    try {
      const liveSessions = await getWeeklySchedule({ noCache: true });
      const liveMatch = liveSessions.find((s) => s.group === reg.booked_group && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
      if (liveMatch) {
        const newGroupPrice = Math.round(liveMatch.price * newCount * 100) / 100;
        if (newGroupPrice !== reg.session_price) {
          newPrice = newGroupPrice;
          priceChanged = true;
        }
        if (isLate && removedPlayers.length > 0) {
          lateFeeDue = removedPlayers.length * 25;
          additionalLateFee = lateFeeDue;
        }
      } else {
        console.error(`Player edit: couldn't find "${reg.booked_group}" on ${reg.booked_date} ${reg.booked_start_time} in the live sheet — price left unchanged. Verify manually.`);
      }
    } catch (err) {
      console.error("Player edit: live price lookup failed — price left unchanged.", err);
    }
  }

  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;
  const appliedCredit = reg.applied_account_credit || 0;
  const oldAmount = Math.max(0, (reg.is_free ? Math.round((reg.session_price ?? 0) * 0.5 * 100) / 100 : (reg.session_price ?? 0)) - appliedCredit);
  const newAmount = priceChanged
    ? Math.max(0, (reg.is_free && isPrivate ? Math.round((newPrice ?? 0) * 0.5 * 100) / 100 : (newPrice ?? 0)) - appliedCredit)
    : oldAmount;
  const priceDelta = priceChanged ? Math.round((newAmount - oldAmount) * 100) / 100 : 0;
  const totalOwedViaCheckout = Math.round((Math.max(0, priceDelta) + additionalLateFee) * 100) / 100;

  // Money owed: send the client to a real Stripe Checkout for it, same as a
  // reschedule topup — never an off-session charge, since there's no admin
  // present here to catch a failed card and this only ever runs for the
  // client's own action. The roster/price change only actually takes effect
  // once payment confirms (finalizePlayerEditTopup), never before — nothing
  // here updates the booking yet.
  if (wasPaid && totalOwedViaCheckout > 0) {
    const stripe = getStripe();
    const origin = req.nextUrl.origin;
    const plainSessionDetails = reg.session_details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
    try {
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        customer_email: reg.email,
        metadata: {
          purpose: "player_edit_topup",
          manage_token: token,
          new_kids: newKidsStr,
          new_count: String(newCount),
          new_price: newPrice != null ? String(newPrice) : "",
          old_price: reg.session_price != null ? String(reg.session_price) : "",
          removed_players: JSON.stringify(removedPlayers),
          added_players: JSON.stringify(addedPlayers),
          is_late: String(isLate),
          late_fee_due: lateFeeDue != null ? String(lateFeeDue) : "",
          // The actual amount this checkout charges (net of any applied
          // account credit) — passed through explicitly rather than
          // re-derived from old_price/new_price at finalize time, since those
          // are raw prices and re-deriving from them would ignore credit.
          total_owed: String(totalOwedViaCheckout),
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: `Roster change: ${plainSessionDetails || "Mesa Basketball Training Session"}` },
              unit_amount: Math.round(totalOwedViaCheckout * 100),
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
        cancel_url: `${origin}/booking/${token}`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });
      return NextResponse.json({ success: true, pendingPayment: true, checkoutUrl: checkoutSession.url });
    } catch (err) {
      console.error("Failed to create player-edit topup checkout:", err);
      return NextResponse.json({ error: "Couldn't start payment for this change — nothing was applied. Please try again." }, { status: 500 });
    }
  }

  const ok = await updateRegistrationPlayers(token, newKidsStr, newCount, newPrice);
  if (!ok) return NextResponse.json({ error: "This booking is no longer active — it may have just been cancelled" }, { status: 409 });

  // A price DECREASE with nothing owed (no late fee, or the group gained no
  // headcount-driven fee) — credit the difference back for their next
  // booking, same as admin add-player's equivalent case. Real refunds are
  // reserved for genuine reschedules/cancellations, not a roster tweak.
  let creditGranted = 0;
  if (wasPaid && priceDelta < 0) {
    try {
      await addAccountCredit(reg.email, -priceDelta);
      creditGranted = -priceDelta;
    } catch (err) {
      console.error("Failed to grant account credit (player edit):", err);
    }
  }

  try {
    await sendPlayerUpdateNotification({
      parentName: reg.parent_name,
      email: reg.email,
      sessionDetails: reg.session_details,
      removedPlayers,
      addedPlayers,
      newKids: newKidsStr,
      sessionType: reg.type,
      isLate,
      lateFeeDue,
      oldPrice: reg.session_price,
      newPrice,
      priceChanged,
    });
    const changeNote = [
      addedPlayers.length > 0 ? `Added: ${addedPlayers.join(", ")}` : "",
      removedPlayers.length > 0 ? `Removed: ${removedPlayers.join(", ")}` : "",
    ].filter(Boolean).join(" | ");
    const sessionLabel = reg.session_details.split(" — ")[0] || reg.session_details;
    const priceNote = priceChanged
      ? creditGranted > 0
        ? ` | $${fmtMoney(creditGranted)} credited for their next booking.`
        : ` | New price: $${newPrice != null ? fmtMoney(newPrice) : "—"}`
      : "";
    await sendAdminSMS(`PLAYERS UPDATED (${sessionLabel}): ${reg.parent_name}\n${changeNote || "Roster order/details changed"}\nNow: ${newKidsStr}${priceNote}`);
  } catch (err) {
    console.error("Player update email/SMS error:", err);
  }

  return NextResponse.json({ success: true, newKids: newKidsStr, newPrice, isLate, lateFeeDue, creditGranted: creditGranted > 0 ? creditGranted : undefined });
}

// PUT — reschedule booking
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json(
      { error: "Booking is already cancelled" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { bookedDate, bookedStartTime, bookedEndTime, bookedLocation, bookedTrainer, kids: bodyKids, sessionType: bodySessionType, sessionGroup, sessionTrainer, parentName: bodyParentName, phone: bodyPhone, useReferralCredit } = body;

  if (!bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
    return NextResponse.json(
      { error: "Missing new session details" },
      { status: 400 }
    );
  }

  // Use updated kids from client if provided, otherwise keep originals
  const kidsToUse = typeof bodyKids === "string" && bodyKids.trim() ? bodyKids : reg.kids;
  const kidCount = kidsToUse ? parseKidsList(kidsToUse).length : (reg.total_participants || 1);
  // 4+ kids is a genuinely different type ("group-private", $250/hr) from a
  // standard private session ($150/hr) — this used to always write "private"
  // regardless of headcount. That never caused a pricing bug (calcPrivatePrice
  // branches on kidCount directly, not the type string), but it did mean the
  // row's own type field lied about what it actually was, which could mislead
  // anything that branches on type === "group-private" specifically without
  // also checking headcount (confirmation email copy, admin dashboard pills).
  const newType: "private" | "group-private" | "weekly" = bodySessionType === "weekly" ? "weekly" : (kidCount >= 4 ? "group-private" : "private");
  const newSessionDetails = newType === "weekly" && sessionGroup
    ? `${sessionGroup} — ${bookedDate} ${bookedStartTime}-${bookedEndTime} at ${bookedLocation}`
    : `Private Session — ${bookedDate} ${bookedStartTime}-${bookedEndTime} at ${bookedLocation}`;
  const resolvedTrainer: string | undefined = newType === "weekly" ? sessionTrainer : bookedTrainer;

  // Check if original session is within 24h (with grace period) → late reschedule fee applies
  const isLateReschedule = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));

  // What was actually paid for the old session via Stripe (if it was), net
  // of any account credit applied at booking time — this is the baseline
  // the new session's price gets reconciled against below.
  const oldPaymentIntentId = reg.stripe_payment_intent_id || undefined;
  const oldPaidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));

  // Cancel old booking first so group enrollment counts reflect the cancellation.
  // Zero rows matched means another request already cancelled/rescheduled this
  // booking (double-click, retry, race) — bail out here, before any credit
  // refund, Stripe refund, or new booking gets created against a booking that's
  // no longer actually confirmed.
  const oldCancelled = await cancelRegistration(token);
  if (!oldCancelled) {
    return NextResponse.json({ error: "This booking was already cancelled or rescheduled" }, { status: 409 });
  }

  // Refund referral credit from the old booking (always — they'll re-apply to the new one if they want)
  if (reg.used_referral_credit && reg.email) {
    await addReferralCredit(reg.email).catch(() => {});
  }

  // Refund account credit from the old booking (same — they can re-apply to the new one)
  if (reg.applied_account_credit && reg.email) {
    await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
  }

  // Sync calendar for the old booking
  if (reg.booked_date && reg.booked_start_time) {
    const wasPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (wasPrivate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date, bookedStartTime: reg.booked_start_time });
      } else {
        // Use the stored booked_group rather than re-parsing session_details — group
        // labels can themselves contain " — " (e.g. "High School Girls — Grades 9-12"),
        // which would truncate the label and miss the calendar event's tag.
        const sessionLabel = reg.booked_group || reg.session_details.split(" — ")[0] || "Group Session";
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids,
          participantsJustRegistered: reg.total_participants || 1,
        });
      }
    } catch (err) {
      console.error("Calendar sync error (reschedule old):", err);
    }
  }

  const newParentName = typeof bodyParentName === "string" && bodyParentName.trim() ? bodyParentName.trim() : reg.parent_name;
  const newPhone = typeof bodyPhone === "string" && bodyPhone.trim() ? bodyPhone.trim() : reg.phone;

  // Apply referral credit to rescheduled booking if client chose to use it
  const isPrivateReschedule = newType === "private";
  let newIsFree = false;
  let newUsedReferralCredit = false;
  if (useReferralCredit && isPrivateReschedule) {
    const credits = await getReferralCredits(reg.email).catch(() => 0);
    if (credits > 0) {
      newIsFree = true;
      newUsedReferralCredit = true;
      await decrementReferralCredit(reg.email).catch(() => {});
    }
  }

  // Compute the new session's price. Weekly (whether staying weekly or
  // switching into it) is ALWAYS looked up live from the sheet, never
  // inferred by scaling the OLD group's per-player rate — different weekly
  // groups can have very different rates (e.g. a $50 group session vs. its
  // $30 companion Pickup slot), so a same-type reschedule that moves to a
  // DIFFERENT group used to silently charge/credit using the wrong group's
  // price entirely. Private (staying private or switching into it) is
  // duration-based and needs no sheet lookup — its formula is exact either
  // way. Camp is intentionally left unpriced here (too many variables —
  // early-bird, drop-in rate, referral discounts — to safely auto-recompute).
  let newSessionPrice: number | undefined;
  if (newType === "weekly") {
    try {
      const liveSessions = await getWeeklySchedule({ noCache: true });
      const liveMatch = liveSessions.find((s) => s.group === sessionGroup && s.date === bookedDate && s.startTime === bookedStartTime);
      if (liveMatch) {
        newSessionPrice = Math.round(liveMatch.price * kidCount);
      } else {
        console.error(`Client reschedule: couldn't find "${sessionGroup}" on ${bookedDate} ${bookedStartTime} in the live sheet — price reconciliation skipped for this reschedule. Verify manually.`);
      }
    } catch (err) {
      console.error("Client reschedule: live price lookup failed — price reconciliation skipped.", err);
    }
  } else if ((newType === "private" || newType === "group-private") && bookedStartTime && bookedEndTime) {
    const duration = Math.max(60, parseMins(bookedEndTime) - parseMins(bookedStartTime));
    newSessionPrice = calcPrivatePrice(duration, kidCount);
  }
  const newPriceKnown = newSessionPrice != null;
  const newEffectivePrice = newPriceKnown
    ? resolvedSessionPrice({ session_price: newSessionPrice ?? null, is_free: newIsFree, type: newType })
    : undefined;

  // Figure out whether real money needs to move. Only bookings actually paid
  // via Stripe get automated refund/charge — cash/manual-paid bookings keep
  // today's behavior (the row's price updates, nothing collected/returned
  // automatically). On-time: refund or charge just the difference, so the
  // client's already-paid amount carries forward. Late: policy forfeits the
  // old payment as a 50% fee — but that fee is credited straight back onto
  // the new session (not left sitting unused in their balance), so the
  // client only ever owes the remainder via Stripe, never the new session's
  // full price on top of losing half their old payment.
  let priceReconciliation: { kind: "refund" | "charge"; amount: number } | null = null;
  let lateFeeCredited = 0;
  let lateFeeCreditApplied = 0;
  let lateFeeEventId: string | null = null;
  if (oldPaymentIntentId) {
    if (isLateReschedule) {
      lateFeeCredited = Math.round(oldPaidAmount * 0.5 * 100) / 100;
      if (lateFeeCredited > 0) await addAccountCredit(reg.email, lateFeeCredited).catch(() => {});
      if (newPriceKnown && newEffectivePrice! > 0) {
        lateFeeCreditApplied = Math.min(lateFeeCredited, newEffectivePrice!);
        if (lateFeeCreditApplied > 0) {
          const applied = await deductAccountCredit(reg.email, lateFeeCreditApplied).catch(() => false);
          if (!applied) lateFeeCreditApplied = 0; // couldn't apply it (shouldn't happen right after crediting it) — leave it in their balance instead
        }
        const amountStillOwed = Math.round((newEffectivePrice! - lateFeeCreditApplied) * 100) / 100;
        if (amountStillOwed > 0.005) {
          priceReconciliation = { kind: "charge", amount: amountStillOwed };
        }
      }
    } else if (newPriceKnown) {
      const delta = Math.round((newEffectivePrice! - oldPaidAmount) * 100) / 100;
      if (delta < -0.005) {
        priceReconciliation = { kind: "refund", amount: Math.round(Math.abs(delta) * 100) / 100 };
      } else if (delta > 0.005) {
        priceReconciliation = { kind: "charge", amount: Math.round(delta * 100) / 100 };
      }
    }
    if (isLateReschedule) {
      // amountChargedExtra is deliberately omitted here — if priceReconciliation
      // is a "charge", that money isn't real until the client actually pays
      // the separate Checkout created further below. lateFeeEventId is
      // threaded through that checkout's metadata so the webhook can fill
      // the real amount in once payment actually confirms
      // (finalizeRescheduleTopup), rather than this recording a charge that
      // might never happen if they abandon it.
      lateFeeEventId = await logLateFeeEvent({
        registrationId: reg.id,
        parentName: reg.parent_name,
        email: reg.email,
        kids: reg.kids,
        sessionType: reg.type,
        sessionDetails: reg.session_details,
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        action: "reschedule",
        initiatedBy: "client",
        amountKept: Math.round((oldPaidAmount - lateFeeCredited) * 100) / 100,
        amountCredited: lateFeeCredited,
        amountApplied: lateFeeCreditApplied,
        newSessionDetails,
      });
    }
  }

  // A package-covered session has no Stripe payment on this row (it was
  // covered by the package's lump-sum charge instead), so oldPaymentIntentId
  // is always undefined for it and the block above never runs. A late
  // reschedule still needs to cost something, per policy: a fresh charge for
  // 50% of what a session like this actually costs right now (live pricing,
  // not whatever was true when it was originally booked) — sent to real
  // Stripe Checkout, separate from the reschedule itself, never off-session.
  // If the new date lands in the same month as the package, the same slot
  // just moves there for free (nothing lost); otherwise it's priced and
  // charged like a normal new booking rather than accidentally given away.
  let packageLateFeeCheckoutUrl: string | undefined;
  let packageLateFeeAmount: number | undefined;
  let newPackageId: string | undefined;
  if (reg.package_id) {
    if (isLateReschedule) {
      const oldDuration = reg.booked_start_time && reg.booked_end_time
        ? Math.max(60, parseMins(reg.booked_end_time) - parseMins(reg.booked_start_time))
        : 60;
      const liveFullPrice = calcPrivatePrice(oldDuration, reg.total_participants || 1);
      packageLateFeeAmount = Math.round(liveFullPrice * 0.5 * 100) / 100;
      if (packageLateFeeAmount > 0) {
        try {
          // Logged BEFORE the checkout exists, with no charged amount yet —
          // see the matching cancel-side comment above. Filled in by the
          // webhook once payment actually confirms.
          const packageFeeEventId = await logLateFeeEvent({
            registrationId: reg.id,
            parentName: reg.parent_name,
            email: reg.email,
            kids: reg.kids,
            sessionType: reg.type,
            sessionDetails: reg.session_details,
            bookedDate: reg.booked_date,
            bookedStartTime: reg.booked_start_time,
            action: "reschedule",
            initiatedBy: "client",
            newSessionDetails,
          });
          const stripe = getStripe();
          const origin = req.nextUrl.origin;
          const plainOldDetails = reg.session_details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
          const feeSession = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            customer_creation: "always",
            customer_email: reg.email,
            metadata: {
              purpose: "package_late_fee",
              action: "reschedule",
              parent_name: reg.parent_name,
              session_details: plainOldDetails,
              late_fee_event_id: packageFeeEventId || "",
            },
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: { name: `Late Reschedule Fee: ${plainOldDetails || "Mesa Basketball Training Session"}` },
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
          console.error("Failed to create package late-reschedule fee checkout:", err);
        }
      }
    }

    // Packages only ever cover a standard private session (up to 3 kids) —
    // never a 4+ kid group-private rate, regardless of remaining capacity.
    const oldPkg = await getPackageById(reg.package_id).catch(() => null);
    let sameMonthCovered = false;
    if (oldPkg && newType === "private" && kidCount <= 3) {
      const d = new Date(bookedDate);
      if (!isNaN(d.getTime())) {
        const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (newMonth === oldPkg.month_year) {
          newPackageId = oldPkg.id;
          sameMonthCovered = true;
        }
      }
    }
    // Different month, switched away from private, or bumped to 4+ kids —
    // the old package can't cover it, so price and charge the new session
    // like a normal booking rather than silently giving it away for free.
    if (!sameMonthCovered && newPriceKnown && newEffectivePrice! > 0) {
      priceReconciliation = { kind: "charge", amount: newEffectivePrice! };
    }
  }

  // Price increased (or a late reschedule needs a fresh full charge): the
  // new booking isn't confirmed yet — send the client to Stripe Checkout for
  // just what's owed, and let the webhook finalize it once payment
  // succeeds, exactly like a brand-new paid booking.
  if (priceReconciliation?.kind === "charge") {
    const bookingBatchId = crypto.randomUUID();
    await addRegistration({
      parentName: newParentName,
      email: reg.email,
      phone: newPhone,
      kids: kidsToUse,
      type: newType,
      sessionDetails: newSessionDetails,
      totalParticipants: kidCount,
      bookedDate,
      bookedStartTime,
      bookedEndTime,
      bookedLocation,
      bookedGroup: newType === "weekly" ? sessionGroup : undefined,
      bookedTrainer: resolvedTrainer,
      isFree: newIsFree,
      usedReferralCredit: newUsedReferralCredit,
      sessionPrice: newSessionPrice,
      appliedAccountCredit: lateFeeCreditApplied || undefined,
      status: "pending_payment",
      bookingBatchId,
    });

    const stripe = getStripe();
    const origin = req.nextUrl.origin;
    const plainSessionDetails = newSessionDetails.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_creation: "always",
      customer_email: reg.email,
      client_reference_id: bookingBatchId,
      metadata: {
        booking_batch_id: bookingBatchId,
        purpose: "reschedule_topup",
        old_session_details: reg.session_details,
        is_late_reschedule: String(!!isLateReschedule),
        topup_amount: String(priceReconciliation.amount),
        late_fee_credited: String(lateFeeCredited),
        late_fee_credit_applied: String(lateFeeCreditApplied),
        // Only meaningful (and only ever acted on) for an ON-TIME reschedule
        // — the old booking was already cancelled synchronously above with
        // no refund, on the assumption this topup completes. If the client
        // abandons it instead, expireAbandonedCheckoutSession uses these to
        // refund the original charge back, since nothing was forfeited under
        // on-time policy and the client would otherwise have no booking at
        // all and no money back. A late reschedule's 50% forfeiture is
        // already correct regardless of whether this topup ever completes,
        // so these are simply ignored in that case.
        old_payment_intent_id: oldPaymentIntentId || "",
        old_paid_amount: String(oldPaidAmount),
        // Only set for a LATE reschedule (see lateFeeEventId above) — lets
        // the webhook fill in the real charged amount on the existing
        // late_fee_events row once this topup actually gets paid.
        late_fee_event_id: lateFeeEventId || "",
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `Reschedule: ${plainSessionDetails || "Mesa Basketball Training Session"}` },
            unit_amount: Math.round(priceReconciliation.amount * 100),
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
      cancel_url: `${origin}/schedule?checkout=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    await attachStripeCheckoutSession(bookingBatchId, checkoutSession.id);

    // The new session's checkout takes priority for the redirect — if a
    // package late fee is also owed (a rare double-edge: late AND the new
    // date fell outside the package's month), its link rides along
    // separately rather than getting silently dropped.
    return NextResponse.json({ success: true, checkoutUrl: checkoutSession.url, isLateReschedule: !!isLateReschedule, packageLateFeeCheckoutUrl });
  }

  // No further payment needed (same price, a price decrease, or a
  // non-Stripe booking) — confirm the new booking immediately, same as
  // before Stripe existed. A price decrease is credited to the account
  // rather than refunded back to the card: real Stripe refunds are reserved
  // for actual cancellations (24h+ notice) where the client is leaving —
  // a reschedule keeps the booking (and the relationship) going, so the
  // difference stays with Mesa as credit toward a future session instead of
  // round-tripping real money through Stripe.
  let rescheduleRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
  if (priceReconciliation?.kind === "refund") {
    await addAccountCredit(reg.email, priceReconciliation.amount).catch(() => {});
    rescheduleRefundResult = { refundedAmount: 0, creditedAmount: priceReconciliation.amount, failed: false };
  }

  // Create new booking with updated type, kids, and session details. When
  // the old booking was Stripe-paid AND we actually reconciled the price
  // on-time (newPriceKnown — same type, so the row's price is directly
  // comparable), carry its payment identity forward: its remaining captured
  // amount now exactly matches this row's price, so a later cancellation/
  // reschedule can still refund it correctly. A type-switch reschedule
  // (private<->weekly) never goes through price reconciliation at all, so
  // carrying the old payment_intent forward there would let a later
  // cancellation refund the wrong amount against a charge that was never
  // adjusted for this switch. A late reschedule never carries it forward
  // either, even if the credit fully covered the new session — that old
  // charge's money has already been fully spoken for (part kept as the late
  // fee, part re-applied here as account credit via lateFeeCreditApplied
  // below), so it no longer represents a live, refundable balance behind
  // this new row.
  const { manageToken: newToken } = await addRegistration({
    parentName: newParentName,
    email: reg.email,
    phone: newPhone,
    kids: kidsToUse,
    type: newType,
    sessionDetails: newSessionDetails,
    totalParticipants: kidCount,
    bookedDate,
    bookedStartTime,
    bookedEndTime,
    bookedLocation,
    bookedGroup: newType === "weekly" ? sessionGroup : undefined,
    bookedTrainer: resolvedTrainer,
    isFree: newIsFree,
    usedReferralCredit: newUsedReferralCredit,
    sessionPrice: newSessionPrice,
    appliedAccountCredit: lateFeeCreditApplied || undefined,
    stripePaymentIntentId: newPriceKnown && !isLateReschedule ? oldPaymentIntentId : undefined,
    stripeCustomerId: newPriceKnown && !isLateReschedule ? (reg.stripe_customer_id || undefined) : undefined,
    packageId: newPackageId,
  });

  // Sync calendar for the new booking
  try {
    if (newType === "private" || newType === "group-private") {
      await addPrivateSessionToCalendar({
        parentName: newParentName,
        email: reg.email,
        phone: newPhone,
        kids: kidsToUse,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        trainer: bookedTrainer || undefined,
      });
    } else {
      await upsertGroupSessionCalendarEvent({
        sessionType: "weekly",
        sessionLabel: sessionGroup || "Group Session",
        bookedDate,
        bookedStartTime,
        bookedEndTime: bookedEndTime || bookedStartTime,
        bookedLocation: bookedLocation || "",
        kidsJustRegistered: kidsToUse,
        participantsJustRegistered: kidCount,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (reschedule new):", err);
  }

  const lateFeeAmount = reg.package_id
    ? packageLateFeeAmount
    : isLateReschedule && !priceReconciliation && !lateFeeCredited
      ? Math.round(resolvedSessionPrice(reg) * 0.5 * 100) / 100
      : undefined;

  const refundAdjustment = priceReconciliation?.kind === "refund" && rescheduleRefundResult
    ? { kind: "refund" as const, refundedAmount: rescheduleRefundResult.refundedAmount, creditedAmount: rescheduleRefundResult.creditedAmount, failed: rescheduleRefundResult.failed }
    : undefined;

  try {
    await sendRescheduleNotification({
      parentName: newParentName,
      email: reg.email,
      oldSessionDetails: reg.session_details,
      newSessionDetails,
      manageToken: newToken,
      isLateReschedule: !!isLateReschedule,
      lateFeeAmount,
      newTrainer: resolvedTrainer,
      priceAdjustment: refundAdjustment,
      lateFeeCredited: lateFeeCredited || undefined,
      lateFeeCreditApplied: lateFeeCreditApplied || undefined,
    });
  } catch (notifyErr) {
    console.error("Reschedule email failed (booking already updated):", notifyErr);
  }

  const rescheduleTrainerLine = resolvedTrainer ? `\nTrainer: ${resolvedTrainer}` : "";
  const refundOutcomeText = refundAdjustment ? describeMoneyOutcome(refundAdjustment, 0, false, false) : "";
  const refundOutcomeAdminText = refundAdjustment ? describeMoneyOutcome(refundAdjustment, 0, false, true) : "";
  const leftoverLateFeeCredit = Math.max(0, lateFeeCredited - lateFeeCreditApplied);
  const packageFeeTotal = packageLateFeeAmount != null ? Math.round((packageLateFeeAmount + SERVICE_FEE) * 100) / 100 : undefined;
  if (reg.sms_consent && reg.phone) {
    const rescheduleLabel = newSessionDetails.split(" — ")[0] || "Session";
    const lateNote = reg.package_id
      ? (packageLateFeeCheckoutUrl
          ? `\nLate reschedule fee: $${fmtMoney(packageFeeTotal!)}. Finish payment here: ${packageLateFeeCheckoutUrl}`
          : isLateReschedule ? "\nA late reschedule fee applies — we'll be in touch." : "")
      : isLateReschedule && !priceReconciliation && !lateFeeCredited ? "\nA late reschedule fee applies." : "";
    const creditNote = lateFeeCreditApplied > 0
      ? `\n$${fmtMoney(lateFeeCreditApplied)} of your late fee credit covered your new session${leftoverLateFeeCredit > 0 ? ` ($${fmtMoney(leftoverLateFeeCredit)} left in your account)` : ""} — nothing further charged.`
      : lateFeeCredited > 0
        ? `\n$${fmtMoney(lateFeeCredited)} credited to your account (late reschedule fee).`
        : "";
    const refundNote = refundOutcomeText ? `\n${refundOutcomeText}.` : "";
    await sendSMS(reg.phone, `Mesa Basketball: ${rescheduleLabel} rescheduled!\n${formatDateWithDay(bookedDate)} | ${bookedStartTime}-${bookedEndTime}\nLocation: ${resolveLocationName(bookedLocation)}${rescheduleTrainerLine}\nAthlete: ${kidsToUse}${lateNote}${creditNote}${refundNote}\nManage: mesabasketballtraining.com/booking/${newToken}\nReply STOP to opt out.`);
  }
  const adminCreditNote = lateFeeCreditApplied > 0
    ? `\n$${fmtMoney(lateFeeCreditApplied)} late-fee credit applied to new session${leftoverLateFeeCredit > 0 ? ` ($${fmtMoney(leftoverLateFeeCredit)} left in account)` : ""}`
    : lateFeeCredited > 0
      ? `\n$${fmtMoney(lateFeeCredited)} credited (late fee)`
      : "";
  const adminPackageNote = reg.package_id
    ? packageLateFeeCheckoutUrl
      ? `\nPackage session — late fee checkout sent: $${fmtMoney(packageFeeTotal!)}`
      : "\nPackage session — slot moved, no fee"
    : "";
  await sendAdminSMS(`RESCHEDULED: ${newParentName}\nFrom: ${reg.session_details}\nTo: ${newSessionDetails}${rescheduleTrainerLine}\nPlayers: ${kidsToUse}${refundOutcomeAdminText ? `\n${refundOutcomeAdminText}` : ""}${adminCreditNote}${adminPackageNote}`);

  return NextResponse.json({ success: true, newToken, isLateReschedule: !!isLateReschedule, checkoutUrl: packageLateFeeCheckoutUrl });
}
