import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import type { Athlete } from "@/lib/athletes";

// Admin-only cosmetic hide/unhide for the Groups tab — purely a dashboard
// display preference. Never touches `groups` (still drives reminder
// emails), the athlete's saved info, or anything the client sees on their
// own account.
// body: { email: string; athleteId: string; hidden: boolean }
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { email, athleteId, hidden } = body as { email?: string; athleteId?: string; hidden?: boolean };
  if (!email || !athleteId || typeof hidden !== "boolean") {
    return NextResponse.json({ error: "Missing or invalid fields." }, { status: 400 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: profile, error: fetchError } = await supabase
    .from("profiles")
    .select("id, kids")
    .ilike("email", email.trim())
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: "Client profile not found." }, { status: 404 });

  const kids: Athlete[] = Array.isArray(profile.kids) ? profile.kids : [];
  const idx = kids.findIndex((k) => k.id === athleteId);
  if (idx === -1) return NextResponse.json({ error: "Athlete not found." }, { status: 404 });
  kids[idx] = { ...kids[idx], hidden };

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ kids, updated_at: new Date().toISOString() })
    .eq("id", profile.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ ok: true, kids });
}
