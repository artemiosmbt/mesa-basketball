import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyDashboardAccess } from "@/lib/auth";
import { requireTrainerNameConfigured, trainerScopeFilter, normalizeDropdownTrainer, deriveOwnClientEmails, scopeToOwnClients } from "@/lib/admin-data-scope";
import { attachComputedFields } from "@/lib/admin-registration-enrichment";
import { getWeeklySchedule, getPrivateSlots, parseTimeToMins } from "@/lib/sheets";
import { getGroupSessionEnrollment } from "@/lib/supabase";
import { trainerNamesMatch } from "@/lib/trainers";

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

// --- Ported verbatim from backfill-athlete-profiles/route.ts's
// parseKidsList/playerLabel + DOB/Grade/Gender regex pulls, for the
// ?view=groups missing-athlete backfill below. ---
function parseKidsStringForGroupsView(kidsStr: string): { name: string; dob: string; grade: string; gender?: string }[] {
  const parts = !kidsStr.trim()
    ? []
    : kidsStr.includes("(")
    ? kidsStr.split("), ").map((p, i, arr) => (i < arr.length - 1 ? p + ")" : p)).filter((s) => s.trim())
    : kidsStr.split(",").map((s) => s.trim()).filter(Boolean);
  return parts
    .map((p) => {
      const idx = p.indexOf(" (");
      const name = (idx > -1 ? p.substring(0, idx) : p).trim();
      const dobMatch = p.match(/DOB:\s*([^,)]+)/i);
      const gradeMatch = p.match(/Grade:\s*([^,)]+)/i);
      const genderMatch = p.match(/Gender:\s*(Male|Female)/i);
      return {
        name,
        dob: dobMatch ? dobMatch[1].trim() : "",
        grade: gradeMatch ? gradeMatch[1].trim() : "",
        gender: genderMatch ? genderMatch[1].trim().toLowerCase() : undefined,
      };
    })
    .filter((k) => k.name);
}
function normalizeNameForGroupsView(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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
    const { data: profiles } = await supabase.from("profiles").select("id, email, phone, parent_name, kids, video_consent");

    // Same backfill as supabase-migration-athlete-ids-and-groups.sql, done
    // lazily here instead of as a one-time migration: the admin/page.tsx
    // Groups tab silently drops any kid missing an `id` from EVERY bucket
    // (including "All Else") since every group-assign/hide/merge action
    // needs a stable id to target a specific kid. Idempotent — a kid that
    // already has both fields is returned untouched — so safe to run on
    // every fetch of this view, keeping every saved athlete visible without
    // ever needing another manual migration run.
    const backfillRows: { id: string; kids: unknown }[] = [];
    for (const p of profiles || []) {
      if (!Array.isArray(p.kids) || p.kids.length === 0) continue;
      let changed = false;
      const fixedKids = p.kids.map((k: Record<string, unknown>) => {
        if (k.id && Array.isArray(k.groups)) return k;
        changed = true;
        return { ...k, id: k.id || crypto.randomUUID(), groups: Array.isArray(k.groups) ? k.groups : [] };
      });
      if (changed) {
        p.kids = fixedKids;
        backfillRows.push({ id: p.id, kids: fixedKids });
      }
    }
    if (backfillRows.length > 0) {
      await Promise.all(
        backfillRows.map((row) =>
          supabase.from("profiles").update({ kids: row.kids, updated_at: new Date().toISOString() }).eq("id", row.id)
        )
      );
    }

    // Also creates any athlete with real registration history under an
    // account-holding client's email who was never saved to profiles.kids
    // at all (e.g. booked before that client created an account, or some
    // other gap in the save-on-booking path) — matched by name only, never
    // guessing a group, so a newly-created entry starts empty and lands in
    // "All Else" for the admin to sort through by hand. A true guest client
    // (no account, no profiles row at all — profiles.id has a hard FK to
    // auth.users.id) can't be created here; those still only ever show up
    // in the Clients tab.
    const accountEmails = (profiles || []).map((p) => (p.email || "").toLowerCase().trim()).filter(Boolean);
    if (accountEmails.length > 0) {
      const { data: regs } = await supabase
        .from("registrations")
        .select("email, kids")
        .neq("status", "payment_abandoned")
        .in("email", accountEmails);

      const kidsSeenByEmail = new Map<string, Map<string, { name: string; dob: string; grade: string; gender?: string }>>();
      for (const r of regs || []) {
        const email = (r.email || "").toLowerCase().trim();
        if (!email || !r.kids) continue;
        if (!kidsSeenByEmail.has(email)) kidsSeenByEmail.set(email, new Map());
        const bucket = kidsSeenByEmail.get(email)!;
        for (const kid of parseKidsStringForGroupsView(r.kids)) {
          const key = normalizeNameForGroupsView(kid.name);
          if (!bucket.has(key)) bucket.set(key, kid);
        }
      }

      const createRows: { id: string; kids: unknown }[] = [];
      for (const p of profiles || []) {
        const email = (p.email || "").toLowerCase().trim();
        const seen = kidsSeenByEmail.get(email);
        if (!seen) continue;
        const kids: Record<string, unknown>[] = Array.isArray(p.kids) ? p.kids : [];
        const grown = [...kids];
        let changed = false;
        for (const [nameKey, parsed] of seen) {
          const alreadyExists = grown.some((k) => normalizeNameForGroupsView((k.name as string) || "") === nameKey);
          if (alreadyExists) continue;
          grown.push({ id: crypto.randomUUID(), name: parsed.name, dob: parsed.dob, grade: parsed.grade, gender: parsed.gender || "", groups: [] });
          changed = true;
        }
        if (changed) {
          p.kids = grown;
          createRows.push({ id: p.id, kids: grown });
        }
      }
      if (createRows.length > 0) {
        await Promise.all(
          createRows.map((row) =>
            supabase.from("profiles").update({ kids: row.kids, updated_at: new Date().toISOString() }).eq("id", row.id)
          )
        );
      }
    }

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

  // "What am I actually scheduled to run" — read straight from the
  // schedule sheet, independent of whether anyone's booked yet, so a
  // trainer with zero bookings still sees "you're on the hook for HS Boys
  // tomorrow at 6pm" instead of an empty dashboard. Deliberately separate
  // from ?view=upcoming (real bookings only) — see admin/page.tsx's
  // "Schedule" tab.
  if (view === "roster") {
    const rosterScopeError = requireTrainerNameConfigured(ctx);
    if (rosterScopeError) return rosterScopeError;

    const dropdownTrainer = searchParams.get("trainer");
    const scopeTrainer = ctx.role === "trainer"
      ? ctx.trainerName!
      : (dropdownTrainer && dropdownTrainer !== "all" ? dropdownTrainer : null);

    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const getP = (t: string) => etParts.find((p) => p.type === t)?.value ?? "0";
    const todayISO = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const nowMins = parseInt(getP("hour")) * 60 + parseInt(getP("minute"));

    // Same "today or later, and if today then not-yet-started" rule as
    // /api/schedule's own isUpcoming — computed in ET, not the server's UTC
    // local time (the same class of bug already found and fixed twice
    // elsewhere in this codebase if this used raw server local time).
    function rowIsUpcoming(dateStr: string, startTime: string): boolean {
      const d = new Date(dateStr + " 12:00:00");
      if (isNaN(d.getTime())) return false;
      const rowISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (rowISO > todayISO) return true;
      if (rowISO < todayISO) return false;
      return parseTimeToMins(startTime) > nowMins;
    }

    const [weeklySessions, privateSlotsAll, enrollment] = await Promise.all([
      getWeeklySchedule(),
      getPrivateSlots(),
      getGroupSessionEnrollment(),
    ]);

    const groupSessions = weeklySessions
      .filter((s) => s.date && s.startTime && rowIsUpcoming(s.date, s.startTime))
      .filter((s) => !scopeTrainer || trainerNamesMatch(s.trainer, scopeTrainer))
      .map((s) => {
        const trainer = s.trainer || "Artemios Gavalas";
        // Matches getGroupSessionEnrollment's own key exactly (see its
        // comment on why weekly rows key on trainer too — two same-named
        // groups run by different trainers at the same date+time never
        // share a capacity pool).
        const key = `${s.date}|${s.startTime}|${s.group}|${trainer}`;
        return {
          date: s.date, startTime: s.startTime, endTime: s.endTime, location: s.location,
          group: s.group, trainer, maxSpots: s.maxSpots, enrolled: enrollment[key] || 0,
        };
      })
      .sort((a, b) => dateMs(a.date) - dateMs(b.date) || parseTimeToMins(a.startTime) - parseTimeToMins(b.startTime));

    const relevantPrivateSlots = privateSlotsAll
      .filter((s) => s.available && s.date && s.startTime && rowIsUpcoming(s.date, s.startTime))
      .filter((s) => !scopeTrainer || trainerNamesMatch(s.trainer, scopeTrainer))
      .sort((a, b) => {
        const dm = dateMs(a.date) - dateMs(b.date);
        if (dm !== 0) return dm;
        if (a.location !== b.location) return a.location.localeCompare(b.location);
        const tA = a.trainer || "Artemios Gavalas", tB = b.trainer || "Artemios Gavalas";
        if (tA !== tB) return tA.localeCompare(tB);
        return parseTimeToMins(a.startTime) - parseTimeToMins(b.startTime);
      });

    // Merge consecutive (touching) same date/location/trainer rows into one
    // readable window instead of a wall of individual 1-hour cards — same
    // idea as the public booking page's own private-slot window merging.
    const privateWindows: { date: string; startTime: string; endTime: string; location: string; trainer: string }[] = [];
    for (const s of relevantPrivateSlots) {
      const trainer = s.trainer || "Artemios Gavalas";
      const last = privateWindows[privateWindows.length - 1];
      if (last && last.date === s.date && last.location === s.location && last.trainer === trainer && last.endTime === s.startTime) {
        last.endTime = s.endTime;
      } else {
        privateWindows.push({ date: s.date, startTime: s.startTime, endTime: s.endTime, location: s.location, trainer });
      }
    }

    return NextResponse.json({ groupSessions, privateWindows });
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
