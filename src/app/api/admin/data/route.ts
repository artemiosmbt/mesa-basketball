import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyDashboardAccess } from "@/lib/auth";
import { requireTrainerNameConfigured, trainerScopeFilter, normalizeDropdownTrainer, deriveOwnClientEmails, scopeToOwnClients } from "@/lib/admin-data-scope";
import { attachComputedFields } from "@/lib/admin-registration-enrichment";

// Mirrors admin/page.tsx's identical client-side helpers exactly — moved
// here too since ?view=clients now does this aggregation server-side.
function dateMs(d: string | null): number {
  if (!d) return 0;
  const p = new Date(d);
  return isNaN(p.getTime()) ? 0 : p.setHours(0, 0, 0, 0);
}
// See the identical fix + rationale on admin/page.tsx's copy of this
// function: stripping "(...)" groups first (not splitting on "," first)
// avoids leaking the DOB/Grade/Gender fields inside those parens as if
// they were additional athlete names.
function athleteNames(kids: string): string {
  return kids ? kids.replace(/\([^)]*\)/g, "").split(",").map((k) => k.trim()).filter(Boolean).join(", ") : "—";
}


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
  const view = searchParams.get("view");

  // Used only to expand a single client's private-session dates on the
  // Packages page, which every recognized account can see in full (packages
  // aren't trainer-scoped) — but that only justifies exposing the handful of
  // fields the UI actually renders (id/type/date/time), never a full-row
  // dump: `select("*")` used to also ship `manage_token` (the sole secret
  // needed to cancel/reschedule a booking via the public token endpoint),
  // phone, session_price, and stripe_payment_intent_id to any trainer-tier
  // account for ANY client, not just their own. Exact-match (not ilike) on
  // the normalized email, since this is an exact client lookup, not a
  // search — ilike with a client-supplied pattern let `%`/`_` wildcard-match
  // the whole table.
  if (emailFilter) {
    // full=1: the Clients-tab detail view — a single client's entire
    // booking history, loaded only once the admin clicks into that
    // specific client (see the lazy-loading plan). Needs the real column
    // set RegCard renders, unlike the minimal id/type/date/time projection
    // below the Packages page uses, and — unlike that branch — DOES need
    // trainer scoping: a plain trainer must only ever see their own
    // bookings for this client, same invariant as every other view.
    if (searchParams.get("full") === "1") {
      const fullScopeError = requireTrainerNameConfigured(ctx);
      if (fullScopeError) return fullScopeError;

      let clientQuery = supabase
        .from("registrations_with_parsed_date")
        .select("*")
        .eq("email", emailFilter.trim().toLowerCase())
        .neq("status", "payment_abandoned")
        .order("booked_date_parsed", { ascending: false });
      const clientTrainerFilter = trainerScopeFilter(ctx);
      if (clientTrainerFilter) clientQuery = clientQuery.eq("booked_trainer_normalized", clientTrainerFilter);

      const [{ data: clientRegs }, { data: clientPackages }, { data: clientProfileRows }] = await Promise.all([
        clientQuery,
        supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
        // Single-row lookup for this one client — lets the client-detail view
        // show grade/DOB/video-consent from their profile without the
        // dashboard needing the site-wide profiles list loaded at all.
        supabase.from("profiles").select("email, phone, parent_name, kids, video_consent").eq("email", emailFilter.trim().toLowerCase()),
      ]);
      const enrichedClient = await attachComputedFields(supabase, clientRegs || [], clientPackages || []);
      return NextResponse.json({ registrations: enrichedClient, profile: clientProfileRows?.[0] || null });
    }

    const { data: registrations } = await supabase
      .from("registrations")
      .select("id, type, booked_date, booked_start_time, booked_end_time")
      .eq("email", emailFilter.trim().toLowerCase())
      .order("booked_date", { ascending: true });
    return NextResponse.json({ registrations: registrations || [] });
  }

  // Clients tab list — built from an aggregate over registrations
  // (email/parent_name, phone, kids, booked_date only — never the full
  // row) instead of the browser deriving counts/last-session-date from
  // every registration it happens to have loaded. Preserves the existing
  // guest-client fallback (no profiles row: kids/count come straight from
  // their own registrations) exactly as the client-side version did.
  if (view === "clients") {
    const clientsScopeError = requireTrainerNameConfigured(ctx);
    if (clientsScopeError) return clientsScopeError;

    let clientRegsQuery = supabase
      .from("registrations_with_parsed_date")
      .select("email, parent_name, phone, kids, booked_date")
      .neq("status", "payment_abandoned");
    const clientsTrainerFilter = trainerScopeFilter(ctx);
    if (clientsTrainerFilter) {
      clientRegsQuery = clientRegsQuery.eq("booked_trainer_normalized", clientsTrainerFilter);
    } else {
      // Admin's own trainer-filter dropdown also narrows the Clients tab
      // (per the dashboard's existing comment: "applies across
      // Upcoming/Past/Calendar, admin also gets Clients").
      const dropdownTrainer = searchParams.get("trainer");
      if (dropdownTrainer) clientRegsQuery = clientRegsQuery.eq("booked_trainer_normalized", normalizeDropdownTrainer(dropdownTrainer));
    }

    const [{ data: clientRegs }, { data: profilesRaw }, { data: referralCreditsRaw }] = await Promise.all([
      clientRegsQuery,
      supabase.from("profiles").select("email, phone, parent_name, kids, video_consent"),
      supabase.from("referral_credits").select("email, credits, total_referrals"),
    ]);

    const ownClientEmails = deriveOwnClientEmails(clientRegs || [], ctx);
    const profiles = scopeToOwnClients(profilesRaw, ownClientEmails);
    const referralCredits = scopeToOwnClients(referralCreditsRaw, ownClientEmails);
    const profilesMap = new Map(profiles.map((p) => [p.email, p]));
    const referralMap = new Map(referralCredits.map((r) => [r.email, r]));

    interface ClientSummary {
      name: string; email: string; phone: string; kids: string; athleteCount: number;
      count: number; lastDate: number; videoConsent: boolean | null; referralsAvailable: number; referralsTotal: number;
    }
    const clientMap = new Map<string, ClientSummary>();
    for (const r of clientRegs || []) {
      const key = r.email || r.parent_name;
      if (!key) continue;
      const d = dateMs(r.booked_date);
      const existing = clientMap.get(key);
      if (existing) {
        existing.count++;
        if (d > existing.lastDate) existing.lastDate = d;
        continue;
      }
      const profile = r.email ? profilesMap.get(r.email) : undefined;
      const rc = r.email ? referralMap.get(r.email) : undefined;
      const profileKids = (profile?.kids as { name?: string }[] | null) || null;
      const profileKidNames = profileKids?.length ? profileKids.map((k) => k.name).filter(Boolean) as string[] : null;
      const kidsDisplay = profileKidNames ? (profileKidNames.join(", ") || "—") : athleteNames(r.kids || "");
      const athleteCount = profileKidNames ? profileKidNames.length : (kidsDisplay === "—" ? 0 : kidsDisplay.split(",").length);
      // Prefer the live profiles.parent_name over this registration's own
      // (possibly years-stale) parent_name — a client who updates their name
      // in Settings only writes to profiles, never back onto their past
      // registration rows, so keying off r.parent_name here would keep
      // showing whichever name they typed at their very first-ever booking.
      // Falls back to r.parent_name for a guest client with no profiles row,
      // same fallback pattern already used for kids/videoConsent below.
      clientMap.set(key, {
        name: profile?.parent_name || r.parent_name, email: r.email, phone: r.phone, kids: kidsDisplay, athleteCount,
        count: 1, lastDate: d,
        videoConsent: profile?.video_consent ?? null,
        referralsAvailable: rc?.credits ?? 0,
        referralsTotal: rc?.total_referrals ?? 0,
      });
    }
    const clients = Array.from(clientMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ clients });
  }

  // Groups tab — admin-only management view over every saved athlete's
  // profile (grade/DOB/group assignments), independent of any registration
  // data. Split out from the old catch-all fetch below so opening the
  // dashboard doesn't pay for this (and the unbounded registrations dump
  // that fetch also did) on every load just in case Groups gets visited.
  if (view === "groups") {
    if (ctx.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: profiles } = await supabase.from("profiles").select("email, phone, parent_name, kids, video_consent");
    return NextResponse.json({ profiles: profiles || [] });
  }

  // Calendar fetches one month at a time as the admin navigates, instead of
  // being handed [...upcoming, ...past] the way it used to (which broke the
  // moment Past stopped always holding full history) — same status
  // exclusions as ?view=past, just scoped to a specific calendar month
  // instead of a rolling window. Month arithmetic is done as plain string
  // math, not via a JS Date + toISOString round-trip, which would risk the
  // exact server-timezone-vs-ET drift already found and fixed twice
  // elsewhere in this codebase.
  if (view === "calendar") {
    const calScopeError = requireTrainerNameConfigured(ctx);
    if (calScopeError) return calScopeError;

    const month = searchParams.get("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Missing or invalid month (expected YYYY-MM)" }, { status: 400 });
    }
    const [y, m] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    const nextMonthNum = m === 12 ? 1 : m + 1;
    const nextMonthYear = m === 12 ? y + 1 : y;
    const monthEndExclusive = `${nextMonthYear}-${String(nextMonthNum).padStart(2, "0")}-01`;

    let calQuery = supabase
      .from("registrations_with_parsed_date")
      .select("*")
      .neq("status", "payment_abandoned")
      .or("status.neq.cancelled,is_late_cancel.eq.true,camp_day_late_fee.gt.0")
      .gte("booked_date_parsed", monthStart)
      .lt("booked_date_parsed", monthEndExclusive)
      .order("booked_date_parsed", { ascending: true });
    const calTrainerFilter = trainerScopeFilter(ctx);
    if (calTrainerFilter) {
      calQuery = calQuery.eq("booked_trainer_normalized", calTrainerFilter);
    } else {
      // No role-based restriction (admin/elevated_trainer) — still honor
      // the dashboard's own trainer-filter dropdown if one is selected,
      // same "narrow the whole page to one trainer" behavior every other
      // tab already has.
      const dropdownTrainer = searchParams.get("trainer");
      if (dropdownTrainer) calQuery = calQuery.eq("booked_trainer_normalized", normalizeDropdownTrainer(dropdownTrainer));
    }

    const [{ data: calRegs }, { data: calPackages }] = await Promise.all([
      calQuery,
      supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    ]);
    const enrichedCal = await attachComputedFields(supabase, calRegs || [], calPackages || []);
    return NextResponse.json({ registrations: enrichedCal });
  }

  // Upcoming loads eagerly on every dashboard open (see the lazy-loading
  // plan) — a coarse SQL-level "today or later" filter first (backed by the
  // parse_booked_date functional index via the registrations_with_parsed_date
  // view, since PostgREST can't filter on an arbitrary function call
  // directly), then the caller does the exact "has this specific session's
  // start time already passed today" check client-side against the much
  // smaller result. "Today" is computed in America/New_York, not the
  // server's own (UTC) local time — the same class of bug already found
  // and fixed twice elsewhere in this codebase (payroll-sync.ts,
  // calendar-sync) if this used the server's raw local date instead.
  if (view === "upcoming") {
    const upcomingScopeError = requireTrainerNameConfigured(ctx);
    if (upcomingScopeError) return upcomingScopeError;

    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let upcomingQuery = supabase
      .from("registrations_with_parsed_date")
      .select("*")
      .in("status", ["confirmed", "pending_payment"])
      .gte("booked_date_parsed", todayET)
      .order("booked_date_parsed", { ascending: true });
    const upcomingTrainerFilter = trainerScopeFilter(ctx);
    if (upcomingTrainerFilter) {
      upcomingQuery = upcomingQuery.eq("booked_trainer_normalized", upcomingTrainerFilter);
    }

    const [{ data: upcomingRegs }, { data: upcomingPackages }] = await Promise.all([
      upcomingQuery,
      supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    ]);
    const enrichedUpcoming = await attachComputedFields(supabase, upcomingRegs || [], upcomingPackages || []);
    return NextResponse.json({ registrations: enrichedUpcoming });
  }

  // Past loads on-demand (first click into the tab), last 30 days by
  // default, with two ways to see further back: the "Load all" button
  // (window=all, drops the lower date bound) and typing into search — a
  // search term BYPASSES the window entirely and queries full history, so
  // browsing stays fast/bounded but searching never silently misses an
  // older session just because "Load all" was never clicked.
  if (view === "past") {
    const pastScopeError = requireTrainerNameConfigured(ctx);
    if (pastScopeError) return pastScopeError;

    const search = searchParams.get("search");
    const windowParam = searchParams.get("window") || "30d";
    const pastTrainerFilter = trainerScopeFilter(ctx);

    // Same "keep in history" exception the old client-side filter used —
    // an on-time cancellation is clutter once its date passes, but a late
    // cancellation/no-show that actually charged a fee is real activity
    // worth keeping visible.
    let pastQuery = supabase
      .from("registrations_with_parsed_date")
      .select("*")
      .neq("status", "payment_abandoned")
      .or("status.neq.cancelled,is_late_cancel.eq.true,camp_day_late_fee.gt.0");
    if (pastTrainerFilter) pastQuery = pastQuery.eq("booked_trainer_normalized", pastTrainerFilter);

    let hasMore = false;
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    if (search && search.trim()) {
      // Escape ilike's own wildcard characters in the user-supplied term —
      // otherwise a search containing a literal "%" or "_" would silently
      // match far more than intended (the exact class of bug already found
      // and fixed once in this same route's old ?email= branch).
      const escaped = search.trim().replace(/[%_]/g, (c) => `\\${c}`);
      pastQuery = pastQuery.or(`parent_name.ilike.%${escaped}%,email.ilike.%${escaped}%,phone.ilike.%${escaped}%`);
    } else {
      pastQuery = pastQuery.lte("booked_date_parsed", todayET);
      if (windowParam !== "all") {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffET = cutoff.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        pastQuery = pastQuery.gte("booked_date_parsed", cutoffET);

        let olderQuery = supabase
          .from("registrations_with_parsed_date")
          .select("id", { count: "exact", head: true })
          .neq("status", "payment_abandoned")
          .or("status.neq.cancelled,is_late_cancel.eq.true,camp_day_late_fee.gt.0")
          .lt("booked_date_parsed", cutoffET);
        if (pastTrainerFilter) olderQuery = olderQuery.eq("booked_trainer_normalized", pastTrainerFilter);
        const { count } = await olderQuery;
        hasMore = !!count && count > 0;
      }
    }

    pastQuery = pastQuery.order("booked_date_parsed", { ascending: false });

    const [{ data: pastRegs }, { data: pastPackages }] = await Promise.all([
      pastQuery,
      supabase.from("monthly_packages").select("id, email, package_type, month_year, is_paid").neq("status", "payment_abandoned"),
    ]);
    const enrichedPast = await attachComputedFields(supabase, pastRegs || [], pastPackages || []);
    return NextResponse.json({ registrations: enrichedPast, hasMore });
  }

  return NextResponse.json({ error: "Missing or unrecognized view parameter" }, { status: 400 });
}
