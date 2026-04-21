"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";

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
function DobInput({ value, onChange, required, inputClass }: {
  value: string; onChange: (v: string) => void; required?: boolean; inputClass?: string;
}) {
  const [mm, dd, yyyy] = parseDob(value);
  const ddRef = useRef<HTMLInputElement>(null);
  const yyyyRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`flex items-center w-full rounded-lg border border-brown-700 text-sm text-white focus-within:border-mesa-accent pl-3 ${inputClass || "bg-brown-800/60"}`}>
      <input type="text" inputMode="numeric" maxLength={2} placeholder="MM" value={mm} required={required}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(v, dd, yyyy)); if (v.length === 2) ddRef.current?.focus(); }}
        className="w-10 bg-transparent pr-1 py-2 text-white text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={ddRef} type="text" inputMode="numeric" maxLength={2} placeholder="DD" value={dd}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(mm, v, yyyy)); if (v.length === 2) yyyyRef.current?.focus(); }}
        className="w-10 bg-transparent px-1 py-2 text-white text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={yyyyRef} type="text" inputMode="numeric" maxLength={4} placeholder="YYYY" value={yyyy}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); onChange(buildDob(mm, dd, v)); }}
        className="w-16 bg-transparent px-1 py-2 text-white text-center placeholder-brown-500 focus:outline-none" />
    </div>
  );
}

const ALL_GRADES = [
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "1st Grade" }, { value: "2", label: "2nd Grade" },
  { value: "3", label: "3rd Grade" }, { value: "4", label: "4th Grade" },
  { value: "5", label: "5th Grade" }, { value: "6", label: "6th Grade" },
  { value: "7", label: "7th Grade" }, { value: "8", label: "8th Grade" },
  { value: "9", label: "9th Grade" }, { value: "10", label: "10th Grade" },
  { value: "11", label: "11th Grade" }, { value: "12", label: "12th Grade" },
  { value: "College +", label: "College / Pro" },
  { value: "Adult", label: "Adult" },
];

export default function SignupPage() {
  const [parentName, setParentName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [kids, setKids] = useState([{ name: "", dob: "", grade: "", gender: "" }]);
  const [smsConsent, setSmsConsent] = useState(false);
  const [marketingEmails, setMarketingEmails] = useState(true);
  const [videoConsent, setVideoConsent] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [resendStatus, setResendStatus] = useState("");
  const router = useRouter();

  function addKid() {
    setKids((prev) => [...prev, { name: "", dob: "", grade: "", gender: "" }]);
  }

  function removeKid(i: number) {
    setKids((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateKid(i: number, field: string, value: string) {
    setKids((prev) => prev.map((k, idx) => idx === i ? { ...k, [field]: value } : k));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);

    const { data, error: signUpError } = await authClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: "https://www.mesabasketballtraining.com/auth/callback",
      },
    });
    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    // Save profile right away using the session
    const session = data.session;
    if (session) {
      await fetch("/api/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ parentName, phone, kids, smsConsent, marketingEmails, videoConsent }),
      });
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next || "/");
    } else {
      // Email confirmation required — stash profile data so login page can save it after confirm
      localStorage.setItem("mesa_pending_profile", JSON.stringify({ parentName, phone, kids, smsConsent, marketingEmails, videoConsent }));
      setConfirmed(true);
      setLoading(false);
    }
  }

  async function handleResend() {
    setResendStatus("sending");
    const { error } = await authClient.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: "https://www.mesabasketballtraining.com/auth/callback" },
    });
    setResendStatus(error ? "error" : "sent");
  }

  if (confirmed) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center px-4 sm:px-6 py-12">
        <div className="w-full max-w-md text-center">
          <div className="h-28 w-28 mx-auto mb-6 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide mb-4">CHECK YOUR EMAIL</h1>
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-8 py-8 space-y-4">
            <p className="text-brown-200 text-base leading-relaxed">
              A confirmation email has been sent to <span className="text-white font-semibold">{email}</span>.
            </p>
            <p className="text-brown-400 text-sm leading-relaxed">
              Click the link in the email to confirm your account before signing in. Check your spam folder if you don&apos;t see it within a minute.
            </p>
            <a
              href="/login"
              className="block w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition text-center mt-2"
            >
              Go to Login
            </a>
            <button
              onClick={handleResend}
              disabled={resendStatus === "sending" || resendStatus === "sent"}
              className="block w-full text-sm text-brown-400 hover:text-white transition disabled:opacity-50"
            >
              {resendStatus === "sending" ? "Sending..." : resendStatus === "sent" ? "Email resent!" : resendStatus === "error" ? "Failed to resend — try again" : "Didn't get it? Resend email"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brown-950 flex items-center justify-center px-4 sm:px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="h-28 w-28 mx-auto mb-4 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">CREATE ACCOUNT</h1>
          <p className="text-brown-400 mt-1 text-sm">Save your info and book faster every time</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-8 py-6 sm:py-8 space-y-5">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Parent / Guardian Name</label>
              <input
                type="text"
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
                required
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="Full name"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="parent@email.com"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="(555) 555-5555"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="Min. 6 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-brown-400 mb-3">Athletes</p>
            <div className="divide-y divide-brown-700 rounded-lg border border-brown-700 overflow-hidden">
              {kids.map((kid, i) => (
                <div key={i} className="bg-brown-800/30 px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-brown-400 font-medium">Athlete {i + 1}</span>
                    {kids.length > 1 && (
                      <button type="button" onClick={() => removeKid(i)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Name</label>
                      <input
                        type="text"
                        value={kid.name}
                        onChange={(e) => updateKid(i, "name", e.target.value)}
                        placeholder="Player's full name"
                        className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-3 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Date of Birth</label>
                      <DobInput value={kid.dob} onChange={(v) => updateKid(i, "dob", v)} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Grade</label>
                      <select
                        value={kid.grade}
                        onChange={(e) => updateKid(i, "grade", e.target.value)}
                        className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                      >
                        <option value="">Select grade...</option>
                        {ALL_GRADES.map((g) => (
                          <option key={g.value} value={g.value}>{g.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-brown-400">Gender</label>
                      <select
                        value={kid.gender}
                        onChange={(e) => updateKid(i, "gender", e.target.value)}
                        className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                      >
                        <option value="">Select gender...</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addKid}
              className="mt-2 text-xs text-mesa-accent hover:underline"
            >
              + Add another athlete
            </button>
          </div>

          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={smsConsent}
                onChange={(e) => setSmsConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-brown-600 accent-mesa-accent"
              />
              <span className="text-xs text-brown-400 leading-relaxed">
                I agree to receive SMS text messages from Mesa Basketball Training (program name: Mesa Basketball Training) including session reminders, schedule updates, and booking confirmations. Message frequency varies (approx. weekly). Message &amp; data rates may apply. Reply STOP to cancel, HELP for help. See our{" "}
                <a href="/terms" className="underline hover:text-mesa-accent">Terms</a>{" "}and{" "}
                <a href="/privacy-policy" className="underline hover:text-mesa-accent">Privacy Policy</a>.
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={marketingEmails}
                onChange={(e) => setMarketingEmails(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-brown-600 accent-mesa-accent"
              />
              <span className="text-xs text-brown-400 leading-relaxed">
                I agree to receive emails about new sessions, camps, promotions, and updates from Mesa Basketball Training.
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={videoConsent}
                onChange={(e) => setVideoConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-brown-600 accent-mesa-accent"
              />
              <span className="text-xs text-brown-400 leading-relaxed">
                I consent to Mesa Basketball Training photographing or filming my athlete during training sessions for use in promotional materials, including social media.
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50"
          >
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>
        <p className="text-center text-brown-400 mt-6 text-sm">
          Already have an account?{" "}
          <Link href="/login" className="text-mesa-accent hover:underline">Sign in</Link>
        </p>
        <p className="text-center mt-3">
          <Link href="/" className="text-brown-500 hover:text-brown-300 text-xs">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}
