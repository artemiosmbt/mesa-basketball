import { sendRegistrationNotification, sendReferralCreditNotification } from "@/lib/email";
import { addPrivateSessionToCalendar } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import {
  addReferralCredit,
  addAccountCredit,
  abandonPendingBookingBatch,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
} from "@/lib/supabase";

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
