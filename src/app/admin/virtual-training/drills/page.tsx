"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

const CATEGORIES = ["Ball Handling", "Finishing", "Mid Range", "Shooting"];
const LEVELS = ["Beginner", "Intermediate", "Advanced"];

interface Drill {
  id: string;
  title: string;
  description: string;
  category: string;
  level: string;
  difficulty: number;
  video_url: string;
  duration_mins: number;
  is_published: boolean;
  created_at: string;
}

const empty = {
  title: "",
  description: "",
  category: "Ball Handling",
  level: "Beginner",
  difficulty: 1,
  video_url: "",
  duration_mins: 12,
  is_published: true,
};

function youtubeId(url: string) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function YoutubeThumb({ url }: { url: string }) {
  const id = youtubeId(url);
  if (!id) return <span className="text-brown-600 text-xs">No preview</span>;
  return (
    <img
      src={`https://img.youtube.com/vi/${id}/mqdefault.jpg`}
      alt="thumbnail"
      className="w-24 h-14 object-cover rounded"
    />
  );
}

export default function DrillsAdminPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Drill | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filterCat, setFilterCat] = useState("All");
  const [filterLevel, setFilterLevel] = useState("All");

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      if (!session || session.user.email !== ADMIN_EMAIL) { router.replace("/login"); return; }
      setToken(session.access_token);
      fetch("/api/admin/drills", { headers: { Authorization: `Bearer ${session.access_token}` } })
        .then(r => r.json())
        .then(d => setDrills(d.drills || []))
        .finally(() => setLoading(false));
    });
  }, [router]);

  function openAdd() { setEditing(null); setForm({ ...empty }); setShowForm(true); }
  function openEdit(d: Drill) { setEditing(d); setForm({ title: d.title, description: d.description, category: d.category, level: d.level, difficulty: d.difficulty, video_url: d.video_url, duration_mins: d.duration_mins, is_published: d.is_published }); setShowForm(true); }

  async function save() {
    if (!token) return;
    setSaving(true);
    const payload = { ...form, difficulty: Number(form.difficulty), duration_mins: Number(form.duration_mins) };
    if (editing) {
      const res = await fetch(`/api/admin/drills/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      const { drill } = await res.json();
      setDrills(prev => prev.map(d => d.id === editing.id ? drill : d));
    } else {
      const res = await fetch("/api/admin/drills", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      const { drill } = await res.json();
      setDrills(prev => [...prev, drill]);
    }
    setSaving(false);
    setShowForm(false);
  }

  async function deleteDrill(id: string, title: string) {
    if (!token) return;
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(id);
    await fetch(`/api/admin/drills/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    setDrills(prev => prev.filter(d => d.id !== id));
    setDeleting(null);
  }

  const filtered = drills.filter(d =>
    (filterCat === "All" || d.category === filterCat) &&
    (filterLevel === "All" || d.level === filterLevel)
  );

  const levelColor: Record<string, string> = {
    Beginner: "bg-green-900/40 text-green-400 border-green-800",
    Intermediate: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
    Advanced: "bg-red-900/40 text-red-400 border-red-800",
  };

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
              <p className="font-[family-name:var(--font-oswald)] text-base sm:text-xl font-bold tracking-wide text-mesa-dark leading-tight">DRILLS</p>
              <p className="text-xs text-brown-500 leading-tight">Virtual Training</p>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile tab bar */}
      <div className="md:hidden border-b border-gray-200 bg-white px-4 flex items-center gap-1 overflow-x-auto">
        <Link href="/admin" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Dashboard</Link>
        <Link href="/admin/payments" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Payments</Link>
        <Link href="/admin/virtual-training" className="shrink-0 px-3 py-2.5 text-sm text-brown-400 border-b-2 border-transparent">Virtual Training</Link>
        <Link href="/admin/virtual-training/drills" className="shrink-0 px-3 py-2.5 text-sm font-semibold text-mesa-dark border-b-2 border-mesa-dark">Drills</Link>
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-2">
          <Link href="/" className="text-xs text-brown-400">← Site</Link>
        </div>
      </div>

      <div className="flex flex-1 min-w-0 w-full">
        {/* Sidebar */}
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-brown-800 bg-brown-900/30 px-3 py-6 sticky top-0 h-screen">
          <nav className="flex-1 space-y-1">
            <Link href="/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">Dashboard</Link>
            <Link href="/admin/payments" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">Payments</Link>
            <Link href="/admin/virtual-training" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">Virtual Training</Link>
            <Link href="/admin/virtual-training/drills" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-brown-800 text-white">Drills</Link>
          </nav>
          <div className="border-t border-brown-800 pt-4 mt-4 space-y-1">
            <Link href="/" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">← Back to Site</Link>
            <button onClick={() => authClient.auth.signOut().then(() => router.push("/login"))} className="w-full text-left px-3 py-2 rounded-lg text-sm text-brown-400 hover:text-white hover:bg-brown-800 transition">Sign Out</button>
          </div>
        </aside>

        <div className="flex-1 min-w-0 px-4 sm:px-6 py-8">

          {/* Top bar */}
          <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
            <div>
              <h1 className="font-[family-name:var(--font-oswald)] text-2xl font-bold tracking-wide">Drill Library</h1>
              <p className="text-brown-400 text-sm mt-0.5">{drills.length} drills total</p>
            </div>
            <button onClick={openAdd} className="rounded-lg bg-mesa-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-yellow-600 transition">
              + Add Drill
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2 mb-6">
            {["All", ...CATEGORIES].map(c => (
              <button key={c} onClick={() => setFilterCat(c)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${filterCat === c ? "bg-mesa-accent border-mesa-accent text-white" : "border-brown-700 text-brown-400 hover:border-brown-500"}`}>{c}</button>
            ))}
            <span className="w-px bg-brown-700 mx-1" />
            {["All", ...LEVELS].map(l => (
              <button key={l} onClick={() => setFilterLevel(l)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${filterLevel === l ? "bg-brown-600 border-brown-600 text-white" : "border-brown-700 text-brown-400 hover:border-brown-500"}`}>{l}</button>
            ))}
          </div>

          {/* Drills list */}
          {loading ? (
            <p className="text-brown-500 text-sm">Loading...</p>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-brown-700 bg-brown-900/20 px-8 py-12 text-center">
              <p className="text-brown-500 text-sm">No drills yet. Hit "Add Drill" to upload your first one.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(d => (
                <div key={d.id} className="rounded-xl border border-brown-700 bg-brown-900/40 px-4 py-4 flex items-center gap-4">
                  <YoutubeThumb url={d.video_url} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-white text-sm">{d.title}</p>
                      {!d.is_published && <span className="text-xs rounded-full bg-brown-800 px-2 py-0.5 text-brown-500">Draft</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-brown-400">{d.category}</span>
                      <span className="text-brown-700">·</span>
                      <span className={`text-xs rounded-full border px-2 py-0.5 ${levelColor[d.level]}`}>{d.level}</span>
                      <span className="text-brown-700">·</span>
                      <span className="text-xs text-mesa-accent font-semibold">Difficulty {d.difficulty}/10</span>
                      <span className="text-brown-700">·</span>
                      <span className="text-xs text-brown-500">~{d.duration_mins} min</span>
                    </div>
                    {d.description && <p className="text-xs text-brown-500 mt-1 line-clamp-1">{d.description}</p>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button onClick={() => openEdit(d)} className="text-xs text-brown-400 hover:text-white transition">Edit</button>
                    <button onClick={() => deleteDrill(d.id, d.title)} disabled={deleting === d.id} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 transition">
                      {deleting === d.id ? "…" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-brown-950 border border-brown-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h2 className="font-[family-name:var(--font-oswald)] text-xl font-bold">{editing ? "Edit Drill" : "Add Drill"}</h2>

            <div>
              <label className="text-xs text-brown-400 uppercase tracking-wide">Title</label>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Two Ball Dribble" className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-brown-400 uppercase tracking-wide">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent">
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-brown-400 uppercase tracking-wide">Level</label>
                <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))} className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent">
                  {LEVELS.map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-brown-400 uppercase tracking-wide">Difficulty (1–10)</label>
                <input type="number" min={1} max={10} value={form.difficulty} onChange={e => setForm(f => ({ ...f, difficulty: Number(e.target.value) }))} className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent" />
              </div>
              <div>
                <label className="text-xs text-brown-400 uppercase tracking-wide">Duration (mins)</label>
                <input type="number" min={1} value={form.duration_mins} onChange={e => setForm(f => ({ ...f, duration_mins: Number(e.target.value) }))} className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent" />
              </div>
            </div>

            <div>
              <label className="text-xs text-brown-400 uppercase tracking-wide">YouTube URL</label>
              <input value={form.video_url} onChange={e => setForm(f => ({ ...f, video_url: e.target.value }))} placeholder="https://youtube.com/watch?v=..." className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent" />
              {form.video_url && youtubeId(form.video_url) && (
                <img src={`https://img.youtube.com/vi/${youtubeId(form.video_url)}/mqdefault.jpg`} className="mt-2 rounded-lg w-full max-w-xs" alt="preview" />
              )}
            </div>

            <div>
              <label className="text-xs text-brown-400 uppercase tracking-wide">Description (optional)</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3} placeholder="What does this drill work on? Any coaching cues?" className="mt-1 w-full rounded-lg bg-brown-900 border border-brown-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-mesa-accent resize-none" />
            </div>

            <div className="flex items-center gap-2">
              <input type="checkbox" id="published" checked={form.is_published} onChange={e => setForm(f => ({ ...f, is_published: e.target.checked }))} className="accent-mesa-accent" />
              <label htmlFor="published" className="text-sm text-brown-300">Published (visible to subscribers)</label>
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={save} disabled={saving || !form.title || !form.video_url} className="flex-1 rounded-lg bg-mesa-accent py-3 font-semibold text-white text-sm hover:bg-yellow-600 transition disabled:opacity-50">
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Drill"}
              </button>
              <button onClick={() => setShowForm(false)} className="flex-1 rounded-lg border border-brown-700 py-3 font-semibold text-brown-400 text-sm hover:text-white hover:border-brown-500 transition">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
