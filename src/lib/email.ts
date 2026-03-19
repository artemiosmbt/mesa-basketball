import { Resend } from "resend";

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://mesa-basketball-h8lk.vercel.app";

const LOCATION_MAP: Record<string, { name: string; url: string }> = {
  "St. Pauls": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "St. Paul's": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "St. Paul's Cathedral": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "Cherry Valley": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
  "Cherry Valley Sports": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
};

function formatSessionDetailsForEmail(details: string): string {
  let result = details;
  for (const [key, { name, url }] of Object.entries(LOCATION_MAP)) {
    if (result.includes(key)) {
      result = result.replace(key, `<a href="${url}" style="color: #c4833e;">${name}</a>`);
      break;
    }
  }
  return result;
}

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured");
  return new Resend(key);
}

export async function sendRegistrationNotification(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  manageToken?: string;
  isFree?: boolean;
  referralCode?: string;
}) {
  const resend = getResend();

  const typeLabel =
    data.type === "camp"
      ? "Camp Registration"
      : data.type === "private"
        ? "Private Session Booking"
        : "Group Private Session Booking";

  const manageLink = data.manageToken
    ? `${BASE_URL}/booking/${data.manageToken}`
    : null;

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `New ${typeLabel}: ${data.parentName}${data.isFree ? " [FREE - LOYALTY REWARD]" : ""}`,
    html: `
      <h2>New ${typeLabel}</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <p><strong>Kids:</strong> ${data.kids}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p><strong>Total Participants:</strong> ${data.totalParticipants}</p>
      ${data.isFree ? '<p><strong style="color: green;">LOYALTY REWARD: This session is FREE</strong></p>' : ""}
    `,
  });

  // Confirmation email to parent
  const priceNote = data.isFree
    ? ""
    : data.type === "private"
      ? "<p><strong>Rate:</strong> $150 (up to 3 participants)</p>"
      : data.type === "group-private"
        ? "<p><strong>Rate:</strong> $250 (4+ participants)</p>"
        : "";

  const paymentNote = data.isFree
    ? ""
    : "<p>Payments can be made via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>). Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Cancellations made within 24 hours of the scheduled session will result in a 50% charge of the session fee.</p>";

  const freeNote = data.isFree
    ? '<p style="background: #166534; color: #4ade80; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">This session is FREE — thank you for your loyalty!</p>'
    : "";

  const manageSection = manageLink
    ? `<p><a href="${manageLink}" style="color: #c4833e; font-weight: bold;">Manage Booking</a> — Cancel or reschedule your session</p>`
    : "";

  const referralSection = data.referralCode
    ? `<p style="background: #1e293b; padding: 12px; border-radius: 8px; margin-top: 12px;"><strong>Your referral code: ${data.referralCode}</strong><br/><span style="font-size: 13px; color: #94a3b8;">Share it with friends — when they book their first session, you both earn credit toward a free session.</span></p>`
    : "";

  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: data.isFree
      ? `FREE Session Confirmed — Mesa Basketball Training`
      : `Booking Confirmed — Mesa Basketball Training`,
    html: `
      <h2>You're booked!</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your ${typeLabel.toLowerCase()} has been confirmed.</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p><strong>Kids:</strong> ${data.kids}</p>
      ${freeNote}
      ${priceNote}
      ${paymentNote}
      ${manageSection}
      ${referralSection}
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

export async function sendCancellationNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  isLateCancel: boolean;
}) {
  const resend = getResend();

  const lateNote = data.isLateCancel
    ? "<p><strong>Note:</strong> This cancellation was made within 24 hours of the session. Per our policy, 50% of the session fee is still due.</p>"
    : "";

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Cancellation: ${data.parentName}`,
    html: `
      <h2>Session Cancelled</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${data.isLateCancel ? "<p><strong>⚠️ Late cancellation — 50% fee applies</strong></p>" : ""}
    `,
  });

  // Confirmation to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Session Cancelled — Mesa Basketball Training`,
    html: `
      <h2>Session Cancelled</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your session has been cancelled:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${lateNote}
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

export async function sendRescheduleNotification(data: {
  parentName: string;
  email: string;
  oldSessionDetails: string;
  newSessionDetails: string;
  manageToken: string;
}) {
  const resend = getResend();
  const manageLink = `${BASE_URL}/booking/${data.manageToken}`;

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Reschedule: ${data.parentName}`,
    html: `
      <h2>Session Rescheduled</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
    `,
  });

  // Confirmation to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Session Rescheduled — Mesa Basketball Training`,
    html: `
      <h2>Session Rescheduled</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your session has been rescheduled.</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
      <p><a href="${manageLink}" style="color: #c4833e; font-weight: bold;">Manage Booking</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
