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
  attachStripeCheckoutSession,
  logLateFeeEvent,
  recordCampDayRefund,
  hasConflictingPrivateBooking,
  checkGroupSessionCapacity,
  getSavedAthletesByEmail,
} from "@/lib/supabase";
import { issueStripeRefund, resolvedSessionPrice, describeMoneyOutcome, isLateAction, parseSessionDateTimeET, computeLateFeeAmounts, settleOldBookingForReschedule, computePlayerEditPricing, parseKidsList } from "@/lib/booking-finalize";
import { getStripe } from "@/lib/stripe";
import { calcServiceFee, serviceFeeItemName, fmtMoney, calcPrivatePrice, getTrainerTier, normalizeTrainerTier, packageCoversTrainerTier } from "@/lib/pricing";
import {
  sendCancellationNotification,
  sendRescheduleNotification,
  sendPlayerUpdateNotification,
} from "@/lib/email";
import { getCurrentSheetLocation, getWeeklySchedule, isPrivateWindowOfferedByTrainer } from "@/lib/sheets";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { notifyTrainerOfCancellation, notifyTrainerOfReschedule, notifyTrainerOfNewBooking } from "@/lib/trainer-notify";
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

  // Looked up server-side from the booking's own (verified) email — never
  // from a client-supplied one — so the manage token itself is what proves
  // the right to see this parent's saved roster, same trust level the token
  // already carries for reschedule/cancel/edit-players.
  const savedAthletes = reg.email ? await getSavedAthletesByEmail(reg.email).catch(() => []) : [];

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
    isPackageBooking: !!reg.package_id,
    savedAthletes,
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
  // isn't disturbed. Read from the stored, booking-time-anchored flag rather
  // than re-deriving it from the group's CURRENT live rate — a rate change
  // since booking would otherwise silently reclassify this booking's policy
  // (see is_bulk_discounted migration comment). Also captured here for reuse
  // below: the full-forfeiture-on-late-cancel policy only applies to these
  // bulk/volume-discounted bookings, not a plain 1-3 session weekly booking
  // at the regular rate (which keeps the old 50% late-fee policy) — though
  // in practice a request only reaches the fee logic below at all when this
  // is false, since a true bulk booking is rejected right here.
  const isBulkDiscountedWeekly = reg.type === "weekly" && !!reg.is_bulk_discounted;
  if (isBulkDiscountedWeekly) {
    return NextResponse.json(
      { error: "Cancellation is not available for sessions booked at a discounted rate. Please use the reschedule option instead." },
      { status: 403 }
    );
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
    const perDayRate = reg.camp_drop_in_rate ?? Math.round((reg.session_price ?? 0) / totalOriginalDays * 100) / 100;
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
    if (reg.sms_consent && reg.phone) {
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
      // Weekly group sessions booked in bulk (the 10%/15% volume discount)
      // are now full forfeiture on late cancel — 0% credited. A plain
      // (non-bulk) weekly booking, plain private, and group-private all keep
      // the original 50% credit. Package-covered sessions never reach this
      // branch (wasPaid is always false for them — see the
      // packageSessionForfeited handling below). In practice this route
      // never actually sees a bulk-discounted weekly cancellation (blocked
      // above, reschedule-only), so this only matters for consistency.
      cancelCredit = isBulkDiscountedWeekly ? 0 : Math.round(paidAmount * 0.5 * 100) / 100;
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
  // on-time cancel (nothing owed, slot already freed above). A LATE cancel
  // no longer triggers a fresh 50% Stripe charge — per current policy the
  // session itself is simply forfeited (stays counted as "used" against the
  // package, same as a no-show), which the recompute above already applied
  // by re-deriving from countPackageSessionsUsed. If this was their last
  // session, the package is just exhausted — nothing further to charge here.
  const packageSessionForfeited = !!(reg.package_id && isLateCancel);
  if (packageSessionForfeited) {
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
    });
  }

  // Bulk-discounted weekly group sessions (booked as part of the 10%/15%
  // volume discount): late cancellation is now full forfeiture (0%
  // refunded/credited) instead of the old 50%-credited policy. A plain
  // (non-bulk) weekly booking, and plain/group-private sessions, are
  // unaffected — this route never actually reaches here for a bulk
  // cancellation though (blocked above as reschedule-only).
  const fullForfeitNoRefund = isBulkDiscountedWeekly && isLateCancel;

  // Late fee wording only makes sense for the original (non-package,
  // non-weekly) policy — someone who already paid is being credited
  // (possibly $0 if their existing account credit already covered the whole
  // thing), never asked for more. Package and weekly sessions now forfeit
  // instead of owing a fee, so they never populate this.
  const lateFeeAmount = reg.package_id || fullForfeitNoRefund
    ? undefined
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
      cancelCredit: wasPaid && isLateCancel && !fullForfeitNoRefund ? cancelCredit : undefined,
      stripeRefundResult,
      packageSessionForfeited,
      fullForfeitNoRefund,
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
    const lateNote = packageSessionForfeited
      ? "\nLate cancellation: this session is forfeited from your package — no additional charge."
      : fullForfeitNoRefund
        ? "\nLate cancellation: this session is non-refundable per our 24-hour policy."
        : reg.package_id
          ? "\nYour package session is available for you to rebook."
          : wasPaid
            ? (moneyOutcome ? `\n${moneyOutcome}.` : "\nNothing additional is due — your account credit already covered this.")
            : isLateCancel ? "\nA late cancellation fee applies." : "";
    await sendSMS(reg.phone, `Mesa Basketball: ${cancelLabel} cancelled.${sessionLine}\nAthlete: ${reg.kids}${lateNote}\nmesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }
  const adminMoneyOutcome = describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, true);
  const adminPackageNote = packageSessionForfeited
    ? "\nPackage session — late cancellation, session forfeited, no fee charged"
    : reg.package_id
      ? "\nPackage session — on-time, no fee, slot freed"
      : "";
  const adminForfeitNote = fullForfeitNoRefund ? "\nWeekly late cancellation — full forfeiture, no refund" : "";
  await sendAdminSMS(`CANCELLED: ${reg.parent_name}\n${cancelSessionDetails}${isLateCancel ? " (late)" : ""}${adminMoneyOutcome ? `\n${adminMoneyOutcome}` : ""}${adminPackageNote}${adminForfeitNote}\nPlayers: ${reg.kids}`);

  if (reg.booked_date && reg.booked_start_time && reg.booked_trainer) {
    await notifyTrainerOfCancellation({
      trainer: reg.booked_trainer,
      parentName: reg.parent_name,
      sessionLabel: reg.type === "weekly" ? (reg.booked_group || "Group Session") : reg.type === "group-private" ? "Group Private Session" : "Private Session",
      date: reg.booked_date,
      startTime: reg.booked_start_time,
      endTime: reg.booked_end_time || reg.booked_start_time,
      location: cancelLocation,
    }).catch((err) => console.error("Trainer cancellation notify failed:", err));
  }

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

  return NextResponse.json({ success: true, isLateCancel, packageSessionForfeited, fullForfeitNoRefund });
}

// Helper for PATCH — kept local since it's only used for the reschedule
// (PUT) handler's own duration math now that the player-edit pricing block
// below moved into computePlayerEditPricing (booking-finalize.ts), which
// uses sheets.ts's parseTimeToMins for the same job.
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

  const pricing = await computePlayerEditPricing(reg, players);
  const {
    newKidsStr, newCount, removedPlayers, addedPlayers, isLate, newPrice,
    lateFeeDue, wasPaid, priceDelta, priceChanged, totalOwedViaCheckout,
  } = pricing;

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
              product_data: { name: serviceFeeItemName(totalOwedViaCheckout) },
              unit_amount: Math.round(calcServiceFee(totalOwedViaCheckout) * 100),
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
  // Note: the client also submits a `sessionTrainer` field for weekly
  // reschedules, but it's deliberately never read — the live-schedule
  // lookup below is the only trusted source for the weekly trainer. See the
  // resolvedTrainer block just below.
  const { bookedDate, bookedStartTime, bookedEndTime, bookedLocation, bookedTrainer, kids: bodyKids, sessionType: bodySessionType, sessionGroup, parentName: bodyParentName, phone: bodyPhone, useReferralCredit } = body;

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
  // Weekly-only: is the request actually moving the session at all, or just
  // editing something else (e.g. kid count) on the SAME still-confirmed
  // slot? Computed from the reg's own stored fields, before any live-sheet
  // lookup or trainer resolution — needed up front so an unchanged slot can
  // skip both entirely (a live-schedule hiccup or a since-removed sheet row
  // must never block a client from editing kids on a booking that isn't
  // actually moving, and the booking's own still-confirmed row would
  // otherwise count as a false "conflict"/"full" against itself).
  const weeklySlotUnchanged = newType === "weekly" && reg.type === "weekly"
    && reg.booked_date === bookedDate && reg.booked_start_time === bookedStartTime
    && reg.booked_end_time === bookedEndTime && reg.booked_location === bookedLocation
    && (reg.booked_group || undefined) === (sessionGroup || undefined);

  // Weekly: never trust the client's own trainer field, same reasoning as a
  // fresh booking (see register/route.ts) — capacity is pooled per trainer,
  // so an unverified trainer name here could land in a pool nothing else
  // counts against, silently bypassing that group's real capacity limit.
  // Re-resolve it from the live sheet instead of the client-submitted
  // sessionTrainer, and reject outright if that exact session no longer
  // exists there (schedule changed since the client's page loaded) — but
  // only when the session is actually moving; see weeklySlotUnchanged above.
  let resolvedTrainer: string | undefined;
  if (newType === "weekly") {
    if (weeklySlotUnchanged) {
      resolvedTrainer = reg.booked_trainer || "Artemios Gavalas";
    } else {
      const liveWeeklySchedule = await getWeeklySchedule({ noCache: true });
      const liveMatch = liveWeeklySchedule.find(
        (ls) => ls.group === sessionGroup && ls.date === bookedDate && ls.startTime === bookedStartTime
      );
      if (!liveMatch) {
        return NextResponse.json(
          { error: "Couldn't verify that session against the current schedule. Please refresh and try again." },
          { status: 400 }
        );
      }
      resolvedTrainer = liveMatch.trainer || "Artemios Gavalas";
      const { available } = await checkGroupSessionCapacity(bookedDate, bookedStartTime, sessionGroup || "", liveMatch.maxSpots, resolvedTrainer);
      if (!available) {
        return NextResponse.json({ error: "That session is now full. Please refresh and try again." }, { status: 400 });
      }
    }
  } else {
    resolvedTrainer = bookedTrainer;
  }

  // Same authoritative slot+trainer+conflict check as a fresh booking (see
  // register/route.ts) — required here too now that trainer determines
  // price: a client-side reschedule form could otherwise name a cheaper
  // substitute trainer for a window only the higher-rate trainer actually
  // offers, or reschedule into a slot that trainer no longer has. Skipped
  // when the request isn't actually moving the session (e.g. only the kid
  // count changed) — the old booking's own row would otherwise show up as
  // a "conflict" against itself, since it's still confirmed at this point.
  const isSameSlotAsBefore = reg.booked_date === bookedDate && reg.booked_start_time === bookedStartTime
    && reg.booked_end_time === bookedEndTime && reg.booked_location === bookedLocation
    && (reg.booked_trainer || undefined) === resolvedTrainer;
  if (newType !== "weekly" && !isSameSlotAsBefore) {
    if (!resolvedTrainer) {
      return NextResponse.json({ error: "Missing trainer for the new session" }, { status: 400 });
    }
    const [slotOffered, slotConflicting] = await Promise.all([
      isPrivateWindowOfferedByTrainer(bookedDate, bookedStartTime, bookedEndTime, bookedLocation, resolvedTrainer),
      hasConflictingPrivateBooking(bookedDate, bookedStartTime, bookedEndTime, bookedLocation, resolvedTrainer),
    ]);
    if (!slotOffered || slotConflicting) {
      return NextResponse.json({ error: "That session is no longer available. Please refresh and try again." }, { status: 400 });
    }
  }

  // Check if original session is within 24h (with grace period) → late reschedule fee applies
  const isLateReschedule = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));

  // Whether the OLD session was part of a bulk/volume-discounted weekly
  // booking (the 10%/15% off for booking several sessions at once) — the
  // full-forfeiture-on-late-reschedule policy only applies to those, not a
  // plain 1-3 session weekly booking at the regular rate (which keeps the
  // old 50% late-fee policy). Read from the stored, booking-time-anchored
  // flag rather than re-deriving it from the group's CURRENT live rate — a
  // rate change since booking would otherwise silently reclassify this
  // booking's policy (see is_bulk_discounted migration comment). Reschedule
  // is always allowed regardless of discount, same as before.
  const isBulkDiscountedWeekly = reg.type === "weekly" && !!reg.is_bulk_discounted;

  // What was actually paid for the old session via Stripe (if it was), net
  // of any account credit applied at booking time — this is the baseline
  // the new session's price gets reconciled against below.
  const oldPaymentIntentId = reg.stripe_payment_intent_id || undefined;
  const oldPaidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));

  // The old booking is deliberately left COMPLETELY untouched through this
  // whole computation — no cancellation, no credit refunds, no calendar
  // changes, no late fee. If this reschedule turns out to need a Stripe
  // topup (below), all of that is deferred until that payment actually
  // succeeds (see settleOldBookingForReschedule in booking-finalize.ts) —
  // an abandoned/expired Checkout must leave the client exactly where they
  // started, not mid-cancelled with a fee already taken and no new session
  // to show for it. When no topup is needed, this reschedule completes in
  // one request/response with nothing async in between, so it's safe to
  // settle the old booking synchronously right before returning — see the
  // settleOldBookingForReschedule call further below.

  const newParentName = typeof bodyParentName === "string" && bodyParentName.trim() ? bodyParentName.trim() : reg.parent_name;
  const newPhone = typeof bodyPhone === "string" && bodyPhone.trim() ? bodyPhone.trim() : reg.phone;

  // Apply referral credit to rescheduled booking if client chose to use it
  const isPrivateReschedule = newType === "private";
  let newIsFree = false;
  let newUsedReferralCredit = false;
  if (useReferralCredit && isPrivateReschedule) {
    const credits = await getReferralCredits(reg.email).catch(() => 0);
    if (credits > 0) {
      // decrementReferralCredit is itself race-safe, but its result must be
      // checked — see the identical fix in register/route.ts. A raced
      // concurrent reschedule/booking request could have this specific
      // decrement fail while the credit was actually consumed elsewhere,
      // and without checking the result this reschedule would still get
      // persisted as referral-credit-covered with no credit ever reserved
      // for it.
      const decremented = await decrementReferralCredit(reg.email).catch(() => false);
      if (decremented) {
        newIsFree = true;
        newUsedReferralCredit = true;
      }
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
    newSessionPrice = calcPrivatePrice(duration, kidCount, getTrainerTier(resolvedTrainer));
  }
  const newPriceKnown = newSessionPrice != null;
  const newEffectivePrice = newPriceKnown
    ? resolvedSessionPrice({ session_price: newSessionPrice ?? null, is_free: newIsFree, used_referral_credit: newUsedReferralCredit, type: newType, booked_trainer: resolvedTrainer })
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
  //
  // Everything here is a PREVIEW — pure computation, no DB writes, no
  // credit movement. If this ends up needing a Stripe topup, the actual
  // credit/forfeiture/log only happens for real once that payment succeeds
  // (settleOldBookingForReschedule, called either synchronously below when
  // no topup is needed, or from the webhook once one is paid) — using this
  // exact same math (computeLateFeeAmounts) so the amount a client is asked
  // to pay always matches what actually gets applied later.
  let priceReconciliation: { kind: "refund" | "charge"; amount: number } | null = null;
  let previewLateFeeCreditApplied = 0;
  if (oldPaymentIntentId) {
    if (isLateReschedule) {
      const amounts = computeLateFeeAmounts(oldPaidAmount, isBulkDiscountedWeekly, newPriceKnown, newEffectivePrice);
      previewLateFeeCreditApplied = amounts.lateFeeCreditApplied;
      if (newPriceKnown && newEffectivePrice! > 0) {
        const amountStillOwed = Math.round((newEffectivePrice! - previewLateFeeCreditApplied) * 100) / 100;
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
  }

  // A package-covered session has no Stripe payment on this row (it was
  // covered by the package's lump-sum charge instead), so oldPaymentIntentId
  // is always undefined for it and the block above never runs. A late
  // reschedule forfeits the OLD session from the package (logged for real
  // once settled, same as everything else here — just previewed as a
  // boolean below for the API response). Whether the NEW session is still
  // covered depends on whether the package has any capacity left AFTER that
  // forfeiture: if so, the new date is covered for free (so long as it's
  // still the same month); if not — either a different month, or this
  // really was their last session — it's priced and charged like a normal
  // new booking, same as buying a fresh session outright.
  let newPackageId: string | undefined;
  const packageSessionForfeitedPreview = !!(reg.package_id && isLateReschedule);
  let newSessionPackageCovered = false;
  if (reg.package_id) {
    // Packages only ever cover a standard private session (up to 3 kids) —
    // never a 4+ kid group-private rate, regardless of remaining capacity.
    const oldPkg = await getPackageById(reg.package_id).catch(() => null);
    // Also requires the NEW trainer to be covered by the package's own tier
    // (see packageCoversTrainerTier) — a reschedule can change trainer
    // (resolvedTrainer comes straight from the client), and without this
    // check an "Any Available Trainer" package could silently cover an
    // Artemios session for free.
    if (oldPkg && newType === "private" && kidCount <= 3 && packageCoversTrainerTier(normalizeTrainerTier(oldPkg.trainer_tier), getTrainerTier(resolvedTrainer))) {
      const d = new Date(bookedDate);
      if (!isNaN(d.getTime())) {
        const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (newMonth === oldPkg.month_year) {
          // The old row is still sitting "confirmed" right now (nothing's
          // been cancelled yet — see above), which this count would
          // otherwise treat as "used". For an ON-TIME reschedule that's
          // about to free it back, exclude it explicitly so this reflects
          // what capacity will actually look like once settled, not what
          // it looks like this instant. A LATE reschedule needs no
          // exclusion — "confirmed" and its eventual "cancelled + forfeited"
          // outcome both count as used identically either way.
          const usedSoFar = await countPackageSessionsUsed(oldPkg.id, isLateReschedule ? undefined : reg.id).catch(() => oldPkg.package_type);
          if (usedSoFar < oldPkg.package_type) {
            newPackageId = oldPkg.id;
            newSessionPackageCovered = true;
          }
        }
      }
    }
    // Different month, switched away from private, bumped to 4+ kids, or the
    // package has no capacity left (this was their last session) — the
    // package can't cover it, so price and charge the new session like a
    // normal booking rather than silently giving it away for free.
    if (!newSessionPackageCovered && newPriceKnown && newEffectivePrice! > 0) {
      priceReconciliation = { kind: "charge", amount: newEffectivePrice! };
    }
  }
  // Bulk-discounted weekly group sessions: late reschedule is full
  // forfeiture of the old session, and the new session is always charged at
  // full price — the charge itself already happens naturally above
  // (previewLateFeeCredited was forced to 0 for a bulk booking, so the full
  // newEffectivePrice flows through as priceReconciliation); this flag only
  // drives the wording below.
  const fullForfeitNoRefund = isBulkDiscountedWeekly && isLateReschedule;

  // Price increased (or a late reschedule needs a fresh full charge): the
  // new booking isn't confirmed yet — send the client to Stripe Checkout for
  // just what's owed. CRITICALLY, the OLD booking is not touched at all
  // here — not cancelled, no credit refunded, no calendar change, no late
  // fee — it stays exactly as-is unless and until the webhook confirms this
  // payment actually succeeded (finalizeRescheduleTopup, which calls
  // settleOldBookingForReschedule using original_manage_token below). An
  // abandoned/expired Checkout then leaves the original booking completely
  // untouched, same as if the reschedule was never attempted.
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
      appliedAccountCredit: previewLateFeeCreditApplied || undefined,
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
        // The OLD booking's own token — settleOldBookingForReschedule (run
        // from the webhook, once payment succeeds) looks this up fresh
        // rather than trusting anything computed/cached here at request
        // time, and is what actually cancels it and applies every side
        // effect (trainer notify, credit refunds, calendar, late fee).
        original_manage_token: token,
        old_session_details: reg.session_details,
        resolved_trainer: resolvedTrainer || "",
        is_late_reschedule: String(!!isLateReschedule),
        is_bulk_discounted_weekly: String(isBulkDiscountedWeekly),
        topup_amount: String(priceReconciliation.amount),
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
            product_data: { name: serviceFeeItemName(priceReconciliation.amount) },
            unit_amount: Math.round(calcServiceFee(priceReconciliation.amount) * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/schedule?checkout=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    await attachStripeCheckoutSession(bookingBatchId, checkoutSession.id);

    return NextResponse.json({ success: true, checkoutUrl: checkoutSession.url, isLateReschedule: !!isLateReschedule, packageSessionForfeited: packageSessionForfeitedPreview, fullForfeitNoRefund });
  }

  // No further payment needed (same price, a price decrease, or a
  // non-Stripe booking) — this whole reschedule completes in this one
  // request/response, with nothing async in between, so it's safe to settle
  // the old booking for real right now (cancel it, refund its
  // referral/account credit, notify its trainer, sync its calendar, and —
  // if late — credit/apply/log its 50% forfeiture).
  const settled = await settleOldBookingForReschedule({
    reg,
    isLateReschedule,
    isBulkDiscountedWeekly,
    resolvedTrainer,
    newSessionDetails,
    newEffectivePrice,
    newPriceKnown,
  });
  if (!settled.cancelled) {
    return NextResponse.json({ error: "This booking was already cancelled or rescheduled" }, { status: 409 });
  }
  const { lateFeeCredited, lateFeeCreditApplied, packageSessionForfeited } = settled;

  // A price decrease is credited to the account rather than refunded back
  // to the card: real Stripe refunds are reserved for actual cancellations
  // (24h+ notice) where the client is leaving — a reschedule keeps the
  // booking (and the relationship) going, so the difference stays with Mesa
  // as credit toward a future session instead of round-tripping real money
  // through Stripe.
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

  // The new row's own package consumption (if the package covered it) —
  // separate from the forfeiture recompute already done right after the old
  // row was cancelled, since that only reflected the OLD row's outcome, not
  // this new one.
  if (newPackageId) {
    try {
      const used = await countPackageSessionsUsed(newPackageId);
      await setPackageSessions(newPackageId, used);
    } catch {
      // non-critical — don't fail the reschedule
    }
  }

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

  const lateFeeAmount = reg.package_id || fullForfeitNoRefund
    ? undefined
    : isLateReschedule && !priceReconciliation && !lateFeeCredited
      ? Math.round(resolvedSessionPrice(reg) * 0.5 * 100) / 100
      : undefined;

  // priceReconciliation is never "charge" by this point — that branch
  // returns early via Stripe Checkout above, well before this code runs; the
  // confirmation for that case fires later from finalizeRescheduleTopup once
  // the webhook confirms payment, not here.
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
      packageSessionForfeited,
      newSessionPackageCovered: packageSessionForfeited ? newSessionPackageCovered : undefined,
      fullForfeitNoRefund,
    });
  } catch (notifyErr) {
    console.error("Reschedule email failed (booking already updated):", notifyErr);
  }

  const rescheduleTrainerLine = resolvedTrainer ? `\nTrainer: ${resolvedTrainer}` : "";
  const refundOutcomeText = refundAdjustment ? describeMoneyOutcome(refundAdjustment, 0, false, false) : "";
  const refundOutcomeAdminText = refundAdjustment ? describeMoneyOutcome(refundAdjustment, 0, false, true) : "";
  const leftoverLateFeeCredit = Math.max(0, lateFeeCredited - lateFeeCreditApplied);
  if (reg.sms_consent && reg.phone) {
    const rescheduleLabel = newSessionDetails.split(" — ")[0] || "Session";
    const lateNote = packageSessionForfeited
      ? (newSessionPackageCovered
          ? "\nLate reschedule: your original session was forfeited from your package, but your new session is still covered — nothing further charged."
          : "\nLate reschedule: your original session was forfeited from your package, and it no longer has capacity to cover the new date — see below for what's owed.")
      : fullForfeitNoRefund
        ? "\nLate reschedule: your original session is fully forfeited (non-refundable) — the new session is charged at full price, see below."
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
  const adminPackageNote = packageSessionForfeited
    ? (newSessionPackageCovered ? "\nPackage session — late reschedule, old session forfeited, new session still covered" : "\nPackage session — late reschedule, old session forfeited, package exhausted (new session charged)")
    : reg.package_id
      ? "\nPackage session — slot moved, no fee"
      : "";
  const adminForfeitNote = fullForfeitNoRefund ? "\nWeekly late reschedule — old session forfeited, new session full price" : "";
  await sendAdminSMS(`RESCHEDULED: ${newParentName}\nFrom: ${reg.session_details}\nTo: ${newSessionDetails}${rescheduleTrainerLine}\nPlayers: ${kidsToUse}${refundOutcomeAdminText ? `\n${refundOutcomeAdminText}` : ""}${adminCreditNote}${adminPackageNote}${adminForfeitNote}`);

  // Trainer-facing NEW-side notification only — the old trainer (if this
  // swapped trainers) was already notified right after the old booking was
  // cancelled, near the top of this function; that fires unconditionally
  // regardless of which branch we take, while this point is only reached
  // when no further payment was needed (see finalizeRescheduleTopup for the
  // equivalent new-side notification when a Stripe top-up was required).
  if (bookedDate && bookedStartTime) {
    const oldTrainer = reg.booked_trainer;
    const newTrainer = resolvedTrainer;
    const newLabel = newType === "weekly" ? (sessionGroup || "Group Session") : newType === "group-private" ? "Group Private Session" : "Private Session";
    const slotActuallyMoved = reg.booked_date !== bookedDate || reg.booked_start_time !== bookedStartTime || (reg.booked_end_time || reg.booked_start_time) !== (bookedEndTime || bookedStartTime) || (reg.booked_location || "") !== (bookedLocation || "");
    if (oldTrainer && newTrainer && oldTrainer === newTrainer && reg.booked_date && reg.booked_start_time && slotActuallyMoved) {
      await notifyTrainerOfReschedule({
        trainer: newTrainer,
        parentName: newParentName,
        sessionLabel: newLabel,
        oldDate: reg.booked_date,
        oldStartTime: reg.booked_start_time,
        oldEndTime: reg.booked_end_time || reg.booked_start_time,
        newDate: bookedDate,
        newStartTime: bookedStartTime,
        newEndTime: bookedEndTime || bookedStartTime,
        location: bookedLocation || "",
      }).catch((err) => console.error("Trainer reschedule notify failed:", err));
    } else if (newTrainer && newTrainer !== oldTrainer) {
      await notifyTrainerOfNewBooking({
        trainer: newTrainer,
        parentName: newParentName,
        kids: kidsToUse,
        sessionLabel: newLabel,
        date: bookedDate,
        startTime: bookedStartTime,
        endTime: bookedEndTime || bookedStartTime,
        location: bookedLocation || "",
      }).catch((err) => console.error("Trainer reschedule-newbooking notify failed:", err));
    }
  }

  return NextResponse.json({
    success: true,
    newToken,
    isLateReschedule: !!isLateReschedule,
    packageSessionForfeited,
    newSessionPackageCovered: packageSessionForfeited ? newSessionPackageCovered : undefined,
    fullForfeitNoRefund,
  });
}
