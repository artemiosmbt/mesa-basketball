"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Image from "next/image";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

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
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  maxSpots: number;
  price: number;
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
  gradeGroup: string;
  earlyBirdPrice: string;
  dropInPrice: string;
  campDays: string[];
}

// Early bird ends March 31, 2026 end of day Eastern (April 1 04:00 UTC)
function isEarlyBirdActive(): boolean {
  return new Date() < new Date("2026-04-01T04:00:00Z");
}

function calcCampPrice(daysSelected: number, totalDays: number, camp: Camp, kidCount: number = 1): string {
  if (daysSelected === 0) return "";
  const count = Math.max(1, kidCount);
  if (daysSelected === totalDays) {
    const baseStr = isEarlyBirdActive() && camp.earlyBirdPrice ? camp.earlyBirdPrice : camp.price;
    if (count === 1) return baseStr;
    const base = parseInt(baseStr.replace(/\D/g, "")) || 0;
    return `$${base * count}`;
  }
  const perDay = parseInt(camp.dropInPrice.replace(/\D/g, "")) || 100;
  return `$${perDay * daysSelected * count}`;
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

interface SelectedGroupSession {
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  group: string;
  maxSpots: number;
  price: number;
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
  // Weekly multi-session
  selectedGroupSessions?: SelectedGroupSession[];
  weeklyTotalPrice?: number;
  weeklySavings?: number;
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
function getStartOptions(window: TimeWindow, minDuration: number, minStart?: number): number[] {
  const options: number[] = [];
  // Latest possible start = window end minus minimum duration
  const latestStart = window.endMins - minDuration;
  const effectiveStart = minStart !== undefined
    ? Math.max(window.startMins, Math.ceil(minStart / 15) * 15)
    : window.startMins;
  for (let t = effectiveStart; t <= latestStart; t += 15) {
    options.push(t);
  }
  return options;
}

// Generate duration options given a start time and window end
// Fixed options: 1 hr, 1 hr 15 min, 1 hr 30 min, 2 hr (capped at 120 min)
function getDurationOptions(startMins: number, windowEnd: number): number[] {
  const maxDuration = Math.min(windowEnd - startMins, 120);
  return [60, 75, 90, 120].filter((d) => d <= maxDuration);
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

// Upsell: extra time at 50% off when window has ≤120 min and user picks 60 min
function getUpsellOptions(
  selectedDuration: number,
  windowTotalMins: number,
  remainingAfterSelection: number
): { extraMins: number; savings: number }[] {
  if (selectedDuration > 60) return []; // only upsell on base 60 min
  if (remainingAfterSelection < 15 || remainingAfterSelection > 30) return []; // only show when 15-30 min left in window
  const options: { extraMins: number; savings: number }[] = [];
  for (const extra of [15, 30]) {
    if (extra <= remainingAfterSelection) {
      const fullPrice = getPrivatePrice(extra, 1);
      options.push({ extraMins: extra, savings: fullPrice / 2 });
    }
  }
  return options;
}

function MiniCalendar({
  month,
  onMonthChange,
  highlightedDates,
  selectedDate,
  onSelectDate,
}: {
  month: Date;
  onMonthChange: (d: Date) => void;
  highlightedDates: Set<string>;
  selectedDate: string | null;
  onSelectDate: (d: string | null) => void;
}) {
  const year = month.getUTCFullYear();
  const mon = month.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, mon, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="rounded-lg border border-brown-700 bg-brown-900/40 p-4 w-72">
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => onMonthChange(new Date(Date.UTC(year, mon - 1, 1)))} className="text-brown-400 hover:text-white px-2 text-lg leading-none">‹</button>
        <span className="text-sm font-semibold">{month.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
        <button onClick={() => onMonthChange(new Date(Date.UTC(year, mon + 1, 1)))} className="text-brown-400 hover:text-white px-2 text-lg leading-none">›</button>
      </div>
      <div className="grid grid-cols-7 text-center mb-2">
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
          <span key={d} className="text-xs text-brown-500 font-medium">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center gap-y-1">
        {cells.map((day, i) => {
          if (!day) return <span key={i} />;
          const cellDate = new Date(Date.UTC(year, mon, day));
          const dateStr = cellDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
          const hasSlot = highlightedDates.has(dateStr);
          const isSelected = selectedDate === dateStr;
          const isPast = cellDate < todayUTC;
          return (
            <button
              key={i}
              disabled={!hasSlot}
              onClick={() => onSelectDate(isSelected ? null : dateStr)}
              className={`text-xs rounded-full w-8 h-8 mx-auto flex items-center justify-center transition ${
                isSelected ? "bg-mesa-accent text-white font-bold" :
                hasSlot ? "bg-brown-700 text-white hover:bg-brown-600 font-medium cursor-pointer" :
                isPast ? "text-brown-800 cursor-default" :
                "text-brown-700 cursor-default"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>
      {selectedDate && (
        <button onClick={() => onSelectDate(null)} className="mt-2 w-full text-xs text-brown-500 hover:text-brown-400">
          Clear date
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const [schedule, setSchedule] = useState<WeeklySession[]>([]);
  const [camps, setCamps] = useState<Camp[]>([]);
  const [privateSlots, setPrivateSlots] = useState<PrivateSlot[]>([]);
  const [bookedSlots, setBookedSlots] = useState<
    { date: string; startTime: string; endTime: string; location: string }[]
  >([]);
  const [groupEnrollment, setGroupEnrollment] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Camp day selection state
  const [campSelectedDays, setCampSelectedDays] = useState<Set<string>>(new Set());

  // Group session selection state: key = "group|date|startTime"
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set());
  const [activeGroup, setActiveGroup] = useState<string>("");
  const [groupDayFilter, setGroupDayFilter] = useState<Set<number>>(new Set());

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
  const [smsConsent, setSmsConsent] = useState(true);
  const [kids, setKids] = useState([{ name: "", dob: "", grade: "" }]);
  const [isGroupRate, setIsGroupRate] = useState(false);
  const [hideUpsell, setHideUpsell] = useState(false);
  const [filterDays, setFilterDays] = useState<Set<number>>(new Set());
  const [filterMonth, setFilterMonth] = useState<string>("");
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  });
  const [calendarSelectedDate, setCalendarSelectedDate] = useState<string | null>(null);
  const [showAllPrivate, setShowAllPrivate] = useState(false);
  const [showAllRecurring, setShowAllRecurring] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());
  const [upsellExtra, setUpsellExtra] = useState(0); // extra minutes accepted
  const [referralCode, setReferralCode] = useState("");

  // Load hideUpsell from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      setHideUpsell(localStorage.getItem("mesa_hide_upsell") === "true");
    }
  }, []);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [schedulingOpen, setSchedulingOpen] = useState(false);

  const [recurringWeeks, setRecurringWeeks] = useState<
    { date: string; startTime: string; endTime: string; location: string; selected: boolean }[]
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Package enrollment state
  const [pkgModal, setPkgModal] = useState<{ open: boolean; packageType: 4 | 8 | null }>({ open: false, packageType: null });
  const [pkgName, setPkgName] = useState("");
  const [pkgEmail, setPkgEmail] = useState("");
  const [pkgPhone, setPkgPhone] = useState("");
  const [pkgMonth, setPkgMonth] = useState("");
  const [pkgSubmitting, setPkgSubmitting] = useState(false);
  const [pkgResult, setPkgResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showReferralInfo, setShowReferralInfo] = useState(false);

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
          setGroupEnrollment(data.groupEnrollment || {});
        }
      })
      .catch(() => setError("Failed to load schedule"))
      .finally(() => setLoading(false));
  }, []);

  // Scroll to hash anchor after data loads (fixes mobile layout-shift issue)
  useEffect(() => {
    if (!loading && typeof window !== "undefined" && window.location.hash) {
      const el = document.querySelector(window.location.hash);
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }
  }, [loading]);

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = useState(false);
  const [pendingGroupOpen, setPendingGroupOpen] = useState(false);
  const profileRef = useRef<{ parentName: string; phone: string; kids: { name: string; dob: string; grade: string }[] } | null>(null);
  const pendingBookingRef = useRef<{
    kind: "modal"; type: BookingType; sessionIndex: number; details: string;
  } | {
    kind: "private";
    windowDate: string; windowLocation: string; windowStartMins: number;
    savedStart: number; savedDuration: number;
  } | {
    kind: "group"; savedGroup: string; savedKeys: string[];
  } | null>(null);

  // Read any pending booking from sessionStorage on mount
  useEffect(() => {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem("mesa_pending_booking") : null;
    if (raw) {
      pendingBookingRef.current = JSON.parse(raw);
      sessionStorage.removeItem("mesa_pending_booking");
    }
  }, []);

  function showAuthPrompt(data: typeof pendingBookingRef.current) {
    if (data) sessionStorage.setItem("mesa_pending_booking", JSON.stringify(data));
    setAuthPrompt(true);
  }

  async function saveProfile() {
    const { data: { session } } = await authClient.auth.getSession();
    if (!session) return;
    fetch("/api/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ parentName, phone, kids }),
    });
  }

  // Pre-fill form from saved profile if logged in
  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? null);
      if (!session) return;
      fetch("/api/profile", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => r.json())
        .then((profile) => {
          if (profile.parent_name) setParentName(profile.parent_name);
          if (profile.email) setEmail(profile.email);
          if (profile.phone) setPhone(profile.phone);
          if (profile.kids?.length) setKids(profile.kids);
          profileRef.current = {
            parentName: profile.parent_name || "",
            phone: profile.phone || "",
            kids: profile.kids?.length ? profile.kids : [{ name: "", dob: "", grade: "" }],
          };
        });
    });
  }, []);

  const pkgMonthOptions = useMemo(() => {
    const now = new Date();
    const options = [];
    for (let i = 0; i < 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const value = d.toISOString().substring(0, 7);
      const label = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      options.push({ value, label });
    }
    return options;
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

  function openPrivateBooking(windowIdx: number, window: TimeWindow, overrideSel?: { start: number; duration: number }) {
    if (!userEmail) {
      const sel = windowSelections[windowIdx] || { start: window.startMins, duration: 60 };
      showAuthPrompt({
        kind: "private",
        windowDate: window.date,
        windowLocation: window.location,
        windowStartMins: window.startMins,
        savedStart: sel.start,
        savedDuration: sel.duration,
      });
      return;
    }
    const sel = overrideSel || windowSelections[windowIdx] || {
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
    setParentName(profileRef.current?.parentName ?? "");
    setPhone(profileRef.current?.phone ?? "");
    setSmsConsent(true);
    setShowAllRecurring(false);
    setKids(profileRef.current?.kids ?? [{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
  }

  function openModal(type: BookingType, sessionIndex: number, details: string) {
    if (!userEmail) { showAuthPrompt({ kind: "modal", type, sessionIndex, details }); return; }
    setModal({ open: true, type, sessionIndex, sessionDetails: details });
    setSubmitResult(null);
    setParentName(profileRef.current?.parentName ?? "");
    setPhone(profileRef.current?.phone ?? "");
    setSmsConsent(true);
    setShowAllRecurring(false);
    setKids(profileRef.current?.kids ?? [{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
    // Pre-select all days for camps with day selection
    if (type === "camp") {
      const camp = camps[sessionIndex];
      if (camp?.campDays?.length > 0) {
        setCampSelectedDays(new Set(camp.campDays));
      } else {
        setCampSelectedDays(new Set());
      }
    }
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
      // Weekly multi-session registration
      if (bookingType === "weekly" && modal.selectedGroupSessions && modal.selectedGroupSessions.length > 0) {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            smsConsent,
            kids: kidsStr,
            type: "weekly",
            sessionDetails: modal.sessionDetails,
            totalParticipants,
            weeklySessions: modal.selectedGroupSessions,
            weeklyTotalPrice: (modal.weeklyTotalPrice || 0) * kids.length,
            submittedReferralCode: referralCode.trim() || undefined,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          setSubmitResult({ success: false, message: result.error || "Registration failed." });
          setSubmitting(false);
          return;
        }
        setSubmitResult({
          success: true,
          message: `${modal.selectedGroupSessions.length} sessions booked! A confirmation email has been sent to ${email}.`,
        });
        saveProfile();
        // Clear selections
        setSelectedGroupKeys(new Set());
        const fresh = await fetch("/api/schedule").then((r) => r.json());
        setSchedule(fresh.weeklySchedule || []);
        setCamps(fresh.camps || []);
        setPrivateSlots(fresh.privateSlots || []);
        setBookedSlots(fresh.bookedSlots || []);
        setGroupEnrollment(fresh.groupEnrollment || {});
        setSubmitting(false);
        return;
      }

      // Camp multi-day registration
      if (bookingType === "camp" && campSelectedDays.size > 0) {
        const camp = camps[modal.sessionIndex];
        if (camp?.campDays?.length > 0) {
          const selectedDaysArr = camp.campDays.filter((d) => campSelectedDays.has(d));
          const totalPrice = calcCampPrice(selectedDaysArr.length, camp.campDays.length, camp, kids.length);
          const campSessions = selectedDaysArr.map((day) => ({
            date: day,
            startTime: camp.time.split("-")[0]?.trim() || camp.time,
            endTime: camp.time.split("-")[1]?.trim() || "",
            location: camp.location,
            campName: camp.name,
            gradeGroup: camp.gradeGroup,
          }));
          const res = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parentName,
              email,
              phone,
              smsConsent,
              kids: kidsStr,
              type: "camp",
              sessionDetails: modal.sessionDetails,
              totalParticipants,
              campSessions,
              campTotalPrice: totalPrice,
              campTotalDays: camp.campDays.length,
            }),
          });
          const result = await res.json();
          if (!res.ok) {
            setSubmitResult({ success: false, message: result.error || "Registration failed." });
            setSubmitting(false);
            return;
          }
          setSubmitResult({
            success: true,
            message: `Camp registration confirmed for ${selectedDaysArr.length} day${selectedDaysArr.length !== 1 ? "s" : ""}! A confirmation email has been sent to ${email}.`,
          });
          saveProfile();
          setCampSelectedDays(new Set());
          const fresh = await fetch("/api/schedule").then((r) => r.json());
          setCamps(fresh.camps || []);
          setSubmitting(false);
          return;
        }
      }

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

      // Register each date (skip emails for all — we'll send one consolidated email)
      const isRecurring = datesToBook.length > 1;
      for (const booking of datesToBook) {
        await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            smsConsent,
            kids: kidsStr,
            type: bookingType,
            sessionDetails: `Private Session — ${booking.date} ${booking.startTime}-${booking.endTime} at ${booking.location}`,
            sessionIndex: modal.sessionIndex,
            totalParticipants,
            bookedDate: booking.date,
            bookedStartTime: booking.startTime,
            bookedEndTime: booking.endTime,
            bookedLocation: booking.location,
            skipEmail: isRecurring,
            submittedReferralCode: referralCode.trim() || undefined,
          }),
        });
      }

      // Send one consolidated email listing all dates
      if (isRecurring) {
        const allSessionsList = datesToBook
          .map((d) => `${d.date} ${d.startTime}-${d.endTime} at ${d.location}`)
          .join("<br/>");
        await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            smsConsent,
            kids: kidsStr,
            type: bookingType,
            sessionDetails: `Recurring Private Sessions:<br/>${allSessionsList}`,
            sessionIndex: modal.sessionIndex,
            totalParticipants,
            emailOnly: true,
            submittedReferralCode: referralCode.trim() || undefined,
          }),
        });
      }

      setSubmitResult({
        success: true,
        message: datesToBook.length > 1
          ? `${datesToBook.length} sessions booked! A confirmation email has been sent to ${email}.`
          : `Booking confirmed! A confirmation email has been sent to ${email}.`,
      });
      saveProfile();
      const fresh = await fetch("/api/schedule").then((r) => r.json());
      setSchedule(fresh.weeklySchedule || []);
      setCamps(fresh.camps || []);
      setPrivateSlots(fresh.privateSlots || []);
      setBookedSlots(fresh.bookedSlots || []);
      setGroupEnrollment(fresh.groupEnrollment || {});
    } catch {
      setSubmitResult({
        success: false,
        message: "Something went wrong. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePackageSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPkgSubmitting(true);
    setPkgResult(null);
    const kidsStr = kids.map((k) => `${k.name} (DOB: ${k.dob}, Grade: ${k.grade})`).join(", ");
    try {
      const res = await fetch("/api/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentName: pkgName,
          email: pkgEmail,
          phone: pkgPhone,
          packageType: pkgModal.packageType,
          monthYear: pkgMonth,
          kids: kidsStr,
          referralCode: referralCode.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPkgResult({ success: false, message: data.error || "Enrollment failed." });
      } else {
        setPkgResult({ success: true, message: `You're enrolled! Check your email for details. Book your ${pkgModal.packageType} private sessions for ${pkgMonthOptions.find(o => o.value === pkgMonth)?.label} and we'll track them automatically.` });
      }
    } catch {
      setPkgResult({ success: false, message: "Something went wrong. Please try again." });
    } finally {
      setPkgSubmitting(false);
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

  // Dates that have available private slots (for calendar highlights)
  const calendarHighlightedDates = useMemo(() => {
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const dates = new Set<string>();
    timeWindows.forEach((w) => {
      if (w.endMins - w.startMins < 60) return;
      const d = new Date(w.date);
      if (d < today) return;
      if (d.getTime() === today.getTime()) {
        const nextValidStart = Math.ceil(currentMins / 15) * 15;
        const effectiveStart = Math.max(w.startMins, nextValidStart);
        if (w.endMins - effectiveStart < 60) return;
      }
      dates.add(w.date);
    });
    return dates;
  }, [timeWindows]);

  // Filter time windows by day of week, month, calendar date, and past dates
  const filteredWindows = useMemo(() => {
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    return timeWindows.filter((w) => {
      if (w.endMins - w.startMins < 60) return false;
      const d = new Date(w.date);
      if (d < today) return false;
      if (d.getTime() === today.getTime()) {
        const nextValidStart = Math.ceil(currentMins / 15) * 15;
        const effectiveStart = Math.max(w.startMins, nextValidStart);
        if (w.endMins - effectiveStart < 60) return false;
      }
      if (calendarSelectedDate && w.date !== calendarSelectedDate) return false;
      if (filterDays.size > 0 && !filterDays.has(d.getUTCDay())) return false;
      if (filterMonth) {
        const monthStr = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        if (monthStr !== filterMonth) return false;
      }
      return true;
    });
  }, [timeWindows, filterDays, filterMonth, calendarSelectedDate]);

  // Available months from time windows
  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    timeWindows.forEach((w) => {
      if (w.endMins - w.startMins < 60) return;
      const d = new Date(w.date);
      months.add(d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }));
    });
    return Array.from(months);
  }, [timeWindows]);

  // Available days from time windows
  const availableDays = useMemo(() => {
    const days = new Set<number>();
    timeWindows.forEach((w) => {
      if (w.endMins - w.startMins < 60) return;
      days.add(new Date(w.date).getUTCDay());
    });
    return Array.from(days).sort();
  }, [timeWindows]);

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // --- Group session helpers ---
  const ALL_GRADES = [
    { value: "K", label: "Kindergarten" },
    { value: "1", label: "1st Grade" }, { value: "2", label: "2nd Grade" },
    { value: "3", label: "3rd Grade" }, { value: "4", label: "4th Grade" },
    { value: "5", label: "5th Grade" }, { value: "6", label: "6th Grade" },
    { value: "7", label: "7th Grade" }, { value: "8", label: "8th Grade" },
    { value: "9", label: "9th Grade" }, { value: "10", label: "10th Grade" },
    { value: "11", label: "11th Grade" }, { value: "12", label: "12th Grade" },
    { value: "College +", label: "College / Pro" },
    { value: "Adult", label: "Adult" },
  ];
  const GRADE_ORDER = ["K","1","2","3","4","5","6","7","8","9","10","11","12","College +","Adult"];

  function getGradesForGroup(groupName: string) {
    const match = groupName.match(/Grades?\s+(K|\d+)[–\-](\d+|College\s*\+?)/i);
    if (!match) return ALL_GRADES;
    const start = match[1].toUpperCase();
    const end = match[2].replace(/\s+/g, " ").trim();
    const endVal = end.toLowerCase().startsWith("college") ? "College +" : end;
    const si = GRADE_ORDER.indexOf(start);
    const ei = GRADE_ORDER.indexOf(endVal);
    if (si === -1 || ei === -1) return ALL_GRADES;
    const allowed = new Set(GRADE_ORDER.slice(si, ei + 1));
    return ALL_GRADES.filter((g) => allowed.has(g.value));
  }

  function getGroupSessionKey(s: WeeklySession): string {
    return `${s.group}|${s.date}|${s.startTime}`;
  }

  function getEnrollmentCount(s: WeeklySession): number {
    const key = `${s.date}|${s.startTime}`;
    return groupEnrollment[key] || 0;
  }

  function isFutureSession(s: WeeklySession): boolean {
    const sessionDate = new Date(s.date);
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (sessionDate > today) return true;
    if (sessionDate < today) return false;
    // Same day — check if start time is still in the future
    const sessionStartMins = parseTime(s.startTime);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    return sessionStartMins > currentMins;
  }

  function isSessionFull(s: WeeklySession): boolean {
    return getEnrollmentCount(s) >= s.maxSpots;
  }

  function toggleGroupSession(s: WeeklySession) {
    const key = getGroupSessionKey(s);
    setSelectedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // Get selected sessions for the active group
  const selectedSessionsForActiveGroup = useMemo(() => {
    return schedule.filter(
      (s) => s.group === activeGroup && selectedGroupKeys.has(getGroupSessionKey(s))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule, activeGroup, selectedGroupKeys]);

  // Auto-restore pending booking once schedule + user are both ready
  useEffect(() => {
    if (loading || !userEmail || !pendingBookingRef.current) return;
    const pending = pendingBookingRef.current;
    pendingBookingRef.current = null;
    if (pending.kind === "modal") {
      openModal(pending.type, pending.sessionIndex, pending.details);
    } else if (pending.kind === "private") {
      const winIdx = timeWindows.findIndex(
        (w) => w.date === pending.windowDate && w.location === pending.windowLocation && w.startMins === pending.windowStartMins
      );
      if (winIdx !== -1) {
        const win = timeWindows[winIdx];
        const savedSel = { start: pending.savedStart, duration: pending.savedDuration };
        setWindowSelections((prev) => ({ ...prev, [winIdx]: savedSel }));
        openPrivateBooking(winIdx, win, savedSel);
      }
    } else if (pending.kind === "group") {
      setActiveGroup(pending.savedGroup);
      setSelectedGroupKeys(new Set(pending.savedKeys));
      setPendingGroupOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, userEmail]);

  // Auto-open group registration once sessions are restored and ready
  useEffect(() => {
    if (!pendingGroupOpen || selectedSessionsForActiveGroup.length < 1) return;
    setPendingGroupOpen(false);
    openGroupRegistration();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGroupOpen, selectedSessionsForActiveGroup]);

  // Compute group session pricing
  const groupPricing = useMemo(() => {
    const sessions = selectedSessionsForActiveGroup;
    const count = sessions.length;
    if (count === 0) return { count: 0, unitPrice: 0, totalPrice: 0, savings: 0, discountLabel: "" };

    const basePrice = sessions[0]?.price || 50;
    let discountPct = 0;
    let discountLabel = "";

    if (count >= 8) {
      discountPct = 0.15;
      discountLabel = "15% off (8+ sessions)";
    } else if (count >= 4) {
      discountPct = 0.10;
      discountLabel = "10% off (4-7 sessions)";
    }

    const unitPrice = Math.round(basePrice * (1 - discountPct) * 100) / 100;
    const totalPrice = Math.round(unitPrice * count * 100) / 100;
    const fullTotal = basePrice * count;
    const savings = Math.round((fullTotal - totalPrice) * 100) / 100;

    return { count, unitPrice, totalPrice, savings, discountLabel, basePrice };
  }, [selectedSessionsForActiveGroup]);

  function openGroupRegistration() {
    if (!userEmail) { showAuthPrompt({ kind: "group", savedGroup: activeGroup, savedKeys: Array.from(selectedGroupKeys) }); return; }
    const sessions = selectedSessionsForActiveGroup;
    if (sessions.length < 1) return;

    const sessionList = sessions
      .map((s) => {
        const d = new Date(s.date);
        const dayName = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
        return `${dayName} ${s.date} ${s.startTime}-${s.endTime}`;
      })
      .join(", ");

    setModal({
      open: true,
      type: "weekly",
      sessionIndex: 0,
      sessionDetails: `${activeGroup} — ${sessions.length} sessions`,
      selectedGroupSessions: sessions.map((s) => ({
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        location: s.location,
        group: s.group,
        maxSpots: s.maxSpots,
        price: s.price,
      })),
      weeklyTotalPrice: groupPricing.totalPrice,
      weeklySavings: groupPricing.savings,
    });
    setSubmitResult(null);
    setParentName(profileRef.current?.parentName ?? "");
    setPhone(profileRef.current?.phone ?? "");
    setSmsConsent(true);
    setShowAllRecurring(false);
    setKids(profileRef.current?.kids ?? [{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
  }

  const grouped = groupByGroup(schedule);

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      {/* Sticky Nav */}
      <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <a href="/" className="flex items-center gap-2 text-lg font-bold text-mesa-dark -ml-5 md:ml-0">
            <div className="h-10 w-[120px] flex items-center overflow-visible">
              <img src="/logo.png" alt="Mesa Basketball Logo" className="h-[120px] w-[120px] object-contain" />
            </div>
            <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
          </a>
          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-4 text-sm">
            <a href="/" className="text-brown-600 hover:text-mesa-dark">Home</a>
            <span className="text-brown-300">|</span>
            <a href="/about" className="text-brown-600 hover:text-mesa-dark">About</a>
            <span className="text-brown-300">|</span>
            <div className="relative group">
              <a href="#schedule" className="flex items-center gap-1 text-brown-600 hover:text-mesa-dark">
                Programs
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </a>
              <div className="absolute top-full left-0 w-44 z-50 hidden group-hover:block pt-2">
                <div className="rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                  <a href="#schedule" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Group Sessions</a>
                  <a href="#camps" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Camps</a>
                  <a href="#private" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Private Sessions</a>
                </div>
              </div>
            </div>
            <span className="text-brown-300">|</span>
            {userEmail ? (
              <div className="relative group">
                <button className="flex items-center gap-1 rounded bg-brown-600/20 px-3 py-1 text-brown-600 hover:bg-brown-600/30">
                  Account
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div className="absolute top-full right-0 w-44 z-50 hidden group-hover:block pt-2">
                  <div className="rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                    <div className="px-4 py-2 border-b border-gray-100">
                      <p className="text-xs text-brown-400">Signed in as</p>
                      <p className="text-xs font-medium text-brown-700 truncate max-w-[160px]">{userEmail}</p>
                    </div>
                    <a href="/my-bookings" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">My Bookings</a>
                    <a href="/settings" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Settings</a>
                    {userEmail === ADMIN_EMAIL && (
                      <a href="/admin" className="block px-4 py-2 text-mesa-accent hover:text-yellow-600 hover:bg-gray-50 font-medium">Admin</a>
                    )}
                    <div className="border-t border-gray-100 mt-1 pt-1">
                      <button onClick={async () => { await authClient.auth.signOut(); window.location.href = "/"; }} className="w-full text-left block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Sign Out</button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <a href="/login?next=/schedule" className="rounded bg-brown-600/20 px-3 py-1 text-brown-600 hover:bg-brown-600/30">Login</a>
            )}
            <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="text-brown-600 hover:text-mesa-dark">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
          {/* Mobile hamburger */}
          <button
            className="md:hidden text-brown-600 hover:text-mesa-dark p-1"
            onClick={() => setMobileMenuOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 bg-white px-6 py-4 space-y-4 text-sm">
            <a href="/" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">Home</a>
            <a href="/about" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">About</a>
            <div>
              <div className="flex items-center justify-between">
                <a href="/schedule" onClick={() => setMobileMenuOpen(false)} className="flex-1 py-2 text-brown-600 hover:text-mesa-dark">Programs</a>
                <button onClick={() => setSchedulingOpen((o) => !o)} className="px-3 py-2 text-brown-600 hover:text-mesa-dark" aria-label="Toggle programs submenu">
                  <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 transition-transform ${schedulingOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
              {schedulingOpen && (
                <div className="ml-4 mt-1 space-y-1">
                  <a href="#schedule" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Group Sessions</a>
                  <a href="#camps" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Camps</a>
                  <a href="#private" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Private Sessions</a>
                </div>
              )}
            </div>
            <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 text-brown-600 hover:text-mesa-dark py-1">
              Instagram
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
            {userEmail ? (
              <>
                <p className="text-xs text-brown-400 px-1">Signed in as <span className="font-medium text-brown-600">{userEmail}</span></p>
                <a href="/my-bookings" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 text-center font-medium">My Bookings</a>
                <a href="/settings" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 text-center font-medium">Settings</a>
                {userEmail === ADMIN_EMAIL && (
                  <a href="/admin" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-mesa-accent/20 px-3 py-2 text-mesa-accent hover:bg-mesa-accent/30 text-center font-medium">Admin</a>
                )}
                <button onClick={async () => { await authClient.auth.signOut(); window.location.href = "/"; }} className="block w-full text-center rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 font-medium">Sign Out</button>
              </>
            ) : (
              <a href="/login?next=/schedule" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 text-center font-medium">Login</a>
            )}
          </div>
        )}
      </nav>

      {/* Page Header */}
      <header className="relative border-b border-brown-800 overflow-hidden min-h-[38vh] md:min-h-[65vh] flex items-end">
        <Image
          src="/photos/grid5.jpg"
          alt="Basketball training session"
          fill
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-mesa-dark via-mesa-dark/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-mesa-dark/60 via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl w-full px-6 py-10 md:py-16">
          <p className="text-sm font-semibold uppercase tracking-widest text-mesa-accent mb-2">Mesa Basketball Training</p>
          <h1 className="font-[family-name:var(--font-fira-cond)] text-4xl font-black tracking-wide md:text-6xl">
            SCHEDULE &amp; BOOK
          </h1>
          <p className="mt-3 text-brown-300 text-sm max-w-md">
            Browse available sessions below and register online. Questions? Call or text{" "}
            <a href="tel:6315991280" className="text-mesa-accent hover:text-yellow-400">(631) 599-1280</a>.
          </p>
        </div>
      </header>

      {/* Weekly Schedule */}
      <section id="schedule" className="py-16 scroll-mt-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-[family-name:var(--font-oswald)] text-center text-3xl font-bold tracking-wide">Group Sessions</h2>
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            <a href="#group-schedule" className="rounded-lg border border-mesa-accent bg-brown-800/60 px-4 py-2 text-center hover:bg-brown-700/60 hover:border-yellow-400 transition cursor-pointer">
              <p className="text-lg font-bold text-mesa-accent">$50 / session</p>
              <p className="text-xs text-brown-400">Volume discounts available</p>
            </a>
          </div>
          <p className="mt-3 text-center text-brown-400">
            Skill work in groups of up to 6 players. Volume discounts available when booking multiple sessions.
          </p>
          <p className="mt-2 text-center text-xs text-brown-500">
            Groups are organized by grade as a guideline. If you play up or you&apos;re unsure which group fits best, contact Artemios at (631) 599-1280 or artemios@mesabasketballtraining.com — we&apos;ll find the right fit.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-brown-500">
            <span>1-3 sessions: $50 each</span>
            <span className="text-brown-600">|</span>
            <span>4-7 sessions: <span className="text-green-400/80">10% off</span></span>
            <span className="text-brown-600">|</span>
            <span>8+ sessions: <span className="text-green-400/80">15% off</span></span>
          </div>

          {loading && <p className="mt-8 text-center text-brown-400">Loading schedule...</p>}
          {error && <p className="mt-8 text-center text-red-400">{error}</p>}

          <div id="group-schedule" className="mt-8 grid gap-6 md:grid-cols-2 scroll-mt-24">
            {Object.entries(grouped).map(([group, sessions]) => {
              const futureSessions = sessions.filter(isFutureSession);
              if (futureSessions.length === 0) return null;
              const isActive = activeGroup === group;
              const selectedCount = futureSessions.filter(
                (s) => selectedGroupKeys.has(getGroupSessionKey(s))
              ).length;

              return (
                <div
                  key={group}
                  className={`rounded-xl border p-6 transition cursor-pointer ${
                    isActive
                      ? "border-mesa-accent bg-brown-900/60"
                      : "border-brown-700 bg-brown-900/40 hover:border-brown-500"
                  }`}
                  onClick={() => {
                    setActiveGroup(isActive ? "" : group);
                    if (!isActive) {
                      setSelectedGroupKeys(new Set());
                      setGroupDayFilter(new Set());
                    }
                  }}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-mesa-accent">{group.replace("Grade 5 & Below", "Grades K-5")}</h3>
                    <div className="flex items-center gap-2">
                      {selectedCount > 0 && (
                        <span className="rounded-full bg-mesa-accent/20 px-2 py-0.5 text-xs font-semibold text-mesa-accent">
                          {selectedCount} selected
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-brown-500">
                    {futureSessions.length} upcoming session{futureSessions.length !== 1 ? "s" : ""}
                  </p>

                  {isActive && (() => {
                    // Compute available days for this group
                    const availDays = Array.from(
                      new Set(futureSessions.map((s) => new Date(s.date).getUTCDay()))
                    ).sort();
                    const filteredSessions = groupDayFilter.size > 0
                      ? futureSessions.filter((s) => groupDayFilter.has(new Date(s.date).getUTCDay()))
                      : futureSessions;
                    const showAll = showAllGroups.has(group);
                    const visibleSessions = showAll ? filteredSessions : filteredSessions.slice(0, 5);

                    return (
                    <div className="mt-4 space-y-2" onClick={(e) => e.stopPropagation()}>
                      <p className="text-sm font-bold text-mesa-accent mb-3">$50 / session</p>
                      {/* Day filter + Select all */}
                      {availDays.length > 1 && (
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          {availDays.map((day) => (
                            <button
                              key={day}
                              onClick={() => setGroupDayFilter((prev) => {
                                const next = new Set(prev);
                                if (next.has(day)) next.delete(day);
                                else next.add(day);
                                return next;
                              })}
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                                groupDayFilter.has(day)
                                  ? "bg-mesa-accent text-white"
                                  : "bg-brown-800 text-brown-400 hover:bg-brown-700"
                              }`}
                            >
                              {DAY_LABELS[day]}
                            </button>
                          ))}
                          {groupDayFilter.size === 1 && (() => {
                            const dayNum = Array.from(groupDayFilter)[0];
                            const dayName = DAY_LABELS[dayNum];
                            const daySessions = futureSessions.filter(
                              (s) => new Date(s.date).getUTCDay() === dayNum && !isSessionFull(s)
                            );
                            const allSelected = daySessions.every((s) => selectedGroupKeys.has(getGroupSessionKey(s)));
                            return (
                              <button
                                onClick={() => {
                                  setSelectedGroupKeys((prev) => {
                                    const next = new Set(prev);
                                    if (allSelected) {
                                      daySessions.forEach((s) => next.delete(getGroupSessionKey(s)));
                                    } else {
                                      daySessions.forEach((s) => next.add(getGroupSessionKey(s)));
                                    }
                                    return next;
                                  });
                                }}
                                className="text-xs text-mesa-accent hover:text-yellow-300 ml-1"
                              >
                                {allSelected ? `Deselect all ${dayName}s` : `Select all ${dayName}s`}
                              </button>
                            );
                          })()}
                          {groupDayFilter.size > 0 && (
                            <button
                              onClick={() => setGroupDayFilter(new Set())}
                              className="text-xs text-brown-500 hover:text-brown-400"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                      {visibleSessions.map((s) => {
                        const key = getGroupSessionKey(s);
                        const enrolled = getEnrollmentCount(s);
                        const spotsLeft = s.maxSpots - enrolled;
                        const full = spotsLeft <= 0;
                        const checked = selectedGroupKeys.has(key);
                        const d = new Date(s.date);
                        const dayName = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

                        return (
                          <label
                            key={key}
                            className={`flex items-center gap-3 rounded-lg px-4 py-3 transition ${
                              full
                                ? "bg-brown-800/30 opacity-50 cursor-not-allowed"
                                : checked
                                  ? "bg-mesa-accent/10 border border-mesa-accent/30"
                                  : "bg-brown-800/50 hover:bg-brown-800/70 cursor-pointer"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={full}
                              onChange={() => toggleGroupSession(s)}
                              className="rounded border-brown-600 accent-mesa-accent h-4 w-4"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">
                                {dayName}, {s.date}
                              </p>
                              <p className="text-xs text-brown-400">
                                {s.startTime} - {s.endTime} &bull; <LocationLink location={s.location} />
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              {full ? (
                                <span className="text-xs font-medium text-red-400">FULL</span>
                              ) : spotsLeft <= 2 ? (
                                <span className="text-xs font-medium text-yellow-400">Almost full!</span>
                              ) : null}
                            </div>
                          </label>
                        );
                      })}

                      {/* View more/less sessions */}
                      {filteredSessions.length > 5 && (
                        <button
                          onClick={() => setShowAllGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(group)) next.delete(group);
                            else next.add(group);
                            return next;
                          })}
                          className="w-full rounded-lg border border-brown-700 py-1.5 text-xs text-brown-400 hover:border-brown-500 hover:text-white transition"
                        >
                          {showAll ? "Show less ↑" : `View ${filteredSessions.length - 5} more sessions ↓`}
                        </button>
                      )}

                      {/* Pricing summary and register button */}
                      {groupPricing.count > 0 && (
                        <div className="mt-4 rounded-lg border border-brown-700 bg-brown-800/60 p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-semibold text-white">
                                {groupPricing.count} session{groupPricing.count !== 1 ? "s" : ""} &times; ${groupPricing.unitPrice}
                                {" = "}
                                <span className="text-mesa-accent">${groupPricing.totalPrice}</span>
                                <span className="text-brown-400 text-xs font-normal ml-1">per athlete</span>
                              </p>
                              {groupPricing.savings > 0 && (
                                <p className="text-xs text-green-400 mt-0.5">
                                  {groupPricing.discountLabel} — You save ${groupPricing.savings}!
                                </p>
                              )}
                              {groupPricing.count >= 1 && groupPricing.count < 4 && (
                                <p className="text-xs text-brown-500 mt-0.5">
                                  Add {4 - groupPricing.count} more for 10% off
                                </p>
                              )}
                              {groupPricing.count >= 4 && groupPricing.count < 8 && (
                                <p className="text-xs text-brown-500 mt-0.5">
                                  Add {8 - groupPricing.count} more for 15% off
                                </p>
                              )}
                            </div>
                            <button
                              onClick={openGroupRegistration}
                              disabled={groupPricing.count < 1}
                              className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-yellow-600 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Register
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Photo divider before camps */}
      <div className="relative h-64 md:h-[26rem] overflow-hidden">
        <Image
          src="/photos/grid10.jpg"
          alt="Basketball camp training"
          fill
          className="object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-mesa-dark/85 via-mesa-dark/50 to-mesa-dark/85" />
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-[family-name:var(--font-fira-cond)] text-xl md:text-4xl font-black tracking-wide md:tracking-widest text-white text-center px-6 drop-shadow-lg">
            MINI CAMPS &amp; <span className="text-mesa-accent">INTENSIVE TRAINING</span>
          </p>
        </div>
      </div>

      {/* Mini Camps */}
      <section id="camps" className="bg-brown-900/30 py-16 scroll-mt-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-[family-name:var(--font-oswald)] text-center text-3xl font-bold tracking-wide">Mini Camps</h2>
          <p className="mt-2 text-center text-brown-400">
            Intensive multi-day programs — spots are limited, register early.
          </p>

          {camps.length === 0 && !loading && (
            <p className="mt-8 text-center text-brown-500">No camps are currently open for registration. Check back soon or reach out to be notified when the next one is announced.</p>
          )}

          {(() => {
            // Group camps by name
            const campGroups: { name: string; camps: { camp: Camp; index: number }[] }[] = [];
            const seen = new Map<string, number>();
            camps.forEach((camp, i) => {
              if (!seen.has(camp.name)) {
                seen.set(camp.name, campGroups.length);
                campGroups.push({ name: camp.name, camps: [] });
              }
              campGroups[seen.get(camp.name)!].camps.push({ camp, index: i });
            });

            return campGroups.map((group) => {
              const isMultiGroup = group.camps.length > 1 || !!group.camps[0]?.camp.gradeGroup;
              const firstCamp = group.camps[0].camp;
              const earlyBird = isEarlyBirdActive();

              if (isMultiGroup) {
                return (
                  <div key={group.name} className="mt-8 rounded-xl border border-brown-700 bg-brown-900/40 p-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="text-xl font-bold text-mesa-accent">{group.name}</h3>
                        <p className="text-sm text-brown-300 mt-0.5">
                          {firstCamp.startDate}{firstCamp.endDate ? ` — ${firstCamp.endDate}` : ""} &bull; <LocationLink location={firstCamp.location} />
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {earlyBird && firstCamp.earlyBirdPrice ? (
                          <>
                            <span className="rounded-full bg-green-900/60 border border-green-700 px-3 py-1 text-sm font-bold text-green-400">
                              Early Bird: {firstCamp.earlyBirdPrice}
                            </span>
                            <span className="text-xs text-brown-500 line-through">{firstCamp.price} after Mar 31</span>
                          </>
                        ) : (
                          <span className="rounded-full bg-brown-800 px-3 py-1 text-sm font-semibold text-mesa-accent">{firstCamp.price}</span>
                        )}
                        {firstCamp.dropInPrice && (
                          <span className="text-xs text-brown-400">{firstCamp.dropInPrice}/day drop-in</span>
                        )}
                      </div>
                    </div>
                    {firstCamp.description && <p className="mt-2 text-sm text-brown-400">{firstCamp.description}</p>}
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      {group.camps.map(({ camp, index }) => (
                        <div key={camp.id} className="rounded-lg border border-brown-600 bg-brown-800/50 p-4 flex flex-col gap-2">
                          <p className="font-semibold text-white text-sm">{camp.gradeGroup}</p>
                          <p className="text-xs text-brown-400">{camp.time}</p>
                          <button
                            onClick={() => openModal("camp", index, `${camp.name} — ${camp.gradeGroup} at ${camp.location}`)}
                            className="mt-auto rounded bg-mesa-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-yellow-600"
                          >
                            Register
                          </button>
                        </div>
                      ))}
                    </div>
                    {firstCamp.campDays.length > 0 && (
                      <p className="mt-3 text-xs text-brown-500">
                        Select any combination of days — {firstCamp.dropInPrice}/day drop-in, or {earlyBird && firstCamp.earlyBirdPrice ? `${firstCamp.earlyBirdPrice} early bird` : firstCamp.price} for all {firstCamp.campDays.length} days.
                      </p>
                    )}
                  </div>
                );
              }

              // Original single-card layout
              const { camp, index } = group.camps[0];
              const spotsLeft = camp.maxSpots - camp.currentEnrolled;
              const full = spotsLeft <= 0;
              return (
                <div key={camp.id} className="mt-8 rounded-xl border border-brown-700 bg-brown-900/40 p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-bold text-mesa-accent">{camp.name}</h3>
                      <p className="text-sm text-brown-300">{camp.startDate}{camp.endDate ? ` — ${camp.endDate}` : ""}</p>
                    </div>
                    <span className="rounded-full bg-brown-800 px-3 py-1 text-sm font-semibold text-mesa-accent">
                      {camp.price}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-brown-400">{camp.time} &bull; <LocationLink location={camp.location} /></p>
                  {camp.description && <p className="mt-2 text-sm text-brown-300">{camp.description}</p>}
                  <div className="mt-4 flex items-center justify-between">
                    <span className={`text-sm font-medium ${full ? "text-red-400" : "text-yellow-400"}`}>
                      {full ? "FULL" : spotsLeft <= 3 ? `${spotsLeft} spot${spotsLeft !== 1 ? "s" : ""} left` : ""}
                    </span>
                    {!full && (
                      <button
                        onClick={() => openModal("camp", index, `${camp.name} (${camp.startDate}${camp.endDate ? ` — ${camp.endDate}` : ""}) at ${camp.location}`)}
                        className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-yellow-600"
                      >
                        Register
                      </button>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </section>

      {/* Photo divider before private */}
      <div className="relative h-64 md:h-[26rem] overflow-hidden">
        <Image
          src="/photos/grid3.jpg"
          alt="Private basketball training session"
          fill
          className="object-cover object-top md:object-top"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-mesa-dark/85 via-mesa-dark/50 to-mesa-dark/85" />
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-[family-name:var(--font-fira-cond)] text-xl md:text-4xl font-black tracking-wide md:tracking-widest text-white text-center px-6 drop-shadow-lg">
            PRIVATE &amp; <span className="text-mesa-accent">1-ON-1 TRAINING</span>
          </p>
        </div>
      </div>

      {/* Private Sessions */}
      <section id="private" className="py-16 scroll-mt-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="font-[family-name:var(--font-oswald)] text-center text-3xl font-bold tracking-wide">Private Sessions</h2>
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            <a href="#private-schedule" className="rounded-lg border border-mesa-accent bg-brown-800/60 px-4 py-2 text-center hover:bg-brown-700/60 hover:border-yellow-400 transition cursor-pointer">
              <p className="text-lg font-bold text-mesa-accent">$150 / 60 min</p>
              <p className="text-xs text-brown-400">Up to 3 participants</p>
            </a>
            <a href="#private-schedule" className="rounded-lg border border-mesa-accent bg-brown-800/60 px-4 py-2 text-center hover:bg-brown-700/60 hover:border-yellow-400 transition cursor-pointer">
              <p className="text-lg font-bold text-mesa-accent">$250 / 60 min</p>
              <p className="text-xs text-brown-400">Group Private (4+ players)</p>
            </a>
          </div>
          <p className="mt-2 text-center text-sm text-brown-500">
            Payment due upon registration — Cash, Venmo, or Zelle
          </p>
          <p className="mt-2 text-center text-sm text-green-400/80">
            New Clients: First Session 50% Off
          </p>

          {/* Monthly Packages */}
          <div className="mt-10 border-t border-brown-800 pt-8">
            <h3 className="text-center text-xl font-bold">Monthly Packages</h3>
            <p className="mt-1 text-center text-sm text-brown-400">
              Commit to a full month of training and save — private sessions only.
            </p>
            <p className="mt-1 text-center text-xs text-brown-500">Up to 3 players per package.</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {/* 4-session */}
              <div className="rounded-xl border border-brown-700 bg-brown-900/40 p-5 text-center">
                <p className="text-3xl font-bold text-mesa-accent">$475</p>
                <p className="mt-0.5 text-sm text-brown-300">4 sessions / month</p>
                <div className="mt-3 rounded-lg bg-brown-800/50 p-3 space-y-0.5">
                  <p className="text-xs text-brown-500">Normally <span className="line-through">$600</span></p>
                  <p className="text-sm font-semibold text-green-400">Save $125 — 21% off</p>
                  <p className="text-xs text-brown-400">$118.75 per session</p>
                </div>
                <button
                  onClick={() => { if (!userEmail) { setAuthPrompt(true); return; } setPkgModal({ open: true, packageType: 4 }); setPkgName(""); setPkgEmail(""); setPkgPhone(""); setPkgMonth(pkgMonthOptions[0]?.value || ""); setPkgResult(null); setKids([{ name: "", dob: "", grade: "" }]); setReferralCode(""); }}
                  className="mt-4 w-full rounded-lg bg-mesa-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-yellow-600"
                >
                  Enroll — 4 Sessions
                </button>
              </div>
              {/* 8-session */}
              <div className="relative rounded-xl border border-mesa-accent/50 bg-brown-900/40 p-5 text-center">
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-mesa-accent px-3 py-0.5 text-xs font-bold text-white whitespace-nowrap">BEST VALUE</span>
                <p className="text-3xl font-bold text-mesa-accent">$900</p>
                <p className="mt-0.5 text-sm text-brown-300">8 sessions / month</p>
                <div className="mt-3 rounded-lg bg-brown-800/50 p-3 space-y-0.5">
                  <p className="text-xs text-brown-500">Normally <span className="line-through">$1,200</span></p>
                  <p className="text-sm font-semibold text-green-400">Save $300 — 25% off</p>
                  <p className="text-xs text-brown-400">$112.50 per session</p>
                </div>
                <button
                  onClick={() => { if (!userEmail) { setAuthPrompt(true); return; } setPkgModal({ open: true, packageType: 8 }); setPkgName(""); setPkgEmail(""); setPkgPhone(""); setPkgMonth(pkgMonthOptions[0]?.value || ""); setPkgResult(null); setKids([{ name: "", dob: "", grade: "" }]); setReferralCode(""); }}
                  className="mt-4 w-full rounded-lg bg-mesa-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-yellow-600"
                >
                  Enroll — 8 Sessions
                </button>
              </div>
            </div>
            <p className="mt-4 text-center text-xs text-brown-500">
              Sessions expire at the end of the calendar month — unused sessions do not carry over.
              Cancellations &amp; reschedules within 48 hours incur a $75 fee (50% of the standard private rate).
            </p>
          </div>

          {privateSlots.length === 0 && !loading && (
            <p className="mt-8 text-center text-brown-500">
              No available slots right now. Check back soon or contact Artemios directly.
            </p>
          )}

          {/* Filters */}
          {timeWindows.length > 0 && (
            <div id="private-schedule" className="relative mt-6">
              <div className="flex flex-wrap gap-4 items-center">
                {/* Day dropdown */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-brown-500">Day:</span>
                  <select
                    value={filterDays.size === 1 ? Array.from(filterDays)[0] : ""}
                    onChange={(e) => { setFilterDays(e.target.value !== "" ? new Set([parseInt(e.target.value)]) : new Set()); setCalendarSelectedDate(null); }}
                    className="rounded-lg border border-brown-700 bg-brown-800 px-3 py-1 text-sm text-white focus:border-mesa-accent focus:outline-none"
                  >
                    <option value="">All days</option>
                    {availableDays.map((day) => (
                      <option key={day} value={day}>{DAY_LABELS[day]}</option>
                    ))}
                  </select>
                </div>
                {/* Month dropdown */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-brown-500">Month:</span>
                  <select
                    value={filterMonth}
                    onChange={(e) => { setFilterMonth(e.target.value); setCalendarSelectedDate(null); }}
                    className="rounded-lg border border-brown-700 bg-brown-800 px-3 py-1 text-sm text-white focus:border-mesa-accent focus:outline-none"
                  >
                    <option value="">All months</option>
                    {availableMonths.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                {/* Calendar toggle button */}
                <button
                  onClick={() => setShowCalendar((v) => !v)}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    showCalendar || calendarSelectedDate
                      ? "border-mesa-accent text-mesa-accent"
                      : "border-brown-700 text-brown-400 hover:border-brown-500 hover:text-white"
                  }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="inline-block mr-1.5 -mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  {calendarSelectedDate ? calendarSelectedDate : "Full Calendar"}
                  {calendarSelectedDate && (
                    <span
                      onClick={(e) => { e.stopPropagation(); setCalendarSelectedDate(null); setShowCalendar(false); }}
                      className="ml-1 text-brown-500 hover:text-white"
                    >✕</span>
                  )}
                </button>
              </div>
              {/* Calendar dropdown — centered below filters */}
              {showCalendar && (
                <div className="mt-3 flex justify-center">
                  <MiniCalendar
                    month={calendarMonth}
                    onMonthChange={setCalendarMonth}
                    highlightedDates={calendarHighlightedDates}
                    selectedDate={calendarSelectedDate}
                    onSelectDate={(d) => { setCalendarSelectedDate(d); setFilterDays(new Set()); setFilterMonth(""); setShowCalendar(false); }}
                  />
                </div>
              )}
            </div>
          )}

          {filteredWindows.length === 0 && timeWindows.length > 0 && (filterDays.size > 0 || filterMonth) && (
            <p className="mt-6 text-center text-sm text-brown-500">
              No sessions match your filters. Try adjusting your selection.
            </p>
          )}

          <div className="mt-6 space-y-4">
            {(showAllPrivate ? filteredWindows : filteredWindows.slice(0, 10)).map((window, wi) => {
              const now = new Date();
              const todayLocalStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
              const isToday = window.date === todayLocalStr;
              const nowMins = now.getHours() * 60 + now.getMinutes();
              const startOptions = getStartOptions(window, 60, isToday ? nowMins : undefined);
              const defaultStart = startOptions.length > 0 ? startOptions[0] : window.startMins;
              const totalAvailable = window.endMins - window.startMins;
              const sel = windowSelections[wi] || {
                start: defaultStart,
                duration: Math.min(60, window.endMins - defaultStart),
              };
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
                            {formatDuration(d)}
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
                      className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-yellow-600"
                    >
                      Book
                    </button>
                  </div>
                </div>
              );
            })}
            {!showAllPrivate && filteredWindows.length > 10 && (
              <button
                onClick={() => setShowAllPrivate(true)}
                className="mt-2 w-full rounded-lg border border-brown-700 py-2 text-sm text-brown-400 hover:border-brown-500 hover:text-white transition"
              >
                View {filteredWindows.length - 10} more days ↓
              </button>
            )}
            {showAllPrivate && filteredWindows.length > 10 && (
              <button
                onClick={() => setShowAllPrivate(false)}
                className="mt-2 w-full rounded-lg border border-brown-700 py-2 text-sm text-brown-400 hover:border-brown-500 hover:text-white transition"
              >
                Show less ↑
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Sticky group session registration bar */}
      {groupPricing.count >= 1 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-brown-700 bg-brown-900 px-6 py-3 shadow-2xl">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">
                {groupPricing.count} session{groupPricing.count !== 1 ? "s" : ""} &times; ${groupPricing.unitPrice} = <span className="text-mesa-accent">${groupPricing.totalPrice}</span>
                <span className="text-brown-400 text-xs font-normal ml-1">per athlete</span>
              </p>
              {groupPricing.savings > 0 && (
                <p className="text-xs text-green-400">{groupPricing.discountLabel} — You save ${groupPricing.savings}!</p>
              )}
            </div>
            <button
              onClick={openGroupRegistration}
              className="rounded bg-mesa-accent px-5 py-2 text-sm font-semibold text-white hover:bg-yellow-600"
            >
              Register
            </button>
          </div>
        </div>
      )}

      {/* Contact Footer */}
      <footer className="border-t border-brown-800 bg-mesa-dark py-12">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="font-[family-name:var(--font-oswald)] text-2xl font-bold tracking-wide">Get in Touch</h2>
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
          <div className="mt-3 flex flex-col items-center gap-2">
            <a
              href="/my-bookings"
              className="text-sm text-mesa-accent hover:text-yellow-300"
            >
              My Bookings &mdash; Look Up Your Registrations
            </a>
            <a
              href="https://www.instagram.com/mesabasketballtraining"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
              className="text-brown-400 hover:text-white transition"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
          <p className="mt-4 text-sm text-brown-600">
            &copy; 2025&ndash;{new Date().getFullYear()} Mesa Basketball Training LLC. All rights reserved.
          </p>
          <div className="mt-3 flex justify-center gap-8 text-sm">
            <a href="/privacy-policy" className="text-mesa-accent hover:text-yellow-300">Privacy Policy</a>
            <a href="/terms" className="text-mesa-accent hover:text-yellow-300">Terms &amp; Conditions</a>
          </div>
        </div>
      </footer>

      {/* Auth Prompt */}
      {authPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-brown-900 p-8 shadow-2xl text-center">
            <div className="h-16 w-16 mx-auto mb-4 rounded-full bg-white overflow-hidden flex items-center justify-center">
              <img src="/logo.png" alt="Mesa Basketball" className="h-16 w-16 object-contain scale-125" />
            </div>
            <h2 className="font-[family-name:var(--font-oswald)] text-2xl font-bold text-white tracking-wide mb-2">
              ACCOUNT REQUIRED
            </h2>
            <p className="text-brown-300 text-sm mb-6 leading-relaxed">
              Create a free account to book a session. Your info saves automatically so booking is faster every time.
            </p>
            <div className="space-y-3">
              <a
                href="/signup?next=/schedule"
                className="block w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition"
              >
                Create Account
              </a>
              <a
                href="/login?next=/schedule"
                className="block w-full rounded-lg border border-brown-600 py-3 font-semibold text-brown-300 hover:border-brown-400 hover:text-white transition"
              >
                Sign In
              </a>
              <button
                onClick={() => setAuthPrompt(false)}
                className="block w-full text-sm text-brown-500 hover:text-brown-300 pt-1"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Registration Modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-brown-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold">
                {modal.type === "camp"
                  ? "Camp Registration"
                  : modal.type === "weekly"
                    ? "Group Session Registration"
                    : "Book Private Session"}
              </h3>
              <button onClick={closeModal} className="text-2xl text-brown-400 hover:text-white">
                &times;
              </button>
            </div>
            <p className="mt-1 text-sm text-brown-400">{modal.sessionDetails}</p>

            {/* Camp day selector */}
            {modal.type === "camp" && !submitResult?.success && (() => {
              const camp = camps[modal.sessionIndex];
              if (!camp?.campDays?.length) return null;
              const earlyBird = isEarlyBirdActive();
              const selectedCount = campSelectedDays.size;
              const totalDays = camp.campDays.length;
              const price = calcCampPrice(selectedCount, totalDays, camp, kids.length);
              return (
                <div className="mt-3 rounded-lg border border-brown-700 bg-brown-800/50 p-4">
                  <p className="text-xs font-semibold text-brown-300 mb-2">Select the days you&apos;d like to attend:</p>
                  <div className="space-y-2">
                    {camp.campDays.map((day) => {
                      const dayStartTime = camp.time.split("-")[0]?.trim() || camp.time;
                      const enrolled = groupEnrollment[`${day}|${dayStartTime}`] || 0;
                      const spotsLeft = camp.maxSpots - enrolled;
                      const dayFull = spotsLeft <= 0;
                      return (
                        <label key={day} className={`flex items-center gap-3 ${dayFull ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                          <input
                            type="checkbox"
                            checked={campSelectedDays.has(day)}
                            disabled={dayFull}
                            onChange={(e) => {
                              if (dayFull) return;
                              setCampSelectedDays((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(day); else next.delete(day);
                                return next;
                              });
                            }}
                            className="h-4 w-4 rounded accent-mesa-accent"
                          />
                          <span className="text-sm text-white flex-1">{day}</span>
                          <span className={`text-xs font-medium ${dayFull ? "text-red-400" : "text-yellow-400"}`}>
                            {dayFull ? "Full" : spotsLeft <= 3 ? `${spotsLeft} spot${spotsLeft !== 1 ? "s" : ""} left` : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedCount > 0 && (
                    <div className="mt-3 border-t border-brown-700 pt-3">
                      <p className="text-sm font-semibold text-mesa-accent">
                        {selectedCount === totalDays ? "All 4 days" : `${selectedCount} day${selectedCount !== 1 ? "s" : ""}`}: {price}
                        {selectedCount === totalDays && earlyBird && camp.earlyBirdPrice && (
                          <span className="ml-2 text-xs text-green-400">(Early Bird — ends Mar 31)</span>
                        )}
                      </p>
                      {selectedCount < totalDays && camp.dropInPrice && (
                        <p className="text-xs text-brown-400 mt-0.5">
                          Drop-in rate: {camp.dropInPrice}/day &bull; All {totalDays} days: {earlyBird && camp.earlyBirdPrice ? `${camp.earlyBirdPrice} (EB) / ${camp.price}` : camp.price}
                        </p>
                      )}
                      <p className="text-xs text-brown-500 mt-1">Payment due upon registration — Cash, Venmo, or Zelle</p>
                    </div>
                  )}
                  {selectedCount === 0 && (
                    <p className="mt-2 text-xs text-yellow-500">Select at least one day to continue.</p>
                  )}
                </div>
              );
            })()}

            {/* Weekly sessions list */}
            {modal.type === "weekly" && modal.selectedGroupSessions && modal.selectedGroupSessions.length > 0 && !submitResult?.success && (
              <div className="mt-3 rounded-lg border border-brown-700 bg-brown-800/50 p-3">
                <p className="text-xs font-semibold text-brown-300 mb-2">Selected dates:</p>
                <div className="space-y-1">
                  {modal.selectedGroupSessions.map((s, i) => {
                    const d = new Date(s.date);
                    const dayName = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
                    return (
                      <p key={i} className="text-xs text-brown-400">
                        {dayName}, {s.date} &bull; {s.startTime}-{s.endTime} &bull; {s.location}
                      </p>
                    );
                  })}
                </div>
                <div className="mt-3 border-t border-brown-700 pt-2">
                  <p className="text-sm font-semibold text-mesa-accent">
                    Total: ${(modal.weeklyTotalPrice || 0) * kids.length}
                    {modal.weeklySavings && modal.weeklySavings > 0 ? (
                      <span className="ml-2 text-xs text-green-400">
                        (You save ${modal.weeklySavings * kids.length}!)
                      </span>
                    ) : null}
                  </p>
                  {kids.length > 1 && (
                    <p className="text-xs text-brown-400 mt-0.5">${modal.weeklyTotalPrice} &times; {kids.length} athletes</p>
                  )}
                  <p className="text-xs text-brown-500 mt-0.5">Payment due upon registration — Cash, Venmo, or Zelle</p>
                </div>
              </div>
            )}

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
                  {(() => {
                    const campForLimit = camps[modal.sessionIndex];
                    const dayStart = campForLimit?.time.split("-")[0]?.trim() || campForLimit?.time || "";
                    const campMaxKids = campForLimit && campSelectedDays.size > 0
                      ? Math.min(...Array.from(campSelectedDays).map((day) => {
                          const enrolled = groupEnrollment[`${day}|${dayStart}`] || 0;
                          return Math.max(0, campForLimit.maxSpots - enrolled);
                        }))
                      : (campForLimit?.maxSpots ?? 10);
                    return (
                      <div className="mb-2 flex items-center justify-between">
                        <label className="text-sm font-medium text-brown-300">Player(s)</label>
                        {kids.length < campMaxKids ? (
                          <button type="button" onClick={addKid} className="text-sm text-mesa-accent hover:text-yellow-300">
                            + Add another player
                          </button>
                        ) : (
                          <span className="text-xs text-yellow-500">Max {campMaxKids} athlete{campMaxKids !== 1 ? "s" : ""} (spots available)</span>
                        )}
                      </div>
                    );
                  })()}
                  {kids.map((kid, i) => (
                    <div key={i} className="mb-3 flex flex-col gap-2">
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          placeholder="Player's Name"
                          required
                          value={kid.name}
                          onChange={(e) => updateKid(i, "name", e.target.value)}
                          className="flex-1 rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                        />
                        {kids.length > 1 && (
                          <button type="button" onClick={() => removeKid(i)} className="text-brown-500 hover:text-red-400 text-xl leading-none">
                            &times;
                          </button>
                        )}
                      </div>
                      <div className="overflow-hidden">
                        <label className="mb-1 block text-xs text-brown-500">Date of Birth</label>
                        <div className="overflow-hidden rounded-lg border border-brown-700 bg-brown-800">
                          <input
                            type="date"
                            required
                            value={kid.dob}
                            onChange={(e) => updateKid(i, "dob", e.target.value)}
                            className="w-full bg-transparent px-3 py-2 text-white text-sm focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-brown-500">Grade</label>
                        <select
                          required
                          value={kid.grade}
                          onChange={(e) => updateKid(i, "grade", e.target.value)}
                          className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white text-sm focus:border-mesa-accent focus:outline-none"
                        >
                          <option value="">Select grade...</option>
                          {(modal.type === "weekly"
                            ? getGradesForGroup(modal.sessionDetails.replace(/ — \d+ sessions?$/, ""))
                            : modal.type === "camp" && camps[modal.sessionIndex]?.gradeGroup
                            ? getGradesForGroup(camps[modal.sessionIndex].gradeGroup)
                            : ALL_GRADES
                          ).map((g) => (
                            <option key={g.value} value={g.value}>{g.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Referral Code */}
                {(modal.type === "private" || modal.type === "group-private" || modal.type === "weekly") && (
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <label className="text-sm font-medium text-brown-300">Referral Code <span className="text-brown-500 font-normal">(optional)</span></label>
                      <button
                        type="button"
                        onClick={() => setShowReferralInfo((v) => !v)}
                        className="flex h-4 w-4 items-center justify-center rounded-full border border-brown-500 text-brown-400 hover:border-mesa-accent hover:text-mesa-accent text-[10px] font-bold leading-none"
                        aria-label="Referral code info"
                      >
                        i
                      </button>
                    </div>
                    {showReferralInfo && (
                      <div className="mb-2 rounded-lg border border-brown-700 bg-brown-900 p-3 text-xs text-brown-300">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="font-semibold text-white">Referral Code</p>
                          <button
                            type="button"
                            onClick={() => setShowReferralInfo(false)}
                            className="text-brown-400 hover:text-white leading-none text-sm"
                            aria-label="Close"
                          >
                            &times;
                          </button>
                        </div>
                        <p>If a Mesa family sent you here, enter their code and they&apos;ll earn a half-off private session as a thank you. New members also get a half-off session just for joining — it&apos;s our way of saying welcome.</p>
                      </div>
                    )}
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
                      {(showAllRecurring ? recurringWeeks : recurringWeeks.slice(0, 3)).map((week, wi) => {
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
                      {!showAllRecurring && recurringWeeks.length > 3 && (
                        <button
                          type="button"
                          onClick={() => setShowAllRecurring(true)}
                          className="mt-1 w-full border-t border-brown-600 pt-2 text-center text-xs text-mesa-accent hover:text-yellow-300"
                        >
                          View more weeks ↓
                        </button>
                      )}
                      {showAllRecurring && recurringWeeks.length > 3 && (
                        <button
                          type="button"
                          onClick={() => setShowAllRecurring(false)}
                          className="mt-1 w-full border-t border-brown-600 pt-2 text-center text-xs text-mesa-accent hover:text-yellow-300"
                        >
                          Show less ↑
                        </button>
                      )}
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
                      <span className="block text-xs font-normal">Up to 3 players</span>
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
                      <span className="block text-xs font-normal">4+ players</span>
                    </button>
                  </div>
                )}

                {priceLabel && (
                  <p className="rounded-lg bg-brown-800 px-3 py-2 text-sm text-mesa-accent">{priceLabel}</p>
                )}

                {submitResult && !submitResult.success && (
                  <p className="text-sm text-red-400">{submitResult.message}</p>
                )}

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smsConsent}
                    onChange={(e) => setSmsConsent(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-brown-600 accent-mesa-accent"
                  />
                  <span className="text-xs text-brown-400 leading-relaxed">
                    I agree to receive text message reminders from Mesa Basketball Training about upcoming sessions. Reply STOP at any time to opt out.
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={submitting || (modal.type === "camp" && camps[modal.sessionIndex]?.campDays?.length > 0 && campSelectedDays.size === 0)}
                  className="w-full rounded-lg bg-mesa-accent py-3 font-semibold text-white transition hover:bg-yellow-600 disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Confirm Registration"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Package Enrollment Modal */}
      {pkgModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-brown-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold">
                {pkgModal.packageType}-Session Package
              </h3>
              <button onClick={() => setPkgModal({ open: false, packageType: null })} className="text-2xl text-brown-400 hover:text-white">&times;</button>
            </div>
            <p className="mt-1 text-sm text-brown-400">
              {pkgModal.packageType === 4 ? "$475" : "$900"} — payment due upon registration (Cash, Venmo, or Zelle)
            </p>

            {pkgResult?.success ? (
              <div className="mt-6 rounded-lg bg-green-900/50 p-4 text-center">
                <p className="text-base font-semibold text-green-400">{pkgResult.message}</p>
                <button onClick={() => setPkgModal({ open: false, packageType: null })} className="mt-4 rounded bg-brown-700 px-4 py-2 text-sm hover:bg-brown-600">Close</button>
              </div>
            ) : (
              <form onSubmit={handlePackageSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-brown-300">Your Name</label>
                  <input type="text" required value={pkgName} onChange={e => setPkgName(e.target.value)} className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-brown-300">Email</label>
                  <input type="email" required value={pkgEmail} onChange={e => setPkgEmail(e.target.value)} className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-brown-300">Phone</label>
                  <input type="tel" required value={pkgPhone} onChange={e => setPkgPhone(e.target.value)} className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-brown-300">Month</label>
                  <select required value={pkgMonth} onChange={e => setPkgMonth(e.target.value)} className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white focus:border-mesa-accent focus:outline-none">
                    {pkgMonthOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  {(() => {
                    const groupSessions = modal.selectedGroupSessions || [];
                    const groupMaxKids = groupSessions.length > 0
                      ? Math.min(...groupSessions.map((s) => {
                          const enrolled = groupEnrollment[`${s.date}|${s.startTime}`] || 0;
                          return Math.max(0, s.maxSpots - enrolled);
                        }))
                      : 10;
                    return (
                      <div className="mb-2 flex items-center justify-between">
                        <label className="text-sm font-medium text-brown-300">Player(s)</label>
                        {kids.length < groupMaxKids ? (
                          <button type="button" onClick={addKid} className="text-sm text-mesa-accent hover:text-yellow-300">+ Add another player</button>
                        ) : (
                          <span className="text-xs text-yellow-500">Max {groupMaxKids} athlete{groupMaxKids !== 1 ? "s" : ""} (spots available)</span>
                        )}
                      </div>
                    );
                  })()}
                  {kids.map((kid, i) => (
                    <div key={i} className="mb-3 flex flex-col gap-2">
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          placeholder="Player's Name"
                          required
                          value={kid.name}
                          onChange={(e) => updateKid(i, "name", e.target.value)}
                          className="flex-1 rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                        />
                        {kids.length > 1 && (
                          <button type="button" onClick={() => removeKid(i)} className="text-brown-500 hover:text-red-400 text-xl leading-none">&times;</button>
                        )}
                      </div>
                      <div className="overflow-hidden">
                        <label className="mb-1 block text-xs text-brown-500">Date of Birth</label>
                        <div className="overflow-hidden rounded-lg border border-brown-700 bg-brown-800">
                          <input
                            type="date"
                            required
                            value={kid.dob}
                            onChange={(e) => updateKid(i, "dob", e.target.value)}
                            className="w-full bg-transparent px-3 py-2 text-white text-sm focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-brown-500">Grade</label>
                        <select
                          required
                          value={kid.grade}
                          onChange={(e) => updateKid(i, "grade", e.target.value)}
                          className="w-full rounded-lg border border-brown-700 bg-brown-800 px-3 py-2 text-white text-sm focus:border-mesa-accent focus:outline-none"
                        >
                          <option value="">Select grade...</option>
                          <option value="K">Kindergarten</option>
                          <option value="1">1st Grade</option>
                          <option value="2">2nd Grade</option>
                          <option value="3">3rd Grade</option>
                          <option value="4">4th Grade</option>
                          <option value="5">5th Grade</option>
                          <option value="6">6th Grade</option>
                          <option value="7">7th Grade</option>
                          <option value="8">8th Grade</option>
                          <option value="9">9th Grade</option>
                          <option value="10">10th Grade</option>
                          <option value="11">11th Grade</option>
                          <option value="12">12th Grade</option>
                          <option value="College +">College / Pro</option>
                          <option value="Adult">Adult</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
                {pkgResult && !pkgResult.success && (
                  <p className="text-sm text-red-400">{pkgResult.message}</p>
                )}
                <button type="submit" disabled={pkgSubmitting} className="w-full rounded-lg bg-mesa-accent py-3 font-semibold text-white transition hover:bg-yellow-600 disabled:opacity-50">
                  {pkgSubmitting ? "Enrolling..." : "Confirm Enrollment"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
