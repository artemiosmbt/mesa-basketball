import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";


export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { searchParams } = new URL(req.url);
  const emailFilter = searchParams.get("email");

  if (emailFilter) {
    const { data: registrations } = await supabase
      .from("registrations")
      .select("*")
      .ilike("email", emailFilter.trim())
      .order("booked_date", { ascending: true });
    return NextResponse.json({ registrations: registrations || [] });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: registrations }, { data: profiles }, { data: referralCredits }, { data: packages }, { data: accountCredits }, { data: lateFeeEvents }] = await Promise.all([
    supabase.from("registrations").select("*").order("created_at", { ascending: false }),
    supabase.from("profiles").select("email, video_consent"),
    supabase.from("referral_credits").select("email, credits, total_referrals"),
    supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid"),
    supabase.from("account_credits").select("email, balance").gt("balance", 0),
    // Recent-activity feed only — older rows are irrelevant clutter, so the
    // query itself narrows to the last week rather than filtering client-side.
    supabase.from("late_fee_events").select("*").gte("created_at", sevenDaysAgo).order("created_at", { ascending: false }),
  ]);

  return NextResponse.json({ registrations: registrations || [], profiles: profiles || [], referralCredits: referralCredits || [], packages: packages || [], accountCredits: accountCredits || [], lateFeeEvents: lateFeeEvents || [] });
}
