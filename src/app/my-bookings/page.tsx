"use client";

import { useState, useEffect } from "react";
import { authClient } from "@/lib/auth";

const LOCATION_NAMES: Record<string, string> = {
  "St. Pauls": "St. Paul's Cathedral",
  "St. Paul's": "St. Paul's Cathedral",
  "Cherry Valley": "Cherry Valley Sports",
};

function formatSessionDetails(details: string, bookedDate?: string | null): string {
  let result = details;

  // Inject day of week before the YYYY-MM-DD date in the string
  if (bookedDate) {
    const match = result.match(/\d{4}-\d{2}-\d{2}/);
    if (match) {
      const d = new Date(bookedDate + "T12:00:00");
      const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
      const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      result = result.replace(match[0], `${dayName}, ${dateStr}`);
    }
  }

  for (const [key, name] of Object.entries(LOCATION_NAMES)) {
    if (result.includes(key)) {
      return result.replace(key, name);
    }
  }
  return result;
}

interface BookingRecord {
  id: string;
  createdAt: string;
  parentName: string;
  kids: string;
  type: string;
  sessionDetails: string;
  bookedDate: string | null;
  bookedStartTime: string | null;
  bookedEndTime: string | null;
  bookedLocation: string | null;
  status: string;
  manageToken: string;
}

export default function MyBookings() {
  const [email, setEmail] = useState("");
  const [bookings, setBookings] = useState<BookingRecord[] | null>(null);
  const [rewards, setRewards] = useState<{
    referralCredits: number;
    referralCode: string | null;
  } | null>(null);
  const [activePackage, setActivePackage] = useState<{ packageType: number; sessionsUsed: number; monthYear: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");

  // Load saved email and auto-lookup — prefer logged-in session
  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      const sessionEmail = session?.user?.email;
      if (sessionEmail) {
        setEmail(sessionEmail);
        lookupBookings(sessionEmail);
      } else if (typeof window !== "undefined") {
        const saved = localStorage.getItem("mesa_parent_email");
        if (saved) {
          setEmail(saved);
          lookupBookings(saved);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function lookupBookings(lookupEmail: string) {
    setLoading(true);
    setError("");
    setBookings(null);
    try {
      const res = await fetch("/api/my-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: lookupEmail.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setBookings(data.registrations);
        setRewards(data.rewards || null);
        setActivePackage(data.activePackage || null);
        localStorage.setItem("mesa_parent_email", lookupEmail.trim());
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <a href="/" className="text-sm text-mesa-accent hover:text-yellow-300">
          &larr; Back to Home
        </a>

        <h1 className="mt-6 text-3xl font-bold">My Bookings</h1>

        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        {loading && (
          <p className="mt-8 text-brown-400 text-sm">Loading your bookings...</p>
        )}

        {!loading && bookings === null && !error && (
          <div className="mt-8 rounded-2xl bg-brown-900 p-8 text-center">
            <p className="text-brown-300 mb-4">Log in to view your bookings.</p>
            <a href="/login?next=/my-bookings" className="inline-block rounded-lg bg-mesa-accent px-6 py-3 font-semibold text-white hover:bg-yellow-600">
              Log In
            </a>
          </div>
        )}

        {bookings !== null && (
          <div className="mt-8 md:grid md:grid-cols-3 md:gap-8 md:items-start">

            {/* Sidebar — referrals + package */}
            {(rewards || activePackage) && (
              <div className="md:col-span-1 space-y-5 mb-8 md:mb-0">
                {rewards && (
                  <div className="rounded-2xl bg-brown-900 p-5 space-y-4">
                    <div>
                      <h2 className="text-sm font-bold uppercase tracking-widest text-mesa-accent mb-3">Referrals</h2>
                      <p className="text-xs text-brown-500 mb-1">Your Referral Code</p>
                      <p className="text-2xl font-bold text-mesa-accent">{rewards.referralCode || "—"}</p>
                      <p className="mt-2 text-xs text-brown-500 leading-relaxed">
                        Share your code — when a new client books with it, you earn 50% off your next private session.
                      </p>
                    </div>

                    <div className={`rounded-xl border px-4 py-3 ${rewards.referralCredits > 0 ? "border-mesa-accent/50 bg-mesa-accent/10" : "border-brown-700 bg-brown-800/40"}`}>
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-widest text-brown-400">Credits Earned</p>
                        <span className={`text-2xl font-bold ${rewards.referralCredits > 0 ? "text-mesa-accent" : "text-brown-600"}`}>
                          {rewards.referralCredits}
                        </span>
                      </div>
                      <p className={`mt-1 text-xs leading-relaxed ${rewards.referralCredits > 0 ? "text-mesa-accent/80" : "text-brown-600"}`}>
                        {rewards.referralCredits > 0
                          ? `${rewards.referralCredits} half-off session${rewards.referralCredits !== 1 ? "s" : ""} ready to use — applied automatically at checkout.`
                          : "No credits yet. Start sharing your code!"}
                      </p>
                    </div>
                  </div>
                )}

                {activePackage && (() => {
                  const remaining = activePackage.packageType - activePackage.sessionsUsed;
                  const [pkgYear, pkgMonth] = activePackage.monthYear.split("-").map(Number);
                  const expiry = new Date(pkgYear, pkgMonth, 0).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
                  const monthLabel = new Date(pkgYear, pkgMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
                  return (
                    <div className="rounded-2xl bg-brown-900 p-5">
                      <h2 className="text-sm font-bold uppercase tracking-widest text-mesa-accent mb-3">Package</h2>
                      <p className="text-xs text-brown-400 mb-3">{monthLabel} &middot; {activePackage.packageType} sessions</p>
                      <div className="flex items-end justify-between mb-3">
                        <div>
                          <p className="text-3xl font-bold text-mesa-accent">{remaining}</p>
                          <p className="text-xs text-brown-400">session{remaining !== 1 ? "s" : ""} remaining</p>
                        </div>
                        <p className="text-xs text-brown-500">{activePackage.sessionsUsed} used</p>
                      </div>
                      <div className="h-2 rounded-full bg-brown-700">
                        <div
                          className="h-2 rounded-full bg-mesa-accent transition-all"
                          style={{ width: `${Math.min(100, (activePackage.sessionsUsed / activePackage.packageType) * 100)}%` }}
                        />
                      </div>
                      {remaining === 0 ? (
                        <p className="mt-3 text-xs text-yellow-400/80">All sessions used — contact Artemios to enroll in next month&apos;s package.</p>
                      ) : (
                        <p className="mt-3 text-xs text-brown-500">Expires {expiry}.</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Main — bookings */}
            <div className={rewards || activePackage ? "md:col-span-2" : "md:col-span-3"}>

        {bookings.length === 0 && (
          <div className="rounded-2xl bg-brown-900 p-6 text-center">
            <p className="text-brown-400">No bookings found for this account.</p>
          </div>
        )}

        {bookings.length > 0 && (() => {
          const now = new Date();
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          // Parse a booking's session datetime (date + start time if available)
          function sessionDateTime(b: BookingRecord): Date | null {
            if (!b.bookedDate) return null;
            const d = new Date(b.bookedDate);
            if (b.bookedStartTime) {
              const m = b.bookedStartTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
              if (m) {
                let h = parseInt(m[1]);
                const min = parseInt(m[2]);
                const period = m[3].toUpperCase();
                if (period === "PM" && h !== 12) h += 12;
                if (period === "AM" && h === 12) h = 0;
                d.setHours(h, min, 0, 0);
              }
            }
            return d;
          }

          // Upcoming: confirmed only, future date (or no date)
          const upcoming = bookings
            .filter((b) => {
              if (b.status !== "confirmed") return false;
              const dt = sessionDateTime(b);
              return !dt || dt > now;
            })
            .sort((a, b) => {
              const da = sessionDateTime(a);
              const db = sessionDateTime(b);
              if (!da) return -1;
              if (!db) return 1;
              return da.getTime() - db.getTime();
            });

          // Past: anything with a past date OR any cancelled session
          const past = bookings
            .filter((b) => {
              if (b.status === "cancelled") return true;
              const dt = sessionDateTime(b);
              return dt !== null && dt <= now;
            })
            .sort((a, b) => {
              const da = sessionDateTime(a)?.getTime() ?? 0;
              const db = sessionDateTime(b)?.getTime() ?? 0;
              return db - da;
            });

          function renderCard(b: BookingRecord, isPast = false) {
            const isConfirmed = b.status === "confirmed";
            const isCancelled = b.status === "cancelled";
            const isClickable = isConfirmed && !isPast;

            const typeLabel =
              b.type === "group-private" ? "Group Private"
              : b.type === "private" ? "Private"
              : b.type === "weekly" ? "Group Session"
              : b.type === "camp" ? "Camp"
              : b.type;

            const inner = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-white">
                      {formatSessionDetails(b.sessionDetails, b.bookedDate)}
                    </p>
                    <div className="mt-2 space-y-1 text-sm">
                      <p className="text-brown-400">
                        <span className="text-brown-500">Players:</span> {b.kids}
                      </p>
                      <p className="text-brown-400">
                        <span className="text-brown-500">Type:</span> {typeLabel}
                      </p>
                      <p className="text-brown-500 text-xs">
                        Registered{" "}
                        {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    {isConfirmed && (
                      <span className="inline-block rounded-full bg-green-900/40 px-3 py-1 text-xs font-medium text-green-400">Confirmed</span>
                    )}
                    {isCancelled && (
                      <span className="inline-block rounded-full bg-red-900/40 px-3 py-1 text-xs font-medium text-red-400">Cancelled</span>
                    )}
                    {!isConfirmed && !isCancelled && (
                      <span className="inline-block rounded-full bg-brown-700 px-3 py-1 text-xs font-medium text-brown-300">{b.status}</span>
                    )}
                  </div>
                </div>
                {isClickable && (
                  <p className="mt-4 text-sm font-medium text-mesa-accent">
                    Manage Booking &rarr;
                  </p>
                )}
              </>
            );

            const sharedClass = `block rounded-2xl border border-brown-700 bg-brown-800 p-5 transition ${
              isCancelled
                ? "opacity-50"
                : isClickable
                ? "hover:border-mesa-accent/50 cursor-pointer"
                : ""
            }`;

            if (isClickable) {
              return <a key={b.id} href={`/booking/${b.manageToken}`} className={sharedClass}>{inner}</a>;
            }
            return <div key={b.id} className={sharedClass}>{inner}</div>;
          }

          return (
            <div>
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setActiveTab("upcoming")}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold transition ${
                    activeTab === "upcoming"
                      ? "bg-mesa-accent text-white"
                      : "bg-brown-900 text-brown-400 hover:text-white"
                  }`}
                >
                  Upcoming {upcoming.length > 0 && `(${upcoming.length})`}
                </button>
                <button
                  onClick={() => setActiveTab("past")}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold transition ${
                    activeTab === "past"
                      ? "bg-brown-700 text-white"
                      : "bg-brown-900 text-brown-400 hover:text-white"
                  }`}
                >
                  Past {past.length > 0 && `(${past.length})`}
                </button>
              </div>

              {activeTab === "upcoming" && (
                <div className="space-y-4">
                  {upcoming.length > 0 ? upcoming.map((b) => renderCard(b, false)) : (
                    <p className="text-brown-500 text-sm">No upcoming sessions.</p>
                  )}
                </div>
              )}
              {activeTab === "past" && (
                <div className="space-y-4">
                  {past.length > 0 ? past.map((b) => renderCard(b, true)) : (
                    <p className="text-brown-500 text-sm">No past sessions.</p>
                  )}
                </div>
              )}
            </div>
          );
        })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
