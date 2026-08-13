import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth";
import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule, getPrivateSlots, type WeeklySession } from "@/lib/sheets";
import { deletePrivateSessionFromCalendar } from "@/lib/calendar";
import { buildWeeklyPlan, claimWeeklyTimeChange, findWeeklyTrainerReassignments, claimWeeklyTrainerReassignment, regGroupKey, type WeeklyRegKeyFields } from "@/lib/weekly-schedule-matching";
import { sendTimeChangeNotification, sendCancellationNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { addAccountCredit, addReferralCredit, countPackageSessionsUsed, setPackageSessions, getPackageById } from "@/lib/supabase";
import { issueStripeRefund, resolvedSessionPrice, type StripeRefundResult } from "@/lib/booking-finalize";
import { fmtMoney } from "@/lib/pricing";
import { notifyTrainerOfCancellation, notifyTrainerOfNewBooking } from "@/lib/trainer-notify";
import { getTrainerTier, normalizeTrainerTier, packageCoversTrainerTier } from "@/lib/trainers";

// A session the trainer removed from the schedule is never the client's
// fault — this is always treated as an on-time cancellation (full refund,
// never a late fee), unlike every client-initiated cancel path. Mirrors the
// on-time-cancel branch in booking/[token]/route.ts's DELETE handler.
async function refundTrainerCancelledBooking(r: {
  id: string;
  email: string;
  manage_token: string;
  session_details: string | null;
  used_referral_credit: boolean | null;
  applied_account_credit: number | null;
  is_paid: boolean | null;
  stripe_payment_intent_id: string | null;
  package_id: string | null;
  session_price: number | null;
  is_free: boolean | null;
  type: string;
  booked_trainer?: string | null;
}): Promise<{ stripeRefundResult?: StripeRefundResult; cancelCredit?: number }> {
  if (r.used_referral_credit && r.email) {
    await addReferralCredit(r.email).catch(() => {});
  }
  if (r.applied_account_credit && r.email) {
    await addAccountCredit(r.email, r.applied_account_credit).catch(() => {});
  }
  let stripeRefundResult: StripeRefundResult | undefined;
  let cancelCredit: number | undefined;
  const wasPaid = !!r.is_paid || !!r.stripe_payment_intent_id;
  if (wasPaid && r.email) {
    const paidAmount = Math.max(0, resolvedSessionPrice({ session_price: r.session_price, is_free: !!r.is_free, used_referral_credit: r.used_referral_credit, type: r.type, booked_trainer: r.booked_trainer }) - (r.applied_account_credit || 0));
    if (paidAmount > 0) {
      if (r.stripe_payment_intent_id) {
        stripeRefundResult = await issueStripeRefund({
          email: r.email,
          manageToken: r.manage_token,
          paymentIntentId: r.stripe_payment_intent_id,
          amountDollars: paidAmount,
          sessionLabel: r.session_details || "",
        }).catch((err) => {
          console.error("Trainer-deletion refund failed for", r.email, err);
          return { refundedAmount: 0, creditedAmount: 0, failed: true };
        });
      } else {
        await addAccountCredit(r.email, paidAmount).catch(() => {});
        cancelCredit = paidAmount;
      }
    }
  }
  if (r.package_id) {
    try {
      const used = await countPackageSessionsUsed(r.package_id);
      await setPackageSessions(r.package_id, used);
    } catch (err) {
      console.error("Package usage recompute failed (trainer-deleted session):", err);
    }
  }
  return { stripeRefundResult, cancelCredit };
}

// SMS suffix describing what happened to the client's money, so a
// trainer-deleted-session cancellation SMS never goes out silent about a
// refund/credit that Stripe or the account balance already reflects.
function refundSmsLine(result: { stripeRefundResult?: StripeRefundResult; cancelCredit?: number }): string {
  if (result.stripeRefundResult) {
    const { refundedAmount, creditedAmount, failed } = result.stripeRefundResult;
    if (failed) return "\nYour refund is being processed — you'll receive a separate confirmation once it's complete.";
    const parts: string[] = [];
    if (refundedAmount > 0) parts.push(`$${fmtMoney(refundedAmount)} refunded to your card`);
    if (creditedAmount > 0) parts.push(`$${fmtMoney(creditedAmount)} credited to your account`);
    return parts.length > 0 ? `\n${parts.join(", ")}.` : "";
  }
  if (result.cancelCredit && result.cancelCredit > 0) {
    return `\n$${fmtMoney(result.cancelCredit)} credited to your account.`;
  }
  return "";
}

function parseTimeMins(t: string): number | null {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

// Merges consecutive (touching) intervals and reports whether the resulting
// union fully covers [rangeStart, rangeEnd) — shared by
// privateBookingStillOnSheet (does this exact range exist at all, across
// any trainer) and findPrivateTrainerReassignments (does THIS SPECIFIC
// trainer's own slots cover it) below.
function intervalsCoverRange(intervals: { start: number; end: number }[], rangeStart: number, rangeEnd: number): boolean {
  if (intervals.length === 0) return false;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let windowStart = sorted[0].start;
  let windowEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start === windowEnd) {
      windowEnd = sorted[i].end;
    } else {
      if (rangeStart >= windowStart && rangeEnd <= windowEnd) return true;
      windowStart = sorted[i].start;
      windowEnd = sorted[i].end;
    }
  }
  return rangeStart >= windowStart && rangeEnd <= windowEnd;
}

// A private booking's start/end time is NOT guaranteed to match any single
// raw sheet row — the booking page merges consecutive same-day/location/
// trainer rows into one bigger window (see buildTimeWindows in
// schedule/page.tsx) and lets the client pick any 15-minute-aligned start
// inside it. So "1:30-2:30 PM" is a perfectly normal booking spanning two
// raw 1-hour rows (1:00-2:00, 2:00-3:00) and will NEVER exact-match either
// row's startTime. Deletion detection has to check whether the booked
// interval is covered by the union of still-present sheet rows for that
// date/trainer, not whether one exact row still exists — otherwise every
// booking that doesn't happen to start on a raw row boundary looks
// "deleted" from the moment it's booked, on the very next sheet edit.
//
// Deliberately checks windows at ANY location for the date/trainer, not
// just the registration's stored booked_location — a session that moved
// location (without the registration's booked_location being resynced;
// that drift is only patched display-side, by getCurrentSheetLocation)
// must not look like a deletion.
// Deliberately trainer-agnostic — this only asks "does this exact date/time
// (at some location) still exist on the sheet at all," never "does MY
// trainer still cover it." It used to filter candidate slots down to the
// registration's OWN stored trainer first, which made a coach reassignment
// on an already-booked private slot (same date/time/location, just a
// different trainer covering — see findPrivateTrainerReassignments, which
// detects exactly that and reconciles booked_trainer separately) look
// identical to the whole session being deleted from the sheet: the old
// trainer's name no longer matched any row, this returned false, and the
// deletion-detection loop below auto-cancelled a real booking and issued a
// real Stripe refund for a session the client still actually had.
function privateBookingStillOnSheet(
  reg: { booked_date: string | null; booked_start_time: string | null; booked_end_time: string | null },
  slots: { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
): boolean {
  const regStart = parseTimeMins(reg.booked_start_time || "");
  const regEnd = parseTimeMins(reg.booked_end_time || "");
  if (regStart === null || regEnd === null) return true; // can't evaluate — don't risk a false cancel

  const byLocation: Record<string, { start: number; end: number }[]> = {};
  slots
    .filter((s) => s.date === reg.booked_date)
    .forEach((s) => {
      const start = parseTimeMins(s.startTime);
      const end = parseTimeMins(s.endTime);
      if (start === null || end === null) return;
      if (!byLocation[s.location]) byLocation[s.location] = [];
      byLocation[s.location].push({ start, end });
    });

  return Object.values(byLocation).some((rows) => intervalsCoverRange(rows, regStart, regEnd));
}

// Private-session counterpart to findWeeklyTrainerReassignments — detects
// confirmed private/group-private registrations whose stored booked_trainer
// no longer matches whichever trainer's sheet slots actually cover that
// EXACT date/time/location. Quiet, internal-only reconciliation (like the
// weekly version): no client notification, but the assigned trainer(s) do
// still get notified — see the call site below.
function findPrivateTrainerReassignments<
  T extends { id: string; booked_date: string | null; booked_start_time: string | null; booked_end_time: string | null; booked_location: string | null; booked_trainer: string | null }
>(
  regs: T[],
  slots: { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
): { reg: T; newTrainer: string }[] {
  const result: { reg: T; newTrainer: string }[] = [];
  for (const r of regs) {
    const regStart = parseTimeMins(r.booked_start_time || "");
    const regEnd = parseTimeMins(r.booked_end_time || "");
    if (regStart === null || regEnd === null) continue;

    const sameDayLocation = slots.filter((s) => s.date === r.booked_date && s.location === (r.booked_location || ""));
    const trainersHere = [...new Set(sameDayLocation.map((s) => s.trainer))];
    const covered: { start: number; end: number }[] = sameDayLocation
      .map((s) => ({ start: parseTimeMins(s.startTime), end: parseTimeMins(s.endTime) }))
      .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null);
    // Only act when the registration's exact range still genuinely exists
    // somewhere on the sheet — if it doesn't, that's a real deletion,
    // handled entirely separately below, not a trainer swap.
    if (!intervalsCoverRange(covered, regStart, regEnd)) continue;

    const currentTrainer = r.booked_trainer || "Artemios Gavalas";
    const coveringTrainer = trainersHere.find((t) => {
      const trainerIntervals = sameDayLocation
        .filter((s) => s.trainer === t)
        .map((s) => ({ start: parseTimeMins(s.startTime), end: parseTimeMins(s.endTime) }))
        .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null);
      return intervalsCoverRange(trainerIntervals, regStart, regEnd);
    });
    if (coveringTrainer && coveringTrainer !== currentTrainer) {
      result.push({ reg: r, newTrainer: coveringTrainer });
    }
  }
  return result;
}

interface WeeklyRegLike extends WeeklyRegKeyFields {
  parent_name: string;
  email: string;
  kids: string;
  phone: string;
  sms_consent: boolean | null;
  type: string;
  manage_token: string;
  used_referral_credit: boolean | null;
  applied_account_credit: number | null;
  is_paid: boolean | null;
  stripe_payment_intent_id: string | null;
  package_id: string | null;
  session_price: number | null;
  is_free: boolean | null;
  booked_trainer: string | null;
}

function sessionIsUpcoming(dateStr: string, startTimeStr: string): boolean {
  try {
    const now = new Date();
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const getP = (t: string) => etParts.find((p) => p.type === t)?.value ?? "0";
    const todayISO = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const nowMinutes = parseInt(getP("hour")) * 60 + parseInt(getP("minute"));

    const sd = new Date(dateStr);
    if (isNaN(sd.getTime())) return true;
    const sessionISO = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, "0")}-${String(sd.getDate()).padStart(2, "0")}`;

    if (sessionISO > todayISO) return true;
    if (sessionISO < todayISO) return false;

    const match = startTimeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return true;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + m > nowMinutes;
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let sessions;
  try {
    sessions = await getWeeklySchedule({ noCache: true });
  } catch (err) {
    console.error("detect-time-changes: failed to fetch schedule", err);
    return NextResponse.json({ error: "Failed to fetch schedule" }, { status: 500 });
  }

  const upcoming = sessions.filter(
    (s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group
  );

  const changesDetected: string[] = [];
  let totalRegistrantsNotified = 0;
  let totalEmailsSent = 0;
  let totalSmsSent = 0;

  // A single sheet read is never trusted as proof of deletion — a transient
  // formula-recalculation glitch or a torn read caught mid-edit elsewhere in
  // the sheet could otherwise make a real, still-scheduled session look
  // "gone" and trigger an irreversible cancel + Stripe refund. Re-fetch
  // independently and only cancel a registration if BOTH reads' plans agree
  // it was deleted; if the confirmation fetch itself fails, confirm nothing
  // this run rather than act on a single read.
  let upcomingConfirm: typeof upcoming | null = null;
  try {
    const confirmSessions = await getWeeklySchedule({ noCache: true });
    upcomingConfirm = confirmSessions.filter(
      (s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group
    );
  } catch (err) {
    console.error("detect-time-changes: confirmation re-fetch failed (weekly)", err);
  }

  const { data: allWeeklyRegsRaw } = await supabase
    .from("registrations")
    .select("*")
    .eq("type", "weekly")
    .eq("status", "confirmed");
  const weeklyRegsUpcoming = (allWeeklyRegsRaw || []).filter(
    (r) => r.booked_date && sessionIsUpcoming(r.booked_date, r.booked_start_time || "")
  );

  // === TIME / LOCATION CHANGE + DELETION DETECTION — WEEKLY SESSIONS ===
  const firstPlan = buildWeeklyPlan(upcoming, weeklyRegsUpcoming);
  const confirmPlan = upcomingConfirm === null ? null : buildWeeklyPlan(upcomingConfirm, weeklyRegsUpcoming);
  const confirmedDeletionIds = confirmPlan === null ? new Set<string>() : new Set(confirmPlan.deletions.map((r) => r.id));
  const weeklyDeletions = confirmPlan === null ? [] : firstPlan.deletions.filter((r) => confirmedDeletionIds.has(r.id));

  if (firstPlan.ambiguous.length > 0) {
    const summary = firstPlan.ambiguous
      .map((a) => `• ${a.date} "${a.group}" — ${a.regCount} booking${a.regCount !== 1 ? "s" : ""}`)
      .join("\n");
    await sendAdminSMS(
      `NEEDS MANUAL REVIEW:\nCan't tell which booking goes with which sheet row without guessing (same group name, multiple sessions changed on the same day at once):\n${summary}\nPlease check these manually — nothing was auto-cancelled or auto-rescheduled for them.`
    ).catch((err) => console.error("Ambiguous-weekly-change admin SMS failed:", err));
  }

  // Group the resolved (unambiguous) time/location moves back by target
  // session so the admin summary reads one line per session, not one per
  // registrant — mirrors how this worked before bucketing was introduced.
  const changesBySession = new Map<string, { session: WeeklySession; regs: WeeklyRegLike[] }>();
  for (const { reg, newSession } of firstPlan.changes) {
    const key = `${newSession.date}|${newSession.group}|${newSession.startTime}|${newSession.endTime}|${newSession.location}`;
    if (!changesBySession.has(key)) changesBySession.set(key, { session: newSession, regs: [] });
    changesBySession.get(key)!.regs.push(reg);
  }

  for (const { session, regs: stale } of changesBySession.values()) {
    const firstOldStart: string = stale[0].booked_start_time;
    const firstOldEnd: string = stale[0].booked_end_time || firstOldStart;
    const firstOldLocation: string = stale[0].booked_location || "";
    const timeChangedAny = stale.some((r) => r.booked_start_time !== session.startTime || r.booked_end_time !== session.endTime);
    const locationChangedAny = stale.some((r) => r.booked_location !== session.location);
    let changeDesc = `${session.date} "${session.group}"`;
    if (timeChangedAny) changeDesc += `: ${firstOldStart}-${firstOldEnd} → ${session.startTime}-${session.endTime}`;
    if (locationChangedAny) {
      const locChangeStr = `${resolveLocationName(firstOldLocation)} → ${resolveLocationName(session.location)}`;
      changeDesc += timeChangedAny ? `, location: ${locChangeStr}` : `: ${locChangeStr}`;
    }
    changesDetected.push(changeDesc);

    for (const r of stale) {
      const timeChanged = r.booked_start_time !== session.startTime || r.booked_end_time !== session.endTime;
      const locationChanged = r.booked_location !== session.location;
      const changeType: "time" | "location" | "both" =
        timeChanged && locationChanged ? "both" : timeChanged ? "time" : "location";

      const rOldStart: string = r.booked_start_time;
      const rOldEnd: string = r.booked_end_time || rOldStart;
      const rOldLocation: string = r.booked_location || "";

      let newDetails = r.session_details || "";
      if (timeChanged) {
        newDetails = newDetails
          .replace(`${rOldStart}-${rOldEnd}`, `${session.startTime}-${session.endTime}`)
          .replace(`${rOldStart}–${rOldEnd}`, `${session.startTime}–${session.endTime}`);
      }
      if (locationChanged && rOldLocation) {
        newDetails = newDetails.replace(`at ${rOldLocation}`, `at ${session.location}`);
      }

      const won = await claimWeeklyTimeChange(supabase, r, {
        booked_start_time: session.startTime,
        booked_end_time: session.endTime,
        ...(locationChanged ? { booked_location: session.location } : {}),
        session_details: newDetails,
      });
      if (!won) continue; // the admin-dashboard sync already caught and notified this one

      try {
        await sendTimeChangeNotification({
          parentName: r.parent_name,
          email: r.email,
          kids: r.kids,
          date: session.date,
          sessionLabel: session.group,
          oldStartTime: rOldStart,
          oldEndTime: rOldEnd,
          newStartTime: session.startTime,
          newEndTime: session.endTime,
          location: session.location,
          changeType,
          oldLocation: locationChanged ? rOldLocation : undefined,
        });
        totalEmailsSent++;
      } catch (err) {
        console.error("Change notification email failed for", r.email, err);
      }

      if (r.sms_consent) {
        const dateStr = formatDateWithDay(session.date);
        const locName = resolveLocationName(session.location);
        let smsBody: string;
        const oldLocName = resolveLocationName(rOldLocation);
        if (changeType === "both") {
          smsBody = `TIME & LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${oldLocName} → ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else if (changeType === "time") {
          smsBody = `TIME CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else {
          smsBody = `LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nLocation: ${oldLocName} → ${locName}\nTime: ${session.startTime}-${session.endTime}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        }
        try {
          await sendSMS(r.phone, smsBody);
          totalSmsSent++;
        } catch (err) {
          console.error("Change notification SMS failed for", r.phone, err);
        }
      }

      totalRegistrantsNotified++;
    }
  }

  if (changesDetected.length > 0) {
    const summary = changesDetected.map((c) => `• ${c}`).join("\n");
    await sendAdminSMS(
      `TIME CHANGE AUTO-DETECTED:\n${summary}\n` +
        `${totalRegistrantsNotified} registrant${totalRegistrantsNotified !== 1 ? "s" : ""} notified ` +
        `(${totalEmailsSent} email, ${totalSmsSent} SMS)`
    );
  }

  // === TRAINER REASSIGNMENT — WEEKLY SESSIONS (quiet, internal-only) ===
  // A coach swap on an already-booked slot (same date/time/location/group,
  // just a different trainer — "something came up, need someone to cover").
  // No CLIENT notification needed; just keeps booked_trainer in sync so
  // per-trainer group capacity pooling stays correct (see
  // findWeeklyTrainerReassignments) — but the trainers involved do get
  // notified: outgoing one told it's off their schedule, incoming one told
  // it's a new booking.
  const trainerReassignments = findWeeklyTrainerReassignments(upcoming, weeklyRegsUpcoming);
  const trainerSyncSummary: string[] = [];
  for (const { reg, newTrainer } of trainerReassignments) {
    const won = await claimWeeklyTrainerReassignment(supabase, reg, newTrainer);
    if (!won) continue; // the admin-dashboard sync already caught and applied this one
    const oldTrainer = reg.booked_trainer || "Artemios Gavalas";
    trainerSyncSummary.push(`• ${reg.booked_date} — ${regGroupKey(reg)}: ${oldTrainer} → ${newTrainer} (${reg.parent_name})`);
    if (reg.booked_date && reg.booked_start_time) {
      const sessionLabel = regGroupKey(reg);
      await notifyTrainerOfCancellation({
        trainer: oldTrainer,
        parentName: reg.parent_name,
        sessionLabel,
        date: reg.booked_date,
        startTime: reg.booked_start_time,
        endTime: reg.booked_end_time || reg.booked_start_time,
        location: reg.booked_location || "",
      }).catch((err) => console.error("Trainer reassignment-cancel notify failed (weekly):", err));
      await notifyTrainerOfNewBooking({
        trainer: newTrainer,
        parentName: reg.parent_name,
        kids: reg.kids,
        sessionLabel,
        date: reg.booked_date,
        startTime: reg.booked_start_time,
        endTime: reg.booked_end_time || reg.booked_start_time,
        location: reg.booked_location || "",
      }).catch((err) => console.error("Trainer reassignment-newbooking notify failed (weekly):", err));
    }
  }
  if (trainerSyncSummary.length > 0) {
    await sendAdminSMS(`TRAINER REASSIGNED:\n${trainerSyncSummary.join("\n")}`);
  }

  const deletedFound: { session: string; date: string; count: number }[] = [];
  const cancelledKeys = new Map<string, number>(); // key → index in deletedFound
  let cancelEmailsSent = 0;
  let cancelSmsSent = 0;

  for (const r of weeklyDeletions) {
    // Track for admin summary
    const summaryKey = `${r.booked_date}|${r.booked_start_time}`;
    if (!cancelledKeys.has(summaryKey)) {
      cancelledKeys.set(summaryKey, deletedFound.length);
      deletedFound.push({
        session: (r.session_details || "").split(" — ")[0].trim() || "Group Session",
        date: r.booked_date,
        count: 0,
      });
    }
    deletedFound[cancelledKeys.get(summaryKey)!].count++;

    // Conditional on status still being "confirmed" — same guard
    // cancelRegistration (the client's own cancel path) already uses.
    // Without it, a client cancelling their own booking at the same moment
    // this cron independently sees the sheet row gone would let BOTH paths
    // run their full refund flow on the same registration: the client's own
    // cancel issues a real Stripe refund, then this write (racing in
    // unguarded) would still succeed, and refundTrainerCancelledBooking
    // below would re-credit referral/account credit and attempt a second
    // Stripe refund — Stripe rejects the over-refund, but the fallback path
    // then credits the whole "shortfall" to account credit anyway, so the
    // client ends up refunded twice through two different channels.
    const { data: claimedRows } = await supabase
      .from("registrations")
      .update({ status: "cancelled", is_late_cancel: false })
      .eq("id", r.id)
      .eq("status", "confirmed")
      .select("id");
    if (!claimedRows || claimedRows.length === 0) {
      deletedFound[cancelledKeys.get(summaryKey)!].count--; // wasn't actually ours to cancel — keep the admin summary accurate
      continue;
    }

    const moneyResult = await refundTrainerCancelledBooking(r);

    try {
      await sendCancellationNotification({
        parentName: r.parent_name,
        email: r.email,
        sessionDetails: r.session_details || "",
        sessionType: r.type,
        isLateCancel: false,
        stripeRefundResult: moneyResult.stripeRefundResult,
        cancelCredit: moneyResult.cancelCredit,
      });
      cancelEmailsSent++;
    } catch (err) {
      console.error("Deletion cancel email failed for", r.email, err);
    }

    if (r.sms_consent && r.phone) {
      const dateStr = formatDateWithDay(r.booked_date);
      const locName = resolveLocationName(r.booked_location || "");
      const timeStr = `${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`;
      try {
        await sendSMS(
          r.phone,
          `CANCELLED\nMesa Basketball: ${(r.session_details || "").split(" — ")[0].trim()} on ${dateStr}\nTime: ${timeStr}${locName ? `\nLocation: ${locName}` : ""}\nSession cancelled by trainer.${refundSmsLine(moneyResult)}\nQuestions? (631) 599-1280\nReply STOP to opt out.`
        );
        cancelSmsSent++;
      } catch (err) {
        console.error("Deletion cancel SMS failed for", r.phone, err);
      }
    }

    if (r.booked_date && r.booked_start_time && r.booked_trainer) {
      await notifyTrainerOfCancellation({
        trainer: r.booked_trainer,
        parentName: r.parent_name,
        sessionLabel: r.booked_group || (r.session_details || "").split(" — ")[0].trim() || "Group Session",
        date: r.booked_date,
        startTime: r.booked_start_time,
        endTime: r.booked_end_time || r.booked_start_time,
        location: r.booked_location || "",
      }).catch((err) => console.error("Trainer cancellation notify failed (weekly deletion):", err));
    }
  }

  // === DELETION DETECTION — PRIVATE SESSIONS ===
  let privateSlots: Awaited<ReturnType<typeof getPrivateSlots>> = [];
  try {
    privateSlots = await getPrivateSlots({ noCache: true });
  } catch (err) {
    console.error("detect-time-changes: failed to fetch private slots", err);
  }

  // Same double-read safety net as the weekly deletion check above — one
  // fresh CSV read is not enough evidence to cancel a paid private session.
  let privateSlotsConfirm: typeof privateSlots | null = null;
  try {
    privateSlotsConfirm = await getPrivateSlots({ noCache: true });
  } catch (err) {
    console.error("detect-time-changes: confirmation re-fetch failed (private)", err);
  }

  const { data: allPrivateRegs } = await supabase
    .from("registrations")
    .select("*")
    .in("type", ["private", "group-private"])
    .eq("status", "confirmed");

  const cancelledPrivateIds = new Set<string>();
  for (const r of (allPrivateRegs || [])) {
    if (!r.booked_date || !sessionIsUpcoming(r.booked_date, r.booked_start_time || "")) continue;
    const existsInFirstRead = privateBookingStillOnSheet(r, privateSlots);
    const existsInConfirmRead = privateSlotsConfirm === null ? true : privateBookingStillOnSheet(r, privateSlotsConfirm);
    if (existsInFirstRead || existsInConfirmRead) continue;
    cancelledPrivateIds.add(r.id);

    const summaryKey = `${r.booked_date}|${r.booked_start_time}`;
    if (!cancelledKeys.has(summaryKey)) {
      cancelledKeys.set(summaryKey, deletedFound.length);
      deletedFound.push({
        session: (r.session_details || "").split(" — ")[0].trim() || "Private Session",
        date: r.booked_date,
        count: 0,
      });
    }
    deletedFound[cancelledKeys.get(summaryKey)!].count++;

    // Conditional on status still being "confirmed" — same guard as the
    // weekly-deletion loop above (see its comment for the double-refund
    // scenario this closes: a client cancelling their own session at the
    // same moment this cron independently sees it gone from the sheet).
    const { data: claimedPrivateRows } = await supabase
      .from("registrations")
      .update({ status: "cancelled", is_late_cancel: false })
      .eq("id", r.id)
      .eq("status", "confirmed")
      .select("id");
    if (!claimedPrivateRows || claimedPrivateRows.length === 0) {
      // Leave it in cancelledPrivateIds (already added above) — whoever else
      // changed it also means it's no longer "confirmed" either way, so it
      // should stay excluded from the trainer-reassignment pass below.
      deletedFound[cancelledKeys.get(summaryKey)!].count--;
      continue;
    }

    // Every other cancellation path in this codebase (client cancel, admin
    // cancel/delete, admin reschedule) removes the private session's Google
    // Calendar event here — this trainer-deletion path was the one place
    // that never did, so a session auto-cancelled by this cron stayed on
    // the calendar forever (there's no daily reconciliation cron for
    // private events like there is for weekly/camp events).
    try {
      await deletePrivateSessionFromCalendar({ email: r.email, bookedDate: r.booked_date, bookedStartTime: r.booked_start_time });
    } catch (err) {
      console.error("Calendar cleanup failed for trainer-deleted private session", r.email, err);
    }

    const moneyResult = await refundTrainerCancelledBooking(r);

    try {
      await sendCancellationNotification({
        parentName: r.parent_name,
        email: r.email,
        sessionDetails: r.session_details || "",
        sessionType: r.type,
        isLateCancel: false,
        stripeRefundResult: moneyResult.stripeRefundResult,
        cancelCredit: moneyResult.cancelCredit,
      });
      cancelEmailsSent++;
    } catch (err) {
      console.error("Deletion cancel email failed for", r.email, err);
    }

    if (r.sms_consent && r.phone) {
      const dateStr = formatDateWithDay(r.booked_date);
      const locName = resolveLocationName(r.booked_location || "");
      const timeStr = `${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`;
      try {
        await sendSMS(
          r.phone,
          `CANCELLED\nMesa Basketball: Private Session on ${dateStr}\nTime: ${timeStr}${locName ? `\nLocation: ${locName}` : ""}\nSession cancelled by trainer.${refundSmsLine(moneyResult)}\nQuestions? (631) 599-1280\nReply STOP to opt out.`
        );
        cancelSmsSent++;
      } catch (err) {
        console.error("Deletion cancel SMS failed for", r.phone, err);
      }
    }

    if (r.booked_trainer) {
      await notifyTrainerOfCancellation({
        trainer: r.booked_trainer,
        parentName: r.parent_name,
        sessionLabel: r.type === "group-private" ? "Group Private Session" : "Private Session",
        date: r.booked_date,
        startTime: r.booked_start_time,
        endTime: r.booked_end_time || r.booked_start_time,
        location: r.booked_location || "",
      }).catch((err) => console.error("Trainer cancellation notify failed (private deletion):", err));
    }
  }

  if (deletedFound.length > 0) {
    const summary = deletedFound
      .map((d) => `• ${d.session} on ${d.date} (${d.count} booking${d.count !== 1 ? "s" : ""})`)
      .join("\n");
    try {
      await sendAdminSMS(
        `SESSIONS CANCELLED (deleted from sheet):\n${summary}\n${cancelEmailsSent} email${cancelEmailsSent !== 1 ? "s" : ""}, ${cancelSmsSent} SMS sent`
      );
    } catch (err) {
      console.error("Admin deletion SMS failed:", err);
    }
  }

  // === TRAINER REASSIGNMENT — PRIVATE SESSIONS (quiet, internal-only) ===
  // Same "something came up, need someone to cover" scenario as the weekly
  // version above, for an already-booked private/group-private session.
  // Excludes rows just cancelled by the deletion loop directly above (a
  // genuinely deleted session, not a trainer swap).
  const privateReassignments = findPrivateTrainerReassignments(
    (allPrivateRegs || []).filter((r) => !cancelledPrivateIds.has(r.id)),
    privateSlots
  );
  const privateTrainerSyncSummary: string[] = [];
  for (const { reg: r, newTrainer } of privateReassignments) {
    const oldTrainer = r.booked_trainer || "Artemios Gavalas";
    // .eq("booked_trainer", null) would never match in Postgres (NULL = NULL
    // is never true) — a legacy row with no stored trainer would silently
    // never win this compare-and-swap without the .is() branch, same
    // pattern as claimWeeklyTrainerReassignment/claimWeeklyTimeChange.
    let updateQuery = supabase
      .from("registrations")
      .update({ booked_trainer: newTrainer })
      .eq("id", r.id);
    updateQuery = r.booked_trainer === null ? updateQuery.is("booked_trainer", null) : updateQuery.eq("booked_trainer", r.booked_trainer);
    const { data: won } = await updateQuery.select("id");
    if (!won || won.length === 0) continue; // a concurrent run already applied this
    privateTrainerSyncSummary.push(`• ${r.booked_date} ${r.booked_start_time} — ${oldTrainer} → ${newTrainer} (${r.parent_name})`);

    // A package-covered session (often booked against a "TBD"/Any Available
    // Trainer slot, which always resolves to the cheaper "other" tier —
    // see getTrainerTier) can end up reassigned to a trainer no longer
    // covered by the client's package (see packageCoversTrainerTier — an
    // "Any Available Trainer" package reassigned onto Artemios is the only
    // way this can now happen). Unlike admin reschedule
    // (admin/reschedule/route.ts), which already re-checks coverage before
    // letting a package keep covering a session, this automatic
    // reassignment only ever updates booked_trainer — nothing here
    // reconciles the mismatch, so it would otherwise persist silently
    // forever. Can't safely auto-charge the difference from an unattended
    // cron, so this alerts for manual review instead, the same way
    // genuinely ambiguous cases elsewhere in this file already do.
    if (r.package_id) {
      const pkg = await getPackageById(r.package_id).catch(() => null);
      if (pkg && !packageCoversTrainerTier(normalizeTrainerTier(pkg.trainer_tier), getTrainerTier(newTrainer))) {
        await sendAdminSMS(
          `⚠️ PACKAGE TIER MISMATCH: ${r.parent_name}'s package-covered session on ${r.booked_date} ${r.booked_start_time} was just reassigned from ${oldTrainer} to ${newTrainer} — but their package was paid for at the "${normalizeTrainerTier(pkg.trainer_tier)}" tier, not "${getTrainerTier(newTrainer)}". Review and charge/waive the difference manually.`
        ).catch(() => {});
      }
    }

    const sessionLabel = r.type === "group-private" ? "Group Private Session" : "Private Session";
    if (r.booked_date && r.booked_start_time) {
      await notifyTrainerOfCancellation({
        trainer: oldTrainer,
        parentName: r.parent_name,
        sessionLabel,
        date: r.booked_date,
        startTime: r.booked_start_time,
        endTime: r.booked_end_time || r.booked_start_time,
        location: r.booked_location || "",
      }).catch((err) => console.error("Trainer reassignment-cancel notify failed (private):", err));
      await notifyTrainerOfNewBooking({
        trainer: newTrainer,
        parentName: r.parent_name,
        kids: r.kids,
        sessionLabel,
        date: r.booked_date,
        startTime: r.booked_start_time,
        endTime: r.booked_end_time || r.booked_start_time,
        location: r.booked_location || "",
      }).catch((err) => console.error("Trainer reassignment-newbooking notify failed (private):", err));
    }
  }
  if (privateTrainerSyncSummary.length > 0) {
    await sendAdminSMS(`TRAINER REASSIGNED (private):\n${privateTrainerSyncSummary.join("\n")}`).catch(() => {});
  }

  return NextResponse.json({
    checked: upcoming.length,
    changesDetected,
    totalRegistrantsNotified,
    totalEmailsSent,
    totalSmsSent,
    deletedFound,
    cancelEmailsSent,
    cancelSmsSent,
  });
}
