"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type CalSession = { date: string; startTime: string; endTime: string; location: string; title: string };

function calDateStr(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr.replace(/-/g, "");
  const withYear = /\d{4}/.test(dateStr) ? dateStr : `${dateStr}, ${new Date().getFullYear()}`;
  const d = new Date(withYear);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }
  return "";
}

function calTimeStr(timeStr: string): string {
  if (!timeStr) return "000000";
  const m = timeStr.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
  if (!m) return "000000";
  let h = parseInt(m[1]);
  const min = parseInt(m[2] || "0");
  const period = (m[3] || "").toLowerCase();
  if (period === "pm" && h !== 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}${String(min).padStart(2, "0")}00`;
}

function buildGoogleCalUrl(s: CalSession): string {
  const d = calDateStr(s.date);
  const start = calTimeStr(s.startTime);
  const end = calTimeStr(s.endTime);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(s.title)}&dates=${d}T${start}/${d}T${end}&ctz=America%2FNew_York&location=${encodeURIComponent(s.location)}&details=${encodeURIComponent("Mesa Basketball Training")}`;
}

function downloadICS(sessions: CalSession[]) {
  const events = sessions.map((s, i) => {
    const d = calDateStr(s.date);
    const start = calTimeStr(s.startTime);
    const end = calTimeStr(s.endTime);
    return [
      "BEGIN:VEVENT",
      `UID:mesa-${d}-${start}-${i}@mesabasketballtraining.com`,
      `DTSTART;TZID=America/New_York:${d}T${start}`,
      `DTEND;TZID=America/New_York:${d}T${end}`,
      `SUMMARY:${s.title}`,
      `LOCATION:${s.location}`,
      "DESCRIPTION:Mesa Basketball Training",
      "END:VEVENT",
    ].join("\r\n");
  }).join("\r\n");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mesa Basketball Training//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", events, "END:VCALENDAR"].join("\r\n");
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mesa-basketball.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function BookingConfirmedContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [calendarSessions, setCalendarSessions] = useState<CalSession[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/booking-confirmed-details?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d) => setCalendarSessions(d.sessions || []))
      .catch(() => {});
  }, [sessionId]);

  return (
    <div className="min-h-screen bg-mesa-dark text-white flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="mb-6 text-5xl">✓</div>
        <h1 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide mb-4">
          PAYMENT RECEIVED
        </h1>
        <p className="text-brown-300 leading-relaxed mb-2">
          Your session is confirmed. You&apos;ll get a confirmation email and text shortly with all the details.
        </p>
        {!sessionId && (
          <p className="text-brown-500 text-sm mb-6">
            If you don&apos;t see a confirmation in a few minutes, contact us and we&apos;ll sort it out.
          </p>
        )}
        {calendarSessions.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => downloadICS(calendarSessions)}
              className="inline-flex items-center rounded px-4 py-2 text-sm font-semibold text-white transition"
              style={{ background: "#3a3a3a" }}
            >
              Add to Apple Calendar
            </button>
            <a
              href={buildGoogleCalUrl(calendarSessions[0])}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded px-4 py-2 text-sm font-semibold text-white transition"
              style={{ background: "#1a73e8" }}
            >
              Add to Google Calendar
            </a>
          </div>
        )}
        <div className="mt-8 flex flex-col gap-3 items-center">
          <Link href="/my-bookings" className="rounded-lg bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-yellow-600 transition">
            View My Bookings
          </Link>
          <Link href="/" className="text-sm text-brown-400 hover:text-white transition">
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BookingConfirmedPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-mesa-dark" />}>
      <BookingConfirmedContent />
    </Suspense>
  );
}
