import { Resend } from "resend";

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";

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
}) {
  const resend = getResend();

  const typeLabel =
    data.type === "camp"
      ? "Camp Registration"
      : data.type === "private"
        ? "Private Session Booking"
        : "Group Private Session Booking";

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
      <p><strong>Payment:</strong></p>
      <ul>
        <li>Venmo: <strong>@Artemios-Gavalas</strong></li>
        <li>Zelle: <strong>artemios@mesabasketballtraining.com</strong></li>
        <li>Cash accepted at the session</li>
      </ul>
      <p><strong>Cancellation Policy:</strong> Please provide at least 24 hours' notice for any cancellation. If a session is canceled with less than 24 hours' notice, 50% of the session fee will still be due.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
