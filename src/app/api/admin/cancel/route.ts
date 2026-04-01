import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email === ADMIN_EMAIL;
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch the registration to calculate late cancel
  const { data: reg } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time")
    .eq("id", id)
    .single();

  let isLateCancel = false;
  if (reg?.booked_date && reg?.booked_start_time) {
    const timeMatch = reg.booked_start_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      const sessionDateTime = new Date(reg.booked_date);
      sessionDateTime.setHours(hours, mins, 0, 0);
      const hoursUntil = (sessionDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
      isLateCancel = hoursUntil >= 0 && hoursUntil < 48;
    }
  }

  const { error } = await supabase
    .from("registrations")
    .update({ status: "cancelled", is_late_cancel: isLateCancel })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, isLateCancel });
}
