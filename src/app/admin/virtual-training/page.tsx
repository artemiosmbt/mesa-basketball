"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

interface WaitlistEntry {
  id: string;
  email: string;
  created_at: string;
}

export default function VirtualTrainingAdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      if (!session || session.user.email !== ADMIN_EMAIL) {
        router.replace("/login");
        return;
      }
      setToken(session.access_token);
      fetch("/api/admin/virtual-training", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => r.json())
        .then((data) => setWaitlist(data.waitlist || []))
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function removeFromWaitlist(id: string, email: string) {
    if (!token) return;
    if (!confirm(`Remove ${email} from the waitlist?`)) return;
    setRemoving(id);
    await fetch("/api/admin/virtual-training", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    setWaitlist((prev) => prev.filter((e) => e.id !== id));
    setRemoving(null);
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
              <p className="font-[family-name:var(--font-oswald)] text-base sm:text-xl font-bold tracking-wide text-mesa-dark leading-tight">VIRTUAL TRAINING</p>
              <p className="text-xs text-brown-500 leading-tight">Mesa Basketball Training</p>
            </div>
          </div>
        </div>
      </div>
      {/* Mobile tab bar */}
      <div className="md:hidden border-b border-gray-200 bg-white px-4 flex items-center gap-1 overflow-x-auto">
        <Link href="/admin" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Dashboard</Link>
        <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Payments</Link>
        <Link href="/admin/virtual-training" className="shrink-0 px-3 py-2.5 text-sm font-semibold text-mesa-dark border-b-2 border-mesa-dark">Virtual Training</Link>
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
            <Link href="/admin/virtual-training" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">
              Virtual Training
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

        <div className="flex-1 min-w-0 px-4 sm:px-6 py-8 space-y-8">

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-5 text-center">
              <p className="font-[family-name:var(--font-oswald)] text-4xl font-bold text-mesa-accent">
                {loading ? "—" : waitlist.length}
              </p>
              <p className="text-xs text-brown-400 mt-1 uppercase tracking-wide">Waitlist Sign-Ups</p>
            </div>
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-5 text-center">
              <p className="font-[family-name:var(--font-oswald)] text-4xl font-bold text-brown-500">0</p>
              <p className="text-xs text-brown-400 mt-1 uppercase tracking-wide">Active Subscribers</p>
            </div>
            <div className="rounded-xl border border-brown-700 bg-brown-900/40 px-6 py-5 text-center col-span-2 md:col-span-1">
              <p className="font-[family-name:var(--font-oswald)] text-4xl font-bold text-brown-500">—</p>
              <p className="text-xs text-brown-400 mt-1 uppercase tracking-wide">Monthly Revenue</p>
            </div>
          </div>

          {/* Waitlist */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold tracking-wide">
                Waitlist
                <span className="ml-2 text-sm font-normal text-brown-400">({loading ? "…" : waitlist.length} emails)</span>
              </h2>
              <span className="text-xs rounded-full bg-mesa-accent/20 border border-mesa-accent/40 px-3 py-1 text-mesa-accent font-semibold">
                Pre-Launch
              </span>
            </div>

            {loading ? (
              <p className="text-brown-500 text-sm">Loading...</p>
            ) : waitlist.length === 0 ? (
              <p className="text-brown-500 text-sm">No sign-ups yet.</p>
            ) : (
              <div className="rounded-xl border border-brown-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brown-700 bg-brown-900/60 text-left">
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-brown-400">#</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-brown-400">Email</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-brown-400">Signed Up</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-brown-400">Plan</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-brown-400"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {waitlist.map((entry, i) => (
                      <tr key={entry.id} className="border-b border-brown-800 last:border-0 hover:bg-brown-900/40 transition">
                        <td className="px-4 py-3 text-brown-500">{i + 1}</td>
                        <td className="px-4 py-3 text-white font-medium">{entry.email}</td>
                        <td className="px-4 py-3 text-brown-400">
                          {new Date(entry.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs rounded-full bg-brown-800 px-2.5 py-1 text-brown-400">Waitlist</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => removeFromWaitlist(entry.id, entry.email)}
                            disabled={removing === entry.id}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 transition"
                          >
                            {removing === entry.id ? "Removing…" : "Remove"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Subscriptions placeholder */}
          <div>
            <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold tracking-wide mb-4">
              Subscribers
              <span className="ml-2 text-sm font-normal text-brown-400">(0 active)</span>
            </h2>
            <div className="rounded-xl border border-brown-700 bg-brown-900/20 px-8 py-10 text-center">
              <p className="text-brown-500 text-sm">No active subscribers yet — launching soon.</p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
