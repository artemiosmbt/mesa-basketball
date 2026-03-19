"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";

const LOCATION_LINKS: Record<string, { name: string; url: string }> = {
  "St. Pauls": { name: "St. Paul's Cathedral", url: "https://share.google/kgiqMxAj2iAFEAGI6" },
  "St. Paul's": { name: "St. Paul's Cathedral", url: "https://share.google/kgiqMxAj2iAFEAGI6" },
  "St. Paul's Cathedral": { name: "St. Paul's Cathedral", url: "https://share.google/kgiqMxAj2iAFEAGI6" },
  "Cherry Valley": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
  "Cherry Valley Sports": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
};

function LocationLink({ location, className }: { location: string; className?: string }) {
  const link = LOCATION_LINKS[location];
  if (link) {
    return (
      <a href={link.url} target="_blank" rel="noopener noreferrer" className={`underline hover:text-mesa-accent ${className || ""}`}>
        {link.name}
      </a>
    );
  }
  return <span className={className}>{location}</span>;
}

interface WeeklySession {
  group: string;
  day: string;
  startTime: string;
  endTime: string;
  location: string;
  maxSpots: number;
}

interface Camp {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  time: string;
  location: string;
  maxSpots: number;
  currentEnrolled: number;
  price: string;
  description: string;
}

interface PrivateSlot {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  available: boolean;
}

type BookingType = "weekly" | "camp" | "private" | "group-private";

// Parse "4:00 PM" → minutes since midnight
function parseTime(t: string): number {
  const match = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return 0;
  let hours = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return hours * 60 + mins;
}

// Minutes since midnight → "4:30 PM"
function formatTimeFromMins(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

function getPrivatePrice(durationMin: number, kidCount: number): number {
  const ratio = durationMin / 60;
  const basePrice = kidCount >= 4 ? 250 : 150;
  return Math.round(basePrice * ratio * 100) / 100;
}

function formatPrice(amount: number): string {
  return amount % 1 === 0 ? `$${amount}` : `$${amount.toFixed(2)}`;
}

interface BookingModal {
  open: boolean;
  type: BookingType;
  sessionIndex: number;
  sessionDetails: string;
  bookedDate?: string;
  bookedStartTime?: string;
  bookedEndTime?: string;
  bookedLocation?: string;
  selectedDuration?: number;
  windowTotalMins?: number;
  remainingAfterSelection?: number;
}

// Group weekly sessions by group name
function groupByGroup(sessions: WeeklySession[]) {
  const groups: Record<string, WeeklySession[]> = {};
  sessions.forEach((s) => {
    if (!groups[s.group]) groups[s.group] = [];
    groups[s.group].push(s);
  });
  return groups;
}

// Merge consecutive slots on same day/location into available windows
interface TimeWindow {
  date: string;
  location: string;
  startMins: number;
  endMins: number;
  startLabel: string;
  endLabel: string;
}

function buildTimeWindows(slots: PrivateSlot[]): TimeWindow[] {
  // Group by date + location
  const groups: Record<string, PrivateSlot[]> = {};
  slots.forEach((s) => {
    const key = `${s.date}|${s.location}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  const windows: TimeWindow[] = [];
  Object.values(groups).forEach((group) => {
    // Sort by start time
    const sorted = [...group].sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));
    let windowStart = parseTime(sorted[0].startTime);
    let windowEnd = parseTime(sorted[0].endTime);

    for (let i = 1; i < sorted.length; i++) {
      const slotStart = parseTime(sorted[i].startTime);
      const slotEnd = parseTime(sorted[i].endTime);
      if (slotStart === windowEnd) {
        // Consecutive — extend window
        windowEnd = slotEnd;
      } else {
        // Gap — close current window and start new one
        windows.push({
          date: sorted[0].date,
          location: sorted[0].location,
          startMins: windowStart,
          endMins: windowEnd,
          startLabel: formatTimeFromMins(windowStart),
          endLabel: formatTimeFromMins(windowEnd),
        });
        windowStart = slotStart;
        windowEnd = slotEnd;
      }
    }
    // Close last window
    windows.push({
      date: sorted[0].date,
      location: sorted[0].location,
      startMins: windowStart,
      endMins: windowEnd,
      startLabel: formatTimeFromMins(windowStart),
      endLabel: formatTimeFromMins(windowEnd),
    });
  });

  return windows;
}

// Generate 15-min increment start times within a window
function getStartOptions(window: TimeWindow, minDuration: number): number[] {
  const options: number[] = [];
  // Latest possible start = window end minus minimum duration
  const latestStart = window.endMins - minDuration;
  for (let t = window.startMins; t <= latestStart; t += 15) {
    options.push(t);
  }
  return options;
}

// Generate duration options given a start time and window end
function getDurationOptions(startMins: number, windowEnd: number): number[] {
  const options: number[] = [];
  const maxDuration = windowEnd - startMins;
  for (let d = 60; d <= maxDuration; d += 15) {
    options.push(d);
  }
  return options;
}

// Upsell: extra time at 50% off when window has ≤120 min and user picks 60 min
function getUpsellOptions(
  selectedDuration: number,
  windowTotalMins: number,
  remainingAfterSelection: number
): { extraMins: number; savings: number }[] {
  if (selectedDuration > 60) return []; // only upsell on base 60 min
  if (windowTotalMins > 120) return []; // only on tight windows
  const options: { extraMins: number; savings: number }[] = [];
  for (const extra of [15, 30]) {
    if (extra <= remainingAfterSelection) {
      const fullPrice = getPrivatePrice(extra, 1);
      options.push({ extraMins: extra, savings: fullPrice / 2 });
    }
  }
  return options;
}

export default function Home() {
  const [schedule, setSchedule] = useState<WeeklySession[]>([]);
  const [camps, setCamps] = useState<Camp[]>([]);
  const [privateSlots, setPrivateSlots] = useState<PrivateSlot[]>([]);
  const [bookedSlots, setBookedSlots] = useState<
    { date: string; startTime: string; endTime: string; location: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Per-window booking state: windowIndex → { start, duration }
  const [windowSelections, setWindowSelections] = useState<
    Record<number, { start: number; duration: number }>
  >({});

  const [modal, setModal] = useState<BookingModal>({
    open: false,
    type: "weekly",
    sessionIndex: 0,
    sessionDetails: "",
  });

  // Form state
  const [parentName, setParentName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [kids, setKids] = useState([{ name: "", dob: "", grade: "" }]);
  const [isGroupRate, setIsGroupRate] = useState(false);
  const [hideUpsell, setHideUpsell] = useState(false);
  const [upsellExtra, setUpsellExtra] = useState(0); // extra minutes accepted
  const [referralCode, setReferralCode] = useState("");

  // Load hideUpsell from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setHideUpsell(localStorage.getItem("mesa_hide_upsell") === "true");
    }
  }, []);

  const [recurringWeeks, setRecurringWeeks] = useState<
    { date: string; startTime: string; endTime: string; location: string; selected: boolean }[]
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setSchedule(data.weeklySchedule || []);
          setCamps(data.camps || []);
          setPrivateSlots(data.privateSlots || []);
          setBookedSlots(data.bookedSlots || []);
        }
      })
      .catch(() => setError("Failed to load schedule"))
      .finally(() => setLoading(false));
  }, []);

  const timeWindows = useMemo(() => {
    const windows = buildTimeWindows(privateSlots);
    // Subtract booked time ranges from windows
    if (bookedSlots.length === 0) return windows;

    const result: TimeWindow[] = [];
    for (const w of windows) {
      // Find bookings that overlap this window
      const overlaps = bookedSlots.filter(
        (b) => b.date === w.date && b.location === w.location
      );
      if (overlaps.length === 0) {
        result.push(w);
        continue;
      }

      // Sort bookings by start time
      const sorted = overlaps
        .map((b) => ({ start: parseTime(b.startTime), end: parseTime(b.endTime) }))
        .sort((a, b) => a.start - b.start);

      // Split window around booked ranges
      let cursor = w.startMins;
      for (const booking of sorted) {
        if (booking.start > cursor) {
          // Gap before this booking
          result.push({
            ...w,
            startMins: cursor,
            endMins: booking.start,
            startLabel: formatTimeFromMins(cursor),
            endLabel: formatTimeFromMins(booking.start),
          });
        }
        cursor = Math.max(cursor, booking.end);
      }
      // Remaining time after last booking
      if (cursor < w.endMins) {
        result.push({
          ...w,
          startMins: cursor,
          endMins: w.endMins,
          startLabel: formatTimeFromMins(cursor),
          endLabel: formatTimeFromMins(w.endMins),
        });
      }
    }
    return result;
  }, [privateSlots, bookedSlots]);

  function updateWindowSelection(
    windowIdx: number,
    field: "start" | "duration",
    value: number,
    window: TimeWindow
  ) {
    setWindowSelections((prev) => {
      const current = prev[windowIdx] || { start: window.startMins, duration: 60 };
      const updated = { ...current, [field]: value };
      // If changing start, clamp duration to max available
      if (field === "start") {
        const maxDur = window.endMins - value;
        if (updated.duration > maxDur) {
          updated.duration = maxDur;
        }
        // Ensure minimum 30 min
        if (updated.duration < 60) {
          updated.duration = 60;
        }
      }
      return { ...prev, [windowIdx]: updated };
    });
  }

  function openPrivateBooking(windowIdx: number, window: TimeWindow) {
    const sel = windowSelections[windowIdx] || {
      start: window.startMins,
      duration: Math.min(60, window.endMins - window.startMins),
    };
    const endMins = sel.start + sel.duration;
    const startLabel = formatTimeFromMins(sel.start);
    const endLabel = formatTimeFromMins(endMins);
    const details = `Private Session — ${window.date} ${startLabel}-${endLabel} (${sel.duration} min) at ${window.location}`;

    // Find future weeks with matching day, location, and time availability
    const selectedDate = new Date(window.date);
    const dayOfWeek = selectedDate.getUTCDay();
    const futureWeeks: typeof recurringWeeks = [];

    for (const w of timeWindows) {
      if (w.date === window.date) continue; // skip current
      if (w.location !== window.location) continue;
      const wDate = new Date(w.date);
      if (wDate.getUTCDay() !== dayOfWeek) continue;
      if (wDate <= selectedDate) continue;
      // Check if the selected time range fits in this window
      if (sel.start >= w.startMins && endMins <= w.endMins) {
        futureWeeks.push({
          date: w.date,
          startTime: startLabel,
          endTime: endLabel,
          location: w.location,
          selected: false,
        });
      }
    }

    setRecurringWeeks(futureWeeks);
    setModal({
      open: true,
      type: "private",
      sessionIndex: windowIdx,
      sessionDetails: details,
      bookedDate: window.date,
      bookedStartTime: startLabel,
      bookedEndTime: endLabel,
      bookedLocation: window.location,
      selectedDuration: sel.duration,
      windowTotalMins: window.endMins - window.startMins,
      remainingAfterSelection: window.endMins - endMins,
    });
    setSubmitResult(null);
    setParentName("");
    setEmail("");
    setPhone("");
    setKids([{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
  }

  function openModal(type: BookingType, sessionIndex: number, details: string) {
    setModal({ open: true, type, sessionIndex, sessionDetails: details });
    setSubmitResult(null);
    setParentName("");
    setEmail("");
    setPhone("");
    setKids([{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
  }

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
  }

  function addKid() {
    setKids((k) => [...k, { name: "", dob: "", grade: "" }]);
  }

  function removeKid(i: number) {
    setKids((k) => k.filter((_, idx) => idx !== i));
  }

  function updateKid(i: number, field: "name" | "dob" | "grade", value: string) {
    setKids((k) => k.map((kid, idx) => (idx === i ? { ...kid, [field]: value } : kid)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitResult(null);

    const totalParticipants = kids.length;
    let bookingType = modal.type;

    if (bookingType === "private" || bookingType === "group-private") {
      bookingType = (isGroupRate || totalParticipants >= 4) ? "group-private" : "private";
    }

    const kidsStr = kids.map((k) => `${k.name} (DOB: ${k.dob}, Grade: ${k.grade})`).join(", ");

    try {
      // Adjust end time if upsell was accepted
      let adjustedEndTime = modal.bookedEndTime;
      if (upsellExtra > 0 && modal.bookedEndTime) {
        const endMins = parseTime(modal.bookedEndTime) + upsellExtra;
        adjustedEndTime = formatTimeFromMins(endMins);
      }

      // Build list of all dates to book (primary + selected recurring)
      const datesToBook = [
        {
          date: modal.bookedDate,
          startTime: modal.bookedStartTime,
          endTime: adjustedEndTime,
          location: modal.bookedLocation,
        },
        ...recurringWeeks.filter((w) => w.selected).map((w) => ({
          date: w.date,
          startTime: w.startTime,
          endTime: upsellExtra > 0 ? formatTimeFromMins(parseTime(w.endTime) + upsellExtra) : w.endTime,
          location: w.location,
        })),
      ];

      const allDatesLabel = datesToBook.map((d) => d.date).join(", ");
      const sessionDetailsAll =
        datesToBook.length > 1
          ? `${modal.sessionDetails} + recurring (${allDatesLabel})`
          : modal.sessionDetails;

      // Register each date
      for (const booking of datesToBook) {
        await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            kids: kidsStr,
            type: bookingType,
            sessionDetails: datesToBook.length > 1
              ? `Private Session — ${booking.date} ${booking.startTime}-${booking.endTime} at ${booking.location}`
              : modal.sessionDetails,
            sessionIndex: modal.sessionIndex,
            totalParticipants,
            bookedDate: booking.date,
            bookedStartTime: booking.startTime,
            bookedEndTime: booking.endTime,
            bookedLocation: booking.location,
            skipEmail: booking !== datesToBook[0], // only send email for first booking
            submittedReferralCode: referralCode.trim() || undefined,
          }),
        });
      }

      // Send one summary email if recurring
      if (datesToBook.length > 1) {
        await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            kids: kidsStr,
            type: bookingType,
            sessionDetails: sessionDetailsAll,
            sessionIndex: modal.sessionIndex,
            totalParticipants,
            emailOnly: true,
          }),
        });
      }

      setSubmitResult({
        success: true,
        message: datesToBook.length > 1
          ? `${datesToBook.length} sessions booked! Check your email for details.`
          : "Registration confirmed! Check your email for details.",
      });
      const fresh = await fetch("/api/schedule").then((r) => r.json());
      setSchedule(fresh.weeklySchedule || []);
      setCamps(fresh.camps || []);
      setPrivateSlots(fresh.privateSlots || []);
      setBookedSlots(fresh.bookedSlots || []);
    } catch {
      setSubmitResult({
        success: false,
        message: "Something went wrong. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // Compute price for the modal based on selected window duration
  // Compute upsell options for the modal
  const upsellOptions = useMemo(() => {
    if (modal.type !== "private" && modal.type !== "group-private") return [];
    if (hideUpsell) return [];
    return getUpsellOptions(
      modal.selectedDuration || 60,
      modal.windowTotalMins || 999,
      modal.remainingAfterSelection || 0
    );
  }, [modal, hideUpsell]);

  const priceLabel = (() => {
    if (modal.type !== "private" && modal.type !== "group-private") return null;
    const match = modal.sessionDetails.match(/\((\d+) min\)/);
    if (!match) return null;
    const baseDuration = parseInt(match[1]);
    const totalDuration = baseDuration + upsellExtra;
    const effectiveGroup = isGroupRate || kids.length >= 4;
    const kidCount = effectiveGroup ? 4 : kids.length;
    // Base price + discounted extra
    const basePrice = getPrivatePrice(baseDuration, kidCount);
    const extraPrice = upsellExtra > 0 ? getPrivatePrice(upsellExtra, kidCount) * 0.5 : 0;
    const totalPrice = basePrice + extraPrice;
    const tier = effectiveGroup ? "Group Private — 4+ participants" : "Private — up to 3 participants";
    const timeNote = totalDuration !== 60 ? ` (${totalDuration} min session)` : "";
    const savingsNote = upsellExtra > 0 ? ` — includes ${upsellExtra} min bonus at 50% off` : "";
    return `${formatPrice(totalPrice)} (${tier})${timeNote}${savingsNote}`;
  })();

  const grouped = groupByGroup(schedule);

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      {/* Hero */}
      <header className="relative overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <div className="flex flex-col items-center text-center">
            <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
              MESA BASKETBALL TRAINING
            </h1>
            <p className="mt-4 text-lg text-brown-300 md:text-xl">
              With Former Division I Player{" "}
              <span className="font-semibold text-mesa-accent">
                Artemios Gavalas
              </span>
            </p>
            <p className="mt-2 text-brown-400">
              St. John&apos;s &bull; Butler &bull; Professional (Greece)
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <a
                href="#schedule"
                className="rounded-lg bg-mesa-accent px-6 py-3 font-semibold text-white transition hover:bg-amber-600"
              >
                Group Schedule
              </a>
              <a
                href="#camps"
                className="rounded-lg border border-brown-500 px-6 py-3 font-semibold text-brown-200 transition hover:bg-brown-800"
              >
                Mini Camps
              </a>
              <a
                href="#private"
                className="rounded-lg border border-brown-500 px-6 py-3 font-semibold text-brown-200 transition hover:bg-brown-800"
              >
                Book Private Session
              </a>
            </div>
          </div>
        </div>
        {/* Photo row */}
        <div className="mx-auto flex max-w-5xl justify-center gap-4 px-6 pb-12">
          <div className="relative h-48 w-1/3 overflow-hidden rounded-xl md:h-64">
            <Image
              src="/photo1.jpg"
              alt="Artemios Gavalas training"
              fill
              className="object-cover"
              priority
            />
          </div>
          <div className="relative h-48 w-1/3 overflow-hidden rounded-xl md:h-64">
            <Image
              src="/photo2.jpg"
              alt="Artemios Gavalas playing"
              fill
              className="object-cover"
              priority
            />
          </div>
        </div>
      </header>

      {/* What to Expect */}
      <section className="bg-brown-900/50 py-16">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-3xl font-bold">What to Expect</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="rounded-xl bg-brown-800/60 p-6">
              <div className="mb-3 text-3xl">🏀</div>
              <h3 className="font-semibold text-mesa-accent">Skill Development</h3>
              <p className="mt-2 text-sm text-brown-300">
                Expert guidance on shooting, dribbling, ball handling & more
              </p>
            </div>
            <div className="rounded-xl bg-brown-800/60 p-6">
              <div className="mb-3 text-3xl">💪</div>
              <h3 className="font-semibold text-mesa-accent">High Energy Drills</h3>
              <p className="mt-2 text-sm text-brown-300">
                Build confidence, skill, and game IQ through competitive drills
              </p>
            </div>
            <div className="rounded-xl bg-brown-800/60 p-6">
              <div className="mb-3 text-3xl">🎓</div>
              <h3 className="font-semibold text-mesa-accent">D1 Experience</h3>
              <p className="mt-2 text-sm text-brown-300">
                Knowledge from playing at St. John&apos;s, Butler, and professionally in Greece
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Weekly Schedule */}
      <section id="schedule" className="py-16">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold">Weekly Schedule</h2>
          <p className="mt-2 text-center text-brown-400">
            Group training sessions — spots are limited to 12 per session
          </p>

          {loading && <p className="mt-8 text-center text-brown-400">Loading schedule...</p>}
          {error && <p className="mt-8 text-center text-red-400">{error}</p>}

          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {Object.entries(grouped).map(([group, sessions]) => (
              <div key={group} className="rounded-xl border border-brown-700 bg-brown-900/40 p-6">
                <h3 className="mb-4 text-lg font-bold text-mesa-accent">{group}</h3>
                <div className="space-y-3">
                  {sessions.map((s, i) => {
                    const globalIndex = schedule.indexOf(s);
                    return (
                      <div key={i} className="flex items-center justify-between rounded-lg bg-brown-800/50 px-4 py-3">
                        <div>
                          <p className="font-medium">{s.day} {s.startTime} - {s.endTime}</p>
                          <p className="text-sm text-brown-400"><LocationLink location={s.location} /></p>
                        </div>
                        <button
                          onClick={() => openModal("weekly", globalIndex, `${group} — ${s.day} ${s.startTime}-${s.endTime} at ${s.location}`)}
                          className="rounded bg-mesa-accent px-3 py-1 text-xs font-semibold text-white transition hover:bg-amber-600"
                        >
                          Register
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Mini Camps */}
      <section id="camps" className="bg-brown-900/30 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold">Mini Camps</h2>
          <p className="mt-2 text-center text-brown-400">
            Summer &amp; break camps — register early, spots fill fast (max 20 per camp)
          </p>

          {camps.length === 0 && !loading && (
            <p className="mt-8 text-center text-brown-500">No upcoming camps scheduled. Check back soon!</p>
          )}

          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {camps.map((camp, i) => {
              const spotsLeft = camp.maxSpots - camp.currentEnrolled;
              const full = spotsLeft <= 0;
              return (
                <div key={camp.id} className="rounded-xl border border-brown-700 bg-brown-900/40 p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-bold text-mesa-accent">{camp.name}</h3>
                      <p className="text-sm text-brown-300">{camp.startDate} — {camp.endDate}</p>
                    </div>
                    <span className="rounded-full bg-brown-800 px-3 py-1 text-sm font-semibold text-mesa-accent">
                      {camp.price}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-brown-400">{camp.time} &bull; <LocationLink location={camp.location} /></p>
                  {camp.description && <p className="mt-2 text-sm text-brown-300">{camp.description}</p>}
                  <div className="mt-4 flex items-center justify-between">
                    <span className={`text-sm font-medium ${full ? "text-red-400" : spotsLeft <= 5 ? "text-yellow-400" : "text-green-400"}`}>
                      {full ? "FULL" : `${spotsLeft} spot${spotsLeft !== 1 ? "s" : ""} left`}
                    </span>
                    {!full && (
                      <button
                        onClick={() => openModal("camp", i, `${camp.name} (${camp.startDate} — ${camp.endDate}) at ${camp.location}`)}
                        className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
                      >
                        Register
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Private Sessions */}
      <section id="private" className="py-16">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold">Private Sessions</h2>
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            <div className="rounded-lg bg-brown-800/60 px-4 py-2 text-center">
              <p className="text-lg font-bold text-mesa-accent">$150 / 60 min</p>
              <p className="text-xs text-brown-400">Up to 3 participants</p>
            </div>
            <div className="rounded-lg bg-brown-800/60 px-4 py-2 text-center">
              <p className="text-lg font-bold text-mesa-accent">$250 / 60 min</p>
              <p className="text-xs text-brown-400">Group Private (4+ kids)</p>
            </div>
          </div>
          <p className="mt-2 text-center text-sm text-brown-500">
            Prorated for shorter sessions &bull; Payment in person — Cash, Venmo, or Zelle
          </p>
          <p className="mt-3 text-center text-sm text-green-400/80">
            Every 11th session is on us! Earn free sessions through our loyalty rewards program.
          </p>

          {privateSlots.length === 0 && !loading && (
            <p className="mt-8 text-center text-brown-500">
              No available slots right now. Check back soon or contact Artemios directly.
            </p>
          )}

          <div className="mt-8 space-y-4">
            {timeWindows.filter((w) => w.endMins - w.startMins >= 60).map((window, wi) => {
              const totalAvailable = window.endMins - window.startMins;
              const sel = windowSelections[wi] || {
                start: window.startMins,
                duration: Math.min(60, totalAvailable),
              };
              const startOptions = getStartOptions(window, 60);
              const durationOptions = getDurationOptions(sel.start, window.endMins);
              const endTime = formatTimeFromMins(sel.start + sel.duration);
              const price = getPrivatePrice(sel.duration, 1);

              return (
                <div
                  key={wi}
                  className="rounded-xl border border-brown-700 bg-brown-900/40 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-brown-200">
                        {(() => {
                          const d = new Date(window.date);
                          const day = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
                          return `${day}, ${window.date}`;
                        })()}
                      </h3>
                      <p className="text-sm text-brown-500">
                        <LocationLink location={window.location} /> &bull; Available {window.startLabel} - {window.endLabel} ({totalAvailable} min)
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-end gap-4">
                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Start Time</label>
                      <select
                        value={sel.start}
                        onChange={(e) =>
                          updateWindowSelection(wi, "start", parseInt(e.target.value), window)
                        }
                        className="rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                      >
                        {startOptions.map((t) => (
                          <option key={t} value={t}>
                            {formatTimeFromMins(t)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Duration</label>
                      <select
                        value={sel.duration}
                        onChange={(e) =>
                          updateWindowSelection(wi, "duration", parseInt(e.target.value), window)
                        }
                        className="rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                      >
                        {durationOptions.map((d) => (
                          <option key={d} value={d}>
                            {d} min
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="text-sm text-brown-300">
                      <span className="text-white font-medium">
                        {formatTimeFromMins(sel.start)} - {endTime}
                      </span>
                      <span className="ml-2 text-mesa-accent font-semibold">
                        From {formatPrice(price)}
                      </span>
                    </div>

                    <button
                      onClick={() => openPrivateBooking(wi, window)}
                      className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
                    >
                      Book
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Contact Footer */}
      <footer className="border-t border-brown-800 bg-mesa-dark py-12">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-2xl font-bold">Get in Touch</h2>
          <div className="mt-4 space-y-1 text-brown-300">
            <p>
              <span className="font-semibold text-white">Call / Text:</span>{" "}
              <a href="tel:6315991280" className="hover:text-mesa-accent">(631) 599-1280</a>
            </p>
            <p>
              <span className="font-semibold text-white">Email:</span>{" "}
              <a href="mailto:artemios@mesabasketballtraining.com" className="hover:text-mesa-accent">
                artemios@mesabasketballtraining.com
              </a>
            </p>
          </div>
          <a
            href="/my-bookings"
            className="mt-6 inline-block text-sm text-mesa-accent hover:text-amber-400"
          >
            My Bookings &mdash; Look Up Your Registrations
          </a>
          <p className="mt-4 text-sm text-brown-600">
            &copy; {new Date().getFullYear()} Mesa Basketball Training. All rights reserved.
          </p>
        </div>
      </footer>

      {/* Registration Modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-brown-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold">
                {modal.type === "camp"
                  ? "Camp Registration"
                  : modal.type === "weekly"
                    ? "Session Registration"
                    : "Book Private Session"}
              </h3>
              <button onClick={closeModal} className="text-2xl text-brown-400 hover:text-white">
                &times;
              </button>
            </div>
            <p className="mt-1 text-sm text-brown-400">{modal.sessionDetails}</p>

            {submitResult?.success ? (
              <div className="mt-6 rounded-lg bg-green-900/50 p-4 text-center">
                <p className="text-lg font-semibold text-green-400">{submitResult.message}</p>
                <button onClick={closeModal} className="mt-4 rounded bg-brown-700 px-4 py-2 text-sm hover:bg-brown-600">
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-brown-300">Parent / Guardian Name</label>
                  <input
                    type="text"
                    required
                    value={parentName}
                    onChange={(e) => setParentName(e.target.value)}
                    className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-brown-300">Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-brown-300">Phone</label>
                    <input
                      type="tel"
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-sm font-medium text-brown-300">Kid(s)</label>
                    <button type="button" onClick={addKid} className="text-sm text-mesa-accent hover:text-amber-400">
                      + Add another kid
                    </button>
                  </div>
                  {kids.map((kid, i) => (
                    <div key={i} className="mb-2 flex gap-2">
                      <input
                        type="text"
                        placeholder="Name"
                        required
                        value={kid.name}
                        onChange={(e) => updateKid(i, "name", e.target.value)}
                        className="flex-1 rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                      />
                      <input
                        type="date"
                        required
                        value={kid.dob}
                        onChange={(e) => updateKid(i, "dob", e.target.value)}
                        className="w-36 rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                        title="Date of Birth"
                      />
                      <input
                        type="text"
                        placeholder="Grade"
                        required
                        value={kid.grade}
                        onChange={(e) => updateKid(i, "grade", e.target.value)}
                        className="w-20 rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                      />
                      {kids.length > 1 && (
                        <button type="button" onClick={() => removeKid(i)} className="text-brown-500 hover:text-red-400">
                          &times;
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Referral Code */}
                {(modal.type === "private" || modal.type === "group-private") && (
                  <div>
                    <label className="mb-1 block text-sm font-medium text-brown-300">Referral Code <span className="text-brown-500 font-normal">(optional)</span></label>
                    <input
                      type="text"
                      value={referralCode}
                      onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                      placeholder="e.g. SMITH-MESA"
                      className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                    />
                  </div>
                )}

                {/* Upsell prompt */}
                {upsellOptions.length > 0 && upsellExtra === 0 && (
                  <div className="rounded-lg border border-green-800/50 bg-green-900/20 p-4">
                    <p className="text-sm font-semibold text-green-400">
                      Extend your session?
                    </p>
                    <p className="mt-1 text-xs text-brown-300">
                      Add extra time at half price. More reps, more progress — same session.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {upsellOptions.map((opt) => {
                        const extraCost = getPrivatePrice(opt.extraMins, isGroupRate || kids.length >= 4 ? 4 : 1) * 0.5;
                        return (
                          <button
                            key={opt.extraMins}
                            type="button"
                            onClick={() => setUpsellExtra(opt.extraMins)}
                            className="rounded bg-green-800/40 px-3 py-2 text-sm text-green-300 hover:bg-green-800/60"
                          >
                            +{opt.extraMins} min (+{formatPrice(extraCost)})
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => {
                          setHideUpsell(true);
                          localStorage.setItem("mesa_hide_upsell", "true");
                        }}
                        className="text-xs text-brown-500 hover:text-brown-400 self-center ml-2"
                      >
                        Don&apos;t show this again
                      </button>
                    </div>
                  </div>
                )}

                {upsellExtra > 0 && (
                  <div className="flex items-center justify-between rounded-lg bg-green-900/20 px-4 py-2">
                    <p className="text-sm text-green-400">
                      +{upsellExtra} min added at 50% off
                    </p>
                    <button
                      type="button"
                      onClick={() => setUpsellExtra(0)}
                      className="text-xs text-brown-500 hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {(modal.type === "private" || modal.type === "group-private") && recurringWeeks.length > 0 && (
                  <div>
                    <label className="mb-2 block text-sm font-medium text-brown-300">
                      Repeat weekly? (same time &amp; location)
                    </label>
                    <div className="space-y-2 rounded-lg border border-brown-700 bg-brown-800/50 p-3">
                      {recurringWeeks.map((week, wi) => {
                        const d = new Date(week.date);
                        const dayName = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
                        return (
                          <label key={wi} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={week.selected}
                              onChange={() =>
                                setRecurringWeeks((prev) =>
                                  prev.map((w, i) =>
                                    i === wi ? { ...w, selected: !w.selected } : w
                                  )
                                )
                              }
                              className="rounded border-brown-600 accent-mesa-accent"
                            />
                            <span className="text-brown-300">
                              {dayName}, {week.date}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(modal.type === "private" || modal.type === "group-private") && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setIsGroupRate(false)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        !isGroupRate && kids.length < 4
                          ? "border-mesa-accent bg-mesa-accent/20 text-mesa-accent"
                          : "border-brown-700 text-brown-400 hover:border-brown-500"
                      }`}
                    >
                      Private ($150/hr)
                      <span className="block text-xs font-normal">Up to 3 kids</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsGroupRate(true)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        isGroupRate || kids.length >= 4
                          ? "border-mesa-accent bg-mesa-accent/20 text-mesa-accent"
                          : "border-brown-700 text-brown-400 hover:border-brown-500"
                      }`}
                    >
                      Group ($250/hr)
                      <span className="block text-xs font-normal">4+ kids</span>
                    </button>
                  </div>
                )}

                {priceLabel && (
                  <p className="rounded-lg bg-brown-800 px-3 py-2 text-sm text-mesa-accent">{priceLabel}</p>
                )}

                {submitResult && !submitResult.success && (
                  <p className="text-sm text-red-400">{submitResult.message}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-lg bg-mesa-accent py-3 font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Confirm Registration"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
