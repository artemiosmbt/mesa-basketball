// Read-only scan for likely-duplicate saved athletes within each parent's
// profile.kids — flags exact-name matches, same-DOB matches, and
// near-identical names (one name a prefix of the other, or small edit
// distance) so a human can confirm before any merge happens. Prints a
// report; does not write anything.
//
// Run with: node --env-file=.env.local scripts/find-duplicate-athletes.mjs

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function normName(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isPrefixOrSuffix(a, b) {
  return a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a);
}

function likelyReason(a, b) {
  const na = normName(a.name), nb = normName(b.name);
  if (na === nb) return "exact name match";
  if (a.dob && b.dob && a.dob === b.dob) return `same DOB (${a.dob})`;
  const firstA = na.split(" ")[0], firstB = nb.split(" ")[0];
  if (firstA === firstB && (isPrefixOrSuffix(na, nb) || na.includes(nb) || nb.includes(na))) {
    return "same first name, one name contains the other";
  }
  const dist = levenshtein(na, nb);
  const shortLen = Math.min(na.length, nb.length);
  if (shortLen >= 4 && dist <= 2) return `near-identical spelling (edit distance ${dist})`;
  return null;
}

const { data: profiles, error } = await supabase
  .from("profiles")
  .select("id, email, parent_name, kids")
  .not("kids", "is", null);
if (error) throw error;

let profilesWithDupes = 0;
let totalPairs = 0;

for (const p of profiles) {
  const kids = Array.isArray(p.kids) ? p.kids : [];
  if (kids.length < 2) continue;

  const pairs = [];
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      const reason = likelyReason(kids[i], kids[j]);
      if (reason) pairs.push({ a: kids[i], b: kids[j], reason });
    }
  }
  if (pairs.length === 0) continue;

  profilesWithDupes++;
  totalPairs += pairs.length;
  console.log(`\n=== ${p.parent_name || "(no name)"} <${p.email}> — profile ${p.id} ===`);
  for (const kid of kids) {
    console.log(`  [${kid.id}] "${kid.name}" dob=${kid.dob || "—"} grade=${kid.grade || "—"} groups=${JSON.stringify(kid.groups || [])}${kid.aliases?.length ? ` aliases=${JSON.stringify(kid.aliases)}` : ""}`);
  }
  console.log("  Likely duplicate pairs:");
  for (const { a, b, reason } of pairs) {
    console.log(`    "${a.name}" [${a.id}]  <->  "${b.name}" [${b.id}]  — ${reason}`);
  }
}

console.log(`\n${profilesWithDupes} profile(s) with likely duplicates, ${totalPairs} flagged pair(s) total, out of ${profiles.length} profiles scanned.`);
