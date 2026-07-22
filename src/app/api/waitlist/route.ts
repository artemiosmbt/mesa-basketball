import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";
import { isRateLimited } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const { email: rawEmail } = await req.json();
  const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : rawEmail;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  // The already-registered check below stops repeat spam to the SAME
  // address, but a script rotating fake emails each request would still
  // trigger the admin-alert email every single time — IP-keyed throttle
  // closes that gap.
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (await isRateLimited(`waitlist:ip:${ip}`, 8, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests. Please wait a few minutes and try again." }, { status: 429 });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return NextResponse.json({ error: "Email not configured" }, { status: 500 });

  const resend = new Resend(key);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Already on the list — no-op rather than re-sending. Without this,
  // repeatedly POSTing the same (or an arbitrary victim's) email resends the
  // confirmation email and the admin alert every single time, unlimited.
  const { data: existing } = await supabase
    .from("virtual_training_waitlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  if (existing) return NextResponse.json({ ok: true });

  await supabase.from("virtual_training_waitlist").upsert({ email }, { onConflict: "email" });

  await Promise.all([
    resend.emails.send({
      from: "Mesa Basketball <noreply@mesabasketballtraining.com>",
      to: "artemios@mesabasketballtraining.com",
      subject: "New Virtual Training Waitlist Sign-Up",
      html: `<p><strong>${email}</strong> just joined the virtual training waitlist.</p>`,
    }),
    resend.emails.send({
      from: "Mesa Basketball <noreply@mesabasketballtraining.com>",
      to: email,
      subject: "You're on the Mesa Virtual Training Waitlist",
      html: `
        <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
          <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;">You're on the list.</h2>
          <p style="color: #555; line-height: 1.6;">
            Thanks for signing up for the Mesa Basketball virtual training waitlist. We'll reach out as soon as it launches.
          </p>
          <p style="color: #555; line-height: 1.6;">
            In the meantime, if you have any questions feel free to call or text at <a href="tel:6315991280" style="color: #d4af37;">(631) 599-1280</a>.
          </p>
          <p style="margin-top: 24px; color: #555;">— Artemios Gavalas<br/>Mesa Basketball Training</p>
        </div>
      `,
    }),
  ]);

  return NextResponse.json({ ok: true });
}
