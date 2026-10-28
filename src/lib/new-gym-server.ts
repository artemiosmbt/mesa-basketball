// SERVER-ONLY (reads trainer phone numbers and the database) — the
// new-location callout for Diamond Charter sessions in client emails and
// texts. Shown only on a family's FIRST booking there (Artemios,
// 2026-10-28), with the number of the trainer running the session for
// anyone who can't find the gym.
import { createClient } from "@supabase/supabase-js";
import { getTrainerContact } from "@/lib/trainer-contacts";
import { trainerNamesMatch } from "@/lib/trainers";
import { NEW_GYM, mentionsNewGym } from "@/lib/new-gym";

const ARTEMIOS = { name: "Artemios", phone: "(631) 599-1280" };

// What families call each trainer (Artemios: "text or call Joe").
const SHORT_NAME: Record<string, string> = {
  "Joseph Owens": "Joe",
  "Zhaneia Thybulle": "Zhaneia",
  "Zain Amjad": "Zain",
  "Steven Papadimitropoulos": "Steven",
};

// Name + number to give a family for one trainer; Artemios (or an
// unassigned/unknown trainer, or one with no number on file) falls back to
// Artemios's own number.
export function trainerHelpContact(trainer: string | null | undefined): { name: string; phone: string } {
  if (!trainer || trainerNamesMatch(trainer, "Artemios Gavalas") || trainer.trim() === "TBD") return ARTEMIOS;
  const contact = getTrainerContact(trainer);
  if (!contact?.phone) return ARTEMIOS;
  return { name: SHORT_NAME[contact.trainerName] || contact.trainerName.split(" ")[0], phone: contact.phone };
}

export function helpLine(trainers: (string | null | undefined)[]): string {
  const seen = new Map<string, { name: string; phone: string }>();
  for (const t of trainers) {
    const c = trainerHelpContact(t);
    seen.set(c.phone, c);
  }
  const list = Array.from(seen.values()).map((c) => `${c.name} at ${c.phone}`);
  const who = list.length <= 1 ? list[0] : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
  return `Trouble finding the gym? Text or call ${who}.`;
}

function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

// How many sessions this family has (or had) at the new gym that are
// actually on: confirmed or a no-show. On-time cancellations and unpaid
// checkouts don't count — they never went.
async function newGymBookingCount(email: string): Promise<number> {
  const pattern = email.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { count, error } = await supabaseAdmin()
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .ilike("email", pattern)
    .ilike("booked_location", "%diamond charter%")
    .in("status", ["confirmed", "no_show"]);
  if (error) throw error;
  return count ?? 0;
}

export interface NewGymSession { location: string | null | undefined; trainer?: string | null }

/**
 * The callout for a client message, or empty strings when none applies.
 * `sessions` are the bookings this message is about — already saved, so
 * they're in the count themselves; it's shown only when this family has no
 * OTHER booking there, i.e. this is their first time. On a lookup failure it's
 * shown anyway (an extra reminder is harmless; a missing one isn't).
 */
export async function newGymNotes(email: string, sessions: NewGymSession[]): Promise<{ sms: string; html: string }> {
  const there = sessions.filter((s) => mentionsNewGym(s.location));
  if (there.length === 0) return { sms: "", html: "" };
  let first = true;
  try {
    first = (await newGymBookingCount(email)) <= there.length;
  } catch (err) {
    console.error("New-gym first-visit check failed; showing the callout:", err);
  }
  if (!first) return { sms: "", html: "" };
  const help = helpLine(there.map((s) => s.trainer));
  return {
    sms: `\n⚠️ NEW LOCATION: ${NEW_GYM.name}, 12 Westminster Rd, West Hempstead — not St. Paul's. ${help}`,
    html: `<div style="border: 2px solid #c4833e; background: #fdf8f6; border-radius: 8px; padding: 12px 14px; margin: 12px 0;">
    <p style="margin: 0 0 4px; font-weight: bold; color: #5c3d2e;">⚠️ NEW LOCATION — not St. Paul's</p>
    <p style="margin: 0;">${there.length > 1 ? "These sessions are" : "This session is"} at <strong>${NEW_GYM.name}</strong>, <a href="${NEW_GYM.mapsUrl}">${NEW_GYM.address}</a> (about 3 minutes from St. Paul's). Not every session is at St. Paul's anymore, so check the location on each one.</p>
    <p style="margin: 6px 0 0;">${help}</p>
  </div>`,
  };
}

/** Does this family already have a new-gym booking? (For messages that aren't about a booking of theirs.) */
export async function hasNewGymBooking(email: string): Promise<boolean> {
  try {
    return (await newGymBookingCount(email)) > 0;
  } catch {
    return false;
  }
}
