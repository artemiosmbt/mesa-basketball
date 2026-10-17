"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { authClient } from "@/lib/auth";
import {
  addDays,
  bookableRange,
  formatDateLong,
  formatDateShort,
  formatTime12,
  nyNow,
  overlaps,
  practiceEnd,
  startTimesForDate,
  STPAULS_PATH,
  STPAULS_PRICE,
  toMinutes,
  weekStart,
} from "@/lib/stpauls";

// Unlisted coach page: church teams pick 1-hour practice times inside the
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
      <div className="h-24 w-24 mx-auto mb-4 rounded-full bg-white overflow-hidden flex items-center justify-center">
        <img src="/logo.png" alt="Mesa Basketball" className="h-24 w-24 object-contain scale-125" />
      </div>
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
  const [selected, setSelected] = useState<{ date: string; start: string }[]>([]);
  const [teamName, setTeamName] = useState("");
  const [coaches, setCoaches] = useState<Coach[]>([{ name: "", phone: "", email: "" }]);
  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [success, setSuccess] = useState<string[] | null>(null);

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

  // Weeks (Mon–Sun) from the first bookable date to the last, each with
  // its practice days and every 1-hour start time.
  const weeks = useMemo(() => {
    const { from, to } = bookableRange();
    const now = nyNow();
    const out: { start: string; days: { date: string; times: string[] }[] }[] = [];
    for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
      const days: { date: string; times: string[] }[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(ws, i);
        if (date < from || date > to) continue;
        const times = startTimesForDate(date).filter((t) => date !== now.date || toMinutes(t) > now.minutes);
        if (times.length) days.push({ date, times });
      }
      if (days.length) out.push({ start: ws, days });
    }
    return out;
  }, []);

  function slotState(date: string, start: string): "mine" | "taken" | "selected" | "blocked" | "open" {
    const end = practiceEnd(start);
    if (mine.some((m) => m.date === date && m.start === start)) return "mine";
    if (taken.some((t) => t.date === date && overlaps(start, end, t.start, t.end))) return "taken";
    if (selected.some((s) => s.date === date && s.start === start)) return "selected";
    if (selected.some((s) => s.date === date && overlaps(start, end, s.start, practiceEnd(s.start)))) return "blocked";
    return "open";
  }

  function toggle(date: string, start: string) {
    setSuccess(null);
    setSelected((prev) => prev.some((s) => s.date === date && s.start === start)
      ? prev.filter((s) => !(s.date === date && s.start === start))
      : [...prev, { date, start }]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setSubmitError("");
    if (selected.length === 0) return setSubmitError("Pick at least one practice time above.");
    setSubmitting(true);
    try {
      const res = await fetch("/api/stpauls", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ slots: selected, teamName, coaches, smsConsent }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || "Couldn't book those practices.");
        if (res.status === 409) { setSelected([]); load(session); }
      } else {
        const sorted = [...selected].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        setSuccess(sorted.map((s) => `${formatDateLong(s.date)}, ${formatTime12(s.start)}–${formatTime12(practiceEnd(s.start))}`));
        setSelected([]);
        load(session);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {
      setSubmitError("Couldn't book those practices. Please try again.");
    }
    setSubmitting(false);
  }

  const updateCoach = (i: number, field: keyof Coach, value: string) =>
    setCoaches((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));

  return (
    <div className="min-h-screen bg-brown-950 px-4 sm:px-6 pt-10 pb-24">
      <div className="w-full max-w-2xl mx-auto">
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
                <ul className="mt-1 text-sm text-green-100">{success.map((s) => <li key={s}>{s}</li>)}</ul>
                <p className="mt-2 text-sm text-green-200">A Mesa trainer will run your practice. Bring ${STPAULS_PRICE} cash per practice for your trainer.</p>
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

            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-5 py-5">
              <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold text-white tracking-wide">1. PICK YOUR PRACTICE TIMES</h2>
              <p className="text-brown-400 text-sm mt-1">Each practice is 1 hour. Tap every time you want — you can pick more than one.</p>
              {loading && <p className="text-brown-400 text-sm mt-3">Loading times...</p>}
              {loadError && <p className="text-red-400 text-sm mt-3">{loadError}</p>}
              <div className="mt-4 space-y-6">
                {weeks.map((w) => (
                  <div key={w.start}>
                    <p className="text-xs font-semibold uppercase tracking-widest text-mesa-accent mb-2">Week of {formatDateShort(w.start)}</p>
                    <div className="space-y-3">
                      {w.days.map((d) => (
                        <div key={d.date}>
                          <p className="text-sm font-semibold text-white mb-1.5">{formatDateShort(d.date)}</p>
                          <div className="flex flex-wrap gap-2">
                            {d.times.map((t) => {
                              const st = slotState(d.date, t);
                              const label = `${formatTime12(t)}–${formatTime12(practiceEnd(t))}`;
                              const cls = {
                                open: "border-brown-600 text-brown-100 hover:border-mesa-accent",
                                selected: "border-mesa-accent bg-mesa-accent text-white",
                                taken: "border-brown-800 text-brown-600 line-through cursor-not-allowed",
                                blocked: "border-brown-800 text-brown-600 cursor-not-allowed",
                                mine: "border-green-600 bg-green-900/40 text-green-200 cursor-default",
                              }[st];
                              return (
                                <button key={t} type="button" disabled={st !== "open" && st !== "selected"} onClick={() => toggle(d.date, t)}
                                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${cls}`}>
                                  {label}{st === "mine" ? " ✓" : ""}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <form id="team-form" onSubmit={submit} className="rounded-xl border border-brown-700 bg-brown-900/40 px-5 py-5 space-y-5">
              <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold text-white tracking-wide">2. YOUR TEAM</h2>
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
                <p><span className="font-semibold text-white">{selected.length}</span> practice{selected.length === 1 ? "" : "s"} selected · ${STPAULS_PRICE} each, cash to your trainer at practice.</p>
                <p className="mt-1 text-xs text-brown-400">Any available Mesa trainer may run your practice. Practices can&apos;t be cancelled online — call or text Artemios at (631) 599-1280.</p>
              </div>
              {submitError && <p className="text-red-400 text-sm">{submitError}</p>}
              <button type="submit" disabled={submitting || selected.length === 0}
                className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50">
                {submitting ? "Booking..." : `Book ${selected.length || ""} Practice${selected.length === 1 ? "" : "s"}`}
              </button>
            </form>
          </div>
        )}
      </div>
      {session && selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-brown-700 bg-brown-950/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <p className="text-sm text-white">{selected.length} practice{selected.length === 1 ? "" : "s"} selected</p>
            <button type="button" onClick={() => document.getElementById("team-form")?.scrollIntoView({ behavior: "smooth" })}
              className="rounded-lg bg-mesa-accent px-4 py-2 text-sm font-bold text-white hover:bg-mesa-accent/90">
              Continue to Team Info ↓
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
