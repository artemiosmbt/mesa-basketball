import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";
import { sendTimeChangeNotification, sendCancellationNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { addAccountCredit, addReferralCredit, countPackageSessionsUsed, setPackageSessions } from "@/lib/supabase";
import { issueStripeRefund, resolvedSessionPrice, type StripeRefundResult } from "@/lib/booking-finalize";
import { fmtMoney } from "@/lib/pricing";

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
    const paidAmount = Math.max(0, resolvedSessionPrice({ session_price: r.session_price, is_free: !!r.is_free, type: r.type }) - (r.applied_account_credit || 0));
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
function privateBookingStillOnSheet(
  reg: { booked_date: string | null; booked_start_time: string | null; booked_end_time: string | null; booked_trainer?: string | null },
  slots: { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
): boolean {
  const regStart = parseTimeMins(reg.booked_start_time || "");
  const regEnd = parseTimeMins(reg.booked_end_time || "");
  if (regStart === null || regEnd === null) return true; // can't evaluate — don't risk a false cancel

  const trainer = reg.booked_trainer || "Artemios Gavalas";
  const byLocation: Record<string, { start: number; end: number }[]> = {};
  slots
    .filter((s) => s.date === reg.booked_date && s.trainer === trainer)
    .forEach((s) => {
      const start = parseTimeMins(s.startTime);
      const end = parseTimeMins(s.endTime);
      if (start === null || end === null) return;
      if (!byLocation[s.location]) byLocation[s.location] = [];
      byLocation[s.location].push({ start, end });
    });

  return Object.values(byLocation).some((rows) => {
    const sorted = [...rows].sort((a, b) => a.start - b.start);
    let windowStart = sorted[0].start;
    let windowEnd = sorted[0].end;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start === windowEnd) {
        windowEnd = sorted[i].end;
      } else {
        if (regStart >= windowStart && regEnd <= windowEnd) return true;
        windowStart = sorted[i].start;
        windowEnd = sorted[i].end;
      }
    }
    return regStart >= windowStart && regEnd <= windowEnd;
  });
}

// Every weekly registration stores its own exact group name in booked_group
// (added specifically to disambiguate — see the same pattern in
// src/lib/supabase.ts's getCampGroupByReferralCode). Prefer that exact
// match; only fall back to a substring check on session_details for legacy
// rows booked before that column existed. Without this, a group name that
// happens to be a substring of another (e.g. "Elite" inside "Elite
// Advanced") could misattribute or "lose" registrations.
function regMatchesGroup(r: { booked_group: string | null; session_details: string | null }, group: string): boolean {
  return r.booked_group ? r.booked_group === group : (r.session_details || "").includes(group);
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
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

  // === TIME / LOCATION CHANGE DETECTION ===
  for (const session of upcoming) {
    const { data: allRegs, error } = await supabase
      .from("registrations")
      .select("*")
      .eq("booked_date", session.date)
      .eq("type", "weekly")
      .eq("status", "confirmed");

    if (error) {
      console.error("detect-time-changes DB error", session.date, session.group, error);
      continue;
    }

    const stale = (allRegs || []).filter(
      (r) =>
        regMatchesGroup(r, session.group) &&
        (r.booked_start_time !== session.startTime ||
          r.booked_end_time !== session.endTime ||
          r.booked_location !== session.location)
    );

    if (stale.length === 0) continue;

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

      await supabase
        .from("registrations")
        .update({
          booked_start_time: session.startTime,
          booked_end_time: session.endTime,
          ...(locationChanged ? { booked_location: session.location } : {}),
          session_details: newDetails,
          admin_change_at: new Date().toISOString(),
        })
        .eq("id", r.id);

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

  // === DELETION DETECTION — WEEKLY SESSIONS ===
  // A single sheet read is never trusted as proof of deletion — a transient
  // formula-recalculation glitch or a torn read caught mid-edit elsewhere in
  // the sheet could otherwise make a real, still-scheduled session look
  // "gone" and trigger an irreversible cancel + Stripe refund. Re-fetch
  // independently and only treat a session as deleted if BOTH reads agree
  // it's missing; if the confirmation fetch itself fails, default to "still
  // exists" so a fetch error can never look like a mass deletion.
  let upcomingConfirm: typeof upcoming | null = null;
  try {
    const confirmSessions = await getWeeklySchedule({ noCache: true });
    upcomingConfirm = confirmSessions.filter(
      (s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group
    );
  } catch (err) {
    console.error("detect-time-changes: confirmation re-fetch failed (weekly)", err);
  }

  // For each upcoming confirmed weekly registration, check if its session still
  // exists in the sheet.
  const { data: allWeeklyRegs } = await supabase
    .from("registrations")
    .select("*")
    .eq("type", "weekly")
    .eq("status", "confirmed");

  const deletedFound: { session: string; date: string; count: number }[] = [];
  const cancelledKeys = new Map<string, number>(); // key → index in deletedFound
  let cancelEmailsSent = 0;
  let cancelSmsSent = 0;

  for (const r of (allWeeklyRegs || [])) {
    if (!r.booked_date || !sessionIsUpcoming(r.booked_date, r.booked_start_time || "")) continue;

    // Session still exists in sheet if any sheet row matches this date, its
    // exact group (regMatchesGroup), AND its exact start time — the time
    // check matters because the time-change sync above already re-synced
    // booked_start_time to the live sheet for any still-existing session, so
    // by this point a genuinely-still-there session's time WILL match. It
    // also stops a same-named group running twice on the same day at
    // different times from masking the deletion of just one of those slots
    // (without a time check, the other slot's mere existence would make the
    // deleted one look like it's still there).
    const existsInFirstRead = upcoming.some(
      (s) => s.date === r.booked_date && s.startTime === r.booked_start_time && regMatchesGroup(r, s.group)
    );
    const existsInConfirmRead = upcomingConfirm === null ? true : upcomingConfirm.some(
      (s) => s.date === r.booked_date && s.startTime === r.booked_start_time && regMatchesGroup(r, s.group)
    );
    if (existsInFirstRead || existsInConfirmRead) continue;

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

    await supabase
      .from("registrations")
      .update({ status: "cancelled", is_late_cancel: false })
      .eq("id", r.id);

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

  for (const r of (allPrivateRegs || [])) {
    if (!r.booked_date || !sessionIsUpcoming(r.booked_date, r.booked_start_time || "")) continue;
    const existsInFirstRead = privateBookingStillOnSheet(r, privateSlots);
    const existsInConfirmRead = privateSlotsConfirm === null ? true : privateBookingStillOnSheet(r, privateSlotsConfirm);
    if (existsInFirstRead || existsInConfirmRead) continue;

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

    await supabase
      .from("registrations")
      .update({ status: "cancelled", is_late_cancel: false })
      .eq("id", r.id);

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
