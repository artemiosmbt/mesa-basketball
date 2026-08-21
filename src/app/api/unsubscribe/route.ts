import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function unsubscribe(email: string, token: string): Promise<boolean> {
  if (!verifyUnsubscribeToken(email, token)) return false;
  const supabase = getSupabaseAdmin();
  // ilike, not eq — profiles.email casing can drift from how it was
  // originally typed at signup (same reasoning as every other email lookup
  // in this codebase), and a case-mismatched exact filter would silently
  // update zero rows while still reporting success to the caller.
  await supabase.from("profiles").update({ reminder_emails: false }).ilike("email", email.trim());
  return true;
}

function htmlPage(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Mesa Basketball Training</title></head>
<body style="margin:0; font-family: Arial, Helvetica, sans-serif; background:#091530; color:#fffbeb; padding:64px 16px; text-align:center;">
  <p style="max-width:420px; margin:0 auto; font-size:16px; line-height:1.6;">${message}</p>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// RFC 8058 one-click unsubscribe target — this is what the List-Unsubscribe
// header (see sendReminderEmail in src/lib/email.ts) points mail clients
// at. Gmail/Yahoo/Apple Mail POST here directly with body
// "List-Unsubscribe=One-Click" when the recipient taps their own built-in
// Unsubscribe button — no page load, no login, no second confirmation click,
// exactly what the RFC requires to count as compliant one-click.
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ok = await unsubscribe(searchParams.get("email") || "", searchParams.get("token") || "");
  return NextResponse.json({ success: ok }, { status: ok ? 200 : 400 });
}

// Same verification, hit when a human clicks the plain-text "Unsubscribe"
// link inside the email body itself rather than a mail client's built-in
// button — renders a small confirmation page instead of JSON.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ok = await unsubscribe(searchParams.get("email") || "", searchParams.get("token") || "");
  return htmlPage(
    ok
      ? "You've been unsubscribed from Mesa Basketball Training reminder emails."
      : "This unsubscribe link is invalid or has expired."
  );
}
