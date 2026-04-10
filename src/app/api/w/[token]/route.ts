import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = getSupabase();

  const { data: session } = await supabase
    .from("workout_sessions")
    .select("*")
    .eq("share_token", token)
    .single();

  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (new Date(session.share_expires_at) < new Date()) return NextResponse.json({ error: "Expired" }, { status: 410 });

  const { data: drills } = await supabase.from("drills").select("*").in("id", session.drill_ids);
  const ordered = session.drill_ids.map((id: string) => drills?.find((d: any) => d.id === id)).filter(Boolean);

  return NextResponse.json({ session, drills: ordered });
}
