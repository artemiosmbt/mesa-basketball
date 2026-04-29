"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

interface Registration {
  id: string;
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  session_details: string;
  booked_date: string | null;
  booked_start_time: string | null;
  status: string;
  is_paid: boolean;
  is_late_cancel: boolean;
  cancel_fee_settled: boolean;
  session_price: number | null;
  total_participants: number | null;
}

const TYPE_LABELS: Record<string, string> = {
  weekly: "Group",
  camp: "Camp",
  private: "Private",
  "group-private": "Group Private",
};

function formatDate(d: string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function sessionLabel(r: Registration) {
  return r.session_details
    ? r.session_details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").split("\n")[0]
    : "—";
}

function daysAway(dateStr: string | null): { label: string; cls: string } | null {
  if (!dateStr) return null;
  const today = new Date();
  const todayMidnight = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const sessionMidnight = new Date(dateStr + "T00:00:00Z").getTime();
  if (isNaN(sessionMidnight)) return null;
  const diff = Math.round((sessionMidnight - todayMidnight) / 86400000);
  if (diff === 0) return { label: "today", cls: "bg-green-900/40 text-green-400" };
  if (diff === 1) return { label: "tomorrow", cls: "bg-blue-900/40 text-blue-400" };
  if (diff === -1) return { label: "yesterday", cls: "bg-orange-900/40 text-orange-400" };
  if (diff > 0) return { label: `in ${diff} days`, cls: "bg-blue-900/40 text-blue-400" };
  return { label: `${Math.abs(diff)} days ago`, cls: "bg-orange-900/40 text-orange-400" };
}

export default function PaymentsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [togglingPaid, setTogglingPaid] = useState<string | null>(null);
  const [settlingFee, setSettlingFee] = useState<string | null>(null);
  const [showAllPaid, setShowAllPaid] = useState(false);

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
        .then((data) => setRegistrations(data.registrations || []))
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function togglePaid(id: string, currentValue: boolean) {
    if (!token) return;
    setTogglingPaid(id);
    await fetch("/api/admin/update-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, field: "is_paid", value: !currentValue }),
    });
    setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, is_paid: !currentValue } : r)));
    setTogglingPaid(null);
  }

  async function settleFee(id: string) {
    if (!token) return;
    setSettlingFee(id);
    await fetch("/api/admin/update-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, field: "cancel_fee_settled", value: true }),
    });
    setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, cancel_fee_settled: true } : r)));
    setSettlingFee(null);
  }

  function dateMs(d: string | null) {
    if (!d) return 0;
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? 0 : parsed.setHours(0, 0, 0, 0);
  }

  function sessionDateTimeMs(r: Registration): number {
    if (!r.booked_date) return 0;
    const timeStr = r.booked_start_time || "00:00";
    const ampm = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    let hours = 0, minutes = 0;
    if (ampm) {
      hours = parseInt(ampm[1]);
      minutes = parseInt(ampm[2]);
      if (ampm[3].toUpperCase() === "PM" && hours !== 12) hours += 12;
      if (ampm[3].toUpperCase() === "AM" && hours === 12) hours = 0;
    } else {
      const hm = timeStr.match(/(\d+):(\d+)/);
      if (hm) { hours = parseInt(hm[1]); minutes = parseInt(hm[2]); }
    }
    const date = new Date(r.booked_date);
    if (isNaN(date.getTime())) return 0;
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  }

  const unpaid = useMemo(() =>
    registrations
      .filter((r) => r.status === "confirmed" && !r.is_paid)
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date)),
  [registrations]);

  const paid = useMemo(() => {
    const now = Date.now();
    return registrations
      .filter((r) => r.status === "confirmed" && r.is_paid && sessionDateTimeMs(r) + 24 * 3600 * 1000 > now)
      .sort((a, b) => sessionDateTimeMs(a) - sessionDateTimeMs(b));
  }, [registrations]);

  const cancelFees = useMemo(() =>
    registrations.filter((r) => r.is_late_cancel && r.session_price && !r.cancel_fee_settled),
  [registrations]);

  if (loading) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center">
        <p className="text-brown-400">Loading...</p>
      </div>
    );
  }

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
              <p className="font-[family-name:var(--font-oswald)] text-base sm:text-xl font-bold tracking-wide text-mesa-dark leading-tight">PAYMENTS</p>
              <p className="text-xs text-brown-500 leading-tight">Mesa Basketball Training</p>
            </div>
          </div>
        </div>
      </div>
      {/* Mobile tab bar */}
      <div className="md:hidden border-b border-gray-200 bg-white px-4 flex items-center gap-1 overflow-x-auto">
        <Link href="/admin" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Dashboard</Link>
        <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm font-semibold text-mesa-dark border-b-2 border-mesa-dark">Payments</Link>
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
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Dashboard
            </Link>
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
              Payments
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
          </div>
        </aside>

      <div className="flex-1 min-w-0 px-4 sm:px-6 py-8 space-y-12">

        {/* Unpaid */}
        <div>
          <h2 className="font-[family-name:var(--font-oswald)] text-lg font-bold tracking-wide text-white mb-4">
            UNPAID
            {unpaid.length > 0 && <span className="ml-2 rounded-full bg-mesa-accent px-2 py-0.5 text-xs font-medium text-white">{unpaid.length}</span>}
          </h2>
          {unpaid.length === 0 ? (
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8 text-center text-brown-500 text-sm">Everyone is paid up.</div>
          ) : (
            <div className="space-y-2">
              {unpaid.map((r) => {
                const da = daysAway(r.booked_date);
                return (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-semibold text-blue-800 shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                      {da && <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${da.cls}`}>{da.label}</span>}
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5 truncate">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
                      <span>{formatDate(r.booked_date)}</span>
                      <span>{r.phone}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => togglePaid(r.id, r.is_paid)}
                    disabled={togglingPaid === r.id}
                    className="w-9 h-9 shrink-0 rounded-full border-2 border-brown-600 hover:border-green-500 flex items-center justify-center transition font-bold text-brown-600 hover:text-green-500 text-sm"
                    title="Mark paid"
                  >
                    {togglingPaid === r.id ? "…" : "✓"}
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Cancellation Fees */}
        <div>
          <h2 className="font-[family-name:var(--font-oswald)] text-lg font-bold tracking-wide text-white mb-4">
            CANCELLATION FEES
            {cancelFees.length > 0 && <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">{cancelFees.length}</span>}
          </h2>
          {cancelFees.length === 0 ? (
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8 text-center text-brown-500 text-sm">No outstanding cancellation fees.</div>
          ) : (
            <div className="space-y-2">
              {cancelFees.map((r) => {
                const fee = Math.round((r.session_price ?? 0) * 0.5);
                const owesRefund = r.is_paid;
                return (
                  <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium text-sm">{r.parent_name}</span>
                        <span className="text-lg font-bold text-mesa-accent">${fee}</span>
                        {owesRefund ? (
                          <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-400">You owe refund</span>
                        ) : (
                          <span className="rounded-full bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-400">Owes you</span>
                        )}
                      </div>
                      <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                      <div className="text-xs text-brown-500 mt-1">{formatDate(r.booked_date)}</div>
                    </div>
                    <button
                      onClick={() => settleFee(r.id)}
                      disabled={settlingFee === r.id}
                      className="shrink-0 rounded-lg bg-brown-700 hover:bg-brown-600 px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-50"
                    >
                      {settlingFee === r.id ? "…" : "Settled"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Paid — with undo */}
        <div>
          <h2 className="font-[family-name:var(--font-oswald)] text-lg font-bold tracking-wide text-white mb-1">
            PAID
            {paid.length > 0 && <span className="ml-2 rounded-full bg-green-700 px-2 py-0.5 text-xs font-medium text-white">{paid.length}</span>}
          </h2>
          <p className="text-xs text-brown-500 mb-4">Tap the checkmark to undo if you marked someone paid by mistake.</p>
          {paid.length === 0 ? (
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8 text-center text-brown-500 text-sm">No paid registrations yet.</div>
          ) : (
            <div className="space-y-2">
              {(showAllPaid ? paid : paid.slice(0, 3)).map((r) => {
                const da = daysAway(r.booked_date);
                return (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3 opacity-60">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-semibold text-blue-800 shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                      {da && <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${da.cls}`}>{da.label}</span>}
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5 truncate">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="text-xs text-brown-500 mt-1">{formatDate(r.booked_date)}</div>
                  </div>
                  <button
                    onClick={() => togglePaid(r.id, r.is_paid)}
                    disabled={togglingPaid === r.id}
                    className="w-9 h-9 shrink-0 rounded-full border-2 border-green-500 bg-green-500/20 flex items-center justify-center transition font-bold text-green-400 hover:border-red-500 hover:bg-red-500/10 hover:text-red-400 text-sm"
                    title="Undo — mark unpaid"
                  >
                    {togglingPaid === r.id ? "…" : "✓"}
                  </button>
                </div>
                );
              })}
            </div>
          )}
          {paid.length > 3 && (
            <button
              onClick={() => setShowAllPaid((v) => !v)}
              className="mt-3 text-xs text-brown-400 hover:text-white transition"
            >
              {showAllPaid ? "Show less" : `View ${paid.length - 3} more`}
            </button>
          )}
        </div>

      </div>
      </div>
    </div>
  );
}
