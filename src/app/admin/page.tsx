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
}

const TYPE_LABELS: Record<string, string> = {
  weekly: "Group",
  camp: "Camp",
  private: "Private",
  "group-private": "Group Private",
};

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("confirmed");
  const [search, setSearch] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

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

  async function cancelRegistration(id: string) {
    if (!token) return;
    if (!confirm("Cancel this registration?")) return;
    setCancelling(id);
    await fetch("/api/admin/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id }),
    });
    setRegistrations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "cancelled" } : r))
    );
    setCancelling(null);
  }

  const filtered = useMemo(() => {
    return registrations.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !r.parent_name?.toLowerCase().includes(q) &&
          !r.email?.toLowerCase().includes(q) &&
          !r.phone?.includes(q)
        )
          return false;
      }
      return true;
    });
  }, [registrations, typeFilter, statusFilter, search]);

  const stats = useMemo(() => ({
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "confirmed").length,
    cancelled: registrations.filter((r) => r.status === "cancelled").length,
    camps: registrations.filter((r) => r.type === "camp" && r.status === "confirmed").length,
    groups: registrations.filter((r) => r.type === "weekly" && r.status === "confirmed").length,
  }), [registrations]);

  if (loading) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center">
        <p className="text-brown-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brown-950 text-white">
      {/* Header */}
      <div className="border-b border-brown-800 bg-brown-900/50 px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white flex items-center justify-center">
              <img src="/logo.png" alt="Mesa" className="h-8 w-8 object-contain" />
            </div>
            <div>
              <p className="font-[family-name:var(--font-oswald)] text-xl font-bold tracking-wide">ADMIN DASHBOARD</p>
              <p className="text-xs text-brown-400">Mesa Basketball Training</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-brown-400 hover:text-white">← Site</Link>
            <button
              onClick={() => authClient.auth.signOut().then(() => router.push("/login"))}
              className="text-sm rounded-lg border border-brown-700 px-3 py-1.5 text-brown-400 hover:text-white hover:border-brown-500 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
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

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <input
            type="text"
            placeholder="Search by name, email, or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2 text-sm text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none w-64"
          />
          <div className="flex gap-1">
            {["all", "weekly", "camp", "private", "group-private"].map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${typeFilter === t ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}
              >
                {t === "all" ? "All Types" : TYPE_LABELS[t] || t}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {["all", "confirmed", "cancelled"].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition capitalize ${statusFilter === s ? "bg-mesa-accent text-white" : "border border-brown-700 text-brown-400 hover:text-white"}`}
              >
                {s === "all" ? "All Status" : s}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-brown-500 mb-3">{filtered.length} registration{filtered.length !== 1 ? "s" : ""}</p>

        {/* Table */}
        <div className="rounded-xl border border-brown-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-brown-900/60 text-xs uppercase tracking-wider text-brown-400">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Parent</th>
                  <th className="px-4 py-3 text-left">Email</th>
                  <th className="px-4 py-3 text-left">Phone</th>
                  <th className="px-4 py-3 text-left">Athletes</th>
                  <th className="px-4 py-3 text-left">Type</th>
                  <th className="px-4 py-3 text-left">Session</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brown-800">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-brown-900/30 transition">
                    <td className="px-4 py-3 text-brown-400 whitespace-nowrap text-xs">
                      {new Date(r.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{r.parent_name}</td>
                    <td className="px-4 py-3 text-brown-300 text-xs">{r.email}</td>
                    <td className="px-4 py-3 text-brown-300 text-xs whitespace-nowrap">{r.phone}</td>
                    <td className="px-4 py-3 text-brown-400 text-xs max-w-[160px] truncate" title={r.kids}>{r.kids}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="rounded-full bg-brown-800 px-2 py-0.5 text-xs text-mesa-accent">
                        {TYPE_LABELS[r.type] || r.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-brown-400 text-xs max-w-[200px] truncate" title={r.session_details}>
                      {r.session_details}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "confirmed" ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.status === "confirmed" && (
                        <button
                          onClick={() => cancelRegistration(r.id)}
                          disabled={cancelling === r.id}
                          className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50"
                        >
                          {cancelling === r.id ? "..." : "Cancel"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-brown-500">No registrations found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
