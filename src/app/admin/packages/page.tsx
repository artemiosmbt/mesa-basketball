"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

interface Package {
  id: string;
  created_at: string;
  email: string;
  parent_name: string;
  phone: string;
  package_type: number;
  month_year: string;
  sessions_used: number;
  reminder_sent: boolean;
  status: string;
  is_paid: boolean;
}

function monthLabel(monthYear: string): string {
  const [y, m] = monthYear.split("-");
  return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function expiryDate(monthYear: string): Date {
  const [y, m] = monthYear.split("-");
  return new Date(parseInt(y), parseInt(m), 0); // last day of month
}

function daysUntilExpiry(monthYear: string): number {
  const exp = expiryDate(monthYear);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatExpiry(monthYear: string): string {
  const d = expiryDate(monthYear);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function PackagesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [packages, setPackages] = useState<Package[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState("all");

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      if (!session || session.user.email !== ADMIN_EMAIL) {
        router.replace("/login");
        return;
      }
      setToken(session.access_token);
      fetch("/api/admin/packages", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => r.json())
        .then((data) => setPackages(data.packages || []))
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function togglePaid(pkg: Package) {
    if (!token) return;
    setToggling(pkg.id);
    const newVal = !pkg.is_paid;
    await fetch("/api/admin/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: pkg.id, is_paid: newVal }),
    });
    setPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, is_paid: newVal } : p)));
    setToggling(null);
  }

  const allMonths = useMemo(() => {
    const months = [...new Set(packages.map((p) => p.month_year))].sort().reverse();
    return months;
  }, [packages]);

  const currentMonthYear = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  const filtered = useMemo(() => {
    return packages.filter((p) => {
      if (monthFilter !== "all" && p.month_year !== monthFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!p.parent_name?.toLowerCase().includes(q) && !p.email?.toLowerCase().includes(q) && !p.phone?.includes(q)) return false;
      }
      return true;
    });
  }, [packages, monthFilter, search]);

  const stats = useMemo(() => ({
    total: filtered.length,
    active: filtered.filter((p) => p.status === "active").length,
    paid: filtered.filter((p) => p.is_paid).length,
    unpaid: filtered.filter((p) => !p.is_paid).length,
  }), [filtered]);

  function PackageCard({ pkg }: { pkg: Package }) {
    const remaining = pkg.package_type - pkg.sessions_used;
    const days = daysUntilExpiry(pkg.month_year);
    const isExpired = days < 0;

    return (
      <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-sm">{pkg.parent_name}</div>
            <div className="text-xs text-brown-400 truncate mt-0.5">{pkg.email}</div>
            <div className="text-xs text-brown-500 mt-0.5">{pkg.phone}</div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="rounded-full bg-mesa-accent/20 text-mesa-accent px-2 py-0.5 text-xs font-bold">
              {pkg.package_type}-Session
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isExpired ? "bg-brown-800 text-brown-400" :
              pkg.status === "active" ? "bg-green-900/40 text-green-400" :
              "bg-brown-800 text-brown-400"
            }`}>
              {isExpired ? "expired" : pkg.status}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-brown-500 uppercase tracking-wider mb-0.5">Month</p>
            <p className="text-brown-200">{monthLabel(pkg.month_year)}</p>
          </div>
          <div>
            <p className="text-brown-500 uppercase tracking-wider mb-0.5">Expires</p>
            <p className={`font-medium ${isExpired ? "text-brown-500" : days <= 5 ? "text-red-400" : days <= 10 ? "text-orange-400" : "text-brown-200"}`}>
              {formatExpiry(pkg.month_year)}
              {!isExpired && <span className="text-brown-500 ml-1">({days}d)</span>}
              {isExpired && <span className="text-brown-600 ml-1">(expired)</span>}
            </p>
          </div>
          <div>
            <p className="text-brown-500 uppercase tracking-wider mb-0.5">Sessions</p>
            <p className="text-brown-200">
              <span className="font-bold text-mesa-accent">{remaining}</span>
              <span className="text-brown-500"> / {pkg.package_type} left</span>
            </p>
            <div className="flex gap-0.5 mt-1">
              {Array.from({ length: pkg.package_type }).map((_, i) => (
                <div key={i} className={`h-1.5 flex-1 rounded-full ${i < pkg.sessions_used ? "bg-mesa-accent/50" : "bg-mesa-accent"}`} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-brown-500 uppercase tracking-wider mb-0.5">Payment</p>
            <button
              onClick={() => togglePaid(pkg)}
              disabled={toggling === pkg.id}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                pkg.is_paid
                  ? "bg-green-900/50 text-green-400 hover:bg-green-900/70"
                  : "bg-red-900/40 text-red-400 hover:bg-red-900/60"
              }`}
            >
              {toggling === pkg.id ? "..." : pkg.is_paid ? "Paid ✓" : "Unpaid"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="min-h-screen bg-brown-950 flex items-center justify-center"><p className="text-brown-400">Loading...</p></div>;
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
              <p className="font-[family-name:var(--font-oswald)] text-base sm:text-xl font-bold tracking-wide text-mesa-dark leading-tight">ADMIN</p>
              <p className="text-xs text-brown-500 leading-tight">Monthly Packages</p>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile tab bar */}
      <div className="md:hidden border-b border-gray-200 bg-white px-4 flex items-center gap-1 overflow-x-auto">
        <Link href="/admin" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Dashboard</Link>
        <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Payments</Link>
        <Link href="/admin/packages" className="shrink-0 px-3 py-2.5 text-sm font-semibold text-mesa-dark border-b-2 border-mesa-dark">Packages</Link>
        <Link href="/admin/virtual-training" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Virtual Training</Link>
        <Link href="/admin/virtual-training/drills" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Drills</Link>
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-2">
          <Link href="/" className="text-xs text-brown-400">← Site</Link>
        </div>
      </div>

      <div className="flex flex-1 min-w-0 w-full">
        {/* Sidebar */}
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-brown-800 bg-brown-900/30 px-3 py-6 sticky top-0 h-screen">
          <nav className="flex-1 space-y-1">
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Dashboard
            </Link>
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">
              Payments
            </Link>
            <Link href="/admin/packages" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { label: "Total", value: stats.total },
              { label: "Active", value: stats.active },
              { label: "Paid", value: stats.paid },
              { label: "Unpaid", value: stats.unpaid },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-4 text-center">
                <p className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-mesa-accent">{s.value}</p>
                <p className="text-xs text-brown-400 mt-1">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-3 mb-6">
            <input
              type="text"
              placeholder="Search by name, email, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none w-full sm:w-64"
            />
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setMonthFilter("all")}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${monthFilter === "all" ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}
              >
                All Months
              </button>
              <button
                onClick={() => setMonthFilter(currentMonthYear)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${monthFilter === currentMonthYear ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}
              >
                This Month
              </button>
              {allMonths.filter((m) => m !== currentMonthYear).map((m) => (
                <button
                  key={m}
                  onClick={() => setMonthFilter(m)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${monthFilter === m ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}
                >
                  {monthLabel(m)}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-brown-500 mb-3">{filtered.length} package{filtered.length !== 1 ? "s" : ""}</p>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {filtered.length === 0 && (
              <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">No packages found.</div>
            )}
            {filtered.map((pkg) => <PackageCard key={pkg.id} pkg={pkg} />)}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block rounded-xl border border-brown-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                <tr>
                  <th className="px-4 py-3 text-left">Client</th>
                  <th className="px-4 py-3 text-left">Package</th>
                  <th className="px-4 py-3 text-left">Month</th>
                  <th className="px-4 py-3 text-left">Expires</th>
                  <th className="px-4 py-3 text-left">Sessions</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brown-800">
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-brown-500">No packages found.</td></tr>
                )}
                {filtered.map((pkg) => {
                  const remaining = pkg.package_type - pkg.sessions_used;
                  const days = daysUntilExpiry(pkg.month_year);
                  const isExpired = days < 0;
                  return (
                    <tr key={pkg.id} className="hover:bg-brown-900/30 transition">
                      <td className="px-4 py-3">
                        <div className="font-medium whitespace-nowrap">{pkg.parent_name}</div>
                        <div className="text-xs text-brown-400">{pkg.email}</div>
                        <div className="text-xs text-brown-500">{pkg.phone}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="rounded-full bg-mesa-accent/20 text-mesa-accent px-2 py-0.5 text-xs font-bold">
                          {pkg.package_type}-Session
                        </span>
                      </td>
                      <td className="px-4 py-3 text-brown-300 whitespace-nowrap text-xs">{monthLabel(pkg.month_year)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        <div className={`font-medium ${isExpired ? "text-brown-500" : days <= 5 ? "text-red-400" : days <= 10 ? "text-orange-400" : "text-brown-200"}`}>
                          {formatExpiry(pkg.month_year)}
                        </div>
                        <div className="text-brown-500">
                          {isExpired ? "expired" : `${days}d left`}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm">
                          <span className="font-bold text-mesa-accent">{remaining}</span>
                          <span className="text-brown-500 text-xs"> / {pkg.package_type} left</span>
                        </div>
                        <div className="flex gap-0.5 mt-1">
                          {Array.from({ length: pkg.package_type }).map((_, i) => (
                            <div key={i} className={`h-1.5 w-3 rounded-full ${i < pkg.sessions_used ? "bg-mesa-accent/40" : "bg-mesa-accent"}`} />
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          isExpired ? "bg-brown-800 text-brown-400" :
                          pkg.status === "active" ? "bg-green-900/40 text-green-400" :
                          "bg-brown-800 text-brown-400"
                        }`}>
                          {isExpired ? "expired" : pkg.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <button
                          onClick={() => togglePaid(pkg)}
                          disabled={toggling === pkg.id}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                            pkg.is_paid
                              ? "bg-green-900/50 text-green-400 hover:bg-green-900/70"
                              : "bg-red-900/40 text-red-400 hover:bg-red-900/60"
                          }`}
                        >
                          {toggling === pkg.id ? "..." : pkg.is_paid ? "Paid ✓" : "Unpaid"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
