import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN = new Set(["START", "UNSTOP", "YES"]);

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

export async function POST(req: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const twilioSignature = req.headers.get("x-twilio-signature") || "";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || "";
  const webhookUrl = `${proto}://${host}/api/twilio/incoming`;

  const rawBody = await req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  if (!twilio.validateRequest(authToken, twilioSignature, webhookUrl, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const from = params.From || "";
  const keyword = (params.Body || "").trim().toUpperCase().split(/\s/)[0];

  if (!OPT_OUT.has(keyword) && !OPT_IN.has(keyword)) {
    return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } });
  }

  const newConsent = OPT_IN.has(keyword);
  const digitsOnly = from.replace(/\D/g, "").slice(-10);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, phone")
    .not("phone", "is", null);

  if (profiles) {
    const matches = profiles.filter(
      (p) => p.phone && p.phone.replace(/\D/g, "").slice(-10) === digitsOnly
    );
    for (const profile of matches) {
      await supabase
        .from("profiles")
        .update({ sms_consent: newConsent, updated_at: new Date().toISOString() })
        .eq("id", profile.id);
    }
  }

  return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } });
}
