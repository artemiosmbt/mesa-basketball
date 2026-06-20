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
  is_free: boolean;
  used_referral_credit: boolean;
  is_full_camp: boolean;
  referral_code: string | null;
}

interface PackageData {
  id: string;
  email: string;
  package_type: number;
  month_year: string;
  is_paid: boolean;
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

export default function PaymentsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [packages, setPackages] = useState<PackageData[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [togglingPaid, setTogglingPaid] = useState<string | null>(null);
  const [settlingFee, setSettlingFee] = useState<string | null>(null);
  const [showAllPaid, setShowAllPaid] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

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
          setPackages(data.packages || []);
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function backfillGroupPrices() {
    if (!token) return;
    setBackfilling(true);
    setBackfillResult(null);
    const res = await fetch("/api/admin/backfill-group-prices", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setBackfillResult(data.message || data.error || "Done");
    setBackfilling(false);
    if (data.updated > 0) {
      // Reload registrations to reflect the updated prices
      const refresh = await fetch("/api/admin/data", {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      setRegistrations(refresh.registrations || []);
    }
  }

  async function togglePaid(id: string, currentValue: boolean, referralCode?: string | null) {
    if (!token) return;
    setTogglingPaid(id);
    await fetch("/api/admin/update-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, field: "is_paid", value: !currentValue, ...(referralCode ? { referralCode } : {}) }),
    });
    if (referralCode) {
      // Full camp: update all day rows belonging to this camp group
      setRegistrations((prev) => prev.map((r) => r.referral_code === referralCode ? { ...r, is_paid: !currentValue } : r));
    } else {
      setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, is_paid: !currentValue } : r)));
    }
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
      const sorted = [...regs].sort((a, b) => sessionDateTimeMs(a) - sessionDateTimeMs(b));
      for (let i = 0; i < sorted.length; i++) {
        result.set(sorted[i].id, { withinPackage: i < pkg.package_type, packagePaid: pkg.is_paid });
      }
    }
    return result;
  }, [registrations, packages]);

  const unpaid = useMemo(() => {
    const seenCamps = new Set<string>();
    return registrations
      .filter((r) => {
        if (r.status !== "confirmed" || r.is_paid) return false;
        const mem = packageMembership.get(r.id);
        if (mem?.withinPackage && mem.packagePaid) return false;
        // Full camps are one payment covering all days — only show one row per camp group
        if (r.is_full_camp && r.referral_code) {
          if (seenCamps.has(r.referral_code)) return false;
          seenCamps.add(r.referral_code);
        }
        return true;
      })
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date));
  }, [registrations, packageMembership]);

  const paid = useMemo(() => {
    const seenCamps = new Set<string>();
    const now = Date.now();
    return registrations
      .filter((r) => {
        if (r.status !== "confirmed" || !r.is_paid || sessionDateTimeMs(r) + 24 * 3600 * 1000 <= now) return false;
        if (r.is_full_camp && r.referral_code) {
          if (seenCamps.has(r.referral_code)) return false;
          seenCamps.add(r.referral_code);
        }
        return true;
      })
      .sort((a, b) => sessionDateTimeMs(a) - sessionDateTimeMs(b));
  }, [registrations]);

  function fullPriceForType(type: string): number {
    if (type === "group-private") return 250;
    if (type === "private") return 150;
    return 50;
  }

  // Volume discount rates for group sessions booked together (where session_price was not stored)
  const weeklyDiscountRates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of registrations) {
      if (r.type === "weekly" && !r.is_full_camp && r.referral_code && r.session_price == null) {
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

  function effectiveAmount(r: Registration): number {
    const isPrivateType = r.type === "private" || r.type === "group-private";
    let basePrice: number;
    if (r.session_price != null) {
      basePrice = r.session_price;
    } else if (r.type === "weekly" && !r.is_full_camp && r.referral_code && weeklyDiscountRates.has(r.referral_code)) {
      const discount = weeklyDiscountRates.get(r.referral_code)!;
      basePrice = Math.round(50 * (r.total_participants || 1) * (1 - discount));
    } else {
      basePrice = fullPriceForType(r.type);
    }
    if (r.is_free && isPrivateType) return Math.round(basePrice * 0.5);
    return basePrice;
  }

  const cancelFees = useMemo(() =>
    registrations.filter((r) => (r.is_late_cancel || r.status === "no_show") && !r.cancel_fee_settled),
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
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Dashboard
            </Link>
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
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
          </div>
        </aside>

      <div className="flex-1 min-w-0 px-4 sm:px-6 py-8 space-y-12">

        {/* Backfill tool for past group session discounts */}
        <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white">Fix past group session prices</p>
            <p className="text-xs text-brown-400 mt-0.5">Writes the correct discounted price into the database for any old group bookings that are still showing $50.</p>
            {backfillResult && <p className="text-xs text-green-400 mt-1">{backfillResult}</p>}
          </div>
          <button
            onClick={backfillGroupPrices}
            disabled={backfilling}
            className="shrink-0 rounded-lg bg-mesa-accent hover:bg-mesa-accent/80 px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50"
          >
            {backfilling ? "Running…" : "Run Fix"}
          </button>
        </div>

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
                const pkgMem = packageMembership.get(r.id);
                const amount = effectiveAmount(r);
                return (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-blue-900 shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                      {r.is_full_camp && <span className="rounded-full bg-purple-900/40 text-purple-300 px-2 py-0.5 text-xs font-medium shrink-0">full camp</span>}
                      {pkgMem?.withinPackage && (
                        <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium shrink-0">pkg</span>
                      )}
                      {da && <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${da.cls}`}>{da.label}</span>}
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5 truncate">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
                      <span>{r.is_full_camp ? "Full camp total" : formatDate(r.booked_date)}</span>
                      <span>{r.phone}</span>
                      <span className="ml-auto text-brown-400 font-medium">${amount}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => togglePaid(r.id, r.is_paid, r.is_full_camp ? r.referral_code : null)}
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
                const sessionPrice = effectiveAmount(r);
                const isNoShow = r.status === "no_show";
                const fee = isNoShow ? sessionPrice : Math.round(sessionPrice * 0.5);
                const owesRefund = r.is_paid;
                return (
                  <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium text-sm">{r.parent_name}</span>
                        <span className="text-lg font-bold text-mesa-accent">${fee}</span>
                        {isNoShow && (
                          <span className="rounded-full bg-orange-900/40 px-2 py-0.5 text-xs font-medium text-orange-400">no show</span>
                        )}
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
                const amount = effectiveAmount(r);
                return (
                <div key={r.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3 opacity-60">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-sm">{r.parent_name}</span>
                      <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-blue-900 shrink-0">{TYPE_LABELS[r.type] || r.type}</span>
                      {packageMembership.get(r.id)?.withinPackage && (
                        <span className="rounded-full bg-teal-900/40 text-teal-400 px-2 py-0.5 text-xs font-medium shrink-0">pkg</span>
                      )}
                      {da && <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${da.cls}`}>{da.label}</span>}
                    </div>
                    {r.kids && <div className="text-xs text-white mt-0.5 truncate">{r.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>}
                    <div className="text-xs text-brown-400 mt-0.5 truncate">{sessionLabel(r)}</div>
                    <div className="flex flex-wrap gap-x-3 mt-1 text-xs text-brown-500">
                      <span>{formatDate(r.booked_date)}</span>
                      <span>{r.phone}</span>
                      <span className="ml-auto text-brown-400 font-medium">${amount}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => togglePaid(r.id, r.is_paid, r.is_full_camp ? r.referral_code : null)}
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
