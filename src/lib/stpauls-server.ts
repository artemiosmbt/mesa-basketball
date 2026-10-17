import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY St. Paul's practice queries (service role key).

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

// Practices this account booked, or is listed on as a coach. Emails are
// stored lowercased on both columns.
export async function getPracticesForEmail(email: string) {
  const supabase = getSupabaseAdmin();
  const [byBooker, byCoach] = await Promise.all([
    supabase.from("stpauls_practices").select("*").eq("booked_by_email", email),
    supabase.from("stpauls_practices").select("*").contains("coaches", [{ email }]),
  ]);
  if (byBooker.error) throw byBooker.error;
  if (byCoach.error) throw byCoach.error;
  const seen = new Set<string>();
  return [...(byBooker.data || []), ...(byCoach.data || [])].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}
