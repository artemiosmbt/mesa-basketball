import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase not configured");
    _supabase = createClient(url, key);
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

export async function cancelRegistration(token: string): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("registrations")
    .update({ status: "cancelled" })
    .eq("manage_token", token)
    .eq("status", "confirmed");
  return !error;
}

// --- Rewards & Referral Helpers ---

/** Count confirmed private/group-private sessions for a given email */
export async function getConfirmedSessionCount(email: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("status", "confirmed")
    .in("type", ["private", "group-private"]);
  if (error) return 0;
  return count || 0;
}

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

/** Check if an email has any previous registrations */
export async function isNewFamily(email: string): Promise<boolean> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", email);
  if (error) return true;
  return (count || 0) === 0;
}

/** Look up the email of the family that owns a referral code */
export async function findReferrerByCode(code: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("email")
    .eq("referral_code", code.toUpperCase())
    .limit(1)
    .single();
  if (error || !data) return null;
  return data.email;
}

/** Generate a referral code from parent name: LASTNAME-MESA */
export function generateReferralCode(parentName: string): string {
  const parts = parentName.trim().split(/\s+/);
  const lastName = parts[parts.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
  return `${lastName}-MESA`;
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
    })
    .select("manage_token")
    .single();
  if (error) throw error;
  return { manageToken: row.manage_token };
}
