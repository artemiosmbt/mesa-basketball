import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import twilio from "twilio";
import { verifyAdmin } from "@/lib/auth";

// One-off broadcast to every past/present client — Artemios heading overseas
// to continue his pro career, handing day-to-day training off to 4 sub-
// trainers he's hand-picked. Not a reusable newsletter tool: the message is
// hardcoded on purpose (mode/channel are the only inputs) so this can't
// later be repurposed into an open "send arbitrary HTML to every client"
// endpoint by accident.
//
// mode:"test" sends ONLY to Artemios's own email/phone, never touches the
// real client list — meant to be run first so he can see exactly what
// lands in an inbox/phone before mode:"send" goes out to everyone.

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const ARTEMI_PHONE = "6315991280";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://mesa-basketball-h8lk.vercel.app";

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

const SUBJECT = "A Message From Coach Artemios — Mesa Basketball";

// Same navy/gold/cream branded shell as sendReminderEmail in src/lib/
// email.ts (see its comments for why: full HTML document, color-scheme
// meta opt-out, [data-ogsc] + prefers-color-scheme dark-mode overrides, and
// a logo with the cream backing circle baked into the PNG's own pixels
// rather than a CSS background-color, since Gmail/Outlook dark mode was
// previously confirmed (real screenshot) to recolor a CSS-driven backing
// black). Kept as one intentionally duplicated template rather than
// factored into a shared helper — this file is meant to be short-lived.
function buildEmailHtml(): string {
  return `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>Mesa Basketball Training</title>
<style>
  [data-ogsc] .mesa-outer-bg, [data-ogsc] .mesa-outer-bg td { background-color: #091530 !important; }
  [data-ogsc] .mesa-card-bg { background-color: #0f1f42 !important; }
  [data-ogsc] .mesa-content-bg { background-color: #fffbeb !important; }
  [data-ogsc] .mesa-cta-bg { background-color: #d4af37 !important; }
  [data-ogsc] .mesa-gold-text { color: #d4af37 !important; }
  [data-ogsc] .mesa-navy-text { color: #091530 !important; }
  [data-ogsc] .mesa-body-text { color: #3a3a3a !important; }
  [data-ogsc] .mesa-muted-text { color: #7d8bab !important; }
  @media (prefers-color-scheme: dark) {
    .mesa-outer-bg, .mesa-outer-bg td { background-color: #091530 !important; }
    .mesa-card-bg { background-color: #0f1f42 !important; }
    .mesa-content-bg { background-color: #fffbeb !important; }
    .mesa-cta-bg { background-color: #d4af37 !important; }
    .mesa-gold-text { color: #d4af37 !important; }
    .mesa-navy-text { color: #091530 !important; }
    .mesa-body-text { color: #3a3a3a !important; }
    .mesa-muted-text { color: #7d8bab !important; }
  }
</style>
</head>
<body class="mesa-outer-bg" bgcolor="#091530" style="margin: 0; padding: 0; background-color: #091530;">
  <div class="mesa-outer-bg" style="background: #091530; padding: 32px 16px; font-family: Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mesa-card-bg" style="max-width: 600px; margin: 0 auto; background: #0f1f42; border-radius: 12px; overflow: hidden; border: 1px solid #1e3a6e;">
      <tr>
        <td class="mesa-outer-bg" style="background: #091530; padding: 28px 24px; text-align: center; border-bottom: 2px solid #d4af37;">
          <img src="${BASE_URL}/logo-circle.png" width="80" height="80" alt="Mesa Basketball Training" style="display: block; margin: 0 auto;" />
          <p class="mesa-gold-text" style="margin: 10px 0 0; color: #d4af37; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; font-weight: bold;">Mesa Basketball Training</p>
        </td>
      </tr>
      <tr>
        <td class="mesa-content-bg" style="padding: 36px 32px; background: #fffbeb;">
          <h1 class="mesa-navy-text" style="margin: 0 0 24px; color: #091530; font-size: 22px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px; font-family: Arial, Helvetica, sans-serif;">
            To The MEΣΑ Family
          </h1>
          <p class="mesa-body-text" style="margin: 0 0 18px; color: #3a3a3a; font-size: 15px; line-height: 1.7;">
            As some of you already know I will be heading off to continue my professional playing career in Greece for some time. Before I leave, I wanted to make sure that I thank each and everyone for your continuous support of the program. None of this would be possible without you guys and I&rsquo;m truly forever grateful for the trust, loyalty, and commitment you have brought to MEΣΑ. Continuing to believe in what I&rsquo;ve been building from the start means everything to me.
          </p>
          <p class="mesa-body-text" style="margin: 0 0 18px; color: #3a3a3a; font-size: 15px; line-height: 1.7;">
            Although I won&rsquo;t physically be present, MEΣA isn&rsquo;t going anywhere. If you don&rsquo;t know yet, I have hand picked a team of 4 additional trainers with a high level of experience, who I trust and know will continue to share the same values, standards, and passion for developing your kids the right way. I encourage everyone to explore what each of them bring to the table and give your athletes the ability to learn from different basketball minds that still share the same values. You can find out more about each of them specifically in the <a href="${BASE_URL}/about" class="mesa-gold-text" style="color: #d4af37; font-weight: bold;">&ldquo;About&rdquo; section</a> of the website. The quality and care you have come to expect from MEΣA will not change.
          </p>
          <p class="mesa-body-text" style="margin: 0 0 18px; color: #3a3a3a; font-size: 15px; line-height: 1.7;">
            As for me, I will still be involved remotely and MEΣΑ will continue to grow while I&rsquo;m away. This is not goodbye, but another step that I&rsquo;m grateful to bring everyone along with me in. I cannot wait and hope to see you all when I return. Please do not ever hesitate to reach out for any questions about anything basketball related, even outside of our program. Thank you from the bottom of my heart for continuing to trust MEΣA.
          </p>
        </td>
      </tr>
      <tr>
        <td class="mesa-outer-bg" style="background: #091530; padding: 20px 24px; text-align: center;">
          <p style="margin: 0 0 6px; color: #fffbeb; font-size: 13px;">
            Questions? Call/text (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com" class="mesa-gold-text" style="color: #d4af37;">artemios@mesabasketballtraining.com</a>
          </p>
          <p class="mesa-muted-text" style="margin: 0; color: #7d8bab; font-size: 11px;">
            With gratitude — Coach Artemios
          </p>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

// Plain ASCII on purpose ("MESA" not "MEΣΑ") — a single non-GSM-7 character
// anywhere in the body forces Twilio to encode the WHOLE message as UCS-2,
// cutting the per-segment length from 153 down to 67 characters and roughly
// tripling the segment (cost) count for a message this length. The branded
// email keeps the real "MEΣΑ" styling; SMS doesn't have that luxury.
const SMS_BODY =
  "MESA: I'm heading to Greece to continue my pro playing career. Thank you for trusting me with your kids these past years - none of this was possible without you. MESA isn't going anywhere: 4 trainers I've hand-picked will keep the same standards while I'm away. Not goodbye! Reply STOP to opt out.";

async function sendOneEmail(resend: Resend, to: string): Promise<void> {
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: SUBJECT,
    html: buildEmailHtml(),
  });
  if (result.error) throw new Error(result.error.message);
}

async function sendOneSms(client: ReturnType<typeof twilio>, phone: string): Promise<void> {
  await client.messages.create({
    body: SMS_BODY,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: formatPhone(phone),
  });
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { mode, channel } = await req.json();
  if (mode !== "test" && mode !== "send") {
    return NextResponse.json({ error: "mode must be \"test\" or \"send\"" }, { status: 400 });
  }
  if (!["email", "sms", "both"].includes(channel)) {
    return NextResponse.json({ error: "channel must be \"email\", \"sms\", or \"both\"" }, { status: 400 });
  }

  const wantsEmail = channel === "email" || channel === "both";
  const wantsSms = channel === "sms" || channel === "both";

  const resendKey = process.env.RESEND_API_KEY;
  if (wantsEmail && !resendKey) {
    return NextResponse.json({ error: "RESEND_API_KEY not configured" }, { status: 500 });
  }
  const resend = resendKey ? new Resend(resendKey) : null;

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (wantsSms && (!twilioSid || !twilioToken || !process.env.TWILIO_PHONE_NUMBER)) {
    return NextResponse.json({ error: "Twilio not configured" }, { status: 500 });
  }
  const smsClient = twilioSid && twilioToken ? twilio(twilioSid, twilioToken) : null;

  const emailResult = { attempted: 0, sent: 0, failed: 0, failedAddresses: [] as string[] };
  const smsResult = { attempted: 0, sent: 0, failed: 0, failedNumbers: [] as string[] };

  if (mode === "test") {
    if (wantsEmail && resend) {
      emailResult.attempted = 1;
      try {
        await sendOneEmail(resend, ARTEMI_EMAIL);
        emailResult.sent = 1;
      } catch (err) {
        console.error("mass-message test email failed:", err);
        emailResult.failed = 1;
        emailResult.failedAddresses.push(ARTEMI_EMAIL);
      }
    }
    if (wantsSms && smsClient) {
      smsResult.attempted = 1;
      try {
        await sendOneSms(smsClient, ARTEMI_PHONE);
        smsResult.sent = 1;
      } catch (err) {
        console.error("mass-message test SMS failed:", err);
        smsResult.failed = 1;
        smsResult.failedNumbers.push(ARTEMI_PHONE);
      }
    }
    return NextResponse.json({ mode, channel, email: emailResult, sms: smsResult });
  }

  // mode === "send" — the real broadcast. Every client who's ever completed
  // a registration (confirmed, cancelled, or no_show — all three mean a
  // real client relationship existed at some point), excluding
  // pending_payment/payment_abandoned rows, which never became a real
  // booking and can carry a typo'd or test email/phone.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: regs, error } = await supabase
    .from("registrations")
    .select("email, phone, sms_consent")
    .in("status", ["confirmed", "cancelled", "no_show"]);
  if (error) {
    return NextResponse.json({ error: `Failed to load client list: ${error.message}` }, { status: 500 });
  }

  const seenEmails = new Set<string>();
  const emails: string[] = [];
  const seenPhones = new Set<string>();
  const phones: string[] = [];
  for (const r of regs || []) {
    const emailKey = (r.email || "").trim().toLowerCase();
    if (emailKey && !seenEmails.has(emailKey)) {
      seenEmails.add(emailKey);
      emails.push(r.email.trim());
    }
    if (r.sms_consent && r.phone) {
      const phoneKey = normalizePhone(r.phone);
      if (phoneKey && !seenPhones.has(phoneKey)) {
        seenPhones.add(phoneKey);
        phones.push(r.phone);
      }
    }
  }

  if (wantsEmail && resend) {
    emailResult.attempted = emails.length;
    for (const email of emails) {
      try {
        await sendOneEmail(resend, email);
        emailResult.sent++;
      } catch (err) {
        console.error("mass-message email failed for", email, err);
        emailResult.failed++;
        emailResult.failedAddresses.push(email);
      }
    }
  }

  if (wantsSms && smsClient) {
    smsResult.attempted = phones.length;
    for (const phone of phones) {
      try {
        await sendOneSms(smsClient, phone);
        smsResult.sent++;
      } catch (err) {
        console.error("mass-message SMS failed for", phone, err);
        smsResult.failed++;
        smsResult.failedNumbers.push(phone);
      }
    }
  }

  return NextResponse.json({ mode, channel, email: emailResult, sms: smsResult });
}
