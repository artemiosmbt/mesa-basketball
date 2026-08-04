import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyDashboardAccess } from "@/lib/auth";


export async function GET(req: NextRequest) {
  const ctx = await verifyDashboardAccess(req);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { searchParams } = new URL(req.url);
  const emailFilter = searchParams.get("email");

  // Used only to expand a single client's sessions from the Packages page,
  // which every recognized account can see in full (packages aren't
  // trainer-scoped) — no additional filtering here.
  if (emailFilter) {
    const { data: registrations } = await supabase
      .from("registrations")
      .select("*")
      .ilike("email", emailFilter.trim())
      .order("booked_date", { ascending: true });
    return NextResponse.json({ registrations: registrations || [] });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let registrationsQuery = supabase.from("registrations").select("*").order("created_at", { ascending: false });
  // A plain trainer account only ever sees their own schedule — scoped at
  // the query itself so their browser never receives another trainer's
  // clients' contact info in the first place, not just a UI that hides it.
  if (ctx.role === "trainer" && ctx.trainerName) {
    registrationsQuery = registrationsQuery.eq("booked_trainer", ctx.trainerName);
  }

  const [{ data: registrations }, { data: profiles }, { data: referralCredits }, { data: packages }, { data: accountCredits }, { data: lateFeeEvents }] = await Promise.all([
    registrationsQuery,
    supabase.from("profiles").select("email, phone, kids, video_consent"),
    supabase.from("referral_credits").select("email, credits, total_referrals"),
    // Same payment_abandoned exclusion as /api/admin/packages — an
    // never-completed Checkout Session shouldn't count as a real package
    // when deciding whether a private session is "within" a paid package.
    supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    supabase.from("account_credits").select("email, balance").gt("balance", 0),
    // Recent-activity feed only — older rows are irrelevant clutter, so the
    // query itself narrows to the last week rather than filtering client-side.
    supabase.from("late_fee_events").select("*").gte("created_at", sevenDaysAgo).order("created_at", { ascending: false }),
  ]);

  return NextResponse.json({ registrations: registrations || [], profiles: profiles || [], referralCredits: referralCredits || [], packages: packages || [], accountCredits: accountCredits || [], lateFeeEvents: lateFeeEvents || [] });
}
