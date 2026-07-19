import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { finalizePaidBookingBatch } from "@/lib/supabase";
import {
  finalizeConfirmedPrivateBooking,
  finalizeConfirmedPrivateSeriesBooking,
  finalizeConfirmedWeeklyBooking,
  finalizeConfirmedCampBooking,
  finalizeRescheduleTopup,
  expireAbandonedBookingBatch,
} from "@/lib/booking-finalize";

// Stripe needs the raw, unparsed request body to verify the signature —
// same requirement as Twilio's webhook (see src/app/api/twilio/incoming),
// so this mirrors that route's shape: verify first, then act.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature") || "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await req.text();

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return new NextResponse("Not configured", { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return new NextResponse("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
    }
  } catch (err) {
    console.error(`Stripe webhook handler error (${event.type}):`, err);
    // Still ack with 200 below — Stripe retries on non-2xx, and re-running a
    // failed finalize is exactly what we want (finalizePaidBookingBatch's
    // pending-only WHERE clause makes it safe to retry).
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
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

  // Only rows still pending_payment get flipped here — a duplicate webhook
  // delivery for the same session finds nothing left to update and this
  // returns an empty array, so the notification/calendar side effects below
  // never run twice.
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
      campCreditApplied,
      sessionPrice: first.session_price ?? undefined,
    });
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const bookingBatchId = session.client_reference_id;
  if (!bookingBatchId) return;
  await expireAbandonedBookingBatch(bookingBatchId);
}
