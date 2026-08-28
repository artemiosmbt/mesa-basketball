import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { normalizedAthleteName, type Athlete } from "@/lib/athletes";

// Merges two saved-athlete entries that are actually the same kid recorded
// under two slightly different name spellings across separate historical
// registrations (e.g. "Remy" vs "Remy Trudeau") — a real gap the backfill
// can't safely close on its own, since blindly fuzzy-matching names risks
// merging two genuinely different siblings instead. This is always an
// explicit, admin-initiated action on two specific athlete IDs within the
// SAME client — never automatic.
//
// This is NOT for an athlete who legitimately belongs to multiple canonical
// groups at once (e.g. a kid who plays both Middle School and High School)
// — that's already just ONE athlete entry with two entries in its `groups`
// array, nothing to merge.
//
// keepId's name/dob/grade/gender/hidden are kept as-is; mergeId's `groups`
// are unioned into keepId's, then mergeId is deleted.
// body: { email: string; keepId: string; mergeId: string }
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { email, keepId, mergeId } = body as { email?: string; keepId?: string; mergeId?: string };
  if (!email || !keepId || !mergeId || keepId === mergeId) {
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
  const keepIdx = kids.findIndex((k) => k.id === keepId);
  const mergeIdx = kids.findIndex((k) => k.id === mergeId);
  if (keepIdx === -1 || mergeIdx === -1) return NextResponse.json({ error: "Athlete not found." }, { status: 404 });

  const mergedGroups = Array.from(new Set([...(kids[keepIdx].groups || []), ...(kids[mergeIdx].groups || [])]));
  // Record mergeId's name (and any aliases IT already carried, in case it
  // was itself the product of an earlier merge) as an alias on the survivor
  // — this is what keeps the merge permanent. Without it, the next booking
  // typed under the merged-away name doesn't match keepId by name at all,
  // so syncAthleteGroupsFromBooking creates a brand-new athlete with that
  // name: the exact duplicate this merge just removed, back again.
  const mergedAliases = Array.from(new Set([
    ...(kids[keepIdx].aliases || []),
    kids[mergeIdx].name,
    ...(kids[mergeIdx].aliases || []),
  ].filter((a) => normalizedAthleteName(a) !== normalizedAthleteName(kids[keepIdx].name))));
  kids[keepIdx] = { ...kids[keepIdx], groups: mergedGroups, aliases: mergedAliases };
  const finalKids = kids.filter((_, i) => i !== mergeIdx);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ kids: finalKids, updated_at: new Date().toISOString() })
    .eq("id", profile.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ ok: true, kids: finalKids });
}
