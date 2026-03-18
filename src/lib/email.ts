import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";

export async function sendRegistrationNotification(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
}) {
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
      <p><strong>Payment:</strong> Cash, Venmo, or Zelle accepted at the session.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or reply to this email.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
