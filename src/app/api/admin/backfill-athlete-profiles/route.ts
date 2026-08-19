import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { normalizedAthleteName, type Athlete } from "@/lib/athletes";
import { canonicalGroupForLabel } from "@/lib/group-matching";

// --- Ported verbatim from booking/[token]/route.ts:667-691 ---
function parseKidsList(kidsStr: string): string[] {
  if (!kidsStr.trim()) return [];
  if (kidsStr.includes("(")) {
    return kidsStr.split("), ").map((p, i, arr) =>
      i < arr.length - 1 ? p + ")" : p
    ).filter((s) => s.trim());
  }
  return kidsStr.split(",").map((s) => s.trim()).filter(Boolean);
}
function playerLabel(playerStr: string): string {
  const idx = playerStr.indexOf(" (");
  return idx > -1 ? playerStr.substring(0, idx).trim() : playerStr.trim();
}

// Extends the verbatim parseKidsList/playerLabel split with regex pulls for
// DOB/Grade/Gender out of the parenthetical, matching the exact format
// schedule/page.tsx's kidsStr builder produces: "Name (DOB: MM/DD/YYYY,
// Grade: X, Gender: Male)" — Gender is omitted for private/camp bookings
// that don't collect it.
function parseRegistrationKidsString(kidsStr: string): { name: string; dob: string; grade: string; gender?: string }[] {
  return parseKidsList(kidsStr)
    .map((p) => {
      const name = playerLabel(p);
      const dobMatch = p.match(/DOB:\s*([^,)]+)/i);
      const gradeMatch = p.match(/Grade:\s*([^,)]+)/i);
      const genderMatch = p.match(/Gender:\s*(Male|Female)/i);
      return {
        name,
        dob: dobMatch ? dobMatch[1].trim() : "",
        grade: gradeMatch ? gradeMatch[1].trim() : "",
        gender: genderMatch ? (genderMatch[1].trim().toLowerCase() as "male" | "female") : undefined,
      };
    })
    .filter((k) => k.name);
}

// One-time (safe to re-run) historical backfill: reconstructs every
// account-holding client's saved athlete roster from their past
// registrations, since none of this was tracked before. Each registration's
// resolved canonical group is attributed ONLY to the specific kid(s) named
// in THAT registration — not to every kid the client has ever had — so a
// parent with two kids in two different programs doesn't get both programs
// misattributed to both kids. Never overwrites an athlete the parent
// already has saved (e.g. from a booking made after this ships).
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: regs, error: regsError } = await supabase
    .from("registrations")
    .select("email, kids, booked_group")
    .neq("status", "payment_abandoned")
    .not("email", "is", null);
  if (regsError) return NextResponse.json({ error: regsError.message }, { status: 500 });

  const athletesByEmail = new Map<string, Map<string, { name: string; dob: string; grade: string; gender?: string; groups: Set<string> }>>();
  for (const r of regs || []) {
    const email = (r.email || "").toLowerCase().trim();
    if (!email || !r.kids) continue;
    if (!athletesByEmail.has(email)) athletesByEmail.set(email, new Map());
    const bucket = athletesByEmail.get(email)!;
    const cgs = r.booked_group ? canonicalGroupForLabel(r.booked_group) : [];
    for (const kid of parseRegistrationKidsString(r.kids)) {
      // Keyed on name+DOB, not name alone — a name-only key collapses two
      // same-named siblings (twins, or any kids sharing a name) across a
      // parent's registration history into one bucket, silently dropping
      // one of their DOB/grade/gender and misattributing both kids' groups
      // to a single saved athlete. Still collapses genuinely identical
      // twins sharing the exact same stored DOB string — no per-kid
      // identifier exists in the historical "Name (DOB: ..., Grade: ...)"
      // registration format to disambiguate that case; a real (rare) data
      // limitation, not something this key change can solve.
      const key = `${normalizedAthleteName(kid.name)}|${kid.dob}`;
      if (!bucket.has(key)) bucket.set(key, { ...kid, groups: new Set() });
      for (const cg of cgs) bucket.get(key)!.groups.add(cg);
    }
  }

  // Only accounts with a real Supabase Auth row can receive a profiles row
  // (profiles.id has a hard FK to auth.users.id) — guest-only clients are
  // correctly skipped.
  const userIdByEmail = new Map<string, string>();
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const u of data.users) if (u.email) userIdByEmail.set(u.email.toLowerCase().trim(), u.id);
    if (data.users.length < 1000) break;
    page++;
  }

  let profilesCreated = 0;
  let profilesUpdated = 0;
  let skippedNoAccount = 0;
  for (const [email, athleteMap] of athletesByEmail) {
    const userId = userIdByEmail.get(email);
    if (!userId) { skippedNoAccount++; continue; }

    const { data: existing } = await supabase.from("profiles").select("kids").eq("id", userId).maybeSingle();
    const existingKids: Athlete[] = Array.isArray(existing?.kids) ? existing.kids : [];
    const merged = [...existingKids];
    let changed = false;
    for (const parsed of athleteMap.values()) {
      // Same name+DOB matching as the bucket key above — prevents a
      // same-named sibling from being silently treated as "already saved"
      // just because a differently-named-DOB'd athlete of the same name
      // exists on the profile already.
      const idx = merged.findIndex((k) => normalizedAthleteName(k.name) === normalizedAthleteName(parsed.name) && k.dob === parsed.dob);
      if (idx >= 0) continue;
      merged.push({
        id: crypto.randomUUID(),
        name: parsed.name,
        dob: parsed.dob,
        grade: parsed.grade,
        gender: (parsed.gender as "male" | "female" | "") || "",
        groups: Array.from(parsed.groups) as Athlete["groups"],
      });
      changed = true;
    }
    if (!changed && existing) continue;

    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert({ id: userId, email, kids: merged, updated_at: new Date().toISOString() });
    if (upsertError) {
      console.error(`Backfill upsert failed for ${email}:`, upsertError);
      continue;
    }
    if (existing) profilesUpdated++;
    else profilesCreated++;
  }

  return NextResponse.json({
    profilesCreated,
    profilesUpdated,
    skippedNoAccount,
    totalClientEmails: athletesByEmail.size,
  });
}
