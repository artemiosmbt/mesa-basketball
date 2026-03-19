"use client";

import { useState, useEffect, useMemo, use } from "react";

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
}

interface TimeWindow {
  date: string;
  location: string;
  startMins: number;
  endMins: number;
  startLabel: string;
  endLabel: string;
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

  // Check if within 24 hours
  const within24Hours = useMemo(() => {
    if (!booking?.bookedDate || !booking?.bookedStartTime) return false;
    const sessionDateTime = new Date(
      `${booking.bookedDate} ${booking.bookedStartTime}`
    );
    const hoursUntil =
      (sessionDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
    return hoursUntil < 24;
  }, [booking]);

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

    return result.filter((w) => w.endMins - w.startMins >= 60);
  }, [privateSlots, bookedSlots]);

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
    const endMins = selectedStart + selectedDuration;

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
          <a href="/" className="mt-4 inline-block text-mesa-accent hover:text-amber-400">
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  if (!booking) return null;

  if (cancelled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-mesa-dark text-white">
        <div className="mx-auto max-w-md rounded-2xl bg-brown-900 p-8 text-center">
          <h1 className="text-2xl font-bold">Session Cancelled</h1>
          <p className="mt-4 text-brown-300">
            Your session has been cancelled. You&apos;ll receive a confirmation email.
          </p>
          {isLateCancel && (
            <p className="mt-3 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
              This cancellation was made within 24 hours of the session. Per our policy, 50% of the session fee is still due.
            </p>
          )}
          <a href="/" className="mt-6 inline-block rounded bg-mesa-accent px-6 py-2 font-semibold text-white hover:bg-amber-600">
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
          <a href="/" className="mt-6 inline-block rounded bg-mesa-accent px-6 py-2 font-semibold text-white hover:bg-amber-600">
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
        <a href="/" className="text-sm text-mesa-accent hover:text-amber-400">
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
                <p><span className="text-brown-400">Session:</span> {booking.sessionDetails}</p>
                <p><span className="text-brown-400">Kids:</span> {booking.kids}</p>
                <p><span className="text-brown-400">Type:</span> {booking.type === "group-private" ? "Group Private" : "Private"}</p>
              </div>

              {within24Hours && (
                <p className="mt-4 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
                  This session is within 24 hours. Cancellations will result in a 50% charge.
                </p>
              )}

              {/* Cancel Section */}
              {!showCancelConfirm && !showReschedule && (
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="rounded border border-red-700 px-4 py-2 text-sm text-red-400 hover:bg-red-900/30"
                  >
                    Cancel Session
                  </button>
                  <button
                    onClick={() => {
                      setShowReschedule(true);
                      loadSchedule();
                    }}
                    className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
                  >
                    Reschedule
                  </button>
                </div>
              )}

              {/* Cancel Confirmation */}
              {showCancelConfirm && (
                <div className="mt-6 rounded-lg border border-red-800 bg-red-900/20 p-4">
                  <p className="text-sm text-brown-300">
                    Are you sure you want to cancel this session?
                    {within24Hours &&
                      " Since this is within 24 hours, 50% of the session fee will still be due."}
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
                          }}
                          className={`block w-full rounded-lg border p-4 text-left transition ${
                            isSelected
                              ? "border-mesa-accent bg-mesa-accent/10"
                              : "border-brown-700 bg-brown-800/50 hover:border-brown-500"
                          }`}
                        >
                          <p className="font-medium">
                            {dayName}, {w.date}
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

                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={handleReschedule}
                      disabled={rescheduling || selectedWindow < 0}
                      className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                    >
                      {rescheduling ? "Rescheduling..." : "Confirm Reschedule"}
                    </button>
                    <button
                      onClick={() => setShowReschedule(false)}
                      className="rounded bg-brown-700 px-4 py-2 text-sm text-brown-300 hover:bg-brown-600"
                    >
                      Go Back
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
