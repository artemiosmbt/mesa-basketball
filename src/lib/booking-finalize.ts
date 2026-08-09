import Stripe from "stripe";
import { sendRegistrationNotification, sendReferralCreditNotification, sendRescheduleNotification, sendPackageConfirmation, sendAbandonedCheckoutEmail, sendAbandonedPackageEmail, sendPlayerUpdateNotification } from "@/lib/email";
import { addPrivateSessionToCalendar, deletePrivateSessionFromCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, formatMonthYear, resolveLocationName } from "@/lib/sms";
import { getStripe } from "@/lib/stripe";
import { calcServiceFee, fmtMoney, packagePrice, fullPriceForType, calcPrivatePrice, getTrainerTier, normalizeTrainerTier } from "@/lib/pricing";
import { notifyTrainerOfNewBooking, notifyTrainerOfCancellation } from "@/lib/trainer-notify";
import { trainerNamesMatch, formatTrainerForDisplay } from "@/lib/trainers";
import { normalizeSessionLabelForComparison as normLabel } from "@/lib/group-matching";
import { getWeeklySchedule, parseTimeToMins } from "@/lib/sheets";
import {
  addReferralCredit,
  awardReferralCreditOnce,
  addAccountCredit,
  deductAccountCredit,
  cancelRegistration,
  logLateFeeEvent,
  abandonPendingBookingBatch,
  finalizePaidBookingBatch,
  getActivePackage,
  getPackageById,
  setPackageSessions,
  countPackageSessionsUsed,
  recordStripeRefund,
  finalizePaidPackage,
  abandonPendingPackage,
  getRegistrationByToken,
  updateRegistrationPlayers,
  alertIfPrivateDoubleBooked,
  type Registration,
} from "@/lib/supabase";

// Parse a session date + hours/mins (Eastern time) into a UTC Date for comparison.
// The server runs UTC; without this, "2:00 PM" is treated as 2pm UTC instead of 2pm ET.
export function parseSessionDateTimeET(dateStr: string, hoursET: number, minsET: number): Date {
  const ref = new Date(dateStr);
  ref.setHours(12, 0, 0, 0); // use midday to safely determine DST offset
  const utcMs = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const nyMs  = new Date(ref.toLocaleString("en-US", { timeZone: "America/New_York" })).getTime();
  const offsetMs = utcMs - nyMs; // e.g. 4h for EDT, 5h for EST
  const sessionLocal = new Date(dateStr);
  sessionLocal.setHours(hoursET, minsET, 0, 0);
  return new Date(sessionLocal.getTime() + offsetMs);
}

// Returns true if this action is a late cancel/reschedule:
// session is within 24h AND the 15-min grace period (from booking time, capped at session start) has expired.
// Fee is waived if admin made a last-minute change (within 24h of session) — not the client's fault.
export function isLateAction(dateStr: string, timeStr: string, createdAt: string, adminChangeAt?: string | null): boolean {
  const timeMatch = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!timeMatch) return false;
  let hours = parseInt(timeMatch[1]);
  const mins = parseInt(timeMatch[2]);
  const period = timeMatch[3].toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  const sessionStart = parseSessionDateTimeET(dateStr, hours, mins);
  const now = Date.now();
  const hoursUntil = (sessionStart.getTime() - now) / (1000 * 60 * 60);
  if (hoursUntil < 0 || hoursUntil >= 24) return false;
  // Waive fee if admin changed the session within 48h of its start time
  if (adminChangeAt) {
    const hoursFromChangeTo = (sessionStart.getTime() - new Date(adminChangeAt).getTime()) / (1000 * 60 * 60);
    if (hoursFromChangeTo <= 48) return false;
  }
  // Within 24h — check grace: 15 min from booking time, capped at session start
  const graceEnd = Math.min(
    new Date(createdAt).getTime() + 15 * 60 * 1000,
    sessionStart.getTime()
  );
  return now >= graceEnd;
}

// "1 High School Skills, 2 Pickup" -> "1 High School Skills and 2 Pickup"; a
// third group joins as "A, B, and C". Used to summarize mixed-group bookings
// in notifications instead of naming just one group.
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The actual price owed for a session, respecting the is_free 50%-off
 * discount for privates (first-time clients / redeemed referral credit) —
 * is_free is never baked into the stored session_price itself. Shared by
 * every cancellation/reschedule/no-show path that needs to know what a
 * client actually paid or owes.
 */
export function resolvedSessionPrice(reg: { session_price: number | null; is_free: boolean; type: string; booked_trainer?: string | null }): number {
  const isPrivateType = reg.type === "private" || reg.type === "group-private";
  const basePrice = reg.session_price ?? fullPriceForType(reg.type, getTrainerTier(reg.booked_trainer));
  return reg.is_free && isPrivateType ? Math.round(basePrice * 0.5 * 100) / 100 : basePrice;
}

/**
 * Describes what actually happened to money on a cancellation — a plain
 * account credit (late cancel, or a non-Stripe/manual-paid booking), a real
 * Stripe refund (possibly split refund+credit via issueStripeRefund's
 * amount_too_large fallback), or (if the Stripe call failed outright) a
 * pending note that doesn't claim money moved before it actually did.
 */
export function describeMoneyOutcome(
  result: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined,
  fallbackCredit: number,
  isLateCancel: boolean,
  forAdmin: boolean
): string {
  if (result) {
    if (result.failed) {
      return forAdmin
        ? "REFUND FAILED, needs manual action"
        : "Your refund is being processed — you'll receive a separate confirmation once it's complete.";
    }
    const parts: string[] = [];
    if (result.refundedAmount > 0) parts.push(forAdmin ? `$${fmtMoney(result.refundedAmount)} refunded` : `$${fmtMoney(result.refundedAmount)} refunded to your original payment method`);
    if (result.creditedAmount > 0) parts.push(forAdmin ? `$${fmtMoney(result.creditedAmount)} credited` : `$${fmtMoney(result.creditedAmount)} credited to your account`);
    return parts.join(", ");
  }
  if (fallbackCredit > 0) {
    return forAdmin
      ? `$${fmtMoney(fallbackCredit)} credited to their account`
      : isLateCancel
        ? `$${fmtMoney(fallbackCredit)} credited to your account (50% of what you paid — late cancellation)`
        : `$${fmtMoney(fallbackCredit)} credited to your account for a future booking`;
  }
  return "";
}

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
  // Registrations-only bookkeeping — a package refund has no
  // registrations row to attach this to, so it's optional there.
  manageToken?: string;
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
    if (params.manageToken) await recordStripeRefund(params.manageToken, refund.id).catch(() => {});
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
          if (params.manageToken) await recordStripeRefund(params.manageToken, partial.id).catch(() => {});
        }
        // The "shortfall" (what Stripe won't let us refund again) is only
        // legitimately owed as account credit when the charge was PARTIALLY
        // refunded before — e.g. an earlier reschedule already refunded part
        // of it, and this credit makes the client whole for the rest. If the
        // charge is instead ALREADY FULLY refunded (charge.amount_refunded
        // covers the whole charge), the client has already gotten 100% of
        // it back through Stripe — most likely a refund issued directly in
        // the Stripe Dashboard, which this app has no other record of.
        // Crediting the shortfall in that case would pay them a second time
        // for money they've already received. Only credit when SOME (not
        // all) of the charge is already refunded.
        const chargeFullyRefunded = !!charge && charge.amount_refunded >= charge.amount;
        const shortfall = chargeFullyRefunded ? 0 : Math.round((params.amountDollars - refundableDollars) * 100) / 100;
        if (shortfall > 0) {
          await addAccountCredit(params.email, shortfall).catch(() => {});
        }
        if (chargeFullyRefunded) {
          await sendAdminSMS(`Refund skipped: ${params.sessionLabel}\n${params.email}\nThis charge was already fully refunded (likely directly in Stripe) before this cancellation ran — no further refund or credit issued, since they've already received the full $${fmtMoney(params.amountDollars)} back. Verify this is correct.`).catch(() => {});
        } else {
          await sendAdminSMS(`Partial refund: ${params.sessionLabel}\n${params.email}\n$${fmtMoney(refundableDollars)} refunded to card${shortfall > 0 ? `, $${fmtMoney(shortfall)} credited to account (an earlier reschedule already used up part of this charge)` : ""}.`).catch(() => {});
        }
        return { refundedAmount: refundableDollars, creditedAmount: shortfall, failed: false };
      } catch (fallbackErr) {
        console.error("Stripe refund fallback failed:", fallbackErr);
      }
    }
    console.error("Stripe refund failed:", err);
    try {
      await sendAdminSMS(`REFUND FAILED — manual action needed\n${params.sessionLabel}\n${params.email}\n$${fmtMoney(params.amountDollars)} could not be refunded automatically. Refund manually in the Stripe dashboard.`);
    } catch {
      // non-critical
    }
    return { refundedAmount: 0, creditedAmount: 0, failed: true };
  }
}

// Resolves the customer + payment method to charge off-session for a given
// registration: its own Stripe payment if it has one, or — for a
// package-covered session, which has no per-session payment — the package
// that covered it. Returns null when there's nothing on file to charge
// (a legacy cash booking, or a payment intent whose payment method wasn't
// retained), so callers can fail closed rather than guessing.
export async function resolveOffSessionPaymentSource(reg: {
  stripe_customer_id?: string | null;
  stripe_payment_intent_id?: string | null;
  package_id?: string | null;
}): Promise<{ customerId: string; paymentMethodId: string } | null> {
  let customerId = reg.stripe_customer_id || null;
  let paymentIntentId = reg.stripe_payment_intent_id || null;
  if ((!customerId || !paymentIntentId) && reg.package_id) {
    const pkg = await getPackageById(reg.package_id).catch(() => null);
    customerId = customerId || pkg?.stripe_customer_id || null;
    paymentIntentId = paymentIntentId || pkg?.stripe_payment_intent_id || null;
  }
  if (!customerId || !paymentIntentId) return null;
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const paymentMethodId = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
    if (!paymentMethodId) return null;
    return { customerId, paymentMethodId };
  } catch {
    return null;
  }
}

export interface OffSessionChargeResult {
  success: boolean;
  paymentIntentId?: string;
  reason?: string;
}

// Charges a saved card with nobody present to fix a failure — deliberately
// avoided everywhere else in this codebase for that exact reason. Only used
// for an admin-initiated action where the admin IS present to see success
// or failure immediately and decide what to do next, and where a failure
// here must block the caller's action rather than proceeding anyway.
export async function chargeSavedCardOffSession(params: {
  customerId: string;
  paymentMethodId: string;
  amountDollars: number;
  description: string;
}): Promise<OffSessionChargeResult> {
  if (params.amountDollars <= 0) return { success: true };
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(params.amountDollars * 100),
      currency: "usd",
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      off_session: true,
      confirm: true,
      description: params.description,
    });
    if (pi.status !== "succeeded") {
      return { success: false, reason: `Charge did not complete (status: ${pi.status}) — it may require additional authentication the client needs to provide themselves.` };
    }
    return { success: true, paymentIntentId: pi.id };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      return { success: false, reason: err.message || "The card was declined." };
    }
    console.error("Off-session charge failed:", err);
    return { success: false, reason: "The charge failed — the client's card may need updating." };
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
  // Already fully prepaid by an active monthly package — no Stripe charge
  // happened for this specific row, so the notification must show $0/no
  // charge regardless of what fullPrice/isFree/accountCreditApplied would
  // otherwise compute to.
  packageCovered?: boolean;
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

  // Best-effort double-booking detection — see alertIfPrivateDoubleBooked's
  // own doc comment. Never blocks/fails this booking on error.
  if (isPrivateType && params.bookedTrainer) {
    alertIfPrivateDoubleBooked(params.bookedDate, params.bookedStartTime, params.bookedEndTime, params.bookedLocation, params.bookedTrainer, params.parentName).catch((err) =>
      console.error("Double-booking check failed:", err)
    );
  }

  let packageSessionsRemaining: number | undefined;
  let packageType: number | undefined;

  // Wrapped like every other side effect below — a transient DB error here
  // must not abort the referral credit, email, SMS, and calendar sync that
  // follow for a booking that's already been paid for.
  // Only worth looking up when this specific booking was itself covered by
  // the package — a client with an active package who chose to book (or had
  // to book, having run out of capacity) a separately-paid session doesn't
  // need "sessions remaining" noise attached to that unrelated charge.
  try {
    if (isPrivateType && params.bookedDate && params.packageCovered) {
      const d = new Date(params.bookedDate);
      const bookingMonth = isNaN(d.getTime())
        ? null
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const activePkg = bookingMonth ? await getActivePackage(params.email, bookingMonth) : null;
      if (activePkg) {
        const used = await countPackageSessionsUsed(activePkg.id);
        await setPackageSessions(activePkg.id, used);
        packageSessionsRemaining = Math.max(0, activePkg.package_type - used);
        packageType = activePkg.package_type;
      }
    }
  } catch (pkgErr) {
    console.error("Package usage recompute failed (private, booking was paid):", pkgErr);
  }

  // Best-effort — the booking is already paid for and confirmed, so a
  // failure here must not surface as a failed booking.
  if (params.privateReferrer) {
    try {
      await awardReferralCreditOnce(params.privateReferrer.email, params.email);
      await sendReferralCreditNotification({
        referrerName: params.privateReferrer.name,
        referrerEmail: params.privateReferrer.email,
        newClientName: params.parentName,
      });
    } catch (creditErr) {
      console.error("Failed to award referral credit (private, booking was paid):", creditErr);
    }
  }

  // What actually got charged via Stripe, net of the first-time/referral
  // discount and any account credit — 0 whenever nothing was charged (fully
  // covered by credit, or already prepaid via an active package). The
  // service fee is added on top of this by the notification functions
  // themselves, not baked in here, since fullPrice still needs to stay the
  // nominal session price for refund/reschedule math.
  const amountCharged = params.packageCovered
    ? 0
    : Math.max(0, (params.isFree ? Math.round((params.fullPrice ?? 0) * 0.5 * 100) / 100 : (params.fullPrice ?? 0)) - params.accountCreditApplied);

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
      amountCharged,
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
    const creditLine = params.accountCreditApplied > 0 ? `\n$${fmtMoney(params.accountCreditApplied)} account credit applied.` : "";
    const chargeLine = amountCharged > 0 ? `\nCharged: $${fmtMoney(amountCharged + calcServiceFee(amountCharged))}.` : "";
    await sendSMS(params.phone, `Mesa Basketball: Your ${typeStr} is confirmed!${dateLine}${privateTrainerLine}${pkgNote}${creditLine}${chargeLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminDateLine = `${formatDateWithDay(params.bookedDate)} | ${params.bookedStartTime}${params.bookedEndTime ? `-${params.bookedEndTime}` : ""}${params.bookedLocation ? `\nLocation: ${resolveLocationName(params.bookedLocation)}` : ""}`;
  const pkgAdminNote = packageSessionsRemaining !== undefined
    ? `\nPkg: ${packageSessionsRemaining}/${packageType} remaining`
    : "";
  const adminTrainerLine = isPrivateType && params.bookedTrainer ? `\nTrainer: ${params.bookedTrainer}` : "";
  const adminTypeLabel = params.type === "group-private" ? "group private" : "private";
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n1 ${adminTypeLabel} session:\n${adminDateLine}${adminTrainerLine}\nPlayers: ${params.kids}${pkgAdminNote}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${params.privateReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`).catch(() => {});

  if (isPrivateType && params.bookedDate && params.bookedStartTime) {
    await notifyTrainerOfNewBooking({
      trainer: params.bookedTrainer,
      parentName: params.parentName,
      kids: params.kids,
      sessionLabel: adminTypeLabel === "group private" ? "Group Private Session" : "Private Session",
      date: params.bookedDate,
      startTime: params.bookedStartTime,
      endTime: params.bookedEndTime || params.bookedStartTime,
      location: params.bookedLocation || "",
    }).catch((err) => console.error("Trainer new-booking notify failed:", err));
  }

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
      // Silent otherwise — this booking is already paid and confirmed, and
      // private sessions have no daily reconciliation cron (unlike
      // weekly/camp), so a failed sync here would never self-heal or
      // surface anywhere unless the client happens to mention it.
      await sendAdminSMS(`⚠️ Calendar sync FAILED for ${params.parentName}'s paid private session (${formatDateWithDay(params.bookedDate || "")} ${params.bookedStartTime}). Booking is confirmed — add it to the calendar manually.`).catch(() => {});
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

  // A single booking can now span more than one distinct group at once (e.g.
  // a group skills session cross-sold with a companion pickup slot), so
  // notifications must name each group with its own count rather than
  // assuming every row shares the first row's group.
  const groupCounts = new Map<string, number>();
  for (const s of weeklySessions) {
    if (s.group) groupCounts.set(s.group, (groupCounts.get(s.group) || 0) + 1);
  }
  const groupEntries = Array.from(groupCounts.entries());
  const isMixedGroups = groupEntries.length > 1;
  const primaryGroupLabel = groupEntries[0]?.[0] || "Group";
  const groupSummary = isMixedGroups
    ? joinWithAnd(groupEntries.map(([group, count]) => `${count} ${group}`))
    : primaryGroupLabel;
  const isPickupBooking = !isMixedGroups && primaryGroupLabel.toLowerCase().includes("pickup");
  const allSessionsList = weeklySessions
    .map((s) => `${s.date} ${s.startTime}-${s.endTime} at ${s.location}${isMixedGroups ? ` (${s.group})` : ""}`)
    .join("<br/>");

  // What actually got charged via Stripe (net of credit) — 0 if fully
  // covered by credit. Worded as "Charged," never "Due," since this only
  // sends once the booking is already confirmed/paid.
  const weeklyAmountCharged = weeklyTotalPrice ? Math.max(0, weeklyTotalPrice - weeklyCreditApplied) : 0;
  const weeklyTotalWithFee = weeklyAmountCharged > 0 ? Math.round((weeklyAmountCharged + calcServiceFee(weeklyAmountCharged)) * 100) / 100 : 0;
  const priceNote = weeklyTotalPrice
    ? `<p><strong>Total:</strong> $${fmtMoney(weeklyTotalPrice)}${weeklyCreditApplied > 0 ? ` — $${fmtMoney(weeklyCreditApplied)} account credit applied` : ""}${weeklyAmountCharged > 0 ? ` — <strong>Charged:</strong> $${fmtMoney(weeklyTotalWithFee)}` : ""}</p>`
    : "";

  // Best-effort — the sessions are already paid for and confirmed, so a
  // failure here must not surface as a failed booking.
  if (weeklyReferrer) {
    try {
      await awardReferralCreditOnce(weeklyReferrer.email, params.email);
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
      sessionDetails: `${isMixedGroups ? groupSummary : primaryGroupLabel} Session${weeklySessions.length !== 1 ? "s" : ""} (${weeklySessions.length} ${weeklySessions.length !== 1 ? "dates" : "date"}):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
      totalParticipants: params.totalParticipants,
      referralCode: params.referralCode,
      referredBy: weeklyReferrer?.name,
      referralCodeUsed: params.submittedReferralCode || undefined,
      trainer: weeklySessions[0]?.trainer,
      calendarEvent: weeklySessions[0] ? { date: weeklySessions[0].date, startTime: weeklySessions[0].startTime, endTime: weeklySessions[0].endTime, location: weeklySessions[0].location } : undefined,
      calendarEvents: weeklySessions.map((s) => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, location: s.location })),
      isPickup: isPickupBooking,
      sessionDetailsIsHtml: true,
    });

    if (weeklyReferrer) {
      await sendReferralCreditNotification({ referrerName: weeklyReferrer.name, referrerEmail: weeklyReferrer.email, newClientName: params.parentName });
    }
  } catch (notifyErr) {
    console.error("Weekly booking email failed (booking was paid):", notifyErr);
  }

  const weeklyTrainerLine = weeklySessions[0]?.trainer ? `\nTrainer: ${weeklySessions[0].trainer}` : "";
  const totalCount = weeklySessions.length;
  const confirmLabel = isMixedGroups
    ? `${groupSummary} sessions`
    : (totalCount === 1 ? `${primaryGroupLabel} session` : `${totalCount} ${primaryGroupLabel} sessions`);
  if (params.smsConsent && params.phone) {
    const sessionLines = weeklySessions.map((s) =>
      `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}${isMixedGroups ? `\nGroup: ${s.group}` : ""}`
    ).join("\n");
    const creditLine = weeklyCreditApplied > 0 ? `\n$${fmtMoney(weeklyCreditApplied)} account credit applied.` : "";
    const chargeLine = weeklyAmountCharged > 0 ? `\nCharged: $${fmtMoney(weeklyTotalWithFee)}.` : "";
    await sendSMS(params.phone, `Mesa Basketball: ${confirmLabel} confirmed!\n${sessionLines}${weeklyTrainerLine}\nAthlete: ${params.kids}${creditLine}${chargeLine}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminLines = weeklySessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}${isMixedGroups ? `\nGroup: ${s.group}` : ""}`
  ).join("\n");
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${confirmLabel}:\n${adminLines}${weeklyTrainerLine}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${weeklyReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`).catch(() => {});

  // Notified per-session (not just weeklySessions[0]) since a single batch
  // can span more than one group with different trainers (e.g. a skills
  // session cross-sold with its companion pickup slot).
  for (const session of weeklySessions) {
    await notifyTrainerOfNewBooking({
      trainer: session.trainer,
      parentName: params.parentName,
      kids: params.kids,
      sessionLabel: session.group || "Group Session",
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      location: session.location,
    }).catch((err) => console.error("Trainer new-booking notify failed:", err));
  }

  const calendarSyncFailures: string[] = [];
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
      calendarSyncFailures.push(`${session.date} ${session.startTime} (${session.group || "Group Session"})`);
    }
  }
  // Weekly/camp events do get a daily reconciliation sweep (calendar-sync
  // cron), so a failure here isn't permanent the way a private-session one
  // is — but that's up to a day away, so still worth an immediate heads-up
  // rather than relying on Artemios to notice a gap on the calendar first.
  if (calendarSyncFailures.length > 0) {
    await sendAdminSMS(`⚠️ Calendar sync FAILED for ${calendarSyncFailures.length} of ${weeklySessions.length} session(s) in ${params.parentName}'s paid weekly booking:\n${calendarSyncFailures.join("\n")}\nBooking is confirmed — will self-heal by tomorrow's calendar sync, or add manually now.`).catch(() => {});
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
  const campAmountCharged = Math.max(0, (campTotalNum ?? sessionPrice ?? 0) - campCreditApplied);
  const campTotalWithFee = campAmountCharged > 0 ? Math.round((campAmountCharged + calcServiceFee(campAmountCharged)) * 100) / 100 : 0;
  const priceNote = campTotalPrice
    ? `<br/><strong>Total:</strong> ${campTotalPrice}${campCreditApplied > 0 ? ` — $${fmtMoney(campCreditApplied)} account credit applied` : ""}${campAmountCharged > 0 ? ` — <strong>Charged:</strong> $${fmtMoney(campTotalWithFee)}` : ""}`
    : "";
  const firstSession = campSessions[0];

  // Best-effort — the days are already paid for and confirmed, so a failure
  // here must not surface as a failed booking.
  if (campReferrer) {
    try {
      await awardReferralCreditOnce(campReferrer.email, params.email);
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
      calendarEvents: campSessions.map((s) => ({ date: s.date, startTime: s.startTime, endTime: s.endTime || s.startTime, location: s.location })),
      sessionDetailsIsHtml: true,
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
      ? `${campCreditApplied > 0 ? ` Total: ${campTotalPrice}, $${fmtMoney(campCreditApplied)} credit applied.` : ` Total: ${campTotalPrice}.`}${campAmountCharged > 0 ? ` Charged: $${fmtMoney(campTotalWithFee)}.` : ""}`
      : "";
    await sendSMS(params.phone, `Mesa Basketball: Camp confirmed (${campSessions.length} day${campSessions.length !== 1 ? "s" : ""})!${priceText}\n${campDayLines}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminCampLines = campSessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}\nLocation: ${resolveLocationName(s.location)}`
  ).join("\n");
  const campNameLine = `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}`;
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${campNameLine}\n${campSessions.length} camp day${campSessions.length !== 1 ? "s" : ""}:\n${adminCampLines}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${campReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`).catch(() => {});

  const calendarSyncFailures: string[] = [];
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
      calendarSyncFailures.push(`${session.date} ${session.startTime}`);
    }
  }
  if (calendarSyncFailures.length > 0) {
    await sendAdminSMS(`⚠️ Calendar sync FAILED for ${calendarSyncFailures.length} of ${campSessions.length} day(s) in ${params.parentName}'s paid camp booking (${campNameLine}):\n${calendarSyncFailures.join("\n")}\nBooking is confirmed — will self-heal by tomorrow's calendar sync, or add manually now.`).catch(() => {});
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
    // Already fully prepaid by an active monthly package — no Stripe charge
    // happened for this date, regardless of fullPrice/isFree.
    packageCovered?: boolean;
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

  // Best-effort double-booking detection — see alertIfPrivateDoubleBooked's
  // own doc comment. One check per date in the series. Never blocks/fails
  // this booking on error.
  if (isPrivateType) {
    for (const s of privateSessions) {
      if (!s.trainer) continue;
      alertIfPrivateDoubleBooked(s.date, s.startTime, s.endTime, s.location, s.trainer, params.parentName).catch((err) =>
        console.error("Double-booking check failed:", err)
      );
    }
  }

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
        const used = await countPackageSessionsUsed(activePkg.id);
        await setPackageSessions(activePkg.id, used);
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
  if (isPrivateType && privateSessions.some((s) => s.packageCovered)) {
    try {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const activePkg = await getActivePackage(params.email, currentMonth);
      if (activePkg) {
        packageSessionsRemaining = Math.max(0, activePkg.package_type - activePkg.sessions_used);
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
      await awardReferralCreditOnce(params.privateReferrer.email, params.email);
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
  // A recurring series can legitimately use different trainers on different
  // dates (see notifyTrainerOfNewBooking's per-session loop below) — the
  // standalone "Trainer:"/"Rate:" summary lines only ever reflect
  // privateSessions[0], so they'd misrepresent every other date whenever
  // the series isn't all one trainer. The accurate per-series total is
  // already itemized in priceNote/sessionDetails below, so it's safe (and
  // more accurate) to omit those two summary lines entirely in that case.
  const allSameTrainer = privateSessions.every((s) => trainerNamesMatch(s.trainer, privateSessions[0]?.trainer));
  const totalPaid = privateSessions.reduce((sum, s) => sum + (s.packageCovered ? 0 : s.isFree ? Math.round(s.fullPrice * 0.5 * 100) / 100 : s.fullPrice), 0);
  const seriesAmountCharged = Math.max(0, totalPaid - params.accountCreditApplied);
  const seriesTotalWithFee = seriesAmountCharged > 0 ? Math.round((seriesAmountCharged + calcServiceFee(seriesAmountCharged)) * 100) / 100 : 0;
  const priceNote = `<p><strong>Total:</strong> $${fmtMoney(totalPaid)}${params.accountCreditApplied > 0 ? ` — $${fmtMoney(params.accountCreditApplied)} account credit applied` : ""}${seriesAmountCharged > 0 ? ` — <strong>Charged:</strong> $${fmtMoney(seriesTotalWithFee)}` : ""}</p>`;

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
      calendarEvents: privateSessions.map((s) => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, location: s.location })),
      accountCreditApplied: params.accountCreditApplied,
      fullPrice: totalPaid,
      sessionDetailsIsHtml: true,
      suppressTrainerAndRateLines: !allSameTrainer,
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
    const trainerLine = privateSessions[0]?.trainer && allSameTrainer ? `\nTrainer: ${formatTrainerForDisplay(privateSessions[0].trainer)}` : "";
    const creditLine = params.accountCreditApplied > 0 ? `\n$${fmtMoney(params.accountCreditApplied)} account credit applied.` : "";
    const chargeLine = seriesAmountCharged > 0 ? `\nCharged: $${fmtMoney(seriesTotalWithFee)}.` : "";
    await sendSMS(params.phone, `Mesa Basketball: ${privateSessions.length} private sessions confirmed!\n${sessionLines}${trainerLine}${pkgNote}${creditLine}${chargeLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
  }

  const adminLines = privateSessions.map((s) =>
    `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
  ).join("\n");
  const trainerLine = privateSessions[0]?.trainer && allSameTrainer ? `\nTrainer: ${privateSessions[0].trainer}` : "";
  const adminTypeLabel = params.type === "group-private" ? "group private" : "private";
  await sendAdminSMS(`NEW BOOKING (paid): ${params.parentName}\n${privateSessions.length} ${adminTypeLabel} sessions:\n${adminLines}${trainerLine}\nPlayers: ${params.kids}${params.submittedReferralCode ? `\nRef code: ${params.submittedReferralCode} ${params.privateReferrer ? "✓ applied" : "✗ NOT applied"}` : ""}`).catch(() => {});

  if (isPrivateType) {
    // Per-session, not just privateSessions[0] — a recurring series can
    // legitimately use a different trainer on different dates (e.g. an "Any
    // Available Trainer" package floating across substitutes week to week).
    for (const s of privateSessions) {
      await notifyTrainerOfNewBooking({
        trainer: s.trainer,
        parentName: params.parentName,
        kids: params.kids,
        sessionLabel: adminTypeLabel === "group private" ? "Group Private Session" : "Private Session",
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        location: s.location,
      }).catch((err) => console.error("Trainer new-booking notify failed:", err));
    }
  }

  if (isPrivateType) {
    const calendarSyncFailures: string[] = [];
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
        calendarSyncFailures.push(`${s.date} ${s.startTime}`);
      }
    }
    // Private sessions have no daily reconciliation cron (unlike
    // weekly/camp), so a failed sync here would never self-heal.
    if (calendarSyncFailures.length > 0) {
      await sendAdminSMS(`⚠️ Calendar sync FAILED for ${calendarSyncFailures.length} of ${privateSessions.length} session(s) in ${params.parentName}'s paid private series:\n${calendarSyncFailures.join("\n")}\nBooking is confirmed — add these to the calendar manually.`).catch(() => {});
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
export async function expireAbandonedBookingBatch(
  bookingBatchId: string,
  // Set only for a reschedule's price-increase topup checkout — the
  // client's ORIGINAL booking is deliberately left untouched until this
  // topup actually succeeds (see settleOldBookingForReschedule's doc
  // comment), so there's nothing to refund or restore on abandonment here —
  // it's exactly as if the reschedule was never attempted. Only changes the
  // admin-facing copy below.
  isRescheduleTopup?: boolean
): Promise<void> {
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
  const first = abandoned[0];

  // Informational, not urgent — an email instead of a text, since abandoned
  // checkouts happen constantly (someone starts, backs out) and there's
  // nothing to act on immediately.
  try {
    await sendAbandonedCheckoutEmail({
      parentName: first.parent_name,
      email: first.email,
      phone: first.phone,
      kids: first.kids,
      sessions: abandoned.map((reg) => ({
        sessionDetails: reg.session_details,
        bookedDate: reg.booked_date,
        sessionPrice: reg.session_price,
      })),
      isRescheduleTopup,
    });
  } catch (err) {
    console.error("Failed to send abandoned checkout email:", err);
  }
}

/** A monthly package's Checkout Session expired unused — mirrors
 *  expireAbandonedBookingBatch above, just for the monthly_packages table. */
export async function expireAbandonedPackage(packageId: string): Promise<void> {
  const pkg = await abandonPendingPackage(packageId);
  if (!pkg) return;
  // Same restoration expireAbandonedBookingBatch already does for a
  // registration — this function's doc comment claimed to mirror that one
  // but was missing this step, so account credit applied toward a package
  // purchase just vanished if the client never completed the Stripe
  // checkout for the remainder.
  if (pkg.applied_account_credit && pkg.applied_account_credit > 0) {
    await addAccountCredit(pkg.email, pkg.applied_account_credit).catch((err) =>
      console.error(`Failed to restore $${pkg.applied_account_credit} account credit after abandoned package ${packageId}:`, err)
    );
  }
  try {
    await sendAbandonedPackageEmail({
      parentName: pkg.parent_name,
      email: pkg.email,
      phone: pkg.phone,
      packageType: pkg.package_type,
      monthYear: pkg.month_year,
    });
  } catch (err) {
    console.error("Failed to send abandoned package checkout email:", err);
  }
}

/**
 * Dispatches a checkout.session.expired event to the right table — mirrors
 * finalizePaidCheckoutSession's package_enrollment branch, since
 * client_reference_id means something different for each.
 */
export async function expireAbandonedCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
  const referenceId = session.client_reference_id;
  if (!referenceId) return;
  if (session.metadata?.purpose === "package_enrollment") {
    await expireAbandonedPackage(referenceId);
    return;
  }
  await expireAbandonedBookingBatch(referenceId, session.metadata?.purpose === "reschedule_topup");
}

export function parseKidsList(kidsStr: string): string[] {
  if (!kidsStr.trim()) return [];
  if (kidsStr.includes("(")) {
    return kidsStr.split("), ").map((p, i, arr) =>
      i < arr.length - 1 ? p + ")" : p
    ).filter((s) => s.trim());
  }
  return kidsStr.split(",").map((s) => s.trim()).filter(Boolean);
}

export function playerLabel(playerStr: string): string {
  const idx = playerStr.indexOf(" (");
  return idx > -1 ? playerStr.substring(0, idx).trim() : playerStr.trim();
}

export interface PlayerEditPricing {
  newPlayers: string[];
  oldPlayers: string[];
  newKidsStr: string;
  newCount: number;
  oldCount: number;
  removedPlayers: string[];
  addedPlayers: string[];
  isLate: boolean;
  newPrice: number | null;
  lateFeeDue?: number;
  priceChanged: boolean;
  additionalLateFee: number;
  wasPaid: boolean;
  oldAmount: number;
  newAmount: number;
  // Positive = client owes more; negative = a credit is due back.
  priceDelta: number;
  // What a Stripe Checkout would actually charge for this change — the
  // late fee is added on top rather than netted against a price decrease,
  // since forgiving one against the other would understate what's owed.
  totalOwedViaCheckout: number;
}

// Computes exactly what a roster change to `reg` would cost, WITHOUT
// mutating anything — shared between a client-facing preview (so the
// parent sees the real number before agreeing to pay) and the actual
// PATCH handler that charges it. Using the same function for both is what
// guarantees the preview can never quote a different amount than what
// Stripe actually charges a moment later.
export async function computePlayerEditPricing(
  reg: Registration,
  players: string[]
): Promise<PlayerEditPricing> {
  const newPlayers = players.filter((p) => p.trim());
  const oldPlayers = parseKidsList(reg.kids);
  const newKidsStr = newPlayers.join(", ");
  const newCount = newPlayers.length;
  const oldCount = oldPlayers.length;

  const removedPlayers = oldPlayers.filter((op) => !newPlayers.includes(op)).map(playerLabel);
  const addedPlayers = newPlayers.filter((np) => !oldPlayers.includes(np)).map(playerLabel);

  const isLate = !!(reg.booked_date && reg.booked_start_time &&
    isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));

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
    const duration = Math.max(60, parseTimeToMins(reg.booked_end_time) - parseTimeToMins(reg.booked_start_time));
    const oldTierHigh = oldCount >= 4;
    const newTierHigh = newCount >= 4;
    if (oldTierHigh !== newTierHigh) {
      const trainerTier = getTrainerTier(reg.booked_trainer);
      const lowPrice = calcPrivatePrice(duration, 1, trainerTier);
      const highPrice = calcPrivatePrice(duration, 4, trainerTier);
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
    // Pickup slot). No volume-discount tier applies here — that discount is
    // for booking several DIFFERENT sessions together, not for how many
    // players attend this one single session.
    try {
      const liveSessions = await getWeeklySchedule({ noCache: true });
      const liveMatch = liveSessions.find((s) => normLabel(s.group) === normLabel(reg.booked_group) && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
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
        console.error(`Player edit pricing: couldn't find "${reg.booked_group}" on ${reg.booked_date} ${reg.booked_start_time} in the live sheet — price left unchanged. Verify manually.`);
      }
    } catch (err) {
      console.error("Player edit pricing: live price lookup failed — price left unchanged.", err);
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

  return {
    newPlayers, oldPlayers, newKidsStr, newCount, oldCount,
    removedPlayers, addedPlayers, isLate, newPrice, lateFeeDue, priceChanged,
    additionalLateFee, wasPaid, oldAmount, newAmount, priceDelta, totalOwedViaCheckout,
  };
}

// Pure math, no DB calls — how much of a late reschedule's 50% forfeiture
// gets credited, and how much of that credit actually applies toward the
// new session's price. Shared between a route handler's PREVIEW of this
// (to size the Stripe topup Checkout charge, before anything is real) and
// settleOldBookingForReschedule's REAL application of it (after payment
// actually succeeds) — using the same function for both guarantees the
// number a client is asked to pay always matches the number that actually
// gets applied later, rather than two independently-written copies of this
// math silently drifting apart.
export function computeLateFeeAmounts(
  oldPaidAmount: number,
  isBulkDiscountedWeekly: boolean,
  newPriceKnown: boolean,
  newEffectivePrice: number | undefined
): { lateFeeCredited: number; lateFeeCreditApplied: number } {
  // Bulk-discounted weekly group sessions: late reschedule is full
  // forfeiture of the old session — nothing carried forward as credit.
  const lateFeeCredited = isBulkDiscountedWeekly ? 0 : Math.round(oldPaidAmount * 0.5 * 100) / 100;
  const lateFeeCreditApplied = newPriceKnown && newEffectivePrice != null && newEffectivePrice > 0 && lateFeeCredited > 0
    ? Math.min(lateFeeCredited, newEffectivePrice)
    : 0;
  return { lateFeeCredited, lateFeeCreditApplied };
}

export interface SettleOldBookingForRescheduleParams {
  reg: Registration;
  isLateReschedule: boolean;
  isBulkDiscountedWeekly: boolean;
  resolvedTrainer: string | undefined;
  newSessionDetails: string;
  newEffectivePrice: number | undefined;
  newPriceKnown: boolean;
  // Only set once the new session's Stripe topup has actually been paid
  // (called from the webhook) — folds the real charged amount straight into
  // the SAME late_fee_events row this function logs, instead of the old
  // two-phase "log a placeholder now, patch in the real amount later once
  // payment confirms" dance, which is no longer needed now that this whole
  // function only ever runs once the outcome is already real.
  amountChargedExtra?: number;
}

export interface SettleOldBookingForRescheduleResult {
  // False only if the old row was no longer "confirmed" by the time this
  // ran (a race — e.g. a duplicate webhook delivery, or the client
  // double-submitting the reschedule and completing both payments). Every
  // other field is a zeroed no-op in that case; the caller should treat this
  // as "someone else already settled it," not retry.
  cancelled: boolean;
  lateFeeCredited: number;
  lateFeeCreditApplied: number;
  packageSessionForfeited: boolean;
}

/**
 * The "old booking is really gone now" half of a reschedule — cancels the
 * original registration and fires every side effect that follows from that
 * (trainer notified, referral/account credit refunded, calendar event
 * removed, and — for a late reschedule — the 50% forfeiture credited and
 * applied toward the new session, logged to late_fee_events). Called from
 * exactly two places:
 *   - Synchronously from the client reschedule route, when no further
 *     Stripe payment is needed (same price, a price decrease, or a late
 *     reschedule whose credit fully covers the new session) — the whole
 *     reschedule completes in one request, so there's no async gap to worry
 *     about; this mirrors exactly what used to be inlined at the top of
 *     that route.
 *   - From the Stripe webhook, once a required topup payment actually
 *     succeeds — NOT synchronously when the reschedule is first requested.
 *     This is the fix for the real incident that motivated splitting this
 *     out: previously the old booking was cancelled (and, if late, its 50%
 *     fee already credited) the instant the client submitted the form,
 *     before they'd paid anything toward the new session — so an abandoned
 *     Stripe Checkout left them with no original booking, a fee already
 *     taken, and no new session actually booked. Deferring this call until
 *     payment is confirmed means an abandoned/expired checkout now leaves
 *     the original booking completely untouched, exactly as if the
 *     reschedule had never been attempted — no fee, no credit, no cancelled
 *     slot, nothing to refund or restore.
 */
export async function settleOldBookingForReschedule(params: SettleOldBookingForRescheduleParams): Promise<SettleOldBookingForRescheduleResult> {
  const { reg, isLateReschedule, isBulkDiscountedWeekly, resolvedTrainer, newSessionDetails, newEffectivePrice, newPriceKnown, amountChargedExtra } = params;

  const oldCancelled = await cancelRegistration(reg.manage_token, isLateReschedule);
  if (!oldCancelled) {
    return { cancelled: false, lateFeeCredited: 0, lateFeeCreditApplied: 0, packageSessionForfeited: false };
  }

  if (reg.package_id) {
    try {
      const used = await countPackageSessionsUsed(reg.package_id);
      await setPackageSessions(reg.package_id, used);
    } catch {
      // non-critical — don't fail the reschedule settlement over this
    }
  }

  // Notify the OLD trainer their slot is gone if this reschedule swaps to a
  // different trainer.
  if (reg.booked_trainer && reg.booked_trainer !== resolvedTrainer && reg.booked_date && reg.booked_start_time) {
    await notifyTrainerOfCancellation({
      trainer: reg.booked_trainer,
      parentName: reg.parent_name,
      sessionLabel: reg.type === "weekly" ? (reg.booked_group || "Group Session") : reg.type === "group-private" ? "Group Private Session" : "Private Session",
      date: reg.booked_date,
      startTime: reg.booked_start_time,
      endTime: reg.booked_end_time || reg.booked_start_time,
      location: reg.booked_location || "",
    }).catch((err) => console.error("Trainer reschedule-cancel notify failed:", err));
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

  const oldPaymentIntentId = reg.stripe_payment_intent_id || undefined;
  const oldPaidAmount = Math.max(0, resolvedSessionPrice(reg) - (reg.applied_account_credit || 0));

  let lateFeeCredited = 0;
  let lateFeeCreditApplied = 0;
  if (oldPaymentIntentId) {
    if (isLateReschedule) {
      const amounts = computeLateFeeAmounts(oldPaidAmount, isBulkDiscountedWeekly, newPriceKnown, newEffectivePrice);
      lateFeeCredited = amounts.lateFeeCredited;
      if (lateFeeCredited > 0) await addAccountCredit(reg.email, lateFeeCredited).catch(() => {});
      if (amounts.lateFeeCreditApplied > 0) {
        const applied = await deductAccountCredit(reg.email, amounts.lateFeeCreditApplied).catch(() => false);
        if (applied) lateFeeCreditApplied = amounts.lateFeeCreditApplied;
      }
      await logLateFeeEvent({
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
        amountChargedExtra: amountChargedExtra || undefined,
        newSessionDetails,
      });
    }
  }

  const packageSessionForfeited = !!(reg.package_id && isLateReschedule);
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
      action: "reschedule",
      initiatedBy: "client",
      newSessionDetails,
    });
  }

  return { cancelled: true, lateFeeCredited, lateFeeCreditApplied, packageSessionForfeited };
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
  // The OLD booking's own manage_token — looked up fresh here (rather than
  // trusting a payload built back when the reschedule was first requested)
  // so settleOldBookingForReschedule always acts on its actual current state.
  originalManageToken: string;
  bookedDate: string;
  bookedStartTime: string;
  bookedEndTime: string;
  bookedLocation: string;
  bookedGroup?: string;
  bookedTrainer?: string;
  totalParticipants: number;
  smsConsent: boolean;
  isLateReschedule: boolean;
  isBulkDiscountedWeekly: boolean;
  amountCharged: number;
  // The NEW (already-confirmed) booking's own effective price — used only to
  // cap how much of a late reschedule's credit applies toward it; always
  // known by this point since the row is real and priced.
  newEffectivePrice: number;
}

/**
 * A reschedule needed real money to move (the new session costs more than
 * what was already paid on the old one) — the client was sent to Stripe
 * Checkout for just the difference (or, after a late reschedule's 50% fee,
 * the new session's full price) and the webhook calls this once that
 * payment actually succeeds. The old booking is deliberately left fully
 * untouched until THIS point — see settleOldBookingForReschedule's own doc
 * comment for why (an abandoned/expired Checkout must leave the client
 * exactly where they started, not mid-cancelled with a fee already taken).
 */
export async function finalizeRescheduleTopup(params: FinalizeRescheduleTopupParams): Promise<void> {
  const isPrivateType = params.type === "private" || params.type === "group-private";

  const oldReg = await getRegistrationByToken(params.originalManageToken);
  let lateFeeCredited = 0;
  let lateFeeCreditApplied = 0;
  let packageSessionForfeited = false;
  let settlementFailed = false;
  if (!oldReg) {
    console.error(`finalizeRescheduleTopup: original booking (token ${params.originalManageToken}) not found — settlement skipped, new booking still confirmed.`);
    settlementFailed = true;
  } else {
    const settled = await settleOldBookingForReschedule({
      reg: oldReg,
      isLateReschedule: params.isLateReschedule,
      isBulkDiscountedWeekly: params.isBulkDiscountedWeekly,
      resolvedTrainer: params.bookedTrainer,
      newSessionDetails: params.newSessionDetails,
      newEffectivePrice: params.newEffectivePrice,
      newPriceKnown: true,
      amountChargedExtra: params.amountCharged,
    });
    if (!settled.cancelled) {
      console.error(`finalizeRescheduleTopup: original booking (token ${params.originalManageToken}) was no longer confirmed by payment time — settlement skipped (likely a duplicate webhook or a double-submitted reschedule), new booking still confirmed.`);
      settlementFailed = true;
    }
    lateFeeCredited = settled.lateFeeCredited;
    lateFeeCreditApplied = settled.lateFeeCreditApplied;
    packageSessionForfeited = settled.packageSessionForfeited;
  }

  // If the old booking couldn't be settled (most likely: the client
  // independently cancelled it themselves in another tab while this topup
  // checkout was still open), the client already got a full refund/credit
  // for the old session through THAT path — leaving the new booking
  // confirmed here would give them a different session for only the topup
  // delta, with the business eating the rest. Undo instead: cancel the new
  // booking and refund exactly what this checkout charged, the same
  // "charge went through but the precondition didn't hold, so bring it back
  // rather than keep it" pattern finalizePlayerEditTopup already uses below.
  if (settlementFailed) {
    const topupTotalWithFee = Math.round((params.amountCharged + calcServiceFee(params.amountCharged)) * 100) / 100;
    const newReg = await getRegistrationByToken(params.manageToken);
    if (newReg?.applied_account_credit && newReg.email) {
      await addAccountCredit(newReg.email, newReg.applied_account_credit).catch((err) =>
        console.error("Failed to refund new booking's applied account credit after reschedule-topup settlement failure:", err)
      );
    }
    const cancelled = await cancelRegistration(params.manageToken, false, 0);
    if (cancelled && newReg?.stripe_payment_intent_id && topupTotalWithFee > 0) {
      await issueStripeRefund({
        email: params.email,
        manageToken: params.manageToken,
        paymentIntentId: newReg.stripe_payment_intent_id,
        amountDollars: topupTotalWithFee,
        sessionLabel: params.newSessionDetails,
      }).catch((err) => console.error("Failed to refund reschedule topup after settlement failure:", err));
    }
    await sendAdminSMS(
      `RESCHEDULE TOPUP UNWOUND: ${params.email}\nOld booking was already gone by payment time — new booking cancelled and $${fmtMoney(topupTotalWithFee)} refunded instead of confirming a session for less than its price. Please verify manually.`
    ).catch(() => {});
    return;
  }
  const fullForfeitNoRefund = params.isBulkDiscountedWeekly && params.isLateReschedule;

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
      lateFeeCredited: lateFeeCredited || undefined,
      lateFeeCreditApplied: lateFeeCreditApplied || undefined,
      packageSessionForfeited,
      newSessionPackageCovered: false,
      fullForfeitNoRefund,
    });
  } catch (err) {
    console.error("Reschedule email failed (topup booking was paid):", err);
  }

  const topupTotalWithFee = Math.round((params.amountCharged + calcServiceFee(params.amountCharged)) * 100) / 100;
  const creditAppliedNote = lateFeeCreditApplied
    ? ` ($${fmtMoney(lateFeeCreditApplied)} late-fee credit applied, remainder charged)`
    : "";
  const forfeitSmsNote = packageSessionForfeited
    ? " (your original package session was forfeited — this is your new session, paid separately)"
    : fullForfeitNoRefund
      ? " (your original session was fully forfeited, non-refundable — this is your new session at full price)"
      : "";
  if (params.smsConsent && params.phone) {
    const trainerLine = params.bookedTrainer ? `\nTrainer: ${params.bookedTrainer}` : "";
    await sendSMS(params.phone, `Mesa Basketball: Reschedule confirmed — $${fmtMoney(topupTotalWithFee)} charged${creditAppliedNote}${forfeitSmsNote}!\n${formatDateWithDay(params.bookedDate)} | ${params.bookedStartTime}-${params.bookedEndTime}\nLocation: ${resolveLocationName(params.bookedLocation)}${trainerLine}\nAthlete: ${params.kids}\nManage: mesabasketballtraining.com/booking/${params.manageToken}\nReply STOP to opt out.`);
  }

  await sendAdminSMS(`RESCHEDULED (paid $${fmtMoney(topupTotalWithFee)}${creditAppliedNote}${packageSessionForfeited ? " — package session forfeited" : fullForfeitNoRefund ? " — weekly full forfeiture" : ""}): ${params.parentName}\nFrom: ${params.oldSessionDetails}\nTo: ${params.newSessionDetails}\nPlayers: ${params.kids}`).catch(() => {});

  // The OLD trainer (if this swapped trainers) was already notified their
  // slot was gone by settleOldBookingForReschedule above, just now (payment
  // only just confirmed — nothing about the old booking happens before
  // this). This just tells the trainer on the NEW booking that it's real
  // now that payment succeeded; no structured old date/time survives to
  // this point to distinguish "rescheduled" vs. "new booking" wording, so
  // this always reads as a fresh booking, which is accurate either way from
  // the perspective of whoever's now on the hook for it.
  if (params.bookedTrainer) {
    await notifyTrainerOfNewBooking({
      trainer: params.bookedTrainer,
      parentName: params.parentName,
      kids: params.kids,
      sessionLabel: isPrivateType ? (params.type === "group-private" ? "Group Private Session" : "Private Session") : (params.bookedGroup || "Group Session"),
      date: params.bookedDate,
      startTime: params.bookedStartTime,
      endTime: params.bookedEndTime,
      location: params.bookedLocation,
    }).catch((err) => console.error("Trainer reschedule-topup notify failed:", err));
  }

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
    await sendAdminSMS(`⚠️ Calendar sync FAILED for ${params.parentName}'s paid reschedule (${formatDateWithDay(params.bookedDate)} ${params.bookedStartTime}). Booking is confirmed — update the calendar manually.`).catch(() => {});
  }
}

/**
 * A monthly package's Stripe Checkout completed — flips it from
 * pending_payment to active, awards the referrer's credit (only now that
 * payment is actually confirmed, not at the enrollment request), and
 * announces it. Starts at 0 sessions used — a session only ever counts
 * against this package once a future booking is explicitly tagged with its
 * package_id (see allocatePackageCoverage in /api/register), never by
 * guessing from whatever else this email happened to book that month.
 */
export async function finalizePaidPackageEnrollment(
  packageId: string,
  paymentIntentId: string,
  customerId: string | null,
  metadata: Record<string, string>
): Promise<void> {
  const smsConsent = metadata.sms_consent === "true";
  const pkg = await finalizePaidPackage(packageId, paymentIntentId, customerId, smsConsent);
  if (!pkg) return; // already handled (duplicate webhook delivery) or not found

  const referrerEmail = metadata.referrer_email || undefined;
  const referrerName = metadata.referrer_name || undefined;
  if (referrerEmail) {
    try {
      await awardReferralCreditOnce(referrerEmail, pkg.email);
      await sendReferralCreditNotification({ referrerName: referrerName || "", referrerEmail, newClientName: pkg.parent_name });
    } catch (creditErr) {
      console.error("Failed to award referral credit (package, booking was paid):", creditErr);
    }
  }

  const kids = metadata.kids || "";
  const submittedReferralCode = metadata.submitted_referral_code || undefined;
  // Prefer the price actually stamped at enrollment (see enrollInPackage) —
  // recomputing live here would show the wrong amount in this confirmation
  // if the rate changed between purchase and this webhook firing. The
  // packagePrice() fallback only covers packages enrolled before total_price
  // existed.
  const totalPrice = pkg.total_price ?? packagePrice(pkg.package_type, normalizeTrainerTier(pkg.trainer_tier));
  // The fee was computed on whatever was left AFTER account credit at
  // enrollment (see /api/packages), not the full package price — using
  // totalPrice here would overstate it for any credit-covered enrollment,
  // and claim a card was charged for a package credit covered in full.
  const appliedCredit = pkg.applied_account_credit || 0;
  const amountCharged = Math.max(0, totalPrice - appliedCredit);
  const fee = amountCharged > 0 ? calcServiceFee(amountCharged) : 0;
  const totalWithFee = Math.round((totalPrice + fee) * 100) / 100;
  const chargedToCard = Math.round((amountCharged + fee) * 100) / 100;
  const monthLabel = formatMonthYear(pkg.month_year);

  try {
    await sendPackageConfirmation({
      parentName: pkg.parent_name,
      email: pkg.email,
      phone: pkg.phone,
      packageType: pkg.package_type,
      monthYear: pkg.month_year,
      totalPrice,
      appliedAccountCredit: appliedCredit,
      kids: kids || undefined,
      referralCode: submittedReferralCode,
    });
  } catch (notifyErr) {
    console.error("Package confirmation email failed (booking was paid):", notifyErr);
  }

  if (smsConsent && pkg.phone) {
    const creditLine = appliedCredit > 0 ? `\n$${fmtMoney(appliedCredit)} account credit applied.` : "";
    const chargeLine = chargedToCard > 0 ? `\nCharged: $${fmtMoney(chargedToCard)}.` : "\nFully covered by account credit — no card was charged.";
    await sendSMS(pkg.phone, `Mesa Basketball: Your ${pkg.package_type}-session package is confirmed for ${monthLabel}! Total: $${fmtMoney(totalWithFee)}.${creditLine}${chargeLine}\nBook your private sessions at mesabasketballtraining.com/schedule and we'll track them automatically.\nReply STOP to opt out.`);
  }
  const adminMoney = appliedCredit > 0
    ? `total $${fmtMoney(totalWithFee)} — $${fmtMoney(appliedCredit)} credit applied, $${fmtMoney(chargedToCard)} charged`
    : `paid $${fmtMoney(totalWithFee)}`;
  await sendAdminSMS(`NEW PACKAGE (${adminMoney}): ${pkg.parent_name}\n${pkg.package_type}-session package — ${monthLabel}\nPhone: ${pkg.phone}${kids ? `\nPlayers: ${kids}` : ""}${submittedReferralCode ? `\nRef code: ${submittedReferralCode} ${referrerEmail ? "✓ applied" : "✗ NOT applied"}` : ""}`).catch(() => {});
}

/**
 * A client's own player-roster edit (add/remove players) that increased the
 * price, or a late removal that owes its own separate fee — the roster and
 * price change is applied HERE, once Stripe confirms the topup actually got
 * paid, never at the moment the checkout was created. There's no new
 * registration row for this (it modifies an existing confirmed one), so
 * everything needed is carried in the Checkout Session's own metadata rather
 * than a booking_batch_id.
 */
async function finalizePlayerEditTopup(session: Stripe.Checkout.Session): Promise<void> {
  const metadata = session.metadata || {};
  const token = metadata.manage_token;
  if (!token) return;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    console.error(`Player-edit topup paid but booking for token ${token} no longer exists — manual follow-up needed.`);
    return;
  }

  const newKids = metadata.new_kids || reg.kids;
  const newCount = metadata.new_count ? parseInt(metadata.new_count, 10) : reg.total_participants;
  const newPrice = metadata.new_price ? Math.round(parseFloat(metadata.new_price) * 100) / 100 : reg.session_price;

  // Nothing here ever changes reg.status, so updateRegistrationPlayers'
  // .eq("status","confirmed") guard can't detect "already processed" the way
  // the main registration flow does — a duplicate webhook delivery (Stripe
  // guarantees at-least-once, not exactly-once) would otherwise re-apply a
  // harmless no-op update but ALSO re-sync the calendar and re-send the
  // client/admin notifications every single redelivery. Checking whether the
  // row already reflects the intended end state catches that without needing
  // a new column.
  if (reg.kids === newKids && reg.total_participants === newCount && (newPrice == null || reg.session_price === newPrice)) {
    return;
  }

  let removedPlayers: string[] = [];
  let addedPlayers: string[] = [];
  try {
    removedPlayers = metadata.removed_players ? JSON.parse(metadata.removed_players) : [];
    addedPlayers = metadata.added_players ? JSON.parse(metadata.added_players) : [];
  } catch (err) {
    // Malformed/truncated metadata (Stripe caps each value at 500 chars) —
    // don't let a JSON.parse throw fail the whole webhook handler, which
    // Stripe would then retry uselessly for up to 3 days. The roster/price
    // change itself doesn't depend on these lists; they're only used for
    // the notification copy.
    console.error(`Player-edit topup: couldn't parse removed/added players metadata for token ${token} — notification will show an incomplete list.`, err);
  }
  const isLate = metadata.is_late === "true";
  const lateFeeDue = metadata.late_fee_due ? parseFloat(metadata.late_fee_due) : undefined;
  const oldPrice = metadata.old_price ? parseFloat(metadata.old_price) : reg.session_price;

  const ok = await updateRegistrationPlayers(token, newKids, newCount, newPrice);
  if (!ok) {
    // The booking stopped being confirmed between checkout creation and
    // payment completing (e.g. the client cancelled in the meantime,
    // extremely rare) — the charge already went through, so it needs to
    // come straight back rather than leaving them charged for a roster
    // change that never actually applied.
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    const amountTotal = session.amount_total != null ? session.amount_total / 100 : 0;
    if (paymentIntentId && amountTotal > 0) {
      await issueStripeRefund({
        email: reg.email,
        paymentIntentId,
        amountDollars: amountTotal,
        sessionLabel: reg.session_details || "",
      }).catch((err) => console.error("Failed to refund player-edit topup after failed update:", err));
    }
    console.error(`Player-edit topup paid but booking ${token} was no longer confirmed when finalizing — refunded and left unchanged.`);
    return;
  }

  try {
    if (reg.type === "private" || reg.type === "group-private") {
      if (reg.booked_date && reg.booked_start_time) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date, bookedStartTime: reg.booked_start_time });
      }
      if (reg.booked_date && reg.booked_start_time && reg.booked_end_time && reg.booked_location) {
        await addPrivateSessionToCalendar({
          parentName: reg.parent_name,
          email: reg.email,
          phone: reg.phone,
          kids: newKids,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time,
          bookedLocation: reg.booked_location,
          trainer: reg.booked_trainer || undefined,
        });
      }
    } else if (reg.booked_date && reg.booked_start_time) {
      await upsertGroupSessionCalendarEvent({
        sessionType: reg.type as "weekly" | "camp",
        sessionLabel: reg.booked_group || reg.session_details.split(" — ")[0] || "Group Session",
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        bookedEndTime: reg.booked_end_time || reg.booked_start_time,
        bookedLocation: reg.booked_location || "",
        kidsJustRegistered: newKids,
        participantsJustRegistered: newCount,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (player-edit topup):", err);
    await sendAdminSMS(`⚠️ Calendar sync FAILED for ${reg.parent_name}'s paid player-edit update (${reg.booked_date ? formatDateWithDay(reg.booked_date) : "?"} ${reg.booked_start_time || "?"}). Booking is confirmed — update the calendar manually.`).catch(() => {});
  }

  try {
    await sendPlayerUpdateNotification({
      parentName: reg.parent_name,
      email: reg.email,
      sessionDetails: reg.session_details,
      removedPlayers,
      addedPlayers,
      newKids,
      sessionType: reg.type,
      isLate,
      lateFeeDue,
      oldPrice,
      newPrice,
      priceChanged: newPrice !== oldPrice,
    });
    const changeNote = [
      addedPlayers.length > 0 ? `Added: ${addedPlayers.join(", ")}` : "",
      removedPlayers.length > 0 ? `Removed: ${removedPlayers.join(", ")}` : "",
    ].filter(Boolean).join(" | ");
    const sessionLabel = reg.session_details.split(" — ")[0] || reg.session_details;
    const totalOwed = metadata.total_owed ? parseFloat(metadata.total_owed) : 0;
    await sendAdminSMS(`PLAYERS UPDATED & PAID (${sessionLabel}): ${reg.parent_name}\n${changeNote || "Roster order/details changed"}\nNow: ${newKids}\n$${fmtMoney(totalOwed + calcServiceFee(totalOwed))} charged (incl. service fee).`).catch(() => {});
  } catch (err) {
    console.error("Player update notification error (paid topup):", err);
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
  const metadata = session.metadata || {};

  // A client editing their own player roster on an already-confirmed
  // booking, where the change increases the price (or a late removal owes a
  // separate fee) — same "no client_reference_id" shape as the package fee
  // above, since this modifies an EXISTING registration row rather than
  // creating a new batch. The roster/price change itself only actually
  // applies here, after payment confirms, not when the checkout was created.
  if (metadata.purpose === "player_edit_topup") {
    await finalizePlayerEditTopup(session);
    return;
  }

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

  // A monthly package purchase — client_reference_id here is the
  // monthly_packages row's own id, not a registrations booking_batch_id, so
  // this has to branch before ever touching finalizePaidBookingBatch below.
  if (metadata.purpose === "package_enrollment") {
    await finalizePaidPackageEnrollment(bookingBatchId, paymentIntentId, customerId, metadata);
    return;
  }

  // Only rows still pending_payment get flipped here — a duplicate delivery
  // (or the cron catching one the webhook already handled) finds nothing
  // left to update and this returns an empty array, so the notification/
  // calendar side effects below never run twice.
  const confirmedRows = await finalizePaidBookingBatch(bookingBatchId, paymentIntentId, customerId);
  if (confirmedRows.length === 0) return;

  // A reschedule that needed a Stripe topup (or, after a late reschedule's
  // 50% fee, a fresh full charge) — the OLD booking is still fully
  // untouched at this point (see settleOldBookingForReschedule's doc
  // comment) and only gets cancelled/settled now, inside
  // finalizeRescheduleTopup, now that payment has actually gone through.
  if (metadata.purpose === "reschedule_topup") {
    const reg = confirmedRows[0];
    if (!reg.booked_date || !reg.booked_start_time) return;
    if (!metadata.original_manage_token) {
      console.error(`reschedule_topup checkout ${session.id} completed with no original_manage_token in metadata — cannot settle the old booking.`);
      return;
    }
    await finalizeRescheduleTopup({
      parentName: reg.parent_name,
      email: reg.email,
      phone: reg.phone,
      kids: reg.kids,
      type: reg.type,
      oldSessionDetails: metadata.old_session_details || "your previous session",
      newSessionDetails: reg.session_details,
      manageToken: reg.manage_token,
      originalManageToken: metadata.original_manage_token,
      bookedDate: reg.booked_date,
      bookedStartTime: reg.booked_start_time,
      bookedEndTime: reg.booked_end_time || reg.booked_start_time,
      bookedLocation: reg.booked_location || "",
      bookedGroup: reg.booked_group || undefined,
      bookedTrainer: reg.booked_trainer || undefined,
      totalParticipants: reg.total_participants,
      smsConsent: !!reg.sms_consent,
      isLateReschedule: metadata.is_late_reschedule === "true",
      isBulkDiscountedWeekly: metadata.is_bulk_discounted_weekly === "true",
      amountCharged: metadata.topup_amount ? Number(metadata.topup_amount) : 0,
      newEffectivePrice: resolvedSessionPrice(reg),
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
