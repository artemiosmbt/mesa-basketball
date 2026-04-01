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

function sessionLabel(r: Registration) {
  return r.session_details
    ? r.session_details.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").split("\n")[0]
    : "—";
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

  const todayMs = new Date().setHours(0, 0, 0, 0);
  function dateMs(d: string | null) {
    if (!d) return 0;
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? 0 : parsed.setHours(0, 0, 0, 0);
  }

  const unpaid = useMemo(() =>
    registrations
      .filter((r) => r.status === "confirmed" && !r.is_paid)
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date)),
  [registrations]);

  const paid = useMemo(() =>
    registrations
      .filter((r) => r.status === "confirmed" && r.is_paid && dateMs(r.booked_date) > todayMs)
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date)),
  [registrations, todayMs]);

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
    <div className="min-h-screen bg-brown-950 text-white flex flex-col">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-14 w-14 rounded-full bg-white border border-gray-100 overflow-hidden flex items-center justify-center">
              <img src="/logo.png" alt="Mesa" className="h-14 w-14 object-contain scale-125" />
            </div>
            <div>
              <p className="font-[family-name:var(--font-oswald)] text-xl font-bold tracking-wide text-mesa-dark">PAYMENTS</p>
              <p className="text-xs text-brown-500">Mesa Basketball Training</p>
            </div>
          </div>
          <div className="flex items-center gap-4 md:hidden">
            <Link href="/admin" className="text-sm text-brown-500 hover:text-mesa-dark">← Registrations</Link>
            <Link href="/" className="text-sm text-brown-500 hover:text-mesa-dark">← Site</Link>
          </div>
        </div>
      </div>

      <div className="flex flex-1">
        {/* Sidebar — desktop only */}
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-brown-800 bg-brown-900/30 px-3 py-6">
          <nav className="flex-1 space-y-1">
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Dashboard
            </Link>
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
              Payments
            </Link>
          </nav>
          <div className="border-t border-brown-800 pt-4 mt-4 space-y-1">
            <Link href="/" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              ← Back to Site
            </Link>
          </div>
        </aside>

      <div className="flex-1 px-4 sm:px-6 py-8 space-y-12">

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
              {unpaid.map((r) => (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-brown-800 px-2 py-0.5 text-xs text-mesa-accent shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
                      <span>{r.booked_date || "—"}</span>
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
              ))}
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
                      <div className="text-xs text-brown-500 mt-1">{r.booked_date}</div>
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
              {(showAllPaid ? paid : paid.slice(0, 3)).map((r) => (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3 opacity-60">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-brown-800 px-2 py-0.5 text-xs text-mesa-accent shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="text-xs text-brown-500 mt-1">{r.booked_date || "—"}</div>
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
              ))}
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
