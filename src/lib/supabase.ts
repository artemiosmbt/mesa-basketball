import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase not configured");
    _supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supabase;
}

export interface Registration {
  id: string;
  created_at: string;
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  session_details: string;
  total_participants: number;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_location: string | null;
  status: string;
  manage_token: string;
  referral_code: string | null;
  is_free: boolean;
  session_price: number | null;
  is_full_camp: boolean;
}

export async function addRegistration(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  bookedDate?: string;
  bookedStartTime?: string;
  bookedEndTime?: string;
  bookedLocation?: string;
}): Promise<{ manageToken: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("registrations")
    .insert({
      parent_name: data.parentName,
      email: data.email,
      phone: data.phone,
      kids: data.kids,
      type: data.type,
      session_details: data.sessionDetails,
      total_participants: data.totalParticipants,
      booked_date: data.bookedDate || null,
      booked_start_time: data.bookedStartTime || null,
      booked_end_time: data.bookedEndTime || null,
      booked_location: data.bookedLocation || null,
    })
    .select("manage_token")
    .single();
  if (error) throw error;
  return { manageToken: row.manage_token };
}

export async function getBookedSlots(): Promise<
  { date: string; startTime: string; endTime: string; location: string }[]
> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time, booked_end_time, booked_location")
    .not("booked_date", "is", null)
    .eq("status", "confirmed")
    .in("type", ["private", "group-private"]);

  if (error) throw error;
  return (data || []).map((r) => ({
    date: r.booked_date,
    startTime: r.booked_start_time,
    endTime: r.booked_end_time,
    location: r.booked_location,
  }));
}

export async function getRegistrationByToken(
  token: string
): Promise<Registration | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .eq("manage_token", token)
    .single();
  if (error) return null;
  return data as Registration;
}

export async function getRegistrationsByEmail(
  email: string
): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .eq("email", email.toLowerCase().trim())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []) as Registration[];
}

export async function updateRegistrationPlayers(
  token: string,
  kids: string,
  totalParticipants: number,
  sessionPrice: number | null
): Promise<boolean> {
  const supabase = getSupabase();
  const update: Record<string, unknown> = { kids, total_participants: totalParticipants };
  if (sessionPrice !== null) update.session_price = sessionPrice;
  const { error } = await supabase
    .from("registrations")
    .update(update)
    .eq("manage_token", token)
    .eq("status", "confirmed");
  return !error;
}

export async function cancelRegistration(token: string, isLateCancel = false): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("registrations")
    .update({ status: "cancelled", is_late_cancel: isLateCancel })
    .eq("manage_token", token)
    .eq("status", "confirmed");
  return !error;
}

/** Get the earliest booked_date + booked_start_time across all days of a full camp group. */
export async function getEarliestCampDay(referralCode: string): Promise<{ booked_date: string; booked_start_time: string } | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time")
    .eq("referral_code", referralCode)
    .eq("type", "camp")
    .eq("is_full_camp", true)
    .not("booked_date", "is", null)
    .order("booked_date", { ascending: true })
    .limit(1)
    .single();
  if (error || !data) return null;
  return data;
}

/** Cancel all confirmed camp days sharing the same referral_code (full camp cancellation). */
export async function cancelFullCampByReferralCode(referralCode: string): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("registrations")
    .update({ status: "cancelled" })
    .eq("referral_code", referralCode)
    .eq("type", "camp")
    .eq("is_full_camp", true)
    .eq("status", "confirmed");
  return !error;
}

// --- Rewards & Referral Helpers ---

/** Get referral credits for an email */
export async function getReferralCredits(email: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("referral_credits")
    .select("credits")
    .eq("email", email)
    .single();
  if (error || !data) return 0;
  return data.credits || 0;
}

/** Add 1 referral credit to an email (upsert) */
export async function addReferralCredit(email: string): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("referral_credits")
    .select("credits")
    .eq("email", email)
    .single();

  if (data) {
    await supabase
      .from("referral_credits")
      .update({ credits: (data.credits || 0) + 1, updated_at: new Date().toISOString() })
      .eq("email", email);
  } else {
    await supabase
      .from("referral_credits")
      .insert({ email, credits: 1 });
  }
}

/** Use 1 referral credit (half-off session) */
export async function decrementReferralCredit(email: string): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("referral_credits")
    .select("credits")
    .eq("email", email)
    .single();
  if (data && (data.credits || 0) > 0) {
    await supabase
      .from("referral_credits")
      .update({ credits: data.credits - 1, updated_at: new Date().toISOString() })
      .eq("email", email);
  }
}

/** Check if email OR phone has any previous registrations (fraud-resistant new client check) */
export async function isNewClient(email: string, phone: string): Promise<boolean> {
  const supabase = getSupabase();
  const normalizedPhone = phone.replace(/\D/g, "").slice(-10); // last 10 digits
  const normalizedEmail = email.toLowerCase().trim();

  // Check existing_clients table (pre-launch clients added manually)
  const { data: existingRows } = await supabase
    .from("existing_clients")
    .select("phone");

  if (existingRows) {
    for (const row of existingRows) {
      const stored = (row.phone || "").replace(/\D/g, "").slice(-10);
      if (stored && stored === normalizedPhone) return false;
    }
  }

  // Check by email in registrations
  const { count: emailCount } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", normalizedEmail);

  if ((emailCount || 0) > 0) return false;

  // Also fetch recent registrations to check phone (stored in various formats)
  const { data: phoneRows } = await supabase
    .from("registrations")
    .select("phone")
    .limit(500);

  if (phoneRows) {
    for (const row of phoneRows) {
      const stored = (row.phone || "").replace(/\D/g, "").slice(-10);
      if (stored && stored === normalizedPhone) return false;
    }
  }

  return true;
}

/** Look up the email of the family that owns a referral code (checks profiles first, then registrations) */
export async function findReferrerByCode(code: string): Promise<string | null> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email")
    .eq("referral_code", upper)
    .maybeSingle();
  if (profile?.email) return profile.email;
  const { data, error } = await supabase
    .from("registrations")
    .select("email")
    .eq("referral_code", upper)
    .limit(1)
    .single();
  if (error || !data) return null;
  return data.email;
}

/** Look up the name and email of the family that owns a referral code (checks profiles first, then registrations) */
export async function findReferrerInfoByCode(code: string): Promise<{ email: string; name: string } | null> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, parent_name")
    .eq("referral_code", upper)
    .maybeSingle();
  if (profile?.email) return { email: profile.email, name: profile.parent_name || "" };
  const { data, error } = await supabase
    .from("registrations")
    .select("email, parent_name")
    .eq("referral_code", upper)
    .limit(1)
    .single();
  if (error || !data) return null;
  return { email: data.email, name: data.parent_name };
}

/** Generate a referral code from parent name: LASTNAME-MESA */
export function generateReferralCode(parentName: string): string {
  const parts = parentName.trim().split(/\s+/);
  const lastName = parts[parts.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
  return `${lastName}-MESA`;
}

/** Get the referral code stored in a user's profile, if any */
export async function getProfileReferralCode(email: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("profiles")
    .select("referral_code")
    .eq("email", email)
    .maybeSingle();
  return data?.referral_code || null;
}

/** Check if a referral code is already taken by a different email */
export async function isReferralCodeTaken(code: string, excludeEmail: string): Promise<boolean> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  // Check profiles table
  const { data: profileMatch } = await supabase
    .from("profiles")
    .select("email")
    .eq("referral_code", upper)
    .neq("email", excludeEmail)
    .maybeSingle();
  if (profileMatch) return true;
  // Fall back to registrations (legacy codes not yet in profiles)
  const { data: regMatch } = await supabase
    .from("registrations")
    .select("email")
    .eq("referral_code", upper)
    .neq("email", excludeEmail)
    .limit(1)
    .maybeSingle();
  return !!regMatch;
}

/**
 * Generate a unique referral code for a family.
 * Priority: profile-stored code → registrations-stored code → generate from profile name → generate from parentName arg.
 * The name used for generation is always the profile's stored name (not the booking form name),
 * so booking on behalf of someone else never changes your own code.
 */
export async function generateUniqueReferralCode(parentName: string, email: string): Promise<string> {
  const supabase = getSupabase();

  // 1. Check profiles table first (source of truth)
  const profileCode = await getProfileReferralCode(email);
  if (profileCode) return profileCode;

  // 2. Fall back to registrations for accounts that existed before profiles had referral_code
  const { data: existing } = await supabase
    .from("registrations")
    .select("referral_code")
    .eq("email", email)
    .not("referral_code", "is", null)
    .limit(1)
    .maybeSingle();

  if (existing?.referral_code) return existing.referral_code;

  // 3. Generate from the profile's stored name (not the booking form name)
  const { data: profile } = await supabase
    .from("profiles")
    .select("parent_name")
    .eq("email", email)
    .maybeSingle();

  const nameToUse = profile?.parent_name || parentName;
  const base = generateReferralCode(nameToUse);
  let code = base;
  let suffix = 2;

  while (true) {
    const taken = await isReferralCodeTaken(code, email);
    if (!taken) return code;
    code = `${base}${suffix}`;
    suffix++;
  }
}

/** Insert a registration with referral_code and is_free columns */
export async function addRegistrationWithRewards(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  bookedDate?: string;
  bookedStartTime?: string;
  bookedEndTime?: string;
  bookedLocation?: string;
  referralCode: string;
  isFree: boolean;
  smsConsent?: boolean;
  sessionPrice?: number;
  isFullCamp?: boolean;
}): Promise<{ manageToken: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("registrations")
    .insert({
      parent_name: data.parentName,
      email: data.email,
      phone: data.phone,
      kids: data.kids,
      type: data.type,
      session_details: data.sessionDetails,
      total_participants: data.totalParticipants,
      booked_date: data.bookedDate || null,
      booked_start_time: data.bookedStartTime || null,
      booked_end_time: data.bookedEndTime || null,
      booked_location: data.bookedLocation || null,
      referral_code: data.referralCode,
      is_free: data.isFree,
      sms_consent: data.smsConsent ?? false,
      session_price: data.sessionPrice ?? null,
      is_full_camp: data.isFullCamp ?? false,
    })
    .select("manage_token")
    .single();
  if (error) throw error;
  return { manageToken: row.manage_token };
}

// --- Monthly Package Helpers ---

export interface MonthlyPackage {
  id: string;
  created_at: string;
  email: string;
  parent_name: string;
  phone: string;
  package_type: number;
  month_year: string;
  sessions_used: number;
  reminder_sent: boolean;
  status: string;
}

export async function enrollInPackage(data: {
  email: string;
  parentName: string;
  phone: string;
  packageType: number;
  monthYear: string;
}): Promise<{ id: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("monthly_packages")
    .insert({
      email: data.email.toLowerCase().trim(),
      parent_name: data.parentName,
      phone: data.phone,
      package_type: data.packageType,
      month_year: data.monthYear,
      sessions_used: 0,
      reminder_sent: false,
      status: "active",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: row.id };
}

export async function getActivePackage(
  email: string,
  monthYear: string
): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .eq("email", email.toLowerCase().trim())
    .eq("month_year", monthYear)
    .eq("status", "active")
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

export async function incrementPackageSessions(id: string, currentUsed: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: currentUsed + 1 })
    .eq("id", id);
}

export async function decrementPackageSessions(id: string, currentUsed: number): Promise<void> {
  const supabase = getSupabase();
  if (currentUsed <= 0) return;
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: currentUsed - 1 })
    .eq("id", id);
}

/** Set sessions_used to an exact value (used for recalculation) */
export async function setPackageSessions(id: string, count: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: count })
    .eq("id", id);
}

/** Count confirmed private/group-private registrations for an email in a given month */
export async function countConfirmedPrivateSessions(email: string, monthYear: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date")
    .eq("email", email.toLowerCase().trim())
    .eq("status", "confirmed")
    .in("type", ["private", "group-private"])
    .not("booked_date", "is", null);

  if (error || !data) return 0;

  return data.filter((r) => {
    const raw = r.booked_date as string;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(raw + "T12:00:00")
      : new Date(raw);
    if (isNaN(d.getTime())) return false;
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return m === monthYear;
  }).length;
}

export async function getPackagesNeedingReminder(monthYear: string): Promise<MonthlyPackage[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .eq("month_year", monthYear)
    .eq("status", "active")
    .eq("reminder_sent", false);
  if (error || !data) return [];
  return (data as MonthlyPackage[]).filter((p) => p.sessions_used < p.package_type);
}

export async function markReminderSent(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ reminder_sent: true })
    .eq("id", id);
}

/** Count confirmed weekly registrations per session (by date + start time) */
export async function getGroupSessionEnrollment(): Promise<
  Record<string, number>
> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time, total_participants")
    .in("type", ["weekly", "camp"])
    .eq("status", "confirmed")
    .not("booked_date", "is", null);

  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data) {
    const key = `${row.booked_date}|${row.booked_start_time}`;
    counts[key] = (counts[key] || 0) + (row.total_participants || 1);
  }
  return counts;
}

/** Check if a specific group session has capacity */
export async function checkGroupSessionCapacity(
  date: string,
  startTime: string,
  maxSpots: number
): Promise<{ available: boolean; enrolled: number }> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("type", "weekly")
    .eq("status", "confirmed")
    .eq("booked_date", date)
    .eq("booked_start_time", startTime);

  const enrolled = error ? 0 : count || 0;
  return { available: enrolled < maxSpots, enrolled };
}

export async function checkDuplicateRegistration(
  email: string,
  date: string,
  startTime: string
): Promise<boolean> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("booked_date", date)
    .eq("booked_start_time", startTime)
    .eq("status", "confirmed");
  return !error && (count ?? 0) > 0;
}

