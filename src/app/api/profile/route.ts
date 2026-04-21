import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateUniqueReferralCode, isReferralCodeTaken } from "@/lib/supabase";

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

  // Handle referral code update
  let referralCodeToSave: string | undefined;
  if (body.referralCode !== undefined) {
    const requested = (body.referralCode as string).toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (requested) {
      const taken = await isReferralCodeTaken(requested, user.email!);
      if (taken) return NextResponse.json({ error: "That referral code is already taken." }, { status: 409 });
      referralCodeToSave = requested;
    }
  }

  // Auto-generate code on first profile save if not already set and name is provided
  if (!referralCodeToSave && body.parentName) {
    const { data: existing } = await supabase
      .from("profiles")
      .select("referral_code")
      .eq("id", user.id)
      .maybeSingle();
    if (!existing?.referral_code) {
      referralCodeToSave = await generateUniqueReferralCode(body.parentName, user.email!);
    }
  }

  const upsertData: Record<string, unknown> = {
    id: user.id,
    email: user.email,
    parent_name: body.parentName || null,
    phone: body.phone || null,
    kids: body.kids || [],
    marketing_emails: body.marketingEmails ?? true,
    sms_consent: body.smsConsent ?? true,
    updated_at: new Date().toISOString(),
  };
  if (referralCodeToSave) upsertData.referral_code = referralCodeToSave;

  await supabase.from("profiles").upsert(upsertData);

  // Keep auth display name in sync so it shows in Supabase dashboard
  if (body.parentName) {
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { display_name: body.parentName },
    });
  }

  return NextResponse.json({ ok: true });
}
