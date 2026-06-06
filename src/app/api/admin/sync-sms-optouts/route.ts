import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
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

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN = new Set(["START", "UNSTOP", "YES"]);

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER!;

  const client = twilio(accountSid, authToken);
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch all inbound messages to our Twilio number
  const optOutPhones = new Set<string>();
  const optInPhones = new Set<string>();

  const messages = await client.messages.list({ to: twilioPhone });
  for (const msg of messages) {
    const keyword = (msg.body || "").trim().toUpperCase().split(/\s/)[0];
    const digits = (msg.from || "").replace(/\D/g, "").slice(-10);
    if (!digits) continue;
    if (OPT_OUT.has(keyword)) {
      optOutPhones.add(digits);
      optInPhones.delete(digits);
    } else if (OPT_IN.has(keyword)) {
      optInPhones.add(digits);
      optOutPhones.delete(digits);
    }
  }

  // Load all profiles and registrations with phone numbers
  const [{ data: profiles }, { data: regs }] = await Promise.all([
    supabase.from("profiles").select("id, email, phone, sms_consent"),
    supabase.from("registrations").select("id, email, phone, sms_consent"),
  ]);

  let profilesUpdated = 0;
  let regsUpdated = 0;

  // Update profiles
  for (const p of (profiles || [])) {
    if (!p.phone) continue;
    const digits = p.phone.replace(/\D/g, "").slice(-10);
    if (optOutPhones.has(digits) && p.sms_consent !== false) {
      await supabase.from("profiles").update({ sms_consent: false, updated_at: new Date().toISOString() }).eq("id", p.id);
      profilesUpdated++;
    } else if (optInPhones.has(digits) && p.sms_consent === false) {
      await supabase.from("profiles").update({ sms_consent: true, updated_at: new Date().toISOString() }).eq("id", p.id);
      profilesUpdated++;
    }
  }

  // Batch update registrations by opt-out set
  const optOutRegIds: string[] = [];
  const optInRegIds: string[] = [];
  for (const r of (regs || [])) {
    if (!r.phone) continue;
    const digits = r.phone.replace(/\D/g, "").slice(-10);
    if (optOutPhones.has(digits) && r.sms_consent !== false) optOutRegIds.push(r.id);
    else if (optInPhones.has(digits) && r.sms_consent === false) optInRegIds.push(r.id);
  }

  if (optOutRegIds.length > 0) {
    await supabase.from("registrations").update({ sms_consent: false }).in("id", optOutRegIds);
    regsUpdated += optOutRegIds.length;
  }
  if (optInRegIds.length > 0) {
    await supabase.from("registrations").update({ sms_consent: true }).in("id", optInRegIds);
    regsUpdated += optInRegIds.length;
  }

  return NextResponse.json({
    optedOut: optOutPhones.size,
    optedIn: optInPhones.size,
    profilesUpdated,
    regsUpdated,
  });
}
