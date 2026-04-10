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

export async function POST(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user } } = await authClient.auth.getUser(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { drill_id, feedback, session_id } = await req.json();
  const supabase = getSupabase();

  await supabase.from("drill_feedback").insert({ user_id: user.id, drill_id, feedback });

  // If all drills in session are done, mark session completed
  if (session_id) {
    const { data: session } = await supabase.from("workout_sessions").select("drill_ids").eq("id", session_id).single();
    if (session) {
      const { count } = await supabase
        .from("drill_feedback")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .in("drill_id", session.drill_ids)
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (count && count >= session.drill_ids.length) {
        await supabase.from("workout_sessions").update({ completed_at: new Date().toISOString() }).eq("id", session_id);
        // Advance week if on week < 8
        const { data: profile } = await supabase.from("user_training_profiles").select("current_week").eq("user_id", user.id).single();
        if (profile && profile.current_week < 8) {
          await supabase.from("user_training_profiles")
            .update({ current_week: profile.current_week + 1, updated_at: new Date().toISOString() })
            .eq("user_id", user.id);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
