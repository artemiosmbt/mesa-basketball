"use client";

import { useState, useEffect, useMemo, type FormEvent } from "react";
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
  booked_group: string | null;
  status: string;
  is_paid: boolean;
  stripe_payment_intent_id: string | null;
  is_late_cancel: boolean;
  cancel_fee_settled: boolean;
  session_price: number | null;
  total_participants: number | null;
  is_free: boolean;
  used_referral_credit: boolean;
  is_full_camp: boolean;
  referral_code: string | null;
  camp_day_late_fee: number | null;
  camp_drop_in_rate: number | null;
  applied_account_credit: number | null;
  booking_batch_id: string | null;
}

interface PackageData {
  id: string;
  email: string;
  package_type: number;
  month_year: string;
  is_paid: boolean;
}

interface AccountCreditData {
  email: string;
  balance: number;
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

// referral_code alone isn't a unique purchase ID — it's the client's own permanent
// referral code, identical across every full-camp purchase they've ever made.
// booked_group (the camp's own name) disambiguates which specific camp this is.
function campGroupKey(r: Registration): string {
  return `${r.referral_code ?? ""}::${r.booked_group ?? ""}`;
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
  const [accountCredits, setAccountCredits] = useState<AccountCreditData[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [togglingPaid, setTogglingPaid] = useState<string | null>(null);
  const [settlingFee, setSettlingFee] = useState<string | null>(null);
  const [showAllPaid, setShowAllPaid] = useState(false);
  const [creditEmail, setCreditEmail] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [addingCredit, setAddingCredit] = useState(false);
  const [creditMessage, setCreditMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [editingCreditEmail, setEditingCreditEmail] = useState<string | null>(null);
  const [editingCreditValue, setEditingCreditValue] = useState("");
  const [savingCreditEdit, setSavingCreditEdit] = useState(false);
  const [now] = useState(() => Date.now());

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
          setAccountCredits(data.accountCredits || []);
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function togglePaid(id: string, currentValue: boolean, referralCode?: string | null, bookedGroup?: string | null) {
    if (!token) return;
    setTogglingPaid(id);
    await fetch("/api/admin/update-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, field: "is_paid", value: !currentValue, ...(referralCode ? { referralCode, bookedGroup: bookedGroup ?? null } : {}) }),
    });
    if (referralCode) {
      // Full camp: update all day rows belonging to this specific camp group
      setRegistrations((prev) => prev.map((r) => r.referral_code === referralCode && r.booked_group === (bookedGroup ?? null) ? { ...r, is_paid: !currentValue } : r));
    } else {
      setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, is_paid: !currentValue } : r)));
    }
    setTogglingPaid(null);
  }

  async function submitCreditAdjustment(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    const email = creditEmail.trim().toLowerCase();
    const amount = parseFloat(creditAmount);
    if (!email || !amount) {
      setCreditMessage({ text: "Enter an email and a non-zero dollar amount.", isError: true });
      return;
    }
    setAddingCredit(true);
    setCreditMessage(null);
    const res = await fetch("/api/admin/account-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, amount }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setCreditMessage({ text: data?.error || "Failed to update credit.", isError: true });
      setAddingCredit(false);
      return;
    }
    setAccountCredits((prev) => {
      const existing = prev.find((a) => a.email === email);
      const newBalance = (existing?.balance ?? 0) + amount;
      if (existing) {
        return newBalance > 0
          ? prev.map((a) => (a.email === email ? { ...a, balance: newBalance } : a))
          : prev.filter((a) => a.email !== email);
      }
      return newBalance > 0 ? [...prev, { email, balance: newBalance }] : prev;
    });
    setCreditMessage({ text: `${amount > 0 ? "Added" : "Removed"} $${Math.abs(amount)} ${amount > 0 ? "to" : "from"} ${email}'s account credit.`, isError: false });
    setCreditEmail("");
    setCreditAmount("");
    setAddingCredit(false);
  }

  function startEditingCredit(email: string, currentBalance: number) {
    setEditingCreditEmail(email);
    setEditingCreditValue(String(currentBalance));
    setCreditMessage(null);
  }

  // Lets the admin type the balance they want a client to end up at, rather
  // than compute a delta by hand — reuses the same delta-based endpoint the
  // Add form above already uses, just with the delta worked out here first.
  async function submitCreditEdit(email: string, currentBalance: number) {
    if (!token) return;
    const newBalance = parseFloat(editingCreditValue);
    if (isNaN(newBalance) || newBalance < 0) {
      setCreditMessage({ text: "Enter a valid non-negative balance.", isError: true });
      return;
    }
    const delta = Math.round((newBalance - currentBalance) * 100) / 100;
    if (delta === 0) {
      setEditingCreditEmail(null);
      return;
    }
    setSavingCreditEdit(true);
    setCreditMessage(null);
    const res = await fetch("/api/admin/account-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, amount: delta }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setCreditMessage({ text: data?.error || "Failed to update credit.", isError: true });
      setSavingCreditEdit(false);
      return;
    }
    setAccountCredits((prev) =>
      newBalance > 0
        ? prev.map((a) => (a.email === email ? { ...a, balance: newBalance } : a))
        : prev.filter((a) => a.email !== email)
    );
    setCreditMessage({ text: `${email}'s account credit set to $${newBalance}.`, isError: false });
    setEditingCreditEmail(null);
    setSavingCreditEdit(false);
  }

  async function settleFee(id: string, referralCode?: string | null, bookedGroup?: string | null) {
    if (!token) return;
    setSettlingFee(id);
    await fetch("/api/admin/update-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, field: "cancel_fee_settled", value: true, ...(referralCode ? { referralCode, bookedGroup: bookedGroup ?? null } : {}) }),
    });
    if (referralCode) {
      setRegistrations((prev) => prev.map((r) => r.referral_code === referralCode && r.booked_group === (bookedGroup ?? null) ? { ...r, cancel_fee_settled: true } : r));
    } else {
      setRegistrations((prev) => prev.map((r) => (r.id === id ? { ...r, cancel_fee_settled: true } : r)));
    }
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

  // Now that Stripe collects payment upfront for every new booking, this
  // list only has a reason to show anything for the pre-Stripe backlog:
  // sessions that already happened, booked before the switch, still
  // waiting on a manual cash/Venmo/Zelle payment. A real Stripe payment
  // never shows here (checked via stripe_payment_intent_id, not just
  // is_paid — that field is never set for a Stripe-collected booking, so
  // checking is_paid alone was wrongly showing paid clients as unpaid).
  // A future booking never belongs here at all: it's either already paid
  // through Stripe or the checkout was never completed, in which case it
  // was never confirmed in the first place. Once the backlog clears out,
  // this list stays empty for good — kept around only in case a future
  // non-Stripe payment path is ever added back.
  const unpaid = useMemo(() => {
    const seenCamps = new Set<string>();
    return registrations
      .filter((r) => {
        if (r.status !== "confirmed" || r.is_paid || r.stripe_payment_intent_id) return false;
        if (sessionDateTimeMs(r) > now) return false;
        const mem = packageMembership.get(r.id);
        if (mem?.withinPackage && mem.packagePaid) return false;
        // Full camps are one payment covering all days — only show one row per camp group
        if (r.is_full_camp && r.referral_code) {
          const key = campGroupKey(r);
          if (seenCamps.has(key)) return false;
          seenCamps.add(key);
        }
        return true;
      })
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date));
  }, [registrations, packageMembership, now]);

  const paid = useMemo(() => {
    const seenCamps = new Set<string>();
    return registrations
      .filter((r) => {
        if (r.status !== "confirmed" || !r.is_paid || sessionDateTimeMs(r) + 24 * 3600 * 1000 <= now) return false;
        if (r.is_full_camp && r.referral_code) {
          const key = campGroupKey(r);
          if (seenCamps.has(key)) return false;
          seenCamps.add(key);
        }
        return true;
      })
      .sort((a, b) => sessionDateTimeMs(a) - sessionDateTimeMs(b));
  }, [registrations, now]);

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

  // Recomputed current total per full-camp referral_code group (capped at the
  // original full-week price), shared by effectiveAmount() and campAdjustments
  // below so both agree on the same number for a given family.
  const campGroupFinalAmounts = useMemo(() => {
    const groups = new Map<string, Registration[]>();
    for (const r of registrations) {
      if (!r.is_full_camp || !r.referral_code) continue;
      const key = campGroupKey(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const map = new Map<string, number>();
    for (const [key, rows] of groups) {
      const originalAmount = rows[0].session_price ?? 0;
      const confirmed = rows.filter((r) => r.status === "confirmed");
      const cancelled = rows.filter((r) => r.status === "cancelled");
      const perDayRate = rows[0].camp_drop_in_rate ?? Math.round(originalAmount / rows.length);
      const recomputedPrice = Math.min(confirmed.length * perDayRate, originalAmount);
      const accruedFees = cancelled.reduce((sum, r) => sum + (r.camp_day_late_fee || 0), 0);
      map.set(key, Math.min(originalAmount, recomputedPrice + accruedFees));
    }
    return map;
  }, [registrations]);

  function effectiveAmount(r: Registration): number {
    const isPrivateType = r.type === "private" || r.type === "group-private";
    let basePrice: number;
    if (r.is_full_camp && r.referral_code && campGroupFinalAmounts.has(campGroupKey(r))) {
      basePrice = campGroupFinalAmounts.get(campGroupKey(r))!;
    } else if (r.session_price != null) {
      basePrice = r.session_price;
    } else if (r.type === "weekly" && !r.is_full_camp && r.referral_code && weeklyDiscountRates.has(r.referral_code)) {
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

  const cancelFees = useMemo(() =>
    // Full-camp rows are handled separately by campAdjustments below (recomputed
    // per-group total, capped at the full-week price) instead of the flat 50% used here.
    registrations.filter((r) => (r.is_late_cancel || r.status === "no_show") && !r.cancel_fee_settled && !r.is_full_camp),
  [registrations]);

  // Full-camp groups with some (not all) days cancelled — recomputed capped total,
  // one card per family rather than per cancelled day. Groups cancelled down to zero
  // days still go through the original whole-camp-cancel flow (email-only, unchanged).
  const campAdjustments = useMemo(() => {
    const groups = new Map<string, Registration[]>();
    for (const r of registrations) {
      if (!r.is_full_camp || !r.referral_code) continue;
      const key = campGroupKey(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const out: { key: string; referralCode: string; bookedGroup: string | null; parentName: string; finalAmount: number; originalAmount: number; isPaid: boolean; kids: string }[] = [];
    for (const [key, rows] of groups) {
      const cancelled = rows.filter((r) => r.status === "cancelled");
      const confirmed = rows.filter((r) => r.status === "confirmed");
      if (cancelled.length === 0 || confirmed.length === 0) continue; // untouched, or fully cancelled (handled elsewhere)
      if (cancelled.every((r) => r.cancel_fee_settled)) continue;
      const originalAmount = rows[0].session_price ?? 0;
      const finalAmount = campGroupFinalAmounts.get(key) ?? originalAmount;
      if (finalAmount === originalAmount) continue; // nothing changed, no adjustment to show
      out.push({ key, referralCode: rows[0].referral_code!, bookedGroup: rows[0].booked_group, parentName: rows[0].parent_name, finalAmount, originalAmount, isPaid: !!rows[0].is_paid, kids: rows[0].kids });
    }
    return out;
  }, [registrations, campGroupFinalAmounts]);

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
                    onClick={() => togglePaid(r.id, r.is_paid, r.is_full_camp ? r.referral_code : null, r.is_full_camp ? r.booked_group : null)}
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

        {/* Camp Adjustments — full-camp groups with some days cancelled, recomputed total */}
        {campAdjustments.length > 0 && (
          <div>
            <h2 className="font-[family-name:var(--font-oswald)] text-lg font-bold tracking-wide text-white mb-4">
              CAMP ADJUSTMENTS
              <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">{campAdjustments.length}</span>
            </h2>
            <div className="space-y-2">
              {campAdjustments.map((a) => {
                const creditIssued = a.isPaid;
                return (
                  <div key={a.key} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium text-sm">{a.parentName}</span>
                        <span className="text-lg font-bold text-mesa-accent">${a.finalAmount}</span>
                        <span className="text-xs text-brown-500">(was ${a.originalAmount})</span>
                        {creditIssued ? (
                          <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-400">Credit issued</span>
                        ) : (
                          <span className="rounded-full bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-400">Owes you</span>
                        )}
                      </div>
                      <div className="text-xs text-white mt-0.5 truncate">{a.kids.split(",").map((k) => k.split("(")[0].trim()).filter(Boolean).join(", ")}</div>
                    </div>
                    <button
                      onClick={() => settleFee(a.key, a.referralCode, a.bookedGroup)}
                      disabled={settlingFee === a.key}
                      className="shrink-0 rounded-lg bg-brown-700 hover:bg-brown-600 px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-50"
                    >
                      {settlingFee === a.key ? "…" : "Settled"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Account Credits */}
        <div>
          <h2 className="font-[family-name:var(--font-oswald)] text-lg font-bold tracking-wide text-white mb-4">
            ACCOUNT CREDITS
            {accountCredits.length > 0 && <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">{accountCredits.length}</span>}
          </h2>
          <form onSubmit={submitCreditAdjustment} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 mb-3 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs text-brown-400 mb-1">Client email</label>
              <input
                type="email"
                value={creditEmail}
                onChange={(e) => setCreditEmail(e.target.value)}
                placeholder="parent@example.com"
                className="w-full rounded-lg border border-brown-700 bg-brown-950 px-3 py-2 text-sm text-white placeholder:text-brown-600"
              />
            </div>
            <div className="w-28">
              <label className="block text-xs text-brown-400 mb-1">Amount ($)</label>
              <input
                type="number"
                step="0.01"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                placeholder="50"
                className="w-full rounded-lg border border-brown-700 bg-brown-950 px-3 py-2 text-sm text-white placeholder:text-brown-600"
              />
            </div>
            <button
              type="submit"
              disabled={addingCredit}
              className="rounded-lg bg-mesa-accent hover:bg-yellow-600 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
            >
              {addingCredit ? "…" : "Apply"}
            </button>
            <p className="w-full text-xs text-brown-500">Positive amount adds credit (e.g. a prepayment), negative removes it.</p>
            {creditMessage && (
              <p className={`w-full text-xs ${creditMessage.isError ? "text-red-400" : "text-green-400"}`}>{creditMessage.text}</p>
            )}
          </form>
          {accountCredits.length === 0 ? (
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-8 text-center text-brown-500 text-sm">No outstanding account credits.</div>
          ) : (
            <div className="space-y-2 mb-3">
              {accountCredits.map((a) => (
                <div key={a.email} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-3 flex items-center justify-between gap-3">
                  <span className="text-sm truncate">{a.email}</span>
                  {editingCreditEmail === a.email ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-brown-500 text-sm">$</span>
                      <input
                        type="number"
                        step="0.01"
                        autoFocus
                        value={editingCreditValue}
                        onChange={(e) => setEditingCreditValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submitCreditEdit(a.email, a.balance); if (e.key === "Escape") setEditingCreditEmail(null); }}
                        className="w-20 rounded-lg border border-brown-700 bg-brown-950 px-2 py-1 text-sm text-white"
                      />
                      <button
                        onClick={() => submitCreditEdit(a.email, a.balance)}
                        disabled={savingCreditEdit}
                        className="text-xs text-green-400 hover:text-green-300 font-semibold transition disabled:opacity-50"
                      >
                        {savingCreditEdit ? "…" : "Save"}
                      </button>
                      <button
                        onClick={() => setEditingCreditEmail(null)}
                        disabled={savingCreditEdit}
                        className="text-xs text-brown-500 hover:text-brown-300 transition disabled:opacity-50"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-lg font-bold text-blue-400">${a.balance}</span>
                      <button
                        onClick={() => startEditingCredit(a.email, a.balance)}
                        className="text-brown-500 hover:text-white transition"
                        title="Edit balance"
                      >
                        ✎
                      </button>
                    </div>
                  )}
                </div>
              ))}
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
                    onClick={() => togglePaid(r.id, r.is_paid, r.is_full_camp ? r.referral_code : null, r.is_full_camp ? r.booked_group : null)}
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
