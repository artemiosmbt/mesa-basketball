import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import type { Athlete, CanonicalGroupId } from "@/lib/athletes";

// Manual group assignment for the admin Groups tab — lets the owner
// add/move/remove a specific athlete's persisted group membership directly,
// independent of whatever auto-add-on-booking has (or hasn't) done. This is
// the only way to prune a stale assignment (e.g. a dual-assigned kid who's
// clearly aged fully out of Junior) since auto-add only ever adds, never
// removes.
// body: { email: string; athleteId: string; groupId: CanonicalGroupId; action: "add" | "remove" }
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { email, athleteId, groupId, action } = body as { email?: string; athleteId?: string; groupId?: CanonicalGroupId; action?: "add" | "remove" };
  if (!email || !athleteId || !groupId || (action !== "add" && action !== "remove")) {
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

  const groups = new Set(kids[idx].groups || []);
  if (action === "add") groups.add(groupId);
  else groups.delete(groupId);
  kids[idx] = { ...kids[idx], groups: Array.from(groups) };

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ kids, updated_at: new Date().toISOString() })
    .eq("id", profile.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ ok: true, kids });
}
