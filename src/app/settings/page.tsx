"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";
import { ALL_GRADES, type CanonicalGroupId } from "@/lib/athletes";

interface Kid {
  id?: string;
  name: string;
  dob: string;
  grade: string;
  gender?: string;
  groups?: CanonicalGroupId[];
}

// Convert YYYY-MM-DD (old date input format) → MM/DD/YYYY
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

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
    <div className="flex items-center w-full rounded-lg border border-mesa-accent/40 bg-brown-800/60 text-sm text-white focus-within:border-mesa-accent pl-3">
      <input type="text" inputMode="numeric" maxLength={2} placeholder="MM" value={mm}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(v, dd, yyyy)); if (v.length === 2) ddRef.current?.focus(); }}
        onClick={(e) => e.stopPropagation()}
        className="w-10 bg-transparent pr-1 py-2 text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={ddRef} type="text" inputMode="numeric" maxLength={2} placeholder="DD" value={dd}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); onChange(buildDob(mm, v, yyyy)); if (v.length === 2) yyyyRef.current?.focus(); }}
        onClick={(e) => e.stopPropagation()}
        className="w-10 bg-transparent px-1 py-2 text-center placeholder-brown-500 focus:outline-none" />
      <span className="text-brown-500 select-none">/</span>
      <input ref={yyyyRef} type="text" inputMode="numeric" maxLength={4} placeholder="YYYY" value={yyyy}
        onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); onChange(buildDob(mm, dd, v)); }}
        onClick={(e) => e.stopPropagation()}
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

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const parentName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
  const [phone, setPhone] = useState("");
  const [kids, setKids] = useState<Kid[]>([{ name: "", dob: "", grade: "" }]);
  const [marketingEmails, setMarketingEmails] = useState(true);
  const [smsConsent, setSmsConsent] = useState(true);
  const [videoConsent, setVideoConsent] = useState(true);
  const [reminderEmails, setReminderEmails] = useState(true);
  const [referralCode, setReferralCode] = useState("");
  const [referralCodeError, setReferralCodeError] = useState("");

  // Athlete bubble collapse/expand + delete-confirm state, matching the
  // registration form's pattern (schedule/page.tsx).
  const [expandedKids, setExpandedKids] = useState<Set<number>>(new Set());
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

  // Snapshot of everything handleSave persists, taken right after the
  // initial load — used to detect unsaved changes so navigating away can
  // warn before silently discarding edits.
  const initialSnapshotRef = useRef<string | null>(null);
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);

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
        const nameSplit = splitName(data.parent_name || "");
        if (nameSplit.first) setFirstName(nameSplit.first);
        if (nameSplit.last) setLastName(nameSplit.last);
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
        if (typeof data.reminder_emails === "boolean") {
          setReminderEmails(data.reminder_emails);
        }
        if (data.referral_code) setReferralCode(data.referral_code);
      }
      setLoading(false);
    });
  }, [router]);

  // Snapshot taken once loading finishes, after every load-time setter above
  // has had a chance to run — captures the actually-loaded values, not the
  // component's initial defaults.
  useEffect(() => {
    if (!loading && initialSnapshotRef.current === null) {
      initialSnapshotRef.current = JSON.stringify({ parentName, phone, kids, marketingEmails, smsConsent, videoConsent, reminderEmails, referralCode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const hasUnsavedChanges = useMemo(() => {
    if (initialSnapshotRef.current === null) return false;
    return JSON.stringify({ parentName, phone, kids, marketingEmails, smsConsent, videoConsent, reminderEmails, referralCode }) !== initialSnapshotRef.current;
  }, [parentName, phone, kids, marketingEmails, smsConsent, videoConsent, reminderEmails, referralCode]);

  // Intercepts a same-app link click — navigates immediately via the router
  // (keeping normal client-side nav speed) unless there are unsaved changes,
  // in which case the confirm modal decides what happens next.
  function handleNavClick(e: React.MouseEvent, href: string) {
    e.preventDefault();
    if (hasUnsavedChanges) {
      setPendingNavHref(href);
    } else {
      router.push(href);
    }
  }

  // Native fallback for the browser's own back/close/refresh — can't be
  // given custom buttons, but still stops an accidental loss of edits.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChanges) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  function addKid() {
    setKids((prev) => {
      setExpandedKids((s) => new Set(s).add(prev.length));
      return [...prev, { name: "", dob: "", grade: "", gender: "" }];
    });
  }

  function removeKid(i: number) {
    setKids((prev) => prev.filter((_, idx) => idx !== i));
    setExpandedKids((s) => {
      const next = new Set<number>();
      s.forEach((idx) => {
        if (idx < i) next.add(idx);
        else if (idx > i) next.add(idx - 1);
      });
      return next;
    });
    setConfirmDeleteIndex(null);
  }

  function toggleKidExpanded(i: number) {
    setExpandedKids((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Collapses (never re-expands) — used for "click anywhere on an expanded
  // card to close it" so it stays idempotent even if a click bubbles up
  // from more than one place at once.
  function collapseKid(i: number) {
    setExpandedKids((s) => {
      if (!s.has(i)) return s;
      const next = new Set(s);
      next.delete(i);
      return next;
    });
  }

  function updateKid(i: number, field: string, value: string) {
    setKids((prev) => prev.map((k, idx) => idx === i ? { ...k, [field]: value } : k));
  }

  // Returns whether the save succeeded — shared by the form's own Save
  // button and the unsaved-changes modal's "Save changes" option.
  async function performSave(): Promise<boolean> {
    setSaving(true);
    setSaved(false);
    setError("");

    const { data: { session } } = await authClient.auth.getSession();
    if (!session) { router.push("/login?next=/settings"); return false; }

    setReferralCodeError("");
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ parentName, phone, kids, marketingEmails, smsConsent, videoConsent, reminderEmails, referralCode: referralCode.trim() || undefined }),
    });

    setSaving(false);
    if (res.ok) {
      setSaved(true);
      initialSnapshotRef.current = JSON.stringify({ parentName, phone, kids, marketingEmails, smsConsent, videoConsent, reminderEmails, referralCode });
      setTimeout(() => setSaved(false), 3000);
      return true;
    }
    const data = await res.json();
    if (res.status === 409) {
      setReferralCodeError(data.error || "That referral code is already taken.");
    } else {
      setError("Failed to save. Please try again.");
    }
    return false;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await performSave();
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
          <Link href="/" onClick={(e) => handleNavClick(e, "/")} className="text-sm text-mesa-accent hover:text-yellow-300">
            &larr; Back to Home
          </Link>
          <span className="text-brown-700">|</span>
          <Link href="/my-bookings" onClick={(e) => handleNavClick(e, "/my-bookings")} className="text-sm text-mesa-accent hover:text-yellow-300">
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
          <div className="bg-brown-900/40 border-2 border-brown-600 rounded-xl shadow-lg shadow-black/30 px-4 sm:px-6 py-6 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Contact Info</h2>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">
                Parent / Guardian Name
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                  placeholder="First name"
                />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
                  placeholder="Last name"
                />
              </div>
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
          <div className="bg-brown-900/40 border-2 border-brown-600 rounded-xl shadow-lg shadow-black/30 px-4 sm:px-6 py-6 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-mesa-accent">Athletes</h2>
            <div className="space-y-3">
              {kids.map((kid, i) => {
                const isExpanded = expandedKids.has(i) || !kid.name;
                const isConfirmingDelete = confirmDeleteIndex === i;
                return (
                  <div key={i} className="flex flex-col gap-2">
                    {isConfirmingDelete ? (
                      <div className="rounded-lg border-2 border-red-700/60 bg-red-900/10 p-3 shadow-lg shadow-black/30 space-y-2.5">
                        <p className="text-sm text-brown-200">
                          Delete <span className="font-semibold text-white">{kid.name || "this athlete"}</span>? This can&apos;t be undone.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => removeKid(i)}
                            className="rounded bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600"
                          >
                            Delete Athlete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteIndex(null)}
                            className="rounded bg-brown-700 px-3 py-1.5 text-xs text-brown-300 hover:bg-brown-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : isExpanded ? (
                      <div
                        onClick={() => collapseKid(i)}
                        className="rounded-lg border-2 border-mesa-accent bg-brown-800 p-3 shadow-lg shadow-black/30 space-y-2 cursor-pointer"
                      >
                        {kids.length > 1 && (
                          <div className="flex justify-end -mt-1 -mr-1">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteIndex(i); }}
                              className="flex h-7 w-7 items-center justify-center rounded-full text-brown-300 hover:bg-brown-900 hover:text-red-400 text-xl leading-none"
                            >
                              &times;
                            </button>
                          </div>
                        )}
                        <div className="space-y-2">
                          <div>
                            <label className="mb-1 block text-xs text-brown-400">Name</label>
                            <input
                              type="text"
                              value={kid.name}
                              onChange={(e) => updateKid(i, "name", e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="Player's full name"
                              className="w-full rounded-lg border border-mesa-accent/40 bg-brown-800/60 px-3 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
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
                              onClick={(e) => e.stopPropagation()}
                              className="w-full rounded-lg border border-mesa-accent/40 bg-brown-800/60 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
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
                              onClick={(e) => e.stopPropagation()}
                              className="w-full rounded-lg border border-mesa-accent/40 bg-brown-800/60 px-3 py-2 text-sm text-white focus:border-mesa-accent focus:outline-none"
                            >
                              <option value="">Select gender...</option>
                              <option value="male">Male</option>
                              <option value="female">Female</option>
                            </select>
                          </div>
                        </div>
                        {kid.name && (
                          <div className="flex justify-end pt-1">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleKidExpanded(i); }}
                              className="rounded bg-mesa-accent px-4 py-1.5 text-xs font-semibold text-white hover:bg-yellow-600 transition"
                            >
                              Save Changes
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => toggleKidExpanded(i)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-full border-2 border-mesa-accent bg-brown-800 py-1.5 pl-4 pr-2 text-sm text-white shadow-lg shadow-black/30 hover:bg-brown-700 transition"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-mesa-accent shrink-0">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                          <span className="truncate font-medium">{kid.name || "Player"}</span>
                          {kid.grade && <span className="shrink-0 text-brown-300 text-xs">Grade {kid.grade}</span>}
                        </button>
                        {kids.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteIndex(i)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-brown-300 hover:bg-brown-900 hover:text-red-400 text-xl leading-none"
                          >
                            &times;
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
            <div className="bg-brown-900/40 border-2 border-brown-600 rounded-xl shadow-lg shadow-black/30 px-4 sm:px-6 py-6 space-y-3">
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
          <div className="bg-brown-900/40 border-2 border-brown-600 rounded-xl shadow-lg shadow-black/30 px-4 sm:px-6 py-6 space-y-4">
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
                {smsConsent && (
                  <p className="text-xs text-yellow-500/80 mt-1 leading-relaxed">
                    If you previously opted out by replying STOP, text START to our number to re-enable delivery.
                  </p>
                )}
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

            <label className="flex items-start gap-3 cursor-pointer">
              <div className="mt-0.5 shrink-0">
                <input
                  type="checkbox"
                  checked={reminderEmails}
                  onChange={(e) => setReminderEmails(e.target.checked)}
                  className="h-4 w-4 rounded border-brown-600 bg-brown-800 accent-mesa-accent cursor-pointer"
                />
              </div>
              <div>
                <p className="text-sm text-white font-medium">Reminder emails</p>
                <p className="text-xs text-brown-400 mt-0.5 leading-relaxed">
                  Get a heads up on days your athlete has a group session coming up, even if you haven&apos;t booked it yet.
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

      {/* Unsaved changes — confirm before leaving without saving */}
      {pendingNavHref !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-brown-900 border border-brown-700 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Unsaved Changes</h3>
            <p className="mt-2 text-sm text-brown-300">
              You have changes that haven&apos;t been saved yet. If you leave now, they&apos;ll be lost.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  const ok = await performSave();
                  const href = pendingNavHref;
                  if (ok && href) {
                    setPendingNavHref(null);
                    router.push(href);
                  }
                }}
                className="w-full rounded-lg bg-mesa-accent py-2.5 font-semibold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const href = pendingNavHref;
                  setPendingNavHref(null);
                  if (href) router.push(href);
                }}
                className="w-full rounded-lg bg-brown-800 py-2.5 text-sm text-brown-300 hover:bg-brown-700 transition"
              >
                Continue Without Saving
              </button>
              <button
                type="button"
                onClick={() => setPendingNavHref(null)}
                className="w-full py-1 text-xs text-brown-500 hover:text-brown-400 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
