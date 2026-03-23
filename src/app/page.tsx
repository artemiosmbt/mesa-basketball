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
      // Weekly multi-session registration
      if (bookingType === "weekly" && modal.selectedGroupSessions && modal.selectedGroupSessions.length > 0) {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentName,
            email,
            phone,
            kids: kidsStr,
            type: "weekly",
            sessionDetails: modal.sessionDetails,
            totalParticipants,
            weeklySessions: modal.selectedGroupSessions,
            weeklyTotalPrice: modal.weeklyTotalPrice,
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dates = new Set<string>();
    timeWindows.forEach((w) => {
      if (w.endMins - w.startMins >= 60 && new Date(w.date) >= today) dates.add(w.date);
    });
    return dates;
  }, [timeWindows]);

  // Filter time windows by day of week, month, calendar date, and past dates
  const filteredWindows = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return timeWindows.filter((w) => {
      if (w.endMins - w.startMins < 60) return false;
      const d = new Date(w.date);
      if (d < today) return false;
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
  function getGroupSessionKey(s: WeeklySession): string {
    return `${s.group}|${s.date}|${s.startTime}`;
  }

  function getEnrollmentCount(s: WeeklySession): number {
    const key = `${s.date}|${s.startTime}`;
    return groupEnrollment[key] || 0;
  }

  function isFutureSession(s: WeeklySession): boolean {
    const sessionDate = new Date(s.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return sessionDate >= today;
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
    const sessions = selectedSessionsForActiveGroup;
    if (sessions.length < 2) return;

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
    setParentName("");
    setEmail("");
    setPhone("");
    setKids([{ name: "", dob: "", grade: "" }]);
    setIsGroupRate(false);
    setUpsellExtra(0);
    setReferralCode("");
  }

  const grouped = groupByGroup(schedule);

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      {/* Sticky Nav */}
      <nav className="sticky top-0 z-50 border-b border-brown-800 bg-mesa-dark/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <a href="#" className="flex items-center gap-2 text-lg font-bold text-white">
            <img src="/logo.jpeg" alt="Mesa Basketball Logo" className="h-10 w-10 rounded-full object-cover" />
            <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
          </a>
          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-4 text-sm">
            <a href="#schedule" className="text-brown-300 hover:text-white">Schedule</a>
            <a href="#camps" className="text-brown-300 hover:text-white">Camps</a>
            <a href="#private" className="text-brown-300 hover:text-white">Private Sessions</a>
            <a href="/my-bookings" className="rounded bg-mesa-accent/20 px-3 py-1 text-mesa-accent hover:bg-mesa-accent/30">My Bookings</a>
          </div>
          {/* Mobile hamburger */}
          <button
            className="md:hidden text-brown-300 hover:text-white p-1"
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
          <div className="md:hidden border-t border-brown-800 bg-mesa-dark/98 px-6 py-4 space-y-4 text-sm">
            <a href="#schedule" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Schedule</a>
            <a href="#camps" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Camps</a>
            <a href="#private" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Private Sessions</a>
            <a href="/my-bookings" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-mesa-accent/20 px-3 py-2 text-mesa-accent hover:bg-mesa-accent/30 text-center font-medium">My Bookings</a>
          </div>
        )}
      </nav>

      {/* Hero */}
      <header className="relative overflow-hidden bg-gradient-to-br from-mesa-dark via-brown-900 to-brown-800">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <div className="flex flex-col items-center text-center">
            <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
              ΜΕΣΑ BASKETBALL TRAINING
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
                className="rounded-lg bg-mesa-accent px-6 py-3 font-semibold text-white transition hover:bg-yellow-600"
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
        <div className="mx-auto flex max-w-2xl justify-center gap-4 px-6 pb-12">
          <div className="relative w-1/2 overflow-hidden rounded-xl" style={{aspectRatio: "3/4"}}>
            <Image
              src="/photo1.jpg"
              alt="Artemios Gavalas at St. John's"
              fill
              className="object-cover"
              style={{ objectPosition: "center 35%" }}
              priority
            />
          </div>
          <div className="relative w-1/2 overflow-hidden rounded-xl" style={{aspectRatio: "3/4"}}>
            <Image
              src="/photo2.jpg"
              alt="Artemios Gavalas at Butler"
              fill
              className="object-cover object-top"
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
              <div className="mb-4 flex justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#d4af37" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
              </div>
              <h3 className="font-semibold text-mesa-accent">Skill Development</h3>
              <p className="mt-2 text-sm text-brown-300">
                Expert guidance on shooting, dribbling, ball handling & more
              </p>
            </div>
            <div className="rounded-xl bg-brown-800/60 p-6">
              <div className="mb-4 flex justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#d4af37" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
              <h3 className="font-semibold text-mesa-accent">High Energy Drills</h3>
              <p className="mt-2 text-sm text-brown-300">
                Build confidence, skill, and game IQ through competitive drills
              </p>
            </div>
            <div className="rounded-xl bg-brown-800/60 p-6">
              <div className="mb-4 flex justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#d4af37" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
              </div>
              <h3 className="font-semibold text-mesa-accent">D1 Experience</h3>
              <p className="mt-2 text-sm text-brown-300">
                Knowledge from playing at St. John&apos;s, Butler, and professionally in Greece
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="flex items-center justify-center gap-3 py-2">
        <div className="h-px w-16 bg-mesa-accent/25" />
        <div className="h-1.5 w-1.5 rotate-45 bg-mesa-accent/50" />
        <div className="h-px w-16 bg-mesa-accent/25" />
      </div>

      {/* Weekly Schedule */}
      <section id="schedule" className="py-16">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-center text-3xl font-bold">Group Sessions</h2>
          <p className="mt-2 text-center text-brown-400">
            Skill work in groups of up to 6 players. Select 2+ sessions to register — volume discounts available.
          </p>
          <p className="mt-2 text-center text-xs text-brown-500">
            Groups are organized by grade as a guideline. If your child plays up or you&apos;re unsure which group fits best, contact Artemios at (631) 599-1280 or artemios@mesabasketballtraining.com — we&apos;ll find the right fit.
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

          <div className="mt-8 grid gap-6 md:grid-cols-2">
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
                    {selectedCount > 0 && (
                      <span className="rounded-full bg-mesa-accent/20 px-2 py-0.5 text-xs font-semibold text-mesa-accent">
                        {selectedCount} selected
                      </span>
                    )}
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
                              </p>
                              {groupPricing.savings > 0 && (
                                <p className="text-xs text-green-400 mt-0.5">
                                  {groupPricing.discountLabel} — You save ${groupPricing.savings}!
                                </p>
                              )}
                              {groupPricing.count < 2 && (
                                <p className="text-xs text-yellow-400/80 mt-0.5">
                                  Select at least 2 sessions to register
                                </p>
                              )}
                              {groupPricing.count >= 2 && groupPricing.count < 4 && (
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
                              disabled={groupPricing.count < 2}
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

      {/* Divider */}
      <div className="flex items-center justify-center gap-3 py-2">
        <div className="h-px w-16 bg-mesa-accent/25" />
        <div className="h-1.5 w-1.5 rotate-45 bg-mesa-accent/50" />
        <div className="h-px w-16 bg-mesa-accent/25" />
      </div>

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
                        className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-yellow-600"
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

      {/* Divider */}
      <div className="flex items-center justify-center gap-3 py-2">
        <div className="h-px w-16 bg-mesa-accent/25" />
        <div className="h-1.5 w-1.5 rotate-45 bg-mesa-accent/50" />
        <div className="h-px w-16 bg-mesa-accent/25" />
      </div>

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
              <p className="text-xs text-brown-400">Group Private (4+ players)</p>
            </div>
          </div>
          <p className="mt-2 text-center text-sm text-brown-500">
            Payment in person — Cash, Venmo, or Zelle
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
                  onClick={() => { setPkgModal({ open: true, packageType: 4 }); setPkgName(""); setPkgEmail(""); setPkgPhone(""); setPkgMonth(pkgMonthOptions[0]?.value || ""); setPkgResult(null); }}
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
                  onClick={() => { setPkgModal({ open: true, packageType: 8 }); setPkgName(""); setPkgEmail(""); setPkgPhone(""); setPkgMonth(pkgMonthOptions[0]?.value || ""); setPkgResult(null); }}
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
            <div className="relative mt-6">
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
      {groupPricing.count >= 2 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-brown-700 bg-brown-900 px-6 py-3 shadow-2xl">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">
                {groupPricing.count} sessions &times; ${groupPricing.unitPrice} = <span className="text-mesa-accent">${groupPricing.totalPrice}</span>
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
            className="mt-6 inline-block text-sm text-mesa-accent hover:text-yellow-300"
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
                    Total: ${modal.weeklyTotalPrice}
                    {modal.weeklySavings && modal.weeklySavings > 0 ? (
                      <span className="ml-2 text-xs text-green-400">
                        (You save ${modal.weeklySavings}!)
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-brown-500 mt-0.5">Payment in person — Cash, Venmo, or Zelle</p>
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
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-sm font-medium text-brown-300">Player(s)</label>
                    <button type="button" onClick={addKid} className="text-sm text-mesa-accent hover:text-yellow-300">
                      + Add another player
                    </button>
                  </div>
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
                          <option value="College">College</option>
                        </select>
                      </div>
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

                <button
                  type="submit"
                  disabled={submitting}
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
              {pkgModal.packageType === 4 ? "$475" : "$900"} — payment in person (Cash, Venmo, or Zelle)
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
