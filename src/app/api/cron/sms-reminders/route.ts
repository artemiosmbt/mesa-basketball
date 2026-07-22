import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// Last 10 digits, ignoring any formatting ("(555) 123-4567" vs "5551234567")
// or leading country code — used purely for matching/deduping the SAME real
// phone number across rows that may have been entered differently, not for
// the outgoing Twilio "to" field (formatPhone handles that).
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only run on Sundays (0 = Sunday)
  const now = new Date();
  if (now.getUTCDay() !== 0) {
    return NextResponse.json({ sent: 0, message: "Not Sunday, skipping" });
  }

  // Upcoming week = tomorrow (Monday) through the following Sunday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + 1);
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  const mondayStr = monday.toISOString().split("T")[0];
  const sundayStr = sunday.toISOString().split("T")[0];

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Claim this week BEFORE sending anything — week_start is the primary
  // key, so an overlapping run (retry, manual re-trigger) fails to insert
  // and skips the whole blast instead of texting every opted-in client twice.
  const { error: claimError } = await supabase
    .from("sms_reminder_runs")
    .insert({ week_start: mondayStr });
  if (claimError) {
    return NextResponse.json({ sent: 0, message: "Already ran for this week" });
  }

  // Get all opted-in phone numbers
  const { data: optedIn, error: optedInError } = await supabase
    .from("registrations")
    .select("phone")
    .eq("sms_consent", true);

  if (optedInError) {
    console.error("Failed to fetch opted-in registrations:", optedInError);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // Get phone numbers that already have a booking in the upcoming week
  const { data: alreadyBooked, error: bookedError } = await supabase
    .from("registrations")
    .select("phone")
    .gte("booked_date", mondayStr)
    .lte("booked_date", sundayStr)
    .not("booked_date", "is", null);

  if (bookedError) {
    console.error("Failed to fetch booked registrations:", bookedError);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // Matched on normalized digits — the same real phone number stored with
  // different formatting across rows ("(555) 123-4567" vs "5551234567")
  // must still be recognized as already-booked (and deduped), or someone
  // could get texted despite already having a session this week, or get
  // texted twice under two differently-formatted entries.
  const bookedPhones = new Set(
    alreadyBooked.map((r) => normalizePhone(r.phone || "")).filter(Boolean)
  );

  const seenNormalized = new Set<string>();
  const phonesToText: string[] = [];
  for (const r of optedIn) {
    if (!r.phone) continue;
    const norm = normalizePhone(r.phone);
    if (!norm || seenNormalized.has(norm) || bookedPhones.has(norm)) continue;
    seenNormalized.add(norm);
    phonesToText.push(r.phone);
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  let sent = 0;
  let failed = 0;

  for (const phone of phonesToText) {
    try {
      await client.messages.create({
        body: "Mesa Basketball: Don't forget to book your group or individual session this week! Reserve your spot at mesabasketballtraining.com. Reply STOP to opt out.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: formatPhone(phone),
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send SMS to ${phone}:`, err);
      failed++;
    }
  }

  await supabase.from("sms_reminder_runs").update({ texts_sent: sent }).eq("week_start", mondayStr);

  return NextResponse.json({ sent, failed, skipped: bookedPhones.size, total: optedIn.length });
}
