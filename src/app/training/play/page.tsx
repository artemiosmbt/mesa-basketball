"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  drill_ids: string[];
  completed_at: string | null;
}

function ytEmbed(url: string) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1&rel=0&modestbranding=1` : null;
}

const FEEDBACK_OPTIONS = [
  { value: "too_easy", label: "Too Easy", emoji: "😴", color: "border-blue-300 text-blue-700 hover:bg-blue-50" },
  { value: "got_it", label: "Got It", emoji: "✅", color: "border-green-300 text-green-700 hover:bg-green-50" },
  { value: "need_more_work", label: "Need More Work", emoji: "💪", color: "border-orange-300 text-orange-700 hover:bg-orange-50" },
];

export default function PlayPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

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
          if (!d.session || d.drills?.length === 0) {
            router.replace("/training");
            return;
          }
          setSession(d.session);
          setDrills(d.drills || []);
          setLoading(false);
        });
    });
  }, [router]);

  const submitFeedback = useCallback(async (feedbackValue: string) => {
    if (!session || !token || submitting) return;
    const drill = drills[currentIndex];
    if (!drill) return;

    setSubmitting(true);
    await fetch("/api/training/feedback", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        drill_id: drill.id,
        feedback: feedbackValue,
        session_id: session.id,
      }),
    });

    if (currentIndex < drills.length - 1) {
      setCurrentIndex((i) => i + 1);
      setSubmitting(false);
    } else {
      setDone(true);
      setSubmitting(false);
    }
  }, [session, token, submitting, drills, currentIndex]);

  if (loading) {
    return (
      <div className="min-h-screen bg-mesa-dark flex items-center justify-center">
        <div className="text-white/60 text-lg">Loading workout...</div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-mesa-dark flex flex-col items-center justify-center text-center px-6">
        <div className="text-6xl mb-6">🏀</div>
        <h1 className="text-3xl font-bold text-white mb-3">Workout Done!</h1>
        <p className="text-white/60 text-lg mb-8">Great work. Keep grinding.</p>
        <button
          onClick={() => router.push("/training")}
          className="bg-mesa-accent text-white px-8 py-3.5 rounded-xl font-bold text-base hover:bg-mesa-accent/90 transition-colors"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const drill = drills[currentIndex];
  if (!drill) return null;

  const embedUrl = ytEmbed(drill.video_url || "");

  return (
    <div className="min-h-screen bg-mesa-dark flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => router.push("/training")}
          className="text-white/60 hover:text-white transition-colors text-sm"
        >
          ← Exit
        </button>
        <div className="flex items-center gap-2">
          {drills.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i < currentIndex
                  ? "w-6 bg-mesa-accent"
                  : i === currentIndex
                  ? "w-8 bg-white"
                  : "w-6 bg-white/20"
              }`}
            />
          ))}
        </div>
        <span className="text-white/50 text-sm">
          {currentIndex + 1} / {drills.length}
        </span>
      </div>

      {/* Video */}
      <div className="flex-1 flex flex-col">
        {embedUrl ? (
          <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
            <iframe
              src={embedUrl}
              className="absolute inset-0 w-full h-full"
              allow="autoplay; encrypted-media"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="w-full aspect-video bg-black/50 flex items-center justify-center">
            <p className="text-white/40">No video available</p>
          </div>
        )}

        {/* Drill info */}
        <div className="px-5 py-5 flex-1 flex flex-col">
          <div className="mb-1">
            <span className="text-mesa-accent text-xs font-semibold uppercase tracking-wider">{drill.category}</span>
          </div>
          <h2 className="text-white text-xl font-bold mb-2">{drill.title}</h2>
          <div className="flex items-center gap-3 mb-4 text-white/50 text-sm">
            <span>{drill.duration_mins} min</span>
            <span>·</span>
            <span>Difficulty {drill.difficulty}/10</span>
          </div>
          {drill.description && (
            <p className="text-white/60 text-sm leading-relaxed mb-6">{drill.description}</p>
          )}

          {/* Feedback */}
          <div className="mt-auto">
            <p className="text-white/50 text-xs uppercase tracking-wider font-medium mb-3 text-center">
              How did this drill go?
            </p>
            <div className="grid grid-cols-3 gap-2">
              {FEEDBACK_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => submitFeedback(opt.value)}
                  disabled={submitting}
                  className={`border-2 rounded-xl py-3 px-2 flex flex-col items-center gap-1 bg-white transition-colors disabled:opacity-40 ${opt.color}`}
                >
                  <span className="text-xl">{opt.emoji}</span>
                  <span className="text-xs font-semibold leading-tight text-center">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
