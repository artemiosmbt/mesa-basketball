import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  return NextResponse.json(data || {});
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const supabase = getSupabaseAdmin();

  await supabase.from("profiles").upsert({
    id: user.id,
    email: user.email,
    parent_name: body.parentName || null,
    phone: body.phone || null,
    kids: body.kids || [],
    marketing_emails: body.marketingEmails ?? true,
    sms_consent: body.smsConsent ?? true,
    updated_at: new Date().toISOString(),
  });

  // Keep auth display name in sync so it shows in Supabase dashboard
  if (body.parentName) {
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { display_name: body.parentName },
    });
  }

  return NextResponse.json({ ok: true });
}
