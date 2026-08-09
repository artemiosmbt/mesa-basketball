import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizedAthleteName, type Athlete } from "@/lib/athletes";
import { mergeAthleteAfterBooking, defaultGroupsForGradeGender } from "@/lib/group-matching";

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}

// Merges one or more athletes into the caller's saved roster WITHOUT
// touching any saved athlete not present in this request — fixes the old
// /api/profile POST's whole-array overwrite, which could silently wipe a
// sibling's saved data when a booking only included a subset of a parent's
// kids. When bookedGroupLabels resolves to canonical group(s), each
// athlete's persisted `groups` auto-expands to include them (never
// auto-shrinks).
// body: { parentName?: string; phone?: string; bookedGroupLabels?: string[]; athletes: Partial<Athlete>[] }
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const supabase = getSupabaseAdmin();

  const { data: existing } = await supabase.from("profiles").select("kids").eq("id", user.id).maybeSingle();
  const existingKids: Athlete[] = Array.isArray(existing?.kids) ? existing.kids : [];
  const merged = [...existingKids];

  // Tracks which `merged` indices an EARLIER entry in this same request
  // already resolved to — without this, two same-named siblings (twins, or
  // any kids sharing a name) submitted in one request collapse into a
  // single saved athlete: the second one's name-only fallback match finds
  // the one the first entry just created/updated and silently overwrites
  // its DOB/grade/gender instead of creating its own entry. An explicit
  // `incoming.id` still always matches regardless (an id is an unambiguous,
  // deliberate reference, not a name guess), so re-submitting the SAME real
  // athlete twice in one request (by id) still correctly merges into one.
  const claimedThisRequest = new Set<number>();
  for (const incoming of (body.athletes || []) as Partial<Athlete>[]) {
    if (!incoming.name?.trim()) continue;
    let idx = incoming.id ? merged.findIndex((k) => k.id === incoming.id) : -1;
    if (idx === -1) {
      idx = merged.findIndex((k, i) => !claimedThisRequest.has(i) && normalizedAthleteName(k.name) === normalizedAthleteName(incoming.name!));
    }
    if (idx >= 0) {
      merged[idx] = mergeAthleteAfterBooking(merged[idx], incoming, body.bookedGroupLabels);
      claimedThisRequest.add(idx);
    } else {
      const groups = defaultGroupsForGradeGender(incoming.grade || "", incoming.gender);
      const fresh: Athlete = {
        id: crypto.randomUUID(),
        name: incoming.name!.trim(),
        dob: incoming.dob || "",
        grade: incoming.grade || "",
        gender: incoming.gender || "",
        groups,
      };
      merged.push(mergeAthleteAfterBooking(fresh, incoming, body.bookedGroupLabels));
      claimedThisRequest.add(merged.length - 1);
    }
  }

  const upsertData: Record<string, unknown> = {
    id: user.id,
    email: user.email,
    kids: merged,
    updated_at: new Date().toISOString(),
  };
  if (body.parentName) upsertData.parent_name = body.parentName;
  if (body.phone) upsertData.phone = body.phone;

  const { error } = await supabase.from("profiles").upsert(upsertData);
  if (error) {
    console.error("Athlete merge upsert failed:", error);
    return NextResponse.json({ error: "Failed to save." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, kids: merged });
}

// DELETE ?id=<athleteId> — removes exactly one saved athlete, leaves the
// rest of the roster untouched. Used by the settings page's per-athlete
// remove control.
export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data: existing } = await supabase.from("profiles").select("kids").eq("id", user.id).maybeSingle();
  const kids: Athlete[] = (Array.isArray(existing?.kids) ? existing.kids : []).filter((k: Athlete) => k.id !== id);

  const { error } = await supabase.from("profiles").update({ kids, updated_at: new Date().toISOString() }).eq("id", user.id);
  if (error) {
    console.error("Athlete delete failed:", error);
    return NextResponse.json({ error: "Failed to save." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, kids });
}
