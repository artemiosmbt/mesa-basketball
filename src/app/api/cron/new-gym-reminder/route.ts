import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin, verifyCronSecret } from "@/lib/auth";
import { todayET } from "@/lib/et-time";
import { normalizeDate } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay } from "@/lib/sms";
import { sendNewGymFirstSessionReminder } from "@/lib/email";
import { helpLine } from "@/lib/new-gym-server";
import { NEW_GYM } from "@/lib/new-gym";

export const maxDuration = 60;

interface Row {
  id: string;
  email: string;
  parent_name: string;
  phone: string | null;
  sms_consent: boolean | null;
  kids: string | null;
  type: string;
  booked_group: string | null;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_trainer: string | null;
  status: string;
}

// Runs at 6pm ET (vercel.json: 22:00 UTC). The ONLY day-before reminder Mesa
// sends (Artemios, 2026-10-28): the evening before a family's FIRST session
// at the new gym, Diamond Charter — a text (if they opted in) and an email
// with the address, "not St. Paul's", and who to call if they can't find it.
// "First" = no earlier confirmed or no-show session there; a cancelled one
// doesn't count (they never went). ?dryRun=1 lists who'd get it, sends nothing.
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req) && !(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  const t = todayET();
  const tomorrowDate = new Date(Date.UTC(t.year, t.month - 1, t.day + 1));
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("registrations")
    .select("id, email, parent_name, phone, sms_consent, kids, type, booked_group, booked_date, booked_start_time, booked_end_time, booked_trainer, status")
    .ilike("booked_location", "%diamond charter%")
    .in("status", ["confirmed", "no_show"]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byFamily = new Map<string, Row[]>();
  for (const r of (data || []) as Row[]) {
    if (!r.email || !r.booked_date) continue;
    const key = r.email.trim().toLowerCase();
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(r);
  }

  const reminded: string[] = [];
  let smsSent = 0, emailsSent = 0;
  for (const [email, rows] of byFamily) {
    const dated = rows.map((r) => ({ r, date: normalizeDate(r.booked_date!) }));
    const firstDate = dated.map((d) => d.date).sort()[0];
    if (firstDate !== tomorrow) continue; // they've been there before, or their first time isn't tomorrow
    const tomorrowRows = dated.filter((d) => d.date === tomorrow && d.r.status === "confirmed").map((d) => d.r);
    if (tomorrowRows.length === 0) continue;
    tomorrowRows.sort((a, b) => (a.booked_start_time || "").localeCompare(b.booked_start_time || ""));

    const label = (r: Row) => `${r.booked_group || (r.type === "camp" ? "Camp" : "Private session")}${r.kids ? ` (${r.kids.replace(/\s*\(DOB:[^)]*\)/g, "")})` : ""}`;
    const time = (r: Row) => `${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`;
    const help = helpLine(tomorrowRows.map((r) => r.booked_trainer));
    const parentName = tomorrowRows[0].parent_name || "there";
    reminded.push(`${parentName} (${tomorrowRows.map((r) => `${r.booked_group || r.type} ${r.booked_start_time}`).join(", ")})`);
    if (dryRun) continue;

    const consented = tomorrowRows.find((r) => r.sms_consent && r.phone);
    if (consented) {
      try {
        await sendSMS(
          consented.phone!,
          `Mesa Basketball reminder: tomorrow (${formatDateWithDay(tomorrow)})\n${tomorrowRows.map((r) => `${label(r)} ${time(r)}`).join("\n")}\n⚠️ NEW LOCATION: ${NEW_GYM.name}, 12 Westminster Rd, West Hempstead — not St. Paul's.\n${help}\nReply STOP to opt out.`
        );
        smsSent++;
      } catch (err) {
        console.error("New-gym reminder SMS failed for", email, err);
      }
    }
    try {
      await sendNewGymFirstSessionReminder({
        to: tomorrowRows[0].email,
        parentName,
        sessions: tomorrowRows.map((r) => ({ label: label(r), dateLabel: formatDateWithDay(tomorrow), timeLabel: time(r) })),
        helpLine: help,
      });
      emailsSent++;
    } catch (err) {
      console.error("New-gym reminder email failed for", email, err);
    }
  }

  if (!dryRun && reminded.length > 0) {
    await sendAdminSMS(`DIAMOND CHARTER FIRST-SESSION REMINDERS (tomorrow):\n${reminded.map((x) => `• ${x}`).join("\n")}\n${emailsSent} email, ${smsSent} SMS sent`).catch(() => {});
  }
  return NextResponse.json({ tomorrow, dryRun, reminded, emailsSent, smsSent });
}
