import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationByToken,
  cancelRegistration,
  cancelFullCampByReferralCode,
  getEarliestCampDay,
  addRegistration,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
  updateRegistrationPlayers,
} from "@/lib/supabase";
import {
  sendCancellationNotification,
  sendRescheduleNotification,
  sendPlayerUpdateNotification,
} from "@/lib/email";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";

// Parse a session date + hours/mins (Eastern time) into a UTC Date for comparison.
// The server runs UTC; without this, "2:00 PM" is treated as 2pm UTC instead of 2pm ET.
function parseSessionDateTimeET(dateStr: string, hoursET: number, minsET: number): Date {
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
function isLateAction(dateStr: string, timeStr: string, createdAt: string): boolean {
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
  // Within 24h — check grace: 15 min from booking time, capped at session start
  const graceEnd = Math.min(
    new Date(createdAt).getTime() + 15 * 60 * 1000,
    sessionStart.getTime()
  );
  return now >= graceEnd;
}

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
  return NextResponse.json({
    id: reg.id,
    parentName: reg.parent_name,
    email: reg.email,
    kids: reg.kids,
    type: reg.type,
    sessionDetails: reg.session_details,
    bookedDate: reg.booked_date,
    bookedStartTime: reg.booked_start_time,
    bookedEndTime: reg.booked_end_time,
    bookedLocation: reg.booked_location,
    status: reg.status,
    createdAt: reg.created_at,
    isFullCamp: reg.is_full_camp ?? false,
  });
}

// DELETE — cancel booking
export async function DELETE(
  _req: NextRequest,
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

  // Block camp cancellations once the camp has started.
  // For full camp, check the earliest day of the group so no day's token can be used
  // after the camp has already begun. For drop-in, check that specific day.
  if (reg.type === "camp") {
    const checkDay = reg.is_full_camp && reg.referral_code
      ? await getEarliestCampDay(reg.referral_code)
      : { booked_date: reg.booked_date!, booked_start_time: reg.booked_start_time! };

    if (checkDay?.booked_date && checkDay?.booked_start_time) {
      const timeMatch = checkDay.booked_start_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const period = timeMatch[3].toUpperCase();
        if (period === "PM" && hours !== 12) hours += 12;
        if (period === "AM" && hours === 12) hours = 0;
        const sessionDateTime = parseSessionDateTimeET(checkDay.booked_date, hours, mins);
        if (Date.now() >= sessionDateTime.getTime()) {
          return NextResponse.json(
            { error: "Cancellations are not accepted once the camp has started. The full amount is due." },
            { status: 400 }
          );
        }
      }
    }
  }

  // Check 24-hour policy with 15-min grace period
  let isLateCancel = false;
  if (reg.booked_date && reg.booked_start_time) {
    isLateCancel = isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at);
  }

  // Full camp: block individual-day cancellation — must cancel all days together
  if (reg.type === "camp" && reg.is_full_camp) {
    if (!reg.referral_code) {
      return NextResponse.json({ error: "Cannot cancel — missing camp group reference." }, { status: 500 });
    }
    const success = await cancelFullCampByReferralCode(reg.referral_code);
    if (!success) {
      return NextResponse.json({ error: "Failed to cancel camp" }, { status: 500 });
    }
    const lateFeeAmount = reg.session_price && isLateCancel ? Math.round(reg.session_price * 0.5) : undefined;
    // Extract camp name (everything before the first " — " in session_details)
    const campName = reg.session_details.split(" — ")[0] || reg.session_details;
    await sendCancellationNotification({
      parentName: reg.parent_name,
      email: reg.email,
      sessionDetails: campName,
      sessionType: reg.type,
      isLateCancel,
      lateFeeAmount,
    });
    // Update calendar for this camp day (count decreases after cancellation)
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
    return NextResponse.json({ success: true, isLateCancel });
  }

  const success = await cancelRegistration(token, isLateCancel);
  if (!success) {
    return NextResponse.json(
      { error: "Failed to cancel" },
      { status: 500 }
    );
  }

  // Recalculate package sessions_used after cancellation
  if (reg.booked_date && (reg.type === "private" || reg.type === "group-private")) {
    try {
      const raw = reg.booked_date;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(raw + "T12:00:00")
        : new Date(raw);
      if (!isNaN(d.getTime())) {
        const bookingMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const activePkg = await getActivePackage(reg.email, bookingMonth);
        if (activePkg) {
          const confirmedCount = await countConfirmedPrivateSessions(reg.email, bookingMonth);
          const newUsed = Math.min(activePkg.package_type, confirmedCount);
          if (newUsed !== activePkg.sessions_used) {
            await setPackageSessions(activePkg.id, newUsed);
          }
        }
      }
    } catch {
      // non-critical — don't fail the cancellation
    }
  }

  const lateFeeAmount = reg.session_price && isLateCancel ? Math.round(reg.session_price * 0.5) : undefined;

  await sendCancellationNotification({
    parentName: reg.parent_name,
    email: reg.email,
    sessionDetails: reg.session_details,
    sessionType: reg.type,
    isLateCancel,
    lateFeeAmount,
  });

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
        const sessionLabel = reg.session_details.split(" — ")[0] || "Group Session";
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

  return NextResponse.json({ success: true, isLateCancel });
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
    isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at));

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
  if (!ok) return NextResponse.json({ error: "Failed to update players" }, { status: 500 });

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
  } catch (err) {
    console.error("Player update email error:", err);
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
  const { bookedDate, bookedStartTime, bookedEndTime, bookedLocation, kids: bodyKids, sessionType: bodySessionType, sessionGroup } = body;

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

  // Check if original session is within 24h (with grace period) → late reschedule fee applies
  const isLateReschedule = !!(reg.booked_date && reg.booked_start_time && isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at));

  // Cancel old booking first so group enrollment counts reflect the cancellation
  await cancelRegistration(token);

  // Sync calendar for the old booking
  if (reg.booked_date && reg.booked_start_time) {
    const wasPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (wasPrivate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date });
      } else {
        const sessionLabel = reg.session_details.split(" — ")[0] || "Group Session";
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

  // Create new booking with updated type, kids, and session details
  const { manageToken: newToken } = await addRegistration({
    parentName: reg.parent_name,
    email: reg.email,
    phone: reg.phone,
    kids: kidsToUse,
    type: newType,
    sessionDetails: newSessionDetails,
    totalParticipants: kidCount,
    bookedDate,
    bookedStartTime,
    bookedEndTime,
    bookedLocation,
  });

  // Sync calendar for the new booking
  try {
    if (newType === "private") {
      await addPrivateSessionToCalendar({
        parentName: reg.parent_name,
        email: reg.email,
        phone: reg.phone,
        kids: kidsToUse,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
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

  const lateFeeAmount = reg.session_price && isLateReschedule ? Math.round(reg.session_price * 0.5) : undefined;

  await sendRescheduleNotification({
    parentName: reg.parent_name,
    email: reg.email,
    oldSessionDetails: reg.session_details,
    newSessionDetails,
    manageToken: newToken,
    isLateReschedule: !!isLateReschedule,
    lateFeeAmount,
  });

  return NextResponse.json({ success: true, newToken, isLateReschedule: !!isLateReschedule });
}
