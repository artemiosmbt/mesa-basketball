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

export async function cancelRegistration(token: string): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("registrations")
    .update({ status: "cancelled" })
    .eq("manage_token", token)
    .eq("status", "confirmed");
  return !error;
}
