import Stripe from "stripe";
import { sendRegistrationNotification, sendReferralCreditNotification, sendRescheduleNotification } from "@/lib/email";
import { addPrivateSessionToCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { getStripe } from "@/lib/stripe";
import {
  addReferralCredit,
  addAccountCredit,
  abandonPendingBookingBatch,
  finalizePaidBookingBatch,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
  recordStripeRefund,
} from "@/lib/supabase";

/**
 * Refunds part or all of a real Stripe charge — used for on-time
 * cancellations and for reschedules that move to a lower-priced session. On
 * success, records the refund id on the row (bookkeeping) and returns true.
 * On failure, does NOT fall back to account credit — silently substituting
 * credit for a promised card refund would be an undisclosed policy change —
 * instead it alerts the admin to refund manually and returns false so the
 * caller can adjust what it tells the client.
 *
 * One exception: a booking that went through a Stripe reschedule "topup"
 * only has its *most recent* charge on file, so if this amount exceeds what
 * that specific charge has left to refund (the rest came from an earlier,
 * already-superseded charge), Stripe rejects it. That case refunds whatever
 * IS still available and credits the shortfall to the account instead of
 * failing outright — still real money back where it's due, just split
 * across the refund and the credit ledger, with an admin alert either way.
 */
export interface StripeRefundResult {
  // Dollars actually sent back to the card.
  refundedAmount: number;
  // Dollars credited to the account instead — either the shortfall from the
  // amount_too_large fallback below, or the full amount if the refund call
  // failed outright and there's nothing left to try automatically.
  creditedAmount: number;
  // True only when the Stripe call failed AND nothing was recovered via the
  // fallback — callers must not tell the client "refunded" in this case.
  failed: boolean;
}

/**
 * Refunds part or all of a real Stripe charge — used for on-time
 * cancellations and for reschedules that move to a lower-priced session.
 * Callers MUST use the returned amounts (not just assume success) when
 * telling the client what happened — see the failure/fallback cases below,
 * both of which can mean less landed on the card than was requested.
 *
 * On success, records the refund id on the row (bookkeeping) and returns
 * `{ refundedAmount: amountDollars, creditedAmount: 0, failed: false }`.
 *
 * On failure, does NOT fall back to account credit — silently substituting
 * credit for a promised card refund would be an undisclosed policy change —
 * instead it alerts the admin to refund manually and returns
 * `{ refundedAmount: 0, creditedAmount: 0, failed: true }`.
 *
 * One exception: a booking that went through a Stripe reschedule "topup"
 * only has its *most recent* charge on file, so if this amount exceeds what
 * that specific charge has left to refund (the rest came from an earlier,
 * already-superseded charge), Stripe rejects it. That case refunds whatever
 * IS still available and credits the shortfall to the account instead of
 * failing outright — still real money back where it's due, just split
 * across the refund and the credit ledger, with an admin alert either way.
 */
export async function issueStripeRefund(params: {
  email: string;
  manageToken: string;
  paymentIntentId: string;
  amountDollars: number;
  sessionLabel: string;
}): Promise<StripeRefundResult> {
  if (params.amountDollars <= 0) return { refundedAmount: 0, creditedAmount: 0, failed: false };
  const stripe = getStripe();
  try {
    const refund = await stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: Math.round(params.amountDollars * 100),
    });
    await recordStripeRefund(params.manageToken, refund.id).catch(() => {});
    return { refundedAmount: params.amountDollars, creditedAmount: 0, failed: false };
  } catch (err) {
    // Different Stripe API versions surface this differently — some set
    // `code: "amount_too_large"`, this account's version leaves code
    // undefined and only sets `param: "amount"` — so check both.
    const isOverRefundError = err instanceof Stripe.errors.StripeInvalidRequestError
      && (err.code === "amount_too_large" || err.param === "amount");
    if (isOverRefundError) {
      try {
        const pi = await stripe.paymentIntents.retrieve(params.paymentIntentId, { expand: ["latest_charge"] });
        const charge = pi.latest_charge as Stripe.Charge | null;
        const refundableDollars = charge ? Math.max(0, charge.amount - charge.amount_refunded) / 100 : 0;
        if (refundableDollars > 0) {
          const partial = await stripe.refunds.create({
            payment_intent: params.paymentIntentId,
            amount: Math.round(refundableDollars * 100),
          });
          await recordStripeRefund(params.manageToken, partial.id).catch(() => {});
        }
        const shortfall = Math.round((params.amountDollars - refundableDollars) * 100) / 100;
        if (shortfall > 0) {
          await addAccountCredit(params.email, shortfall).catch(() => {});
        }
        await sendAdminSMS(`Partial refund: ${params.sessionLabel}\n${params.email}\n$${refundableDollars} refunded to card${shortfall > 0 ? `, $${shortfall} credited to account (an earlier reschedule already used up part of this charge)` : ""}.`).catch(() => {});
        return { refundedAmount: refundableDollars, creditedAmount: shortfall, failed: false };
      } catch (fallbackErr) {
        console.error("Stripe refund fallback failed:", fallbackErr);
      }
    }
    console.error("Stripe refund failed:", err);
    try {
      await sendAdminSMS(`REFUND FAILED — manual action needed\n${params.sessionLabel}\n${params.email}\n$${params.amountDollars} could not be refunded automatically. Refund manually in the Stripe dashboard.`);
    } catch {
      // non-critical
    }
    return { refundedAmount: 0, creditedAmount: 0, failed: true };
  }
}

export interface FinalizePrivateBookingParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  bookedDate: string;
  bookedStartTime: string;
  bookedEndTime: string;
  bookedLocation: string;
  bookedTrainer?: string;
  manageToken: string;
  isFree: boolean;
  isFirstTime: boolean;
  referralCode: string;
  privateReferrer: { email: string; name: string } | null;
  submittedReferralCode?: string;
  smsConsent: boolean;
  accountCreditApplied: number;
  fullPrice?: number;
}

/**
 * Runs everything that used to happen synchronously right after a private
 * booking's DB insert in /api/register: package usage recompute, the
 * referrer's credit award, the confirmation email, client + admin SMS, and
 * the Google Calendar event. Now also called from the Stripe webhook once
 * payment actually succeeds, so a booking is only "confirmed" — and the
 * client/admin only notified — once money has actually moved.
 */
export async function finalizeConfirmedPrivateBooking(params: FinalizePrivateBookingParams): Promise<void> {
  const isPrivateType = params.type === "private" || params.type === "group-private";

  let packageSessionsRemaining: number | undefined;
  let packageType: number | undefined;

  // Wrapped like every other side effect below — a transient DB error here
  // must not abort the referral credit, email, SMS, and calendar sync that
  // follow for a booking that's already been paid for.
  try {
    if (isPrivateType && params.bookedDate) {
      const d = new Date(params.bookedDate);
      const bookingMonth = isNaN(d.getTime())
        ? null
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const activePkg = bookingMonth ? await getActivePackage(params.email, bookingMonth) : null;
      if (activePkg && bookingMonth) {
        const confirmedCount = await countConfirmedPrivateSessions(params.email, bookingMonth);
        const newUsed = Math.min(activePkg.package_type, confirmedCount);
        await setPackageSessions(activePkg.id, newUsed);
        if (newUsed <= activePkg.package_type) {
          packageSessionsRemaining = activePkg.package_type - newUsed;
          packageType = activePkg.package_type;
        }
      }
    }
  } catch (pkgErr) {
    console.error("Package usage recompute failed (private, booking was paid):", pkgErr);
  }

  // Best-effort — the booking is already paid for and confirmed, so a
  // failure here must not surface as a failed booking.
  if (params.privateReferrer) {
    try {
      await addReferralCredit(params.privateReferrer.email);
      await sendReferralCreditNotification({
        referrerName: params.privateReferrer.name,
        referrerEmail: params.privateReferrer.email,
        newClientName: params.parentName,
      });
    } catch (creditErr) {
      console.error("Failed to award referral credit (private, booking was paid):", creditErr);
    }
  }

  try {
    await sendRegistrationNotification({
      parentName: params.parentName,
      email: params.email,
      phone: params.phone,
      kids: params.kids,
      type: params.type,
      sessionDetails: params.sessionDetails,
      totalParticipants: params.totalParticipants,
      manageToken: params.manageToken,
      isFree: params.isFree,
      isFirstTime: params.isFirstTime,
      packageSessionsRemaining,
      packageType,
      referralCode: params.referralCode,
      referredBy: params.privateReferrer?.name,
      referralCodeUsed: params.submittedReferralCode || undefined,
      trainer: isPrivateType ? params.bookedTrainer : undefined,
      calendarEvent: { date: params.bookedDate, startTime: params.bookedStartTime, endTime: params.bookedEndTime || params.bookedStartTime, location: params.bookedLocation || "" },
      accountCreditApplied: params.accountCreditApplied,
      fullPrice: params.fullPrice,
    });
  } catch (notifyErr) {
    console.error("Private booking email failed (booking was paid):", notifyErr);
  }

  if (params.smsConsent && params.phone) {
    const typeStr = isPrivateType ? "private session" : "session";
    const dateLine = `\n${formatDateWithDay(params.bookedDate)} | ${params.bookedStartTime}${params.bookedEndTime ? `-${params.bookedEndTime}` : ""}${params.bookedLocation ? `\nLocation: ${resolveLocationName(params.bookedLocation)}` : ""}`;
    const pkgNote = packageSessionsRemaining !== undefined
      ? `\n${packageSessionsRemaining} session${packageSessionsRemaining !== 1 ? "s" : ""} remaining in your package.`
      : "";
    const privateTrainerLine = isPrivateType && params.bookedTrainer ? `\nTrainer: ${params.bookedTrainer}` : "";
    const creditLine = params.accountCreditApplied > 0 ? `\n$${params.accountCreditApplied} account credit applied.` : "";
    await sendSMS(params.phone, `Mesa Basketball: Your ${typeStr} is confirmed!${dateLine}${privateTrainerLine}${pkgNote}${creditLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminDateLine = `${formatDateWithDay(params.bookedDate)} | ${params.bookedStartTime}${params.bookedEndTime ? `-${params.bookedEndTime}` : ""}${params.bookedLocation ? `\nLocation: ${resolveLocationName(params.bookedLocation)}` : ""}`;
  const pkgAdminNote = packageSessionsRemaining !== undefined
    ? `\nPkg: ${packageSessionsRemaining}/${packageType} remaining`
    : "";
  const adminTrainerLine = isPrivateType && params.bookedTrainer ? `\nTrainer: ${params.bookedTrainer}` : "";
  const adminTypeLabel = params.type === "group-private" ? "group private" : "private";
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n1 ${adminTypeLabel} session:\n${adminDateLine}${adminTrainerLine}\nPlayers: ${params.kids}${pkgAdminNote}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${params.privateReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`);

  if (isPrivateType && params.bookedDate && params.bookedStartTime && params.bookedEndTime) {
    try {
      await addPrivateSessionToCalendar({
        parentName: params.parentName,
        email: params.email,
        phone: params.phone,
        kids: params.kids,
        bookedDate: params.bookedDate,
        bookedStartTime: params.bookedStartTime,
        bookedEndTime: params.bookedEndTime,
        bookedLocation: params.bookedLocation || "",
        trainer: params.bookedTrainer || undefined,
      });
    } catch (err) {
      console.error("Calendar sync error (private, post-payment):", err);
    }
  }
}

export interface FinalizeWeeklyBookingParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  weeklySessions: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    group: string;
    trainer?: string;
    maxSpots?: number;
  }>;
  totalParticipants: number;
  referralCode: string;
  weeklyReferrer: { email: string; name: string } | null;
  submittedReferralCode?: string;
  smsConsent: boolean;
  weeklyTotalPrice?: number;
  weeklyCreditApplied: number;
}

/**
 * Same role as finalizeConfirmedPrivateBooking, but for a batch of weekly
 * group-session rows created together (one row per selected date). Sends a
 * single consolidated email/SMS across all sessions, same as before Stripe.
 */
export async function finalizeConfirmedWeeklyBooking(params: FinalizeWeeklyBookingParams): Promise<void> {
  const { weeklySessions, weeklyReferrer, weeklyCreditApplied, weeklyTotalPrice } = params;

  const isPickupBooking = weeklySessions[0]?.group?.toLowerCase().includes("pickup");
  const allSessionsList = weeklySessions
    .map((s) => `${s.date} ${s.startTime}-${s.endTime} at ${s.location}`)
    .join("<br/>");

  const priceNote = weeklyTotalPrice
    ? weeklyCreditApplied > 0
      ? `<p><strong>Total:</strong> $${weeklyTotalPrice} — $${weeklyCreditApplied} account credit applied — <strong>Due:</strong> $${weeklyTotalPrice - weeklyCreditApplied}</p>`
      : `<p><strong>Total:</strong> $${weeklyTotalPrice}</p>`
    : "";

  // Best-effort — the sessions are already paid for and confirmed, so a
  // failure here must not surface as a failed booking.
  if (weeklyReferrer) {
    try {
      await addReferralCredit(weeklyReferrer.email);
    } catch (creditErr) {
      console.error("Failed to award referral credit (weekly, booking was paid):", creditErr);
    }
  }

  try {
    await sendRegistrationNotification({
      parentName: params.parentName,
      email: params.email,
      phone: params.phone,
      kids: params.kids,
      type: "weekly",
      sessionDetails: `${isPickupBooking ? "Pickup" : "Group"} Session${weeklySessions.length !== 1 ? "s" : ""} (${weeklySessions.length} ${weeklySessions.length !== 1 ? "dates" : "date"}):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
      totalParticipants: params.totalParticipants,
      referralCode: params.referralCode,
      referredBy: weeklyReferrer?.name,
      referralCodeUsed: params.submittedReferralCode || undefined,
      trainer: weeklySessions[0]?.trainer,
      calendarEvent: weeklySessions[0] ? { date: weeklySessions[0].date, startTime: weeklySessions[0].startTime, endTime: weeklySessions[0].endTime, location: weeklySessions[0].location } : undefined,
    });

    if (weeklyReferrer) {
      await sendReferralCreditNotification({ referrerName: weeklyReferrer.name, referrerEmail: weeklyReferrer.email, newClientName: params.parentName });
    }
  } catch (notifyErr) {
    console.error("Weekly booking email failed (booking was paid):", notifyErr);
  }

  const groupNames: string[] = Array.from(new Set(
    weeklySessions.map((s) => s.group).filter((g): g is string => !!g)
  ));
  const sessionTypeSMS = isPickupBooking ? "pickup" : (groupNames.length === 1 ? groupNames[0] : "group");
  const weeklyTrainerLine = weeklySessions[0]?.trainer ? `\nTrainer: ${weeklySessions[0].trainer}` : "";
  if (params.smsConsent && params.phone) {
    const sessionLines = weeklySessions.map((s) =>
      `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
    ).join("\n");
    const count = weeklySessions.length;
    const capitalizedType = sessionTypeSMS.charAt(0).toUpperCase() + sessionTypeSMS.slice(1);
    const confirmLabel = count === 1 ? `${capitalizedType} session` : `${count} ${sessionTypeSMS} sessions`;
    const creditLine = weeklyCreditApplied > 0 ? `\n$${weeklyCreditApplied} account credit applied.` : "";
    await sendSMS(params.phone, `Mesa Basketball: ${confirmLabel} confirmed!\n${sessionLines}${weeklyTrainerLine}\nAthlete: ${params.kids}${creditLine}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminLines = weeklySessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
  ).join("\n");
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${weeklySessions.length} ${sessionTypeSMS} session${weeklySessions.length !== 1 ? "s" : ""}:\n${adminLines}${weeklyTrainerLine}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${weeklyReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`);

  for (const session of weeklySessions) {
    try {
      await upsertGroupSessionCalendarEvent({
        sessionType: "weekly",
        sessionLabel: session.group || "Group Session",
        bookedDate: session.date,
        bookedStartTime: session.startTime,
        bookedEndTime: session.endTime,
        bookedLocation: session.location,
        maxSpots: session.maxSpots,
        kidsJustRegistered: params.kids,
        participantsJustRegistered: params.totalParticipants,
      });
    } catch (err) {
      console.error("Calendar sync error (weekly, post-payment):", err);
    }
  }
}

export interface FinalizeCampBookingParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  campSessions: Array<{
    date: string;
    startTime: string;
    endTime?: string;
    location: string;
    campName: string;
    gradeGroup?: string;
  }>;
  totalParticipants: number;
  referralCode: string;
  campReferrer: { email: string; name: string } | null;
  submittedReferralCode?: string;
  smsConsent: boolean;
  campTotalPrice?: string;
  // Numeric total (parsed from campTotalPrice) — used for the "Due" note so
  // a multi-day drop-in purchase's due amount is computed against the whole
  // purchase, not against a single day's price share.
  campTotalNum?: number;
  campCreditApplied: number;
  sessionPrice?: number;
}

/**
 * Same role as finalizeConfirmedPrivateBooking, but for a batch of camp-day
 * rows created together (one row per selected day).
 */
export async function finalizeConfirmedCampBooking(params: FinalizeCampBookingParams): Promise<void> {
  const { campSessions, campReferrer, campCreditApplied, campTotalPrice, campTotalNum, sessionPrice } = params;

  const daysList = campSessions
    .map((s) => `${s.date} ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}`)
    .join("<br/>");
  const dueAmount = (campTotalNum ?? sessionPrice ?? 0) - campCreditApplied;
  const priceNote = campTotalPrice
    ? campCreditApplied > 0
      ? `<br/><strong>Total:</strong> ${campTotalPrice} — $${campCreditApplied} account credit applied — <strong>Due:</strong> $${dueAmount}`
      : `<br/><strong>Total:</strong> ${campTotalPrice}`
    : "";
  const firstSession = campSessions[0];

  // Best-effort — the days are already paid for and confirmed, so a failure
  // here must not surface as a failed booking.
  if (campReferrer) {
    try {
      await addReferralCredit(campReferrer.email);
    } catch (creditErr) {
      console.error("Failed to award referral credit (camp, booking was paid):", creditErr);
    }
  }

  try {
    await sendRegistrationNotification({
      parentName: params.parentName,
      email: params.email,
      phone: params.phone,
      kids: params.kids,
      type: "camp",
      sessionDetails: `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}<br/>Days registered (${campSessions.length}):<br/>${daysList}${priceNote}`,
      totalParticipants: params.totalParticipants,
      referralCode: params.referralCode,
      referredBy: campReferrer?.name,
      referralCodeUsed: params.submittedReferralCode || undefined,
      calendarEvent: { date: firstSession.date, startTime: firstSession.startTime, endTime: firstSession.endTime || firstSession.startTime, location: firstSession.location },
    });

    if (campReferrer) {
      await sendReferralCreditNotification({ referrerName: campReferrer.name, referrerEmail: campReferrer.email, newClientName: params.parentName });
    }
  } catch (notifyErr) {
    console.error("Camp booking email failed (booking was paid):", notifyErr);
  }

  if (params.smsConsent && params.phone) {
    const campDayLines = campSessions.map((s) =>
      `${formatDateWithDay(s.date)} | ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}\nLocation: ${resolveLocationName(s.location)}`
    ).join("\n");
    const priceText = campTotalPrice
      ? campCreditApplied > 0
        ? ` Total: ${campTotalPrice}, $${campCreditApplied} credit applied.`
        : ` Total: ${campTotalPrice}.`
      : "";
    await sendSMS(params.phone, `Mesa Basketball: Camp confirmed (${campSessions.length} day${campSessions.length !== 1 ? "s" : ""})!${priceText}\n${campDayLines}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminCampLines = campSessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}\nLocation: ${resolveLocationName(s.location)}`
  ).join("\n");
  const campNameLine = `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}`;
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${campNameLine}\n${campSessions.length} camp day${campSessions.length !== 1 ? "s" : ""}:\n${adminCampLines}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${campReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`);

  for (const session of campSessions) {
    try {
      await upsertGroupSessionCalendarEvent({
        sessionType: "camp",
        sessionLabel: session.campName || "Camp",
        bookedDate: session.date,
        bookedStartTime: session.startTime,
        bookedEndTime: session.endTime || session.startTime,
        bookedLocation: session.location,
        kidsJustRegistered: params.kids,
        participantsJustRegistered: params.totalParticipants,
      });
    } catch (err) {
      console.error("Calendar sync error (camp, post-payment):", err);
    }
  }
}

export interface FinalizePrivateSeriesBookingParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  privateSessions: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    trainer?: string;
    fullPrice: number;
    isFree: boolean;
  }>;
  totalParticipants: number;
  referralCode: string;
  privateReferrer: { email: string; name: string } | null;
  submittedReferralCode?: string;
  smsConsent: boolean;
  isFirstTime: boolean;
  accountCreditApplied: number;
}

/**
 * Same role as finalizeConfirmedPrivateBooking, but for a batch of recurring
 * private-session rows created together (one row per selected date, one
 * Stripe charge for the total). Sends a single consolidated email/SMS across
 * all dates, same as the old N-calls-plus-emailOnly pattern did — but package
 * usage still gets recomputed per row against ITS OWN booked month, since a
 * series can span more than one calendar month.
 */
export async function finalizeConfirmedPrivateSeriesBooking(params: FinalizePrivateSeriesBookingParams): Promise<void> {
  const { privateSessions } = params;
  const isPrivateType = params.type === "private" || params.type === "group-private";

  // Package usage is a per-month concept — recompute/persist it for every
  // month touched by this series, not just once. Wrapped like every other
  // side effect here — a transient DB error mid-loop must not abort the
  // referral credit, email, SMS, and calendar sync that follow for a series
  // that's already been paid for.
  try {
    const touchedMonths = new Set<string>();
    for (const s of privateSessions) {
      const d = new Date(s.date);
      if (isNaN(d.getTime())) continue;
      const bookingMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (touchedMonths.has(bookingMonth)) continue;
      touchedMonths.add(bookingMonth);
      if (!isPrivateType) continue;
      const activePkg = await getActivePackage(params.email, bookingMonth);
      if (activePkg) {
        const confirmedCount = await countConfirmedPrivateSessions(params.email, bookingMonth);
        const newUsed = Math.min(activePkg.package_type, confirmedCount);
        await setPackageSessions(activePkg.id, newUsed);
      }
    }
  } catch (pkgErr) {
    console.error("Package usage recompute failed (private series, booking was paid):", pkgErr);
  }

  // The note in the consolidated email/SMS just reflects the CURRENT
  // calendar month's package (matching the note the old emailOnly call
  // showed) — a single "remaining" number doesn't map cleanly onto a series
  // that might span several months' packages anyway.
  let packageSessionsRemaining: number | undefined;
  let packageType: number | undefined;
  if (isPrivateType) {
    try {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const activePkg = await getActivePackage(params.email, currentMonth);
      if (activePkg) {
        packageSessionsRemaining = activePkg.package_type - activePkg.sessions_used;
        packageType = activePkg.package_type;
      }
    } catch (pkgErr) {
      console.error("Package note lookup failed (private series, booking was paid):", pkgErr);
    }
  }

  // Best-effort — the series is already paid for and confirmed, so a
  // failure here must not surface as a failed booking.
  if (params.privateReferrer) {
    try {
      await addReferralCredit(params.privateReferrer.email);
      await sendReferralCreditNotification({
        referrerName: params.privateReferrer.name,
        referrerEmail: params.privateReferrer.email,
        newClientName: params.parentName,
      });
    } catch (creditErr) {
      console.error("Failed to award referral credit (private series, booking was paid):", creditErr);
    }
  }

  const allSessionsList = privateSessions
    .map((s) => `${s.date} ${s.startTime}-${s.endTime} at ${s.location}`)
    .join("<br/>");
  const totalPaid = privateSessions.reduce((sum, s) => sum + (s.isFree ? Math.round(s.fullPrice * 0.5) : s.fullPrice), 0);
  const priceNote = params.accountCreditApplied > 0
    ? `<p><strong>Total:</strong> $${totalPaid} — $${params.accountCreditApplied} account credit applied — <strong>Due:</strong> $${Math.max(0, totalPaid - params.accountCreditApplied)}</p>`
    : `<p><strong>Total:</strong> $${totalPaid}</p>`;

  try {
    await sendRegistrationNotification({
      parentName: params.parentName,
      email: params.email,
      phone: params.phone,
      kids: params.kids,
      type: params.type,
      sessionDetails: `Recurring Private Sessions (${privateSessions.length} dates):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
      totalParticipants: params.totalParticipants,
      isFree: privateSessions[0]?.isFree ?? false,
      isFirstTime: params.isFirstTime,
      packageSessionsRemaining,
      packageType,
      referralCode: params.referralCode,
      referredBy: params.privateReferrer?.name,
      referralCodeUsed: params.submittedReferralCode || undefined,
      trainer: privateSessions[0]?.trainer,
      calendarEvent: privateSessions[0] ? { date: privateSessions[0].date, startTime: privateSessions[0].startTime, endTime: privateSessions[0].endTime, location: privateSessions[0].location } : undefined,
      accountCreditApplied: params.accountCreditApplied,
      fullPrice: totalPaid,
    });
  } catch (notifyErr) {
    console.error("Private series booking email failed (booking was paid):", notifyErr);
  }

  if (params.smsConsent && params.phone) {
    const sessionLines = privateSessions.map((s) =>
      `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
    ).join("\n");
    const pkgNote = packageSessionsRemaining !== undefined
      ? `\n${packageSessionsRemaining} session${packageSessionsRemaining !== 1 ? "s" : ""} remaining in your package.`
      : "";
    const trainerLine = privateSessions[0]?.trainer ? `\nTrainer: ${privateSessions[0].trainer}` : "";
    const creditLine = params.accountCreditApplied > 0 ? `\n$${params.accountCreditApplied} account credit applied.` : "";
    await sendSMS(params.phone, `Mesa Basketball: ${privateSessions.length} private sessions confirmed!\n${sessionLines}${trainerLine}${pkgNote}${creditLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminLines = privateSessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
  ).join("\n");
  const trainerLine = privateSessions[0]?.trainer ? `\nTrainer: ${privateSessions[0].trainer}` : "";
  const adminTypeLabel = params.type === "group-private" ? "group private" : "private";
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${privateSessions.length} ${adminTypeLabel} sessions:\n${adminLines}${trainerLine}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${params.privateReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`);

  if (isPrivateType) {
    for (const s of privateSessions) {
      try {
        await addPrivateSessionToCalendar({
          parentName: params.parentName,
          email: params.email,
          phone: params.phone,
          kids: params.kids,
          bookedDate: s.date,
          bookedStartTime: s.startTime,
          bookedEndTime: s.endTime,
          bookedLocation: s.location,
          trainer: s.trainer,
        });
      } catch (err) {
        console.error("Calendar sync error (private series, post-payment):", err);
      }
    }
  }
}

/**
 * A checkout was never completed — either Stripe told us the session
 * expired, or the abandonment-sweep cron caught one the webhook missed.
 * Flips the batch to payment_abandoned and gives back any account credit
 * that was tentatively deducted when the pending booking was created
 * (they never actually paid, so it shouldn't be spent). Safe to call more
 * than once for the same batch — abandonPendingBookingBatch only touches
 * rows still pending_payment, so a repeat call is a no-op.
 */
export async function expireAbandonedBookingBatch(bookingBatchId: string): Promise<void> {
  const abandoned = await abandonPendingBookingBatch(bookingBatchId);
  if (abandoned.length === 0) return;

  for (const reg of abandoned) {
    if (reg.applied_account_credit && reg.applied_account_credit > 0) {
      await addAccountCredit(reg.email, reg.applied_account_credit).catch(() => {});
    }
    // A redeemed referral credit is decremented at booking-insert time,
    // before Stripe Checkout even exists — if they never actually paid, give
    // it back the same way applied_account_credit already is above.
    if (reg.used_referral_credit) {
      await addReferralCredit(reg.email).catch(() => {});
    }
  }

  try {
    await sendAdminSMS(`Checkout expired unused: ${abandoned[0]?.parent_name || "unknown"}\n${abandoned[0]?.session_details || bookingBatchId}\nNo charge — booking not confirmed.`);
  } catch {
    // non-critical
  }
}

export interface FinalizeRescheduleTopupParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  oldSessionDetails: string;
  newSessionDetails: string;
  manageToken: string;
  bookedDate: string;
  bookedStartTime: string;
  bookedEndTime: string;
  bookedLocation: string;
  bookedGroup?: string;
  bookedTrainer?: string;
  totalParticipants: number;
  smsConsent: boolean;
  isLateReschedule: boolean;
  amountCharged: number;
}

/**
 * A reschedule needed real money to move (the new session costs more than
 * what was already paid on the old one) — the client was sent to Stripe
 * Checkout for just the difference (or, after a late reschedule's 50% fee
 * was kept, the new session's full price) and the webhook calls this once
 * that payment succeeds. The old booking was already cancelled synchronously
 * when the reschedule was requested; this only confirms/announces the new
 * one, mirroring how a brand-new paid booking is only announced once paid.
 */
export async function finalizeRescheduleTopup(params: FinalizeRescheduleTopupParams): Promise<void> {
  const isPrivateType = params.type === "private" || params.type === "group-private";

  try {
    await sendRescheduleNotification({
      parentName: params.parentName,
      email: params.email,
      oldSessionDetails: params.oldSessionDetails,
      newSessionDetails: params.newSessionDetails,
      manageToken: params.manageToken,
      isLateReschedule: params.isLateReschedule,
      newTrainer: params.bookedTrainer,
      priceAdjustment: { kind: "charge", amount: params.amountCharged },
    });
  } catch (err) {
    console.error("Reschedule email failed (topup booking was paid):", err);
  }

  if (params.smsConsent && params.phone) {
    const trainerLine = params.bookedTrainer ? `\nTrainer: ${params.bookedTrainer}` : "";
    await sendSMS(params.phone, `Mesa Basketball: Reschedule confirmed — $${params.amountCharged} charged!\n${formatDateWithDay(params.bookedDate)} | ${params.bookedStartTime}-${params.bookedEndTime}\nLocation: ${resolveLocationName(params.bookedLocation)}${trainerLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/booking/${params.manageToken}\nReply STOP to opt out.`);
  }

  await sendAdminSMS(`RESCHEDULED (paid $${params.amountCharged}): ${params.parentName}\nFrom: ${params.oldSessionDetails}\nTo: ${params.newSessionDetails}\nPlayers: ${params.kids}`);

  try {
    if (isPrivateType) {
      await addPrivateSessionToCalendar({
        parentName: params.parentName,
        email: params.email,
        phone: params.phone,
        kids: params.kids,
        bookedDate: params.bookedDate,
        bookedStartTime: params.bookedStartTime,
        bookedEndTime: params.bookedEndTime,
        bookedLocation: params.bookedLocation,
        trainer: params.bookedTrainer,
      });
    } else {
      await upsertGroupSessionCalendarEvent({
        sessionType: "weekly",
        sessionLabel: params.bookedGroup || "Group Session",
        bookedDate: params.bookedDate,
        bookedStartTime: params.bookedStartTime,
        bookedEndTime: params.bookedEndTime,
        bookedLocation: params.bookedLocation,
        kidsJustRegistered: params.kids,
        participantsJustRegistered: params.totalParticipants,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (reschedule topup):", err);
  }
}

/**
 * Finalizes a Stripe Checkout Session that actually completed payment,
 * routing to the right per-type finalize function. Called from two places:
 * the Stripe webhook (the normal path), and the abandonment-sweep cron as a
 * self-heal when a webhook was missed or delayed — the cron first confirms
 * with Stripe that the session really did complete before calling this, so
 * a genuinely paid booking never gets marked payment_abandoned just because
 * its webhook never arrived.
 */
export async function finalizePaidCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
  const bookingBatchId = session.client_reference_id;
  if (!bookingBatchId) {
    console.error("checkout.session.completed with no client_reference_id", session.id);
    return;
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || null;
  if (!paymentIntentId) {
    console.error("checkout.session.completed with no payment_intent", session.id);
    return;
  }

  // Only rows still pending_payment get flipped here — a duplicate delivery
  // (or the cron catching one the webhook already handled) finds nothing
  // left to update and this returns an empty array, so the notification/
  // calendar side effects below never run twice.
  const confirmedRows = await finalizePaidBookingBatch(bookingBatchId, paymentIntentId, customerId);
  if (confirmedRows.length === 0) return;

  const metadata = session.metadata || {};

  // A reschedule that needed a Stripe topup (or, after a late reschedule's
  // 50% fee, a fresh full charge) — the old booking was already cancelled
  // synchronously when the reschedule was requested; this just announces
  // the new one now that payment has actually gone through.
  if (metadata.purpose === "reschedule_topup") {
    const reg = confirmedRows[0];
    if (!reg.booked_date || !reg.booked_start_time) return;
    await finalizeRescheduleTopup({
      parentName: reg.parent_name,
      email: reg.email,
      phone: reg.phone,
      kids: reg.kids,
      type: reg.type,
      oldSessionDetails: metadata.old_session_details || "your previous session",
      newSessionDetails: reg.session_details,
      manageToken: reg.manage_token,
      bookedDate: reg.booked_date,
      bookedStartTime: reg.booked_start_time,
      bookedEndTime: reg.booked_end_time || reg.booked_start_time,
      bookedLocation: reg.booked_location || "",
      bookedGroup: reg.booked_group || undefined,
      bookedTrainer: reg.booked_trainer || undefined,
      totalParticipants: reg.total_participants,
      smsConsent: !!reg.sms_consent,
      isLateReschedule: metadata.is_late_reschedule === "true",
      amountCharged: metadata.topup_amount ? Number(metadata.topup_amount) : 0,
    });
    return;
  }

  const isFirstTime = metadata.is_first_time === "true";
  const referrer = metadata.referrer_email
    ? { email: metadata.referrer_email, name: metadata.referrer_name || "" }
    : null;
  const submittedReferralCode = metadata.submitted_referral_code || undefined;

  // Every row in a batch was created together by the same /api/register
  // branch, so they all share a type — safe to key off the first row.
  const batchType = confirmedRows[0]?.type;

  if (batchType === "private" || batchType === "group-private") {
    // A recurring series stamps the same booking_batch_id across every date's
    // row — one consolidated finalize for those, same as weekly/camp. A
    // single-date booking (the common case) keeps its own per-row finalize,
    // which sends its own manage-this-booking link.
    if (confirmedRows.length > 1) {
      const first = confirmedRows[0];
      const accountCreditApplied = confirmedRows.reduce((sum, r) => sum + (r.applied_account_credit || 0), 0);
      await finalizeConfirmedPrivateSeriesBooking({
        parentName: first.parent_name,
        email: first.email,
        phone: first.phone,
        kids: first.kids,
        type: first.type,
        privateSessions: confirmedRows.map((r) => ({
          date: r.booked_date || "",
          startTime: r.booked_start_time || "",
          endTime: r.booked_end_time || "",
          location: r.booked_location || "",
          trainer: r.booked_trainer || undefined,
          fullPrice: r.session_price ?? 0,
          isFree: r.is_free,
        })),
        totalParticipants: first.total_participants,
        referralCode: first.referral_code || "",
        privateReferrer: referrer,
        submittedReferralCode,
        smsConsent: !!first.sms_consent,
        isFirstTime,
        accountCreditApplied,
      });
    } else {
      for (const reg of confirmedRows) {
        if (!reg.booked_date || !reg.booked_start_time) continue;
        await finalizeConfirmedPrivateBooking({
          parentName: reg.parent_name,
          email: reg.email,
          phone: reg.phone,
          kids: reg.kids,
          type: reg.type,
          sessionDetails: reg.session_details,
          totalParticipants: reg.total_participants,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          bookedTrainer: reg.booked_trainer || undefined,
          manageToken: reg.manage_token,
          isFree: reg.is_free,
          isFirstTime,
          referralCode: reg.referral_code || "",
          privateReferrer: referrer,
          submittedReferralCode,
          smsConsent: !!reg.sms_consent,
          accountCreditApplied: reg.applied_account_credit || 0,
          fullPrice: reg.session_price ?? undefined,
        });
      }
    }
  } else if (batchType === "weekly") {
    const first = confirmedRows[0];
    const weeklyCreditApplied = confirmedRows.reduce((sum, r) => sum + (r.applied_account_credit || 0), 0);
    const weeklyTotalPrice = metadata.total_price ? Number(metadata.total_price) : undefined;
    await finalizeConfirmedWeeklyBooking({
      parentName: first.parent_name,
      email: first.email,
      phone: first.phone,
      kids: first.kids,
      weeklySessions: confirmedRows.map((r) => ({
        date: r.booked_date || "",
        startTime: r.booked_start_time || "",
        endTime: r.booked_end_time || "",
        location: r.booked_location || "",
        group: r.booked_group || "",
        trainer: r.booked_trainer || undefined,
      })),
      totalParticipants: first.total_participants,
      referralCode: first.referral_code || "",
      weeklyReferrer: referrer,
      submittedReferralCode,
      smsConsent: !!first.sms_consent,
      weeklyTotalPrice,
      weeklyCreditApplied,
    });
  } else if (batchType === "camp") {
    const first = confirmedRows[0];
    const campCreditApplied = confirmedRows.reduce((sum, r) => sum + (r.applied_account_credit || 0), 0);
    const campGradeGroup = metadata.camp_grade_group || undefined;
    await finalizeConfirmedCampBooking({
      parentName: first.parent_name,
      email: first.email,
      phone: first.phone,
      kids: first.kids,
      campSessions: confirmedRows.map((r) => ({
        date: r.booked_date || "",
        startTime: r.booked_start_time || "",
        endTime: r.booked_end_time || undefined,
        location: r.booked_location || "",
        campName: r.booked_group || "",
        gradeGroup: campGradeGroup,
      })),
      totalParticipants: first.total_participants,
      referralCode: first.referral_code || "",
      campReferrer: referrer,
      submittedReferralCode,
      smsConsent: !!first.sms_consent,
      campTotalPrice: metadata.total_price || undefined,
      campTotalNum: metadata.total_price ? parseInt(String(metadata.total_price).replace(/\D/g, "")) || 0 : 0,
      campCreditApplied,
      sessionPrice: first.session_price ?? undefined,
    });
  }
}
