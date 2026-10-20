import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  bookableRange,
  formatDateLong,
  formatTime12,
  overlaps,
  practiceEnd,
  validateSlot,
  type StPaulsCoach,
} from "@/lib/stpauls";
import { sendStPaulsBookingAdminEmail, sendStPaulsBookingCoachEmail } from "@/lib/email";
import { sendAdminSMS, sendSMS } from "@/lib/sms";
import { getPracticesForEmail } from "@/lib/stpauls-server";

// Coach-facing St. Paul's practice booking. Any signed-in account can use
// it — the page itself is unlisted (only coaches with the link find it).
// Writes only to stpauls_practices, never registrations, so none of this
// reaches payroll, Payments, or the admin's regular session tabs.

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function getAuthedUser(req: NextRequest): Promise<{ id: string; email: string } | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email ? { id: user.id, email: user.email.toLowerCase().trim() } : null;
}

const hhmm = (t: string) => (t || "").slice(0, 5);

export async function GET(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { from, to } = bookableRange();
  const [{ data: booked, error }, mine, { data: profile }] = await Promise.all([
    supabase.from("stpauls_practices").select("practice_date, start_time, end_time")
      .eq("status", "booked").gte("practice_date", from).lte("practice_date", to),
    getPracticesForEmail(user.email).catch((e) => { console.error("St. Paul's own-practice load failed:", e); return []; }),
    supabase.from("profiles").select("parent_name, phone, sms_consent").eq("id", user.id).maybeSingle(),
  ]);
  if (error) {
    console.error("St. Paul's availability load failed:", error);
    return NextResponse.json({ error: "Couldn't load practice times." }, { status: 500 });
  }

  return NextResponse.json({
    // Other teams' bookings go out as bare times only — no names or contacts.
    taken: (booked || []).map((b) => ({ date: b.practice_date, start: hhmm(b.start_time), end: hhmm(b.end_time) })),
    mine: mine
      .filter((p) => p.status === "booked")
      // Pending until Artemios approves it by assigning a trainer. The coach
      // only ever sees Pending/Confirmed — never who or how.
      .map((p) => ({ id: p.id, date: p.practice_date, start: hhmm(p.start_time), end: hhmm(p.end_time), teamName: p.team_name, pending: !p.assigned_trainer }))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)),
    profile: profile ? { name: profile.parent_name || "", phone: profile.phone || "", smsConsent: !!profile.sms_consent } : null,
    email: user.email,
  });
}

const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const teamName = clean(body.teamName, 80);
  if (!teamName) return NextResponse.json({ error: "Enter your team name." }, { status: 400 });

  const coaches: StPaulsCoach[] = (Array.isArray(body.coaches) ? body.coaches : [])
    .slice(0, 6)
    .map((c: Record<string, unknown>) => ({ name: clean(c.name, 80), phone: clean(c.phone, 30), email: clean(c.email, 120).toLowerCase() }));
  if (coaches.length === 0) return NextResponse.json({ error: "Add at least one coach." }, { status: 400 });
  for (const c of coaches) {
    if (!c.name || c.phone.replace(/\D/g, "").length < 10 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
      return NextResponse.json({ error: "Every coach needs a name, phone number, and email." }, { status: 400 });
    }
  }

  const rawSlots: { date: string; start: string }[] = (Array.isArray(body.slots) ? body.slots : [])
    .slice(0, 40)
    .map((s: Record<string, unknown>) => ({ date: clean(s.date, 10), start: clean(s.start, 5) }));
  if (rawSlots.length === 0) return NextResponse.json({ error: "Pick at least one practice time." }, { status: 400 });
  for (const s of rawSlots) {
    const err = validateSlot(s.date, s.start);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  const slots = rawSlots.map((s) => ({ ...s, end: practiceEnd(s.start) }));
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (slots[i].date === slots[j].date && overlaps(slots[i].start, slots[i].end, slots[j].start, slots[j].end)) {
        return NextResponse.json({ error: "Two of the times you picked overlap. Practices are one hour each." }, { status: 400 });
      }
    }
  }

  const supabase = getSupabaseAdmin();

  // A brand-new coach account gets a minimal profile: no players, no
  // reminder emails (those are about group sessions for kids). An existing
  // account's profile is never touched — a parent who also coaches keeps
  // their kids and preferences exactly as they were — except that checking
  // the text box here opts them in (never out).
  const { data: existingProfile } = await supabase.from("profiles").select("id, phone, sms_consent").eq("id", user.id).maybeSingle();
  const optedIntoTexts = !!body.smsConsent || !!existingProfile?.sms_consent;
  if (existingProfile && body.smsConsent && !existingProfile.sms_consent) {
    const { error: consentError } = await supabase.from("profiles")
      .update({ sms_consent: true, updated_at: new Date().toISOString() }).eq("id", user.id);
    if (consentError) console.error("St. Paul's SMS opt-in save failed:", consentError);
  }
  if (!existingProfile) {
    const primary = coaches.find((c) => c.email === user.email) || coaches[0];
    const { error: profileError } = await supabase.from("profiles").insert({
      id: user.id,
      email: user.email,
      parent_name: clean(body.accountName, 80) || primary.name,
      phone: clean(body.accountPhone, 30) || primary.phone,
      kids: [],
      sms_consent: !!body.smsConsent,
      marketing_emails: false,
      reminder_emails: false,
      updated_at: new Date().toISOString(),
    });
    if (profileError) console.error("St. Paul's coach profile create failed:", profileError);
  }

  // One insert for every picked time — all-or-nothing, and the table's
  // no-overlap constraint rejects the whole batch if any time was just taken.
  const rows = slots.map((s) => ({
    practice_date: s.date,
    start_time: s.start,
    end_time: s.end,
    team_name: teamName,
    coaches,
    booked_by_user_id: user.id,
    booked_by_email: user.email,
    booked_by_name: coaches.find((c) => c.email === user.email)?.name || coaches[0].name,
  }));
  const { error: insertError } = await supabase.from("stpauls_practices").insert(rows);
  if (insertError) {
    if (insertError.code === "23P01") {
      return NextResponse.json({ error: "Another team just booked one of those times. Please pick again." }, { status: 409 });
    }
    console.error("St. Paul's practice insert failed:", insertError);
    return NextResponse.json({ error: "Couldn't book those practices. Please try again." }, { status: 500 });
  }

  const sorted = [...slots].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const practices = sorted.map((s) => ({ date: formatDateLong(s.date), time: `${formatTime12(s.start)}–${formatTime12(s.end)}` }));
  // A booking is only a REQUEST until Artemios approves it (by assigning a
  // trainer in admin) — every message here says so plainly. "Request
  // received" text only to the account that booked, and only with SMS
  // consent — the other listed coaches never agreed to texts (they get the
  // email). Sent to the phone they just typed for themselves.
  const bookerPhone = coaches.find((c) => c.email === user.email)?.phone || existingProfile?.phone || coaches[0].phone;
  const confirmText = optedIntoTexts && bookerPhone
    ? sendSMS(bookerPhone, `Mesa Basketball: We got ${teamName}'s practice request for ${practices.map((p) => `${p.date}, ${p.time}`).join("; ")} at St. Paul's. It is NOT confirmed yet - we'll text you once it's confirmed. Questions? Text Artemios at (631) 599-1280. Reply STOP to opt out.`)
    : Promise.resolve();
  await Promise.allSettled([
    confirmText,
    sendStPaulsBookingAdminEmail({ teamName, coaches, practices }),
    sendAdminSMS(`NEW St. Paul's practice REQUEST (pending): ${teamName}, ${practices.map((p) => `${p.date} ${p.time}`).join("; ")}. Assign a trainer in admin to approve it, or cancel it to decline.`),
    ...coaches.map((c) => sendStPaulsBookingCoachEmail({ to: c.email, coachName: c.name, teamName, practices })),
  ]);

  return NextResponse.json({ ok: true, booked: sorted.length });
}
