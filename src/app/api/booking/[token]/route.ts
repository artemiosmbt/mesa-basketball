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
} from "@/lib/supabase";
import { issueStripeRefund, resolvedSessionPrice, describeMoneyOutcome, isLateAction, parseSessionDateTimeET } from "@/lib/booking-finalize";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE } from "@/lib/pricing";
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
      let cancelCredit = 0;
      let stripeRefundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
      if (wasPaid && reg.email) {
        const paidAmount = Math.max(0, resolvedSessionPrice(reg) - groupCredit);
        if (isLateCancel) {
          cancelCredit = Math.round(paidAmount * 0.5);
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
        ? Math.round(Math.max(0, resolvedSessionPrice(reg) - groupCredit) * 0.5)
        : undefined;
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
    const thisDayLateFee = isLateCancel ? Math.round(perDayRate * 0.5) : 0;
    const success = await cancelRegistration(token, isLateCancel, thisDayLateFee);
    if (!success) {
      // Zero rows matched — another request already cancelled this day.
      // Bail out here so the refund logic below never runs twice.
      return NextResponse.json({ error: "This day was already cancelled" }, { status: 409 });
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
    const delta = finalAmount - originalAmount;

    // If they already paid more than the new total, that difference goes
    // back — a real Stripe refund when this day's charge went through
    // Stripe (the late-fee math above is already baked into the amount, so
    // there's no separate "late keeps it all" branch needed here), account
    // credit for the old manual/cash path.
    const creditGranted = isPaid && delta < 0 ? -delta : 0;
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
        : ` Amount due: $${finalAmount}.`;
      await sendSMS(reg.phone, `Mesa Basketball: ${campName} — ${formatDateWithDay(reg.booked_date || "")} cancelled. New total: $${finalAmount} (was $${originalAmount}).${adjustmentLine}\nReply STOP to opt out.`);
    }
    const adminMoneyOutcome = isPaid ? describeMoneyOutcome(stripeRefundResult, creditGranted, false, true) : "";
    await sendAdminSMS(`CAMP DAY CANCELLED: ${reg.parent_name}\n${campName} — ${reg.booked_date}\nNew total: $${finalAmount} (was $${originalAmount})${isPaid ? (adminMoneyOutcome ? ` — ${adminMoneyOutcome}` : "") : ` — due: $${finalAmount}`}`);

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
      delta,
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
      cancelCredit = Math.round(paidAmount * 0.5);
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
      ? Math.round(Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0)) * 0.5)
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
          ? `\nLate cancellation fee: $${Math.round(((packageLateFeeAmount || 0) + SERVICE_FEE) * 100) / 100}. Finish payment here: ${packageLateFeeCheckoutUrl}`
          : isLateCancel ? "\nA late cancellation fee applies — we'll be in touch." : "\nYour package session is available for you to rebook.")
      : wasPaid
        ? (moneyOutcome ? `\n${moneyOutcome}.` : "\nNothing additional is due — your account credit already covered this.")
        : isLateCancel ? "\nA late cancellation fee applies." : "";
    await sendSMS(reg.phone, `Mesa Basketball: ${cancelLabel} cancelled.${sessionLine}\nAthlete: ${reg.kids}${lateNote}\nmesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }
  const adminMoneyOutcome = describeMoneyOutcome(stripeRefundResult, cancelCredit, isLateCancel, true);
  const adminPackageNote = reg.package_id
    ? packageLateFeeCheckoutUrl
      ? `\nPackage session — late fee checkout sent: $${Math.round(((packageLateFeeAmount || 0) + SERVICE_FEE) * 100) / 100}`
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

function calcPrivatePrice(durationMins: number, kidCount: number): number {
  return Math.round((kidCount >= 4 ? 250 : 150) * (durationMins / 60) * 100) / 100;
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
        newPrice = isLate ? Math.round((lowPrice + highPrice) / 2) : Math.round(lowPrice);
        if (isLate) lateFeeDue = Math.round(newPrice - lowPrice);
      } else {
        // 1-3 → 4+: gaining tier (no fee)
        newPrice = Math.round(highPrice);
      }
      priceChanged = true;
    }
  } else if (reg.type === "weekly") {
    const oldGroupPrice = reg.session_price ?? oldCount * 50;
    const newGroupPrice = newCount * 50;
    if (newGroupPrice !== oldGroupPrice) {
      if (isLate && removedPlayers.length > 0) lateFeeDue = removedPlayers.length * 25;
      newPrice = newGroupPrice;
      priceChanged = true;
    }
  }

  const ok = await updateRegistrationPlayers(token, newKidsStr, newCount, newPrice);
  if (!ok) return NextResponse.json({ error: "This booking is no longer active — it may have just been cancelled" }, { status: 409 });

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
    const priceNote = priceChanged ? ` | New price: $${newPrice}` : "";
    await sendAdminSMS(`PLAYERS UPDATED (${sessionLabel}): ${reg.parent_name}\n${changeNote || "Roster order/details changed"}\nNow: ${newKidsStr}${priceNote}`);
  } catch (err) {
    console.error("Player update email/SMS error:", err);
  }

  return NextResponse.json({ success: true, newKids: newKidsStr, newPrice, isLate, lateFeeDue });
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
  const newType: "private" | "weekly" = bodySessionType === "weekly" ? "weekly" : "private";
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
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date });
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

  // Compute the new session's price. Same-type reschedule: preserve the
  // per-player discount rate (divide by original participant count, scale to
  // new count). Type-switch reschedule (private <-> weekly, or group-private
  // <-> private): compute a fresh price for the NEW type from scratch —
  // this used to just leave newSessionPrice undefined for any type switch,
  // which meant NO price reconciliation ever ran for it and a client
  // downgrading e.g. private -> weekly silently never got the difference
  // back.
  let newSessionPrice: number | undefined;
  if (reg.type === newType && reg.session_price != null && reg.total_participants > 0) {
    const perPlayerRate = reg.session_price / reg.total_participants;
    newSessionPrice = Math.round(perPlayerRate * kidCount);
  } else if (newType === "weekly") {
    newSessionPrice = kidCount * 50;
  } else if (newType === "private" && bookedStartTime && bookedEndTime) {
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
  if (oldPaymentIntentId) {
    if (isLateReschedule) {
      lateFeeCredited = Math.round(oldPaidAmount * 0.5);
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
    if (newType === "private") {
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
      ? Math.round(resolvedSessionPrice(reg) * 0.5)
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
          ? `\nLate reschedule fee: $${packageFeeTotal}. Finish payment here: ${packageLateFeeCheckoutUrl}`
          : isLateReschedule ? "\nA late reschedule fee applies — we'll be in touch." : "")
      : isLateReschedule && !priceReconciliation && !lateFeeCredited ? "\nA late reschedule fee applies." : "";
    const creditNote = lateFeeCreditApplied > 0
      ? `\n$${lateFeeCreditApplied} of your late fee credit covered your new session${leftoverLateFeeCredit > 0 ? ` ($${leftoverLateFeeCredit} left in your account)` : ""} — nothing further charged.`
      : lateFeeCredited > 0
        ? `\n$${lateFeeCredited} credited to your account (late reschedule fee).`
        : "";
    const refundNote = refundOutcomeText ? `\n${refundOutcomeText}.` : "";
    await sendSMS(reg.phone, `Mesa Basketball: ${rescheduleLabel} rescheduled!\n${formatDateWithDay(bookedDate)} | ${bookedStartTime}-${bookedEndTime}\nLocation: ${resolveLocationName(bookedLocation)}${rescheduleTrainerLine}\nAthlete: ${kidsToUse}${lateNote}${creditNote}${refundNote}\nManage: mesabasketballtraining.com/booking/${newToken}\nReply STOP to opt out.`);
  }
  const adminCreditNote = lateFeeCreditApplied > 0
    ? `\n$${lateFeeCreditApplied} late-fee credit applied to new session${leftoverLateFeeCredit > 0 ? ` ($${leftoverLateFeeCredit} left in account)` : ""}`
    : lateFeeCredited > 0
      ? `\n$${lateFeeCredited} credited (late fee)`
      : "";
  const adminPackageNote = reg.package_id
    ? packageLateFeeCheckoutUrl
      ? `\nPackage session — late fee checkout sent: $${packageFeeTotal}`
      : "\nPackage session — slot moved, no fee"
    : "";
  await sendAdminSMS(`RESCHEDULED: ${newParentName}\nFrom: ${reg.session_details}\nTo: ${newSessionDetails}${rescheduleTrainerLine}\nPlayers: ${kidsToUse}${refundOutcomeAdminText ? `\n${refundOutcomeAdminText}` : ""}${adminCreditNote}${adminPackageNote}`);

  return NextResponse.json({ success: true, newToken, isLateReschedule: !!isLateReschedule, checkoutUrl: packageLateFeeCheckoutUrl });
}
