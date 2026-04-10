import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authClient } from "@/lib/auth";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await authClient.auth.getUser(token);
  return user;
}

const CATEGORIES = ["Ball Handling", "Finishing", "Mid Range", "Shooting"];

// Difficulty range per week (week 1-8)
function difficultyRange(week: number): { min: number; max: number } {
  if (week <= 2) return { min: 1, max: 3 };
  if (week <= 4) return { min: 3, max: 5 };
  if (week <= 6) return { min: 5, max: 7 };
  return { min: 7, max: 10 };
}

// Weighted random pick — drills with "need_more_work" preferred, "too_easy" deprioritized
function weightedPick(drills: any[], feedbackMap: Record<string, string>) {
  const weights = drills.map(d => {
    const fb = feedbackMap[d.id];
    if (!fb) return 1.5;           // unseen — slightly preferred
    if (fb === "need_more_work") return 3;
    if (fb === "too_easy") return 0.2;
    return 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < drills.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return drills[i];
  }
  return drills[drills.length - 1];
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabase();

  // Get or create user profile
  let { data: profile } = await supabase.from("user_training_profiles").select("*").eq("user_id", user.id).single();
  if (!profile) {
    const { data: created } = await supabase.from("user_training_profiles").insert({ user_id: user.id }).select().single();
    profile = created;
  }

  // Check if a workout already exists for today
  const today = new Date().toISOString().split("T")[0];
  const { data: existing } = await supabase
    .from("workout_sessions")
    .select("*, drills:drill_ids")
    .eq("user_id", user.id)
    .gte("created_at", today)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    // Fetch the actual drill objects
    const { data: drills } = await supabase.from("drills").select("*").in("id", existing.drill_ids);
    const ordered = existing.drill_ids.map((id: string) => drills?.find((d: any) => d.id === id)).filter(Boolean);
    return NextResponse.json({ session: existing, drills: ordered, profile });
  }

  // Generate a new workout
  const { min, max } = difficultyRange(profile.current_week);

  // Get all published drills for this level
  const { data: allDrills } = await supabase
    .from("drills")
    .select("*")
    .eq("level", profile.level)
    .eq("is_published", true);

  if (!allDrills || allDrills.length === 0) {
    return NextResponse.json({ session: null, drills: [], profile });
  }

  // Get user's most recent feedback per drill
  const { data: feedbackRows } = await supabase
    .from("drill_feedback")
    .select("drill_id, feedback")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const feedbackMap: Record<string, string> = {};
  for (const row of feedbackRows || []) {
    if (!feedbackMap[row.drill_id]) feedbackMap[row.drill_id] = row.feedback;
  }

  // Get recently used drill IDs (last 3 sessions) to avoid repeats
  const { data: recentSessions } = await supabase
    .from("workout_sessions")
    .select("drill_ids")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(3);

  const recentDrillIds = new Set((recentSessions || []).flatMap((s: any) => s.drill_ids));

  const selected: any[] = [];

  for (const category of CATEGORIES) {
    // Try drills in difficulty range first, excluding recently used
    let pool = allDrills.filter(d =>
      d.category === category &&
      d.difficulty >= min && d.difficulty <= max &&
      !recentDrillIds.has(d.id)
    );

    // If pool is empty, try same range including recent
    if (pool.length === 0) {
      pool = allDrills.filter(d => d.category === category && d.difficulty >= min && d.difficulty <= max);
    }

    // If still empty, use any drill in category
    if (pool.length === 0) {
      pool = allDrills.filter(d => d.category === category);
    }

    if (pool.length > 0) {
      selected.push(weightedPick(pool, feedbackMap));
    }
  }

  if (selected.length === 0) {
    return NextResponse.json({ session: null, drills: [], profile });
  }

  // Save the session
  const { data: session } = await supabase
    .from("workout_sessions")
    .insert({
      user_id: user.id,
      week: profile.current_week,
      level: profile.level,
      drill_ids: selected.map(d => d.id),
    })
    .select()
    .single();

  return NextResponse.json({ session, drills: selected, profile });
}
