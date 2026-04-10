"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";

interface Drill {
  id: string;
  title: string;
  category: string;
  level: string;
  difficulty: number;
  duration_mins: number;
  video_url: string;
  description: string;
}

interface Session {
  id: string;
  week: number;
  level: string;
  drill_ids: string[];
  completed_at: string | null;
  share_token: string | null;
  share_expires_at: string | null;
}

interface Profile {
  current_week: number;
  level: string;
}

function ytThumbnail(url: string) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : null;
}

const CATEGORY_COLORS: Record<string, string> = {
  "Ball Handling": "bg-blue-100 text-blue-800",
  "Finishing": "bg-green-100 text-green-800",
  "Mid Range": "bg-purple-100 text-purple-800",
  "Shooting": "bg-orange-100 text-orange-800",
};

export default function TrainingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session: authSession } }) => {
      if (!authSession) {
        router.replace("/login");
        return;
      }
      setToken(authSession.access_token);
      fetch("/api/training/workout", {
        headers: { Authorization: `Bearer ${authSession.access_token}` },
      })
        .then((r) => r.json())
        .then((d) => {
          setSession(d.session);
          setDrills(d.drills || []);
          setProfile(d.profile);
          if (d.session?.share_token && d.session?.share_expires_at) {
            const expires = new Date(d.session.share_expires_at);
            if (expires > new Date()) {
              setShareUrl(`${window.location.origin}/w/${d.session.share_token}`);
            }
          }
          setLoading(false);
        });
    });
  }, [router]);

  async function handleShare() {
    if (!session || !token) return;
    setSharing(true);
    const res = await fetch("/api/training/share", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: session.id }),
    });
    const data = await res.json();
    if (data.token) {
      const url = `${window.location.origin}/w/${data.token}`;
      setShareUrl(url);
    }
    setSharing(false);
  }

  async function handleCopy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-mesa-light flex items-center justify-center">
        <div className="text-mesa-brown text-lg">Loading your workout...</div>
      </div>
    );
  }

  const totalMins = drills.reduce((sum, d) => sum + (d.duration_mins || 0), 0);
  const isCompleted = !!session?.completed_at;

  return (
    <div className="min-h-screen bg-mesa-light">
      {/* Header */}
      <header className="bg-mesa-dark text-white px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-8 h-8 bg-mesa-accent rounded-full flex items-center justify-center text-sm font-bold">M</div>
          <span className="font-bold text-lg">Mesa Training</span>
        </Link>
        <button
          onClick={() => authClient.auth.signOut().then(() => router.push("/"))}
          className="text-sm text-white/60 hover:text-white transition-colors"
        >
          Sign out
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        {/* Week Progress */}
        {profile && (
          <div className="bg-white rounded-2xl p-6 mb-6 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm text-mesa-brown/60 uppercase tracking-wide font-medium">Your Program</p>
                <h2 className="text-xl font-bold text-mesa-dark mt-0.5">
                  Week {profile.current_week} of 8 — {profile.level}
                </h2>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-mesa-accent">{profile.current_week}</p>
                <p className="text-xs text-mesa-brown/60">/ 8 weeks</p>
              </div>
            </div>
            <div className="w-full bg-brown-100 rounded-full h-2">
              <div
                className="bg-mesa-accent h-2 rounded-full transition-all"
                style={{ width: `${((profile.current_week - 1) / 8) * 100}%` }}
              />
            </div>
            <p className="text-xs text-mesa-brown/50 mt-2">
              {profile.current_week < 8
                ? `${8 - profile.current_week} week${8 - profile.current_week !== 1 ? "s" : ""} remaining`
                : "Program complete!"}
            </p>
          </div>
        )}

        {/* Today's Workout */}
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-mesa-dark">
            {isCompleted ? "Today's Workout ✓" : "Today's Workout"}
          </h1>
          {session && !isCompleted && (
            <Link
              href="/training/play"
              className="bg-mesa-accent text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-mesa-accent/90 transition-colors"
            >
              Start Workout
            </Link>
          )}
          {isCompleted && (
            <span className="bg-green-100 text-green-700 px-4 py-2 rounded-xl text-sm font-semibold">
              Completed
            </span>
          )}
        </div>

        {!session && (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <p className="text-mesa-brown/70 text-lg">No drills available yet.</p>
            <p className="text-mesa-brown/50 text-sm mt-1">Check back once drills are added to the library.</p>
          </div>
        )}

        {session && drills.length > 0 && (
          <>
            <div className="flex items-center gap-4 mb-4 text-sm text-mesa-brown/60">
              <span>{drills.length} drills</span>
              <span>·</span>
              <span>~{totalMins} min</span>
            </div>

            <div className="space-y-3 mb-6">
              {drills.map((drill, i) => {
                const thumb = ytThumbnail(drill.video_url || "");
                return (
                  <div key={drill.id} className="bg-white rounded-2xl overflow-hidden shadow-sm flex gap-4 p-4 items-start">
                    {thumb ? (
                      <div className="w-20 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-brown-100">
                        <img src={thumb} alt={drill.title} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-20 h-14 rounded-lg flex-shrink-0 bg-brown-100 flex items-center justify-center text-brown-400 text-xs">
                        No video
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-mesa-dark text-sm leading-snug">{drill.title}</h3>
                        <span className="text-xs text-mesa-brown/50 flex-shrink-0">{drill.duration_mins} min</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[drill.category] || "bg-gray-100 text-gray-700"}`}>
                          {drill.category}
                        </span>
                        <span className="text-xs text-mesa-brown/50">Difficulty {drill.difficulty}/10</span>
                      </div>
                    </div>
                    <span className="w-6 h-6 rounded-full bg-brown-100 text-brown-500 text-xs font-bold flex items-center justify-center flex-shrink-0">
                      {i + 1}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3">
              {!isCompleted && (
                <Link
                  href="/training/play"
                  className="flex-1 bg-mesa-accent text-white py-3.5 rounded-xl font-bold text-center text-base hover:bg-mesa-accent/90 transition-colors"
                >
                  Start Workout
                </Link>
              )}
              <div className="flex-1">
                {!shareUrl ? (
                  <button
                    onClick={handleShare}
                    disabled={sharing}
                    className="w-full border-2 border-mesa-dark text-mesa-dark py-3.5 rounded-xl font-bold text-base hover:bg-mesa-dark hover:text-white transition-colors disabled:opacity-50"
                  >
                    {sharing ? "Generating link..." : "Share Workout"}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={shareUrl}
                      className="flex-1 border border-brown-200 rounded-xl px-3 py-2 text-sm text-mesa-brown bg-white"
                    />
                    <button
                      onClick={handleCopy}
                      className="bg-mesa-dark text-white px-4 py-2 rounded-xl text-sm font-semibold"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
