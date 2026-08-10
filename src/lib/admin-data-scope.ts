import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth";
import { normalizeTrainerNameForComparison } from "@/lib/trainers";

// Shared trainer-role scoping for every /api/admin/data* view. Extracted
// from what used to be one inline copy of this logic in admin/data/route.ts
// — a prior audit found a real PII leak from this exact class of gap
// (a scoping check applied to one query but forgotten on a sibling one), so
// as this route splits into several view-specific queries, the scoping
// logic itself must live in exactly one place rather than be copy-pasted
// and risk drifting out of sync across them.

// A misconfigured TRAINER_ACCOUNTS row (role: "trainer" but no trainerName
// set) must fail CLOSED, not open — every scoping helper below is gated on
// ctx.trainerName being truthy, so silently letting this through would skip
// all of them and hand this account every client's full data sitewide
// instead of the intended narrow scope. Checked once, up front.
export function requireTrainerNameConfigured(ctx: AuthContext): NextResponse | null {
  if (ctx.role === "trainer" && !ctx.trainerName) {
    return NextResponse.json({ error: "Trainer account is missing its name configuration — contact the admin." }, { status: 403 });
  }
  return null;
}

// The trainer name a registrations query should be scoped to, pre-
// normalized (trim, lowercase, whitespace-collapsed — matches
// normalizeTrainerNameForComparison exactly) for comparison against the
// booked_trainer_normalized column (see
// supabase-migration-admin-dashboard-trainer-normalize.sql), or null if
// this role sees every trainer's bookings (admin/elevated_trainer).
// booked_trainer is whatever casing/spacing was live on the hand-typed
// schedule sheet at booking time, which can drift from the exact text
// configured in TRAINER_ACCOUNTS — a bare .ilike() only forgives a casing
// difference, not a whitespace one, which is exactly the gap this
// normalized-column comparison closes.
export function trainerScopeFilter(ctx: AuthContext): string | null {
  return ctx.role === "trainer" ? normalizeTrainerNameForComparison(ctx.trainerName!) : null;
}

// Same normalization, for the admin dashboard's own trainer-filter
// dropdown value (a non-security, "narrow what I'm looking at" filter) —
// needs the identical treatment so it matches booked_trainer_normalized
// too.
export function normalizeDropdownTrainer(raw: string): string {
  return normalizeTrainerNameForComparison(raw);
}

// Derives the "clients this trainer is actually allowed to see" set from
// their own already-scoped registrations — used to scope secondary tables
// (profiles, referral_credits, account_credits, late_fee_events) that have
// no booked_trainer column of their own to filter on directly.
export function deriveOwnClientEmails(
  registrations: { email?: string | null }[],
  ctx: AuthContext
): Set<string> | null {
  if (ctx.role !== "trainer") return null;
  return new Set(registrations.map((r) => (r.email || "").toLowerCase().trim()).filter(Boolean));
}

// Applies the set derived above to any table keyed by email. A null
// ownClientEmails (non-trainer role) means "no scoping needed" — the full
// list passes through unfiltered.
export function scopeToOwnClients<T extends { email?: string | null }>(
  rows: T[] | null,
  ownClientEmails: Set<string> | null
): T[] {
  const list = rows || [];
  return ownClientEmails ? list.filter((r) => ownClientEmails.has((r.email || "").toLowerCase().trim())) : list;
}
