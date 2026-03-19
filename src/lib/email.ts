import { Resend } from "resend";

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://mesa-basketball-h8lk.vercel.app";

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
    subject: `New ${typeLabel}: ${data.parentName}`,
    html: `
      <h2>New ${typeLabel}</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <p><strong>Kids:</strong> ${data.kids}</p>
      <p><strong>Session:</strong> ${data.sessionDetails}</p>
      <p><strong>Total Participants:</strong> ${data.totalParticipants}</p>
    `,
  });

  // Confirmation email to parent
  const priceNote =
    data.type === "private"
      ? "<p><strong>Rate:</strong> $150 (up to 3 participants)</p>"
      : data.type === "group-private"
        ? "<p><strong>Rate:</strong> $250 (4+ participants)</p>"
        : "";

  const manageSection = manageLink
    ? `<p><a href="${manageLink}" style="color: #c4833e; font-weight: bold;">Manage Booking</a> — Cancel or reschedule your session</p>`
    : "";

  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Booking Confirmed — Mesa Basketball Training`,
    html: `
      <h2>You're booked!</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your ${typeLabel.toLowerCase()} has been confirmed.</p>
      <p><strong>Session:</strong> ${data.sessionDetails}</p>
      <p><strong>Kids:</strong> ${data.kids}</p>
      ${priceNote}
      <p>Payments can be made via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>). Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Cancellations made within 24 hours of the scheduled session will result in a 50% charge of the session fee.</p>
      ${manageSection}
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
      <p><strong>Session:</strong> ${data.sessionDetails}</p>
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
      <p><strong>Session:</strong> ${data.sessionDetails}</p>
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
      <p><strong>Old Session:</strong> ${data.oldSessionDetails}</p>
      <p><strong>New Session:</strong> ${data.newSessionDetails}</p>
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
      <p><strong>Old Session:</strong> ${data.oldSessionDetails}</p>
      <p><strong>New Session:</strong> ${data.newSessionDetails}</p>
      <p><a href="${manageLink}" style="color: #c4833e; font-weight: bold;">Manage Booking</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
