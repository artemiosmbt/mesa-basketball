"use client";

import { useState, useEffect, useMemo } from "react";
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

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [videoConsentMap, setVideoConsentMap] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"upcoming" | "past" | "clients">("upcoming");
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

  const todayMs = new Date().setHours(0, 0, 0, 0);

  const upcoming = useMemo(() =>
    registrations
      .filter((r) => r.status === "confirmed" && dateMs(r.booked_date) >= todayMs)
      .sort((a, b) => dateMs(a.booked_date) - dateMs(b.booked_date)),
  [registrations, todayMs]);

  const past = useMemo(() =>
    registrations
      .filter((r) => dateMs(r.booked_date) < todayMs && dateMs(r.booked_date) > 0)
      .sort((a, b) => dateMs(b.booked_date) - dateMs(a.booked_date)),
  [registrations, todayMs]);

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

  function RegCard({ r, showDelete = false }: { r: Registration; showDelete?: boolean }) {
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
            {(r.status === "confirmed" || showDelete) && (
              <div className="flex flex-wrap gap-3 pt-1 border-t border-brown-800">
                {r.status === "confirmed" && (
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
                {showDelete && (
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

  function RegTableRows({ list }: { list: Registration[] }) {
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
            <td className="px-4 py-3">
              {r.status === "confirmed" && (
                <div className="flex flex-col gap-1">
                  <button onClick={() => cancelRegistration(r.id)} disabled={cancelling === r.id} className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50">
                    {cancelling === r.id ? "..." : "Cancel"}
                  </button>
                  {noShowConfirm !== r.id ? (
                    <button onClick={() => setNoShowConfirm(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 transition disabled:opacity-50">
                      No Show
                    </button>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-orange-300 font-semibold">Are you sure?</span>
                      <div className="flex gap-2">
                        <button onClick={() => markNoShow(r.id)} disabled={noShowing === r.id} className="text-xs text-orange-400 hover:text-orange-300 font-semibold transition disabled:opacity-50">
                          {noShowing === r.id ? "..." : "Yes"}
                        </button>
                        <button onClick={() => setNoShowConfirm(null)} className="text-xs text-brown-500 hover:text-brown-300 transition">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
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
          {(["upcoming", "past", "clients"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedClient(null); }}
              className={`px-3 py-2 rounded-lg text-sm font-semibold capitalize transition ${tab === t ? "bg-mesa-accent text-white" : "bg-brown-900 text-brown-400 hover:text-white"}`}
            >
              {t === "upcoming" ? `Upcoming (${upcoming.length})` : t === "past" ? "Past" : "Clients"}
            </button>
          ))}
        </div>

        {/* Filters — not shown on clients tab */}
        {tab !== "clients" && (
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
            <p className="text-xs text-brown-500 mb-3">{displayedUpcoming.length} session{displayedUpcoming.length !== 1 ? "s" : ""}</p>
            <div className="md:hidden space-y-3">
              {displayedUpcoming.length === 0 && <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">No upcoming sessions.</div>}
              {displayedUpcoming.map((r) => <RegCard key={r.id} r={r} />)}
            </div>
            <div className="hidden md:block rounded-xl border border-brown-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                  <tr>
                    <th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brown-800"><RegTableRows list={displayedUpcoming} /></tbody>
              </table>
            </div>
          </>
        )}

        {/* Past */}
        {tab === "past" && (
          <>
            <p className="text-xs text-brown-500 mb-3">{displayedPast.length} session{displayedPast.length !== 1 ? "s" : ""}</p>
            <div className="md:hidden space-y-3">
              {displayedPast.length === 0 && <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-8 text-center text-brown-500 text-sm">No past sessions.</div>}
              {displayedPast.map((r) => <RegCard key={r.id} r={r} />)}
            </div>
            <div className="hidden md:block rounded-xl border border-brown-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                  <tr>
                    <th className="px-4 py-3 text-left">Registered</th><th className="px-4 py-3 text-left">Parent</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Phone</th><th className="px-4 py-3 text-left">Athletes</th><th className="px-4 py-3 text-left">Type</th><th className="px-4 py-3 text-left">Session</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brown-800"><RegTableRows list={displayedPast} /></tbody>
              </table>
            </div>
          </>
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
