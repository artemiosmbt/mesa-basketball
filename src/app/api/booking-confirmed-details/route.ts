import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { getRegistrationsByBatchId } from "@/lib/supabase";

function sessionTitle(type: string, sessionDetails: string): string {
  const isPickup = type === "weekly" && sessionDetails.toLowerCase().includes("pickup");
  if (type === "camp") return "Mesa Basketball Training — Camp";
  if (isPickup) return "Mesa Basketball Training — Pickup Session";
  if (type === "weekly") return "Mesa Basketball Training — Group Session";
  return "Mesa Basketball Training — Private Session";
}

// Lets the post-checkout confirmation page offer "Add to Calendar" the same
// way the old (pre-Stripe) inline confirmation did — access is via
// possession of the Stripe Checkout Session id embedded in success_url
// (a long, non-guessable string only the paying client ever sees), same
// trust model as the manage-booking token links used elsewhere on the site.
// Only returns scheduling info (date/time/location/a generic title), never
// names/emails/phone numbers.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ sessions: [] });

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const bookingBatchId = session.client_reference_id;
    // Package enrollments' client_reference_id points at monthly_packages,
    // not registrations, and packages have no fixed date/time to calendar.
    if (!bookingBatchId || session.metadata?.purpose === "package_enrollment") {
      return NextResponse.json({ sessions: [] });
    }

    const rows = await getRegistrationsByBatchId(bookingBatchId);
    const sessions = rows
      .filter((r) => r.booked_date && r.booked_start_time && r.booked_end_time)
      .map((r) => ({
        date: r.booked_date as string,
        startTime: r.booked_start_time as string,
        endTime: r.booked_end_time as string,
        location: r.booked_location || "",
        title: sessionTitle(r.type, r.session_details || ""),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({ sessions });
  } catch (err) {
    console.error("booking-confirmed-details error:", err);
    return NextResponse.json({ sessions: [] });
  }
}
