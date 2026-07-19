import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { updateRegistrationPlayers, addAccountCredit } from "@/lib/supabase";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";
import { sendAdminSMS, sendSMS } from "@/lib/sms";
import { getWeeklySchedule } from "@/lib/sheets";

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

function effectiveAmount(fullPrice: number, isFree: boolean, isPriv: boolean): number {
  return isFree && isPriv ? Math.round(fullPrice * 0.5) : fullPrice;
}

// Fallback when session_price is null (a real, common case — legacy rows)
// rather than treating an unset price as $0, which would understate what's
// actually owed.
function fullPriceForType(type: string): number {
  return type === "group-private" ? 250 : type === "private" ? 150 : 50;
}

// Adds one player to an existing confirmed booking. Small, rarely-used admin
// action — no late fee, and price is recalculated using the same rules as
// the reschedule tool (full private duration rate, or the weekly group's
// per-player rate carried forward). Camp pricing is left untouched, same as
// reschedule, since it has too many variables to safely auto-recompute.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, playerName } = await req.json();
  if (!id || typeof playerName !== "string" || !playerName.trim()) {
    return NextResponse.json({ error: "Missing player name" }, { status: 400 });
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
    return NextResponse.json({ error: "Only confirmed bookings can be edited" }, { status: 400 });
  }

  const newKids = reg.kids ? `${reg.kids}, ${playerName.trim()}` : playerName.trim();
  const oldCount = reg.total_participants || 1;
  const newCount = oldCount + 1;
  const isPriv = isPrivateType(reg.type);

  let newFullPrice: number | null = null;
  if (isPriv && reg.booked_start_time && reg.booked_end_time) {
    const durationMins = Math.max(60, parseMinsFromTime(reg.booked_end_time) - parseMinsFromTime(reg.booked_start_time));
    newFullPrice = calcPrivatePrice(durationMins, newCount);
  } else if (reg.type === "weekly" && reg.booked_date && reg.booked_start_time) {
    // Look up the group's actual live rate rather than scaling the stored
    // price — different groups have different per-session rates (e.g. "HS
    // Pickup" is $30, not $50), and this also sidesteps a null session_price.
    try {
      const sessions = await getWeeklySchedule();
      const match = sessions.find((s) => s.group === reg.booked_group && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
      if (match) {
        newFullPrice = Math.round(match.price * newCount);
      }
    } catch {
      // Sheet lookup failed — leave the existing price untouched rather than guessing.
    }
  }
  // camp (or missing price data): leave session_price untouched — pass null so
  // updateRegistrationPlayers doesn't overwrite it.

  // Account credit applied at booking time is a separate field from
  // session_price/is_free and still belongs to this booking — subtract it
  // from both sides so the displayed/texted amounts reflect what's actually
  // still owed, not the pre-credit rate.
  const appliedCredit = reg.applied_account_credit || 0;
  const oldFullPrice = reg.session_price ?? fullPriceForType(reg.type);
  const oldAmount = Math.max(0, effectiveAmount(oldFullPrice, !!reg.is_free, isPriv) - appliedCredit);
  const newAmount = newFullPrice !== null ? Math.max(0, effectiveAmount(newFullPrice, !!reg.is_free, isPriv) - appliedCredit) : oldAmount;
  const priceDelta = newFullPrice !== null ? newAmount - oldAmount : 0;

  const ok = await updateRegistrationPlayers(reg.manage_token, newKids, newCount, newFullPrice);
  if (!ok) {
    return NextResponse.json({ error: "Failed to add player" }, { status: 500 });
  }

  let creditGranted = 0;
  if (reg.is_paid && priceDelta < 0) {
    try {
      await addAccountCredit(reg.email, -priceDelta);
      creditGranted = -priceDelta;
    } catch (err) {
      console.error("Failed to grant account credit (admin add-player):", err);
    }
  }
  const amountDue = reg.is_paid && priceDelta > 0 ? priceDelta : 0;

  try {
    if (isPriv) {
      if (reg.booked_date) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date });
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
        sessionLabel: reg.booked_group || (reg.session_details || "").split(" — ")[0] || "Group Session",
        bookedDate: reg.booked_date,
        bookedStartTime: reg.booked_start_time,
        bookedEndTime: reg.booked_end_time || reg.booked_start_time,
        bookedLocation: reg.booked_location || "",
        kidsJustRegistered: newKids,
        participantsJustRegistered: newCount,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (admin add-player):", err);
  }

  try {
    const priceNote = newFullPrice === null
      ? ""
      : creditGranted > 0
        ? ` $${oldAmount} -> $${newAmount}, $${creditGranted} credited for their next booking.`
        : amountDue > 0
          ? ` $${oldAmount} -> $${newAmount}, $${amountDue} additional due.`
          : priceDelta !== 0
            ? ` $${oldAmount} -> $${newAmount}.`
            : "";
    if (reg.sms_consent && reg.phone) {
      await sendSMS(
        reg.phone,
        `Mesa Basketball: ${playerName.trim()} was added to your booking (${reg.booked_group || reg.session_details.split(" — ")[0]}).${priceNote}\nManage: mesabasketballtraining.com/booking/${reg.manage_token}\nReply STOP to opt out.`
      );
    }
    await sendAdminSMS(`PLAYER ADDED: ${reg.parent_name}\n${reg.session_details}\nAdded: ${playerName.trim()}\nNow: ${newKids}${priceNote}`);
  } catch (err) {
    console.error("Notification error (admin add-player):", err);
  }

  return NextResponse.json({
    success: true,
    kids: newKids,
    totalParticipants: newCount,
    sessionPrice: newFullPrice !== null ? newFullPrice : reg.session_price,
    creditGranted,
    amountDue,
  });
}
