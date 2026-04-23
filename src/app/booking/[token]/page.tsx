"use client";

import { useState, useEffect, useMemo, use } from "react";

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

function formatSessionDetails(details: string): string {
  for (const [key, { name }] of Object.entries(LOCATION_LINKS)) {
    if (details.includes(key)) {
      return details.replace(key, name);
    }
  }
  return details;
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

  // Check if within 48 hours
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
    return hoursUntil >= 0 && hoursUntil < 48;
  }, [booking]);

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
      const [year, month, day] = w.date.split("-").map(Number);
      const windowStart = new Date(year, month - 1, day, Math.floor(w.startMins / 60), w.startMins % 60);
      return windowStart > now;
    });
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
                ? "This cancellation was made within 48 hours of the camp. Per our policy, 50% of the total camp fee is still due."
                : "This change was made within 48 hours of the session. Per our policy, 50% of the session fee is still due."}
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
              This reschedule was made within 48 hours of the session. Per our policy, 50% of the session fee is still due.
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
                <p><span className="text-brown-400">Session:</span> {formatSessionDetails(booking.sessionDetails)}</p>
                <p><span className="text-brown-400">Players:</span> {booking.kids}</p>
                <p><span className="text-brown-400">Type:</span> {booking.type === "group-private" ? "Group Private" : "Private"}</p>
              </div>

              {within24Hours && (
                <p className="mt-4 rounded-lg bg-yellow-900/30 px-4 py-2 text-sm text-yellow-400">
                  {booking.isFullCamp
                    ? "This camp is within 48 hours. Canceling the entire camp will result in a 50% charge of the total camp fee."
                    : "This session is within 48 hours. Rescheduling or canceling will result in a 50% charge of the session fee."}
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
                        {within24Hours &&
                          " Since the camp is within 48 hours, 50% of the total camp fee will still be due per our cancellation policy."}
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
                  {/* Drop-in or non-camp — normal cancel/reschedule */}
                  {!showCancelConfirm && !showReschedule && (
                    <div className="mt-6 flex gap-3">
                      <button
                        onClick={() => setShowCancelConfirm(true)}
                        className="rounded border border-red-700 px-4 py-2 text-sm text-red-400 hover:bg-red-900/30"
                      >
                        Cancel Session
                      </button>
                      {booking.type !== "camp" && (
                        <button
                          onClick={() => {
                            setShowReschedule(true);
                            loadSchedule();
                          }}
                          className="rounded bg-mesa-accent px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-600"
                        >
                          Reschedule
                        </button>
                      )}
                    </div>
                  )}

                  {/* Cancel Confirmation */}
                  {showCancelConfirm && (
                    <div className="mt-6 rounded-lg border border-red-800 bg-red-900/20 p-4">
                      <p className="text-sm text-brown-300">
                        Are you sure you want to cancel this session?
                        {within24Hours &&
                          " Since this is within 48 hours, 50% of the session fee will still be due per our rescheduling/cancellation policy."}
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
                      onClick={() => setShowReschedule(false)}
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
                        return `${day}, ${w.date} ${formatTimeFromMins(selectedStart)}-${formatTimeFromMins(selectedStart + selectedDuration)}`;
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
