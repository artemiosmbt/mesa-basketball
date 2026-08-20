import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { normalizedAthleteName, type Athlete, type CanonicalGroupId } from "@/lib/athletes";

// --- Ported verbatim from backfill-athlete-profiles/route.ts ---
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

// One-time-reconciliation mapping, used ONLY by this route — deliberately
// NOT merged into group-matching.ts's canonicalGroupForLabel (which drives
// live auto-assign-on-booking for every future registration). This adds the
// pre-restructure era label "High School Boys" (the group's literal old
// name, before the JV/Varsity split — confirmed by the owner), which maps
// to jv-boys per explicit instruction. Every other keyword matches
// canonicalGroupForLabel exactly.
function historicalGroupsForLabel(liveLabel: string): CanonicalGroupId[] {
  const name = liveLabel.toLowerCase();
  const hasJV = /\bjv\b/.test(name);
  const hasVarsity = name.includes("varsity");
  if (hasJV && hasVarsity) return ["jv-boys", "varsity-boys"];
  if (hasJV) return ["jv-boys"];
  if (hasVarsity) return ["varsity-boys"];
  if (name.includes("junior") || /\bjr\b/.test(name)) return ["junior"];
  if (name.includes("middle school")) return ["ms"];
  if (name.includes("high school") && name.includes("girls")) return ["hs-girls"];
  if (name.includes("high school") && name.includes("boys")) return ["jv-boys"];
  return [];
}

interface HistoricalEntry {
  name: string;
  dob: string;
  grade: string;
  gender?: string;
  groups: Set<CanonicalGroupId>;
}

// Reassigns every athlete's group membership from their real registration
// history — additive only (a group is only ever ADDED, never removed), so
// an athlete manually placed by the admin, or already correctly grouped,
// only ever gains groups they demonstrably also booked in the past. A kid
// with history in more than one program (e.g. Middle School AND Junior)
// ends up in both, matching how one booking can already carry multiple
// canonical groups elsewhere in this codebase. Also creates any athlete
// who has registration history but no saved profiles.kids entry at all
// (same "never overwrite an existing entry" rule as
// backfill-athlete-profiles, just combined here with the corrected
// historical-era mapping above so a freshly-created entry doesn't fall
// into the same High-School-Boys gap that route has).
// body: { apply?: boolean } — defaults to a dry run (no writes).
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: regs, error: regsError } = await supabase
    .from("registrations")
    .select("email, kids, booked_group")
    .neq("status", "payment_abandoned")
    .not("email", "is", null);
  if (regsError) return NextResponse.json({ error: regsError.message }, { status: 500 });

  // email -> normalizedName -> resolved historical groups (+ enough of the
  // kid's own data to seed a brand-new entry if none is saved yet)
  const historicalByEmail = new Map<string, Map<string, HistoricalEntry>>();
  for (const r of regs || []) {
    const email = (r.email || "").toLowerCase().trim();
    if (!email || !r.kids) continue;
    const cgs = r.booked_group ? historicalGroupsForLabel(r.booked_group) : [];
    if (cgs.length === 0) continue;
    if (!historicalByEmail.has(email)) historicalByEmail.set(email, new Map());
    const bucket = historicalByEmail.get(email)!;
    for (const kid of parseRegistrationKidsString(r.kids)) {
      const nameKey = normalizedAthleteName(kid.name);
      if (!bucket.has(nameKey)) bucket.set(nameKey, { name: kid.name, dob: kid.dob, grade: kid.grade, gender: kid.gender, groups: new Set() });
      const entry = bucket.get(nameKey)!;
      for (const cg of cgs) entry.groups.add(cg);
      if (!entry.dob && kid.dob) entry.dob = kid.dob;
      if (!entry.grade && kid.grade) entry.grade = kid.grade;
      if (!entry.gender && kid.gender) entry.gender = kid.gender;
    }
  }

  const userIdByEmail = new Map<string, string>();
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const u of data.users) if (u.email) userIdByEmail.set(u.email.toLowerCase().trim(), u.id);
    if (data.users.length < 1000) break;
    page++;
  }

  const athletesCreated: { email: string; name: string; groups: CanonicalGroupId[] }[] = [];
  const athletesUpdated: { email: string; name: string; groupsAdded: CanonicalGroupId[] }[] = [];
  let profilesCreated = 0;
  let skippedNoAccount = 0;

  for (const [email, nameMap] of historicalByEmail) {
    const userId = userIdByEmail.get(email);
    if (!userId) { skippedNoAccount++; continue; }

    const { data: existing } = await supabase.from("profiles").select("kids").eq("id", userId).maybeSingle();
    const existingKids: Athlete[] = Array.isArray(existing?.kids) ? existing.kids : [];
    let changed = false;

    const grownKids = existingKids.map((k) => {
      const resolved = nameMap.get(normalizedAthleteName(k.name || ""));
      if (!resolved || resolved.groups.size === 0) return k;
      const current = new Set(k.groups || []);
      const toAdd = Array.from(resolved.groups).filter((g) => !current.has(g));
      if (toAdd.length === 0) return k;
      changed = true;
      athletesUpdated.push({ email, name: k.name, groupsAdded: toAdd });
      return { ...k, groups: [...(k.groups || []), ...toAdd] };
    });

    const finalKids = [...grownKids];
    for (const [nameKey, entry] of nameMap) {
      const alreadyExists = finalKids.some((k) => normalizedAthleteName(k.name || "") === nameKey);
      if (alreadyExists) continue;
      changed = true;
      const groups = Array.from(entry.groups);
      finalKids.push({
        id: crypto.randomUUID(),
        name: entry.name,
        dob: entry.dob,
        grade: entry.grade,
        gender: (entry.gender as "male" | "female" | "") || "",
        groups,
      });
      athletesCreated.push({ email, name: entry.name, groups });
    }

    if (!changed) continue;

    if (apply) {
      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert({ id: userId, email, kids: finalKids, updated_at: new Date().toISOString() });
      if (upsertError) {
        return NextResponse.json({ error: `Write failed for ${email}: ${upsertError.message}` }, { status: 500 });
      }
    }
    if (!existing) profilesCreated++;
  }

  return NextResponse.json({
    apply,
    profilesCreated,
    athletesCreated,
    athletesUpdated,
    skippedNoAccount,
  });
}
