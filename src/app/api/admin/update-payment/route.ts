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

  const { id, field, value, referralCode, bookedGroup } = await req.json();
  if (!id || !field) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const allowed = ["is_paid", "cancel_fee_settled"];
  if (!allowed.includes(field)) {
    return NextResponse.json({ error: "Invalid field" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // For full camp registrations, update all rows sharing the same referral_code AND
  // booked_group (the camp's own name) — referral_code alone isn't a unique purchase
  // ID, it's the client's permanent code, identical across every camp they've bought.
  if (referralCode && (field === "is_paid" || field === "cancel_fee_settled")) {
    let query = supabase
      .from("registrations")
      .update({ [field]: value })
      .eq("referral_code", referralCode)
      .eq("is_full_camp", true);
    query = bookedGroup ? query.eq("booked_group", bookedGroup) : query.is("booked_group", null);
    if (field === "cancel_fee_settled") query = query.eq("status", "cancelled");
    const { error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase
    .from("registrations")
    .update({ [field]: value })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
