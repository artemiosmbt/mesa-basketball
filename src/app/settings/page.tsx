"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";

const ALL_GRADES = [
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "1st Grade" }, { value: "2", label: "2nd Grade" },
  { value: "3", label: "3rd Grade" }, { value: "4", label: "4th Grade" },
  { value: "5", label: "5th Grade" }, { value: "6", label: "6th Grade" },
  { value: "7", label: "7th Grade" }, { value: "8", label: "8th Grade" },
  { value: "9", label: "9th Grade" }, { value: "10", label: "10th Grade" },
  { value: "11", label: "11th Grade" }, { value: "12", label: "12th Grade" },
  { value: "Other", label: "Other" },
  { value: "College +", label: "College / Pro" },
  { value: "Adult", label: "Adult" },
];

interface Kid {
  name: string;
  dob: string;
  grade: string;
  gender?: string;
}

// Convert YYYY-MM-DD (old date input format) → MM/DD/YYYY
function normalizeDob(dob: string): string {
  const iso = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return dob;
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
    <div className="flex items-center w-full rounded-lg border border-brown-700 bg-brown-800/60 text-sm text-white focus-within:border-mesa-accent pl-3">
      <input type="text" inputMode="numeric" maxLength={2} placeholder="MM" value={mm}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(v, dd, yyyy)); if (v.length === 2) ddRef.current?.focus(); }}
        className="w-10 bg-transparent pr-1 py-2 text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={ddRef} type="text" inputMode="numeric" maxLength={2} placeholder="DD" value={dd}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(mm, v, yyyy)); if (v.length === 2) yyyyRef.current?.focus(); }}
        className="w-10 bg-transparent px-1 py-2 text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={yyyyRef} type="text" inputMode="numeric" maxLength={4} placeholder="YYYY" value={yyyy}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); onChange(buildDob(mm, dd, v)); }}
        className="w-16 bg-transparent px-1 py-2 text-center placeholder-brown-500 focus:outline-none" />
    </div>
  );
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [userEmail, setUserEmail] = useState("");

  const [parentName, setParentName] = useState("");
  const [phone, setPhone] = useState("");
  const [kids, setKids] = useState<Kid[]>([{ name: "", dob: "", grade: "" }]);
  const [marketingEmails, setMarketingEmails] = useState(true);
  const [smsConsent, setSmsConsent] = useState(true);
  const [videoConsent, setVideoConsent] = useState(true);
  const [referralCode, setReferralCode] = useState("");
  const [referralCodeError, setReferralCodeError] = useState("");

  const router = useRouter();

  useEffect(() => {
    authClient.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.push("/login?next=/settings");
        return;
      }
      setUserEmail(session.user.email ?? "");
      const res = await fetch("/api/profile", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.parent_name) setParentName(data.parent_name);
        if (data.phone) setPhone(data.phone);
        if (data.kids && Array.isArray(data.kids) && data.kids.length > 0) {
          setKids(data.kids.map((k: Kid) => ({ ...k, dob: normalizeDob(k.dob) })));
        }
        if (typeof data.marketing_emails === "boolean") {
          setMarketingEmails(data.marketing_emails);
        }
        if (typeof data.sms_consent === "boolean") {
          setSmsConsent(data.sms_consent);
        }
        if (typeof data.video_consent === "boolean") {
          setVideoConsent(data.video_consent);
        }
        if (data.referral_code) setReferralCode(data.referral_code);
      }
      setLoading(false);
    });
  }, [router]);

  function addKid() {
    setKids((prev) => [...prev, { name: "", dob: "", grade: "", gender: "" }]);
  }

  function removeKid(i: number) {
    setKids((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateKid(i: number, field: string, value: string) {
    setKids((prev) => prev.map((k, idx) => idx === i ? { ...k, [field]: value } : k));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");

    const { data: { session } } = await authClient.auth.getSession();
    if (!session) { router.push("/login?next=/settings"); return; }

    setReferralCodeError("");
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ parentName, phone, kids, marketingEmails, smsConsent, videoConsent, referralCode: referralCode.trim() || undefined }),
    });

    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      const data = await res.json();
      if (res.status === 409) {
        setReferralCodeError(data.error || "That referral code is already taken.");
      } else {
        setError("Failed to save. Please try again.");
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center">
        <p className="text-brown-400 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brown-950 px-4 sm:px-6 py-12">
      <div className="mx-auto max-w-lg">
        {/* Back links */}
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm text-mesa-accent hover:text-yellow-300">
            &larr; Back to Home
          </Link>
          <span className="text-brown-700">|</span>
          <Link href="/my-bookings" className="text-sm text-mesa-accent hover:text-yellow-300">
            My Bookings
          </Link>
        </div>

        <div className="mt-6 mb-8">
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">
            ACCOUNT SETTINGS
          </h1>
          <p className="text-brown-400 text-sm mt-1">{userEmail}</p>
        </div>

        <form onSubmit={handleSave} className="space-y-8">

          {/* Contact Info */}
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-6 py-6 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Contact Info</h2>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">
                Parent / Guardian Name
              </label>
              <input
                type="text"
                value={parentName}
                onChange={(e) => setParentName(e.target.value)}
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="Full name"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">
                Phone
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                placeholder="(555) 555-5555"
              />
            </div>
          </div>

          {/* Athletes */}
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-6 py-6 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Athletes</h2>
            <div className="divide-y divide-brown-700 rounded-lg border border-brown-700 overflow-hidden">
              {kids.map((kid, i) => (
                <div key={i} className="bg-brown-800/30 px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-brown-400 font-medium">Athlete {i + 1}</span>
                    {kids.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeKid(i)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
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
                        value={kid.gender || ""}
                        onChange={(e) => updateKid(i, "gender", e.target.value)}
                        className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                      >
                        <option value="">Select gender...</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addKid}
              className="text-xs text-mesa-accent hover:underline"
            >
              + Add another athlete
            </button>
          </div>

          {/* Referral Code — admin only */}
          {userEmail === "artemios@mesabasketballtraining.com" && (
            <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-6 py-6 space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Referral Code</h2>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Your Code</label>
                <input
                  type="text"
                  value={referralCode}
                  onChange={(e) => { setReferralCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "")); setReferralCodeError(""); }}
                  placeholder="Auto-generated on first save"
                  className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none font-mono tracking-wider"
                />
                {referralCodeError && <p className="mt-1 text-xs text-red-400">{referralCodeError}</p>}
                <p className="mt-1 text-xs text-brown-600">Letters, numbers, and hyphens only. Leave blank to keep your current code.</p>
              </div>
            </div>
          )}

          {/* Preferences */}
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-4 sm:px-6 py-6 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Preferences</h2>

            <label className="flex items-start gap-3 cursor-pointer">
              <div className="mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  checked={smsConsent}
                  onChange={(e) => setSmsConsent(e.target.checked)}
                  className="h-4 w-4 rounded border-brown-600 bg-brown-800 accent-mesa-accent cursor-pointer"
                />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Text message reminders</p>
                <p className="text-xs text-brown-400 mt-0.5 leading-relaxed">
                  Receive text message reminders about upcoming sessions. Reply STOP at any time to opt out.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <div className="mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  checked={marketingEmails}
                  onChange={(e) => setMarketingEmails(e.target.checked)}
                  className="h-4 w-4 rounded border-brown-600 bg-brown-800 accent-mesa-accent cursor-pointer"
                />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Marketing emails</p>
                <p className="text-xs text-brown-400 mt-0.5 leading-relaxed">
                  Receive emails about new sessions, camps, promotions, and updates from Mesa Basketball Training.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <div className="mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  checked={videoConsent}
                  onChange={(e) => setVideoConsent(e.target.checked)}
                  className="h-4 w-4 rounded border-brown-600 bg-brown-800 accent-mesa-accent cursor-pointer"
                />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Photo & video consent</p>
                <p className="text-xs text-brown-400 mt-0.5 leading-relaxed">
                  Allow Mesa Basketball Training to photograph or film my athlete during sessions for use in promotional materials, including social media.
                </p>
              </div>
            </label>
          </div>

          {/* Save */}
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
          </button>
        </form>
      </div>
    </div>
  );
}
