import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { addAccountCredit, deductAccountCredit } from "@/lib/supabase";

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

// Manual balance adjustment — positive amount adds credit, negative removes it.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email, amount } = await req.json();
  if (!email || typeof amount !== "number" || amount === 0) {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  const trimmedEmail = String(email).toLowerCase().trim();
  if (amount > 0) {
    await addAccountCredit(trimmedEmail, amount);
  } else {
    const success = await deductAccountCredit(trimmedEmail, -amount);
    if (!success) {
      return NextResponse.json({ error: "Insufficient balance to remove that much credit" }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true });
}
