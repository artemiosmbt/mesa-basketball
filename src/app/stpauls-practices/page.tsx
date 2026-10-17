"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { authClient } from "@/lib/auth";
import LandingNav from "../LandingNav";
import {
  addDays,
  bookableRange,
  formatDateLong,
  formatDateShort,
  formatTime12,
  nyNow,
  dayOfWeek,
  overlaps,
  practiceEnd,
  startTimesForDate,
  STPAULS_PATH,
  STPAULS_PRICE,
  toMinutes,
} from "@/lib/stpauls";

// Unlisted coach page: church teams pick a 1-hour practice time inside the
// St. Paul's practice blocks and a Mesa trainer runs the practice. Nothing
// on the site links here — coaches get the link directly.

type Range = { date: string; start: string; end: string };
type Mine = Range & { id: string; teamName: string };
type Coach = { name: string; phone: string; email: string };

const inputClass = "w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none";
const labelClass = "block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5";

function Header() {
  return (
    <div className="text-center mb-8">
      <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">ST. PAUL&apos;S TEAM PRACTICES</h1>
      <p className="text-brown-300 mt-2 text-sm max-w-md mx-auto">
        Have a Mesa Basketball trainer run your team&apos;s practice. ${STPAULS_PRICE} per 1-hour practice, paid in cash to your trainer at practice.
      </p>
    </div>
  );
}

function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "signup") {
      if (password !== confirm) return setError("Passwords do not match.");
      if (password.length < 6) return setError("Password must be at least 6 characters.");
    }
    setLoading(true);
    if (mode === "signin") {
      const { error: err } = await authClient.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (err) return setError(err.message.toLowerCase().includes("not confirmed") ? "Confirm your email first — check your inbox (and spam) for the link." : err.message);
      return onDone();
    }
    // Brings them back here after confirming their email (see auth/callback).
    try { localStorage.setItem("mesa_post_auth_next", STPAULS_PATH); } catch {}
    const { data, error: err } = await authClient.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: "https://www.mesabasketballtraining.com/auth/callback" },
    });
    setLoading(false);
    if (err) return setError(err.message);
    if (data.session) {
      try { localStorage.removeItem("mesa_post_auth_next"); } catch {}
      return onDone();
    }
    setCheckEmail(true);
  }

  if (checkEmail) {
    return (
      <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-6 py-8 text-center space-y-3">
        <h2 className="font-[family-name:var(--font-oswald)] text-2xl font-bold text-white">CHECK YOUR EMAIL</h2>
        <p className="text-brown-200 text-sm">We sent a confirmation link to <span className="text-white font-semibold">{email}</span>.</p>
        <p className="text-brown-400 text-sm">Click it, sign in, and you&apos;ll come right back to this page to pick your practice times.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="bg-brown-900/40 border border-brown-700 rounded-xl px-6 py-8 space-y-5">
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-brown-950/60 p-1">
        {(["signup", "signin"] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setError(""); }}
            className={`rounded-md py-2 text-sm font-semibold transition ${mode === m ? "bg-mesa-accent text-white" : "text-brown-300 hover:text-white"}`}>
            {m === "signup" ? "Create Account" : "Sign In"}
          </button>
        ))}
      </div>
      <p className="text-brown-300 text-sm text-center">
        {mode === "signup" ? "Create a coach account to book practices." : "Welcome back, coach."}
      </p>
      {error && <p className="text-red-400 text-sm text-center">{error}</p>}
      <div>
        <label className={labelClass}>Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="coach@email.com" />
      </div>
      <div>
        <label className={labelClass}>Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="••••••••" />
      </div>
      {mode === "signup" && (
        <div>
          <label className={labelClass}>Confirm Password</label>
          <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} placeholder="••••••••" />
        </div>
      )}
      {mode === "signin" && (
        <div className="flex justify-end -mt-2">
          <Link href="/forgot-password" className="text-xs text-brown-400 hover:text-mesa-accent">Forgot password?</Link>
        </div>
      )}
      <button type="submit" disabled={loading} className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50">
        {loading ? "One sec..." : mode === "signup" ? "Create Account" : "Sign In"}
      </button>
    </form>
  );
}

export default function StPaulsPracticesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [taken, setTaken] = useState<Range[]>([]);
  const [mine, setMine] = useState<Mine[]>([]);
  const [hasProfile, setHasProfile] = useState(false);
  const [month, setMonth] = useState(() => bookableRange().from.slice(0, 7)); // YYYY-MM
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedStart, setSelectedStart] = useState("");
  const [teamName, setTeamName] = useState("");
  const [coaches, setCoaches] = useState<Coach[]>([{ name: "", phone: "", email: "" }]);
  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async (s: Session) => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/stpauls", { headers: { Authorization: `Bearer ${s.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load practice times.");
      setTaken(data.taken);
      setMine(data.mine);
      setHasProfile(!!data.profile);
      // Prefill the first coach from the account, but never clobber typing.
      setCoaches((prev) => prev.length === 1 && !prev[0].name && !prev[0].phone && !prev[0].email
        ? [{ name: data.profile?.name || "", phone: data.profile?.phone || "", email: data.email || "" }]
        : prev);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load practice times.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    authClient.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthChecked(true);
      if (data.session) load(data.session);
    });
  }, [load]);

  async function afterAuth() {
    const { data } = await authClient.auth.getSession();
    setSession(data.session);
    if (data.session) load(data.session);
  }

  const range = useMemo(() => bookableRange(), []);
  const today = useMemo(() => nyNow(), []);

  // Start times on a date that are still open: inside the block, not
  // already started, and not overlapping any booked practice.
  const openTimes = useCallback((date: string) => {
    if (date < range.from || date > range.to) return [];
    return startTimesForDate(date).filter((t) =>
      (date !== today.date || toMinutes(t) > today.minutes) &&
      !taken.some((b) => b.date === date && overlaps(t, practiceEnd(t), b.start, b.end)));
  }, [range, today, taken]);

  // Month grid, Sunday-first, padded with blanks before the 1st.
  const monthCells = useMemo(() => {
    const first = `${month}-01`;
    const cells: (string | null)[] = Array(dayOfWeek(first)).fill(null);
    for (let d = first; d.startsWith(month); d = addDays(d, 1)) cells.push(d);
    return cells;
  }, [month]);
  const shiftMonth = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const canPrev = month > range.from.slice(0, 7);
  const canNext = month < range.to.slice(0, 7);

  function pickDate(date: string) {
    setSuccess(null);
    setSubmitError("");
    setSelectedDate(date);
    setSelectedStart("");
    setTimeout(() => document.getElementById("team-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !selectedDate) return;
    setSubmitError("");
    if (!selectedStart) return setSubmitError("Pick a start time.");
    setSubmitting(true);
    try {
      const res = await fetch("/api/stpauls", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ slots: [{ date: selectedDate, start: selectedStart }], teamName, coaches, smsConsent }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || "Couldn't book that practice.");
        if (res.status === 409) { setSelectedStart(""); load(session); }
      } else {
        setSuccess(`${formatDateLong(selectedDate)}, ${formatTime12(selectedStart)}–${formatTime12(practiceEnd(selectedStart))}`);
        setSelectedDate(null);
        setSelectedStart("");
        load(session);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {
      setSubmitError("Couldn't book that practice. Please try again.");
    }
    setSubmitting(false);
  }

  const updateCoach = (i: number, field: keyof Coach, value: string) =>
    setCoaches((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));

  return (
    <div className="min-h-screen bg-brown-950 text-white">
      <LandingNav />
      <main className="w-full max-w-2xl mx-auto px-4 sm:px-6 py-10">
        <Header />

        {!authChecked ? (
          <p className="text-center text-brown-400 text-sm">Loading...</p>
        ) : !session ? (
          <div className="max-w-md mx-auto"><AuthForm onDone={afterAuth} /></div>
        ) : (
          <div className="space-y-6">
            {success && (
              <div className="rounded-xl border border-green-600/60 bg-green-900/30 px-5 py-4">
                <p className="font-bold text-green-300">You&apos;re booked!</p>
                <p className="mt-1 text-sm text-green-100">{success}</p>
                <p className="mt-2 text-sm text-green-200">A Mesa trainer will run your practice. Bring ${STPAULS_PRICE} cash for your trainer.</p>
              </div>
            )}

            {mine.length > 0 && (
              <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-5 py-4">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-brown-400 mb-2">Your Booked Practices</h2>
                <ul className="space-y-1 text-sm text-white">
                  {mine.map((m) => (
                    <li key={m.id}>{formatDateShort(m.date)} · {formatTime12(m.start)}–{formatTime12(m.end)} · <span className="text-brown-300">{m.teamName}</span></li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-brown-400">Need to cancel or change one? Call or text Artemios at (631) 599-1280.</p>
              </div>
            )}

            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 sm:px-5 py-5">
              <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold text-white tracking-wide">1. PICK A DAY</h2>
              {loading && <p className="text-brown-400 text-sm mt-2">Loading times...</p>}
              {loadError && <p className="text-red-400 text-sm mt-2">{loadError}</p>}
              <div className="mt-4 flex items-center justify-between">
                <button type="button" disabled={!canPrev} onClick={() => shiftMonth(-1)}
                  className="rounded-lg border border-brown-700 px-3 py-1.5 text-brown-200 hover:text-white disabled:opacity-30">←</button>
                <p className="font-semibold text-white">
                  {new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}
                </p>
                <button type="button" disabled={!canNext} onClick={() => shiftMonth(1)}
                  className="rounded-lg border border-brown-700 px-3 py-1.5 text-brown-200 hover:text-white disabled:opacity-30">→</button>
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1 text-center">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <p key={i} className="py-1 text-xs font-semibold text-brown-500">{d}</p>
                ))}
                {monthCells.map((d, i) => {
                  if (!d) return <div key={`b${i}`} />;
                  const isPracticeDay = startTimesForDate(d).length > 0 && d >= range.from && d <= range.to && (d > today.date || (d === today.date && startTimesForDate(d).some((t) => toMinutes(t) > today.minutes)));
                  const open = isPracticeDay && openTimes(d).length > 0;
                  const hasMine = mine.some((m) => m.date === d);
                  const isSelected = d === selectedDate;
                  const cls = isSelected
                    ? "bg-mesa-accent text-white font-bold shadow-lg shadow-mesa-accent/30"
                    : open
                    ? "bg-brown-800 text-white hover:bg-brown-700 font-semibold"
                    : isPracticeDay
                    ? "bg-brown-900 text-brown-500 line-through"
                    : "text-brown-700";
                  return (
                    <button key={d} type="button" disabled={!open} onClick={() => pickDate(d)}
                      className={`relative h-11 sm:h-12 rounded-lg text-sm transition ${cls} ${d === today.date && !isSelected ? "ring-1 ring-mesa-accent/60" : ""}`}>
                      {Number(d.slice(8))}
                      {hasMine && <span className={`absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${isSelected ? "bg-white" : "bg-green-400"}`} />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-brown-400">
                <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded bg-brown-800" /> Open</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded bg-brown-900 border border-brown-700" /> Full</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" /> Your practice</span>
              </div>
            </div>

            {selectedDate && (
              <form id="team-form" onSubmit={submit} className="scroll-mt-24 rounded-xl border border-mesa-accent/60 bg-brown-900/40 px-5 py-5 space-y-5">
                <div>
                  <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold text-white tracking-wide">2. {formatDateLong(selectedDate).toUpperCase()}</h2>
                  <label className={`${labelClass} mt-4`}>Start Time (1-hour practice)</label>
                  <select required value={selectedStart} onChange={(e) => setSelectedStart(e.target.value)} className={inputClass}>
                    <option value="">Select a time</option>
                    {openTimes(selectedDate).map((t) => (
                      <option key={t} value={t}>{formatTime12(t)} – {formatTime12(practiceEnd(t))}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Team Name</label>
                  <input required value={teamName} onChange={(e) => setTeamName(e.target.value)} className={inputClass} placeholder="e.g. St. Paul's 7th Grade Boys" />
                </div>
                {coaches.map((c, i) => (
                  <div key={i} className="rounded-lg border border-brown-800 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-white">{i === 0 ? "Head Coach" : `Coach ${i + 1}`}</p>
                      {i > 0 && (
                        <button type="button" onClick={() => setCoaches((prev) => prev.filter((_, idx) => idx !== i))} className="text-xs text-brown-400 hover:text-red-400">Remove</button>
                      )}
                    </div>
                    <input required value={c.name} onChange={(e) => updateCoach(i, "name", e.target.value)} className={inputClass} placeholder="Full name" />
                    <input required type="tel" value={c.phone} onChange={(e) => updateCoach(i, "phone", e.target.value)} className={inputClass} placeholder="Phone" />
                    <input required type="email" value={c.email} onChange={(e) => updateCoach(i, "email", e.target.value)} className={inputClass} placeholder="Email" />
                  </div>
                ))}
                {coaches.length < 6 && (
                  <button type="button" onClick={() => setCoaches((prev) => [...prev, { name: "", phone: "", email: "" }])}
                    className="text-sm font-semibold text-mesa-accent hover:underline">+ Add another coach</button>
                )}
                {!hasProfile && (
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={smsConsent} onChange={(e) => setSmsConsent(e.target.checked)} className="mt-1 h-4 w-4 accent-mesa-accent" />
                    <span className="text-xs text-brown-300 leading-relaxed">
                      Text me a weekly reminder to book my team&apos;s practices (Mesa Basketball Training, about once a week). Message &amp; data rates may apply. Reply STOP to cancel, HELP for help.
                    </span>
                  </label>
                )}
                <div className="rounded-lg bg-brown-950/60 px-4 py-3 text-sm text-brown-200">
                  <p>${STPAULS_PRICE}, paid in cash to your trainer at practice.</p>
                  <p className="mt-1 text-xs text-brown-400">Any available Mesa trainer may run your practice. Practices can&apos;t be cancelled online — call or text Artemios at (631) 599-1280.</p>
                </div>
                {submitError && <p className="text-red-400 text-sm">{submitError}</p>}
                <button type="submit" disabled={submitting || !selectedStart}
                  className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50">
                  {submitting ? "Booking..." : "Book Practice"}
                </button>
              </form>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
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
            <a href="/my-bookings" className="text-sm text-mesa-accent hover:text-yellow-300">
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
    </div>
  );
}
