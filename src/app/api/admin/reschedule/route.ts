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
import { addAccountCredit } from "@/lib/supabase";

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

// Admin-initiated move of a single confirmed booking to a new day/time/location
// (and optionally a new type, e.g. converting a group booking into a private
// one). Unlike the client-facing reschedule, this updates the row in place
// (same manage_token, same id) and never charges a late fee — the business
// made the change, not the client.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, bookedDate, bookedStartTime, bookedEndTime, bookedLocation, bookedGroup, bookedTrainer, sessionLabelPrefix, newType } = await req.json();
  if (!id || !bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
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

  // Recompute price whenever the destination charges differently than the
  // source. Group -> private isn't comparable at all, so it's always
  // recalculated. Weekly -> weekly is recalculated too, since different
  // groups can have very different rates (e.g. "HS Pickup" is $30, a regular
  // group is $50) — we look the new group's actual rate up from the live
  // sheet rather than trusting a client-supplied number.
  //
  // Skip entirely for bookings with special pricing already applied (free /
  // referral-credit sessions) — silently overwriting a discounted price with
  // the sheet's sticker price would be a real money bug, not a convenience.
  const skipPriceRecompute = !!reg.is_free || !!reg.used_referral_credit;
  let newSessionPrice: number | undefined;
  if (!skipPriceRecompute) {
    if (isNewPrivate && !wasPrivate) {
      const durationMins = Math.max(60, parseMinsFromTime(bookedEndTime) - parseMinsFromTime(bookedStartTime));
      newSessionPrice = calcPrivatePrice(durationMins, reg.total_participants || 1);
    } else if (effectiveType === "weekly") {
      try {
        const sessions = await getWeeklySchedule();
        const match = sessions.find((s) => s.group === newSessionLabel && s.date === bookedDate && s.startTime === bookedStartTime);
        if (match) {
          newSessionPrice = Math.round(match.price * (reg.total_participants || 1));
        }
      } catch {
        // Sheet lookup failed — leave the existing price untouched rather than guessing.
      }
    }
  }

  const oldPrice = reg.session_price ?? 0;
  const priceDelta = newSessionPrice !== undefined ? newSessionPrice - oldPrice : 0;

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
      ...(newSessionPrice !== undefined ? { session_price: newSessionPrice } : {}),
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If the client already paid and the new price is lower, credit the
  // difference to their account (same rule already used for partial camp-day
  // cancellations elsewhere). If the new price is higher, there's no Stripe
  // charge to trigger yet — surface the amount due in the response/notices
  // instead so it doesn't get charged silently once Stripe is live.
  let creditGranted = 0;
  if (reg.is_paid && priceDelta < 0) {
    try {
      await addAccountCredit(reg.email, -priceDelta);
      creditGranted = -priceDelta;
    } catch (err) {
      console.error("Failed to grant account credit (admin reschedule):", err);
    }
  }
  const amountDue = reg.is_paid && priceDelta > 0 ? priceDelta : 0;

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

  // Notify the client — no late fee, this was the business's call. The price
  // note is appended directly (not part of the shared template) since only
  // this admin flow needs to say "no change to your rate" vs "new rate" vs
  // "credited"/"due".
  const priceNote = newSessionPrice === undefined
    ? ""
    : creditGranted > 0
      ? `\n$${creditGranted} has been credited to your account.`
      : amountDue > 0
        ? `\nNew price: $${newSessionPrice} (was $${oldPrice}). $${amountDue} additional due.`
        : priceDelta !== 0
          ? `\nNew price: $${newSessionPrice} (was $${oldPrice}).`
          : "";

  try {
    await sendRescheduleNotification({
      parentName: reg.parent_name,
      email: reg.email,
      oldSessionDetails,
      newSessionDetails,
      manageToken: reg.manage_token,
      isLateReschedule: false,
      newTrainer: resolvedTrainer,
    });
    if (reg.sms_consent && reg.phone) {
      await sendSMS(
        reg.phone,
        `Mesa Basketball: Your session has been rescheduled by your trainer.\n${formatDateWithDay(bookedDate)} | ${bookedStartTime}-${bookedEndTime}\nLocation: ${resolveLocationName(bookedLocation)}\nAthlete: ${reg.kids}${priceNote}\nManage: mesabasketballtraining.com/booking/${reg.manage_token}\nReply STOP to opt out.`
      );
    }
    const adminPriceNote = newSessionPrice === undefined
      ? ""
      : creditGranted > 0
        ? `\n$${creditGranted} credited to their account (was paid, new price is lower)`
        : amountDue > 0
          ? `\n$${amountDue} additional now due (already paid at the old price)`
          : priceDelta !== 0
            ? `\nPrice: $${oldPrice} -> $${newSessionPrice}`
            : "";
    await sendAdminSMS(`ADMIN RESCHEDULED: ${reg.parent_name}\nFrom: ${oldSessionDetails}\nTo: ${newSessionDetails}\nPlayers: ${reg.kids}${adminPriceNote}`);
  } catch (err) {
    console.error("Notification error (admin reschedule):", err);
  }

  return NextResponse.json({
    success: true,
    sessionDetails: newSessionDetails,
    newType: effectiveType,
    newSessionPrice,
    oldSessionPrice: oldPrice,
    priceDelta,
    creditGranted,
    amountDue,
  });
}
