import type { SupabaseClient } from "@supabase/supabase-js";

interface EnrichableRegistration {
  id: string;
  email: string | null;
  booked_date: string | null;
  booked_start_time: string | null;
  type: string;
  status: string;
  referral_code?: string | null;
  session_price?: number | null;
}

interface PackageSummary {
  email: string;
  package_type: number;
  month_year: string;
  is_paid: boolean;
}

export interface ComputedFields {
  within_package?: boolean;
  package_paid?: boolean;
  weekly_discount_rate?: number;
}

function toMonthYear(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function sessionMs(dateStr: string | null, timeStr: string | null): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  if (!timeStr) return d.getTime();
  const m = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return d.getTime();
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

/**
 * Attaches within_package/package_paid/weekly_discount_rate to each row in
 * `registrations` — mirrors admin/page.tsx's packageMembership/
 * weeklyDiscountRates useMemos exactly (same positional-index and
 * discount-tier logic), just computed server-side instead of client-side.
 *
 * This is what makes windowed/lazy loading safe for these two features:
 * package membership is a positional index across ALL of a client's
 * sessions in one month, and the discount tier is a count across ALL
 * sessions sharing a referral code — both need to see the COMPLETE
 * relevant set to get the right answer, never just whatever partial window
 * the browser happens to have loaded. The sub-queries below always fetch
 * that complete set fresh (bounded to one client's one month, or one
 * referral-code batch — small regardless of total table size), independent
 * of what's in the `registrations` array being enriched.
 */
export async function attachComputedFields<T extends EnrichableRegistration>(
  supabase: SupabaseClient,
  registrations: T[],
  packages: PackageSummary[]
): Promise<(T & ComputedFields)[]> {
  const pkgByKey = new Map<string, PackageSummary>();
  for (const pkg of packages) {
    const key = `${pkg.email.toLowerCase().trim()}|${pkg.month_year}`;
    if (!pkgByKey.has(key)) pkgByKey.set(key, pkg);
  }

  // Distinct (email, monthYear) pairs in this batch that actually have a
  // matching package — no point sub-querying pairs that can never resolve.
  const pkgKeysNeeded = new Set<string>();
  for (const r of registrations) {
    if (r.type !== "private" && r.type !== "group-private") continue;
    if (r.status !== "confirmed") continue;
    const monthYear = toMonthYear(r.booked_date);
    if (!monthYear) continue;
    const key = `${(r.email || "").toLowerCase().trim()}|${monthYear}`;
    if (pkgByKey.has(key)) pkgKeysNeeded.add(key);
  }

  const withinPackageById = new Map<string, { withinPackage: boolean; packagePaid: boolean }>();
  await Promise.all(
    [...pkgKeysNeeded].map(async (key) => {
      const sep = key.indexOf("|");
      const email = key.slice(0, sep);
      const monthYear = key.slice(sep + 1);
      const pkg = pkgByKey.get(key)!;
      const { data } = await supabase
        .from("registrations")
        .select("id, booked_date, booked_start_time")
        .eq("email", email)
        .in("type", ["private", "group-private"])
        .eq("status", "confirmed");
      const inMonth = (data || []).filter((r) => toMonthYear(r.booked_date) === monthYear);
      const sorted = inMonth.sort(
        (a, b) => sessionMs(a.booked_date, a.booked_start_time) - sessionMs(b.booked_date, b.booked_start_time)
      );
      for (let i = 0; i < sorted.length; i++) {
        withinPackageById.set(sorted[i].id, { withinPackage: i < pkg.package_type, packagePaid: pkg.is_paid });
      }
    })
  );

  // Weekly bulk-discount rate — distinct referral codes in this batch
  // missing a stored session_price (booked before pricing was persisted at
  // write time).
  const codesNeeded = new Set<string>();
  for (const r of registrations) {
    if (r.type === "weekly" && r.referral_code && r.session_price == null) {
      codesNeeded.add(r.referral_code);
    }
  }
  const rateByCode = new Map<string, number>();
  await Promise.all(
    [...codesNeeded].map(async (code) => {
      const { count } = await supabase
        .from("registrations")
        .select("id", { count: "exact", head: true })
        .eq("referral_code", code)
        .eq("type", "weekly")
        .is("session_price", null);
      if (count && count >= 8) rateByCode.set(code, 0.15);
      else if (count && count >= 4) rateByCode.set(code, 0.1);
    })
  );

  return registrations.map((r) => {
    const pkgInfo = withinPackageById.get(r.id);
    const rate = r.referral_code ? rateByCode.get(r.referral_code) : undefined;
    return {
      ...r,
      ...(pkgInfo ? { within_package: pkgInfo.withinPackage, package_paid: pkgInfo.packagePaid } : {}),
      ...(rate !== undefined ? { weekly_discount_rate: rate } : {}),
    };
  });
}
