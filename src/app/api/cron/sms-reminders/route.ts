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

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get all unique phone numbers that have opted in to SMS
  const { data: registrations, error } = await supabase
    .from("registrations")
    .select("phone")
    .eq("sms_consent", true);

  if (error) {
    console.error("Failed to fetch registrations:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // Deduplicate phone numbers
  const uniquePhones = [...new Set(registrations.map((r) => r.phone))].filter(Boolean);

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  let sent = 0;
  let failed = 0;

  for (const phone of uniquePhones) {
    try {
      await client.messages.create({
        body: "Mesa Basketball: Don't forget to book your session this week! Reserve your spot at mesabasketballtraining.com. Reply STOP to opt out.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send SMS to ${phone}:`, err);
      failed++;
    }
  }

  return NextResponse.json({ sent, failed, total: uniquePhones.length });
}
