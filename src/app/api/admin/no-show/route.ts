import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { sendNoShowNotification } from "@/lib/email";

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

// Full-price fallback by session type if session_price is not stored
function fullPriceForType(type: string): number {
  if (type === "group-private") return 250;
  if (type === "private") return 150;
  return 50; // weekly group
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

  const { data: reg } = await supabase
    .from("registrations")
    .select("parent_name, email, session_details, type, session_price")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

  const { error } = await supabase
    .from("registrations")
    .update({ status: "no_show" })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const feeAmount = reg.session_price ?? fullPriceForType(reg.type);

  await sendNoShowNotification({
    parentName: reg.parent_name,
    email: reg.email,
    sessionDetails: reg.session_details,
    sessionType: reg.type,
    feeAmount,
  });

  return NextResponse.json({ ok: true, feeAmount });
}
