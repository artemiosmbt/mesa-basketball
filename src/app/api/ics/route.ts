import { NextRequest, NextResponse } from "next/server";

function dateStr(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.replace(/-/g, "");
  const parsed = new Date(/\d{4}/.test(d) ? d : `${d}, ${new Date().getFullYear()}`);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}${String(parsed.getMonth() + 1).padStart(2, "0")}${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return "";
}

function timeStr(t: string): string {
  const m = t?.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
  if (!m) return "000000";
  let h = parseInt(m[1]);
  const min = parseInt(m[2] || "0");
  const period = (m[3] || "").toLowerCase();
  if (period === "pm" && h !== 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}${String(min).padStart(2, "0")}00`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const date = searchParams.get("date") || "";
  const startTime = searchParams.get("start") || "";
  const endTime = searchParams.get("end") || "";
  const location = searchParams.get("location") || "";
  const title = searchParams.get("title") || "Mesa Basketball Training";

  const d = dateStr(date);
  if (!d) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mesa Basketball Training//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:mesa-${d}-${timeStr(startTime)}@mesabasketballtraining.com`,
    `DTSTART;TZID=America/New_York:${d}T${timeStr(startTime)}`,
    `DTEND;TZID=America/New_York:${d}T${timeStr(endTime)}`,
    `SUMMARY:${title}`,
    `LOCATION:${location}`,
    "DESCRIPTION:Mesa Basketball Training",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="mesa-basketball.ics"`,
    },
  });
}
