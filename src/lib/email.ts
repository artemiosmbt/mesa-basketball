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
      result = result.replace(key, `<a href="${url}" style="color: #d4af37;">${name}</a>`);
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
  isFirstTime?: boolean;
  packageSessionsRemaining?: number;
  packageType?: number;
  referralCode?: string;
  referredBy?: string;
}) {
  const resend = getResend();

  const isPackageBooking = data.packageSessionsRemaining !== undefined;

  const typeLabel =
    data.type === "camp"
      ? "Camp Registration"
      : data.type === "weekly"
        ? "Group Session Registration"
        : data.type === "private"
          ? "Private Session Booking"
          : "Group Private Session Booking";

  const manageLink = data.manageToken
    ? `${BASE_URL}/booking/${data.manageToken}`
    : null;

  // Email to Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `New ${typeLabel}: ${data.parentName}${isPackageBooking ? " [Monthly Package]" : ""}${data.isFree && !isPackageBooking ? " [50% OFF]" : ""}`,
    html: `
      <h2>New ${typeLabel}</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <p><strong>Players:</strong> ${data.kids}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p><strong>Total Participants:</strong> ${data.totalParticipants}</p>
      ${isPackageBooking ? `<p><strong>Package:</strong> ${data.packageType}-session monthly plan — ${data.packageSessionsRemaining} session${data.packageSessionsRemaining !== 1 ? "s" : ""} remaining after this booking</p>` : ""}
      ${data.isFree && !isPackageBooking ? `<p><strong style="color: #d4af37;">${data.isFirstTime ? "First-Time Discount" : "Referral Credit"}: 50% off applied</strong></p>` : ""}
      ${data.referredBy ? `<p><strong>Referred by:</strong> ${data.referredBy}</p>` : ""}
    `,
  });
  if (adminResult.error) console.error("Resend admin email error:", adminResult.error);

  // Confirmation email to parent
  const packageNote = isPackageBooking
    ? `<p style="background: #162d5a; color: #d4af37; padding: 14px; border-radius: 8px; margin: 12px 0;">
        <strong>This session is part of your ${data.packageType}-session monthly training package.</strong><br/>
        <span style="font-size: 14px; opacity: 0.85;">You have <strong>${data.packageSessionsRemaining} session${data.packageSessionsRemaining !== 1 ? "s" : ""} remaining</strong> in your plan this month. Payment for your package was already arranged at enrollment — no additional payment is due for this session.</span>
       </p>`
    : "";

  const priceNote = isPackageBooking || data.isFree
    ? ""
    : data.type === "private"
      ? "<p><strong>Rate:</strong> $150 (up to 3 participants)</p>"
      : data.type === "group-private"
        ? "<p><strong>Rate:</strong> $250 (4+ participants)</p>"
        : "";

  const paymentNote = isPackageBooking || data.isFree
    ? ""
    : "<p>Payment is due upon registration via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>). Please provide at least 48 hours' notice if you need to cancel or reschedule a session. Rescheduling or canceling within 48 hours of the scheduled session will result in a 50% charge of the session fee.</p>";

  const freeNote = !isPackageBooking && data.isFree && data.isFirstTime
    ? '<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">First Session Discount Applied — 50% Off! Payment due upon registration: $75 (private) or $125 (group private) via Cash, Venmo, or Zelle.</p>'
    : !isPackageBooking && data.isFree
    ? '<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">Referral Credit Applied — 50% Off This Session! Payment due upon registration: $75 (private) or $125 (group private) via Cash, Venmo, or Zelle.</p>'
    : "";

  const manageSection = `<p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage, cancel, or reschedule your sessions</p>`;

  const referralSection = data.referralCode
    ? `<p style="background: #162d5a; padding: 12px; border-radius: 8px; margin-top: 12px; color: #ffffff;"><strong style="color: #d4af37;">Your referral code: ${data.referralCode}</strong><br/><span style="font-size: 13px; color: #93c5fd;">Share this code with friends and family — when they book their first session using your code, you'll receive 50% off a private session.</span></p>`
    : "";

  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: data.isFree
      ? `Booking Confirmed — Mesa Basketball Training`
      : `Booking Confirmed — Mesa Basketball Training`,
    html: `
      <h2>You're booked!</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your ${typeLabel.toLowerCase()} has been confirmed.</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p><strong>Players:</strong> ${data.kids}</p>
      ${packageNote}
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
  if (clientResult.error) console.error("Resend client email error:", clientResult.error, "to:", data.email);
}

export async function sendReferralCreditNotification(data: {
  referrerName: string;
  referrerEmail: string;
  newClientName: string;
}) {
  const resend = getResend();
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.referrerEmail,
    replyTo: ARTEMI_EMAIL,
    subject: `You earned a 50% off private session — Mesa Basketball Training`,
    html: `
      <h2>You earned a reward!</h2>
      <p>Hi ${data.referrerName},</p>
      <p>Great news — <strong>${data.newClientName}</strong> just booked their first session using your referral code. As a thank you, you've earned <strong>50% off your next private session</strong>.</p>
      <p>Your discount will be applied automatically the next time you book a private session.</p>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — check your referral credits anytime.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

export async function sendCancellationNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  sessionType?: string;
  isLateCancel: boolean;
  lateFeeAmount?: number;
}) {
  const resend = getResend();

  const lateFee = data.lateFeeAmount !== undefined
    ? data.lateFeeAmount
    : data.sessionType === "group-private" ? 125 : data.sessionType === "weekly" ? 25 : 75;
  const lateNote = data.isLateCancel
    ? `<p><strong>Note:</strong> This cancellation was made within 48 hours of the session. Per our policy, a 50% cancellation fee ($${lateFee}) is still due. Please pay via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>).</p>`
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
      ${data.isLateCancel ? `<p><strong>⚠️ Late cancellation — 50% fee ($${lateFee}) applies</strong></p>` : ""}
    `,
  });

  // Confirmation to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `Session Cancelled — Mesa Basketball Training`,
    html: `
      <h2>Session Cancelled</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your session has been cancelled:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${lateNote}
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

function formatMonthYear(monthYear: string): string {
  const [year, month] = monthYear.split("-");
  const d = new Date(parseInt(year), parseInt(month) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function lastDayOfMonth(monthYear: string): string {
  const [year, month] = monthYear.split("-");
  const d = new Date(parseInt(year), parseInt(month), 0);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export async function sendPackageConfirmation(data: {
  parentName: string;
  email: string;
  phone: string;
  packageType: number;
  monthYear: string;
  totalPrice: number;
  kids?: string;
  referralCode?: string;
}) {
  const resend = getResend();
  const monthLabel = formatMonthYear(data.monthYear);
  const expiry = lastDayOfMonth(data.monthYear);

  // Notify Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `New Package Enrollment: ${data.parentName} — ${data.packageType} sessions (${monthLabel})`,
    html: `
      <h2>New Monthly Package Enrollment</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Email:</strong> ${data.email}</p>
      <p><strong>Phone:</strong> ${data.phone}</p>
      <p><strong>Package:</strong> ${data.packageType} sessions / month</p>
      <p><strong>Month:</strong> ${monthLabel}</p>
      <p><strong>Total:</strong> $${data.totalPrice}</p>
      ${data.kids ? `<p><strong>Player(s):</strong> ${data.kids}</p>` : ""}
      ${data.referralCode ? `<p><strong>Referral Code:</strong> ${data.referralCode}</p>` : ""}
    `,
  });

  // Confirmation to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Package Confirmed — Mesa Basketball Training (${monthLabel})`,
    html: `
      <h2>You're enrolled!</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your <strong>${data.packageType}-session private training package</strong> for <strong>${monthLabel}</strong> is confirmed.</p>
      <h3>Package Details</h3>
      <ul>
        <li><strong>Sessions:</strong> ${data.packageType} private sessions</li>
        <li><strong>Total Price:</strong> $${data.totalPrice}</li>
        <li><strong>Month:</strong> ${monthLabel}</li>
        <li><strong>Sessions expire:</strong> ${expiry} — unused sessions do not carry over</li>
      </ul>
      <h3>Payment</h3>
      <p>Payment is due upon registration: <strong>Cash, Venmo (@Artemios-Gavalas), or Zelle (artemios@mesabasketballtraining.com)</strong>.</p>
      <h3>Cancellation &amp; Rescheduling Policy</h3>
      <p>Cancellations and reschedules within 48 hours of a scheduled session incur a <strong>$75 fee</strong> (50% of the standard $150 private rate).</p>
      <h3>Track Your Sessions</h3>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — check how many sessions you've used this month.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

export async function sendPackageReminder(data: {
  parentName: string;
  email: string;
  packageType: number;
  sessionsUsed: number;
  monthYear: string;
}) {
  const resend = getResend();
  const sessionsRemaining = data.packageType - data.sessionsUsed;
  const monthLabel = formatMonthYear(data.monthYear);

  // Reminder to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Your Mesa Basketball sessions are expiring soon!`,
    html: `
      <h2>Don't let your sessions go to waste!</h2>
      <p>Hey ${data.parentName},</p>
      <p>Just a heads up — your <strong>${monthLabel}</strong> package has <strong>${sessionsRemaining} session${sessionsRemaining !== 1 ? "s" : ""} remaining</strong> and the month ends in 3 days.</p>
      <p>Don't let them go to waste! Book now and make the most of your training time.</p>
      <p><a href="${BASE_URL}/#private" style="color: #d4af37; font-weight: bold; font-size: 16px;">Book Your Remaining Sessions &rarr;</a></p>
      <br/>
      <p>Keep working hard — every session counts!</p>
      <p>Questions? Reach out to Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });

  // Notify Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Package Reminder Sent: ${data.parentName} — ${sessionsRemaining} session(s) remaining`,
    html: `
      <p><strong>Parent:</strong> ${data.parentName} (${data.email})</p>
      <p><strong>Month:</strong> ${monthLabel}</p>
      <p><strong>Sessions Used:</strong> ${data.sessionsUsed} / ${data.packageType}</p>
      <p><strong>Remaining:</strong> ${sessionsRemaining}</p>
      <p>A reminder email has been sent to the parent.</p>
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
    replyTo: ARTEMI_EMAIL,
    subject: `Session Rescheduled — Mesa Basketball Training`,
    html: `
      <h2>Session Rescheduled</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your session has been rescheduled.</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage all your sessions</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
