"use client";

import { useState } from "react";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError("");
    setBookings(null);

    try {
      const res = await fetch("/api/my-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setBookings(data.registrations);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-mesa-dark text-white">
      <div className="mx-auto max-w-lg px-6 py-16">
        <a href="/" className="text-sm text-mesa-accent hover:text-amber-400">
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
              className="rounded-lg bg-mesa-accent px-6 py-3 font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
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

        {bookings !== null && bookings.length > 0 && (
          <div className="mt-8 space-y-4">
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
                          <span className="text-brown-500">Kids:</span>{" "}
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
                        className="inline-flex items-center gap-1 text-sm font-medium text-mesa-accent hover:text-amber-400"
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
