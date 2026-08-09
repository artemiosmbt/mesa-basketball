import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export const ADMIN_EMAIL = "artemios@mesabasketballtraining.com";

// Every /api/cron/* route uses this to authenticate Vercel Cron's own
// invocation. Requiring CRON_SECRET to actually be set (not just comparing
// the header to it) matters: `authHeader !== \`Bearer ${process.env.CRON_SECRET}\``
// alone fails OPEN if the env var were ever unset in production — it'd
// silently become a literal comparison against the string "Bearer
// undefined", which anyone could send. Centralized here so all ten cron
// routes share one fail-closed check instead of ten copies that could
// individually drift.
export function verifyCronSecret(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  return !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

// Trainer dashboard accounts — Upcoming/Past/Calendar/Packages only, no
// Clients tab, no stats row, read-only everywhere except marking a session
// No Show (Cancel/Reschedule/Delete/Add-Player/payment edits stay exclusive
// to ADMIN_EMAIL). "elevated" additionally gets the all-trainers filter
// dropdown on Upcoming/Past/Calendar and sees every trainer's bookings
// there instead of just their own — reserved for whoever oversees every
// trainer (e.g. the gym's on-site overseer), not a regular trainer. A plain
// "trainer" only ever sees their own schedule — trainerName must exactly
// match the booked_trainer values on the schedule sheet/registrations, and
// is enforced server-side (not just hidden in the UI) so that account's
// browser never even receives another trainer's clients' contact info.
// To add a trainer: have them sign up normally on the site, then add a row
// here with their login email and redeploy. trainerName is only needed
// (and only meaningful) for role "trainer" — omit it for "elevated_trainer".
//
// Deliberately holds NO phone numbers. This file is imported by several
// "use client" components (nav bars, the admin dashboard) for role/nav-link
// resolution — anything referenced here ends up baked into a public,
// unauthenticated JS bundle that ships to every site visitor, not just
// logged-in trainers. Notification phone numbers live in the server-only
// src/lib/trainer-contacts.ts instead, which nothing client-side ever
// imports. Learned this the hard way: phone numbers used to live directly
// on this array and were confirmed (via a build + bundle grep) to be
// present in a publicly-fetchable static chunk.
export interface TrainerAccount {
  email: string;
  role: "trainer" | "elevated_trainer";
  trainerName?: string;
}

export const TRAINER_ACCOUNTS: TrainerAccount[] = [
  { email: "ckaterinakis@hchc.edu", role: "elevated_trainer" },
  // { email: "coach@example.com", role: "trainer", trainerName: "John Smith" },
  { email: "giftedtraining24@gmail.com", role: "trainer", trainerName: "Joseph Owens" },
  { email: "zthybulle@gmail.com", role: "trainer", trainerName: "Zhaneia Thybulle" },
  { email: "zamjadh786@gmail.com", role: "trainer", trainerName: "Zain Amjad" },
  { email: "sjpapadi@gmail.com", role: "trainer", trainerName: "Steven Papadimitropoulos" },
  { email: "wissemanntristan@gmail.com", role: "trainer", trainerName: "Tristan Wissemann" },
];

export type AuthRole = "admin" | "elevated_trainer" | "trainer";

export interface AuthContext {
  email: string;
  role: AuthRole;
  // Only set for role "trainer" — the exact booked_trainer value their view
  // (server and client) is scoped down to.
  trainerName?: string;
}

// Pure email → role lookup, shared by both the server (getAuthContext,
// after verifying the bearer token) and client components (which already
// have a verified session's email from Supabase and don't need to re-prove
// it against a token here).
export function resolveAuthRole(email: string | null | undefined): AuthContext | null {
  if (!email) return null;
  if (email === ADMIN_EMAIL) return { email, role: "admin" };
  const trainer = TRAINER_ACCOUNTS.find((t) => t.email === email);
  if (!trainer) return null;
  return { email, role: trainer.role, trainerName: trainer.trainerName };
}

let _client: SupabaseClient | null = null;

// Lazily initialized client for auth operations
export const authClient = {
  get auth() {
    if (!_client) {
      _client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { flowType: "implicit" } }
      );
    }
    return _client.auth;
  },
};

// Login/signup redirect via ?next= must only ever go to a path on this same
// site — an unchecked value lets an attacker send
// `/login?next=https://evil.example.com`, so a victim logs in for real on
// the legitimate domain and is then bounced straight to a phishing page
// right after a trusted auth flow. Only a same-origin relative path
// (leading "/", never "//" which browsers treat as protocol-relative to
// another host) is allowed; anything else falls back to "/".
export function safeRedirectPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

// Resolves a bearer token to whichever recognized dashboard role (if any)
// it belongs to — the full admin, or one of the configured trainer
// accounts. Returns null for anyone else.
export async function getAuthContext(req: NextRequest): Promise<AuthContext | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await authClient.auth.getUser(token);
  return resolveAuthRole(user?.email);
}

// Shared admin check for every /api/admin/* WRITE route — every route that
// changes data must call this before any mutation. Trainer accounts are
// read-only dashboards and must never pass this, no matter their role.
export async function verifyAdmin(req: NextRequest): Promise<boolean> {
  const ctx = await getAuthContext(req);
  return ctx?.role === "admin";
}

// For read-only dashboard routes that trainer accounts may also load (the
// admin data feed, the packages list). Callers still MUST apply
// ctx.trainerName scoping themselves when role is "trainer" — this only
// confirms the caller is a recognized account, not what they're allowed to
// see within that account.
export async function verifyDashboardAccess(req: NextRequest): Promise<AuthContext | null> {
  return getAuthContext(req);
}
