"use client";

import { useState, useEffect } from "react";

const LOCATION_NAMES: Record<string, string> = {
  "St. Pauls": "St. Paul's Cathedral",
  "St. Paul's": "St. Paul's Cathedral",
  "Cherry Valley": "Cherry Valley Sports",
};

function formatSessionDetails(details: string): string {
  for (const [key, name] of Object.entries(LOCATION_NAMES)) {
    if (details.includes(key)) {
      return details.replace(key, name);
    }
  }
  return details;
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

  // Load saved email and auto-lookup
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("mesa_parent_email");
      if (saved) {
        setEmail(saved);
        lookupBookings(saved);
      }
    }
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

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    lookupBookings(email);
  }

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <div className="mx-auto max-w-lg px-6 py-16">
        <a href="/" className="text-sm text-mesa-accent hover:text-yellow-300">
          &larr; Back to Home
        </a>

        <h1 className="mt-6 text-3xl font-bold">My Bookings</h1>
        <p className="mt-2 text-brown-400">
          Enter your email to view all your registrations.
        </p>

        <form onSubmit={handleLookup} className="mt-6">
          <div className="flex gap-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="parent@example.com"
              required
              className="flex-1 rounded-lg border border-brown-700 bg-brown-800 px-4 py-3 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none focus:ring-1 focus:ring-mesa-accent"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-mesa-accent px-6 py-3 font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
            >
              {loading ? "Looking up..." : "Look Up"}
            </button>
          </div>
        </form>

        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        {bookings !== null && bookings.length === 0 && (
          <div className="mt-8 rounded-2xl bg-brown-900 p-6 text-center">
            <p className="text-brown-400">
              No bookings found for <span className="text-white">{email}</span>.
            </p>
            <p className="mt-2 text-sm text-brown-500">
              Make sure you&apos;re using the same email you registered with.
            </p>
          </div>
        )}

        {/* Referral Section */}
        {rewards && (
          <div className="mt-8 rounded-2xl bg-brown-900 p-6">
            <h2 className="text-lg font-bold">Referrals</h2>
            <div className="mt-4 rounded-lg bg-brown-800/60 p-4">
              <p className="text-sm font-semibold text-brown-300">Your Referral Code</p>
              <p className="mt-1 text-xl font-bold text-mesa-accent">{rewards.referralCode || "—"}</p>
              <p className="mt-2 text-xs text-brown-500">
                Share your code with friends — when a new client books using your code, you earn a 50% off credit on your next private session.
              </p>
              {rewards.referralCredits > 0 && (
                <p className="mt-2 text-sm font-semibold text-mesa-accent">
                  {rewards.referralCredits} half-off credit{rewards.referralCredits !== 1 ? "s" : ""} available — will be applied automatically on your next booking.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Monthly Package Status Card */}
        {activePackage && (
          <div className="mt-6 rounded-2xl bg-brown-900 p-6">
            <h2 className="text-lg font-bold">
              Monthly Package —{" "}
              {new Date(activePackage.monthYear + "-01").toLocaleDateString("en-US", {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              })}
            </h2>
            <div className="mt-4 space-y-3">
              <p className="text-sm text-brown-300">
                {activePackage.packageType}-session package
              </p>
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-brown-400">
                    {activePackage.sessionsUsed} used &middot;{" "}
                    {activePackage.packageType - activePackage.sessionsUsed} remaining
                  </span>
                  <span className="text-brown-500 text-xs">
                    {activePackage.sessionsUsed}/{activePackage.packageType}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-brown-700">
                  <div
                    className="h-2 rounded-full bg-mesa-accent transition-all"
                    style={{
                      width: `${Math.min(100, (activePackage.sessionsUsed / activePackage.packageType) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-brown-500">
                Sessions expire{" "}
                {new Date(
                  new Date(activePackage.monthYear + "-01").getFullYear(),
                  new Date(activePackage.monthYear + "-01").getMonth() + 1,
                  0
                ).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </div>
        )}

        {bookings !== null && bookings.length > 0 && (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-brown-500">
              {bookings.length} booking{bookings.length !== 1 ? "s" : ""} found
            </p>

            {bookings.map((b) => {
              const isConfirmed = b.status === "confirmed";
              const isCancelled = b.status === "cancelled";

              return (
                <div
                  key={b.id}
                  className={`rounded-2xl bg-brown-900 p-5 ${
                    isCancelled ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-white">
                        {formatSessionDetails(b.sessionDetails)}
                      </p>
                      <div className="mt-2 space-y-1 text-sm">
                        <p className="text-brown-400">
                          <span className="text-brown-500">Players:</span>{" "}
                          {b.kids}
                        </p>
                        <p className="text-brown-400">
                          <span className="text-brown-500">Type:</span>{" "}
                          {b.type === "group-private"
                            ? "Group Private"
                            : b.type === "private"
                            ? "Private"
                            : b.type === "group"
                            ? "Group"
                            : b.type === "camp"
                            ? "Camp"
                            : b.type}
                        </p>
                        <p className="text-brown-500 text-xs">
                          Registered{" "}
                          {new Date(b.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      {isConfirmed && (
                        <span className="inline-block rounded-full bg-green-900/40 px-3 py-1 text-xs font-medium text-green-400">
                          Confirmed
                        </span>
                      )}
                      {isCancelled && (
                        <span className="inline-block rounded-full bg-red-900/40 px-3 py-1 text-xs font-medium text-red-400">
                          Cancelled
                        </span>
                      )}
                      {!isConfirmed && !isCancelled && (
                        <span className="inline-block rounded-full bg-brown-700 px-3 py-1 text-xs font-medium text-brown-300">
                          {b.status}
                        </span>
                      )}
                    </div>
                  </div>

                  {isConfirmed && (
                    <div className="mt-3 border-t border-brown-800 pt-3">
                      <a
                        href={`/booking/${b.manageToken}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-mesa-accent hover:text-yellow-300"
                      >
                        Manage Booking &rarr;
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
