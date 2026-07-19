import { Resend } from "resend";

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://mesa-basketball-h8lk.vercel.app";

const VENMO_LINK = `<a href="https://venmo.com/u/Artemios-Gavalas" target="_blank" style="color: #008CFF; font-weight: bold;">@Artemios-Gavalas</a>`;
const PAYMENT_OPTIONS = `Zelle (artemios@mesabasketballtraining.com), Venmo (${VENMO_LINK}), or Cash`;
const PAYMENT_LINES = `<p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; line-height: 1.8;">
  Zelle: artemios@mesabasketballtraining.com<br/>
  Venmo: ${VENMO_LINK}<br/>
  Cash
</p>`;

const LOCATION_MAP: Record<string, { name: string; url: string }> = {
  "St. Pauls": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "St. Paul's": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "St. Paul's Cathedral": { name: "St. Paul's Cathedral", url: "https://share.google/kVGkfSgr6SaShDWF7" },
  "Cherry Valley": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
  "Cherry Valley Sports": { name: "Cherry Valley Sports", url: "https://share.google/YKRoCTFuLP33bpSUZ" },
  "Holy Resurrection": { name: "Holy Resurrection Brookville", url: "https://www.google.com/search?q=holy+resurrection+brookville" },
  "Holy Resurrection Brookville": { name: "Holy Resurrection Brookville", url: "https://www.google.com/search?q=holy+resurrection+brookville" },
};

function formatSessionDetailsForEmail(details: string): string {
  let result = details;
  for (const [key, { name, url }] of Object.entries(LOCATION_MAP)) {
    if (result.includes(key)) {
      result = result.replaceAll(key, `<a href="${url}" style="color: #d4af37;">${name}</a>`);
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
  referralCodeUsed?: string;
  trainer?: string;
  calendarEvent?: { date: string; startTime: string; endTime: string; location: string; };
  accountCreditApplied?: number;
  fullPrice?: number;
}) {
  const resend = getResend();

  const isPackageBooking = data.packageSessionsRemaining !== undefined;

  const isPickup = data.type === "weekly" && data.sessionDetails.toLowerCase().includes("pickup");
  const typeLabel =
    data.type === "camp"
      ? "Camp Registration"
      : isPickup
        ? "Pickup Session Registration"
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
      ${data.trainer ? `<p><strong>Trainer:</strong> ${data.trainer}</p>` : ""}
      <p><strong>Total Participants:</strong> ${data.totalParticipants}</p>
      ${isPackageBooking ? `<p><strong>Package:</strong> ${data.packageType}-session monthly plan — ${data.packageSessionsRemaining} session${data.packageSessionsRemaining !== 1 ? "s" : ""} remaining after this booking</p>` : ""}
      ${data.isFree && !isPackageBooking ? `<p><strong style="color: #d4af37;">${data.isFirstTime ? "First-Time Discount" : "Referral Credit"}: 50% off applied</strong></p>` : ""}
      ${data.accountCreditApplied && data.accountCreditApplied > 0 ? `<p><strong style="color: #93c5fd;">Account credit applied: $${data.accountCreditApplied}</strong></p>` : ""}
      ${data.referredBy ? `<p><strong>Referred by:</strong> ${data.referredBy}</p>` : ""}
      ${data.referralCodeUsed ? `<p><strong>Referral code used:</strong> ${data.referralCodeUsed}</p>` : ""}
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
    : `<p>Payment is due upon registration via ${PAYMENT_OPTIONS}. Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Rescheduling or canceling within 24 hours of the scheduled session will result in a 50% charge of the session fee. <strong>No-shows without prior notice will be charged the full session fee.</strong></p>`;

  const discountedPrice = data.type === "group-private" ? 125 : 75;
  const freeNote = !isPackageBooking && data.isFree && data.isFirstTime
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">First Session Discount Applied — 50% Off! Payment due upon registration: $${discountedPrice} via Cash, Venmo, or Zelle.</p>`
    : !isPackageBooking && data.isFree
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">Referral Credit Applied — 50% Off This Session! Payment due upon registration: $${discountedPrice} via Cash, Venmo, or Zelle.</p>`
    : "";

  const accountCreditNote = data.accountCreditApplied && data.accountCreditApplied > 0 && data.fullPrice != null
    ? `<p style="background: #1e3a5f; color: #93c5fd; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">$${data.accountCreditApplied} account credit applied — Due: $${data.fullPrice - data.accountCreditApplied}</p>`
    : "";

  const manageSection = `<p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage, cancel, or reschedule your sessions</p>`;

  const calendarButtons = (() => {
    if (!data.calendarEvent) return "";
    const { date, startTime, endTime, location } = data.calendarEvent;
    const loc = LOCATION_MAP[location]?.name || location;
    const title = data.type === "camp" ? "Mesa Basketball Training — Camp" : isPickup ? "Mesa Basketball Training — Pickup Session" : data.type === "weekly" ? "Mesa Basketball Training — Group Session" : "Mesa Basketball Training — Private Session";
    const googleUrl = buildGoogleCalendarUrl(date, startTime, endTime, loc, title);
    const params = new URLSearchParams({ date, start: startTime, end: endTime, location: loc, title });
    const icsUrl = `${BASE_URL}/api/ics?${params.toString()}`;
    return `<p style="margin-top: 8px;">
      <a href="${googleUrl}" target="_blank" style="display: inline-block; background: #1a73e8; color: #ffffff; padding: 7px 14px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; margin-right: 8px;">Add to Google Calendar</a>
      <a href="${icsUrl}" style="display: inline-block; background: #3a3a3a; color: #ffffff; padding: 7px 14px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold;">Add to Apple Calendar</a>
    </p>`;
  })();

  const icsAttachment = (() => {
    if (!data.calendarEvent) return null;
    const { date, startTime, endTime, location } = data.calendarEvent;
    const loc = LOCATION_MAP[location]?.name || location;
    const icsTitle = data.type === "camp" ? "Mesa Basketball Training — Camp" : isPickup ? "Mesa Basketball Training — Pickup Session" : data.type === "weekly" ? "Mesa Basketball Training — Group Session" : "Mesa Basketball Training — Private Session";
    const content = buildICSContent(date, startTime, endTime, loc, icsTitle);
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
      ${data.trainer ? `<p><strong>Trainer:</strong> ${data.trainer}</p>` : ""}
      <p><strong>Players:</strong> ${data.kids}</p>
      ${packageNote}
      ${freeNote}
      ${accountCreditNote}
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

interface StripeRefundOutcome {
  refundedAmount: number;
  creditedAmount: number;
  failed: boolean;
}

export async function sendCancellationNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  sessionType?: string;
  isLateCancel: boolean;
  lateFeeAmount?: number;
  campAdjustment?: { finalAmount: number; originalAmount: number; isPaid: boolean; creditGranted: number; stripeRefundResult?: StripeRefundOutcome };
  // Late cancellation: 50% credited to account. No Stripe call is ever
  // attempted for this case, so there's nothing to "fail" — it's a plain credit.
  cancelCredit?: number;
  // On-time cancellation of a Stripe-paid booking: the actual outcome of
  // trying to refund it — may be split across a real card refund and account
  // credit (see issueStripeRefund's amount_too_large fallback), or failed
  // entirely (nothing moved yet; admin alerted to complete it manually).
  stripeRefundResult?: StripeRefundOutcome;
}) {
  const resend = getResend();
  const isPickupCancel = data.sessionDetails.toLowerCase().includes("pickup");

  const somethingWasAttempted = data.cancelCredit !== undefined || !!data.stripeRefundResult;
  const lateFee = data.lateFeeAmount !== undefined
    ? data.lateFeeAmount
    : data.sessionType === "group-private" ? 125 : data.sessionType === "weekly" ? 25 : 75;
  const lateNote = data.isLateCancel && !data.campAdjustment && !somethingWasAttempted
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Fee</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This cancellation was made within 24 hours of the session. Per our policy, a <strong>50% fee of $${lateFee}</strong> is still due.</p>
        ${PAYMENT_LINES}
      </div>`
    : "";

  // Renders whatever actually happened to the money — a plain credit, a full
  // refund, a split refund+credit, or (if the Stripe call failed outright) a
  // pending note that doesn't claim money moved before it actually did.
  function moneyOutcomeHtml(refundResult: StripeRefundOutcome | undefined, plainCredit: number | undefined, lateCreditNote: string): string {
    if (refundResult) {
      if (refundResult.failed) {
        return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
          <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Refund In Progress</p>
          <p style="margin: 0; color: #ffffff; font-size: 14px;">Your refund is being processed — you'll receive a separate confirmation once it's complete.</p>
        </div>`;
      }
      const parts: string[] = [];
      if (refundResult.refundedAmount > 0) parts.push(`<strong>$${refundResult.refundedAmount}</strong> has been refunded to your original payment method`);
      if (refundResult.creditedAmount > 0) parts.push(`<strong>$${refundResult.creditedAmount}</strong> has been credited to your account`);
      if (parts.length === 0) return "";
      return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">${refundResult.refundedAmount > 0 ? "Refund Issued" : "Account Credit"}</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">${parts.join(", ")}.</p>
      </div>`;
    }
    if (plainCredit !== undefined && plainCredit > 0) {
      return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Account Credit</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;"><strong>$${plainCredit}</strong> has been credited to your account for a future booking${lateCreditNote}.</p>
      </div>`;
    }
    return "";
  }

  const creditNote = !data.campAdjustment
    ? moneyOutcomeHtml(data.stripeRefundResult, data.cancelCredit, data.isLateCancel ? " (50% of what you paid — this was a late cancellation, so the other half isn't refunded per our policy)" : "")
    : "";

  // Camp day partial-cancel: recomputed total + credit/due, worded off the isPaid flag
  // rather than assuming payment happened (not every family pays at registration).
  // Money already paid beyond the new total goes back as a real Stripe refund when
  // that day's charge went through Stripe, account credit for the old manual/cash path.
  const campMoneyHtml = data.campAdjustment?.isPaid
    ? moneyOutcomeHtml(data.campAdjustment.stripeRefundResult, data.campAdjustment.creditGranted > 0 ? data.campAdjustment.creditGranted : undefined, "")
    : "";
  const campAdjustmentLine = data.campAdjustment && !data.campAdjustment.isPaid
    ? `<strong>$${data.campAdjustment.finalAmount}</strong> is due.`
    : "";
  const campAdjustmentNote = data.campAdjustment
    ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Updated Camp Total</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">New total: <strong>$${data.campAdjustment.finalAmount}</strong> (was $${data.campAdjustment.originalAmount}). ${campAdjustmentLine}</p>
        ${!data.campAdjustment.isPaid ? PAYMENT_LINES : ""}
      </div>${campMoneyHtml}`
    : "";

  // Plain-text summary of what happened to the money, for the admin email only.
  function adminMoneySummary(refundResult: StripeRefundOutcome | undefined, plainCredit: number | undefined): string {
    if (refundResult) {
      if (refundResult.failed) return "refund FAILED — needs manual action";
      const parts: string[] = [];
      if (refundResult.refundedAmount > 0) parts.push(`$${refundResult.refundedAmount} refunded to their card`);
      if (refundResult.creditedAmount > 0) parts.push(`$${refundResult.creditedAmount} credited to their account`);
      return parts.join(", ");
    }
    return plainCredit !== undefined && plainCredit > 0 ? `$${plainCredit} credited to their account` : "";
  }
  const adminCancelSummary = adminMoneySummary(data.stripeRefundResult, data.cancelCredit);
  const adminCampSummary = data.campAdjustment?.isPaid
    ? adminMoneySummary(data.campAdjustment.stripeRefundResult, data.campAdjustment.creditGranted)
    : "";

  // Email to Artemi
  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `${isPickupCancel ? "Pickup " : ""}Cancellation: ${data.parentName}`,
    html: `
      <h2>${isPickupCancel ? "Pickup " : ""}Session Cancelled</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${data.isLateCancel && !data.campAdjustment && !somethingWasAttempted ? `<p><strong>⚠️ Late cancellation (within 24h) — 50% fee ($${lateFee}) applies</strong></p>` : ""}
      ${!data.campAdjustment && adminCancelSummary ? `<p><strong>${adminCancelSummary}</strong>${data.isLateCancel ? " (late cancellation — 50% of what they paid)" : ""}</p>` : ""}
      ${data.campAdjustment ? `<p><strong>New total: $${data.campAdjustment.finalAmount} (was $${data.campAdjustment.originalAmount}).</strong> ${data.campAdjustment.isPaid ? adminCampSummary : `Due: $${data.campAdjustment.finalAmount}`}</p>` : ""}
    `,
  });

  // Confirmation to parent
  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `${isPickupCancel ? "Pickup " : ""}Session Cancelled — Mesa Basketball Training`,
    html: `
      <h2>${isPickupCancel ? "Pickup " : ""}Session Cancelled</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your ${isPickupCancel ? "pickup " : ""}session has been cancelled:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${lateNote}
      ${creditNote}
      ${campAdjustmentNote}
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
      <p>Please send payment via ${PAYMENT_OPTIONS}.</p>
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
      <p>Payment is due upon registration: ${PAYMENT_OPTIONS}.</p>
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

export async function sendPlayerUpdateNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  removedPlayers: string[];
  addedPlayers: string[];
  newKids: string;
  sessionType: string;
  isLate: boolean;
  lateFeeDue?: number;
  oldPrice: number | null;
  newPrice: number | null;
  priceChanged: boolean;
}) {
  const resend = getResend();

  const removedList = data.removedPlayers.length > 0
    ? `<p><strong>Removed:</strong> ${data.removedPlayers.join(", ")}</p>` : "";
  const addedList = data.addedPlayers.length > 0
    ? `<p><strong>Added:</strong> ${data.addedPlayers.join(", ")}</p>` : "";

  const lateBlock = data.isLate && data.removedPlayers.length > 0
    ? `<div style="background:#7c1d1d;border-left:4px solid #ef4444;border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="margin:0 0 6px 0;font-size:15px;font-weight:bold;color:#fff;">⚠️ Late Removal — Fee Applies</p>
        <p style="margin:0;color:#fff;font-size:14px;">This player was removed within 24 hours of the session. Per our policy${data.lateFeeDue ? `, a fee of <strong>$${data.lateFeeDue}</strong> is still due` : ", a late cancellation fee still applies"}.</p>
        ${PAYMENT_LINES}
      </div>`
    : "";

  const priceBlock = data.priceChanged && data.newPrice !== null
    ? `<p style="background:#162d5a;padding:12px;border-radius:8px;color:#fff;">
        <strong style="color:#d4af37;">Updated Session Rate: $${data.newPrice}</strong>
        ${data.isLate && (data.sessionType === "private" || data.sessionType === "group-private")
          ? `<br/><span style="font-size:13px;opacity:0.85;">Because this change was made within 24 hours, only half the price difference was applied.</span>`
          : ""}
      </p>`
    : "";

  await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Player Update${data.isLate && data.removedPlayers.length > 0 ? " ⚠️ LATE" : ""}: ${data.parentName}`,
    html: `
      <h2>Player List Updated</h2>
      <p><strong>Parent:</strong> ${data.parentName}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${removedList}${addedList}
      <p><strong>Current Players:</strong> ${data.newKids}</p>
      ${data.priceChanged ? `<p><strong>Price:</strong> $${data.oldPrice ?? "—"} → $${data.newPrice ?? "—"}</p>` : ""}
      ${data.isLate && data.removedPlayers.length > 0 ? `<p style="color:#ef4444;"><strong>⚠️ Late removal${data.lateFeeDue ? ` — $${data.lateFeeDue} fee due` : ""}</strong></p>` : ""}
    `,
  });

  await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `Player List Updated — Mesa Basketball Training`,
    html: `
      <h2>Player List Updated</h2>
      <p>Hi ${data.parentName},</p>
      <p>Your player list for the following session has been updated:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${removedList}${addedList}
      <p><strong>Current Players:</strong> ${data.newKids}</p>
      ${priceBlock}
      ${lateBlock}
      <p><a href="${BASE_URL}/my-bookings" style="color:#d4af37;font-weight:bold;">View My Bookings</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}

export async function sendTimeChangeNotification(data: {
  parentName: string;
  email: string;
  kids: string;
  date: string;
  sessionLabel: string;
  oldStartTime: string;
  oldEndTime: string;
  newStartTime: string;
  newEndTime: string;
  location: string;
  changeType?: "time" | "location" | "both";
  oldLocation?: string;
}) {
  const resend = getResend();
  const changeType = data.changeType ?? "time";

  const dateObj = new Date(data.date);
  const formattedDate = isNaN(dateObj.getTime())
    ? data.date
    : dateObj.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
        timeZone: "UTC",
      });

  const locEntry = LOCATION_MAP[data.location];
  const newLocDisplay = locEntry
    ? `<a href="${locEntry.url}" style="color: #d4af37;">${locEntry.name}</a>`
    : data.location;
  const oldLocEntry = data.oldLocation ? LOCATION_MAP[data.oldLocation] : undefined;
  const oldLocText = oldLocEntry ? oldLocEntry.name : (data.oldLocation ?? data.location);

  const subjectLabel =
    changeType === "both" ? "Session Schedule Update" :
    changeType === "location" ? "Session Location Update" :
    "Session Time Update";

  const descText =
    changeType === "both" ? "Your upcoming group session time and location have changed." :
    changeType === "location" ? "Your upcoming group session location has changed. The time stays the same." :
    "Your upcoming group session time has changed. Everything else stays the same.";

  const td = (bg: string, label: string, value: string, extraStyle = "") =>
    `<tr><td style="padding:10px 14px;background:${bg};color:#9ca3af;font-size:13px;width:110px;">${label}</td><td style="padding:10px 14px;background:${bg};color:#ffffff;${extraStyle}">${value}</td></tr>`;

  const rows: string[] = [
    td("#1e1e1e", "Date", `<strong>${formattedDate}</strong>`),
    td("#161616", "Session", data.sessionLabel),
  ];

  if (changeType !== "location") {
    rows.push(`<tr><td style="padding:10px 14px;background:#1e1e1e;color:#9ca3af;font-size:13px;width:110px;">Old Time</td><td style="padding:10px 14px;background:#1e1e1e;color:#f87171;text-decoration:line-through;">${data.oldStartTime}–${data.oldEndTime}</td></tr>`);
    rows.push(`<tr><td style="padding:10px 14px;background:#161616;color:#9ca3af;font-size:13px;">New Time</td><td style="padding:10px 14px;background:#161616;color:#4ade80;font-weight:bold;font-size:15px;">${data.newStartTime}–${data.newEndTime}</td></tr>`);
  } else {
    rows.push(td("#1e1e1e", "Time", `${data.newStartTime}–${data.newEndTime}`));
  }

  if (changeType !== "time") {
    rows.push(`<tr><td style="padding:10px 14px;background:#1e1e1e;color:#9ca3af;font-size:13px;">Old Location</td><td style="padding:10px 14px;background:#1e1e1e;color:#f87171;text-decoration:line-through;">${oldLocText}</td></tr>`);
    rows.push(`<tr><td style="padding:10px 14px;background:#161616;color:#9ca3af;font-size:13px;">New Location</td><td style="padding:10px 14px;background:#161616;color:#4ade80;font-weight:bold;font-size:15px;">${newLocDisplay}</td></tr>`);
  } else {
    rows.push(td("#1e1e1e", "Location", newLocDisplay));
  }

  rows.push(td("#161616", "Athletes", data.kids));

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `${subjectLabel} — Mesa Basketball Training`,
    html: `
      <h2>${subjectLabel}</h2>
      <p>Hi ${data.parentName},</p>
      <p>${descText}</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0; border-radius: 8px; overflow: hidden;">
        ${rows.join("")}
      </table>
      <p>We apologize for any inconvenience. Please update your calendar to reflect the change.</p>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (result.error) console.error("Change notification email error for", data.email, result.error);
}

export async function sendRescheduleNotification(data: {
  parentName: string;
  email: string;
  oldSessionDetails: string;
  newSessionDetails: string;
  manageToken: string;
  isLateReschedule?: boolean;
  lateFeeAmount?: number;
  newTrainer?: string;
  // Set when the new session's price differs from what was already paid on
  // the old one. "charge" (money collected via Stripe — either a topup on an
  // on-time reschedule, or a fresh full charge after a late reschedule's 50%
  // fee was kept) is always a confirmed success by the time this runs — the
  // webhook only calls this after Stripe confirms payment. "refund" reflects
  // the actual outcome of trying to refund the difference, which — same as
  // a cancellation refund — can be split across a real refund and account
  // credit, or fail outright.
  priceAdjustment?:
    | { kind: "charge"; amount: number }
    | { kind: "refund"; refundedAmount: number; creditedAmount: number; failed: boolean };
  // Set when a late reschedule of a Stripe-paid booking credited 50% of the
  // old payment to the account, but the new session didn't need a fresh
  // Stripe charge (e.g. its price couldn't be determined automatically) —
  // covers that edge case's messaging when priceAdjustment isn't also set.
  lateFeeCredited?: number;
}) {
  const resend = getResend();

  // The late-fee "still due" note only makes sense when nothing was
  // collected/credited automatically for this reschedule at all.
  const lateFeeNote = data.isLateReschedule && !data.priceAdjustment && !data.lateFeeCredited
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Fee</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This reschedule was made within 24 hours of the session. Per our policy, a <strong>50% fee${data.lateFeeAmount ? ` of $${data.lateFeeAmount}` : ""}</strong> is still due.</p>
        ${PAYMENT_LINES}
      </div>`
    : "";
  function refundAdjustmentBody(adj: { refundedAmount: number; creditedAmount: number; failed: boolean }): string {
    if (adj.failed) return "Your refund is being processed — you'll receive a separate confirmation once it's complete.";
    const parts: string[] = [];
    if (adj.refundedAmount > 0) parts.push(`<strong>$${adj.refundedAmount}</strong> has been refunded to your original payment method`);
    if (adj.creditedAmount > 0) parts.push(`<strong>$${adj.creditedAmount}</strong> has been credited to your account`);
    return parts.length > 0 ? `${parts.join(", ")} (new session is lower-priced).` : "";
  }
  const priceAdjustmentNote = data.priceAdjustment
    ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">${data.priceAdjustment.kind === "refund" ? (data.priceAdjustment.failed ? "Refund In Progress" : "Refund Issued") : "Payment Received"}</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">${data.priceAdjustment.kind === "refund"
          ? refundAdjustmentBody(data.priceAdjustment)
          : `<strong>$${data.priceAdjustment.amount}</strong> was charged to complete your reschedule${data.isLateReschedule ? " (late reschedule — 50% of your original payment was kept as a fee, and credited to your account; the new session required full payment)" : " (new session is higher-priced)"}.`}</p>
      </div>`
    : !data.priceAdjustment && data.lateFeeCredited
      ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
          <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Account Credit</p>
          <p style="margin: 0; color: #ffffff; font-size: 14px;"><strong>$${data.lateFeeCredited}</strong> has been credited to your account (50% of what you paid — this was a late reschedule, so the other half isn't refunded per our policy).</p>
        </div>`
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
      ${data.newTrainer ? `<p><strong>Trainer:</strong> ${data.newTrainer}</p>` : ""}
      ${data.priceAdjustment
        ? data.priceAdjustment.kind === "refund"
          ? `<p><strong>${data.priceAdjustment.failed ? "REFUND FAILED — needs manual action" : [data.priceAdjustment.refundedAmount > 0 ? `$${data.priceAdjustment.refundedAmount} refunded` : "", data.priceAdjustment.creditedAmount > 0 ? `$${data.priceAdjustment.creditedAmount} credited` : ""].filter(Boolean).join(", ")}</strong></p>`
          : `<p><strong>Charged: $${data.priceAdjustment.amount}</strong></p>`
        : data.lateFeeCredited ? `<p><strong>$${data.lateFeeCredited} credited to their account</strong> (late reschedule — 50% of what they paid)</p>` : ""}
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
      ${data.newTrainer ? `<p><strong>Trainer:</strong> ${data.newTrainer}</p>` : ""}
      ${priceAdjustmentNote}
      ${lateFeeNote}
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage all your sessions</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
}
