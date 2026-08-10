import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { attachComputedFields } from "@/lib/admin-registration-enrichment";

// Replaces admin/payments/page.tsx's reuse of the big, unscoped
// /api/admin/data — that page only ever read registrations, packages,
// accountCredits, and lateFeeEvents from that response, discarding
// profiles/referralCredits every load, and pulled every column
// (manage_token, session_details HTML, etc.) off every registration
// regardless of whether this page renders it. Admin-only, same as the page
// itself, so no trainer-role scoping needed.
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Only "confirmed" registrations ever appear in either the Unpaid or Paid
  // (last 24h) lists this page renders — narrowing the query itself (not
  // just filtering client-side) and selecting only the columns this page
  // actually reads (see the field audit in the commit this shipped with)
  // cuts both row count and row width versus the old full-table,
  // full-column fetch.
  const [{ data: registrations }, { data: packages }, { data: accountCredits }, { data: lateFeeEvents }] = await Promise.all([
    supabase
      .from("registrations")
      .select("id, email, parent_name, phone, kids, type, session_details, booked_date, booked_start_time, booked_group, booked_trainer, status, is_paid, stripe_payment_intent_id, session_price, total_participants, is_free, is_full_camp, referral_code, camp_day_late_fee, camp_drop_in_rate, applied_account_credit")
      .eq("status", "confirmed"),
    // Deliberately NOT trainer-scoped — same reasoning as admin/data's
    // equivalent query — package coverage isn't tied to one trainer.
    supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    supabase.from("account_credits").select("email, balance").gt("balance", 0),
    supabase.from("late_fee_events").select("*").gte("created_at", sevenDaysAgo).order("created_at", { ascending: false }),
  ]);

  const enrichedRegistrations = await attachComputedFields(supabase, registrations || [], packages || []);

  return NextResponse.json({
    registrations: enrichedRegistrations,
    packages: packages || [],
    accountCredits: accountCredits || [],
    lateFeeEvents: lateFeeEvents || [],
  });
}
