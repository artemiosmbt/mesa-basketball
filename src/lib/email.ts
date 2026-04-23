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

function calDateStr(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.replace(/-/g, "");
  const parsed = new Date(/\d{4}/.test(d) ? d : `${d}, ${new Date().getFullYear()}`);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}${String(parsed.getMonth() + 1).padStart(2, "0")}${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return "";
}

function calTimeStr(t: string): string {
  const m = t?.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
  if (!m) return "000000";
  let h = parseInt(m[1]);
  const min = parseInt(m[2] || "0");
  const period = (m[3] || "").toLowerCase();
  if (period === "pm" && h !== 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}${String(min).padStart(2, "0")}00`;
}

function buildGoogleCalendarUrl(date: string, startTime: string, endTime: string, location: string, title: string): string {
  const d = calDateStr(date);
  if (!d) return "";
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${d}T${calTimeStr(startTime)}/${d}T${calTimeStr(endTime)}&ctz=America%2FNew_York&location=${encodeURIComponent(location)}&details=${encodeURIComponent("Mesa Basketball Training")}`;
}

function buildICSContent(date: string, startTime: string, endTime: string, location: string, title: string): string {
  const d = calDateStr(date);
  if (!d) return "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mesa Basketball Training//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:mesa-${d}T${calTimeStr(startTime)}@mesabasketballtraining.com`,
    `DTSTART;TZID=America/New_York:${d}T${calTimeStr(startTime)}`,
    `DTEND;TZID=America/New_York:${d}T${calTimeStr(endTime)}`,
    `SUMMARY:${title}`,
    `LOCATION:${location}`,
    "DESCRIPTION:Mesa Basketball Training",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
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
  calendarEvent?: { date: string; startTime: string; endTime: string; location: string; };
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
    : "<p>Payment is due upon registration via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>). Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Rescheduling or canceling within 24 hours of the scheduled session will result in a 50% charge of the session fee. <strong>No-shows without prior notice will be charged the full session fee.</strong></p>";

  const discountedPrice = data.type === "group-private" ? 125 : 75;
  const freeNote = !isPackageBooking && data.isFree && data.isFirstTime
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">First Session Discount Applied — 50% Off! Payment due upon registration: $${discountedPrice} via Cash, Venmo, or Zelle.</p>`
    : !isPackageBooking && data.isFree
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">Referral Credit Applied — 50% Off This Session! Payment due upon registration: $${discountedPrice} via Cash, Venmo, or Zelle.</p>`
    : "";

  const manageSection = `<p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage, cancel, or reschedule your sessions</p>`;

  const calendarButtons = (() => {
    if (!data.calendarEvent) return "";
    const { date, startTime, endTime, location } = data.calendarEvent;
    const loc = LOCATION_MAP[location]?.name || location;
    const title = data.type === "camp" ? "Mesa Basketball Training — Camp" : data.type === "weekly" ? "Mesa Basketball Training — Group Session" : "Mesa Basketball Training — Private Session";
    const googleUrl = buildGoogleCalendarUrl(date, startTime, endTime, loc, title);
    return `<p style="margin-top: 8px;">
      <a href="${googleUrl}" target="_blank" style="display: inline-block; background: #5c3d2e; color: #ffffff; padding: 7px 14px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; margin-right: 8px;">Google Calendar</a>
      <span style="font-size: 12px; color: #8a7060;">or open the .ics attachment for Apple / Outlook</span>
    </p>`;
  })();

  const icsAttachment = (() => {
    if (!data.calendarEvent) return null;
    const { date, startTime, endTime, location } = data.calendarEvent;
    const loc = LOCATION_MAP[location]?.name || location;
    const title = data.type === "camp" ? "Mesa Basketball Training — Camp" : data.type === "weekly" ? "Mesa Basketball Training — Group Session" : "Mesa Basketball Training — Private Session";
    const content = buildICSContent(date, startTime, endTime, loc, title);
    if (!content) return null;
    return { filename: "mesa-basketball.ics", content: Buffer.from(content) };
  })();

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
      ${calendarButtons}
      ${paymentNote}
      ${manageSection}
      ${referralSection}
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
    ...(icsAttachment ? { attachments: [icsAttachment] } : {}),
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
    ? `<p><strong>Note:</strong> This cancellation was made within 24 hours of the session. Per our policy, a 50% cancellation fee ($${lateFee}) is still due. Please pay via Zelle (<strong>artemios@mesabasketballtraining.com</strong>), Cash, or Venmo (<strong>@Artemios-Gavalas</strong>).</p>`
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
      ${data.isLateCancel ? `<p><strong>⚠️ Late cancellation (within 24h) — 50% fee ($${lateFee}) applies</strong></p>` : ""}
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

export async function sendNoShowNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  sessionType?: string;
  feeAmount: number;
}) {
  const resend = getResend();

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `No-Show: ${data.parentName}`,
    html: `
      <h2>No-Show Recorded</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p><strong>Full fee due:</strong> $${data.feeAmount}</p>
    `,
  });

  // Email to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `No-Show — Session Fee Due — Mesa Basketball Training`,
    html: `
      <h2>No-Show on File</h2>
      <p>Hi ${data.parentName},</p>
      <p>You were marked as a <strong>no-show</strong> for the following session:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      <p style="background: #3b1515; color: #fca5a5; padding: 14px; border-radius: 8px; margin: 12px 0;">
        Per our policy, <strong>no-shows without prior notice are charged the full session fee</strong>.<br/>
        <strong>Amount due: $${data.feeAmount}</strong>
      </p>
      <p>Please send payment via:</p>
      <ul>
        <li><strong>Zelle:</strong> artemios@mesabasketballtraining.com</li>
        <li><strong>Venmo:</strong> @Artemios-Gavalas</li>
        <li><strong>Cash</strong> at your next session</li>
      </ul>
      <p>If you believe this was marked in error, please reply to this email or contact Artemios directly.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
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
      <p>Cancellations and reschedules within 24 hours of a scheduled session incur a <strong>$75 fee</strong> (50% of the standard $150 private rate). <strong>No-shows without prior notice will be charged the full session fee.</strong></p>
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
  isLateReschedule?: boolean;
  lateFeeAmount?: number;
}) {
  const resend = getResend();

  const lateFeeNote = data.isLateReschedule
    ? `<p style="color: #f59e0b;"><strong>Late Reschedule:</strong> This was rescheduled within 24 hours. 50% of the session fee is due${data.lateFeeAmount ? ` ($${data.lateFeeAmount})` : ""}.</p>`
    : "";

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Reschedule${data.isLateReschedule ? " ⚠️ LATE" : ""}: ${data.parentName}`,
    html: `
      <h2>Session Rescheduled</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
      ${lateFeeNote}
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
      ${data.isLateReschedule ? `<p style="color: #f59e0b;">This reschedule was made within 24 hours of the session. Per our policy, 50% of the session fee is still due${data.lateFeeAmount ? ` ($${data.lateFeeAmount})` : ""}.</p>` : ""}
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage all your sessions</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
