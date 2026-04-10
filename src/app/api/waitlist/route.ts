import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

export async function POST(req: NextRequest) {
  const { email } = await req.json();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return NextResponse.json({ error: "Email not configured" }, { status: 500 });

  const resend = new Resend(key);

  await resend.emails.send({
    from: "Mesa Basketball <noreply@mesabasketballtraining.com>",
    to: "artemios@mesabasketballtraining.com",
    subject: "New Virtual Training Waitlist Sign-Up",
    html: `<p><strong>${email}</strong> just joined the virtual training waitlist.</p>`,
  });

  return NextResponse.json({ ok: true });
}
