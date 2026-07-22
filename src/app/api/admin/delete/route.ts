import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { deletePrivateSessionFromCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";


export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch registration details before deleting so we can clean up the calendar
  const { data: reg } = await supabase
    .from("registrations")
    .select("type, email, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, kids, session_details, total_participants, status, is_paid, stripe_payment_intent_id, applied_account_credit, used_referral_credit")
    .eq("id", id)
    .single();

  // Delete is meant for erasing a genuine mistake/duplicate row, not for
  // making a paid booking's money disappear with no refund trail — unlike
  // /api/admin/cancel, this route has no refund/credit logic at all. A
  // confirmed row that was actually paid for must go through Cancel instead,
  // which correctly refunds or credits it. This also covers a booking that
  // cost the client something WITHOUT a Stripe charge ever happening — fully
  // covered by account credit or a referral credit — which is_paid/
  // stripe_payment_intent_id alone would miss entirely, silently erasing the
  // credit the client spent on it with no way to get it back.
  const wasPaidViaStripe = !!(reg?.is_paid || reg?.stripe_payment_intent_id);
  const wasPaidViaCredit = !!(reg && ((reg.applied_account_credit || 0) > 0 || reg.used_referral_credit));
  if (reg && reg.status === "confirmed" && (wasPaidViaStripe || wasPaidViaCredit)) {
    return NextResponse.json(
      { error: "This booking was paid for (card or credit) — use Cancel instead of Delete so the client is properly refunded or credited." },
      { status: 400 }
    );
  }

  const { error } = await supabase.from("registrations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Clean up calendar — only for confirmed bookings (cancelled ones already removed)
  if (reg?.booked_date && reg?.booked_start_time && reg?.status !== "cancelled") {
    const isPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (isPrivate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: reg.booked_date, bookedStartTime: reg.booked_start_time });
      } else {
        // Use the stored booked_group rather than re-parsing session_details — group
        // labels can themselves contain " — " (e.g. "High School Girls — Grades 9-12"),
        // which would truncate the label and miss the calendar event's tag.
        const sessionLabel = reg.booked_group || reg.session_details?.split(" — ")[0] || "Group Session";
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids || "",
          participantsJustRegistered: reg.total_participants || 1,
        });
      }
    } catch (err) {
      console.error("Calendar sync error (admin delete):", err);
    }
  }

  return NextResponse.json({ ok: true });
}
