"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

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
  status: string;
  session_price: number | null;
}

const TYPE_LABELS: Record<string, string> = {
  weekly: "Group",
  camp: "Camp",
  private: "Private",
  "group-private": "Group Private",
};

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

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  cancelRegistration: (id: string) => Promise<void>;
  markNoShow: (id: string) => Promise<void>;
  cancelling: string | null;
  noShowing: string | null;
  noShowConfirm: string | null;
  setNoShowConfirm: (id: string | null) => void;
}

function CalendarView({ list, cancelRegistration, markNoShow, cancelling, noShowing, noShowConfirm, setNoShowConfirm }: CalendarViewProps) {
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

  function typePill(type: string) {
    switch (type) {
      case "private": return "bg-mesa-accent/30 text-mesa-accent";
      case "weekly": return "bg-blue-900/60 text-blue-300";
      case "camp": return "bg-purple-900/60 text-purple-300";
      case "group-private": return "bg-green-900/60 text-green-300";
      default: return "bg-brown-800 text-brown-300";
    }
  }

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
                      <span className={`rounded-full px-2 py-0.5 text-xs ${typePill(r.type)}`}>{TYPE_LABELS[r.type] || r.type}</span>
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
                    {r.status === "confirmed" && (
                      <div className="flex gap-2">
                        <button onClick={() => cancelRegistration(r.id)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                          {cancelling === r.id ? "..." : "Cancel"}
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
  const [tab, setTab] = useState<"upcoming" | "past" | "clients" | "calendar">("upcoming");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [noShowConfirm, setNoShowConfirm] = useState<string | null>(null);
  const [noShowing, setNoShowing] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      if (!session || session.user.email !== ADMIN_EMAIL) {
        router.replace("/login");
        return;
      }
      setToken(session.access_token);
      fetch("/api/admin/data", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => r.json())
        .then((data) => {
          setRegistrations(data.registrations || []);
          const map: Record<string, boolean> = {};
          for (const p of (data.profiles || [])) {
            if (p.email) map[p.email] = p.video_consent ?? true;
          }
          setVideoConsentMap(map);
        })
        .finally(() => setLoading(false));
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
    const map = new Map<string, { name: string; email: string; phone: string; kids: string; count: number; lastDate: number; videoConsent: boolean | null }>();
    for (const r of registrations) {
      const key = r.email || r.parent_name;
      const existing = map.get(key);
      const d = dateMs(r.booked_date);
      if (existing) {
        existing.count++;
        if (d > existing.lastDate) existing.lastDate = d;
      } else {
        const vc = r.email && r.email in videoConsentMap ? videoConsentMap[r.email] : null;
        map.set(key, { name: r.parent_name, email: r.email, phone: r.phone, kids: athleteNames(r.kids || ""), count: 1, lastDate: d, videoConsent: vc });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [registrations, videoConsentMap]);

  const clientRegistrations = useMemo(() => {
    if (!selectedClient) return [];
    return registrations
      .filter((r) => (r.email || r.parent_name) === selectedClient)
      .sort((a, b) => dateMs(b.booked_date) - dateMs(a.booked_date));
  }, [registrations, selectedClient]);

  // Apply type filter + search to a list
  function applyFilters(list: Registration[]) {
    return list.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
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
              <span className="rounded-full bg-brown-800 px-2 py-0.5 text-xs text-mesa-accent">{TYPE_LABELS[r.type] || r.type}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" ? "bg-green-900/40 text-green-400" : r.status === "no_show" ? "bg-orange-900/40 text-orange-400" : "bg-red-900/40 text-red-400"}`}>
                {r.status === "no_show" ? "no show" : r.status}
              </span>
            </div>
            <div className="text-xs text-brown-300 mt-0.5 truncate">{athleteNames(r.kids || "")}</div>
            <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
              {r.booked_date && <span className="text-mesa-accent">{formatDate(r.booked_date)}</span>}
              <span>{r.phone}</span>
            </div>
          </div>
          <span className={`shrink-0 mt-0.5 text-brown-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>
            ▾
          </span>
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
            </div>
            <div>
              <p className="text-brown-500 uppercase tracking-wider mb-0.5">Athletes</p>
              <p className="text-brown-200">{r.kids ? r.kids.split(",").map((k) => k.trim()).join("\n") : "—"}</p>
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
              <span className="rounded-full bg-brown-800 px-2 py-0.5 text-xs text-mesa-accent">{TYPE_LABELS[r.type] || r.type}</span>
            </td>
            <td className="px-4 py-3 text-brown-400 text-xs max-w-[240px]">
              <div className="whitespace-pre-line leading-relaxed">{r.session_details ? r.session_details.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "—"}</div>
            </td>
            <td className="px-4 py-3 whitespace-nowrap">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" ? "bg-green-900/40 text-green-400" : r.status === "no_show" ? "bg-orange-900/40 text-orange-400" : "bg-red-900/40 text-red-400"}`}>
                {r.status === "no_show" ? "no show" : r.status}
              </span>
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
          <tr><td colSpan={9} className="px-4 py-8 text-center text-brown-500">No registrations found.</td></tr>
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
              {["all", "weekly", "camp", "private", "group-private"].map((t) => (
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
                        <tr><th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Action</th></tr>
                      </thead>
                      <tbody>
                        <tr><td colSpan={9} className="px-4 py-2 bg-brown-900/70 text-xs font-semibold text-mesa-accent">Today — {todayLabel}</td></tr>
                        {todaySessions.length === 0
                          ? <tr><td colSpan={9} className="px-4 py-3 text-xs text-brown-500 italic">No sessions scheduled for today.</td></tr>
                          : <RegTableRows list={todaySessions} />
                        }
                        {groupByDate(futureSessions).map(({ key, label, sessions }) => (
                          <Fragment key={key}>
                            <tr><td colSpan={9} className="px-4 py-2 bg-brown-900/70 border-t-2 border-brown-600 text-xs font-semibold text-mesa-accent">{label}</td></tr>
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
                  <tr><th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Action</th></tr>
                </thead>
                <tbody>
                  {displayedPast.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-brown-500">No past sessions.</td></tr>}
                  {groupByDate(displayedPast).map(({ key, label, sessions }) => (
                    <Fragment key={key}>
                      <tr><td colSpan={9} className="px-4 py-2 bg-brown-900/70 border-t-2 border-brown-600 text-xs font-semibold text-mesa-accent">{label}</td></tr>
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
              cancelRegistration={cancelRegistration}
              markNoShow={markNoShow}
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
        {tab === "clients" && selectedClient && (
          <>
            <button onClick={() => setSelectedClient(null)} className="text-sm text-mesa-accent hover:underline mb-4 inline-block">← All Clients</button>
            <div className="space-y-3">
              {clientRegistrations.map((r) => <RegCard key={r.id} r={r} showDelete />)}
              {clientRegistrations.length === 0 && <p className="text-brown-500 text-sm">No registrations found.</p>}
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
