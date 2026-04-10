import { notFound } from "next/navigation";
import Link from "next/link";

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
}

function ytThumbnail(url: string) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : null;
}

function ytEmbed(url: string) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? `https://www.youtube.com/embed/${match[1]}?rel=0&modestbranding=1` : null;
}

const CATEGORY_COLORS: Record<string, string> = {
  "Ball Handling": "bg-blue-100 text-blue-800",
  "Finishing": "bg-green-100 text-green-800",
  "Mid Range": "bg-purple-100 text-purple-800",
  "Shooting": "bg-orange-100 text-orange-800",
};

export default async function SharedWorkoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://mesabasketballtraining.com";
  const res = await fetch(`${baseUrl}/api/w/${token}`, { cache: "no-store" });

  if (!res.ok) {
    if (res.status === 410) {
      return (
        <div className="min-h-screen bg-mesa-light flex flex-col items-center justify-center px-6 text-center">
          <div className="text-5xl mb-5">⏰</div>
          <h1 className="text-2xl font-bold text-mesa-dark mb-2">Link Expired</h1>
          <p className="text-mesa-brown/70 mb-6">This workout link has expired (links are valid for 48 hours).</p>
          <Link href="/" className="text-mesa-accent hover:underline font-medium">← Mesa Basketball Training</Link>
        </div>
      );
    }
    notFound();
  }

  const { session, drills }: { session: Session; drills: Drill[] } = await res.json();
  const totalMins = drills.reduce((sum, d) => sum + (d.duration_mins || 0), 0);

  return (
    <div className="min-h-screen bg-mesa-light">
      {/* Header */}
      <header className="bg-mesa-dark text-white px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-8 h-8 bg-mesa-accent rounded-full flex items-center justify-center text-sm font-bold">M</div>
          <span className="font-bold text-lg">Mesa Basketball Training</span>
        </Link>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-10">
        {/* Title */}
        <div className="mb-6">
          <p className="text-mesa-brown/50 text-sm uppercase tracking-wide font-medium mb-1">Shared Workout</p>
          <h1 className="text-3xl font-bold text-mesa-dark">Week {session.week} — {session.level}</h1>
          <p className="text-mesa-brown/60 mt-1">{drills.length} drills · ~{totalMins} min</p>
        </div>

        {/* Drills */}
        <div className="space-y-6">
          {drills.map((drill, i) => {
            const embed = ytEmbed(drill.video_url || "");
            const thumb = ytThumbnail(drill.video_url || "");

            return (
              <div key={drill.id} className="bg-white rounded-2xl overflow-hidden shadow-sm">
                {/* Video */}
                {embed ? (
                  <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                    <iframe
                      src={embed}
                      className="absolute inset-0 w-full h-full"
                      allow="encrypted-media"
                      allowFullScreen
                    />
                  </div>
                ) : thumb ? (
                  <img src={thumb} alt={drill.title} className="w-full aspect-video object-cover" />
                ) : (
                  <div className="w-full aspect-video bg-brown-100 flex items-center justify-center">
                    <span className="text-brown-400 text-sm">No video</span>
                  </div>
                )}

                {/* Info */}
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-mesa-dark text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {i + 1}
                      </span>
                      <h2 className="font-bold text-mesa-dark text-lg">{drill.title}</h2>
                    </div>
                    <span className="text-mesa-brown/50 text-sm flex-shrink-0">{drill.duration_mins} min</span>
                  </div>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${CATEGORY_COLORS[drill.category] || "bg-gray-100 text-gray-700"}`}>
                      {drill.category}
                    </span>
                    <span className="text-xs text-mesa-brown/50">Difficulty {drill.difficulty}/10</span>
                  </div>
                  {drill.description && (
                    <p className="text-mesa-brown/70 text-sm leading-relaxed">{drill.description}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer CTA */}
        <div className="mt-10 bg-mesa-dark rounded-2xl p-6 text-center">
          <h3 className="text-white font-bold text-lg mb-1">Get your own personalized program</h3>
          <p className="text-white/60 text-sm mb-4">Workouts tailored to your level that get harder each week.</p>
          <Link
            href="/virtual-training"
            className="inline-block bg-mesa-accent text-white px-6 py-3 rounded-xl font-bold text-sm hover:bg-mesa-accent/90 transition-colors"
          >
            Learn More
          </Link>
        </div>
      </main>
    </div>
  );
}
