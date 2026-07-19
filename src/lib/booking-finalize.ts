import { sendRegistrationNotification, sendReferralCreditNotification } from "@/lib/email";
import { addPrivateSessionToCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { getStripe } from "@/lib/stripe";
import {
  addReferralCredit,
  addAccountCredit,
  abandonPendingBookingBatch,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
  recordStripeRefund,
} from "@/lib/supabase";

/**
 * Refunds a real Stripe charge for an on-time cancellation. On success,
 * records the refund id on the row (bookkeeping) and returns true. On
 * failure, does NOT fall back to account credit — silently substituting
 * credit for a promised card refund would be an undisclosed policy change —
 * instead it alerts the admin to refund manually and returns false so the
 * caller can adjust what it tells the client.
 */
export async function issueCancellationRefund(params: {
  email: string;
  manageToken: string;
  paymentIntentId: string;
  amountDollars: number;
  sessionLabel: string;
}): Promise<boolean> {
  if (params.amountDollars <= 0) return true;
  try {
    const stripe = getStripe();
    const refund = await stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: Math.round(params.amountDollars * 100),
    });
    await recordStripeRefund(params.manageToken, refund.id).catch(() => {});
    return true;
  } catch (err) {
    console.error("Stripe refund failed:", err);
    try {
      await sendAdminSMS(`REFUND FAILED — manual action needed\n${params.sessionLabel}\n${params.email}\n$${params.amountDollars} could not be refunded automatically. Refund manually in the Stripe dashboard.`);
    } catch {
      // non-critical
    }
    return false;
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
  campCreditApplied: number;
  sessionPrice?: number;
}

/**
 * Same role as finalizeConfirmedPrivateBooking, but for a batch of camp-day
 * rows created together (one row per selected day).
 */
export async function finalizeConfirmedCampBooking(params: FinalizeCampBookingParams): Promise<void> {
  const { campSessions, campReferrer, campCreditApplied, campTotalPrice, sessionPrice } = params;

  const daysList = campSessions
    .map((s) => `${s.date} ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}`)
    .join("<br/>");
  const priceNote = campTotalPrice
    ? campCreditApplied > 0
      ? `<br/><strong>Total:</strong> ${campTotalPrice} — $${campCreditApplied} account credit applied — <strong>Due:</strong> $${(sessionPrice ?? 0) - campCreditApplied}`
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
  }

  try {
    await sendAdminSMS(`Checkout expired unused: ${abandoned[0]?.parent_name || "unknown"}\n${abandoned[0]?.session_details || bookingBatchId}\nNo charge — booking not confirmed.`);
  } catch {
    // non-critical
  }
}
