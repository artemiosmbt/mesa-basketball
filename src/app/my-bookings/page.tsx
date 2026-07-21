"use client";

import { useState, useEffect } from "react";
import { authClient } from "@/lib/auth";
import { fmtMoney } from "@/lib/pricing";

const LOCATION_NAMES: Record<string, string> = {
  "St. Pauls": "St. Paul's Cathedral",
  "St. Paul's": "St. Paul's Cathedral",
  "Cherry Valley": "Cherry Valley Sports",
  "Holy Resurrection": "Holy Resurrection Brookville",
  "Holy Resurrection Brookville": "Holy Resurrection Brookville",
};

function formatSessionDetails(details: string, bookedDate?: string | null): string {
  let result = details;

  if (bookedDate) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(bookedDate)
      ? new Date(bookedDate + "T12:00:00")
      : new Date(bookedDate + " 12:00:00");
    const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    // Try ISO format (YYYY-MM-DD) in the details string first
    const isoMatch = result.match(/\d{4}-\d{2}-\d{2}/);
    if (isoMatch) {
      result = result.replace(isoMatch[0], `${dayName}, ${dateStr}`);
    } else if (result.includes(dateStr)) {
      result = result.replace(dateStr, `${dayName}, ${dateStr}`);
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
  bookedTrainer: string | null;
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
  const [accountCredit, setAccountCredit] = useState(0);
  const [activePackage, setActivePackage] = useState<{ id: string; packageType: number; sessionsUsed: number; monthYear: string; cancellable: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");
  const [showPackageCancelConfirm, setShowPackageCancelConfirm] = useState(false);
  const [cancellingPackage, setCancellingPackage] = useState(false);
  const [packageCancelResult, setPackageCancelResult] = useState<{ success: boolean; message: string } | null>(null);

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
        setAccountCredit(data.accountCredit || 0);
        setActivePackage(data.activePackage || null);
        localStorage.setItem("mesa_parent_email", lookupEmail.trim());
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelPackage() {
    if (!activePackage) return;
    setCancellingPackage(true);
    try {
      const res = await fetch("/api/packages/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: activePackage.id, email }),
      });
      const data = await res.json();
      if (data.success) {
        setPackageCancelResult({
          success: true,
          message: data.refundFailed
            ? "Your package has been cancelled. Your refund is being processed — you'll get a separate confirmation once it's complete."
            : data.refundedAmount > 0 && data.creditedAmount > 0
              ? `Your package has been cancelled — $${fmtMoney(data.refundedAmount)} has been refunded to your original payment method and $${fmtMoney(data.creditedAmount)} credited to your account (the $4.50 service fee isn't refundable).`
              : data.creditedAmount > 0
                ? `Your package has been cancelled and $${fmtMoney(data.creditedAmount)} has been credited to your account (the $4.50 service fee isn't refundable).`
                : `Your package has been cancelled and $${fmtMoney(data.refundedAmount)} has been refunded to your original payment method (the $4.50 service fee isn't refundable).`,
        });
        setActivePackage(null);
      } else {
        setPackageCancelResult({ success: false, message: data.error || "Failed to cancel package." });
      }
    } catch {
      setPackageCancelResult({ success: false, message: "Something went wrong. Please try again." });
    } finally {
      setCancellingPackage(false);
      setShowPackageCancelConfirm(false);
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
          <div className="mt-8 space-y-6">
            <form
              onSubmit={(e) => { e.preventDefault(); if (email.trim()) lookupBookings(email.trim()); }}
              className="rounded-2xl bg-brown-900 p-6 space-y-4"
            >
              <p className="text-sm text-brown-300">Enter the email you used when registering to view your bookings.</p>
              <div className="flex gap-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="flex-1 rounded-lg bg-brown-800 border border-brown-700 px-4 py-2.5 text-sm text-white placeholder-brown-500 focus:outline-none focus:border-mesa-accent"
                />
                <button
                  type="submit"
                  disabled={!email.trim()}
                  className="rounded-lg bg-mesa-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-40"
                >
                  Look up
                </button>
              </div>
            </form>
            <div className="text-center text-sm text-brown-600">or</div>
            <div className="text-center">
              <a href="/login?next=/my-bookings" className="inline-block rounded-lg bg-brown-800 border border-brown-700 px-6 py-3 text-sm font-semibold text-white hover:bg-brown-700">
                Log In
              </a>
            </div>
          </div>
        )}

        {bookings !== null && (
          <div className="mt-8 md:grid md:grid-cols-3 md:gap-8 md:items-start">

            {/* Sidebar — referrals + package + credit (credit card always shows, even at $0) */}
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

                <div className="rounded-2xl bg-brown-900 p-5">
                  <h2 className="text-sm font-bold uppercase tracking-widest text-mesa-accent mb-3">Account Credit</h2>
                  <div className={`rounded-xl border px-4 py-3 ${accountCredit > 0 ? "border-mesa-accent/50 bg-mesa-accent/10" : "border-brown-700 bg-brown-800/40"}`}>
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-widest text-brown-400">Available</p>
                      <span className={`text-2xl font-bold ${accountCredit > 0 ? "text-mesa-accent" : "text-brown-600"}`}>${accountCredit}</span>
                    </div>
                    <p className={`mt-1 text-xs leading-relaxed ${accountCredit > 0 ? "text-mesa-accent/80" : "text-brown-600"}`}>
                      {accountCredit > 0
                        ? "Applied automatically toward your next booking's total."
                        : "No credit on your account right now."}
                    </p>
                  </div>
                </div>

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

                      {showPackageCancelConfirm ? (
                        <div className="mt-4 rounded-lg border border-red-800/50 bg-red-900/10 p-3">
                          <p className="text-xs text-brown-300 mb-3">Cancel this package and refund the package price to your card? (The $4.50 service fee isn&apos;t refundable.)</p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleCancelPackage}
                              disabled={cancellingPackage}
                              className="flex-1 rounded-lg bg-red-800 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {cancellingPackage ? "Cancelling..." : "Yes, cancel & refund"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowPackageCancelConfirm(false)}
                              disabled={cancellingPackage}
                              className="flex-1 rounded-lg bg-brown-700 py-2 text-xs font-semibold text-white hover:bg-brown-600 disabled:opacity-50"
                            >
                              Never mind
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => activePackage.cancellable && setShowPackageCancelConfirm(true)}
                          disabled={!activePackage.cancellable}
                          title={activePackage.cancellable ? "" : "A session has already been booked against this package — it can no longer be cancelled."}
                          className={`mt-4 w-full rounded-lg py-2 text-xs font-semibold transition ${
                            activePackage.cancellable
                              ? "bg-brown-800 text-red-400 hover:bg-brown-700 border border-red-900/50"
                              : "bg-brown-800/50 text-brown-600 cursor-not-allowed"
                          }`}
                        >
                          Cancel Package
                        </button>
                      )}
                    </div>
                  );
                })()}

                {packageCancelResult && (
                  <div className={`rounded-2xl p-4 text-sm ${packageCancelResult.success ? "bg-green-900/20 border border-green-800/50 text-green-300" : "bg-red-900/20 border border-red-800/50 text-red-300"}`}>
                    {packageCancelResult.message}
                  </div>
                )}
            </div>

            {/* Main — bookings */}
            <div className="md:col-span-2">

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
                      {b.bookedTrainer && (
                        <p className="text-brown-400">
                          <span className="text-brown-500">Trainer:</span> {b.bookedTrainer}
                        </p>
                      )}
                      <p className="text-brown-500 text-xs">
                        Registered{" "}
                        {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    {isConfirmed && !isPast && (
                      <span className="inline-block rounded-full bg-green-900/40 px-3 py-1 text-xs font-medium text-green-400">Scheduled</span>
                    )}
                    {isConfirmed && isPast && (
                      <span className="inline-block rounded-full bg-brown-800 px-3 py-1 text-xs font-medium text-brown-400">Completed</span>
                    )}
                    {isCancelled && (
                      <span className="inline-block rounded-full bg-red-900/40 px-3 py-1 text-xs font-medium text-red-400">Cancelled</span>
                    )}
                    {!isConfirmed && !isCancelled && (
                      <span className="inline-block rounded-full bg-brown-700 px-3 py-1 text-xs font-medium text-brown-300">
                        {b.status === "no_show" ? "No-Show"
                          : b.status === "payment_abandoned" ? "Payment Not Completed"
                          : b.status === "pending_payment" ? "Payment Pending"
                          : b.status}
                      </span>
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
