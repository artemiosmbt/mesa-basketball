"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ALL_TRAINER_NAMES, sortTrainerNames } from "@/lib/trainers";
import {
  addDays,
  dayOfWeek,
  formatDateLong,
  formatDateShort,
  formatTime12,
  fromMinutes,
  nyNow,
  STPAULS_BLOCKS,
  STPAULS_SLOT_STEP_MINUTES,
  toMinutes,
  weekStart,
  type StPaulsCoach,
} from "@/lib/stpauls";

// Admin dashboard tab for St. Paul's team practices. The admin sees every
// practice and is the only one who can assign a trainer or cancel; a
// trainer sees only the practices assigned to them (filtered server-side).
// A coach's booking is a pending REQUEST until the admin assigns its first
// trainer — that is the approval, and it's what confirms it to the coach.

interface Practice {
  id: string;
  date: string;
  start: string;
  end: string;
  teamName: string;
  coaches: StPaulsCoach[];
  assignedTrainer: string | null;
  createdAt: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function StPaulsPracticesTab({ token, isAdmin, onChanged }: { token: string; isAdmin: boolean; onChanged?: () => void }) {
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [practices, setPractices] = useState<Practice[] | null>(null);
  const [error, setError] = useState("");
  const [week, setWeek] = useState(() => weekStart(nyNow().date));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/stpauls", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load practices.");
      setPractices(data.practices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load practices.");
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function assign(id: string, trainer: string) {
    setSaving(id);
    setError("");
    const res = await fetch("/api/admin/stpauls", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, assignedTrainer: trainer || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || "Couldn't save the trainer.");
    else {
      setPractices((prev) => prev?.map((p) => (p.id === id ? { ...p, assignedTrainer: data.assignedTrainer } : p)) || prev);
      onChanged?.();
    }
    setSaving(null);
  }

  async function cancel(id: string) {
    setSaving(id);
    setError("");
    const res = await fetch(`/api/admin/stpauls?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || "Couldn't cancel.");
    else {
      setPractices((prev) => prev?.filter((p) => p.id !== id) || prev);
      if (selectedId === id) setSelectedId(null);
      onChanged?.();
    }
    setConfirmCancel(null);
    setSaving(null);
  }

  const trainers = useMemo(() => sortTrainerNames([...ALL_TRAINER_NAMES]), []);
  const today = nyNow().date;

  // Calendar: one column per practice day this week, one row per half hour
  // from the earliest block start to the latest block end.
  const days = useMemo(() => {
    const out: { date: string; block: (typeof STPAULS_BLOCKS)[number] }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(week, i);
      const block = STPAULS_BLOCKS.find((b) => b.dow === (i + 1) % 7);
      if (block) out.push({ date, block });
    }
    return out;
  }, [week]);
  const rows = useMemo(() => {
    const first = Math.min(...STPAULS_BLOCKS.map((b) => toMinutes(b.start)));
    const last = Math.max(...STPAULS_BLOCKS.map((b) => toMinutes(b.end)));
    const out: string[] = [];
    for (let m = first; m < last; m += STPAULS_SLOT_STEP_MINUTES) out.push(fromMinutes(m));
    return out;
  }, []);

  const selected = practices?.find((p) => p.id === selectedId) || null;

  function trainerControl(p: Practice) {
    if (!isAdmin) return <span className="text-white">{p.assignedTrainer || "TBD"}</span>;
    // Picking the first trainer approves the request and confirms it to the
    // coach; once confirmed it can be swapped but not put back to pending.
    return (
      <select
        value={p.assignedTrainer || ""}
        disabled={saving === p.id}
        onChange={(e) => assign(p.id, e.target.value)}
        className={`rounded-lg border px-2 py-1 text-sm text-white focus:border-mesa-accent focus:outline-none disabled:opacity-50 ${p.assignedTrainer ? "border-brown-700 bg-brown-800/60" : "border-amber-500 bg-amber-500/15"}`}
      >
        {!p.assignedTrainer && <option value="">Assign trainer to approve…</option>}
        {trainers.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    );
  }

  function cancelControl(p: Practice) {
    if (!isAdmin) return null;
    if (confirmCancel === p.id) {
      return (
        <span className="flex items-center gap-2 text-xs">
          <span className="text-brown-300">{p.assignedTrainer ? "Cancel this practice?" : "Decline this request?"}</span>
          <button onClick={() => cancel(p.id)} disabled={saving === p.id} className="rounded bg-red-700 px-2 py-1 font-semibold text-white disabled:opacity-50">{p.assignedTrainer ? "Yes, cancel" : "Yes, decline"}</button>
          <button onClick={() => setConfirmCancel(null)} className="text-brown-400 hover:text-white">No</button>
        </span>
      );
    }
    return <button onClick={() => setConfirmCancel(p.id)} className="text-xs text-red-400 hover:text-red-300">{p.assignedTrainer ? "Cancel practice" : "Decline request"}</button>;
  }

  function statusBadge(p: Practice) {
    return p.assignedTrainer
      ? <span className="rounded-full bg-green-900/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-400">Confirmed</span>
      : <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Pending approval</span>;
  }

  function coachLines(p: Practice) {
    return p.coaches.map((c, i) => (
      <p key={i} className="text-brown-300 text-xs">
        {c.name} · <a href={`tel:${c.phone}`} className="hover:text-white">{c.phone}</a> · <a href={`mailto:${c.email}`} className="hover:text-white">{c.email}</a>
      </p>
    ));
  }

  const pendingCount = (practices || []).filter((p) => !p.assignedTrainer && p.date >= today).length;

  const listed = (practices || [])
    .filter((p) => (showPast ? p.date < today : p.date >= today))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start) * (showPast ? -1 : 1));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["calendar", "list"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${view === v ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}>
            {v === "calendar" ? "Calendar" : "List"}
          </button>
        ))}
        <span className="text-xs text-brown-500 ml-auto">Coach booking link: <span className="text-brown-300">mesabasketballtraining.com/stpauls-practices</span></span>
      </div>

      {isAdmin && pendingCount > 0 && (
        <p className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          <strong>{pendingCount} practice request{pendingCount === 1 ? "" : "s"} waiting for approval.</strong> Assign a trainer to approve (the coach gets a confirmation), or decline.
        </p>
      )}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {practices === null && !error && <p className="text-brown-400 text-sm">Loading practices...</p>}

      {practices !== null && view === "calendar" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => { setWeek(addDays(week, -7)); setSelectedId(null); }} className="rounded-lg border border-brown-700 px-3 py-1.5 text-sm text-brown-300 hover:text-white">←</button>
            <p className="text-sm font-semibold text-white">Week of {formatDateShort(week)}</p>
            <button onClick={() => { setWeek(addDays(week, 7)); setSelectedId(null); }} className="rounded-lg border border-brown-700 px-3 py-1.5 text-sm text-brown-300 hover:text-white">→</button>
            {week !== weekStart(today) && (
              <button onClick={() => { setWeek(weekStart(today)); setSelectedId(null); }} className="text-xs text-mesa-accent hover:underline">This week</button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-1 text-xs">
              <thead>
                <tr>
                  <th className="w-20" />
                  {days.map((d) => (
                    <th key={d.date} className={`pb-1 text-center font-semibold ${d.date === today ? "text-mesa-accent" : "text-brown-300"}`}>
                      {DAY_NAMES[dayOfWeek(d.date)]} {formatDateShort(d.date).split(", ")[1]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t}>
                    <td className="pr-2 text-right align-top text-brown-500 whitespace-nowrap">{formatTime12(t)}</td>
                    {days.map((d) => {
                      const m = toMinutes(t);
                      const inBlock = m >= toMinutes(d.block.start) && m < toMinutes(d.block.end);
                      if (!inBlock) return <td key={d.date} className="rounded bg-brown-950/40" />;
                      const p = practices.find((x) => x.date === d.date && toMinutes(x.start) <= m && m < toMinutes(x.end));
                      if (p) {
                        // Only the practice's first half hour draws the cell; it spans the rest.
                        if (toMinutes(p.start) !== m) return null;
                        const span = Math.max(1, Math.round((toMinutes(p.end) - toMinutes(p.start)) / STPAULS_SLOT_STEP_MINUTES));
                        return (
                          <td key={d.date} rowSpan={span}
                            onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                            className={`cursor-pointer rounded px-2 py-1.5 align-top hover:brightness-110 ${p.assignedTrainer ? "bg-green-700/80 text-white" : "bg-amber-500/80 text-brown-950"} ${selectedId === p.id ? "ring-2 ring-mesa-accent" : ""}`}>
                            <p className="font-semibold leading-tight">{p.teamName}</p>
                            <p className={`leading-tight ${p.assignedTrainer ? "text-green-100" : "font-semibold"}`}>{p.assignedTrainer ? `(${p.assignedTrainer})` : "PENDING"}</p>
                          </td>
                        );
                      }
                      // Trainers only receive their own practices, so an empty cell
                      // isn't necessarily open — only the admin gets red.
                      return <td key={d.date} className={`rounded h-7 ${isAdmin ? "bg-red-900/60" : "bg-brown-900"}`} />;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isAdmin && (
            <div className="flex gap-4 text-xs text-brown-400">
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded bg-red-900/60" /> Open</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded bg-amber-500/80" /> Pending approval</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded bg-green-700/80" /> Confirmed</span>
            </div>
          )}
          {selected && (
            <div className="rounded-xl border border-brown-700 bg-brown-900/60 p-4 space-y-2">
              <p className="flex flex-wrap items-center gap-2 font-semibold text-white">{selected.teamName} {statusBadge(selected)}</p>
              <p className="text-sm text-brown-300">{formatDateLong(selected.date)}, {formatTime12(selected.start)}–{formatTime12(selected.end)}</p>
              {coachLines(selected)}
              <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
                <span className="text-brown-500">Trainer:</span>
                {trainerControl(selected)}
                <span className="ml-auto">{cancelControl(selected)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {practices !== null && view === "list" && (
        <div className="space-y-3">
          <div className="flex gap-1">
            {[false, true].map((past) => (
              <button key={String(past)} onClick={() => setShowPast(past)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${showPast === past ? "bg-brown-700 text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}>
                {past ? "Past" : "Upcoming"}
              </button>
            ))}
          </div>
          {listed.length === 0 && <p className="text-brown-500 text-sm">No {showPast ? "past" : "upcoming"} practices booked.</p>}
          {listed.map((p) => (
            <div key={p.id} className="rounded-xl border border-brown-700 bg-brown-900/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-white">{p.teamName} {statusBadge(p)}</p>
                  <p className="text-sm text-brown-300">{formatDateLong(p.date)}, {formatTime12(p.start)}–{formatTime12(p.end)}</p>
                  <div className="mt-1 space-y-0.5">{coachLines(p)}</div>
                </div>
                <div className="flex flex-col items-end gap-2 text-sm">
                  <span className="flex items-center gap-2"><span className="text-brown-500">Trainer:</span>{trainerControl(p)}</span>
                  {cancelControl(p)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
