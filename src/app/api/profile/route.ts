import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateUniqueReferralCode, isReferralCodeTaken } from "@/lib/supabase";
import { normalizeGender } from "@/lib/athletes";

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
  const [{ data }, { count: bookingCount }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase.from("registrations").select("*", { count: "exact", head: true })
      .eq("email", user.email!.toLowerCase().trim())
      .eq("status", "confirmed"),
  ]);
  // Self-heals a profile saved back when signup/page.tsx's gender dropdown
  // still returned capitalized "Male"/"Female" (see normalizeGender) — every
  // reader downstream expects lowercase, so this is normalized on every read
  // rather than requiring a one-time data migration.
  const normalized = data && Array.isArray(data.kids)
    ? { ...data, kids: data.kids.map((k: Record<string, unknown>) => ({ ...k, gender: normalizeGender(k.gender as string) })) }
    : data;
  return NextResponse.json({ ...(normalized || {}), is_returning_client: (bookingCount || 0) > 0 });
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

  // This route's kids array is a full overwrite (correct for the settings
  // page's "manage my whole roster" UI) — normalize every kid to guarantee
  // an id/groups here since a client-supplied kid (e.g. a newly-added row
  // in settings) may have neither yet.
  const kidsNormalized = (body.kids || []).map((k: Record<string, unknown>) => ({
    ...k,
    id: (k.id as string) || crypto.randomUUID(),
    groups: Array.isArray(k.groups) ? k.groups : [],
    gender: normalizeGender(k.gender as string),
  }));

  const upsertData: Record<string, unknown> = {
    id: user.id,
    email: user.email,
    parent_name: body.parentName || null,
    phone: body.phone || null,
    kids: kidsNormalized,
    marketing_emails: body.marketingEmails ?? true,
    // Defaults to false (opt-out), not true — TCPA consent must never be
    // assumed. Every current caller (signup, settings, post-confirmation
    // profile save) already sends an explicit boolean, so this default
    // isn't reachable today; it's a guard against a future caller silently
    // opting someone into texts by omitting the field.
    sms_consent: body.smsConsent ?? false,
    video_consent: body.videoConsent ?? true,
    // Opt-out by default (true), unlike sms_consent above — the owner's
    // explicit choice for this preference, backfilled to true for every
    // existing profile via supabase-migration-reminder-emails-consent.sql.
    reminder_emails: body.reminderEmails ?? true,
    updated_at: new Date().toISOString(),
  };
  if (referralCodeToSave) upsertData.referral_code = referralCodeToSave;

  let { error: upsertError } = await supabase.from("profiles").upsert(upsertData);
  if (upsertError?.code === "23505" && referralCodeToSave) {
    // Unique violation on referral_code — two concurrent profile saves raced
    // to the same generated/requested code. A user-requested code losing
    // that race should be reported, not silently swapped for something else.
    if (body.referralCode !== undefined) {
      return NextResponse.json({ error: "That referral code is already taken." }, { status: 409 });
    }
    // Auto-generated code collided — retry once with a random suffix rather
    // than silently dropping the whole profile save.
    upsertData.referral_code = `${referralCodeToSave}${Math.floor(10 + Math.random() * 90)}`;
    ({ error: upsertError } = await supabase.from("profiles").upsert(upsertData));
  }
  if (upsertError) {
    console.error("Profile upsert failed:", upsertError);
    return NextResponse.json({ error: "Failed to save profile." }, { status: 500 });
  }

  // Also sync to registrations — sms-reminders.ts's cron reads
  // registrations.sms_consent directly, not profiles. Without this, a
  // client explicitly opting out here still gets texted: their existing
  // registration rows keep whatever sms_consent value was set whenever they
  // last booked. Twilio's own STOP-reply handler (twilio/incoming/route.ts)
  // already dual-writes both tables for the exact same reason — this path
  // was missing that.
  if (body.smsConsent !== undefined && user.email) {
    const { error: regConsentError } = await supabase
      .from("registrations")
      .update({ sms_consent: !!body.smsConsent })
      .eq("email", user.email.toLowerCase().trim());
    if (regConsentError) console.error(`Failed to sync sms_consent to registrations for ${user.email}:`, regConsentError);
  }

  // Keep auth display name in sync so it shows in Supabase dashboard —
  // previously uncaught/unlogged, so a future transient failure here would
  // silently leave the Auth dashboard's display name blank with no trace.
  if (body.parentName) {
    const { error: metaError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: { display_name: body.parentName },
    });
    if (metaError) console.error(`Failed to sync auth display_name for user ${user.id}:`, metaError);
  }

  return NextResponse.json({ ok: true });
}
