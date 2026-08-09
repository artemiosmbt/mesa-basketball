// SERVER-ONLY — never import this from a "use client" component, or from
// any module a client component imports (that's exactly why phone numbers
// were moved out of src/lib/auth.ts's TRAINER_ACCOUNTS: that file is shared
// with client nav components for role/nav-link resolution, and anything
// referenced there ends up in a public, unauthenticated JS bundle). Only
// src/lib/trainer-notify.ts imports this, which is itself only ever used
// from server-side API routes.
import { TRAINER_ACCOUNTS } from "@/lib/auth";
import { trainerNamesMatch } from "@/lib/trainers";

// Notification phone (SMS) numbers, keyed by the exact trainerName spelling
// configured in auth.ts's TRAINER_ACCOUNTS. Omit an entry if that trainer
// doesn't want texts — notifyTrainerOfNewBooking/Cancellation/Reschedule
// each independently no-op on a missing phone, same as a missing email.
const PHONE_BY_TRAINER_NAME: Record<string, string> = {
  "Joseph Owens": "516-439-6467",
  "Zhaneia Thybulle": "347-355-1168",
  "Zain Amjad": "516-303-5963",
  "Steven Papadimitropoulos": "929-465-3066",
  "Tristan Wissemann": "631-793-4868",
};

export interface TrainerContact {
  trainerName: string;
  email?: string;
  phone?: string;
}

// Looks up a trainer's contact info by their exact schedule-sheet name (the
// same string stored in booked_trainer) — used to notify THEM (not just the
// admin) about their own bookings. Returns null for Artemios (not in
// TRAINER_ACCOUNTS — he already gets every admin notification) or any name
// with no matching account, so a sheet typo just means that trainer's
// notification silently doesn't fire, rather than erroring the booking.
export function getTrainerContact(trainerName: string | null | undefined): TrainerContact | null {
  if (!trainerName) return null;
  // Normalized comparison (not exact ===) — trainerName here is whatever
  // casing was live on the hand-typed schedule sheet at booking/reassignment
  // time, which can drift from the exact spelling configured in auth.ts.
  // Without this, a stray capitalization difference would silently no-op
  // every notification for a real, configured trainer — the same class of
  // gap payroll-sync.ts already had to guard against for its own matching.
  const account = TRAINER_ACCOUNTS.find((t) => trainerNamesMatch(t.trainerName, trainerName));
  if (!account || !account.trainerName) return null;
  return {
    trainerName: account.trainerName,
    email: account.email,
    phone: PHONE_BY_TRAINER_NAME[account.trainerName],
  };
}
