"use client";

import { useState, useEffect, useMemo, use, useRef } from "react";

const LOCATION_LINKS: Record<string, { name: string; url: string }> = {
  "St. Pauls": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "St. Paul's": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "Cherry Valley": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
};

function getPrivatePrice(durationMin: number, kidCount: number): number {
  const ratio = durationMin / 60;
  const basePrice = kidCount >= 4 ? 250 : 150;
  return Math.round(basePrice * ratio * 100) / 100;
}

function formatPrice(amount: number): string {
  return amount % 1 === 0 ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function formatSessionDetails(details: string, bookedDate?: string | null): string {
  let result = details;

  if (bookedDate) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(bookedDate)
      ? new Date(bookedDate + "T12:00:00")
      : new Date(bookedDate + " 12:00:00");
    const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const isoMatch = result.match(/\d{4}-\d{2}-\d{2}/);
    if (isoMatch) {
      result = result.replace(isoMatch[0], `${dayName}, ${dateStr}`);
    } else if (result.includes(dateStr)) {
      result = result.replace(dateStr, `${dayName}, ${dateStr}`);
    }
  }

  for (const [key, { name }] of Object.entries(LOCATION_LINKS)) {
    if (result.includes(key)) {
      return result.replace(key, name);
    }
  }
  return result;
}

interface Booking {
  id: string;
  parentName: string;
  email: string;
  kids: string;
  type: string;
  sessionDetails: string;
  bookedDate: string | null;
  bookedStartTime: string | null;
  bookedEndTime: string | null;
  bookedLocation: string | null;
  status: string;
  createdAt: string;
  isFullCamp: boolean;
}

interface TimeWindow {
  date: string;
  location: string;
  startMins: number;
  endMins: number;
  startLabel: string;
  endLabel: string;
}

function parseKids(kidsStr: string): string[] {
  if (!kidsStr.trim()) return [];
  if (kidsStr.includes("(")) {
    return kidsStr.split("), ").map((p, i, arr) =>
      i < arr.length - 1 ? p + ")" : p
    ).filter((s) => s.trim());
  }
  return kidsStr.split(",").map((s) => s.trim()).filter(Boolean);
}

function playerName(playerStr: string): string {
  const idx = playerStr.indexOf(" (");
  return idx > -1 ? playerStr.substring(0, idx).trim() : playerStr.trim();
}

function parseDob(dob: string): [string, string, string] {
  const p = dob.split("/");
  return [p[0] || "", p[1] || "", p[2] || ""];
}
function buildDob(mm: string, dd: string, yyyy: string): string {
  if (!mm && !dd && !yyyy) return "";
  if (!dd && !yyyy) return mm;
  if (!yyyy) return `${mm}/${dd}`;
  return `${mm}/${dd}/${yyyy}`;
}
function DobInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [mm, dd, yyyy] = parseDob(value);
  const ddRef = useRef<HTMLInputElement>(null);
  const yyyyRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center w-full rounded border border-brown-700 bg-brown-900 text-sm text-white focus-within:border-mesa-accent pl-3">
      <input type="text" inputMode="numeric" maxLength={2} placeholder="MM" value={mm}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(v, dd, yyyy)); if (v.length === 2) ddRef.current?.focus(); }}
        className="w-10 bg-transparent pr-1 py-2 text-center placeholder-brown-600 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={ddRef} type="text" inputMode="numeric" maxLength={2} placeholder="DD" value={dd}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(mm, v, yyyy)); if (v.length === 2) yyyyRef.current?.focus(); }}
        className="w-10 bg-transparent px-1 py-2 text-center placeholder-brown-600 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={yyyyRef} type="text" inputMode="numeric" maxLength={4} placeholder="YYYY" value={yyyy}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); onChange(buildDob(mm, dd, v)); }}
        className="w-16 bg-transparent px-1 py-2 text-center placeholder-brown-600 focus:outline-none" />
    </div>
  );
}

function buildPlayerString(name: string, dob: string, grade: string, gender: string): string {
  const parts: string[] = [];
  if (dob) parts.push(`DOB: ${dob}`);
  if (grade) parts.push(`Grade: ${grade}`);
  if (gender) parts.push(`Gender: ${gender}`);
  return parts.length > 0 ? `${name.trim()} (${parts.join(", ")})` : name.trim();
}

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

function formatTimeFromMins(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

export default function ManageBooking({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [isLateCancel, setIsLateCancel] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduled, setRescheduled] = useState(false);
  const [isLateReschedule, setIsLateReschedule] = useState(false);

  // Player editing state
  const [showEditPlayers, setShowEditPlayers] = useState(false);
  const [editedPlayers, setEditedPlayers] = useState<string[]>([]);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerDob, setNewPlayerDob] = useState("");
  const [newPlayerGrade, setNewPlayerGrade] = useState("");
  const [newPlayerGender, setNewPlayerGender] = useState("");
  const [showPlayerConfirm, setShowPlayerConfirm] = useState(false);
  const [savingPlayers, setSavingPlayers] = useState(false);
  const [playerSaveError, setPlayerSaveError] = useState("");
  const [playerSaveSuccess, setPlayerSaveSuccess] = useState(false);
  const [playerLateResult, setPlayerLateResult] = useState<{ isLate: boolean; lateFeeDue?: number } | null>(null);

  // Schedule data for rescheduling
  const [privateSlots, setPrivateSlots] = useState<
    { date: string; startTime: string; endTime: string; location: string; available: boolean }[]
  >([]);
  const [bookedSlots, setBookedSlots] = useState<
    { date: string; startTime: string; endTime: string; location: string }[]
  >([]);

  // Reschedule selection
  const [selectedWindow, setSelectedWindow] = useState<number>(-1);
  const [selectedStart, setSelectedStart] = useState<number>(0);
  const [selectedDuration, setSelectedDuration] = useState<number>(60);
  const [upsellExtra, setUpsellExtra] = useState(0);
  const [hideUpsell, setHideUpsell] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHideUpsell(localStorage.getItem("mesa_hide_upsell") === "true");
    }
  }, []);

  useEffect(() => {
    fetch(`/api/booking/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setBooking(data);
      })
      .catch(() => setError("Failed to load booking"))
      .finally(() => setLoading(false));
  }, [token]);

  // True when the session is within 24 hours
  const within24Hours = useMemo(() => {
    if (!booking?.bookedDate || !booking?.bookedStartTime) return false;
    const timeMatch = booking.bookedStartTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!timeMatch) return false;
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const period = timeMatch[3].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    const sessionDateTime = new Date(booking.bookedDate);
    sessionDateTime.setHours(hours, mins, 0, 0);
    const hoursUntil = (sessionDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil < 24;
  }, [booking]);

  // True when within the 15-min grace period after booking (capped at session start)
  const withinGracePeriod = useMemo(() => {
    if (!within24Hours || !booking?.bookedDate || !booking?.bookedStartTime || !booking?.createdAt) return false;
    const timeMatch = booking.bookedStartTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!timeMatch) return false;
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const period = timeMatch[3].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    const sessionDateTime = new Date(booking.bookedDate);
    sessionDateTime.setHours(hours, mins, 0, 0);
    const graceEnd = Math.min(
      new Date(booking.createdAt).getTime() + 15 * 60 * 1000,
      sessionDateTime.getTime()
    );
    return Date.now() < graceEnd;
  }, [booking, within24Hours]);

  // Session has already passed — no changes allowed
  const sessionPassed = useMemo(() => {
    if (!booking?.bookedDate || !booking?.bookedStartTime) return false;
    const timeMatch = booking.bookedStartTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!timeMatch) return false;
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const period = timeMatch[3].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    const sessionDateTime = new Date(booking.bookedDate);
    sessionDateTime.setHours(hours, mins, 0, 0);
    return Date.now() >= sessionDateTime.getTime();
  }, [booking]);

  // Camp has already started — no cancellation allowed, full amount due
  const campStarted = sessionPassed && booking?.type === "camp";

  // Build time windows for rescheduling
  const timeWindows = useMemo(() => {
    if (privateSlots.length === 0) return [];
    const available = privateSlots.filter((s) => s.available);
    // Group by date + location and merge consecutive
    const groups: Record<string, typeof available> = {};
    available.forEach((s) => {
      const key = `${s.date}|${s.location}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });

    const windows: TimeWindow[] = [];
    Object.values(groups).forEach((group) => {
      const sorted = [...group].sort(
        (a, b) => parseTime(a.startTime) - parseTime(b.startTime)
      );
      let wStart = parseTime(sorted[0].startTime);
      let wEnd = parseTime(sorted[0].endTime);

      for (let i = 1; i < sorted.length; i++) {
        const sStart = parseTime(sorted[i].startTime);
        const sEnd = parseTime(sorted[i].endTime);
        if (sStart === wEnd) {
          wEnd = sEnd;
        } else {
          windows.push({
            date: sorted[0].date,
            location: sorted[0].location,
            startMins: wStart,
            endMins: wEnd,
            startLabel: formatTimeFromMins(wStart),
            endLabel: formatTimeFromMins(wEnd),
          });
          wStart = sStart;
          wEnd = sEnd;
        }
      }
      windows.push({
        date: sorted[0].date,
        location: sorted[0].location,
        startMins: wStart,
        endMins: wEnd,
        startLabel: formatTimeFromMins(wStart),
        endLabel: formatTimeFromMins(wEnd),
      });
    });

    // Subtract booked slots
    const result: TimeWindow[] = [];
    for (const w of windows) {
      const overlaps = bookedSlots.filter(
        (b) => b.date === w.date && b.location === w.location
      );
      if (overlaps.length === 0) {
        result.push(w);
        continue;
      }
      const sorted = overlaps
        .map((b) => ({ start: parseTime(b.startTime), end: parseTime(b.endTime) }))
        .sort((a, b) => a.start - b.start);
      let cursor = w.startMins;
      for (const b of sorted) {
        if (b.start > cursor) {
          result.push({ ...w, startMins: cursor, endMins: b.start, startLabel: formatTimeFromMins(cursor), endLabel: formatTimeFromMins(b.start) });
        }
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < w.endMins) {
        result.push({ ...w, startMins: cursor, endMins: w.endMins, startLabel: formatTimeFromMins(cursor), endLabel: formatTimeFromMins(w.endMins) });
      }
    }

    const now = new Date();
    return result.filter((w) => {
      if (w.endMins - w.startMins < 60) return false;
      const baseDate = new Date(w.date);
      if (isNaN(baseDate.getTime())) return true;
      const windowStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), Math.floor(w.startMins / 60), w.startMins % 60);
      return windowStart > now;
    });
  }, [privateSlots, bookedSlots]);

  function openEditPlayers() {
    if (!booking) return;
    setEditedPlayers(parseKids(booking.kids));
    setShowEditPlayers(true);
    setShowAddPlayer(false);
    setNewPlayerName("");
    setNewPlayerDob("");
    setNewPlayerGrade("");
    setNewPlayerGender("");
    setPlayerSaveError("");
    setPlayerSaveSuccess(false);
    setShowPlayerConfirm(false);
    setPlayerLateResult(null);
  }

  async function handleSavePlayers() {
    setSavingPlayers(true);
    setPlayerSaveError("");
    const res = await fetch(`/api/booking/${token}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ players: editedPlayers }),
    });
    const data = await res.json();
    if (data.success) {
      setBooking((prev) => prev ? { ...prev, kids: data.newKids } : null);
      setShowEditPlayers(false);
      setShowPlayerConfirm(false);
      if (data.isLate && data.lateFeeDue) {
        setPlayerLateResult({ isLate: true, lateFeeDue: data.lateFeeDue });
      } else {
        setPlayerSaveSuccess(true);
      }
    } else {
      setPlayerSaveError(data.error || "Failed to update players");
      setShowPlayerConfirm(false);
    }
    setSavingPlayers(false);
  }

  async function loadSchedule() {
    const res = await fetch("/api/schedule");
    const data = await res.json();
    setPrivateSlots(data.privateSlots || []);
    setBookedSlots(data.bookedSlots || []);
  }

  async function handleCancel() {
    setCancelling(true);
    const res = await fetch(`/api/booking/${token}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      setCancelled(true);
      setIsLateCancel(data.isLateCancel);
    } else {
      setError(data.error || "Failed to cancel");
    }
    setCancelling(false);
  }

  async function handleReschedule() {
    if (selectedWindow < 0) return;
    const window = timeWindows[selectedWindow];
    const endMins = selectedStart + selectedDuration + upsellExtra;

    setRescheduling(true);
    const res = await fetch(`/api/booking/${token}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookedDate: window.date,
        bookedStartTime: formatTimeFromMins(selectedStart),
        bookedEndTime: formatTimeFromMins(endMins),
        bookedLocation: window.location,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setRescheduled(true);
      setIsLateReschedule(data.isLateReschedule ?? false);
    } else {
      setError(data.error || "Failed to reschedule");
    }
    setRescheduling(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesa-dark text-white">
        <p className="text-brown-400">Loading booking...</p>
      </div>
    );
  }

  if (error && !booking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesa-dark text-white">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Booking Not Found</h1>
          <p className="mt-2 text-brown-400">{error}</p>
          <a href="/" className="mt-4 inline-block text-mesa-accent hover:text-yellow-300">
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  if (!booking) return null;

  if (cancelled) {
    const isFullCampCancel = booking?.type === "camp" && booking?.isFullCamp;
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesa-dark text-white">
        <div className="mx-auto max-w-md rounded-2xl bg-brown-900 p-8 text-center">
          <h1 className="text-2xl font-bold">{isFullCampCancel ? "Camp Cancelled" : "Session Cancelled"}</h1>
          <p className="mt-4 text-brown-300">
            {isFullCampCancel
              ? "Your entire camp registration has been cancelled. You'll receive a confirmation email."
              : "Your session has been cancelled. You'll receive a confirmation email."}
          </p>
          {isLateCancel && (
            <p className="mt-3 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
              {isFullCampCancel
                ? "This cancellation was made within 24 hours of the camp. Per our policy, 50% of the total camp fee is still due."
                : "This change was made within 24 hours of the session. Per our policy, 50% of the session fee is still due."}
            </p>
          )}
          <a href="/" className="mt-6 inline-block rounded bg-mesa-accent px-6 py-2 font-semibold text-white hover:bg-yellow-600">
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  if (rescheduled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesa-dark text-white">
        <div className="mx-auto max-w-md rounded-2xl bg-brown-900 p-8 text-center">
          <h1 className="text-2xl font-bold text-green-400">Session Rescheduled</h1>
          <p className="mt-4 text-brown-300">
            Your session has been rescheduled. Check your email for the updated details and a new manage booking link.
          </p>
          {isLateReschedule && (
            <p className="mt-3 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
              This reschedule was made within 24 hours of the session. Per our policy, 50% of the session fee is still due.
            </p>
          )}
          <a href="/" className="mt-6 inline-block rounded bg-mesa-accent px-6 py-2 font-semibold text-white hover:bg-yellow-600">
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  const alreadyCancelled = booking.status === "cancelled";

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <div className="mx-auto max-w-lg px-6 py-16">
        <a href="/" className="text-sm text-mesa-accent hover:text-yellow-300">
          &larr; Back to Home
        </a>

        <div className="mt-6 rounded-2xl bg-brown-900 p-6">
          <h1 className="text-2xl font-bold">Manage Booking</h1>

          {alreadyCancelled ? (
            <p className="mt-4 rounded-lg bg-red-900/30 px-4 py-2 text-red-400">
              This booking has been cancelled.
            </p>
          ) : (
            <>
              <div className="mt-4 space-y-2">
                <p><span className="text-brown-400">Session:</span> {formatSessionDetails(booking.sessionDetails, booking.bookedDate)}</p>
                <p><span className="text-brown-400">Players:</span> {parseKids(booking.kids).map(playerName).join(", ")}</p>
                <p><span className="text-brown-400">Type:</span> {
                  booking.type === "group-private" ? "Group Private"
                  : booking.type === "weekly" ? "Group Session"
                  : booking.type === "camp" ? "Camp"
                  : "Private"
                }</p>
              </div>

              {within24Hours && !withinGracePeriod && (
                <p className="mt-4 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
                  {booking.isFullCamp
                    ? "This camp is within 24 hours. Canceling the entire camp will result in a 50% charge of the total camp fee."
                    : "This session is within 24 hours. Rescheduling, canceling, or removing players will result in a late fee per our cancellation policy."}
                </p>
              )}

              {/* Session has already passed — no changes allowed */}
              {sessionPassed && !campStarted && (
                <p className="mt-4 rounded-lg bg-brown-800/60 px-4 py-2 text-sm text-brown-400">
                  This session has already taken place. No changes can be made.
                </p>
              )}

              {/* Camp has started — no cancellation allowed */}
              {campStarted && (
                <p className="mt-4 rounded-lg bg-red-900/30 px-4 py-2 text-sm text-red-400">
                  This camp has already started. Cancellations are no longer accepted and the full amount is due.
                </p>
              )}

              {/* Full camp — can only cancel entire camp, no individual day cancel or reschedule */}
              {!sessionPassed && booking.type === "camp" && booking.isFullCamp ? (
                <>
                  <p className="mt-4 rounded-lg bg-brown-800/60 px-4 py-2 text-sm text-brown-300">
                    You registered for the full camp package. Individual days cannot be cancelled or rescheduled — you may only cancel the entire camp.
                  </p>

                  {!showCancelConfirm && (
                    <div className="mt-6">
                      <button
                        onClick={() => setShowCancelConfirm(true)}
                        className="rounded border border-red-700 px-4 py-2 text-sm text-red-400 hover:bg-red-900/30"
                      >
                        Cancel Entire Camp
                      </button>
                    </div>
                  )}

                  {showCancelConfirm && (
                    <div className="mt-6 rounded-lg border border-red-800 bg-red-900/20 p-4">
                      <p className="text-sm text-brown-300">
                        Are you sure you want to cancel the entire camp? All registered days will be cancelled.
                        {within24Hours && !withinGracePeriod &&
                          " Since the camp is within 24 hours, 50% of the total camp fee will still be due per our cancellation policy."}
                      </p>
                      <div className="mt-3 flex gap-3">
                        <button
                          onClick={handleCancel}
                          disabled={cancelling}
                          className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          {cancelling ? "Cancelling..." : "Yes, Cancel Entire Camp"}
                        </button>
                        <button
                          onClick={() => setShowCancelConfirm(false)}
                          className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                        >
                          Go Back
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : !sessionPassed ? (
                <>
                  {/* Drop-in or non-camp — normal cancel/reschedule/edit-players */}
                  {!showCancelConfirm && !showReschedule && !showEditPlayers && (
                    <div className="mt-6 flex flex-wrap gap-3">
                      <button
                        onClick={() => setShowCancelConfirm(true)}
                        className="rounded border border-red-700 px-4 py-2 text-sm text-red-400 hover:bg-red-900/30"
                      >
                        Cancel Session
                      </button>
                      {booking.type !== "camp" && (
                        <button
                          onClick={() => { setShowReschedule(true); loadSchedule(); }}
                          className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600"
                        >
                          Reschedule
                        </button>
                      )}
                      {booking.type !== "camp" && (
                        <button
                          onClick={openEditPlayers}
                          className="rounded border border-brown-600 px-4 py-2 text-sm text-brown-300 hover:bg-brown-800"
                        >
                          Edit Players
                        </button>
                      )}
                    </div>
                  )}

                  {/* Feedback after player update — only in the main (no-mode) view */}
                  {!showCancelConfirm && !showReschedule && !showEditPlayers && (
                    <>
                      {playerSaveSuccess && (
                        <p className="mt-4 rounded-lg bg-green-900/30 px-4 py-2 text-sm text-green-400">
                          Player list updated successfully.
                        </p>
                      )}
                      {playerLateResult?.isLate && playerLateResult.lateFeeDue && (
                        <div className="mt-4 rounded-lg border border-yellow-700 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-400">
                          ⚠️ Player removed within 24 hours — a late fee of <strong>${playerLateResult.lateFeeDue}</strong> is still due. Please pay via Venmo, Zelle, or cash.
                        </div>
                      )}
                    </>
                  )}

                  {/* Edit Players */}
                  {showEditPlayers && (() => {
                    const originalPlayers = parseKids(booking.kids);
                    const removed = originalPlayers.filter((op) => !editedPlayers.includes(op)).map(playerName);
                    const hasChanges = JSON.stringify(editedPlayers) !== JSON.stringify(originalPlayers);
                    return (
                      <div className="mt-6">
                        <h2 className="text-lg font-semibold mb-3">Edit Players</h2>

                        <div className="space-y-2">
                          {editedPlayers.map((player, i) => (
                            <div key={i} className="flex items-center justify-between rounded-lg border border-brown-700 bg-brown-800/50 px-4 py-3">
                              <span className="text-white text-sm">{playerName(player)}</span>
                              <button
                                onClick={() => setEditedPlayers((prev) => prev.filter((_, j) => j !== i))}
                                disabled={editedPlayers.length <= 1}
                                className="text-sm text-red-400 hover:text-red-300 disabled:text-brown-600 disabled:cursor-not-allowed"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>

                        {editedPlayers.length <= 1 && (
                          <p className="mt-2 text-xs text-brown-500">Add another player before you can remove the last one.</p>
                        )}

                        {/* Add player form */}
                        {!showAddPlayer ? (
                          <button
                            onClick={() => setShowAddPlayer(true)}
                            className="mt-3 text-sm text-mesa-accent hover:text-yellow-300"
                          >
                            + Add a player
                          </button>
                        ) : (
                          <div className="mt-3 space-y-3 rounded-lg border border-brown-700 bg-brown-800/50 p-4">
                            <p className="text-sm font-medium text-brown-300">New Player</p>
                            <input
                              type="text"
                              placeholder="Full name *"
                              value={newPlayerName}
                              onChange={(e) => setNewPlayerName(e.target.value)}
                              className="w-full rounded border border-brown-700 bg-brown-900 px-3 py-2 text-sm text-white placeholder-brown-600"
                            />
                            <div>
                              <label className="mb-1 block text-xs text-brown-400">Date of Birth *</label>
                              <DobInput value={newPlayerDob} onChange={setNewPlayerDob} />
                            </div>
                            <select
                              value={newPlayerGrade}
                              onChange={(e) => setNewPlayerGrade(e.target.value)}
                              className="w-full rounded border border-brown-700 bg-brown-900 px-3 py-2 text-sm text-white"
                            >
                              <option value="">Grade *</option>
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
                            <select
                              value={newPlayerGender}
                              onChange={(e) => setNewPlayerGender(e.target.value)}
                              className="w-full rounded border border-brown-700 bg-brown-900 px-3 py-2 text-sm text-white"
                            >
                              <option value="">Gender *</option>
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                            </select>
                            <div className="flex gap-2">
                              <button
                                disabled={!newPlayerName.trim() || newPlayerDob.length < 8 || !newPlayerGrade || !newPlayerGender}
                                onClick={() => {
                                  const p = buildPlayerString(newPlayerName, newPlayerDob, newPlayerGrade, newPlayerGender);
                                  setEditedPlayers((prev) => [...prev, p]);
                                  setNewPlayerName("");
                                  setNewPlayerDob("");
                                  setNewPlayerGrade("");
                                  setNewPlayerGender("");
                                  setShowAddPlayer(false);
                                }}
                                className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
                              >
                                Add
                              </button>
                              <button
                                onClick={() => { setShowAddPlayer(false); setNewPlayerName(""); setNewPlayerDob(""); setNewPlayerGrade(""); setNewPlayerGender(""); }}
                                className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {within24Hours && !withinGracePeriod && removed.length > 0 && (
                          <p className="mt-3 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
                            This session is within 24 hours. Removing a player will incur a late cancellation fee.
                          </p>
                        )}

                        {playerSaveError && (
                          <p className="mt-2 text-sm text-red-400">{playerSaveError}</p>
                        )}

                        <div className="mt-4 flex gap-3">
                          <button
                            onClick={() => setShowPlayerConfirm(true)}
                            disabled={!hasChanges || savingPlayers}
                            className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
                          >
                            Save Changes
                          </button>
                          <button
                            onClick={() => { setShowEditPlayers(false); setShowAddPlayer(false); }}
                            className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                          >
                            Go Back
                          </button>
                        </div>

                        {showPlayerConfirm && (
                          <div className="mt-4 rounded-lg border border-brown-700 bg-brown-800/50 p-4">
                            <p className="text-sm text-brown-300">
                              {removed.length > 0
                                ? `Remove ${removed.join(", ")} from this booking?`
                                : "Save changes to your player list?"}
                              {within24Hours && !withinGracePeriod && removed.length > 0
                                ? " A late cancellation fee will apply." : ""}
                            </p>
                            <div className="mt-3 flex gap-3">
                              <button
                                onClick={handleSavePlayers}
                                disabled={savingPlayers}
                                className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
                              >
                                {savingPlayers ? "Saving..." : "Confirm"}
                              </button>
                              <button
                                onClick={() => setShowPlayerConfirm(false)}
                                className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                              >
                                Go Back
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Cancel Confirmation */}
                  {showCancelConfirm && (
                    <div className="mt-6 rounded-lg border border-red-800 bg-red-900/20 p-4">
                      <p className="text-sm text-brown-300">
                        Are you sure you want to cancel this session?
                        {within24Hours && !withinGracePeriod &&
                          " Since this is within 24 hours, 50% of the session fee will still be due per our rescheduling/cancellation policy."}
                      </p>
                      <div className="mt-3 flex gap-3">
                        <button
                          onClick={handleCancel}
                          disabled={cancelling}
                          className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          {cancelling ? "Cancelling..." : "Yes, Cancel"}
                        </button>
                        <button
                          onClick={() => setShowCancelConfirm(false)}
                          className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                        >
                          Go Back
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : null}

              {/* Reschedule Section */}
              {showReschedule && (
                <div className="mt-6">
                  <h2 className="text-lg font-semibold">Pick a New Time</h2>

                  {timeWindows.length === 0 && (
                    <p className="mt-4 text-sm text-brown-500">
                      No available slots right now. Contact Artemios directly.
                    </p>
                  )}

                  <div className="mt-4 space-y-3">
                    {timeWindows.map((w, wi) => {
                      const d = new Date(w.date);
                      const dayName = d.toLocaleDateString("en-US", {
                        weekday: "long",
                        timeZone: "UTC",
                      });
                      const dateLabel = d.toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        timeZone: "UTC",
                      });
                      const isSelected = selectedWindow === wi;
                      const totalAvailable = w.endMins - w.startMins;

                      // Start options (15-min increments, must leave room for 60 min)
                      const startOptions: number[] = [];
                      for (let t = w.startMins; t <= w.endMins - 60; t += 15) {
                        startOptions.push(t);
                      }
                      // Duration options
                      const effectiveStart = isSelected ? selectedStart : w.startMins;
                      const durOptions: number[] = [];
                      for (let d = 60; d <= w.endMins - effectiveStart; d += 15) {
                        durOptions.push(d);
                      }

                      return (
                        <button
                          key={wi}
                          onClick={() => {
                            setSelectedWindow(wi);
                            setSelectedStart(w.startMins);
                            setSelectedDuration(Math.min(60, totalAvailable));
                            setUpsellExtra(0);
                          }}
                          className={`block w-full rounded-lg border p-4 text-left transition ${
                            isSelected
                              ? "border-mesa-accent bg-mesa-accent/10"
                              : "border-brown-700 bg-brown-800/50 hover:border-brown-500"
                          }`}
                        >
                          <p className="font-medium">
                            {dayName}, {dateLabel}
                          </p>
                          <p className="text-sm text-brown-400">
                            {w.location} &bull; {w.startLabel} - {w.endLabel} ({totalAvailable} min)
                          </p>

                          {isSelected && (
                            <div
                              className="mt-3 flex flex-wrap items-end gap-3"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div>
                                <label className="mb-1 block text-xs text-brown-400">Start</label>
                                <select
                                  value={selectedStart}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value);
                                    setSelectedStart(v);
                                    const maxDur = w.endMins - v;
                                    if (selectedDuration > maxDur) setSelectedDuration(Math.max(60, maxDur));
                                  }}
                                  className="rounded border border-brown-700 bg-brown-800 px-2 py-1 text-sm text-white"
                                >
                                  {startOptions.map((t) => (
                                    <option key={t} value={t}>{formatTimeFromMins(t)}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs text-brown-400">Duration</label>
                                <select
                                  value={selectedDuration}
                                  onChange={(e) => setSelectedDuration(parseInt(e.target.value))}
                                  className="rounded border border-brown-700 bg-brown-800 px-2 py-1 text-sm text-white"
                                >
                                  {durOptions.map((d) => (
                                    <option key={d} value={d}>{d} min</option>
                                  ))}
                                </select>
                              </div>
                              <p className="text-sm text-brown-300">
                                {formatTimeFromMins(selectedStart)} - {formatTimeFromMins(selectedStart + selectedDuration)}
                              </p>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Upsell prompt */}
                  {selectedWindow >= 0 && !hideUpsell && (() => {
                    const w = timeWindows[selectedWindow];
                    if (!w) return null;
                    const totalAvail = w.endMins - w.startMins;
                    const remaining = w.endMins - (selectedStart + selectedDuration);
                    if (selectedDuration > 60 || totalAvail > 120 || remaining <= 0) return null;
                    const extras = [15, 30].filter((e) => e <= remaining);
                    if (extras.length === 0) return null;
                    if (upsellExtra > 0) {
                      return (
                        <div className="mt-4 flex items-center justify-between rounded-lg bg-green-900/20 px-4 py-2">
                          <p className="text-sm text-green-400">+{upsellExtra} min added at 50% off</p>
                          <button type="button" onClick={() => setUpsellExtra(0)} className="text-xs text-brown-500 hover:text-red-400">Remove</button>
                        </div>
                      );
                    }
                    return (
                      <div className="mt-4 rounded-lg border border-green-800/50 bg-green-900/20 p-4">
                        <p className="text-sm font-semibold text-green-400">Extend your session?</p>
                        <p className="mt-1 text-xs text-brown-300">Add extra time at half price. More reps, more progress — same session.</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {extras.map((extra) => {
                            const cost = getPrivatePrice(extra, 1) * 0.5;
                            return (
                              <button key={extra} type="button" onClick={() => setUpsellExtra(extra)} className="rounded bg-green-800/40 px-3 py-2 text-sm text-green-300 hover:bg-green-800/60">
                                +{extra} min (+{formatPrice(cost)})
                              </button>
                            );
                          })}
                          <button type="button" onClick={() => { setHideUpsell(true); localStorage.setItem("mesa_hide_upsell", "true"); }} className="text-xs text-brown-500 hover:text-brown-400 self-center ml-2">
                            Don&apos;t show this again
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Bottom buttons (for short lists) */}
                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={handleReschedule}
                      disabled={rescheduling || selectedWindow < 0}
                      className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
                    >
                      {rescheduling ? "Rescheduling..." : "Confirm Reschedule"}
                    </button>
                    <button
                      onClick={() => { setShowReschedule(false); setSelectedWindow(-1); setSelectedStart(0); setSelectedDuration(60); setUpsellExtra(0); }}
                      className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                    >
                      Go Back
                    </button>
                  </div>
                </div>
              )}

              {/* Sticky bottom bar when rescheduling with a slot selected */}
              {showReschedule && selectedWindow >= 0 && (
                <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-brown-700 bg-brown-900 px-6 py-3 shadow-2xl">
                  <div className="mx-auto flex max-w-lg items-center justify-between">
                    <div className="text-sm text-brown-300">
                      {(() => {
                        const w = timeWindows[selectedWindow];
                        if (!w) return null;
                        const d = new Date(w.date);
                        const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
                        const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
                        return `${day}, ${dateStr} ${formatTimeFromMins(selectedStart)}-${formatTimeFromMins(selectedStart + selectedDuration)}`;
                      })()}
                    </div>
                    <button
                      onClick={handleReschedule}
                      disabled={rescheduling}
                      className="rounded bg-mesa-accent px-5 py-2 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
                    >
                      {rescheduling ? "Rescheduling..." : "Confirm Reschedule"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
