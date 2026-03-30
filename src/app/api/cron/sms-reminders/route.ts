import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

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

  const bookedPhones = new Set(alreadyBooked.map((r) => r.phone));

  // Deduplicate opted-in phones and exclude anyone already booked this week
  const phonesToText = [
    ...new Set(optedIn.map((r) => r.phone)),
  ].filter((phone) => phone && !bookedPhones.has(phone));

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
        to: phone,
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send SMS to ${phone}:`, err);
      failed++;
    }
  }

  return NextResponse.json({ sent, failed, skipped: bookedPhones.size, total: optedIn.length });
}
