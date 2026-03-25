import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { getCamps } from "@/lib/sheets";

const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "College +"];

// Parse grade range from camp name, e.g. "Grades 6-8 Summer Camp" → ["6","7","8"]
// Returns null if no grade range found (treat as all grades)
function getGradeRangeForCamp(campName: string): Set<string> | null {
  const match = campName.match(/Grades?\s+(K|\d+)[–\-](\d+|College\s*\+?)/i);
  if (!match) return null;
  const start = match[1].toUpperCase();
  const end = match[2].replace(/\s+/g, " ").trim();
  const endVal = end.toLowerCase().startsWith("college") ? "College +" : end;
  const si = GRADE_ORDER.indexOf(start);
  const ei = GRADE_ORDER.indexOf(endVal);
  if (si === -1 || ei === -1) return null;
  return new Set(GRADE_ORDER.slice(si, ei + 1));
}

// Extract all grades from a kids string like:
// "John (DOB: 2012-05-15, Grade: 7), Jane (DOB: 2013-08-20, Grade: K)"
function extractGradesFromKids(kids: string): string[] {
  const grades: string[] = [];
  const regex = /Grade:\s*([^,)]+)/gi;
  let match;
  while ((match = regex.exec(kids)) !== null) {
    grades.push(match[1].trim());
  }
  return grades;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch current camps from Google Sheets
  const camps = await getCamps();
  if (camps.length === 0) {
    return NextResponse.json({ message: "No camps found" });
  }

  // Get camps we've already notified about
  const { data: alreadyNotified, error: notifiedError } = await supabase
    .from("camp_notifications")
    .select("camp_id");

  if (notifiedError) {
    console.error("Failed to fetch camp_notifications:", notifiedError);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  const notifiedIds = new Set((alreadyNotified || []).map((r) => r.camp_id));

  // Find new camps that are marked ready to notify and haven't been notified yet
  const newCamps = camps.filter((camp) => {
    const campId = `${camp.name}|${camp.startDate}`;
    return camp.name && camp.startDate && camp.notify && !notifiedIds.has(campId);
  });

  if (newCamps.length === 0) {
    return NextResponse.json({ message: "No new camps", checked: camps.length });
  }

  // Fetch all opted-in registrations
  const { data: registrations, error: regError } = await supabase
    .from("registrations")
    .select("phone, kids")
    .eq("sms_consent", true)
    .eq("status", "confirmed");

  if (regError) {
    console.error("Failed to fetch registrations:", regError);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const results = [];

  for (const camp of newCamps) {
    const campId = `${camp.name}|${camp.startDate}`;
    const gradeRange = getGradeRangeForCamp(camp.name);

    // Find phones where at least one kid is in the grade range (or camp has no grade restriction)
    const phonesToText = new Set<string>();
    for (const reg of registrations || []) {
      if (!reg.phone) continue;
      if (gradeRange === null) {
        // No grade restriction — text everyone
        phonesToText.add(reg.phone);
      } else {
        const kidGrades = extractGradesFromKids(reg.kids || "");
        const hasMatchingKid = kidGrades.some((g) => gradeRange.has(g));
        if (hasMatchingKid) {
          phonesToText.add(reg.phone);
        }
      }
    }

    const message =
      `Mesa Basketball: New camp just added — ${camp.name}! ` +
      `${camp.startDate}${camp.endDate && camp.endDate !== camp.startDate ? ` to ${camp.endDate}` : ""} ` +
      `at ${camp.location}. ${camp.price ? `$${camp.price}. ` : ""}` +
      `Book your spot at mesabasketballtraining.com/schedule#camps. Reply STOP to opt out.`;

    let sent = 0;
    let failed = 0;

    for (const phone of phonesToText) {
      try {
        await twilioClient.messages.create({
          body: message,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
        sent++;
      } catch (err) {
        console.error(`Failed to send SMS to ${phone}:`, err);
        failed++;
      }
    }

    // Record that we've notified for this camp
    await supabase.from("camp_notifications").insert({
      camp_id: campId,
      camp_name: camp.name,
      texts_sent: sent,
    });

    results.push({ camp: camp.name, sent, failed });
  }

  return NextResponse.json({ newCamps: newCamps.length, results });
}
