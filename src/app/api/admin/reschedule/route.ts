import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";
import { sendRescheduleNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { getWeeklySchedule } from "@/lib/sheets";
import { addAccountCredit, deductAccountCredit, addReferralCredit } from "@/lib/supabase";
import { isLateAction, resolveOffSessionPaymentSource, chargeSavedCardOffSession } from "@/lib/booking-finalize";
import { SERVICE_FEE, SERVICE_FEE_LABEL } from "@/lib/pricing";

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

function isPrivateType(type: string): boolean {
  return type === "private" || type === "group-private";
}

// Fallback when session_price is null (a real, common case — legacy rows)
// rather than treating an unset price as $0, which would understate what's
// actually owed. Mirrors fullPriceForType() in the admin dashboard.
function fullPriceForType(type: string): number {
  return type === "group-private" ? 250 : type === "private" ? 150 : 50;
}

// The DB always stores the FULL (undiscounted) session_price for private
// sessions — the referral-credit / first-time 50% off is applied at display
// and billing time via is_free, never baked into the stored price. Mirrors
// resolvedSessionPrice() in booking/[token]/route.ts and effectivePrice() in
// the admin dashboard.
function effectiveAmount(fullPrice: number, isFree: boolean, isPriv: boolean): number {
  return isFree && isPriv ? Math.round(fullPrice * 0.5) : fullPrice;
}

// Admin-initiated move of a single confirmed booking to a new day/time/location
// (and optionally a new type, e.g. converting a group booking into a private
// one). Unlike the client-facing reschedule, this updates the row in place
// (same manage_token, same id). On-time, this never charges a late fee — the
// business made the change, not the client. If the OLD session is genuinely
// within the late window, the admin explicitly chooses whether to waive the
// fee (helping the client out) or charge the same fee the client would owe
// themselves (e.g. they're having trouble using the site but still owe it).
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, bookedDate, bookedStartTime, bookedEndTime, bookedLocation, bookedGroup, bookedTrainer, sessionLabelPrefix, newType, keepReferralCredit, feeChoice } = await req.json();
  if (!id || !bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (feeChoice && feeChoice !== "waive" && feeChoice !== "charge") {
    return NextResponse.json({ error: "Invalid feeChoice" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: reg } = await supabase
    .from("registrations")
    .select("*")
    .eq("id", id)
    .single();

  if (!reg) {
    return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json({ error: "Only confirmed bookings can be rescheduled" }, { status: 400 });
  }

  // Same lateness rule a client-initiated reschedule uses, checked against
  // the OLD (current) session time before it moves. Gate on the choice
  // before any mutation happens, so a retry after the admin picks is clean.
  const isLateReschedule = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));
  if (isLateReschedule && !feeChoice) {
    return NextResponse.json(
      { error: "The current session is within the 24-hour window — choose how to handle the fee.", needsFeeChoice: true, isLateReschedule: true },
      { status: 400 }
    );
  }
  const chargeLateFee = isLateReschedule && feeChoice === "charge";

  const oldSessionDetails: string = reg.session_details;
  const oldBookedDate: string | null = reg.booked_date;
  const oldBookedStartTime: string | null = reg.booked_start_time;
  const oldSessionLabel: string = reg.booked_group || "";
  const wasPrivate = isPrivateType(reg.type);

  const effectiveType: string = (typeof newType === "string" && newType) ? newType : reg.type;
  const isNewPrivate = isPrivateType(effectiveType);

  // Rebuild session_details by swapping only the trailing "date time at location"
  // segment. If the caller (the reschedule picker) already knows the exact new
  // group/camp/private label — which may itself contain " — ", e.g. "High
  // School Girls — Grades 9-12" — use that. Otherwise fall back to preserving
  // whatever prefix the existing session_details already had.
  const derivedParts = (oldSessionDetails || "").split(" — ");
  const derivedPrefix = derivedParts.length > 1 ? derivedParts.slice(0, -1).join(" — ") : (derivedParts[0] || "");
  const prefix = (typeof sessionLabelPrefix === "string" && sessionLabelPrefix) ? sessionLabelPrefix : derivedPrefix;
  const newSessionDetails = `${prefix} — ${bookedDate} ${bookedStartTime}-${bookedEndTime} at ${bookedLocation}`;

  const newSessionLabel: string = (typeof bookedGroup === "string" && bookedGroup) ? bookedGroup : oldSessionLabel;
  const resolvedTrainer = (typeof bookedTrainer === "string" && bookedTrainer) ? bookedTrainer : (reg.booked_trainer || undefined);

  // Referral-credit reuse: only meaningful when the booking already used one
  // (private-only in this codebase) and the caller explicitly says whether to
  // keep applying it. Default (no explicit value) preserves whatever the
  // booking already had — nothing changes unless the admin actively unchecks it.
  // Moving away from private entirely always drops it — the 50% discount
  // mechanism doesn't exist for weekly/camp sessions in this codebase, so
  // leaving these flags set on a non-private row would be inconsistent state.
  let newIsFree: boolean = !!reg.is_free;
  let newUsedReferralCredit: boolean = !!reg.used_referral_credit;
  let creditRefunded = false;
  if (wasPrivate && !isNewPrivate) {
    newIsFree = false;
    newUsedReferralCredit = false;
  } else if (reg.used_referral_credit && typeof keepReferralCredit === "boolean" && !keepReferralCredit) {
    newIsFree = false;
    newUsedReferralCredit = false;
  }

  // Recompute the FULL (undiscounted) price whenever the destination charges
  // differently than the source. Group -> private isn't comparable at all, so
  // it's always recalculated from the new duration. Private -> private is also
  // recalculated, since duration-based pricing should reflect the actual new
  // slot length. Weekly -> weekly is recalculated too, since different groups
  // can have very different rates (e.g. "HS Pickup" is $30, a regular group is
  // $50) — looked up from the live sheet rather than trusted from the client.
  // Camp pricing is left untouched — too many variables (early-bird, drop-in
  // rate, referral discounts) to safely auto-recompute.
  let newFullPrice: number | undefined;
  let priceLookupFailed = false;
  if (isNewPrivate) {
    const durationMins = Math.max(60, parseMinsFromTime(bookedEndTime) - parseMinsFromTime(bookedStartTime));
    newFullPrice = calcPrivatePrice(durationMins, reg.total_participants || 1);
  } else if (effectiveType === "weekly") {
    try {
      const sessions = await getWeeklySchedule();
      const match = sessions.find((s) => s.group === newSessionLabel && s.date === bookedDate && s.startTime === bookedStartTime);
      if (match) {
        newFullPrice = Math.round(match.price * (reg.total_participants || 1));
      } else {
        priceLookupFailed = true;
      }
    } catch {
      // Sheet lookup failed — leave the existing price untouched rather than guessing.
      priceLookupFailed = true;
    }
    if (priceLookupFailed) {
      console.error(`Admin reschedule: couldn't find "${newSessionLabel}" on ${bookedDate} ${bookedStartTime} in the live sheet — session_price left unchanged at $${reg.session_price}. Verify manually.`);
    }
  }

  // Account credit applied at the original booking (separate from the
  // referral-credit 50% discount) still belongs to this same booking after a
  // reschedule — it isn't touched by this update, so it reduces what's shown
  // as owed on both sides. It's a constant offset either way, so it doesn't
  // change the credit-granted/amount-due delta, but the displayed $ amounts
  // need to reflect what the client actually still owes, not the pre-credit rate.
  const appliedCredit = reg.applied_account_credit || 0;
  const oldFullPrice = reg.session_price ?? fullPriceForType(reg.type);
  const oldAmount = Math.max(0, effectiveAmount(oldFullPrice, !!reg.is_free, wasPrivate) - appliedCredit);
  const newAmount = newFullPrice !== undefined ? Math.max(0, effectiveAmount(newFullPrice, newIsFree, isNewPrivate) - appliedCredit) : oldAmount;
  const priceDelta = newFullPrice !== undefined ? newAmount - oldAmount : 0;

  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;

  // Late + the admin chose to charge the fee: same policy a client-initiated
  // late reschedule pays — 50% of what they paid for the OLD session is
  // credited, then applied toward the new session's price. Unlike every
  // other admin tool, any TRUE remainder beyond that credit is charged
  // automatically to the card on file, right now, before anything else
  // happens — the admin explicitly asked for this (parents don't reliably
  // pay a "you still owe X" note on their own), and unlike a fully
  // unattended flow, the admin is right here to see success or failure
  // immediately. If there's no saved card to charge, or the charge fails
  // (declined, expired, etc.), the whole reschedule is aborted before
  // anything changes — the original session stays booked exactly as it
  // was, and it's on the admin to have the client sort out their card.
  let lateFeeCredited = 0;
  let lateFeeCreditApplied = 0;
  let autoChargedAmount = 0;
  let autoChargePaymentIntentId: string | undefined;
  if (wasPaid && chargeLateFee) {
    lateFeeCredited = Math.round(oldAmount * 0.5);
    lateFeeCreditApplied = Math.min(lateFeeCredited, newAmount);
    const remainder = Math.max(0, Math.round((newAmount - lateFeeCreditApplied) * 100) / 100);
    if (remainder > 0.005) {
      const source = await resolveOffSessionPaymentSource(reg);
      if (!source) {
        return NextResponse.json(
          { error: `No saved card found for ${reg.parent_name} to auto-charge the remaining $${remainder} — the reschedule was NOT applied. Choose "waive" instead, or have them update their payment method first.` },
          { status: 402 }
        );
      }
      const plainSessionDetails = newSessionDetails.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
      const chargeResult = await chargeSavedCardOffSession({
        customerId: source.customerId,
        paymentMethodId: source.paymentMethodId,
        amountDollars: Math.round((remainder + SERVICE_FEE) * 100) / 100,
        description: `Late reschedule remainder: ${plainSessionDetails || "Mesa Basketball Training Session"}`,
      });
      if (!chargeResult.success) {
        return NextResponse.json(
          { error: `Couldn't automatically charge the remaining $${remainder} (+ ${SERVICE_FEE_LABEL} fee) — ${chargeResult.reason} The reschedule was NOT applied; the original session is unchanged.` },
          { status: 402 }
        );
      }
      autoChargedAmount = remainder;
      autoChargePaymentIntentId = chargeResult.paymentIntentId;
    }
  }

  const { error } = await supabase
    .from("registrations")
    .update({
      type: effectiveType,
      booked_date: bookedDate,
      booked_start_time: bookedStartTime,
      booked_end_time: bookedEndTime,
      booked_location: bookedLocation,
      booked_group: isNewPrivate ? null : (newSessionLabel || reg.booked_group),
      booked_trainer: resolvedTrainer || null,
      session_details: newSessionDetails,
      admin_change_at: new Date().toISOString(),
      is_free: newIsFree,
      used_referral_credit: newUsedReferralCredit,
      ...(newFullPrice !== undefined ? { session_price: newFullPrice } : {}),
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Unchecking "keep referral credit" gives the credit back — they're no
  // longer using it, so it shouldn't just vanish.
  if (reg.used_referral_credit && !newUsedReferralCredit) {
    try {
      await addReferralCredit(reg.email);
      creditRefunded = true;
    } catch (err) {
      console.error("Failed to refund referral credit (admin reschedule):", err);
    }
  }

  // "Already paid" covers both the old manual cash toggle AND a real Stripe
  // charge — Stripe-paid rows never set is_paid, so checking that alone would
  // miss every paying client since Stripe went live.
  //
  // On-time (or the admin chose to waive the fee): if the new amount owed is
  // lower, credit the difference to their account for their next booking
  // (same rule already used for partial camp-day cancellations elsewhere) —
  // always account credit here, never a real Stripe refund, since this is a
  // business-initiated change, not a client cancellation. If the new amount
  // is higher, there's no charge triggered automatically — surface it in the
  // response/notices instead so the admin can follow up.
  //
  // Late + charged: any remainder was already auto-charged above (or there
  // wasn't one) — this only needs to actually grant/apply the 50% late-fee
  // credit now that the reschedule (and any required charge) has succeeded.
  let creditGranted = 0;
  let amountDue = 0;
  if (wasPaid && chargeLateFee) {
    if (lateFeeCredited > 0) {
      try {
        await addAccountCredit(reg.email, lateFeeCredited);
      } catch (err) {
        console.error("Failed to grant late-fee account credit (admin reschedule):", err);
      }
      if (lateFeeCreditApplied > 0) {
        const applied = await deductAccountCredit(reg.email, lateFeeCreditApplied).catch(() => false);
        if (!applied) lateFeeCreditApplied = 0; // couldn't apply it (shouldn't happen right after crediting it) — leave it in their balance instead
      }
    }
    creditGranted = lateFeeCredited - lateFeeCreditApplied;
  } else if (wasPaid && priceDelta < 0) {
    try {
      await addAccountCredit(reg.email, -priceDelta);
      creditGranted = -priceDelta;
    } catch (err) {
      console.error("Failed to grant account credit (admin reschedule):", err);
    }
  } else if (wasPaid && priceDelta > 0) {
    amountDue = priceDelta;
  }

  // Sync calendar. Private sessions are a single event tied to the booking;
  // group/camp sessions are shared events keyed by date+time+label, so we
  // recompute the old slot (this registrant leaving) and the new slot (this
  // registrant arriving) from what's now in the DB. The old and new sides are
  // handled independently since a type conversion (e.g. group -> private)
  // means one side is a shared group event and the other is a standalone one.
  try {
    if (wasPrivate) {
      if (oldBookedDate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: oldBookedDate });
      }
    } else if (oldBookedDate && oldBookedStartTime) {
      await upsertGroupSessionCalendarEvent({
        sessionType: reg.type as "weekly" | "camp",
        sessionLabel: oldSessionLabel || derivedPrefix,
        bookedDate: oldBookedDate,
        bookedStartTime: oldBookedStartTime,
        bookedEndTime: reg.booked_end_time || oldBookedStartTime,
        bookedLocation: reg.booked_location || "",
        kidsJustRegistered: "",
        participantsJustRegistered: 0,
      });
    }

    if (isNewPrivate) {
      await addPrivateSessionToCalendar({
        parentName: reg.parent_name,
        email: reg.email,
        phone: reg.phone,
        kids: reg.kids,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        trainer: resolvedTrainer,
      });
    } else {
      await upsertGroupSessionCalendarEvent({
        sessionType: effectiveType as "weekly" | "camp",
        sessionLabel: newSessionLabel || prefix,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        kidsJustRegistered: reg.kids,
        participantsJustRegistered: reg.total_participants || 1,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (admin reschedule):", err);
  }

  // Notify the client. On-time (or waived), this was the business's call —
  // no fee. Late + charged: same policy a client-initiated late reschedule
  // pays, so the note explains the 50% fee credit and how much of it (if
  // any) covered the new session. The price note is appended directly (not
  // part of the shared template) since only this admin flow needs to say
  // "no change" vs "credited" vs "due".
  const priceNote = chargeLateFee
    ? `\nLate reschedule fee: $${lateFeeCredited} (50% of what you paid) credited to your account${lateFeeCreditApplied > 0 ? `, $${lateFeeCreditApplied} applied to your new session` : ""}.${autoChargedAmount > 0 ? ` $${Math.round((autoChargedAmount + SERVICE_FEE) * 100) / 100} ($${autoChargedAmount} + ${SERVICE_FEE_LABEL} fee) was charged to your card on file to cover the rest.` : ""}`
    : newFullPrice === undefined
      ? ""
      : creditGranted > 0
        ? `\n$${oldAmount} → $${newAmount}. $${creditGranted} credited to your account for your next booking.`
        : amountDue > 0
          ? `\n$${oldAmount} → $${newAmount}. $${amountDue} additional due.`
          : priceDelta !== 0
            ? `\n$${oldAmount} → $${newAmount}.`
            : "";
  const creditRefundNote = creditRefunded ? "\nYour referral credit was refunded since it's no longer applied to this booking." : "";

  // Spell out exactly what moved — which session type/name, on what day, at
  // what time — rather than just the new slot, so it reads as a clear
  // "from this, to this" rather than a bare confirmation.
  const fromLine = (oldBookedDate && oldBookedStartTime)
    ? `From: ${derivedPrefix || "Session"} — ${formatDateWithDay(oldBookedDate)} | ${oldBookedStartTime}${reg.booked_end_time ? `-${reg.booked_end_time}` : ""}${reg.booked_location ? ` at ${resolveLocationName(reg.booked_location)}` : ""}`
    : null;
  const toLine = `To: ${prefix} — ${formatDateWithDay(bookedDate)} | ${bookedStartTime}-${bookedEndTime} at ${resolveLocationName(bookedLocation)}`;

  try {
    await sendRescheduleNotification({
      parentName: reg.parent_name,
      email: reg.email,
      oldSessionDetails,
      newSessionDetails,
      manageToken: reg.manage_token,
      isLateReschedule: chargeLateFee,
      lateFeeCredited: chargeLateFee ? lateFeeCredited : undefined,
      lateFeeCreditApplied: chargeLateFee ? lateFeeCreditApplied : undefined,
      priceAdjustment: autoChargedAmount > 0 ? { kind: "charge", amount: autoChargedAmount } : undefined,
      newTrainer: resolvedTrainer,
    });
    if (reg.sms_consent && reg.phone) {
      await sendSMS(
        reg.phone,
        `Mesa Basketball: Your session has been rescheduled by your trainer.\n${fromLine ? `${fromLine}\n` : ""}${toLine}\nAthlete: ${reg.kids}${priceNote}${creditRefundNote}\nManage: mesabasketballtraining.com/booking/${reg.manage_token}\nReply STOP to opt out.`
      );
    }
    const adminPriceNote = chargeLateFee
      ? `\nLate fee charged: $${lateFeeCredited} credited (50% of $${oldAmount} paid)${lateFeeCreditApplied > 0 ? `, $${lateFeeCreditApplied} applied to new session ($${newAmount})` : ""}.${autoChargedAmount > 0 ? ` $${Math.round((autoChargedAmount + SERVICE_FEE) * 100) / 100} auto-charged to their card on file (${autoChargePaymentIntentId}).` : ""}`
      : newFullPrice === undefined
        ? ""
        : creditGranted > 0
          ? `\n$${oldAmount} -> $${newAmount}: $${creditGranted} credited to their account (already paid)`
          : amountDue > 0
            ? `\n$${oldAmount} -> $${newAmount}: $${amountDue} additional now due (already paid at the old price)`
            : priceDelta !== 0
              ? `\nPrice: $${oldAmount} -> $${newAmount}`
              : "";
    const adminCreditRefundNote = creditRefunded ? "\nReferral credit refunded (no longer applied)." : "";
    const priceLookupFailedNote = priceLookupFailed ? `\n⚠️ Couldn't verify the new price on the schedule sheet — price left at $${reg.session_price}, double-check it manually.` : "";
    await sendAdminSMS(`ADMIN RESCHEDULED: ${reg.parent_name}\nFrom: ${oldSessionDetails}\nTo: ${newSessionDetails}\nPlayers: ${reg.kids}${adminPriceNote}${adminCreditRefundNote}${priceLookupFailedNote}`);
  } catch (err) {
    console.error("Notification error (admin reschedule):", err);
  }

  return NextResponse.json({
    success: true,
    sessionDetails: newSessionDetails,
    newType: effectiveType,
    newSessionPrice: newFullPrice,
    oldAmount,
    newAmount,
    priceDelta,
    creditGranted,
    amountDue,
    creditRefunded,
    newIsFree,
    newUsedReferralCredit,
    priceLookupFailed,
    isLateReschedule,
    lateFeeCharged: chargeLateFee,
    lateFeeCredited: chargeLateFee ? lateFeeCredited : undefined,
    lateFeeCreditApplied: chargeLateFee ? lateFeeCreditApplied : undefined,
    autoChargedAmount: autoChargedAmount > 0 ? autoChargedAmount : undefined,
  });
}
