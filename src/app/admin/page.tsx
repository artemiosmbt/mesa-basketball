"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";
import type { WeeklySession, Camp, PrivateSlot } from "@/lib/sheets";

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
}

interface PackageData {
  id: string;
  email: string;
  package_type: number;
  month_year: string;
  is_paid: boolean;
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

function dateMs(d: string | null): number {
  if (!d) return 0;
  const p = new Date(d);
  return isNaN(p.getTime()) ? 0 : p.setHours(0, 0, 0, 0);
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

function athleteNames(kids: string) {
  return kids ? kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ") : "—";
}

function sessionText(details: string) {
  return details ? details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").split("\n")[0] : "—";
}

function formatPrice(price: number | null): string {
  if (price == null) return "—";
  return `$${price}`;
}

function fullPriceForType(type: string): number {
  if (type === "group-private") return 250;
  if (type === "private") return 150;
  return 50;
}

function effectivePrice(r: Registration, weeklyDiscountRates?: Map<string, number>): number {
  const isPrivateType = r.type === "private" || r.type === "group-private";
  let basePrice: number;
  if (r.session_price != null) {
    basePrice = r.session_price;
  } else if (r.type === "weekly" && r.referral_code && weeklyDiscountRates?.has(r.referral_code)) {
    const discount = weeklyDiscountRates.get(r.referral_code)!;
    basePrice = Math.round(50 * (r.total_participants || 1) * (1 - discount));
  } else {
    basePrice = fullPriceForType(r.type);
  }
  const discounted = r.is_free && isPrivateType ? Math.round(basePrice * 0.5) : basePrice;
  // session_price/basePrice is always the full pre-credit rate — account
  // credit applied at booking time is a separate field and has to be
  // subtracted here, or this shows what they'd owe with no credit at all.
  return Math.max(0, discounted - (r.applied_account_credit || 0));
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

function calcPrivatePricePreview(durationMins: number, kidCount: number): number {
  return Math.round((kidCount >= 4 ? 250 : 150) * (durationMins / 60) * 100) / 100;
}

function isPrivateTypeClient(type: string): boolean {
  return type === "private" || type === "group-private";
}

// The DB stores the FULL (undiscounted) session_price for private sessions —
// the 50% referral-credit/first-time discount is applied at display time via
// is_free, mirroring effectivePrice() and the server's identical logic.
function effectiveAmountPreview(fullPrice: number, isFree: boolean, isPriv: boolean): number {
  return isFree && isPriv ? Math.round(fullPrice * 0.5) : fullPrice;
}

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

function renderPrivateRescheduleFields(privateSlots: PrivateSlot[], form: RescheduleForm, setForm: (f: RescheduleForm) => void) {
  const dates = uniqueSorted(privateSlots.map((s) => s.date)).sort((a, b) => dateSortKey(a) - dateSortKey(b));
  const slotsForDate = privateSlots.filter((s) => s.date === form.date);
  const times = Array.from(new Set(slotsForDate.map((s) => s.startTime)));
  const slotsForTime = slotsForDate.filter((s) => s.startTime === form.start);
  const locations = Array.from(new Set(slotsForTime.map((s) => s.location)));

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
          <label className={RESCHEDULE_LABEL_CLASS}>Time</label>
          <select
            value={form.start}
            onChange={(e) => {
              const start = e.target.value;
              const match = slotsForDate.find((s) => s.startTime === start);
              setForm({ ...form, start, end: match?.endTime || "", location: match?.location || "", trainer: match?.trainer || "" });
            }}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a time…</option>
            {times.map((t) => {
              const match = slotsForDate.find((s) => s.startTime === t);
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
            onChange={(e) => {
              const location = e.target.value;
              const match = slotsForTime.find((s) => s.location === location);
              setForm({ ...form, location, trainer: match?.trainer || form.trainer });
            }}
            className={RESCHEDULE_SELECT_CLASS}
          >
            <option value="">Select a location…</option>
            {locations.map((l) => {
              const match = slotsForTime.find((s) => s.location === l);
              return <option key={l} value={l}>{l}{match?.trainer ? ` (${match.trainer})` : ""}</option>;
            })}
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

interface CalendarViewProps {
  list: Registration[];
  packageMembership: Map<string, { withinPackage: boolean; packagePaid: boolean }>;
  weeklyDiscountRates: Map<string, number>;
  cancelRegistration: (id: string) => Promise<void>;
  markNoShow: (id: string) => Promise<void>;
  openReschedule: (r: Registration) => void;
  cancelling: string | null;
  noShowing: string | null;
  noShowConfirm: string | null;
  setNoShowConfirm: (id: string | null) => void;
}

function CalendarView({ list, packageMembership, weeklyDiscountRates, cancelRegistration, markNoShow, openReschedule, cancelling, noShowing, noShowConfirm, setNoShowConfirm }: CalendarViewProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const sessionsByDay = useMemo(() => {
    const map = new Map<string, Registration[]>();
    for (const r of list) {
      if (!r.booked_date) continue;
      const d = new Date(r.booked_date);
      if (isNaN(d.getTime())) continue;
      const key = toDateKey(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [list]);

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
            {selectedSessions.map((r) => (
              <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${typePill(r.type, r.session_details)}`}>{typePillLabel(r.type, r.session_details)}</span>
                      {packageMembership.get(r.id)?.withinPackage && (
                        <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium">pkg</span>
                      )}
                    </div>
                    <div className="text-xs text-brown-300">{athleteNames(r.kids || "")}</div>
                    <div className="text-xs text-brown-500 mt-0.5">{r.email} · {r.phone}</div>
                    <div className="text-xs text-brown-400 mt-1 leading-relaxed whitespace-pre-line">
                      {r.session_details ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "—"}
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" ? "bg-green-900/40 text-green-400" : r.status === "no_show" ? "bg-orange-900/40 text-orange-400" : "bg-red-900/40 text-red-400"}`}>
                      {r.status === "no_show" ? "no show" : r.status}
                    </span>
                    {!packageMembership.get(r.id)?.withinPackage && (
                      <span className="text-xs font-medium text-green-400">
                        {formatPrice(effectivePrice(r, weeklyDiscountRates))}
                      </span>
                    )}
                    {r.status === "confirmed" && (
                      <div className="flex gap-2">
                        <button onClick={() => cancelRegistration(r.id)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                          {cancelling === r.id ? "..." : "Cancel"}
                        </button>
                        <button onClick={() => openReschedule(r)} className="text-xs text-blue-400 hover:text-blue-300 transition">
                          Reschedule
                        </button>
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
                  </div>
                </div>
              </div>
            ))}
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
  const [videoConsentMap, setVideoConsentMap] = useState<Record<string, boolean>>({});
  const [referralCreditsMap, setReferralCreditsMap] = useState<Record<string, { available: number; total: number }>>({});
  const [packages, setPackages] = useState<PackageData[]>([]);
  const [tab, setTab] = useState<"upcoming" | "past" | "clients" | "calendar">("upcoming");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [noShowConfirm, setNoShowConfirm] = useState<string | null>(null);
  const [noShowing, setNoShowing] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);

  // Admin reschedule state
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
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
      if (!session || session.user.email !== ADMIN_EMAIL) {
        router.replace("/login");
        return;
      }
      setToken(session.access_token);

      // Load registrations first so the dashboard renders right away
      fetch("/api/admin/data", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).then((r) => r.json()).then((adminData) => {
        setRegistrations(adminData.registrations || []);
        const map: Record<string, boolean> = {};
        for (const p of (adminData.profiles || [])) {
          if (p.email) map[p.email] = p.video_consent ?? true;
        }
        setVideoConsentMap(map);
        const creditsMap: Record<string, { available: number; total: number }> = {};
        for (const rc of (adminData.referralCredits || [])) {
          if (rc.email) creditsMap[rc.email] = { available: rc.credits || 0, total: rc.total_referrals || 0 };
        }
        setReferralCreditsMap(creditsMap);
        setPackages(adminData.packages || []);
      }).finally(() => setLoading(false));

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

      // Load the current schedule (groups/camps/private slots) so the reschedule
      // modal can offer real dropdown options instead of free text.
      fetch("/api/schedule").then((r) => r.json()).then((d) => {
        setScheduleData({
          weeklySchedule: d.weeklySchedule || [],
          camps: d.camps || [],
          privateSlots: d.privateSlots || [],
        });
      }).catch(() => {});
    });
  }, [router]);

  async function deleteRegistration(id: string) {
    if (!token) return;
    if (!confirm("Permanently delete this registration? This cannot be undone.")) return;
    setDeleting(id);
    await fetch("/api/admin/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    setRegistrations((prev) => prev.filter((r) => r.id !== id));
    setDeleting(null);
  }

  async function cancelRegistration(id: string) {
    if (!token) return;
    if (!confirm("Cancel this registration?")) return;
    setCancelling(id);
    await fetch("/api/admin/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, status: "cancelled" } : r)));
    setCancelling(null);
  }

  async function markNoShow(id: string) {
    if (!token) return;
    setNoShowing(id);
    setNoShowConfirm(null);
    await fetch("/api/admin/no-show", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, status: "no_show" } : r)));
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
    } else if (data.amountDue > 0) {
      alert(`Player added. $${data.amountDue} additional is now due (already paid at the old price) — collect this manually, no auto-charge yet.`);
    }
  }

  function openReschedule(r: Registration) {
    setReschedulingId(r.id);
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

  function reviewReschedule() {
    const r = registrations.find((x) => x.id === reschedulingId);
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

  async function submitReschedule() {
    if (!token || !reschedulingId) return;
    const r = registrations.find((x) => x.id === reschedulingId);
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
      }),
    });
    const data = await res.json();
    setRescheduleSaving(false);
    if (!res.ok) {
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
    setReschedulingId(null);
    const notes: string[] = [];
    if (data.creditGranted > 0) {
      notes.push(`$${data.creditGranted} was credited to ${r.parent_name}'s account (new price is lower and they'd already paid).`);
    } else if (data.amountDue > 0) {
      notes.push(`$${data.amountDue} additional is now due from ${r.parent_name} (already paid at the old, lower price) — there's no auto-charge yet, so collect this manually.`);
    }
    if (data.creditRefunded) {
      notes.push(`Their referral credit was refunded since it's no longer applied to this booking.`);
    }
    if (data.priceLookupFailed) {
      notes.push(`Couldn't verify the new price on the schedule sheet — the price was left unchanged, double-check it manually.`);
    }
    if (notes.length > 0) alert(`Rescheduled. ${notes.join(" ")}`);
  }

  const upcoming = useMemo(() => {
    const now = Date.now();
    return registrations
      .filter((r) => r.status === "confirmed" && sessionMs(r.booked_date, r.booked_start_time) > now)
      .sort((a, b) => sessionMs(a.booked_date, a.booked_start_time) - sessionMs(b.booked_date, b.booked_start_time));
  }, [registrations]);

  const past = useMemo(() => {
    const now = Date.now();
    return registrations
      .filter((r) => {
        const ms = sessionMs(r.booked_date, r.booked_start_time);
        return ms > 0 && ms <= now;
      })
      .sort((a, b) => sessionMs(b.booked_date, b.booked_start_time) - sessionMs(a.booked_date, a.booked_start_time));
  }, [registrations]);

  // Unique clients sorted by name
  const clients = useMemo(() => {
    const map = new Map<string, { name: string; email: string; phone: string; kids: string; count: number; lastDate: number; videoConsent: boolean | null; referralsAvailable: number; referralsTotal: number }>();
    for (const r of registrations) {
      const key = r.email || r.parent_name;
      const existing = map.get(key);
      const d = dateMs(r.booked_date);
      if (existing) {
        existing.count++;
        if (d > existing.lastDate) existing.lastDate = d;
      } else {
        const vc = r.email && r.email in videoConsentMap ? videoConsentMap[r.email] : null;
        const rc = r.email ? (referralCreditsMap[r.email] ?? { available: 0, total: 0 }) : { available: 0, total: 0 };
        map.set(key, { name: r.parent_name, email: r.email, phone: r.phone, kids: athleteNames(r.kids || ""), count: 1, lastDate: d, videoConsent: vc, referralsAvailable: rc.available, referralsTotal: rc.total });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [registrations, videoConsentMap, referralCreditsMap]);

  const clientRegistrations = useMemo(() => {
    if (!selectedClient) return [];
    return registrations
      .filter((r) => (r.email || r.parent_name) === selectedClient)
      .sort((a, b) => dateMs(b.booked_date) - dateMs(a.booked_date));
  }, [registrations, selectedClient]);

  // Volume discount rates for group sessions booked together (no stored session_price)
  const weeklyDiscountRates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of registrations) {
      if (r.type === "weekly" && r.referral_code && r.session_price == null) {
        counts.set(r.referral_code, (counts.get(r.referral_code) || 0) + 1);
      }
    }
    const rateMap = new Map<string, number>();
    for (const [code, count] of counts) {
      if (count >= 8) rateMap.set(code, 0.15);
      else if (count >= 4) rateMap.set(code, 0.10);
    }
    return rateMap;
  }, [registrations]);

  // Apply type filter + search to a list
  function applyFilters(list: Registration[]) {
    return list.filter((r) => {
      if (typeFilter === "pickup") {
        if (!isPickup(r)) return false;
      } else if (typeFilter === "weekly") {
        if (r.type !== "weekly" || isPickup(r)) return false;
      } else if (typeFilter !== "all") {
        if (r.type !== typeFilter) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!r.parent_name?.toLowerCase().includes(q) && !r.email?.toLowerCase().includes(q) && !r.phone?.includes(q)) return false;
      }
      return true;
    });
  }

  const stats = useMemo(() => ({
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "confirmed").length,
    cancelled: registrations.filter((r) => r.status === "cancelled").length,
    camps: registrations.filter((r) => r.type === "camp" && r.status === "confirmed").length,
    groups: registrations.filter((r) => r.type === "weekly" && r.status === "confirmed").length,
  }), [registrations]);

  // Map each registration id to whether it falls within a monthly package
  const packageMembership = useMemo(() => {
    const result = new Map<string, { withinPackage: boolean; packagePaid: boolean }>();

    function toMonthYear(dateStr: string | null): string | null {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }

    const pkgMap = new Map<string, { package_type: number; is_paid: boolean }>();
    for (const pkg of packages) {
      const key = `${pkg.email.toLowerCase().trim()}|${pkg.month_year}`;
      if (!pkgMap.has(key)) pkgMap.set(key, { package_type: pkg.package_type, is_paid: pkg.is_paid });
    }
    const regsByKey = new Map<string, Registration[]>();
    for (const r of registrations) {
      if (r.type !== "private" && r.type !== "group-private") continue;
      if (r.status !== "confirmed") continue;
      const monthYear = toMonthYear(r.booked_date);
      if (!monthYear) continue;
      const key = `${(r.email || "").toLowerCase().trim()}|${monthYear}`;
      if (!pkgMap.has(key)) continue;
      if (!regsByKey.has(key)) regsByKey.set(key, []);
      regsByKey.get(key)!.push(r);
    }
    for (const [key, regs] of regsByKey) {
      const pkg = pkgMap.get(key)!;
      const sorted = [...regs].sort((a, b) => sessionMs(a.booked_date, a.booked_start_time) - sessionMs(b.booked_date, b.booked_start_time));
      for (let i = 0; i < sorted.length; i++) {
        result.set(sorted[i].id, { withinPackage: i < pkg.package_type, packagePaid: pkg.is_paid });
      }
    }
    return result;
  }, [registrations, packages]);

  function RegCard({ r, showDelete = false, isPast = false }: { r: Registration; showDelete?: boolean; isPast?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const fullSession = r.session_details
      ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()
      : "—";
    return (
      <div className="rounded-xl border border-brown-700 bg-brown-900/40 overflow-hidden">
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
              {packageMembership.get(r.id)?.withinPackage && (
                <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium">pkg</span>
              )}
              {(() => { const da = daysAway(r.booked_date); return da ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${da.cls}`}>{da.label}</span> : null; })()}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" && !isPast ? "bg-green-900/40 text-green-400" : r.status === "confirmed" && isPast ? "bg-brown-800 text-brown-400" : r.status === "no_show" ? "bg-orange-900/40 text-orange-400" : "bg-red-900/40 text-red-400"}`}>
                {r.status === "confirmed" ? (isPast ? "completed" : "scheduled") : r.status === "no_show" ? "no show" : r.status}
              </span>
            </div>
            <div className="text-xs text-brown-300 mt-0.5 truncate">{athleteNames(r.kids || "")}</div>
            <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
              {r.booked_date && <span className="text-mesa-accent">{formatDate(r.booked_date)}</span>}
              <span>{r.phone}</span>
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end justify-between self-stretch">
            <span className={`text-brown-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
            {!packageMembership.get(r.id)?.withinPackage && (
              <span className="text-white font-medium text-xs">{formatPrice(effectivePrice(r, weeklyDiscountRates))}</span>
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
                <p className="text-mesa-accent font-medium">{formatDate(r.booked_date)}</p>
              </div>
              {r.booked_trainer && (
                <div>
                  <p className="text-brown-500 uppercase tracking-wider mb-0.5">Trainer</p>
                  <p className="text-brown-200">{r.booked_trainer}</p>
                </div>
              )}
              {!packageMembership.get(r.id)?.withinPackage && (
                <div>
                  <p className="text-brown-500 uppercase tracking-wider mb-0.5">Price</p>
                  <p className="text-green-400 font-medium">{formatPrice(effectivePrice(r, weeklyDiscountRates))}</p>
                </div>
              )}
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Athletes</p>
              <p className="text-brown-200">{r.kids ? r.kids.split(",").map((k) => k.trim()).join("\n") : "—"}</p>
              {r.status === "confirmed" && (
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

            {/* Actions */}
            {(r.status === "confirmed" || showDelete || isPast) && (
              <div className="flex flex-wrap gap-3 pt-1 border-t border-brown-800">
                {r.status === "confirmed" && !isPast && (
                  <button onClick={() => cancelRegistration(r.id)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                    {cancelling === r.id ? "Cancelling..." : "Cancel"}
                  </button>
                )}
                {r.status === "confirmed" && !isPast && (
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
                {(showDelete || isPast) && (
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

  function RegTableRows({ list, isPast = false }: { list: Registration[]; isPast?: boolean }) {
    return (
      <>
        {list.map((r) => (
          <tr key={r.id} className="hover:bg-brown-900/30 transition">
            <td className="px-4 py-3 text-brown-400 whitespace-nowrap text-xs">
              <div>{new Date(r.created_at).toLocaleDateString()}</div>
              {r.booked_date && <div className="text-mesa-accent font-medium mt-0.5">↳ {formatDate(r.booked_date)}</div>}
            </td>
            <td className="px-4 py-3 font-medium whitespace-nowrap">{r.parent_name}</td>
            <td className="px-4 py-3 text-brown-300 text-xs">{r.email}</td>
            <td className="px-4 py-3 text-brown-300 text-xs whitespace-nowrap">{r.phone}</td>
            <td className="px-4 py-3 text-brown-300 text-xs">{athleteNames(r.kids || "")}</td>
            <td className="px-4 py-3 whitespace-nowrap">
              <div className="flex flex-wrap gap-1">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${isPickup(r) ? "bg-orange-500 text-white" : "bg-amber-400 text-blue-900"}`}>{typePillLabel(r.type, r.session_details)}</span>
                {packageMembership.get(r.id)?.withinPackage && (
                  <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium">pkg</span>
                )}
                {(() => { const da = daysAway(r.booked_date); return da ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${da.cls}`}>{da.label}</span> : null; })()}
              </div>
            </td>
            <td className="px-4 py-3 text-brown-400 text-xs max-w-[240px]">
              <div className="whitespace-pre-line leading-relaxed">{r.session_details ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "—"}</div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" && !isPast ? "bg-green-900/40 text-green-400" : r.status === "confirmed" && isPast ? "bg-brown-800 text-brown-400" : r.status === "no_show" ? "bg-orange-900/40 text-orange-400" : "bg-red-900/40 text-red-400"}`}>
                {r.status === "confirmed" ? (isPast ? "completed" : "scheduled") : r.status === "no_show" ? "no show" : r.status}
              </span>
            </td>
            <td className="px-4 py-3 whitespace-nowrap text-xs">
              {packageMembership.get(r.id)?.withinPackage ? (
                <span className="text-brown-600">—</span>
              ) : (
                <span className="text-green-400 font-medium">{formatPrice(effectivePrice(r, weeklyDiscountRates))}</span>
              )}
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
              {isPast ? (
                <div className="flex items-center gap-3">
                  {r.status === "confirmed" && (
                    <button onClick={() => { if (window.confirm("Mark as no show?")) markNoShow(r.id); }} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 transition disabled:opacity-50">
                      {noShowing === r.id ? "..." : "No Show"}
                    </button>
                  )}
                  <button onClick={() => { if (window.confirm("Delete this record permanently?")) deleteRegistration(r.id); }} disabled={deleting === r.id} className="text-xs text-brown-500 hover:text-red-400 transition disabled:opacity-50">
                    {deleting === r.id ? "..." : "Delete"}
                  </button>
                </div>
              ) : (
                r.status === "confirmed" && (
                  <div className="flex items-center gap-3">
                    <button onClick={() => cancelRegistration(r.id)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                      {cancelling === r.id ? "..." : "Cancel"}
                    </button>
                    <button onClick={() => openReschedule(r)} className="text-xs text-blue-400 hover:text-blue-300 transition">
                      Reschedule
                    </button>
                    <button onClick={() => { if (window.confirm("Mark as no show?")) markNoShow(r.id); }} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 transition disabled:opacity-50">
                      {noShowing === r.id ? "..." : "No Show"}
                    </button>
                  </div>
                )
              )}
            </td>
          </tr>
        ))}
        {list.length === 0 && (
          <tr><td colSpan={10} className="px-4 py-8 text-center text-brown-500">No registrations found.</td></tr>
        )}
      </>
    );
  }

  if (loading) {
    return <div className="min-h-screen bg-brown-950 flex items-center justify-center"><p className="text-brown-400">Loading...</p></div>;
  }

  const displayedUpcoming = applyFilters(upcoming);
  const displayedPast = applyFilters(past);

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
        <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Payments</Link>
        <Link href="/admin/packages" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Packages</Link>
        <Link href="/admin/virtual-training" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Virtual Training</Link>
        <Link href="/admin/virtual-training/drills" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Drills</Link>
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
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Payments
            </Link>
            <Link href="/admin/packages" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Packages
            </Link>
            <Link href="/admin/virtual-training" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Virtual Training
            </Link>
            <Link href="/admin/virtual-training/drills" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Drills
            </Link>
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
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          {[
            { label: "Total", value: stats.total },
            { label: "Confirmed", value: stats.confirmed },
            { label: "Cancelled", value: stats.cancelled },
            { label: "Camp Bookings", value: stats.camps },
            { label: "Group Bookings", value: stats.groups },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-4 text-center">
              <p className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-mesa-accent">{s.value}</p>
              <p className="text-xs text-brown-400 mt-1">{s.label}</p>
            </div>
          ))}
        </div>

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
          {(["upcoming", "past", "calendar", "clients"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedClient(null); }}
              className={`px-3 py-2 rounded-lg text-sm font-semibold capitalize transition ${tab === t ? "bg-mesa-accent text-white" : "bg-brown-900 text-brown-400 hover:text-white"}`}
            >
              {t === "upcoming" ? `Upcoming (${upcoming.length})` : t === "past" ? "Past" : t === "calendar" ? (
                <span className="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  Calendar
                </span>
              ) : "Clients"}
            </button>
          ))}
        </div>

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
              return (
                <>
                  <p className="text-xs text-brown-500 mb-3">{displayedUpcoming.length} session{displayedUpcoming.length !== 1 ? "s" : ""}</p>
                  {/* Mobile */}
                  <div className="md:hidden space-y-4">
                    <div>
                      <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">Today — {todayLabel}</div>
                      {todaySessions.length === 0
                        ? <p className="text-xs text-brown-500 italic py-1">No sessions scheduled for today.</p>
                        : <div className="space-y-3">{todaySessions.map((r) => <RegCard key={r.id} r={r} />)}</div>
                      }
                    </div>
                    {groupByDate(futureSessions).map(({ key, label, sessions }) => (
                      <div key={key}>
                        <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">{label}</div>
                        <div className="space-y-3">{sessions.map((r) => <RegCard key={r.id} r={r} />)}</div>
                      </div>
                    ))}
                  </div>
                  {/* Desktop */}
                  <div className="hidden md:block rounded-xl border border-brown-700 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                        <tr><th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Price</th><th className="px-4 py-3 text-left">Action</th></tr>
                      </thead>
                      <tbody>
                        <tr><td colSpan={10} className="px-4 py-2 bg-brown-900/70 text-xs font-semibold text-mesa-accent">Today — {todayLabel}</td></tr>
                        {todaySessions.length === 0
                          ? <tr><td colSpan={10} className="px-4 py-3 text-xs text-brown-500 italic">No sessions scheduled for today.</td></tr>
                          : <RegTableRows list={todaySessions} />
                        }
                        {groupByDate(futureSessions).map(({ key, label, sessions }) => (
                          <Fragment key={key}>
                            <tr><td colSpan={10} className="px-4 py-2 bg-brown-900/70 border-t-2 border-brown-600 text-xs font-semibold text-mesa-accent">{label}</td></tr>
                            <RegTableRows list={sessions} />
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </>
        )}

        {/* Past */}
        {tab === "past" && (
          <>
            <p className="text-xs text-brown-500 mb-3">{displayedPast.length} session{displayedPast.length !== 1 ? "s" : ""}</p>
            {/* Mobile */}
            <div className="md:hidden space-y-4">
              {displayedPast.length === 0 && <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">No past sessions.</div>}
              {groupByDate(displayedPast).map(({ key, label, sessions }) => (
                <div key={key}>
                  <div className="text-xs font-semibold text-mesa-accent border-b border-brown-700 pb-1.5 mb-2">{label}</div>
                  <div className="space-y-3">{sessions.map((r) => <RegCard key={r.id} r={r} isPast />)}</div>
                </div>
              ))}
            </div>
            {/* Desktop */}
            <div className="hidden md:block rounded-xl border border-brown-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                  <tr><th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Price</th><th className="px-4 py-3 text-left">Action</th></tr>
                </thead>
                <tbody>
                  {displayedPast.length === 0 && <tr><td colSpan={10} className="px-4 py-8 text-center text-brown-500">No past sessions.</td></tr>}
                  {groupByDate(displayedPast).map(({ key, label, sessions }) => (
                    <Fragment key={key}>
                      <tr><td colSpan={10} className="px-4 py-2 bg-brown-900/70 border-t-2 border-brown-600 text-xs font-semibold text-mesa-accent">{label}</td></tr>
                      <RegTableRows list={sessions} isPast />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Calendar — all sessions combined */}
        {tab === "calendar" && (
          <div className="rounded-xl border border-brown-700 bg-brown-900/20 p-4">
            <CalendarView
              list={[...upcoming, ...past.filter(r => r.status !== "cancelled")]}
              packageMembership={packageMembership}
              weeklyDiscountRates={weeklyDiscountRates}
              cancelRegistration={cancelRegistration}
              markNoShow={markNoShow}
              openReschedule={openReschedule}
              cancelling={cancelling}
              noShowing={noShowing}
              noShowConfirm={noShowConfirm}
              setNoShowConfirm={setNoShowConfirm}
            />
          </div>
        )}

        {/* Clients */}
        {tab === "clients" && !selectedClient && (
          <div className="space-y-2">
            {clients.map((c) => (
              <button
                key={c.email || c.name}
                onClick={() => setSelectedClient(c.email || c.name)}
                className="w-full text-left rounded-xl border border-brown-700 bg-brown-900/40 hover:bg-brown-800/60 px-4 py-3 transition"
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
        )}

        {/* Client detail */}
        {tab === "clients" && selectedClient && (() => {
          const clientData = clients.find((c) => (c.email || c.name) === selectedClient);
          return (
            <>
              <button onClick={() => setSelectedClient(null)} className="text-sm text-mesa-accent hover:underline mb-4 inline-block">← All Clients</button>
              {clientData && (
                <div className="mb-4 rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center gap-6">
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
                {clientRegistrations.map((r) => <RegCard key={r.id} r={r} showDelete />)}
                {clientRegistrations.length === 0 && <p className="text-brown-500 text-sm">No registrations found.</p>}
              </div>
            </>
          );
        })()}

      </div>
      </div>

      {/* Admin reschedule modal */}
      {reschedulingId && (() => {
        const r = registrations.find((x) => x.id === reschedulingId);
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
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setReschedulingId(null)}>
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
                    newFull = calcPrivatePricePreview(durationMins, r.total_participants || 1);
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
                  const oldAmount = Math.max(0, effectiveAmountPreview(r.session_price ?? 0, !!r.is_free, isPrivateTypeClient(r.type)) - appliedCredit);
                  const newAmount = Math.max(0, effectiveAmountPreview(newFull, newIsFreePreview, targetIsPrivate) - appliedCredit);
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
                <p className="text-[11px] text-brown-500 mt-3">No late fee is charged. The client will get an email/text about the change.</p>
                <div className="flex gap-3 mt-4">
                  <button onClick={submitReschedule} disabled={rescheduleSaving} className="flex-1 rounded-lg bg-mesa-accent text-white text-sm font-semibold py-2 disabled:opacity-50">
                    {rescheduleSaving ? "Sending..." : "Confirm & Send"}
                  </button>
                  <button onClick={() => setRescheduleStep("edit")} disabled={rescheduleSaving} className="rounded-lg border border-brown-700 text-brown-300 text-sm px-4 py-2 disabled:opacity-50">
                    Back
                  </button>
                </div>
                <button onClick={() => setReschedulingId(null)} disabled={rescheduleSaving} className="mt-2 w-full text-center text-xs text-brown-500 hover:text-brown-300 transition disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          );
        }

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setReschedulingId(null)}>
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
                  renderPrivateRescheduleFields(scheduleData.privateSlots, rescheduleForm, setRescheduleForm)
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
                  <span>Apply the same referral credit used on the original booking (50% off)</span>
                </label>
              )}
              {rescheduleError && <p className="text-xs text-red-400 mt-2">{rescheduleError}</p>}
              <p className="text-[11px] text-brown-500 mt-3">No late fee is charged — this updates the client&apos;s existing booking and notifies them by email/text.</p>
              <div className="flex gap-3 mt-4">
                <button onClick={reviewReschedule} disabled={!scheduleData} className="flex-1 rounded-lg bg-mesa-accent text-white text-sm font-semibold py-2 disabled:opacity-50">
                  Review Change
                </button>
                <button onClick={() => setReschedulingId(null)} className="rounded-lg border border-brown-700 text-brown-300 text-sm px-4 py-2">
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
