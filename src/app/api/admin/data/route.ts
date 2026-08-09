import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyDashboardAccess } from "@/lib/auth";
import { requireTrainerNameConfigured, trainerScopeFilter, deriveOwnClientEmails, scopeToOwnClients } from "@/lib/admin-data-scope";
import { attachComputedFields } from "@/lib/admin-registration-enrichment";


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
    const { data: registrations } = await supabase
      .from("registrations")
      .select("id, type, booked_date, booked_start_time, booked_end_time")
      .eq("email", emailFilter.trim().toLowerCase())
      .order("booked_date", { ascending: true });
    return NextResponse.json({ registrations: registrations || [] });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const scopeError = requireTrainerNameConfigured(ctx);
  if (scopeError) return scopeError;

  let registrationsQuery = supabase.from("registrations").select("*").order("created_at", { ascending: false });
  // A plain trainer account only ever sees their own schedule — scoped at
  // the query itself so their browser never receives another trainer's
  // clients' contact info in the first place, not just a UI that hides it.
  const trainerFilter = trainerScopeFilter(ctx);
  if (trainerFilter) {
    registrationsQuery = registrationsQuery.ilike("booked_trainer", trainerFilter);
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
  // browser in full, regardless of role, until this was fixed. Scope these
  // the same way registrations already is: down to only the clients who
  // actually appear in THIS trainer's own scoped registrations. Elevated
  // trainers and admin are unaffected (they're meant to see everyone).
  const ownClientEmails = deriveOwnClientEmails(registrations || [], ctx);
  const profiles = scopeToOwnClients(profilesRaw, ownClientEmails);
  const referralCredits = scopeToOwnClients(referralCreditsRaw, ownClientEmails);
  const accountCredits = scopeToOwnClients(accountCreditsRaw, ownClientEmails);
  const lateFeeEvents = scopeToOwnClients(lateFeeEventsRaw, ownClientEmails);

  // Package-membership badges and bulk-discount pricing need to see each
  // client's complete relevant history (one month, or one booking batch) to
  // compute correctly — done server-side here (not left to the client-side
  // useMemos this replaces) specifically so this stays correct once other
  // views start returning partial windows instead of everything.
  const enrichedRegistrations = await attachComputedFields(supabase, registrations || [], packages || []);

  return NextResponse.json({ registrations: enrichedRegistrations, profiles: profiles || [], referralCredits: referralCredits || [], packages: packages || [], accountCredits: accountCredits || [], lateFeeEvents: lateFeeEvents || [] });
}
