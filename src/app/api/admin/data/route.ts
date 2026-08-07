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

  // A misconfigured TRAINER_ACCOUNTS row (role: "trainer" but no
  // trainerName set) must fail CLOSED, not open — every scoping guard below
  // is gated on `ctx.trainerName` being truthy, so silently letting this
  // through would skip all of them and hand this account every client's
  // full registrations, contact info, and credit balances sitewide instead
  // of the intended narrow scope. Checked once, up front, rather than
  // trusting every downstream `if (... && ctx.trainerName)` to agree.
  if (ctx.role === "trainer" && !ctx.trainerName) {
    return NextResponse.json({ error: "Trainer account is missing its name configuration — contact the admin." }, { status: 403 });
  }

  let registrationsQuery = supabase.from("registrations").select("*").order("created_at", { ascending: false });
  // A plain trainer account only ever sees their own schedule — scoped at
  // the query itself so their browser never receives another trainer's
  // clients' contact info in the first place, not just a UI that hides it.
  // Case-insensitive (ilike, not eq) since booked_trainer is whatever
  // casing was live on the hand-typed schedule sheet at booking time, which
  // can drift from the exact casing configured in TRAINER_ACCOUNTS —
  // without this, a stray capitalization difference would silently show
  // this trainer an incomplete schedule instead of their real one.
  if (ctx.role === "trainer") {
    registrationsQuery = registrationsQuery.ilike("booked_trainer", ctx.trainerName!);
  }

  const [{ data: registrations }, { data: profilesRaw }, { data: referralCreditsRaw }, { data: packages }, { data: accountCreditsRaw }, { data: lateFeeEventsRaw }] = await Promise.all([
    registrationsQuery,
    supabase.from("profiles").select("email, phone, parent_name, kids, video_consent"),
    supabase.from("referral_credits").select("email, credits, total_referrals"),
    // Deliberately NOT trainer-scoped, unlike everything else below — an
    // "Any Available Trainer" package floats across whichever substitute has
    // an open slot, so any trainer plausibly needs to know a walk-in client
    // has one, not just clients they've personally already served.
    supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    supabase.from("account_credits").select("email, balance").gt("balance", 0),
    // Recent-activity feed only — older rows are irrelevant clutter, so the
    // query itself narrows to the last week rather than filtering client-side.
    supabase.from("late_fee_events").select("*").gte("created_at", sevenDaysAgo).order("created_at", { ascending: false }),
  ]);

  // A plain trainer's registrations query above is already scoped to their
  // own bookings — but profiles/referralCredits/accountCredits/lateFeeEvents
  // were still being fetched completely unscoped and shipped to their
  // browser in full, regardless of role. That directly contradicts this
  // route's own stated invariant just above ("their browser never receives
  // another trainer's clients' contact info in the first place") — a plain
  // trainer account could open devtools and read every client's phone
  // number, kids, and credit balances site-wide, not just their own
  // clients', even though the UI never renders most of it. Scope these the
  // same way registrations already is: down to only the clients who
  // actually appear in THIS trainer's own scoped registrations. Elevated
  // trainers and admin are unaffected (they're meant to see everyone).
  const isPlainTrainer = ctx.role === "trainer";
  const ownClientEmails = isPlainTrainer
    ? new Set((registrations || []).map((r) => (r.email || "").toLowerCase().trim()).filter(Boolean))
    : null;
  const profiles = ownClientEmails ? (profilesRaw || []).filter((p) => ownClientEmails.has((p.email || "").toLowerCase().trim())) : profilesRaw;
  const referralCredits = ownClientEmails ? (referralCreditsRaw || []).filter((r) => ownClientEmails.has((r.email || "").toLowerCase().trim())) : referralCreditsRaw;
  const accountCredits = ownClientEmails ? (accountCreditsRaw || []).filter((a) => ownClientEmails.has((a.email || "").toLowerCase().trim())) : accountCreditsRaw;
  const lateFeeEvents = ownClientEmails ? (lateFeeEventsRaw || []).filter((e) => ownClientEmails.has((e.email || "").toLowerCase().trim())) : lateFeeEventsRaw;

  return NextResponse.json({ registrations: registrations || [], profiles: profiles || [], referralCredits: referralCredits || [], packages: packages || [], accountCredits: accountCredits || [], lateFeeEvents: lateFeeEvents || [] });
}
