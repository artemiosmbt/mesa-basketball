import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";
import { sendRescheduleNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { getWeeklySchedule } from "@/lib/sheets";
import { addAccountCredit, deductAccountCredit, addReferralCredit, addRegistration, cancelRegistration, logLateFeeEvent, getPackageById, countPackageSessionsUsed, setPackageSessions } from "@/lib/supabase";
import { isLateAction, resolveOffSessionPaymentSource, chargeSavedCardOffSession, issueStripeRefund } from "@/lib/booking-finalize";
import { calcServiceFee, serviceFeeLabel, fmtMoney, calcPrivatePrice, fullPriceForType, getTrainerTier, normalizeTrainerTier } from "@/lib/pricing";
import { notifyTrainerOfCancellation, notifyTrainerOfReschedule, notifyTrainerOfNewBooking } from "@/lib/trainer-notify";


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

function isPrivateType(type: string): boolean {
  return type === "private" || type === "group-private";
}

// The DB always stores the FULL (undiscounted) session_price for private
// sessions — the referral-credit / first-time 50% off is applied at display
// and billing time via is_free, never baked into the stored price. Mirrors
// resolvedSessionPrice() in booking/[token]/route.ts and effectivePrice() in
// the admin dashboard.
function effectiveAmount(fullPrice: number, isFree: boolean, isPriv: boolean): number {
  return isFree && isPriv ? Math.round(fullPrice * 0.5 * 100) / 100 : fullPrice;
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

  // Claim the row BEFORE charging anything — two near-simultaneous reschedule
  // requests for the same booking (double-click, retry) would otherwise both
  // pass the check above, both charge a real off-session card payment below,
  // and only one would win the final write. Claiming first means the loser
  // of the race is rejected here, before any charge happens, instead of
  // relying on a best-effort refund afterward.
  const claimToken = crypto.randomUUID();
  const { data: claimedRows } = await supabase
    .from("registrations")
    .update({ admin_action_claim_token: claimToken })
    .eq("id", id)
    .eq("status", "confirmed")
    .is("admin_action_claim_token", null)
    .select("id");
  if (!claimedRows || claimedRows.length === 0) {
    return NextResponse.json({ error: "This booking is already being rescheduled by another request." }, { status: 409 });
  }
  // Best-effort release for every abort path below that returns before the
  // final update (which clears the claim itself on success) — otherwise an
  // aborted attempt (needs-fee-choice, no card on file, decline) would leave
  // this row permanently unable to be rescheduled again.
  async function releaseClaim() {
    await supabase
      .from("registrations")
      .update({ admin_action_claim_token: null })
      .eq("id", id)
      .eq("admin_action_claim_token", claimToken);
  }

  // Same lateness rule a client-initiated reschedule uses, checked against
  // the OLD (current) session time before it moves. Gate on the choice
  // before any mutation happens, so a retry after the admin picks is clean.
  const isLateReschedule = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at));
  if (isLateReschedule && !feeChoice) {
    await releaseClaim();
    return NextResponse.json(
      { error: "The current session is within the 24-hour window — choose how to handle the fee.", needsFeeChoice: true, isLateReschedule: true },
      { status: 400 }
    );
  }
  const chargeLateFee = isLateReschedule && feeChoice === "charge";

  // Whether the OLD session was part of a bulk/volume-discounted weekly
  // booking (the 10%/15% off for booking several sessions at once) — the
  // full-forfeiture late-reschedule policy only applies to those, not a
  // plain 1-3 session weekly booking at the regular rate (which keeps the
  // old 50% late-fee policy). Same live-rate comparison the client-facing
  // endpoint uses.
  let isBulkDiscountedWeekly = false;
  if (reg.type === "weekly" && reg.session_price !== null && reg.booked_date && reg.booked_start_time) {
    try {
      const oldSessions = await getWeeklySchedule({ noCache: true });
      const oldGroupLabel = reg.booked_group || reg.session_details.split(" — ")[0] || "";
      const oldMatch = oldSessions.find((s) => s.group === oldGroupLabel && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
      if (oldMatch) {
        const oldStandardRate = oldMatch.price * (reg.total_participants || 1);
        isBulkDiscountedWeekly = reg.session_price < oldStandardRate;
      }
    } catch {
      // Sheet lookup failed — default to not-discounted rather than guessing.
    }
  }

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
    newFullPrice = calcPrivatePrice(durationMins, reg.total_participants || 1, getTrainerTier(resolvedTrainer));
  } else if (effectiveType === "weekly") {
    try {
      const sessions = await getWeeklySchedule({ noCache: true });
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
  const oldFullPrice = reg.session_price ?? fullPriceForType(reg.type, getTrainerTier(reg.booked_trainer));
  const oldAmount = Math.max(0, effectiveAmount(oldFullPrice, !!reg.is_free, wasPrivate) - appliedCredit);
  const newAmount = newFullPrice !== undefined ? Math.max(0, effectiveAmount(newFullPrice, newIsFree, isNewPrivate) - appliedCredit) : oldAmount;
  const priceDelta = newFullPrice !== undefined ? newAmount - oldAmount : 0;

  const wasPaid = !!reg.is_paid || !!reg.stripe_payment_intent_id;

  // A package-covered session has no direct per-session Stripe payment on
  // this row (wasPaid is always false for it — it was covered by the
  // package's lump-sum charge instead), so every wasPaid-gated branch below
  // silently no-ops for it. A late reschedule the admin chooses to CHARGE no
  // longer triggers a fresh 50% fee — per current policy, the OLD session is
  // simply forfeited from the package (the same "lose a whole session"
  // policy as the client-facing flow), and whether the NEW session is still
  // covered depends on whether the package has any capacity left AFTER that
  // forfeiture. This route mutates the same row in place rather than
  // cancelling+recreating it (unlike the client-facing flow), so there's no
  // natural second row to mark "forfeited" — instead, a purely internal
  // bookkeeping row is inserted and immediately cancelled as late, which
  // makes it count as "used" via the exact same countPackageSessionsUsed
  // mechanism every other cancellation in this codebase relies on. It's
  // never surfaced to the client (no manage_token exposed, no notification
  // sent for it) — the client only ever sees the ONE row that's actually
  // being rescheduled below.
  let sameMonthCovered = false;
  let clearPackageId = false;
  if (reg.package_id) {
    if (chargeLateFee) {
      try {
        const { manageToken: forfeitToken } = await addRegistration({
          parentName: reg.parent_name,
          email: reg.email,
          phone: reg.phone,
          kids: reg.kids,
          type: reg.type,
          sessionDetails: oldSessionDetails,
          totalParticipants: reg.total_participants || 1,
          bookedDate: oldBookedDate || undefined,
          bookedStartTime: oldBookedStartTime || undefined,
          bookedEndTime: reg.booked_end_time || undefined,
          bookedLocation: reg.booked_location || undefined,
          bookedTrainer: reg.booked_trainer || undefined,
          packageId: reg.package_id,
        });
        await cancelRegistration(forfeitToken, true);
      } catch (err) {
        console.error("Failed to record package session forfeiture (admin reschedule):", err);
      }
    }
    // Packages only ever cover a standard private session (up to 3 kids) —
    // never a 4+ kid group-private rate, regardless of remaining capacity.
    // Also requires the NEW trainer to match the package's own tier — an
    // admin reschedule can move the session to a different trainer, and
    // without this check a package bought for one tier could end up
    // covering the other tier's (possibly pricier) trainer for free.
    const oldPkg = await getPackageById(reg.package_id).catch(() => null);
    if (oldPkg && effectiveType === "private" && (reg.total_participants || 1) <= 3 && getTrainerTier(resolvedTrainer) === normalizeTrainerTier(oldPkg.trainer_tier)) {
      const d = new Date(bookedDate);
      if (!isNaN(d.getTime())) {
        const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (newMonth === oldPkg.month_year) {
          // Re-checked live (not oldPkg's own possibly-stale sessions_used)
          // — the forfeiture bookkeeping row above, if this was late, has
          // already landed, so this reflects the true remaining capacity.
          const usedSoFar = await countPackageSessionsUsed(oldPkg.id).catch(() => oldPkg.package_type);
          sameMonthCovered = usedSoFar < oldPkg.package_type;
        }
      }
    }
    clearPackageId = !sameMonthCovered;
  }
  const packageSessionForfeited = !!(reg.package_id && chargeLateFee);
  // Nothing was ever paid directly for this specific session while it was
  // package-covered, so if it's leaving the package, the FULL new price is
  // owed — not a delta off of some prior payment that never actually happened.
  const packageMoveOutCharge = clearPackageId && newFullPrice !== undefined
    ? Math.max(0, effectiveAmount(newFullPrice, newIsFree, isNewPrivate))
    : 0;

  // Nothing gets confirmed with money still owed — every dollar the client
  // ends up owing after this reschedule is auto-charged to the card on file
  // before anything changes, whether that's an on-time price increase (the
  // whole delta) or a late reschedule's remainder after the 50% fee credit
  // is applied. The admin is right here to see success or failure
  // immediately, unlike every other flow in this codebase that deliberately
  // avoids off-session charging. If there's no saved card, or the charge
  // fails (declined, expired, etc.), the whole reschedule is aborted before
  // anything changes — the original session stays booked exactly as it
  // was, and it's on the admin to have the client sort out their card.
  // resolveOffSessionPaymentSource already falls back to the PACKAGE's own
  // saved card when the row itself has no direct payment on file, so the
  // packageMoveOutCharge piece below can charge through the exact same
  // mechanism with no separate code path needed.
  const fullForfeitNoRefund = isBulkDiscountedWeekly && chargeLateFee;
  let lateFeeCredited = 0;
  let lateFeeCreditApplied = 0;
  let amountToCharge = 0;
  if (wasPaid && chargeLateFee) {
    // Weekly group sessions: late reschedule is full forfeiture — nothing
    // credited toward the new session, which is charged in full below.
    // Every other paid session type keeps the original 50%-credited policy.
    lateFeeCredited = fullForfeitNoRefund ? 0 : Math.round(oldAmount * 0.5 * 100) / 100;
    lateFeeCreditApplied = Math.min(lateFeeCredited, newAmount);
    amountToCharge = Math.max(0, Math.round((newAmount - lateFeeCreditApplied) * 100) / 100);
  } else if (wasPaid && priceDelta > 0) {
    amountToCharge = priceDelta;
  }
  amountToCharge = Math.round((amountToCharge + packageMoveOutCharge) * 100) / 100;

  let autoChargedAmount = 0;
  let autoChargePaymentIntentId: string | undefined;
  if (amountToCharge > 0.005) {
    const source = await resolveOffSessionPaymentSource(reg);
    if (!source) {
      await releaseClaim();
      return NextResponse.json(
        { error: `No saved card found for ${reg.parent_name} to auto-charge the $${amountToCharge} owed — the reschedule was NOT applied. Have them update their payment method first${chargeLateFee ? ', or choose "waive" instead' : ""}.` },
        { status: 402 }
      );
    }
    const plainSessionDetails = newSessionDetails.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
    const chargeResult = await chargeSavedCardOffSession({
      customerId: source.customerId,
      paymentMethodId: source.paymentMethodId,
      amountDollars: Math.round((amountToCharge + calcServiceFee(amountToCharge)) * 100) / 100,
      description: `Reschedule${chargeLateFee ? " (late fee remainder)" : ""}: ${plainSessionDetails || "Mesa Basketball Training Session"}`,
    });
    if (!chargeResult.success) {
      await releaseClaim();
      return NextResponse.json(
        { error: `Couldn't automatically charge the $${amountToCharge} owed (+ ${serviceFeeLabel(amountToCharge)} fee) — ${chargeResult.reason} The reschedule was NOT applied; the original session is unchanged.` },
        { status: 402 }
      );
    }
    autoChargedAmount = amountToCharge;
    autoChargePaymentIntentId = chargeResult.paymentIntentId;
  }

  // Guarded on status still being "confirmed" as defense-in-depth against a
  // concurrent CANCEL of this same row (a concurrent reschedule can no
  // longer race here — the claim step above already rejects that). If the
  // row's status changed out from under us, the charge that already went
  // through needs to come straight back rather than leaving the client
  // charged for a change that was never actually applied.
  const { data: updatedRows, error } = await supabase
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
      admin_action_claim_token: null,
      ...(newFullPrice !== undefined ? { session_price: newFullPrice } : {}),
      ...(clearPackageId ? { package_id: null } : {}),
    })
    .eq("id", id)
    .eq("status", "confirmed")
    .select("id");

  if (!error && (!updatedRows || updatedRows.length === 0)) {
    let refundNote = "";
    if (autoChargedAmount > 0 && autoChargePaymentIntentId) {
      const refundResult = await issueStripeRefund({
        email: reg.email,
        paymentIntentId: autoChargePaymentIntentId,
        amountDollars: Math.round((autoChargedAmount + calcServiceFee(autoChargedAmount)) * 100) / 100,
        sessionLabel: reg.session_details || "",
      }).catch((err) => {
        console.error("Failed to refund admin reschedule charge after lost race:", err);
        return null;
      });
      refundNote = refundResult && !refundResult.failed
        ? " Any charge was refunded."
        : " The charge could NOT be automatically refunded — check Stripe and refund manually.";
    }
    return NextResponse.json({ error: `This booking was already changed by another request — nothing was applied.${refundNote}` }, { status: 409 });
  }

  if (error) {
    // The charge above already succeeded, but the write that was supposed to
    // apply it failed outright (network blip, constraint violation) — same
    // reasoning as the lost-race case just above: refund rather than leave
    // the client charged for a reschedule that never actually took effect.
    let refundNote = "";
    if (autoChargedAmount > 0 && autoChargePaymentIntentId) {
      const refundResult = await issueStripeRefund({
        email: reg.email,
        paymentIntentId: autoChargePaymentIntentId,
        amountDollars: Math.round((autoChargedAmount + calcServiceFee(autoChargedAmount)) * 100) / 100,
        sessionLabel: reg.session_details || "",
      }).catch((err) => {
        console.error("Failed to refund admin reschedule charge after DB update error:", err);
        return null;
      });
      refundNote = refundResult && !refundResult.failed
        ? " Any charge was refunded."
        : " The charge could NOT be automatically refunded — check Stripe and refund manually.";
    }
    await releaseClaim();
    return NextResponse.json({ error: `${error.message}${refundNote}` }, { status: 500 });
  }

  // The session just left package coverage (moved to a different month, or
  // converted away from a package-eligible private session) — free its slot
  // back on the OLD package, same recompute used everywhere else a
  // package-covered session stops counting against it.
  if (clearPackageId && reg.package_id) {
    try {
      const used = await countPackageSessionsUsed(reg.package_id);
      await setPackageSessions(reg.package_id, used);
    } catch {
      // non-critical — don't fail the reschedule
    }
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
  // A price DECREASE always credits the difference to their account for
  // their next booking (same rule already used for partial camp-day
  // cancellations elsewhere) — always account credit here, never a real
  // Stripe refund, since this is a business-initiated change, not a client
  // cancellation. A price INCREASE (on-time or the late-fee remainder) was
  // already auto-charged above, or the whole reschedule was blocked — so
  // there's never anything left owed by the time this runs. This block only
  // needs to actually grant/apply the 50% late-fee credit now that the
  // reschedule (and any required charge) has succeeded.
  let creditGranted = 0;
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
    await logLateFeeEvent({
      registrationId: id,
      parentName: reg.parent_name,
      email: reg.email,
      kids: reg.kids,
      sessionType: reg.type,
      sessionDetails: oldSessionDetails,
      bookedDate: oldBookedDate,
      bookedStartTime: oldBookedStartTime,
      action: "reschedule",
      initiatedBy: "admin",
      amountKept: Math.round((oldAmount - lateFeeCredited) * 100) / 100,
      amountCredited: lateFeeCredited,
      amountApplied: lateFeeCreditApplied,
      amountChargedExtra: autoChargedAmount > 0 ? Math.round((autoChargedAmount + calcServiceFee(autoChargedAmount)) * 100) / 100 : 0,
      newSessionDetails,
    });
  } else if (wasPaid && priceDelta < 0) {
    try {
      await addAccountCredit(reg.email, -priceDelta);
      creditGranted = -priceDelta;
    } catch (err) {
      console.error("Failed to grant account credit (admin reschedule):", err);
    }
  } else if (packageSessionForfeited) {
    // Package forfeiture — no fee, no prior direct payment on this session
    // to credit against (it was covered by the package's lump sum), so this
    // doesn't fit the wasPaid branch above. If the package still had
    // capacity, nothing further is owed; if not, the new session was charged
    // in full (packageMoveOutCharge, folded into amountToCharge) and already
    // went through synchronously above, so the confirmed amount is known
    // immediately — logged directly rather than deferred to a webhook.
    await logLateFeeEvent({
      registrationId: id,
      parentName: reg.parent_name,
      email: reg.email,
      kids: reg.kids,
      sessionType: reg.type,
      sessionDetails: oldSessionDetails,
      bookedDate: oldBookedDate,
      bookedStartTime: oldBookedStartTime,
      action: "reschedule",
      initiatedBy: "admin",
      amountChargedExtra: autoChargedAmount > 0 ? Math.round((autoChargedAmount + calcServiceFee(autoChargedAmount)) * 100) / 100 : 0,
      newSessionDetails,
    });
  }

  // Sync calendar. Private sessions are a single event tied to the booking;
  // group/camp sessions are shared events keyed by date+time+label, so we
  // recompute the old slot (this registrant leaving) and the new slot (this
  // registrant arriving) from what's now in the DB. The old and new sides are
  // handled independently since a type conversion (e.g. group -> private)
  // means one side is a shared group event and the other is a standalone one.
  try {
    if (wasPrivate) {
      if (oldBookedDate && oldBookedStartTime) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: oldBookedDate, bookedStartTime: oldBookedStartTime });
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
  // no fee. Late + charged for a package or weekly session: full forfeiture,
  // no fee (package: the old session is simply lost; weekly: nothing
  // refunded), so the note explains that instead of a 50% credit. Every
  // other late + charged session keeps the original 50% fee-credit wording.
  // The price note is appended directly (not part of the shared template)
  // since only this admin flow needs to say "no change" vs "credited" vs "due".
  const priceNote = reg.package_id
    ? packageSessionForfeited
      ? (clearPackageId
          ? (packageMoveOutCharge > 0
              ? `\nYour original session was forfeited from your package (late reschedule policy), and it no longer has capacity to cover the new date — priced as a regular session: $${fmtMoney(packageMoveOutCharge + calcServiceFee(packageMoveOutCharge))} charged to your card on file.`
              : "\nYour original session was forfeited from your package (late reschedule policy), and it no longer has capacity to cover the new date.")
          : "\nYour original session was forfeited from your package (late reschedule policy), but your new session is still covered — nothing further due.")
      : [
          clearPackageId
            ? packageMoveOutCharge > 0
              ? `\nThis date falls outside your package month, so it's priced as a regular session: $${fmtMoney(packageMoveOutCharge + calcServiceFee(packageMoveOutCharge))} charged to your card on file.`
              : "\nThis date falls outside your package month, so it's no longer covered by it."
            : "\nStill covered by your monthly package — nothing further due for this session.",
        ].filter(Boolean).join("")
    : fullForfeitNoRefund
      ? `\nYour original session was fully forfeited (non-refundable) — the new session is charged at full price.${autoChargedAmount > 0 ? ` $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} was charged to your card on file.` : ""}`
      : chargeLateFee
        ? `\nLate reschedule fee: $${fmtMoney(lateFeeCredited)} (50% of what you paid) credited to your account${lateFeeCreditApplied > 0 ? `, $${fmtMoney(lateFeeCreditApplied)} applied to your new session` : ""}.${autoChargedAmount > 0 ? ` $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} was charged to your card on file to cover the rest.` : ""}`
        : newFullPrice === undefined
          ? ""
          : creditGranted > 0
            ? `\n$${fmtMoney(oldAmount)} → $${fmtMoney(newAmount)}. $${fmtMoney(creditGranted)} credited to your account for your next booking.`
            : autoChargedAmount > 0
              ? `\n$${fmtMoney(oldAmount)} → $${fmtMoney(newAmount)}. $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} was charged to your card on file.`
              : priceDelta !== 0
                ? `\n$${fmtMoney(oldAmount)} → $${fmtMoney(newAmount)}.`
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
      packageSessionForfeited,
      newSessionPackageCovered: packageSessionForfeited ? !clearPackageId : undefined,
      fullForfeitNoRefund,
    });
    if (reg.sms_consent && reg.phone) {
      await sendSMS(
        reg.phone,
        `Mesa Basketball: Your session has been rescheduled by your trainer.\n${fromLine ? `${fromLine}\n` : ""}${toLine}\nAthlete: ${reg.kids}${priceNote}${creditRefundNote}\nManage: mesabasketballtraining.com/booking/${reg.manage_token}\nReply STOP to opt out.`
      );
    }
    const adminPriceNote = reg.package_id
      ? packageSessionForfeited
        ? (clearPackageId
            ? (packageMoveOutCharge > 0
                ? `\nPackage session forfeited (late reschedule) — capacity exhausted, $${fmtMoney(packageMoveOutCharge + calcServiceFee(packageMoveOutCharge))} auto-charged to their card on file (${autoChargePaymentIntentId}).`
                : "\nPackage session forfeited (late reschedule) — capacity exhausted, no charge captured.")
            : "\nPackage session forfeited (late reschedule) — new session still covered, no charge.")
        : [
            clearPackageId
              ? packageMoveOutCharge > 0
                ? `\nOutside package month — $${fmtMoney(packageMoveOutCharge + calcServiceFee(packageMoveOutCharge))} auto-charged to their card on file (${autoChargePaymentIntentId}), package slot freed.`
                : "\nOutside package month — package slot freed, no charge."
              : "\nStill within package month — no charge.",
          ].filter(Boolean).join("")
      : fullForfeitNoRefund
        ? `\nWeekly late reschedule — old session fully forfeited, no refund.${autoChargedAmount > 0 ? ` $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} auto-charged to their card on file (${autoChargePaymentIntentId}) for the new session at full price.` : ""}`
        : chargeLateFee
          ? `\nLate fee charged: $${fmtMoney(lateFeeCredited)} credited (50% of $${fmtMoney(oldAmount)} paid)${lateFeeCreditApplied > 0 ? `, $${fmtMoney(lateFeeCreditApplied)} applied to new session ($${fmtMoney(newAmount)})` : ""}.${autoChargedAmount > 0 ? ` $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} auto-charged to their card on file (${autoChargePaymentIntentId}).` : ""}`
          : newFullPrice === undefined
            ? ""
            : creditGranted > 0
              ? `\n$${fmtMoney(oldAmount)} -> $${fmtMoney(newAmount)}: $${fmtMoney(creditGranted)} credited to their account (already paid)`
              : autoChargedAmount > 0
                ? `\n$${fmtMoney(oldAmount)} -> $${fmtMoney(newAmount)}: $${fmtMoney(autoChargedAmount + calcServiceFee(autoChargedAmount))} auto-charged to their card on file (${autoChargePaymentIntentId}).`
                : priceDelta !== 0
                  ? `\nPrice: $${fmtMoney(oldAmount)} -> $${fmtMoney(newAmount)}`
                  : "";
    const adminCreditRefundNote = creditRefunded ? "\nReferral credit refunded (no longer applied)." : "";
    const priceLookupFailedNote = priceLookupFailed ? `\n⚠️ Couldn't verify the new price on the schedule sheet — price left at $${fmtMoney(reg.session_price ?? 0)}, double-check it manually.` : "";
    await sendAdminSMS(`ADMIN RESCHEDULED: ${reg.parent_name}\nFrom: ${oldSessionDetails}\nTo: ${newSessionDetails}\nPlayers: ${reg.kids}${adminPriceNote}${adminCreditRefundNote}${priceLookupFailedNote}`);
  } catch (err) {
    console.error("Notification error (admin reschedule):", err);
  }

  // Independent of the client/admin notification block above — a Resend
  // hiccup on the client email must not also silently skip telling the
  // trainer(s) about the change (this used to sit inside that same
  // try/catch, so an early throw there swallowed it with no distinguishing
  // log). Same trainer-swap-vs-plain-reschedule distinction as the
  // client-facing reschedule endpoint — see the comment there.
  if (bookedDate && bookedStartTime) {
    const oldTrainer = reg.booked_trainer;
    const newTrainer = resolvedTrainer;
    const slotActuallyMoved = oldBookedDate !== bookedDate || oldBookedStartTime !== bookedStartTime || (reg.booked_end_time || oldBookedStartTime) !== (bookedEndTime || bookedStartTime) || (reg.booked_location || "") !== (bookedLocation || "");
    if (oldTrainer && newTrainer && oldTrainer === newTrainer && oldBookedDate && oldBookedStartTime && slotActuallyMoved) {
      await notifyTrainerOfReschedule({
        trainer: newTrainer,
        parentName: reg.parent_name,
        sessionLabel: newSessionLabel || prefix,
        oldDate: oldBookedDate,
        oldStartTime: oldBookedStartTime,
        oldEndTime: reg.booked_end_time || oldBookedStartTime,
        newDate: bookedDate,
        newStartTime: bookedStartTime,
        newEndTime: bookedEndTime || bookedStartTime,
        location: bookedLocation || "",
      }).catch((notifyErr) => console.error("Trainer reschedule notify failed:", notifyErr));
    } else {
      if (oldTrainer && oldTrainer !== newTrainer && oldBookedDate && oldBookedStartTime) {
        await notifyTrainerOfCancellation({
          trainer: oldTrainer,
          parentName: reg.parent_name,
          sessionLabel: oldSessionLabel || derivedPrefix,
          date: oldBookedDate,
          startTime: oldBookedStartTime,
          endTime: reg.booked_end_time || oldBookedStartTime,
          location: reg.booked_location || "",
        }).catch((notifyErr) => console.error("Trainer reschedule-cancel notify failed:", notifyErr));
      }
      if (newTrainer && newTrainer !== oldTrainer) {
        await notifyTrainerOfNewBooking({
          trainer: newTrainer,
          parentName: reg.parent_name,
          kids: reg.kids,
          sessionLabel: newSessionLabel || prefix,
          date: bookedDate,
          startTime: bookedStartTime,
          endTime: bookedEndTime || bookedStartTime,
          location: bookedLocation || "",
        }).catch((notifyErr) => console.error("Trainer reschedule-newbooking notify failed:", notifyErr));
      }
    }
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
    creditRefunded,
    newIsFree,
    newUsedReferralCredit,
    priceLookupFailed,
    isLateReschedule,
    lateFeeCharged: chargeLateFee,
    lateFeeCredited: chargeLateFee ? lateFeeCredited : undefined,
    lateFeeCreditApplied: chargeLateFee ? lateFeeCreditApplied : undefined,
    autoChargedAmount: autoChargedAmount > 0 ? autoChargedAmount : undefined,
    packageSessionForfeited,
    newSessionPackageCovered: packageSessionForfeited ? !clearPackageId : undefined,
    fullForfeitNoRefund,
  });
}
