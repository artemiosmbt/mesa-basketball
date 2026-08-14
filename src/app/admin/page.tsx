"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, resolveAuthRole, TRAINER_ACCOUNTS, type AuthContext } from "@/lib/auth";
import type { WeeklySession, Camp, PrivateSlot } from "@/lib/sheets";
import { fullPriceForType, calcPrivatePrice as calcPrivatePricePreview, getTrainerTier, effectiveSessionPrice, REFERRAL_CREDIT_SESSION_PRICE } from "@/lib/pricing";
import { trainerNamesMatch, normalizeTrainerNameForComparison } from "@/lib/trainers";
import { type CanonicalGroupId } from "@/lib/athletes";
import { CANONICAL_GROUPS } from "@/lib/group-matching";

interface Registration {
  id: string;
  created_at: string;
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  session_details: string;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_location: string | null;
  booked_group: string | null;
  booked_trainer: string | null;
  manage_token: string;
  sms_consent: boolean;
  status: string;
  session_price: number | null;
  total_participants: number;
  referral_code: string | null;
  is_free: boolean;
  used_referral_credit: boolean;
  is_paid?: boolean;
  applied_account_credit?: number | null;
  is_late_cancel?: boolean;
  camp_day_late_fee?: number | null;
  package_id?: string | null;
  // Computed server-side (see src/lib/admin-registration-enrichment.ts) —
  // replaces the old client-side packageMembership/weeklyDiscountRates
  // useMemos, which needed the full unfiltered dataset in memory to get
  // this positional/tier math right.
  within_package?: boolean;
  package_paid?: boolean;
  weekly_discount_rate?: number;
}

interface ProfileKid {
  id?: string;
  name: string;
  dob: string;
  grade: string;
  gender?: string;
  groups?: CanonicalGroupId[];
  hidden?: boolean;
}

interface RescheduleForm {
  group: string;
  date: string;
  start: string;
  end: string;
  location: string;
  trainer: string;
  // Per-session rate from the sheet for the picked weekly group (not yet
  // multiplied by player count) — used to preview the price before saving.
  price?: number;
}

// Matches api/admin/data's ?view=clients response shape.
interface ClientSummary {
  name: string;
  email: string;
  phone: string;
  kids: string;
  athleteCount: number;
  count: number;
  lastDate: number;
  videoConsent: boolean | null;
  referralsAvailable: number;
  referralsTotal: number;
}

interface ScheduleData {
  weeklySchedule: WeeklySession[];
  camps: Camp[];
  privateSlots: PrivateSlot[];
}

const TYPE_LABELS: Record<string, string> = {
  weekly: "Group",
  pickup: "Pickup",
  camp: "Camp",
  private: "Private",
  "group-private": "Group Private",
};

function isPickup(r: { type: string; session_details: string }): boolean {
  return r.type === "weekly" && r.session_details?.toLowerCase().includes("pickup");
}

// Whether a weekly booking was part of a bulk/volume-discounted purchase
// (the 10%/15% off for booking several sessions at once) — the full-
// forfeiture late-cancel/reschedule policy only applies to those, not a
// plain 1-3 session weekly booking at the regular rate. Mirrors the same
// live-rate comparison the server uses (session_price vs. the group's
// actual current sheet rate).
function isBulkDiscountedWeekly(r: Registration, weeklySchedule: WeeklySession[]): boolean {
  if (r.type !== "weekly" || r.session_price == null || !r.booked_date || !r.booked_start_time) return false;
  const groupLabel = r.booked_group || r.session_details?.split(" — ")[0] || "";
  const match = weeklySchedule.find((s) => s.group === groupLabel && s.date === r.booked_date && s.startTime === r.booked_start_time);
  if (!match) return false;
  const standardRate = match.price * (r.total_participants || 1);
  return r.session_price < standardRate;
}

function typePill(type: string, sessionDetails?: string) {
  if (type === "weekly" && sessionDetails?.toLowerCase().includes("pickup")) return "bg-orange-900/60 text-orange-400";
  switch (type) {
    case "private": return "bg-mesa-accent/30 text-mesa-accent";
    case "weekly": return "bg-blue-900/60 text-blue-300";
    case "camp": return "bg-purple-900/60 text-purple-300";
    case "group-private": return "bg-green-900/60 text-green-300";
    default: return "bg-brown-800 text-brown-300";
  }
}

function typePillLabel(type: string, sessionDetails?: string) {
  if (type === "weekly" && sessionDetails?.toLowerCase().includes("pickup")) return "Pickup";
  return TYPE_LABELS[type] || type;
}

function sessionMs(date: string | null, startTime: string | null): number {
  if (!date) return 0;
  const d = new Date(date);
  if (isNaN(d.getTime())) return 0;
  if (startTime) {
    const m = startTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (m) {
      let h = parseInt(m[1]);
      const min = parseInt(m[2]);
      if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
      if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
      d.setHours(h, min, 0, 0);
      return d.getTime();
    }
  }
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Kids are stored as "Name (DOB: ..., Grade: ..., Gender: ...), Name2 (...)"
// — the DOB/Grade/Gender fields inside the parens have commas of their own,
// so splitting on "," first (the old approach) chopped each parenthetical
// into its own fragment and leaked "Grade: 5th"/"Gender: Male)" through as
// if they were additional athlete names. Strip every "(...)" group first,
// so splitting on "," afterward only ever splits between real names.
function athleteNames(kids: string) {
  return kids ? kids.replace(/\([^)]*\)/g, "").split(",").map((k) => k.trim()).filter(Boolean).join(", ") : "—";
}

// Last whitespace-separated token of a name, or "" if it's a single word
// (nothing to call a "last name"). Used both to display a last name for an
// athlete who was only ever saved with a first name, and to sort the Groups
// tab by last name so siblings land next to each other.
function lastNameOf(fullName: string): string {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

// Groups-tab-only display fallback — an athlete saved with just a first
// name borrows the parent's last name so there's something to show/sort
// by. Purely cosmetic: never written back to the athlete's saved data.
function groupsTabDisplayName(athleteName: string, parentName: string): { displayName: string; sortLastName: string } {
  const athleteLast = lastNameOf(athleteName);
  if (athleteLast) return { displayName: athleteName, sortLastName: athleteLast };
  const parentLast = lastNameOf(parentName);
  return parentLast
    ? { displayName: `${athleteName} ${parentLast}`, sortLastName: parentLast }
    : { displayName: athleteName, sortLastName: athleteName };
}

function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/\s+/).filter(Boolean);
}

// Matches on a first OR last name token from either the parent or any
// player — "smith" finds "John Smith" the parent, and separately finds any
// client with a player named "Smith", not just an exact full-name match.
function clientMatchesSearch(c: { name: string; kids: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const parentTokens = nameTokens(c.name);
  const playerTokens = c.kids === "—" ? [] : c.kids.split(",").flatMap((k) => nameTokens(k));
  return [...parentTokens, ...playerTokens].some((t) => t.includes(q));
}

function sessionText(details: string) {
  return details ? details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").split("\n")[0] : "—";
}

function formatPrice(price: number | null): string {
  if (price == null) return "—";
  return `$${price}`;
}

// Full session rate before any account credit is netted out — the base
// priceDisplay() builds on. weekly_discount_rate is computed server-side
// (see src/lib/admin-registration-enrichment.ts) and attached directly to
// the row, rather than passed in as a separately-fetched Map.
function preCreditPrice(r: Registration): number {
  const isPrivateType = r.type === "private" || r.type === "group-private";
  let basePrice: number;
  if (r.session_price != null) {
    basePrice = r.session_price;
  } else if (r.type === "weekly" && r.weekly_discount_rate != null) {
    basePrice = Math.round(50 * (r.total_participants || 1) * (1 - r.weekly_discount_rate));
  } else {
    basePrice = fullPriceForType(r.type, getTrainerTier(r.booked_trainer));
  }
  return effectiveSessionPrice(basePrice, r.is_free, isPrivateType, !!r.used_referral_credit);
}

// A flat dollar figure would hide that a $0 (or reduced) balance came from
// spending account credit, not from nothing being owed — so break it out:
// "$X credit" when credit covered it in full, "$X credit, $Y card" when it
// only covered part, otherwise the plain amount exactly as before.
function priceDisplay(r: Registration): string {
  const total = preCreditPrice(r);
  const credit = Math.min(r.applied_account_credit || 0, total);
  const owed = Math.max(0, total - credit);
  if (credit <= 0) return formatPrice(owed);
  if (owed <= 0) return `$${credit} credit`;
  return `$${credit} credit, $${owed} card`;
}

function daysAway(dateStr: string | null): { label: string; cls: string } | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const sessionDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((sessionDay - todayDay) / 86400000);
  if (diff === 0) return { label: "today", cls: "bg-green-900/40 text-green-400" };
  if (diff === 1) return { label: "tomorrow", cls: "bg-blue-900/40 text-blue-400" };
  if (diff === -1) return { label: "yesterday", cls: "bg-orange-900/40 text-orange-400" };
  if (diff > 0) return { label: `in ${diff} days`, cls: "bg-blue-900/40 text-blue-400" };
  return { label: `${Math.abs(diff)} days ago`, cls: "bg-orange-900/40 text-orange-400" };
}

// Shared status badge styling/label — used everywhere a registration's
// status is shown (client detail view, upcoming, past).
function statusBadge(status: string, isPast?: boolean): { cls: string; label: string } {
  if (status === "pending_payment") return { cls: "bg-blue-900/40 text-blue-400", label: "awaiting payment" };
  if (status === "payment_abandoned") return { cls: "bg-brown-700 text-brown-300", label: "abandoned" };
  if (status === "no_show") return { cls: "bg-orange-900/40 text-orange-400", label: "no show" };
  if (status === "confirmed") {
    return isPast
      ? { cls: "bg-brown-800 text-brown-400", label: "completed" }
      : { cls: "bg-green-900/40 text-green-400", label: isPast === undefined ? "confirmed" : "scheduled" };
  }
  return { cls: "bg-red-900/40 text-red-400", label: status };
}

// A pending_payment/payment_abandoned row is safe to delete — nothing was
// ever charged, no slot needs freeing — but a *just-created* pending_payment
// row still has a small chance the client is mid-checkout right now, with
// Stripe's webhook about to confirm it a few seconds later. payment_abandoned
// is always safe (Stripe already told us that checkout genuinely expired);
// pending_payment needs a few minutes' buffer first so deleting one can never
// race a real, in-flight payment confirmation.
function isDeletablePending(r: Registration): boolean {
  if (r.status === "payment_abandoned") return true;
  if (r.status !== "pending_payment") return false;
  return Date.now() - new Date(r.created_at).getTime() > 3 * 60 * 1000;
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- Reschedule dropdown helpers -------------------------------------------

function splitCampTime(time: string): { start: string; end: string } {
  const parts = time.split(/\s*[-–]\s*/);
  return { start: parts[0]?.trim() || time, end: parts[1]?.trim() || parts[0]?.trim() || time };
}

function dateSortKey(d: string): number {
  const t = new Date(d + " 12:00:00").getTime();
  return isNaN(t) ? 0 : t;
}

// Mirrors the pricing formulas in /api/admin/reschedule so the confirm step
// can preview the price before saving — the server always has the final say.
function parseTimeToMinsClient(t: string): number {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function formatTimeFromMinsClient(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

interface AdminTimeWindow {
  location: string;
  trainer: string;
  startMins: number;
  endMins: number;
}

// Mirrors buildTimeWindows() on the client booking page: the sheet lists
// private availability as separate hour-long rows (e.g. 3-4pm, 4-5pm), so
// adjacent rows for the same location/trainer get merged into one
// contiguous window before generating start-time options from it — exactly
// what the client-facing reschedule/booking flow already does, which is why
// a client can pick any 15-minute mark but the admin reschedule tool
// couldn't (it only ever exposed each raw row's own start time).
function buildTimeWindowsClient(slots: PrivateSlot[]): AdminTimeWindow[] {
  const groups: Record<string, PrivateSlot[]> = {};
  slots.forEach((s) => {
    const key = `${s.location}|${s.trainer}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });
  const windows: AdminTimeWindow[] = [];
  Object.values(groups).forEach((group) => {
    const sorted = [...group].sort((a, b) => parseTimeToMinsClient(a.startTime) - parseTimeToMinsClient(b.startTime));
    let windowStart = parseTimeToMinsClient(sorted[0].startTime);
    let windowEnd = parseTimeToMinsClient(sorted[0].endTime);
    for (let i = 1; i < sorted.length; i++) {
      const slotStart = parseTimeToMinsClient(sorted[i].startTime);
      const slotEnd = parseTimeToMinsClient(sorted[i].endTime);
      if (slotStart === windowEnd) {
        windowEnd = slotEnd;
      } else {
        windows.push({ location: sorted[0].location, trainer: sorted[0].trainer, startMins: windowStart, endMins: windowEnd });
        windowStart = slotStart;
        windowEnd = slotEnd;
      }
    }
    windows.push({ location: sorted[0].location, trainer: sorted[0].trainer, startMins: windowStart, endMins: windowEnd });
  });
  return windows;
}

// 15-min increment start times within a window, capped so at least
// minDuration remains before the window ends (matches the client-side
// booking flow's own getStartOptions()).
function getStartOptionsClient(window: { startMins: number; endMins: number }, minDuration: number): number[] {
  const options: number[] = [];
  const latestStart = window.endMins - minDuration;
  for (let t = window.startMins; t <= latestStart; t += 15) {
    options.push(t);
  }
  return options;
}

function isPrivateTypeClient(type: string): boolean {
  return type === "private" || type === "group-private";
}

// The DB stores the FULL (undiscounted) session_price for private sessions —
// the referral-credit/first-time discount is applied at display time via
// is_free, mirroring preCreditPrice() and the server's identical logic.
const effectiveAmountPreview = effectiveSessionPrice;

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

interface CampOption {
  key: string;
  label: string;
  camp: Camp;
}

function campOptions(camps: Camp[]): CampOption[] {
  return camps.map((c, i) => ({
    key: `${i}`,
    label: c.gradeGroup ? `${c.name} — ${c.gradeGroup}` : c.name,
    camp: c,
  }));
}

function campDayOptions(camp: Camp): string[] {
  if (camp.campDays && camp.campDays.length > 0) {
    return [...camp.campDays].sort((a, b) => dateSortKey(a) - dateSortKey(b));
  }
  return camp.startDate ? [camp.startDate] : [];
}

const RESCHEDULE_SELECT_CLASS = "mt-0.5 w-full rounded bg-brown-950 border border-brown-700 px-2 py-1.5 text-sm text-white";
const RESCHEDULE_LABEL_CLASS = "text-[10px] uppercase tracking-wider text-brown-500";

function renderWeeklyRescheduleFields(weeklySchedule: WeeklySession[], form: RescheduleForm, setForm: (f: RescheduleForm) => void) {
  const groups = uniqueSorted(weeklySchedule.map((s) => s.group));
  const sessionsForGroup = weeklySchedule.filter((s) => s.group === form.group);
  const dates = uniqueSorted(sessionsForGroup.map((s) => s.date)).sort((a, b) => dateSortKey(a) - dateSortKey(b));
  const sessionsForDate = sessionsForGroup.filter((s) => s.date === form.date);
  const times = Array.from(new Set(sessionsForDate.map((s) => s.startTime)));
  const sessionsForTime = sessionsForDate.filter((s) => s.startTime === form.start);
  const locations = Array.from(new Set(sessionsForTime.map((s) => s.location)));

  return (
    <>
      <div>
        <label className={RESCHEDULE_LABEL_CLASS}>Group</label>
        <select
          value={form.group}
          onChange={(e) => {
            const group = e.target.value;
            const first = weeklySchedule.find((s) => s.group === group);
            setForm({ group, date: "", start: "", end: "", location: "", trainer: first?.trainer || "", price: first?.price });
          }}
          className={RESCHEDULE_SELECT_CLASS}
        >
          <option value="">Select a group…</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      {form.group && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Date</label>
          <select
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value, start: "", end: "", location: "" })}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a date…</option>
            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}
      {form.date && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Time</label>
          <select
            value={form.start}
            onChange={(e) => {
              const start = e.target.value;
              const match = sessionsForDate.find((s) => s.startTime === start);
              setForm({ ...form, start, end: match?.endTime || "", location: match?.location || form.location, trainer: match?.trainer || form.trainer, price: match?.price ?? form.price });
            }}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a time…</option>
            {times.map((t) => {
              const match = sessionsForDate.find((s) => s.startTime === t);
              return <option key={t} value={t}>{t}{match ? `-${match.endTime}` : ""}</option>;
            })}
          </select>
        </div>
      )}
      {form.start && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Location</label>
          <select
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a location…</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

function renderCampRescheduleFields(camps: Camp[], form: RescheduleForm, setForm: (f: RescheduleForm) => void) {
  const options = campOptions(camps);
  const selected = options.find((o) => o.key === form.group);
  const days = selected ? campDayOptions(selected.camp) : [];

  return (
    <>
      <div>
        <label className={RESCHEDULE_LABEL_CLASS}>Camp</label>
        <select
          value={form.group}
          onChange={(e) => {
            const key = e.target.value;
            const opt = options.find((o) => o.key === key);
            if (!opt) { setForm({ group: "", date: "", start: "", end: "", location: "", trainer: "" }); return; }
            const { start, end } = splitCampTime(opt.camp.time);
            setForm({ group: key, date: "", start, end, location: opt.camp.location, trainer: "" });
          }}
          className={RESCHEDULE_SELECT_CLASS}
        >
          <option value="">Select a camp…</option>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      {selected && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Day</label>
          <select
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a day…</option>
            {days.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}
      {selected && form.date && (
        <div className="rounded-lg border border-brown-700 bg-brown-950 px-3 py-2 text-xs text-brown-300">
          Fixed time/location for this camp: {form.start}-{form.end} at {form.location}
        </div>
      )}
    </>
  );
}

function renderPrivateRescheduleFields(privateSlots: PrivateSlot[], form: RescheduleForm, setForm: (f: RescheduleForm) => void, preferredDurationMins: number = 60) {
  const dates = uniqueSorted(privateSlots.map((s) => s.date)).sort((a, b) => dateSortKey(a) - dateSortKey(b));
  const slotsForDate = privateSlots.filter((s) => s.date === form.date);
  const locations = Array.from(new Set(slotsForDate.map((s) => s.location)));
  const slotsForLocation = slotsForDate.filter((s) => s.location === form.location);
  // Merge adjacent hourly sheet rows into real windows, then offer every
  // 15-minute mark within them — same granularity the client gets when
  // booking/rescheduling themselves — while keeping at least
  // preferredDurationMins free so the session is never compressed shorter
  // than it started (defaults to 60 min; preserves the original booking's
  // duration when one already exists).
  const windowsForLocation = form.location ? buildTimeWindowsClient(slotsForLocation) : [];
  const startOptions = Array.from(new Set(
    windowsForLocation.flatMap((w) => getStartOptionsClient(w, preferredDurationMins))
  )).sort((a, b) => a - b);

  return (
    <>
      <div>
        <label className={RESCHEDULE_LABEL_CLASS}>Date</label>
        <select
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value, start: "", end: "", location: "", trainer: "" })}
          className={RESCHEDULE_SELECT_CLASS}
        >
          <option value="">Select a date…</option>
          {dates.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {form.date && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Location</label>
          <select
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value, start: "", end: "", trainer: "" })}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a location…</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      )}
      {form.location && (
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Time</label>
          <select
            value={form.start ? String(parseTimeToMinsClient(form.start)) : ""}
            onChange={(e) => {
              const startMins = parseInt(e.target.value, 10);
              const endMins = startMins + preferredDurationMins;
              // Recover the trainer from whichever raw sheet row actually
              // covers the full selected duration at this location.
              const match = slotsForLocation.find((s) =>
                parseTimeToMinsClient(s.startTime) <= startMins && parseTimeToMinsClient(s.endTime) >= endMins
              );
              setForm({
                ...form,
                start: formatTimeFromMinsClient(startMins),
                end: formatTimeFromMinsClient(endMins),
                trainer: match?.trainer || form.trainer,
              });
            }}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a time…</option>
            {startOptions.map((mins) => (
              <option key={mins} value={mins}>
                {formatTimeFromMinsClient(mins)}-{formatTimeFromMinsClient(mins + preferredDurationMins)}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

function renderManualRescheduleFields(form: RescheduleForm, setForm: (f: RescheduleForm) => void) {
  return (
    <>
      <p className="text-[11px] text-amber-400 -mt-1">Couldn&apos;t load the schedule sheet — enter the new session manually.</p>
      <div>
        <label className={RESCHEDULE_LABEL_CLASS}>Date</label>
        <input value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} placeholder="e.g. July 20, 2026" className={RESCHEDULE_SELECT_CLASS} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>Start</label>
          <input value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} placeholder="e.g. 7:00 PM" className={RESCHEDULE_SELECT_CLASS} />
        </div>
        <div>
          <label className={RESCHEDULE_LABEL_CLASS}>End</label>
          <input value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} placeholder="e.g. 8:00 PM" className={RESCHEDULE_SELECT_CLASS} />
        </div>
      </div>
      <div>
        <label className={RESCHEDULE_LABEL_CLASS}>Location</label>
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Location" className={RESCHEDULE_SELECT_CLASS} />
      </div>
    </>
  );
}

function formatDateHeader(d: string | null): string {
  if (!d) return "No Date";
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function groupByDate(list: Registration[]): { key: string; label: string; sessions: Registration[] }[] {
  const groups: { key: string; label: string; sessions: Registration[] }[] = [];
  for (const r of list) {
    const key = r.booked_date ?? "__none__";
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      groups.push({ key, label: formatDateHeader(r.booked_date), sessions: [r] });
    } else {
      last.sessions.push(r);
    }
  }
  return groups;
}

// --- Session folders (group/pickup/camp signups sharing one real session) --

interface Folder {
  key: string;
  // true = a weekly/pickup/camp session, shown as an expandable folder.
  // Private/group-private bookings are always their own one-off session, so
  // they never fold — grouped stays false and regs has exactly one entry.
  grouped: boolean;
  regs: Registration[];
  maxSpots?: number;
}

// Same identity checkGroupSessionCapacity/checkCampCapacity use to pool
// signups for one real session — so folders always match what the site
// itself treats as "the same session" and enforces capacity against.
function folderKeyFor(r: Registration): string {
  if (r.type === "weekly" || r.type === "camp") {
    return `${r.type}|${r.booked_date ?? ""}|${r.booked_start_time ?? ""}|${r.booked_group ?? ""}`;
  }
  return `single|${r.id}`;
}

function buildFolders(list: Registration[], weeklyCapacity: Map<string, number>, campCapacity: Map<string, number>): Folder[] {
  const order: string[] = [];
  const byKey = new Map<string, Registration[]>();
  for (const r of list) {
    const key = folderKeyFor(r);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(r);
  }
  return order.map((key) => {
    const regs = byKey.get(key)!;
    const sample = regs[0];
    const grouped = sample.type === "weekly" || sample.type === "camp";
    let maxSpots: number | undefined;
    if (grouped) {
      maxSpots = sample.type === "weekly"
        ? weeklyCapacity.get(`${sample.booked_date ?? ""}|${sample.booked_start_time ?? ""}|${sample.booked_group ?? ""}`)
        : campCapacity.get(sample.booked_group ?? "");
    }
    return { key, grouped, regs, maxSpots };
  });
}

// Only confirmed + pending_payment count toward "signed up" — the same
// statuses the real capacity check counts — so the folder header number
// always lines up with what actually blocks a new booking. Cancelled/no-show
// rows still show up once the folder is expanded.
function folderSignedUpCount(regs: Registration[]): number {
  return regs
    .filter((r) => r.status === "confirmed" || r.status === "pending_payment")
    .reduce((sum, r) => sum + (r.total_participants || 1), 0);
}

// Same "X/Y signed up" label everywhere a folder header appears (Upcoming,
// Past, Calendar) — falls back to just "X signed up" when the schedule
// sheet has no matching capacity for this session.
function folderCountLabel(folder: Folder): string {
  const signedUp = folderSignedUpCount(folder.regs);
  return typeof folder.maxSpots === "number" ? `${signedUp}/${folder.maxSpots} signed up` : `${signedUp} signed up`;
}

function buildWeeklyCapacityMap(weeklySchedule: WeeklySession[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of weeklySchedule) {
    map.set(`${s.date}|${s.startTime}|${s.group}`, s.maxSpots);
  }
  return map;
}

function buildCampCapacityMap(camps: Camp[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of camps) {
    if (!map.has(c.name)) map.set(c.name, c.maxSpots);
  }
  return map;
}

function folderLabel(sample: Registration): string {
  if (sample.type === "camp") return sample.booked_group || sessionText(sample.session_details);
  if (isPickup(sample)) return "Pickup";
  return sample.booked_group || "Group Session";
}

interface CalendarViewProps {
  token: string | null;
  trainerFilter: string;
  weeklyCapacity: Map<string, number>;
  campCapacity: Map<string, number>;
  canEdit: boolean;
  cancelRegistration: (id: string, feeChoice?: "waive" | "charge", regHint?: Registration) => Promise<void>;
  markNoShow: (id: string) => Promise<void>;
  openReschedule: (r: Registration) => void;
  deleteRegistration: (id: string) => Promise<void>;
  cancelling: string | null;
  noShowing: string | null;
  noShowConfirm: string | null;
  setNoShowConfirm: (id: string | null) => void;
  deleting: string | null;
}

function CalendarView({ token, trainerFilter, weeklyCapacity, campCapacity, canEdit, cancelRegistration, markNoShow, openReschedule, deleteRegistration, cancelling, noShowing, noShowConfirm, setNoShowConfirm, deleting }: CalendarViewProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedRegs, setExpandedRegs] = useState<Set<string>>(new Set());

  // One month's registrations at a time, fetched as the admin navigates —
  // replaces being handed [...upcoming, ...past] directly, which broke once
  // Past stopped always holding full history. Cached per month for this
  // component's lifetime (it unmounts on tab switch today anyway, same as
  // before) so navigating back to an already-seen month doesn't re-fetch.
  const monthKey = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, "0")}`;
  // Trainer filter is part of the cache key — switching the dropdown must
  // trigger a fresh fetch under its own key, not reuse a different
  // trainer's cached month.
  const cacheKey = `${monthKey}|${trainerFilter}`;
  const [monthCache, setMonthCache] = useState<Map<string, Registration[]>>(new Map());
  const cached = monthCache.get(cacheKey);
  // Derived from the cache itself (absent = still loading) rather than a
  // separate setState call at the top of the effect below — the earlier
  // version's synchronous setCalLoading(true) there, in an effect that also
  // depends on the very state it updates, is exactly the "cascading
  // renders" pattern React's own linter warns against.
  const calLoading = cached === undefined;

  useEffect(() => {
    if (!token || monthCache.has(cacheKey)) return;
    const params = new URLSearchParams({ view: "calendar", month: monthKey });
    if (trainerFilter !== "all") params.set("trainer", trainerFilter);
    fetch(`/api/admin/data?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setMonthCache((prev) => new Map(prev).set(cacheKey, data.registrations || []));
      })
      .catch(() => {
        setMonthCache((prev) => new Map(prev).set(cacheKey, []));
      });
  }, [monthKey, cacheKey, token, monthCache, trainerFilter]);

  function toggleFolder(key: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleReg(id: string) {
    setExpandedRegs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function regRowJSX(r: Registration) {
    const expanded = expandedRegs.has(r.id);
    const fullSession = r.session_details
      ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()
      : "—";
    return (
      <div key={r.id} className="rounded-xl border-2 border-brown-600 bg-brown-900/40 overflow-hidden shadow-lg shadow-black/30">
        <button
          type="button"
          onClick={() => toggleReg(r.id)}
          className="w-full text-left px-4 py-3 flex items-start justify-between gap-2"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-sm">{r.parent_name}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${typePill(r.type, r.session_details)}`}>{typePillLabel(r.type, r.session_details)}</span>
              {r.within_package && (
                <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium">pkg</span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(r.status).cls}`}>
                {statusBadge(r.status).label}
              </span>
            </div>
            <div className="text-xs text-brown-300 mt-0.5 truncate">{athleteNames(r.kids || "")}</div>
            <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
              {r.booked_date && <span className="text-mesa-accent">{formatDate(r.booked_date)}</span>}
              {r.booked_start_time && (
                <span>{r.booked_start_time}{r.booked_end_time ? `-${r.booked_end_time}` : ""}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end justify-between self-stretch gap-1">
            <span className={`text-brown-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
            {canEdit && !r.within_package && (
              <span className="text-xs font-medium text-green-400">{priceDisplay(r)}</span>
            )}
          </div>
        </button>

        {expanded && (
          <div className="border-t border-brown-700 px-4 py-3 space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Email</p>
                <p className="text-brown-200 break-all">{r.email || "—"}</p>
              </div>
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Phone</p>
                <p className="text-brown-200">{r.phone || "—"}</p>
              </div>
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Athletes</p>
              <p className="text-brown-200 whitespace-pre-line">{r.kids ? r.kids.split(",").map((k) => k.trim()).join("\n") : "—"}</p>
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Session Details</p>
              <p className="text-brown-200 whitespace-pre-line leading-relaxed">{fullSession}</p>
            </div>

            {r.status === "confirmed" && (
              <div className="flex flex-wrap gap-3 pt-1 border-t border-brown-800">
                {canEdit && (
                  <button onClick={() => cancelRegistration(r.id, undefined, r)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                    {cancelling === r.id ? "..." : "Cancel"}
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => openReschedule(r)} className="text-xs text-blue-400 hover:text-blue-300 transition">
                    Reschedule
                  </button>
                )}
                {noShowConfirm !== r.id ? (
                  <button onClick={() => setNoShowConfirm(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 transition disabled:opacity-50">
                    No Show
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-orange-300 font-semibold">Sure?</span>
                    <button onClick={() => markNoShow(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 font-semibold transition disabled:opacity-50">
                      {noShowing === r.id ? "..." : "Yes"}
                    </button>
                    <button onClick={() => setNoShowConfirm(null)} className="text-xs text-brown-500 hover:text-brown-300 transition">No</button>
                  </div>
                )}
              </div>
            )}
            {canEdit && isDeletablePending(r) && (
              // Never a real booking — nothing charged, no slot to
              // free — safe to delete right away.
              <div className="flex flex-wrap gap-3 pt-1 border-t border-brown-800">
                <button onClick={() => deleteRegistration(r.id)} disabled={deleting === r.id} className="text-xs text-brown-600 hover:text-red-500 transition disabled:opacity-50">
                  {deleting === r.id ? "..." : "Delete"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function folderRowJSX(folder: Folder) {
    const sample = folder.regs[0];
    const timeLabel = sample.booked_start_time ? `${sample.booked_start_time}${sample.booked_end_time ? `-${sample.booked_end_time}` : ""}` : null;
    const expanded = expandedFolders.has(folder.key);
    return (
      <div key={folder.key} className="rounded-xl border-2 border-brown-600 bg-brown-900/40 overflow-hidden shadow-lg shadow-black/30">
        <button type="button" onClick={() => toggleFolder(folder.key)} className="w-full text-left px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`text-brown-500 transition-transform duration-200 shrink-0 ${expanded ? "rotate-180" : ""}`}>▾</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${typePill(sample.type, sample.session_details)}`}>{typePillLabel(sample.type, sample.session_details)}</span>
            <span className="font-medium text-sm">{folderLabel(sample)}</span>
            {timeLabel && <span className="text-xs text-brown-400">{timeLabel}</span>}
            {sample.booked_location && <span className="text-xs text-brown-500">· {sample.booked_location}</span>}
          </div>
          <span className="shrink-0 text-xs font-medium text-mesa-accent whitespace-nowrap">
            {folderCountLabel(folder)}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-brown-700 px-3 py-3 space-y-2 bg-brown-950/40">
            {folder.regs.map((r) => regRowJSX(r))}
          </div>
        )}
      </div>
    );
  }

  const sessionsByDay = useMemo(() => {
    const map = new Map<string, Registration[]>();
    for (const r of (cached ?? [])) {
      if (!r.booked_date) continue;
      const d = new Date(r.booked_date);
      if (isNaN(d.getTime())) continue;
      const key = toDateKey(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [cached]);

  const days = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: { dateKey: string; day: number; isCurrentMonth: boolean }[] = [];

    for (let i = firstDow - 1; i >= 0; i--) {
      const d = new Date(year, month, -i);
      cells.push({ dateKey: toDateKey(d), day: d.getDate(), isCurrentMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ dateKey: toDateKey(new Date(year, month, d)), day: d, isCurrentMonth: true });
    }
    let trail = 1;
    while (cells.length < 42) {
      const d = new Date(year, month + 1, trail++);
      cells.push({ dateKey: toDateKey(d), day: d.getDate(), isCurrentMonth: false });
    }
    return cells;
  }, [currentMonth]);

  const today = new Date();
  const todayKey = toDateKey(today);
  const monthLabel = currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const selectedSessions = selectedDay ? (sessionsByDay.get(selectedDay) ?? []) : [];

  function prevMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
    setSelectedDay(null);
  }
  function nextMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
    setSelectedDay(null);
  }

  return (
    <div>
      {/* Month nav */}
      <div className="flex items-center justify-between mb-4">
        <button onClick={prevMonth} className="px-3 py-1.5 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">← Prev</button>
        <span className="font-semibold text-white">{monthLabel}</span>
        <button onClick={nextMonth} className="px-3 py-1.5 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">Next →</button>
      </div>
      {calLoading && <p className="text-xs text-brown-500 mb-3">Loading…</p>}

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-center text-xs text-brown-500 py-1 font-medium">{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-1">
        {days.map(({ dateKey, day, isCurrentMonth }) => {
          const sessions = sessionsByDay.get(dateKey) ?? [];
          const isToday = dateKey === todayKey;
          const isSelected = dateKey === selectedDay;
          return (
            <button
              key={dateKey}
              disabled={sessions.length === 0}
              onClick={() => setSelectedDay(isSelected ? null : dateKey)}
              className={`min-h-[60px] rounded-lg p-1.5 text-left transition ${!isCurrentMonth ? "opacity-25" : ""} ${
                isSelected ? "bg-mesa-accent/20 border border-mesa-accent" :
                sessions.length > 0 ? "bg-brown-800/60 border border-brown-700 hover:border-mesa-accent/60 cursor-pointer" :
                "bg-brown-900/20 border border-brown-800/40 cursor-default"
              }`}
            >
              <span className={`text-xs font-medium leading-none ${isToday ? "text-mesa-accent font-bold" : isCurrentMonth ? "text-white" : "text-brown-600"}`}>
                {day}
              </span>
              {sessions.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {sessions.slice(0, 2).map((s, i) => (
                    <div key={i} className={`rounded text-[9px] px-1 py-0.5 truncate leading-tight ${typePill(s.type)}`}>
                      {s.parent_name}
                    </div>
                  ))}
                  {sessions.length > 2 && <div className="text-[9px] text-brown-500">+{sessions.length - 2}</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected day detail */}
      {selectedDay && selectedSessions.length > 0 && (
        <div className="mt-5 border-t border-brown-700 pt-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            <span className="ml-2 text-mesa-accent font-normal">{selectedSessions.length} session{selectedSessions.length !== 1 ? "s" : ""}</span>
          </h3>
          <div className="space-y-2">
            {buildFolders(selectedSessions, weeklyCapacity, campCapacity).map((folder) =>
              folder.grouped ? folderRowJSX(folder) : regRowJSX(folder.regs[0])
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [profilesMap, setProfilesMap] = useState<Record<string, { phone: string; parentName: string; kids: ProfileKid[] }>>({});
  const [tab, setTab] = useState<"upcoming" | "past" | "clients" | "calendar" | "groups" | "schedule">("upcoming");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [noShowConfirm, setNoShowConfirm] = useState<string | null>(null);
  const [noShowing, setNoShowing] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authCtx, setAuthCtx] = useState<AuthContext | null>(null);
  const [trainerFilter, setTrainerFilter] = useState("all");
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; confirmed: number; cancelled: number; camps: number; groups: number } | null>(null);

  // Past tab: last-30-days by default (pastWindowRegs), "Load all" upgrades
  // to pastAllRegs, and typing a search term while on this tab bypasses the
  // window entirely (pastSearchRegs) — see api/admin/data's ?view=past for
  // why search can't just filter whatever's currently loaded.
  const [pastWindowRegs, setPastWindowRegs] = useState<Registration[] | null>(null);
  const [pastAllRegs, setPastAllRegs] = useState<Registration[] | null>(null);
  const [pastSearchRegs, setPastSearchRegs] = useState<Registration[] | null>(null);
  const [pastHasMore, setPastHasMore] = useState(false);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastLoadingAll, setPastLoadingAll] = useState(false);
  const [pastSearchLoading, setPastSearchLoading] = useState(false);

  // Schedule tab: what a trainer is actually assigned to run, read straight
  // off the schedule sheet (api/admin/data's ?view=roster) — independent of
  // whether anyone's booked, unlike every other tab here which is bookings-
  // only. Refetched whenever the tab is opened or the trainer-filter
  // dropdown changes (admin/elevated only — a plain trainer always sees
  // just their own, server-enforced the same way every other view is).
  interface RosterGroupSession { date: string; startTime: string; endTime: string; location: string; group: string; trainer: string; maxSpots: number; enrolled: number }
  interface RosterPrivateWindow { date: string; startTime: string; endTime: string; location: string; trainer: string }
  const [rosterGroupSessions, setRosterGroupSessions] = useState<RosterGroupSession[] | null>(null);
  const [rosterPrivateWindows, setRosterPrivateWindows] = useState<RosterPrivateWindow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  // Clients tab: the list itself is a lightweight per-client aggregate
  // (see api/admin/data's ?view=clients) fetched once per tab visit /
  // trainer-filter change, not derived from the full registrations
  // dataset. Clicking into one specific client fetches THAT client's full
  // history on demand (clientDetailRegs) — never preloaded for everyone.
  const [clientsList, setClientsList] = useState<ClientSummary[] | null>(null);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientDetailRegs, setClientDetailRegs] = useState<Registration[] | null>(null);
  const [clientDetailProfile, setClientDetailProfile] = useState<{ phone: string; parent_name: string; kids: ProfileKid[]; video_consent: boolean | null } | null>(null);
  const [clientDetailLoading, setClientDetailLoading] = useState(false);
  const [clientDetailFor, setClientDetailFor] = useState<string | null>(null);

  // Groups tab state — which athlete row (keyed "email|athleteId") is
  // expanded to show parent info, and which group-assignment mutation (if
  // any) is currently in flight, to disable its button while saving.
  const [expandedGroupAthlete, setExpandedGroupAthlete] = useState<string | null>(null);
  const [groupActionPending, setGroupActionPending] = useState<string | null>(null);
  // profilesMap (site-wide, needed for groupBuckets) is fetched only once
  // Groups is actually visited — see the effect below — not bundled into
  // dashboard mount like it used to be.
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);

  // Admin reschedule state
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  // The full row being rescheduled, captured at the moment the modal opens
  // rather than re-looked-up from `registrations` later — `registrations`
  // now only ever holds upcoming bookings (see the lazy-loading effect
  // above), but Calendar's rows allow Reschedule on a past confirmed
  // session too, which that lookup would silently fail to find.
  const [reschedulingReg, setReschedulingReg] = useState<Registration | null>(null);
  const [rescheduleStep, setRescheduleStep] = useState<"edit" | "confirm">("edit");
  const [rescheduleForm, setRescheduleForm] = useState<RescheduleForm>({ group: "", date: "", start: "", end: "", location: "", trainer: "" });
  const [rescheduleSaving, setRescheduleSaving] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);
  const [rescheduleConvertToPrivate, setRescheduleConvertToPrivate] = useState(false);
  const [rescheduleConvertToGroup, setRescheduleConvertToGroup] = useState(false);
  const [rescheduleKeepCredit, setRescheduleKeepCredit] = useState(true);

  // Add-player state
  const [addPlayerOpenId, setAddPlayerOpenId] = useState<string | null>(null);
  const [addPlayerName, setAddPlayerName] = useState("");
  const [addPlayerSaving, setAddPlayerSaving] = useState(false);
  const [addPlayerError, setAddPlayerError] = useState<string | null>(null);

  // Time Change state
  const [tcResult, setTcResult] = useState<{ changesFound: { session: string; oldTime: string; newTime: string; count: number }[]; totalEmailsSent: number; totalSmsSent: number } | null>(null);

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      const ctx = session ? resolveAuthRole(session.user.email) : null;
      if (!session || !ctx) {
        router.replace("/login");
        return;
      }
      setAuthCtx(ctx);
      setToken(session.access_token);

      // Upcoming is the only data the dashboard needs at mount — it's what
      // every role lands on, and Past/Calendar/Clients/Groups each fetch
      // their own scoped data lazily on first visit (see the effects
      // below). This used to also fire a second, unbounded all-time
      // registrations+profiles+packages+referral-credits+account-credits+
      // late-fee-events fetch on every single mount (re-enriching the
      // ENTIRE booking history every time, most of it never even read by
      // the UI) — that's what was making the dashboard feel slower and
      // slower as booking history grew. Reschedule/cancel/no-show and the
      // trainer-filter dropdown only ever act on an upcoming booking, so
      // this one fetch is genuinely all `registrations` state needs to hold
      // now.
      fetch(`/api/admin/data?view=upcoming`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).then((r) => r.json()).then((upcomingData) => {
        setRegistrations(upcomingData.registrations || []);
      }).catch(() => {}).finally(() => setLoading(false));

      // Time-change sync writes data — trainer accounts are read-only, so
      // only admin ever triggers this.
      if (ctx.role === "admin") {
        // Auto-sync time changes in the background — banner appears when it's done,
        // but it no longer holds up the rest of the dashboard from rendering.
        fetch("/api/admin/sync-time-changes", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).then((r) => r.json()).then((syncResult) => {
          if (syncResult?.changesFound?.length > 0) {
            setTcResult(syncResult);
          }
        }).catch(() => {});
      }

      // Load the current schedule (groups/camps/private slots) — every role
      // needs this for folder capacity ("X/Y signed up"), not just admin's
      // reschedule modal.
      fetch("/api/schedule").then((r) => r.json()).then((d) => {
        setScheduleData({
          weeklySchedule: d.weeklySchedule || [],
          camps: d.camps || [],
          privateSlots: d.privateSlots || [],
        });
      }).catch(() => {});
    });
  }, [router]);

  // Fetch the Past tab's default (last-30-days) window the first time it's
  // opened — not on mount, so a session that never visits Past never pays
  // for it.
  useEffect(() => {
    if (tab !== "past" || !token || pastWindowRegs !== null || pastLoading) return;
    setPastLoading(true);
    fetch("/api/admin/data?view=past&window=30d", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setPastWindowRegs(data.registrations || []);
        setPastHasMore(!!data.hasMore);
      })
      .catch(() => setPastWindowRegs([]))
      .finally(() => setPastLoading(false));
  }, [tab, token, pastWindowRegs, pastLoading]);

  // Schedule tab — fetched on first visit, and re-fetched if the
  // trainer-filter dropdown changes (admin/elevated only; a plain trainer's
  // scope is fixed server-side regardless of this param).
  useEffect(() => {
    if (tab !== "schedule" || !token || rosterLoading) return;
    setRosterLoading(true);
    const params = trainerFilter !== "all" ? `&trainer=${encodeURIComponent(trainerFilter)}` : "";
    fetch(`/api/admin/data?view=roster${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setRosterGroupSessions(data.groupSessions || []);
        setRosterPrivateWindows(data.privateWindows || []);
      })
      .catch(() => {
        setRosterGroupSessions([]);
        setRosterPrivateWindows([]);
      })
      .finally(() => setRosterLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token, trainerFilter]);

  async function loadAllPast() {
    if (!token) return;
    setPastLoadingAll(true);
    try {
      const res = await fetch("/api/admin/data?view=past&window=all", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setPastAllRegs(data.registrations || []);
    } finally {
      setPastLoadingAll(false);
    }
  }

  // Typing into the shared search box while on the Past tab bypasses the
  // window entirely and queries full history server-side — debounced so
  // every keystroke doesn't fire its own request. Clearing the box (or
  // leaving the tab, then coming back with it still empty) reverts to
  // whatever's already loaded (pastAllRegs ?? pastWindowRegs) with no
  // re-fetch needed, since that data was never discarded.
  useEffect(() => {
    if (tab !== "past" || !token) return;
    if (!search.trim()) {
      setPastSearchRegs(null);
      return;
    }
    setPastSearchLoading(true);
    const handle = setTimeout(() => {
      fetch(`/api/admin/data?view=past&search=${encodeURIComponent(search.trim())}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => setPastSearchRegs(data.registrations || []))
        .catch(() => setPastSearchRegs([]))
        .finally(() => setPastSearchLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [tab, search, token]);

  // Clients tab list — fetched on first visit, and re-fetched if the
  // trainer-filter dropdown changes (it narrows Clients too, same as
  // Upcoming/Past/Calendar) or nothing's loaded yet under the current
  // filter.
  useEffect(() => {
    if (tab !== "clients" || !token || clientsLoading) return;
    setClientsLoading(true);
    const params = trainerFilter !== "all" ? `&trainer=${encodeURIComponent(trainerFilter)}` : "";
    fetch(`/api/admin/data?view=clients${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => setClientsList(data.clients || []))
      .catch(() => setClientsList([]))
      .finally(() => setClientsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token, trainerFilter]);

  // Clicking into one specific client fetches THEIR full history on
  // demand — never preloaded for everyone else. Re-fetches if a different
  // client is selected; clearing the selection just hides the detail view,
  // no need to discard what was already loaded.
  useEffect(() => {
    if (!selectedClient || !token || selectedClient === clientDetailFor) return;
    setClientDetailLoading(true);
    fetch(`/api/admin/data?email=${encodeURIComponent(selectedClient)}&full=1`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        setClientDetailRegs(data.registrations || []);
        setClientDetailProfile(data.profile || null);
        setClientDetailFor(selectedClient);
      })
      .catch(() => {
        setClientDetailRegs([]);
        setClientDetailProfile(null);
        setClientDetailFor(selectedClient);
      })
      .finally(() => setClientDetailLoading(false));
  }, [selectedClient, token, clientDetailFor]);

  // Groups tab's athlete list needs the site-wide profiles table (grade/DOB/
  // group assignments) — fetched once on first visit, same lazy pattern as
  // every other tab, not bundled into dashboard mount.
  useEffect(() => {
    if (tab !== "groups" || !token || groupsLoaded || groupsLoading) return;
    setGroupsLoading(true);
    fetch("/api/admin/data?view=groups", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        const profMap: Record<string, { phone: string; parentName: string; kids: ProfileKid[] }> = {};
        for (const p of (data.profiles || [])) {
          if (!p.email) continue;
          profMap[p.email] = { phone: p.phone || "", parentName: p.parent_name || "", kids: Array.isArray(p.kids) ? p.kids : [] };
        }
        setProfilesMap(profMap);
        setGroupsLoaded(true);
      })
      .catch(() => {})
      .finally(() => setGroupsLoading(false));
  }, [tab, token, groupsLoaded, groupsLoading]);

  async function deleteRegistration(id: string) {
    if (!token) return;
    if (!confirm("Permanently delete this registration? This cannot be undone.")) return;
    setDeleting(id);
    const res = await fetch("/api/admin/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setRegistrations((prev) => prev.filter((r) => r.id !== id));
    } else {
      const data = await res.json().catch(() => null);
      alert(data?.error || "Failed to delete this registration.");
    }
    setDeleting(null);
  }

  async function cancelRegistration(id: string, feeChoice?: "waive" | "charge", regHint?: Registration) {
    if (!token) return;
    if (!feeChoice && !confirm("Cancel this registration? If the client already paid, they'll be refunded in full automatically.")) return;
    setCancelling(id);
    const res = await fetch("/api/admin/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, feeChoice }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, status: "cancelled" } : r)));
      if (data?.refundFailed) {
        alert("Cancelled, but the automatic refund failed — you'll need to refund this client manually in the Stripe dashboard.");
      } else if (data?.refundedAmount > 0 || data?.creditedAmount > 0) {
        const parts = [
          data.refundedAmount > 0 ? `$${data.refundedAmount} refunded to their card` : "",
          data.creditedAmount > 0 ? `$${data.creditedAmount} credited to their account` : "",
        ].filter(Boolean).join(", ");
        alert(`Cancelled${data.isLateCancel ? " (late fee charged)" : ""}. ${parts}.`);
      } else if (data?.packageSessionForfeited) {
        alert("Cancelled (late). The session was forfeited from their package — no fee, no refund.");
      } else if (data?.fullForfeitNoRefund) {
        alert("Cancelled (late). Full forfeiture — nothing refunded or credited.");
      } else if (data?.isLateCancel) {
        alert("Cancelled (late fee applies) — nothing to auto-refund/credit for this booking.");
      }
    } else if (data?.needsFeeChoice) {
      setCancelling(null);
      // regHint (the row the click came from) covers Calendar's past
      // sessions too, which the now upcoming-only `registrations` state
      // wouldn't contain.
      const reg = regHint ?? registrations.find((x) => x.id === id);
      const feeExplainer = reg?.package_id
        ? "OK = CHARGE — the session is forfeited from their package (no fee, but no refund/carryover either).\n\nCancel = WAIVE the fee — the slot is freed back to their package, same as an on-time cancellation."
        : reg && isBulkDiscountedWeekly(reg, scheduleData?.weeklySchedule || [])
          ? "OK = CHARGE — full forfeiture, nothing refunded/credited (bulk-discounted booking).\n\nCancel = WAIVE the fee — full refund back to their card, same as an on-time cancellation."
          : "OK = CHARGE the standard late fee — half of what they paid is credited to their account, the other half is kept as the fee.\n\nCancel = WAIVE the fee — full refund back to their card, same as an on-time cancellation.";
      const charge = confirm(
        `This booking is within the 24-hour late-cancellation window.\n\n${feeExplainer}`
      );
      return cancelRegistration(id, charge ? "charge" : "waive", reg);
    } else {
      alert(data?.error || "Failed to cancel.");
    }
    setCancelling(null);
  }

  async function markNoShow(id: string) {
    if (!token) return;
    setNoShowing(id);
    setNoShowConfirm(null);
    const res = await fetch("/api/admin/no-show", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, status: "no_show" } : r)));
    } else {
      const data = await res.json().catch(() => null);
      alert(data?.error || "Failed to mark as no-show.");
    }
    setNoShowing(null);
  }

  async function submitAddPlayer(id: string) {
    if (!token || !addPlayerName.trim()) {
      setAddPlayerError("Enter a player name.");
      return;
    }
    setAddPlayerSaving(true);
    setAddPlayerError(null);
    const res = await fetch("/api/admin/add-player", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, playerName: addPlayerName.trim() }),
    });
    const data = await res.json();
    setAddPlayerSaving(false);
    if (!res.ok) {
      setAddPlayerError(data.error || "Failed to add player.");
      return;
    }
    setRegistrations((prev) => prev.map((reg) => (reg.id === id ? {
      ...reg,
      kids: data.kids || reg.kids,
      total_participants: typeof data.totalParticipants === "number" ? data.totalParticipants : reg.total_participants,
      session_price: typeof data.sessionPrice === "number" ? data.sessionPrice : reg.session_price,
    } : reg)));
    setAddPlayerOpenId(null);
    setAddPlayerName("");
    if (data.creditGranted > 0) {
      alert(`Player added. $${data.creditGranted} was credited to their account (already paid at the old, lower price).`);
    } else if (data.autoChargedAmount > 0) {
      alert(`Player added. $${data.autoChargedAmount} (+ service fee) was automatically charged to their card on file.`);
    }
  }

  function openReschedule(r: Registration) {
    setReschedulingId(r.id);
    setReschedulingReg(r);
    setRescheduleStep("edit");
    setRescheduleError(null);
    setRescheduleConvertToPrivate(false);
    setRescheduleConvertToGroup(false);
    setRescheduleKeepCredit(true);
    // For weekly/camp we start the picker blank so the admin actively selects
    // from real sheet options rather than pre-filling with the (possibly
    // stale) current label. Private sessions still start pre-filled since
    // there's no "group" step for them to reconsider.
    const isGroupOrCamp = r.type === "weekly" || r.type === "camp";
    setRescheduleForm({
      group: "",
      date: isGroupOrCamp ? "" : (r.booked_date || ""),
      start: isGroupOrCamp ? "" : (r.booked_start_time || ""),
      end: isGroupOrCamp ? "" : (r.booked_end_time || ""),
      location: isGroupOrCamp ? "" : (r.booked_location || ""),
      trainer: r.booked_trainer || "",
    });
  }

  function closeReschedule() {
    setReschedulingId(null);
    setReschedulingReg(null);
  }

  function reviewReschedule() {
    const r = reschedulingReg;
    const convertingToPrivate = r?.type === "weekly" && rescheduleConvertToPrivate;
    const convertingToGroup = !!r && isPrivateTypeClient(r.type) && rescheduleConvertToGroup;
    const needsGroup = (r?.type === "weekly" && !convertingToPrivate) || r?.type === "camp" || convertingToGroup;
    if ((needsGroup && !rescheduleForm.group.trim()) || !rescheduleForm.date.trim() || !rescheduleForm.start.trim() || !rescheduleForm.end.trim() || !rescheduleForm.location.trim()) {
      setRescheduleError("Please select all fields.");
      return;
    }
    setRescheduleError(null);
    setRescheduleStep("confirm");
  }

  async function submitReschedule(feeChoice?: "waive" | "charge") {
    if (!token || !reschedulingId) return;
    const r = reschedulingReg;
    if (!r) return;
    setRescheduleSaving(true);
    setRescheduleError(null);

    const convertingToPrivate = r.type === "weekly" && rescheduleConvertToPrivate;
    const convertingToGroup = isPrivateTypeClient(r.type) && rescheduleConvertToGroup;
    const willBePrivate = convertingToPrivate || (isPrivateTypeClient(r.type) && !convertingToGroup);
    const showCreditCheckbox = !!r.used_referral_credit && willBePrivate;

    let bookedGroup: string | undefined;
    let sessionLabelPrefix: string | undefined;
    let newType: string | undefined;
    if (convertingToPrivate) {
      sessionLabelPrefix = "Private Session";
      newType = "private";
    } else if (convertingToGroup) {
      bookedGroup = rescheduleForm.group;
      sessionLabelPrefix = rescheduleForm.group;
      newType = "weekly";
    } else if (r.type === "weekly") {
      bookedGroup = rescheduleForm.group;
      sessionLabelPrefix = rescheduleForm.group;
    } else if (r.type === "camp" && scheduleData) {
      const opt = campOptions(scheduleData.camps).find((o) => o.key === rescheduleForm.group);
      if (opt) {
        bookedGroup = opt.camp.name;
        sessionLabelPrefix = opt.camp.gradeGroup ? `${opt.camp.name} — ${opt.camp.gradeGroup}` : opt.camp.name;
      }
    } else {
      sessionLabelPrefix = "Private Session";
    }

    const res = await fetch("/api/admin/reschedule", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: reschedulingId,
        bookedDate: rescheduleForm.date.trim(),
        bookedStartTime: rescheduleForm.start.trim(),
        bookedEndTime: rescheduleForm.end.trim(),
        bookedLocation: rescheduleForm.location.trim(),
        bookedGroup,
        bookedTrainer: rescheduleForm.trainer || undefined,
        sessionLabelPrefix,
        newType,
        keepReferralCredit: showCreditCheckbox ? rescheduleKeepCredit : undefined,
        feeChoice,
      }),
    });
    const data = await res.json();
    setRescheduleSaving(false);
    if (!res.ok) {
      if (data?.needsFeeChoice) {
        const feeExplainer = r.package_id
          ? "OK = CHARGE — the original session is forfeited from their package (no fee). If the package still has capacity, the new session is still covered; otherwise it's charged at full price.\n\nCancel = WAIVE the fee — reschedule at no cost, same as an on-time reschedule."
          : isBulkDiscountedWeekly(r, scheduleData?.weeklySchedule || [])
            ? "OK = CHARGE — the original session is fully forfeited (no refund/credit, bulk-discounted booking), and the new session is charged at full price.\n\nCancel = WAIVE the fee — reschedule at no cost, same as an on-time reschedule."
            : "OK = CHARGE the standard late fee — half of what they paid is credited to their account and applied toward the new session, the other half is kept as the fee.\n\nCancel = WAIVE the fee — reschedule at no cost, same as an on-time reschedule.";
        const charge = confirm(
          `The current session is within the 24-hour late-reschedule window.\n\n${feeExplainer}`
        );
        return submitReschedule(charge ? "charge" : "waive");
      }
      setRescheduleError(data.error || "Failed to reschedule.");
      return;
    }
    const id = reschedulingId;
    setRegistrations((prev) => prev.map((reg) => (reg.id === id ? {
      ...reg,
      type: data.newType || reg.type,
      booked_date: rescheduleForm.date.trim(),
      booked_start_time: rescheduleForm.start.trim(),
      booked_end_time: rescheduleForm.end.trim(),
      booked_location: rescheduleForm.location.trim(),
      booked_group: convertingToPrivate ? null : (bookedGroup ?? reg.booked_group),
      booked_trainer: rescheduleForm.trainer || reg.booked_trainer,
      session_price: typeof data.newSessionPrice === "number" ? data.newSessionPrice : reg.session_price,
      is_free: typeof data.newIsFree === "boolean" ? data.newIsFree : reg.is_free,
      used_referral_credit: typeof data.newUsedReferralCredit === "boolean" ? data.newUsedReferralCredit : reg.used_referral_credit,
      session_details: data.sessionDetails || reg.session_details,
    } : reg)));
    closeReschedule();
    const notes: string[] = [];
    if (data.packageSessionForfeited) {
      notes.push(`Original session forfeited from their package (late reschedule).${data.newSessionPackageCovered ? " New session still covered — nothing charged." : " Package had no capacity left for the new date."}`);
      if (data.autoChargedAmount > 0) {
        notes.push(`$${data.autoChargedAmount} (+ service fee) was automatically charged to their card on file for the new session.`);
      }
    } else if (data.fullForfeitNoRefund) {
      notes.push(`Original session fully forfeited (no refund/credit) — weekly late reschedule.`);
      if (data.autoChargedAmount > 0) {
        notes.push(`$${data.autoChargedAmount} (+ service fee) was automatically charged to their card on file for the new session at full price.`);
      }
    } else if (data.lateFeeCharged) {
      notes.push(`Late fee charged: $${data.lateFeeCredited} credited to ${r.parent_name}'s account (50% of what they paid)${data.lateFeeCreditApplied > 0 ? `, $${data.lateFeeCreditApplied} of it applied to the new session` : ""}.`);
      if (data.autoChargedAmount > 0) {
        notes.push(`$${data.autoChargedAmount} (+ service fee) was automatically charged to their card on file to cover the rest.`);
      }
    } else if (data.creditGranted > 0) {
      notes.push(`$${data.creditGranted} was credited to ${r.parent_name}'s account (new price is lower and they'd already paid).`);
    } else if (data.autoChargedAmount > 0) {
      notes.push(`$${data.autoChargedAmount} (+ service fee) was automatically charged to their card on file (new price is higher).`);
    }
    if (data.creditRefunded) {
      notes.push(`Their referral credit was refunded since it's no longer applied to this booking.`);
    }
    if (data.priceLookupFailed) {
      notes.push(`Couldn't verify the new price on the schedule sheet — the price was left unchanged, double-check it manually.`);
    }
    if (notes.length > 0) alert(`Rescheduled. ${notes.join(" ")}`);
  }

  // Cancel/Reschedule/Delete/Add-Player/payment edits are admin-only; No
  // Show is the one exception every trainer tier can still take (see RegCard
  // and CalendarView's regRowJSX) since a trainer is the one who'd actually
  // know a client didn't show up.
  const canEdit = authCtx?.role === "admin";

  // Everything the dashboard displays is scoped through this — "all" is a
  // no-op for a basic trainer account anyway, since the server already only
  // ever sent them their own sessions. within_package/weekly_discount_rate
  // are computed server-side (src/lib/admin-registration-enrichment.ts)
  // against each client's complete relevant history, not this filtered
  // view, so they stay correct regardless of what's shown here.
  // trainerNamesMatch (not ===) — booked_trainer is whatever casing was
  // live on the hand-typed schedule sheet at booking time, which can drift
  // row to row for the same real trainer (see the same fix already applied
  // server-side, e.g. checkGroupSessionCapacity). An exact-match filter
  // here would silently miss some of a trainer's own rows.
  const visibleRegistrations = useMemo(
    () => (trainerFilter === "all" ? registrations : registrations.filter((r) => trainerNamesMatch(r.booked_trainer, trainerFilter))),
    [registrations, trainerFilter]
  );

  // Seeded with every configured trainer account FIRST (so a trainer with
  // zero sessions booked yet — brand new, or just hasn't been assigned
  // anything — still shows up as a real filter option, not just names that
  // happen to already appear on a registration), then layered with whatever
  // actually shows up in registrations for anyone not already covered (the
  // owner himself, "TBD", or a substitute not yet added as a dashboard
  // account). Deduped by normalized name so a casing/whitespace variant
  // never shows up as a separate, near-identical option — one
  // representative spelling per real trainer (the configured account's
  // canonical spelling wins when both exist), which visibleRegistrations
  // above then normalized-matches against every casing variant anyway.
  const availableTrainers = useMemo(() => {
    const byNormalized = new Map<string, string>();
    for (const t of TRAINER_ACCOUNTS) {
      if (!t.trainerName) continue;
      byNormalized.set(normalizeTrainerNameForComparison(t.trainerName), t.trainerName);
    }
    for (const r of registrations) {
      const raw = r.booked_trainer || "";
      if (!raw) continue;
      const key = normalizeTrainerNameForComparison(raw);
      if (!byNormalized.has(key)) byNormalized.set(key, raw);
    }
    return uniqueSorted(Array.from(byNormalized.values()));
  }, [registrations]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    return visibleRegistrations
      // pending_payment holds a real slot (someone's mid-checkout) — worth
      // seeing here, not just hidden until the webhook confirms it.
      .filter((r) => (r.status === "confirmed" || r.status === "pending_payment") && sessionMs(r.booked_date, r.booked_start_time) > now)
      .sort((a, b) => sessionMs(a.booked_date, a.booked_start_time) - sessionMs(b.booked_date, b.booked_start_time));
  }, [visibleRegistrations]);

  // Source: whichever of these is active — a search term (bypasses the
  // window entirely), else "Load all" if it's been clicked, else the
  // default last-30-days window. The payment_abandoned/cancelled-clutter/
  // status exclusions (see keepCancelledInHistory's old logic) are now
  // applied server-side (api/admin/data's ?view=past) — this just does the
  // trainer-filter-dropdown narrowing and the exact "has this specific
  // session's time actually passed yet" cut the server's coarse
  // date-only bound can't do on its own (same two-stage pattern as
  // ?view=upcoming).
  const past = useMemo(() => {
    const now = Date.now();
    const source = pastSearchRegs ?? pastAllRegs ?? pastWindowRegs ?? [];
    const scoped = trainerFilter === "all" ? source : source.filter((r) => trainerNamesMatch(r.booked_trainer, trainerFilter));
    return scoped
      .filter((r) => sessionMs(r.booked_date, r.booked_start_time) <= now)
      .sort((a, b) => sessionMs(b.booked_date, b.booked_start_time) - sessionMs(a.booked_date, a.booked_start_time));
  }, [pastSearchRegs, pastAllRegs, pastWindowRegs, trainerFilter]);

  // Fetched from api/admin/data's ?view=clients (see the effect above) —
  // the server-side aggregate this useMemo used to compute client-side over
  // the full registrations dataset. clientMatchesSearch's name/kid-token
  // matching stays client-side since it's just filtering an already-small,
  // already-loaded list — no reason to round-trip that to the server too.
  const clients = useMemo(() => clientsList ?? [], [clientsList]);
  const filteredClients = useMemo(
    () => clients.filter((c) => clientMatchesSearch(c, clientSearch)),
    [clients, clientSearch]
  );

  // Buckets every saved athlete directly by their PERSISTED groups field —
  // never recomputed live from grade/gender — so an athlete assigned to two
  // groups (e.g. transitioning between Middle School and High School)
  // intentionally appears in both sections, and the owner's manual
  // add/move/remove edits are exactly what's reflected here.
  const groupBuckets = useMemo(() => {
    const buckets: Record<CanonicalGroupId | "all-else", { email: string; parentName: string; athlete: ProfileKid; displayName: string; sortLastName: string }[]> = {
      junior: [], "ms-boys": [], "ms-girls": [], "hs-girls": [], "hs-boys": [], "all-else": [],
    };
    for (const [email, profile] of Object.entries(profilesMap)) {
      for (const kid of profile.kids) {
        if (!kid.name || !kid.id || kid.hidden) continue;
        const { displayName, sortLastName } = groupsTabDisplayName(kid.name, profile.parentName);
        const row = { email, parentName: profile.parentName, athlete: kid, displayName, sortLastName };
        const groups = kid.groups || [];
        if (groups.length === 0) {
          buckets["all-else"].push(row);
          continue;
        }
        for (const g of groups) buckets[g]?.push(row);
      }
    }
    for (const key of Object.keys(buckets) as (CanonicalGroupId | "all-else")[]) {
      // Last name first (so siblings land next to each other), full display
      // name as a stable tiebreaker among same-last-name siblings.
      buckets[key].sort((a, b) => a.sortLastName.localeCompare(b.sortLastName) || a.displayName.localeCompare(b.displayName));
    }
    return buckets;
  }, [profilesMap]);

  async function setAthleteGroup(email: string, athleteId: string, groupId: CanonicalGroupId, action: "add" | "remove") {
    const actionKey = `${email}|${athleteId}|${groupId}`;
    setGroupActionPending(actionKey);
    try {
      const res = await fetch("/api/admin/athletes/group", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, athleteId, groupId, action }),
      });
      if (res.ok) {
        const data = await res.json();
        setProfilesMap((prev) => ({ ...prev, [email]: { ...prev[email], kids: data.kids } }));
      }
    } finally {
      setGroupActionPending(null);
    }
  }

  // Cosmetic-only: removes an athlete from the Groups tab's rendered list.
  // Does not touch their `groups` (still drives reminder emails) or
  // anything on the client's own account.
  async function hideAthleteFromGroupsTab(email: string, athleteId: string) {
    const actionKey = `hide|${email}|${athleteId}`;
    setGroupActionPending(actionKey);
    try {
      const res = await fetch("/api/admin/athletes/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, athleteId, hidden: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setProfilesMap((prev) => ({ ...prev, [email]: { ...prev[email], kids: data.kids } }));
        if (expandedGroupAthlete === `${email}|${athleteId}`) setExpandedGroupAthlete(null);
      }
    } finally {
      setGroupActionPending(null);
    }
  }

  // Merges two saved-athlete entries within the same client that are
  // actually the same kid recorded under two different name spellings
  // across past bookings (e.g. "Remy" vs "Remy Trudeau") — unions their
  // groups, keeps keepId, deletes mergeId. Always an explicit two-athlete
  // choice, never automatic — a real athlete legitimately in two groups is
  // already just one entry and never needs this.
  async function mergeAthletes(email: string, keepId: string, mergeId: string) {
    const actionKey = `merge|${email}|${mergeId}`;
    setGroupActionPending(actionKey);
    try {
      const res = await fetch("/api/admin/athletes/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, keepId, mergeId }),
      });
      if (res.ok) {
        const data = await res.json();
        setProfilesMap((prev) => ({ ...prev, [email]: { ...prev[email], kids: data.kids } }));
      }
    } finally {
      setGroupActionPending(null);
    }
  }

  // Fetched on demand when a client is clicked (see the effect above) —
  // already exact-email-filtered, payment_abandoned-excluded, and
  // date-descending sorted server-side. Every real registration has an
  // email (verified against live data — 0 of 429 rows lack one), so the
  // legacy "guest keyed by parent_name" case the old client-side filter
  // defensively handled is not reachable in practice.
  const clientRegistrations = clientDetailFor === selectedClient ? (clientDetailRegs ?? []) : [];

  // Apply type filter + search to a list
  // skipSearch: the Past tab's search is handled server-side (its `past`
  // source is already the search-matched result once a term is typed —
  // see the pastSearchRegs effect) — re-applying this client-side search
  // on top would be redundant at best and could disagree at the edges
  // with the server's own matching, so Past always passes true here.
  function applyFilters(list: Registration[], skipSearch = false) {
    return list.filter((r) => {
      if (typeFilter === "pickup") {
        if (!isPickup(r)) return false;
      } else if (typeFilter === "weekly") {
        if (r.type !== "weekly" || isPickup(r)) return false;
      } else if (typeFilter !== "all") {
        if (r.type !== typeFilter) return false;
      }
      if (!skipSearch && search.trim()) {
        // Whitespace-normalized name match (a stray double space in a saved
        // name shouldn't hide it from a normally-typed search) and
        // digits-only phone match (so searching "5551234567" finds a client
        // stored as "(555) 123-4567" and vice versa) — same normalization
        // classes already established elsewhere in this codebase for
        // exactly this reason.
        const q = search.trim().toLowerCase().replace(/\s+/g, " ");
        const qDigits = search.replace(/\D/g, "");
        const nameMatch = !!r.parent_name?.toLowerCase().replace(/\s+/g, " ").includes(q);
        const emailMatch = !!r.email?.toLowerCase().includes(q);
        const phoneMatch = !!qDigits && !!r.phone?.replace(/\D/g, "").includes(qDigits);
        if (!nameMatch && !emailMatch && !phoneMatch) return false;
      }
      return true;
    });
  }

  // Fetched from a dedicated aggregate-count endpoint (src/app/api/admin/stats)
  // instead of computed by .length-ing the full registrations dataset —
  // admin-only, same as the tiles themselves, and independent of whatever
  // subset of history is currently loaded for the active tab. Re-fetches
  // when the trainer-filter dropdown changes, preserving the same
  // "narrow the whole page (including these tiles) to one trainer" behavior
  // the old client-side version had.
  useEffect(() => {
    if (!token || authCtx?.role !== "admin") return;
    const params = trainerFilter !== "all" ? `?trainer=${encodeURIComponent(trainerFilter)}` : "";
    fetch(`/api/admin/stats${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {});
  }, [token, authCtx, trainerFilter]);


  // Session-slot capacity from the live schedule sheet, keyed the same way
  // folders are — powers the "X signed up / Y" folder header.
  const weeklyCapacity = useMemo(() => buildWeeklyCapacityMap(scheduleData?.weeklySchedule || []), [scheduleData]);
  const campCapacity = useMemo(() => buildCampCapacityMap(scheduleData?.camps || []), [scheduleData]);

  function RegCard({ r, isPast = false }: { r: Registration; isPast?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const fullSession = r.session_details
      ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()
      : "—";
    return (
      <div className="rounded-xl border-2 border-brown-600 bg-brown-900/40 overflow-hidden shadow-lg shadow-black/30">
        {/* Tappable summary row */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left px-4 py-3 flex items-start justify-between gap-2"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-sm">{r.parent_name}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${isPickup(r) ? "bg-orange-500 text-white" : "bg-amber-400 text-blue-900"}`}>{typePillLabel(r.type, r.session_details)}</span>
              {r.within_package && (
                <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium">pkg</span>
              )}
              {(() => { const da = daysAway(r.booked_date); return da ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${da.cls}`}>{da.label}</span> : null; })()}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(r.status, isPast).cls}`}>
                {statusBadge(r.status, isPast).label}
              </span>
            </div>
            <div className="text-xs text-brown-300 mt-0.5 truncate">{athleteNames(r.kids || "")}</div>
            <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
              {r.booked_date && <span className="text-mesa-accent">{formatDate(r.booked_date)}</span>}
              {r.booked_start_time && (
                <span>{r.booked_start_time}{r.booked_end_time ? `-${r.booked_end_time}` : ""}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end justify-between self-stretch">
            <span className={`text-brown-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
            {canEdit && !r.within_package && (
              <span className="text-white font-medium text-xs">{priceDisplay(r)}</span>
            )}
          </div>
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="border-t border-brown-700 px-4 py-3 space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Email</p>
                <p className="text-brown-200 break-all">{r.email || "—"}</p>
              </div>
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Phone</p>
                <p className="text-brown-200">{r.phone || "—"}</p>
              </div>
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Registered</p>
                <p className="text-brown-200">{new Date(r.created_at).toLocaleDateString()}</p>
              </div>
              <div>
                <p className="text-brown-500 uppercase tracking-wider mb-0.5">Session Date</p>
                <p className="text-mesa-accent font-medium">
                  {formatDate(r.booked_date)}
                  {r.booked_start_time && ` · ${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`}
                </p>
              </div>
              {r.booked_trainer && (
                <div>
                  <p className="text-brown-500 uppercase tracking-wider mb-0.5">Trainer</p>
                  <p className="text-brown-200">{r.booked_trainer}</p>
                </div>
              )}
              {canEdit && !r.within_package && (
                <div>
                  <p className="text-brown-500 uppercase tracking-wider mb-0.5">Price</p>
                  <p className="text-green-400 font-medium">{priceDisplay(r)}</p>
                </div>
              )}
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Athletes</p>
              <p className="text-brown-200">{r.kids ? r.kids.split(",").map((k) => k.trim()).join("\n") : "—"}</p>
              {authCtx?.role === "admin" && r.status === "confirmed" && (
                addPlayerOpenId === r.id ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={addPlayerName}
                      onChange={(e) => setAddPlayerName(e.target.value)}
                      placeholder="Player name"
                      className="min-w-0 flex-1 rounded bg-brown-950 border border-brown-700 px-2 py-1 text-xs text-white"
                    />
                    <button onClick={() => submitAddPlayer(r.id)} disabled={addPlayerSaving} className="text-xs text-mesa-accent hover:text-yellow-300 font-semibold transition disabled:opacity-50 shrink-0">
                      {addPlayerSaving ? "..." : "Add"}
                    </button>
                    <button onClick={() => { setAddPlayerOpenId(null); setAddPlayerName(""); setAddPlayerError(null); }} className="text-xs text-brown-500 hover:text-brown-300 transition shrink-0">
                      ✕
                    </button>
                  </div>
                ) : (
                  <button onClick={() => { setAddPlayerOpenId(r.id); setAddPlayerName(""); setAddPlayerError(null); }} className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition">
                    + Add Player
                  </button>
                )
              )}
              {addPlayerOpenId === r.id && addPlayerError && <p className="text-xs text-red-400 mt-1">{addPlayerError}</p>}
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Session Details</p>
              <p className="text-brown-200 whitespace-pre-line leading-relaxed">{fullSession}</p>
            </div>

            {/* Actions — Cancel/Reschedule/Delete are admin-only; No Show is
                the one action every trainer tier can also take, since
                they're the one who'd actually know a client didn't show. */}
            {(r.status === "confirmed" || (canEdit && (isPast || isDeletablePending(r)))) && (
              <div className="flex flex-wrap gap-3 pt-1 border-t border-brown-800">
                {canEdit && r.status === "confirmed" && !isPast && (
                  <button onClick={() => cancelRegistration(r.id, undefined, r)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                    {cancelling === r.id ? "Cancelling..." : "Cancel"}
                  </button>
                )}
                {canEdit && r.status === "confirmed" && !isPast && (
                  <button onClick={() => openReschedule(r)} className="text-xs text-blue-400 hover:text-blue-300 transition">
                    Reschedule
                  </button>
                )}
                {r.status === "confirmed" && noShowConfirm !== r.id && (
                  <button onClick={() => setNoShowConfirm(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 transition disabled:opacity-50">
                    No Show
                  </button>
                )}
                {r.status === "confirmed" && noShowConfirm === r.id && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-orange-300 font-semibold">Sure?</span>
                    <button onClick={() => markNoShow(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 font-semibold transition disabled:opacity-50">
                      {noShowing === r.id ? "..." : "Yes"}
                    </button>
                    <button onClick={() => setNoShowConfirm(null)} className="text-xs text-brown-500 hover:text-brown-300 transition">
                      No
                    </button>
                  </div>
                )}
                {/* For a real (confirmed) booking, Delete only ever shows once
                    its start time has passed — Cancel is the right tool for
                    an active upcoming booking, and deleting one silently
                    would mean no refund and no client notification. But a
                    pending_payment/payment_abandoned row was never a real
                    booking — nothing was charged, no slot needs freeing — so
                    it's safe to delete right away, upcoming or not, rather
                    than waiting on the automatic abandonment sweep. Admin only. */}
                {canEdit && (isPast || isDeletablePending(r)) && (
                  <button onClick={() => deleteRegistration(r.id)} disabled={deleting === r.id} className="text-xs text-brown-600 hover:text-red-500 transition disabled:opacity-50">
                    {deleting === r.id ? "Deleting..." : "Delete"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // A collapsed folder for one real weekly/pickup/camp session — expands to
  // the individual RegCards (with each athlete's info) that make it up.
  function FolderCard({ folder, isPast = false }: { folder: Folder; isPast?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const sample = folder.regs[0];
    const timeLabel = sample.booked_start_time ? `${sample.booked_start_time}${sample.booked_end_time ? `-${sample.booked_end_time}` : ""}` : null;
    return (
      <div className="rounded-xl border-2 border-brown-600 bg-brown-900/40 overflow-hidden shadow-lg shadow-black/30">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left px-4 py-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${isPickup(sample) ? "bg-orange-500 text-white" : "bg-amber-400 text-blue-900"}`}>{typePillLabel(sample.type, sample.session_details)}</span>
              <span className="font-medium text-sm">{folderLabel(sample)}</span>
              {(() => { const da = daysAway(sample.booked_date); return da ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${da.cls}`}>{da.label}</span> : null; })()}
            </div>
            <div className="text-xs text-brown-400 mt-1">
              {timeLabel && <span>{timeLabel}</span>}{sample.booked_location ? ` · ${sample.booked_location}` : ""}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end justify-between self-stretch gap-1">
            <span className={`text-brown-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
            <span className="text-mesa-accent font-medium text-xs whitespace-nowrap">
              {folderCountLabel(folder)}
            </span>
          </div>
        </button>
        {expanded && (
          <div className="border-t border-brown-700 px-3 py-3 space-y-2 bg-brown-950/40">
            {folder.regs.map((r) => <RegCard key={r.id} r={r} isPast={isPast} />)}
          </div>
        )}
      </div>
    );
  }

  function FolderAwareCardList({ list, isPast = false }: { list: Registration[]; isPast?: boolean }) {
    return (
      <div className="space-y-3">
        {buildFolders(list, weeklyCapacity, campCapacity).map((folder) =>
          folder.grouped
            ? <FolderCard key={folder.key} folder={folder} isPast={isPast} />
            : <RegCard key={folder.regs[0].id} r={folder.regs[0]} isPast={isPast} />
        )}
      </div>
    );
  }

  if (loading) {
    return <div className="min-h-screen bg-brown-950 flex items-center justify-center"><p className="text-brown-400">Loading...</p></div>;
  }

  const displayedUpcoming = applyFilters(upcoming);
  const displayedPast = applyFilters(past, true);

  return (
    <div className="min-h-screen bg-brown-950 text-white flex flex-col w-full max-w-full">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="h-10 w-10 sm:h-14 sm:w-14 shrink-0 rounded-full bg-white border border-gray-100 overflow-hidden flex items-center justify-center hover:opacity-80 transition">
              <img src="/logo.png" alt="Mesa" className="h-10 w-10 sm:h-14 sm:w-14 object-contain scale-125" />
            </Link>
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-oswald)] text-base sm:text-xl font-bold tracking-wide text-mesa-dark leading-tight">ADMIN</p>
              <p className="text-xs text-brown-500 leading-tight">Dashboard</p>
            </div>
          </div>
        </div>
      </div>
      {/* Mobile tab bar */}
      <div className="md:hidden border-b border-gray-200 bg-white px-4 flex items-center gap-1 overflow-x-auto">
        <Link href="/admin" className="shrink-0 px-3 py-2.5 text-sm font-semibold text-mesa-dark border-b-2 border-mesa-dark">Dashboard</Link>
        {authCtx?.role === "admin" && <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Payments</Link>}
        <Link href="/admin/packages" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Packages</Link>
        {authCtx?.role === "admin" && <Link href="/admin/virtual-training" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Virtual Training</Link>}
        {authCtx?.role === "admin" && <Link href="/admin/virtual-training/drills" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Drills</Link>}
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-2">
          <Link href="/" className="text-xs text-brown-400">← Site</Link>
        </div>
      </div>

      <div className="flex flex-1 min-w-0 w-full">
        {/* Sidebar — desktop only */}
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-brown-800 bg-brown-900/30 px-3 py-6 sticky top-0 h-screen">
          <nav className="flex-1 space-y-1">
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
              Dashboard
            </Link>
            {authCtx?.role === "admin" && (
              <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
                Payments
              </Link>
            )}
            <Link href="/admin/packages" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Packages
            </Link>
            {authCtx?.role === "admin" && (
              <>
                <Link href="/admin/virtual-training" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
                  Virtual Training
                </Link>
                <Link href="/admin/virtual-training/drills" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
                  Drills
                </Link>
              </>
            )}
          </nav>
          <div className="border-t border-brown-800 pt-4 mt-4 space-y-1">
            <Link href="/" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              ← Back to Site
            </Link>
            <button
              onClick={() => authClient.auth.signOut().then(() => router.push("/login"))}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition"
            >
              Sign Out
            </button>
          </div>
        </aside>

      <div className="flex-1 min-w-0 px-4 sm:px-6 py-8">
        {/* Stats — admin only */}
        {authCtx?.role === "admin" && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            {[
              { label: "Total", value: stats?.total },
              { label: "Confirmed", value: stats?.confirmed },
              { label: "Cancelled", value: stats?.cancelled },
              { label: "Camp Bookings", value: stats?.camps },
              { label: "Group Bookings", value: stats?.groups },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-4 text-center">
                <p className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-mesa-accent">{s.value ?? "—"}</p>
                <p className="text-xs text-brown-400 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Time Change Sync — auto-runs on load, button is manual re-run */}
        {tcResult && tcResult.changesFound.length > 0 && (
          <div className="mb-6 rounded-xl border border-green-800 bg-green-950/40 px-4 py-3 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-green-300">Time change detected and handled</p>
              <div className="text-xs text-green-400/80 mt-0.5 space-y-0.5">
                {tcResult.changesFound.map((c, i) => (
                  <p key={i}>{c.session}: {c.oldTime} → {c.newTime} — {c.count} registrant{c.count !== 1 ? "s" : ""} notified</p>
                ))}
              </div>
            </div>
            <span className="text-xs text-green-500 shrink-0">{tcResult.totalEmailsSent} email{tcResult.totalEmailsSent !== 1 ? "s" : ""}, {tcResult.totalSmsSent} SMS sent</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {(authCtx?.role === "admin" ? (["upcoming", "schedule", "past", "calendar", "clients", "groups"] as const) : (["upcoming", "schedule", "past", "calendar"] as const)).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedClient(null); }}
              className={`px-3 py-2 rounded-lg text-sm font-semibold capitalize transition ${tab === t ? "bg-mesa-accent text-white" : "bg-brown-900 text-brown-400 hover:text-white"}`}
            >
              {t === "upcoming" ? `Upcoming (${upcoming.length})` : t === "schedule" ? "My Schedule" : t === "past" ? "Past" : t === "calendar" ? (
                <span className="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  Calendar
                </span>
              ) : t === "clients" ? "Clients" : "Groups"}
            </button>
          ))}
        </div>

        {/* Trainer filter — admin and elevated trainer accounts only; applies across Upcoming/Past/Calendar (admin also gets Clients, elevated trainer does not) */}
        {(authCtx?.role === "admin" || authCtx?.role === "elevated_trainer") && availableTrainers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <span className="text-xs uppercase tracking-wider text-brown-500">Trainer</span>
            <select
              value={trainerFilter}
              onChange={(e) => setTrainerFilter(e.target.value)}
              className="rounded-lg border border-brown-700 bg-brown-800/60 px-3 py-1.5 text-sm text-white focus:border-mesa-accent focus:outline-none"
            >
              <option value="all">All Trainers</option>
              {availableTrainers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        {/* Filters — list tabs only */}
        {(tab === "upcoming" || tab === "past") && (
          <div className="flex flex-wrap gap-3 mb-6">
            <input
              type="text"
              placeholder="Search by name, email, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none w-full sm:w-64"
            />
            <div className="flex flex-wrap gap-1">
              {["all", "weekly", "pickup", "camp", "private", "group-private"].map((t) => (
                <button key={t} onClick={() => setTypeFilter(t)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${typeFilter === t ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}>
                  {t === "all" ? "All Types" : TYPE_LABELS[t] || t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Upcoming */}
        {tab === "upcoming" && (
          <>
            {(() => {
              const todayKey = toDateKey(new Date());
              const todayLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
              const todaySessions = displayedUpcoming.filter(r => r.booked_date && toDateKey(new Date(r.booked_date)) === todayKey);
              const futureSessions = displayedUpcoming.filter(r => !r.booked_date || toDateKey(new Date(r.booked_date)) !== todayKey);
              // visibleRegistrations (unlike displayedUpcoming/upcoming) isn't cut
              // by "has this session's start time already passed" — the server's
              // ?view=upcoming query only bounds by date (today-or-later), so a
              // today-dated row whose time already passed is still in here. That
              // makes this the right source to tell "genuinely nothing was ever
              // scheduled today" apart from "today's sessions already happened."
              const hadSessionsToday = applyFilters(
                visibleRegistrations.filter(r => r.booked_date && toDateKey(new Date(r.booked_date)) === todayKey)
              ).length > 0;
              return (
                <>
                  <p className="text-xs text-brown-500 mb-3">{displayedUpcoming.length} session{displayedUpcoming.length !== 1 ? "s" : ""}</p>
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">Today — {todayLabel}</div>
                      {todaySessions.length === 0
                        ? <p className="text-xs text-brown-500 italic py-1">{hadSessionsToday ? "No more sessions scheduled for today." : "No sessions scheduled for today."}</p>
                        : <FolderAwareCardList list={todaySessions} />
                      }
                    </div>
                    {groupByDate(futureSessions).map(({ key, label, sessions }) => (
                      <div key={key}>
                        <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">{label}</div>
                        <FolderAwareCardList list={sessions} />
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </>
        )}

        {/* Schedule — what's actually assigned on the schedule sheet,
            regardless of whether anyone's booked it yet */}
        {tab === "schedule" && (
          <>
            {rosterLoading && rosterGroupSessions === null ? (
              <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">Loading…</div>
            ) : (() => {
              const groups = rosterGroupSessions || [];
              const privates = rosterPrivateWindows || [];
              const dayMap = new Map<string, { label: string; ms: number; groups: RosterGroupSession[]; privates: RosterPrivateWindow[] }>();
              const ensureDay = (date: string) => {
                if (!dayMap.has(date)) {
                  dayMap.set(date, { label: formatDateHeader(date), ms: new Date(date).getTime() || 0, groups: [], privates: [] });
                }
                return dayMap.get(date)!;
              };
              groups.forEach((g) => ensureDay(g.date).groups.push(g));
              privates.forEach((p) => ensureDay(p.date).privates.push(p));
              const days = Array.from(dayMap.values()).sort((a, b) => a.ms - b.ms);
              const showTrainerLabel = trainerFilter === "all" && (authCtx?.role === "admin" || authCtx?.role === "elevated_trainer");

              if (days.length === 0) {
                return <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">Nothing scheduled.</div>;
              }

              return (
                <div className="space-y-4">
                  {days.map((day) => (
                    <div key={day.label}>
                      <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">{day.label}</div>
                      <div className="space-y-2">
                        {day.groups.map((g, i) => (
                          <div key={`g-${i}`} className="rounded-lg border border-brown-700 bg-brown-800/40 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="text-sm font-semibold text-white">{g.group}</span>
                              <span className="text-xs text-brown-400 ml-2">{g.startTime}–{g.endTime} • {g.location}{showTrainerLabel ? ` • ${g.trainer}` : ""}</span>
                            </div>
                            <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${g.enrolled === 0 ? "bg-brown-700 text-brown-300" : "bg-mesa-accent/20 text-mesa-accent"}`}>
                              {g.enrolled}/{g.maxSpots} signed up
                            </span>
                          </div>
                        ))}
                        {day.privates.map((p, i) => (
                          <div key={`p-${i}`} className="rounded-lg border border-brown-700 bg-brown-800/20 px-3 py-2 text-sm text-brown-300">
                            <span className="font-semibold text-white">Private availability</span>
                            <span className="text-xs text-brown-400 ml-2">{p.startTime}–{p.endTime} • {p.location}{showTrainerLabel ? ` • ${p.trainer}` : ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        {/* Past */}
        {tab === "past" && (
          <>
            {pastLoading && pastWindowRegs === null ? (
              <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">Loading…</div>
            ) : (
              <>
                <p className="text-xs text-brown-500 mb-3">
                  {displayedPast.length} session{displayedPast.length !== 1 ? "s" : ""}
                  {!search.trim() && !pastAllRegs && " (last 30 days)"}
                  {pastSearchLoading && " — searching…"}
                </p>
                <div className="space-y-4">
                  {displayedPast.length === 0 && <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">No past sessions.</div>}
                  {groupByDate(displayedPast).map(({ key, label, sessions }) => (
                    <div key={key}>
                      <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">{label}</div>
                      <FolderAwareCardList list={sessions} isPast />
                    </div>
                  ))}
                </div>
                {!search.trim() && !pastAllRegs && pastHasMore && (
                  <button
                    onClick={loadAllPast}
                    disabled={pastLoadingAll}
                    className="mt-4 w-full rounded-lg border border-brown-700 px-4 py-2.5 text-sm text-brown-300 hover:text-white hover:border-mesa-accent transition disabled:opacity-50"
                  >
                    {pastLoadingAll ? "Loading…" : "Load all past sessions"}
                  </button>
                )}
              </>
            )}
          </>
        )}

        {/* Calendar — all sessions combined */}
        {tab === "calendar" && (
          <div className="rounded-xl border border-brown-700 bg-brown-900/20 p-4">
            <CalendarView
              token={token}
              trainerFilter={trainerFilter}
              weeklyCapacity={weeklyCapacity}
              campCapacity={campCapacity}
              canEdit={canEdit}
              cancelRegistration={cancelRegistration}
              markNoShow={markNoShow}
              openReschedule={openReschedule}
              deleteRegistration={deleteRegistration}
              cancelling={cancelling}
              noShowing={noShowing}
              noShowConfirm={noShowConfirm}
              setNoShowConfirm={setNoShowConfirm}
              deleting={deleting}
            />
          </div>
        )}

        {/* Clients */}
        {tab === "clients" && authCtx?.role === "admin" && !selectedClient && (
          <>
            <input
              type="text"
              placeholder="Search by parent or player first or last name..."
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              className="mb-4 rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none w-full sm:w-80"
            />
            <div className="space-y-2">
              {clientsLoading && clientsList === null && (
                <p className="text-sm text-brown-500 py-4 text-center">Loading…</p>
              )}
              {!(clientsLoading && clientsList === null) && filteredClients.length === 0 && (
                <p className="text-sm text-brown-500 py-4 text-center">No clients found.</p>
              )}
              {filteredClients.map((c) => (
              <button
                key={c.email || c.name}
                onClick={() => setSelectedClient(c.email || c.name)}
                className="w-full text-left rounded-xl border-2 border-brown-600 bg-brown-900/40 hover:bg-brown-800/60 px-4 py-3 transition shadow-lg shadow-black/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs text-brown-400 mt-0.5">{c.kids}</div>
                    <div className="flex flex-col gap-0.5 mt-1 text-xs text-brown-500">
                      <span>{c.phone}</span>
                      <span className="truncate">{c.email}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right space-y-1">
                    <div className="text-mesa-accent font-bold text-sm">{c.count}</div>
                    <div className="text-xs text-brown-500">session{c.count !== 1 ? "s" : ""}</div>
                    {c.athleteCount > 0 && (
                      <div className="text-xs text-brown-500">{c.athleteCount} athlete{c.athleteCount !== 1 ? "s" : ""}</div>
                    )}
                    {c.referralsTotal > 0 && (
                      <div className="rounded-full px-2 py-0.5 text-xs font-medium bg-purple-900/40 text-purple-300">
                        {c.referralsAvailable} avail / {c.referralsTotal} total ref{c.referralsTotal !== 1 ? "s" : ""}
                      </div>
                    )}
                    {c.videoConsent !== null && (
                      <div className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.videoConsent ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
                        {c.videoConsent ? "filming ✓" : "no filming"}
                      </div>
                    )}
                  </div>
                </div>
              </button>
              ))}
            </div>
          </>
        )}

        {/* Client detail */}
        {tab === "clients" && authCtx?.role === "admin" && selectedClient && (() => {
          const clientData = clients.find((c) => (c.email || c.name) === selectedClient);
          const profile = clientDetailFor === selectedClient ? clientDetailProfile : undefined;
          const kids: ProfileKid[] = profile?.kids?.length
            ? profile.kids
            : clientData && clientData.kids !== "—"
              ? clientData.kids.split(",").map((n) => ({ name: n.trim(), dob: "", grade: "" }))
              : [];
          const phone = profile?.phone || clientData?.phone || "";
          return (
            <>
              <button onClick={() => setSelectedClient(null)} className="text-sm text-mesa-accent hover:underline mb-4 inline-block">← All Clients</button>
              {clientData && (
                <div className="mb-4 rounded-xl border-2 border-brown-600 bg-brown-900/40 px-4 py-3 shadow-lg shadow-black/30">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-semibold text-base text-white">{clientData.name}</p>
                      <div className="mt-1 text-sm text-brown-300 space-y-0.5">
                        <p className="break-all">{clientData.email || "—"}</p>
                        <p>{phone || "—"}</p>
                      </div>
                    </div>
                    {kids.length > 0 && (
                      <div className="min-w-0">
                        <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-1">Players</p>
                        <div className="space-y-0.5">
                          {kids.map((k, i) => (
                            <div key={i} className="text-sm text-brown-200">
                              <p>
                                <span className="font-medium">{k.name}</span>
                                {k.dob && <span className="text-brown-400"> · DOB {k.dob}</span>}
                                {k.grade && <span className="text-brown-400"> · Grade {k.grade}</span>}
                                {k.gender && <span className="text-brown-400"> · {k.gender}</span>}
                              </p>
                              {k.groups && k.groups.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                  {k.groups.map((g) => (
                                    <span key={g} className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-mesa-accent/20 text-mesa-accent">
                                      {CANONICAL_GROUPS.find((cg) => cg.id === g)?.label || g}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {clientData && (
                <div className="mb-4 rounded-xl border-2 border-brown-600 bg-brown-900/40 px-4 py-3 flex items-center gap-6 shadow-lg shadow-black/30">
                  <div className="text-center">
                    <p className="text-mesa-accent font-bold text-xl leading-none">{clientData.count}</p>
                    <p className="text-xs text-brown-500 mt-1">session{clientData.count !== 1 ? "s" : ""}</p>
                  </div>
                  <div className="w-px h-8 bg-brown-700" />
                  <div className="text-center">
                    <p className="text-purple-300 font-bold text-xl leading-none">{clientData.referralsAvailable}</p>
                    <p className="text-xs text-brown-500 mt-1">credit{clientData.referralsAvailable !== 1 ? "s" : ""} available</p>
                  </div>
                  <div className="w-px h-8 bg-brown-700" />
                  <div className="text-center">
                    <p className="text-purple-400 font-bold text-xl leading-none">{clientData.referralsTotal}</p>
                    <p className="text-xs text-brown-500 mt-1">total referral{clientData.referralsTotal !== 1 ? "s" : ""} given</p>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                {clientDetailLoading && clientDetailFor !== selectedClient ? (
                  <p className="text-brown-500 text-sm">Loading…</p>
                ) : (
                  <>
                    {clientRegistrations.map((r) => <RegCard key={r.id} r={r} isPast={sessionMs(r.booked_date, r.booked_start_time) < Date.now()} />)}
                    {clientRegistrations.length === 0 && <p className="text-brown-500 text-sm">No registrations found.</p>}
                  </>
                )}
              </div>
            </>
          );
        })()}

        {/* Groups */}
        {tab === "groups" && authCtx?.role === "admin" && !groupsLoaded && (
          <p className="text-sm text-brown-500 py-4 text-center">Loading…</p>
        )}
        {tab === "groups" && authCtx?.role === "admin" && groupsLoaded && (
          <div className="space-y-6">
            {[...CANONICAL_GROUPS, { id: "all-else" as const, label: "All Else" }].map((g) => {
              const rows = groupBuckets[g.id];
              return (
                <div key={g.id}>
                  <h3 className="mb-3 rounded-lg bg-mesa-accent px-4 py-3 text-xl font-extrabold uppercase tracking-wide text-brown-900 shadow-lg shadow-black/30">
                    {g.label} <span className="text-base font-semibold normal-case text-brown-800">({rows.length})</span>
                  </h3>
                  {rows.length === 0 ? (
                    <p className="text-sm text-brown-500">No athletes.</p>
                  ) : (
                    <div className="space-y-2">
                      {rows.map(({ email, parentName, athlete, displayName }) => {
                        const rowKey = `${email}|${athlete.id}`;
                        const isExpanded = expandedGroupAthlete === rowKey;
                        const otherKids = (profilesMap[email]?.kids || []).filter((k) => k.id !== athlete.id);
                        const hidePending = groupActionPending === `hide|${email}|${athlete.id}`;
                        return (
                          <div key={rowKey} className="rounded-xl border-2 border-brown-600 bg-brown-900/40 px-4 py-3 shadow-lg shadow-black/30">
                            <div className="flex items-center justify-between gap-3">
                              <button
                                type="button"
                                onClick={() => setExpandedGroupAthlete(isExpanded ? null : rowKey)}
                                className="flex-1 min-w-0 text-left flex items-center justify-between gap-3"
                              >
                                <div className="min-w-0">
                                  <span className="font-medium text-sm text-white">{displayName}</span>
                                  <span className="text-brown-400 text-xs ml-2">
                                    {athlete.grade ? `Grade ${athlete.grade}` : ""}{athlete.grade && athlete.gender ? " · " : ""}{athlete.gender || ""}
                                  </span>
                                </div>
                                <span className="text-brown-500 text-xs shrink-0">{isExpanded ? "▲" : "▼"}</span>
                              </button>
                              <button
                                type="button"
                                disabled={hidePending || !athlete.id}
                                onClick={() => athlete.id && hideAthleteFromGroupsTab(email, athlete.id)}
                                title="Remove from this view (doesn't affect their account)"
                                className="shrink-0 text-brown-500 hover:text-red-400 text-lg leading-none disabled:opacity-50"
                              >
                                &times;
                              </button>
                            </div>
                            {isExpanded && (
                              <div className="mt-3 pt-3 border-t border-brown-700 space-y-3">
                                <div className="text-sm">
                                  <p className="text-white font-medium">{parentName || "—"}</p>
                                  <p className="text-brown-400 text-xs break-all">{email}</p>
                                </div>
                                {otherKids.length > 0 && (
                                  <div>
                                    <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-1">
                                      Other Athletes <span className="normal-case text-brown-600">(same kid under a different spelling? merge them)</span>
                                    </p>
                                    <div className="space-y-1">
                                      {otherKids.map((k) => {
                                        const mergePending = groupActionPending === `merge|${email}|${k.id}`;
                                        const otherDisplayName = groupsTabDisplayName(k.name, parentName).displayName;
                                        return (
                                          <div key={k.id} className="flex items-center justify-between gap-2 text-xs text-brown-300">
                                            <span>{otherDisplayName}{k.grade ? ` · Grade ${k.grade}` : ""}{k.gender ? ` · ${k.gender}` : ""}</span>
                                            <button
                                              type="button"
                                              disabled={mergePending || !athlete.id || !k.id}
                                              onClick={() => athlete.id && k.id && mergeAthletes(email, athlete.id!, k.id!)}
                                              className="shrink-0 text-mesa-accent hover:text-yellow-300 disabled:opacity-50"
                                            >
                                              {mergePending ? "Merging..." : `Merge into ${displayName}`}
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                                <div>
                                  <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-1">Groups</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {CANONICAL_GROUPS.map((cg) => {
                                      const assigned = (athlete.groups || []).includes(cg.id);
                                      const actionKey = `${email}|${athlete.id}|${cg.id}`;
                                      const pending = groupActionPending === actionKey;
                                      return (
                                        <button
                                          key={cg.id}
                                          type="button"
                                          disabled={pending || !athlete.id}
                                          onClick={() => athlete.id && setAthleteGroup(email, athlete.id, cg.id, assigned ? "remove" : "add")}
                                          className={`rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                                            assigned ? "bg-mesa-accent text-white" : "bg-brown-800 text-brown-400 hover:text-white"
                                          }`}
                                        >
                                          {assigned ? "✓ " : "+ "}{cg.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>
      </div>

      {/* Admin reschedule modal */}
      {reschedulingId && (() => {
        const r = reschedulingReg;
        if (!r) return null;

        // For the confirm-step "To" label: converting clears the group in favor
        // of "Private Session" (or vice versa); weekly uses the group name as-is;
        // camp resolves the picked option key back to "Name — GradeGroup".
        const convertingToPrivate = r.type === "weekly" && rescheduleConvertToPrivate;
        const convertingToGroup = isPrivateTypeClient(r.type) && rescheduleConvertToGroup;
        const toGroupLabel = convertingToPrivate
          ? "Private Session"
          : convertingToGroup
            ? rescheduleForm.group
            : r.type === "weekly"
              ? rescheduleForm.group
              : r.type === "camp" && scheduleData
                ? campOptions(scheduleData.camps).find((o) => o.key === rescheduleForm.group)?.label
                : undefined;

        if (rescheduleStep === "confirm") {
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => closeReschedule()}>
              <div className="w-full max-w-sm rounded-xl bg-brown-900 border border-brown-700 p-5" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-semibold text-white mb-1">Confirm Reschedule</h3>
                <p className="text-xs text-brown-400 mb-3">{r.parent_name} — {athleteNames(r.kids || "")}</p>
                <div className="rounded-lg border border-brown-700 bg-brown-950 p-3 space-y-2 text-xs">
                  <div>
                    <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-0.5">From</p>
                    {r.booked_group && <p className="text-brown-300">{r.booked_group}</p>}
                    <p className="text-brown-300">{formatDate(r.booked_date)} · {r.booked_start_time}{r.booked_end_time ? `-${r.booked_end_time}` : ""}</p>
                    <p className="text-brown-400">{r.booked_location}</p>
                  </div>
                  <div className="border-t border-brown-800 pt-2">
                    <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-0.5">To</p>
                    {toGroupLabel && <p className="text-white font-medium">{toGroupLabel}</p>}
                    <p className="text-white font-medium">{rescheduleForm.date} · {rescheduleForm.start}-{rescheduleForm.end}</p>
                    <p className="text-mesa-accent">{rescheduleForm.location}</p>
                  </div>
                </div>
                {(() => {
                  const targetIsPrivate = convertingToPrivate || (isPrivateTypeClient(r.type) && !convertingToGroup);
                  const targetIsWeekly = convertingToGroup || (r.type === "weekly" && !convertingToPrivate);
                  let newFull: number | undefined;
                  if (targetIsPrivate) {
                    const durationMins = Math.max(60, parseTimeToMinsClient(rescheduleForm.end) - parseTimeToMinsClient(rescheduleForm.start));
                    newFull = calcPrivatePricePreview(durationMins, r.total_participants || 1, getTrainerTier(rescheduleForm.trainer || r.booked_trainer));
                  } else if (targetIsWeekly && typeof rescheduleForm.price === "number") {
                    newFull = Math.round(rescheduleForm.price * (r.total_participants || 1));
                  }
                  if (newFull === undefined) {
                    return <p className="text-[11px] text-brown-500 mt-2">Price isn&apos;t auto-tracked for camps — adjust manually if needed.</p>;
                  }

                  const showCreditCheckbox = !!r.used_referral_credit && targetIsPrivate;
                  // Discounts only apply to private sessions — moving away from
                  // private always drops it, regardless of the checkbox.
                  const newIsFreePreview = !targetIsPrivate ? false : (showCreditCheckbox ? rescheduleKeepCredit : !!r.is_free);

                  const appliedCredit = r.applied_account_credit || 0;
                  const oldAmount = Math.max(0, effectiveAmountPreview(r.session_price ?? 0, !!r.is_free, isPrivateTypeClient(r.type), !!r.used_referral_credit) - appliedCredit);
                  const newAmount = Math.max(0, effectiveAmountPreview(newFull, newIsFreePreview, targetIsPrivate, !!r.used_referral_credit) - appliedCredit);
                  const delta = newAmount - oldAmount;

                  return (
                    <>
                      <div className="rounded-lg border border-brown-700 bg-brown-950 p-3 mt-2 text-xs">
                        <p className="text-brown-500 uppercase tracking-wider text-[10px] mb-1">Price</p>
                        <p className="text-brown-300">${oldAmount} → <span className="text-white font-medium">${newAmount}</span></p>
                        {delta !== 0 ? (
                          <p className={`mt-1 font-medium ${delta > 0 ? "text-orange-400" : "text-green-400"}`}>
                            {delta > 0 ? `$${delta} owed` : `$${-delta} credited for next booking`}
                          </p>
                        ) : (
                          <p className="text-brown-500 mt-1">No price change.</p>
                        )}
                      </div>
                      {showCreditCheckbox && !rescheduleKeepCredit && (
                        <p className="text-[11px] text-amber-400 mt-1">1 referral credit will be refunded to their account.</p>
                      )}
                    </>
                  );
                })()}
                {rescheduleError && <p className="text-xs text-red-400 mt-2">{rescheduleError}</p>}
                <p className="text-[11px] text-brown-500 mt-3">If the current session is within 24 hours, you&apos;ll be asked whether to waive or charge the late fee. The client will get an email/text about the change.</p>
                <div className="flex gap-3 mt-4">
                  <button onClick={() => submitReschedule()} disabled={rescheduleSaving} className="flex-1 rounded-lg bg-mesa-accent text-white text-sm font-semibold py-2 disabled:opacity-50">
                    {rescheduleSaving ? "Sending..." : "Confirm & Send"}
                  </button>
                  <button onClick={() => setRescheduleStep("edit")} disabled={rescheduleSaving} className="rounded-lg border border-brown-700 text-brown-300 text-sm px-4 py-2 disabled:opacity-50">
                    Back
                  </button>
                </div>
                <button onClick={() => closeReschedule()} disabled={rescheduleSaving} className="mt-2 w-full text-center text-xs text-brown-500 hover:text-brown-300 transition disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          );
        }

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => closeReschedule()}>
            <div className="w-full max-w-sm rounded-xl bg-brown-900 border border-brown-700 p-5" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-white mb-1">Reschedule Session</h3>
              <p className="text-xs text-brown-400 mb-3">{r.parent_name} — {athleteNames(r.kids || "")}</p>
              {r.type === "weekly" && (
                <div className="flex rounded-lg border border-brown-700 overflow-hidden mb-3 text-xs font-medium">
                  <button
                    onClick={() => { setRescheduleConvertToPrivate(false); setRescheduleForm({ group: "", date: "", start: "", end: "", location: "", trainer: "" }); }}
                    className={`flex-1 py-1.5 transition ${!rescheduleConvertToPrivate ? "bg-mesa-accent text-white" : "bg-brown-950 text-brown-400 hover:text-white"}`}
                  >
                    Group Session
                  </button>
                  <button
                    onClick={() => { setRescheduleConvertToPrivate(true); setRescheduleForm({ group: "", date: "", start: "", end: "", location: "", trainer: "" }); }}
                    className={`flex-1 py-1.5 transition ${rescheduleConvertToPrivate ? "bg-mesa-accent text-white" : "bg-brown-950 text-brown-400 hover:text-white"}`}
                  >
                    Convert to Private
                  </button>
                </div>
              )}
              {isPrivateTypeClient(r.type) && (
                <div className="flex rounded-lg border border-brown-700 overflow-hidden mb-3 text-xs font-medium">
                  <button
                    onClick={() => { setRescheduleConvertToGroup(false); setRescheduleForm({ group: "", date: r.booked_date || "", start: r.booked_start_time || "", end: r.booked_end_time || "", location: r.booked_location || "", trainer: r.booked_trainer || "" }); }}
                    className={`flex-1 py-1.5 transition ${!rescheduleConvertToGroup ? "bg-mesa-accent text-white" : "bg-brown-950 text-brown-400 hover:text-white"}`}
                  >
                    Private Session
                  </button>
                  <button
                    onClick={() => { setRescheduleConvertToGroup(true); setRescheduleForm({ group: "", date: "", start: "", end: "", location: "", trainer: "" }); }}
                    className={`flex-1 py-1.5 transition ${rescheduleConvertToGroup ? "bg-mesa-accent text-white" : "bg-brown-950 text-brown-400 hover:text-white"}`}
                  >
                    Convert to Group
                  </button>
                </div>
              )}
              <div className="space-y-2">
                {!scheduleData ? (
                  <p className="text-xs text-brown-500">Loading available sessions…</p>
                ) : (scheduleData.weeklySchedule.length === 0 && scheduleData.camps.length === 0 && scheduleData.privateSlots.length === 0) ? (
                  renderManualRescheduleFields(rescheduleForm, setRescheduleForm)
                ) : r.type === "weekly" && rescheduleConvertToPrivate ? (
                  renderPrivateRescheduleFields(scheduleData.privateSlots, rescheduleForm, setRescheduleForm)
                ) : r.type === "weekly" ? (
                  renderWeeklyRescheduleFields(scheduleData.weeklySchedule, rescheduleForm, setRescheduleForm)
                ) : r.type === "camp" ? (
                  renderCampRescheduleFields(scheduleData.camps, rescheduleForm, setRescheduleForm)
                ) : isPrivateTypeClient(r.type) && rescheduleConvertToGroup ? (
                  renderWeeklyRescheduleFields(scheduleData.weeklySchedule, rescheduleForm, setRescheduleForm)
                ) : (
                  // Preserve the original booking's own duration (e.g. a 90
                  // or 120-min session) rather than defaulting to 60 — the
                  // time picker only offers starts that leave at least that
                  // much room in the window.
                  renderPrivateRescheduleFields(
                    scheduleData.privateSlots,
                    rescheduleForm,
                    setRescheduleForm,
                    Math.max(60, parseTimeToMinsClient(r.booked_end_time || "") - parseTimeToMinsClient(r.booked_start_time || ""))
                  )
                )}
              </div>
              {rescheduleConvertToPrivate && (
                <p className="text-[11px] text-amber-400 mt-2">Price will be recalculated for a private session based on duration and player count.</p>
              )}
              {isPrivateTypeClient(r.type) && rescheduleConvertToGroup && (
                <p className="text-[11px] text-amber-400 mt-2">Price will be recalculated using the new group&apos;s rate.</p>
              )}
              {!!r.used_referral_credit && ((r.type === "weekly" && rescheduleConvertToPrivate) || (isPrivateTypeClient(r.type) && !rescheduleConvertToGroup)) && (
                <label className="flex items-start gap-2 mt-2 text-xs text-brown-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rescheduleKeepCredit}
                    onChange={(e) => setRescheduleKeepCredit(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{`Apply the same referral credit used on the original booking ($${REFERRAL_CREDIT_SESSION_PRICE} flat)`}</span>
                </label>
              )}
              {rescheduleError && <p className="text-xs text-red-400 mt-2">{rescheduleError}</p>}
              <p className="text-[11px] text-brown-500 mt-3">If the current session is within 24 hours, you&apos;ll be asked whether to waive or charge the late fee. If the new session costs more, the difference (or the fee remainder) is charged automatically to the card on file. The client will get an email/text about the change.</p>
              <div className="flex gap-3 mt-4">
                <button onClick={reviewReschedule} disabled={!scheduleData} className="flex-1 rounded-lg bg-mesa-accent text-white text-sm font-semibold py-2 disabled:opacity-50">
                  Review Change
                </button>
                <button onClick={() => closeReschedule()} className="rounded-lg border border-brown-700 text-brown-300 text-sm px-4 py-2">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
