import { Resend } from "resend";
import { calcServiceFee, fmtMoney, PRIVATE_RATE_BY_TIER, GROUP_PRIVATE_RATE_BY_TIER, getTrainerTier, REFERRAL_CREDIT_SESSION_PRICE } from "./pricing";
import { formatTrainerForDisplay } from "./trainers";
import { formatMonthYear } from "./sms";
import { REFERRAL_PROGRAM_ENABLED } from "./feature-flags";
import { buildUnsubscribeUrl } from "./unsubscribe";

const ARTEMI_EMAIL = "artemios@mesabasketballtraining.com";
const FROM_EMAIL = "Mesa Basketball <noreply@mesabasketballtraining.com>";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://mesa-basketball-h8lk.vercel.app";

const VENMO_LINK = `<a href="https://venmo.com/u/Artemios-Gavalas" target="_blank" style="color: #008CFF; font-weight: bold;">@Artemios-Gavalas</a>`;
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

// Every notification here embeds client-submitted strings (parent/kid names,
// phone, referral names) directly into an HTML email sent to someone ELSE
// (the referrer, the admin, or the client themselves) — unescaped, a crafted
// name like `<a href="https://phish.example">click here</a>` renders as a
// live, clickable phishing link in that other person's inbox. Escape any
// such field right before interpolating it into an `html:` template.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// sessionDetails can be client-submitted (the single private/group-private
// booking branch in register/route.ts inserts it verbatim) and this
// function's output goes straight into an HTML email to BOTH the admin and
// the client at every stage of a booking's lifecycle (registration,
// cancellation, no-show, player-update notifications) — so, same reasoning
// as escapeHtml above, anything that isn't our own trusted LOCATION_MAP
// replacement link must be escaped. Splits on each matched location name
// (not a single indexOf) to preserve the original replaceAll behavior for a
// name that appears more than once.
//
// weekly/camp/private-series bookings are the one exception: booking-finalize.ts
// builds their sessionDetails itself, as server-controlled HTML (`<br/>`,
// `<strong>`, `<p>` for line breaks and the price summary) wrapped around
// sheet-verified dates/times/locations — never raw client input. Escaping
// that blindly renders the literal tags as text ("...<br/><p><strong>Total:
// </strong>...") instead of formatting the email, so the caller marks it
// `isHtml: true` to pass it through as-is (only doing location-link
// substitution, not escaping).
function formatSessionDetailsForEmail(details: string, isHtml = false): string {
  if (isHtml) {
    let result = details;
    for (const [key, { name, url }] of Object.entries(LOCATION_MAP)) {
      if (!result.includes(key)) continue;
      const link = `<a href="${url}" style="color: #d4af37;">${name}</a>`;
      result = result.split(key).join(link);
    }
    return result;
  }
  for (const [key, { name, url }] of Object.entries(LOCATION_MAP)) {
    if (!details.includes(key)) continue;
    const link = `<a href="${url}" style="color: #d4af37;">${name}</a>`;
    return details.split(key).map(escapeHtml).join(link);
  }
  return escapeHtml(details);
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

// A single .ics file can validly contain more than one VEVENT — used to give
// a multi-date private series (or any other multi-date booking) ONE
// calendar file covering every date, instead of just the first one. Each
// event still needs its own globally-unique UID (date+time is enough here).
function buildICSContent(events: { date: string; startTime: string; endTime: string; location: string; title: string }[]): string {
  const vevents = events.flatMap(({ date, startTime, endTime, location, title }) => {
    const d = calDateStr(date);
    if (!d) return [];
    return [
      "BEGIN:VEVENT",
      `UID:mesa-${d}T${calTimeStr(startTime)}@mesabasketballtraining.com`,
      `DTSTART;TZID=America/New_York:${d}T${calTimeStr(startTime)}`,
      `DTEND;TZID=America/New_York:${d}T${calTimeStr(endTime)}`,
      `SUMMARY:${title}`,
      `LOCATION:${location}`,
      "DESCRIPTION:Mesa Basketball Training",
      "END:VEVENT",
    ];
  });
  if (vevents.length === 0) return "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mesa Basketball Training//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...vevents,
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
  // A multi-date series (e.g. recurring private sessions) — when set, the
  // .ics attachment covers EVERY date, not just calendarEvent's one. The
  // Google/Apple "Add to Calendar" buttons above the attachment still only
  // ever offer the first date (Google's URL scheme is single-event only) —
  // the attachment is what actually gets every date into the client's own
  // calendar app in one action.
  calendarEvents?: { date: string; startTime: string; endTime: string; location: string; }[];
  accountCreditApplied?: number;
  fullPrice?: number;
  // The actual dollar amount charged via Stripe for this booking (net of any
  // discount/credit, before the service fee) — unset/0 for package sessions
  // (already paid at enrollment) or a booking fully covered by credit, since
  // neither one touches Stripe. Drives the "charged to your card" note below;
  // this function only ever runs after payment already succeeded (or never
  // needed to happen), so it must never claim payment is still "due."
  amountCharged?: number;
  // Explicit flag from the caller for whether this weekly booking is a
  // single-group Pickup booking. Must be passed explicitly rather than
  // sniffed from sessionDetails — a mixed booking's sessionDetails can
  // legitimately contain the word "pickup" (e.g. "1 High School Skills and 1
  // Pickup") without the whole booking being a pickup booking.
  isPickup?: boolean;
  // True when sessionDetails is server-built HTML (weekly/camp/private-series
  // batch bookings), not raw client input — see formatSessionDetailsForEmail.
  sessionDetailsIsHtml?: boolean;
  // A multi-date private series can legitimately span more than one trainer
  // (different dates, different substitute covering) — `trainer` above is
  // only ever the FIRST session's, so the standalone "Trainer:"/"Rate:"
  // summary lines below would misrepresent every OTHER date in the series
  // (wrong name, and — since price is trainer-tier-dependent — a rate that
  // may not match what several of the dates actually cost). The accurate
  // per-series total is already itemized directly in `sessionDetails` by
  // the caller, so these two summary lines are just redundant (not the
  // source of truth) for a series and safe to omit entirely rather than
  // show a number/name that only applies to one date out of several.
  suppressTrainerAndRateLines?: boolean;
}) {
  const resend = getResend();

  const isPackageBooking = data.packageSessionsRemaining !== undefined;

  const isPickup = data.type === "weekly" && !!data.isPickup;
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
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
      <p><strong>Players:</strong> ${escapeHtml(data.kids)}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails, data.sessionDetailsIsHtml)}</p>
      ${data.trainer && !data.suppressTrainerAndRateLines ? `<p><strong>Trainer:</strong> ${escapeHtml(data.trainer)}</p>` : ""}
      <p><strong>Total Participants:</strong> ${data.totalParticipants}</p>
      ${isPackageBooking ? `<p><strong>Package:</strong> ${data.packageType}-session monthly plan — ${data.packageSessionsRemaining} session${data.packageSessionsRemaining !== 1 ? "s" : ""} remaining after this booking</p>` : ""}
      ${data.isFree && !isPackageBooking ? `<p><strong style="color: #d4af37;">${data.isFirstTime ? "First-Time Discount: 50% off applied" : `Referral Credit: $${REFERRAL_CREDIT_SESSION_PRICE} flat applied`}</strong></p>` : ""}
      ${data.accountCreditApplied && data.accountCreditApplied > 0 ? `<p><strong style="color: #93c5fd;">Account credit applied: $${fmtMoney(data.accountCreditApplied)}</strong></p>` : ""}
      ${data.amountCharged != null && data.amountCharged > 0 ? `<p><strong>Charged: $${fmtMoney(data.amountCharged + calcServiceFee(data.amountCharged))}</strong></p>` : ""}
      ${data.referredBy ? `<p><strong>Referred by:</strong> ${escapeHtml(data.referredBy)}</p>` : ""}
      ${data.referralCodeUsed ? `<p><strong>Referral code used:</strong> ${escapeHtml(data.referralCodeUsed)}</p>` : ""}
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

  const emailTrainerTier = getTrainerTier(data.trainer);
  const priceNote = isPackageBooking || data.isFree || data.suppressTrainerAndRateLines
    ? ""
    : data.type === "private"
      ? `<p><strong>Rate:</strong> $${PRIVATE_RATE_BY_TIER[emailTrainerTier]} (up to 3 participants)</p>`
      : data.type === "group-private"
        ? `<p><strong>Rate:</strong> $${GROUP_PRIVATE_RATE_BY_TIER[emailTrainerTier]} (4+ participants)</p>`
        : "";

  // This function only ever runs once a booking is actually confirmed —
  // either it was paid via Stripe already (webhook-triggered), or it never
  // needed payment at all (free session, or fully covered by credit). Either
  // way, payment is never still "due" by the time this sends, so this only
  // states the cancellation/reschedule policy, not a payment method.
  const paymentNote = isPackageBooking || data.isFree
    ? ""
    : data.type === "weekly"
      ? `<p>Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Rescheduling or canceling within 24 hours of the scheduled session will result in a 50% charge of the session fee. <strong>No-shows without prior notice will be charged the full session fee.</strong> (Sessions booked in bulk — 4+ or 8+ at once — are non-refundable if cancelled within 24 hours, and a reschedule within 24 hours is charged at full price for the new session.)</p>`
      : `<p>Please provide at least 24 hours' notice if you need to cancel or reschedule a session. Rescheduling or canceling within 24 hours of the scheduled session will result in a 50% charge of the session fee. <strong>No-shows without prior notice will be charged the full session fee.</strong></p>`;

  const freeNote = !isPackageBooking && data.isFree && data.isFirstTime
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">First Session Discount Applied — 50% Off!</p>`
    : !isPackageBooking && data.isFree
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">Referral Credit Applied — $${REFERRAL_CREDIT_SESSION_PRICE} This Session!</p>`
    : "";

  // The actual card charge, including the service fee — this is the
  // one number that should match what shows on the client's bank/card
  // statement, so it's shown plainly rather than folded into the other
  // price notes above (which describe the session's rate, not the charge).
  const chargedNote = data.amountCharged != null && data.amountCharged > 0
    ? `<p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">Charged to your card: $${fmtMoney(data.amountCharged + calcServiceFee(data.amountCharged))}</p>`
    : "";

  const accountCreditNote = data.accountCreditApplied && data.accountCreditApplied > 0 && data.fullPrice != null
    ? `<p style="background: #1e3a5f; color: #93c5fd; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">$${fmtMoney(data.accountCreditApplied)} account credit applied</p>`
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
    // Google's URL-based "add to calendar" scheme only ever supports one
    // event — for a multi-date series these two buttons can only offer the
    // first date. The attached .ics file (below, via icsAttachment) covers
    // every date; this note tells the client that file exists and is the
    // one to use for the full series.
    const seriesNote = data.calendarEvents && data.calendarEvents.length > 1
      ? `<br/><span style="font-size: 11px; color: #93c5fd;">(buttons add just this first date — this email's attached calendar file has all ${data.calendarEvents.length} dates)</span>`
      : "";
    return `<p style="margin-top: 8px;">
      <a href="${googleUrl}" target="_blank" style="display: inline-block; background: #1a73e8; color: #ffffff; padding: 7px 14px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; margin-right: 8px;">Add to Google Calendar</a>
      <a href="${icsUrl}" style="display: inline-block; background: #3a3a3a; color: #ffffff; padding: 7px 14px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold;">Add to Apple Calendar</a>
      ${seriesNote}
    </p>`;
  })();

  const icsAttachment = (() => {
    // Prefer the full multi-date list when the caller provided one — falls
    // back to the single calendarEvent for every non-series booking (the
    // overwhelming majority of call sites, unaffected by this change).
    const events = data.calendarEvents && data.calendarEvents.length > 0
      ? data.calendarEvents
      : data.calendarEvent
        ? [data.calendarEvent]
        : [];
    if (events.length === 0) return null;
    const icsTitle = data.type === "camp" ? "Mesa Basketball Training — Camp" : isPickup ? "Mesa Basketball Training — Pickup Session" : data.type === "weekly" ? "Mesa Basketball Training — Group Session" : "Mesa Basketball Training — Private Session";
    const content = buildICSContent(events.map((e) => ({ ...e, location: LOCATION_MAP[e.location]?.name || e.location, title: icsTitle })));
    if (!content) return null;
    return { filename: "mesa-basketball.ics", content: Buffer.from(content) };
  })();

  // Referrals are paused — don't invite people to share/earn on something
  // that currently doesn't do anything. Gated on the same flag as
  // everywhere else, not deleted, so this comes back automatically
  // whenever REFERRAL_PROGRAM_ENABLED flips back on.
  const referralSection = REFERRAL_PROGRAM_ENABLED && data.referralCode
    ? `<p style="background: #162d5a; padding: 12px; border-radius: 8px; margin-top: 12px; color: #ffffff;"><strong style="color: #d4af37;">Your referral code: ${data.referralCode}</strong><br/><span style="font-size: 13px; color: #93c5fd;">Share this code with friends and family — when they book their first session using your code, you'll receive a $${REFERRAL_CREDIT_SESSION_PRICE} private session.</span></p>`
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
      <p>Hi ${escapeHtml(data.parentName)},</p>
      <p>Your ${typeLabel.toLowerCase()} has been confirmed.</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails, data.sessionDetailsIsHtml)}</p>
      ${data.trainer && !data.suppressTrainerAndRateLines ? `<p><strong>Trainer:</strong> ${escapeHtml(formatTrainerForDisplay(data.trainer))}</p>` : ""}
      <p><strong>Players:</strong> ${escapeHtml(data.kids)}</p>
      ${packageNote}
      ${freeNote}
      ${accountCreditNote}
      ${chargedNote}
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
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.referrerEmail,
    replyTo: ARTEMI_EMAIL,
    subject: `You earned a $${REFERRAL_CREDIT_SESSION_PRICE} private session — Mesa Basketball Training`,
    html: `
      <h2>You earned a reward!</h2>
      <p>Hi ${escapeHtml(data.referrerName)},</p>
      <p>Great news — <strong>${escapeHtml(data.newClientName)}</strong> just booked their first session using your referral code. As a thank you, you've earned a <strong>$${REFERRAL_CREDIT_SESSION_PRICE} private session</strong>.</p>
      <p>Your discount will be applied automatically the next time you book a private session.</p>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — check your referral credits anytime.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (result.error) console.error("Resend referral-credit email error:", result.error, "to:", data.referrerEmail);
}

interface StripeRefundOutcome {
  refundedAmount: number;
  creditedAmount: number;
  failed: boolean;
}

// Renders whatever actually happened to the money — a plain credit, a full
// refund, a split refund+credit, or (if the Stripe call failed outright) a
// pending note that doesn't claim money moved before it actually did.
// Shared by every cancellation email (sessions and packages alike) so the
// wording of a given money outcome never drifts between them.
function moneyOutcomeHtml(refundResult: StripeRefundOutcome | undefined, plainCredit: number | undefined, lateCreditNote: string): string {
  if (refundResult) {
    if (refundResult.failed) {
      return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Refund In Progress</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">Your refund is being processed — you'll receive a separate confirmation once it's complete.</p>
      </div>`;
    }
    const parts: string[] = [];
    if (refundResult.refundedAmount > 0) parts.push(`<strong>$${fmtMoney(refundResult.refundedAmount)}</strong> has been refunded to your original payment method`);
    if (refundResult.creditedAmount > 0) parts.push(`<strong>$${fmtMoney(refundResult.creditedAmount)}</strong> has been credited to your account`);
    if (parts.length === 0) return "";
    return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
      <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">${refundResult.refundedAmount > 0 ? "Refund Issued" : "Account Credit"}</p>
      <p style="margin: 0; color: #ffffff; font-size: 14px;">${parts.join(", ")}.</p>
    </div>`;
  }
  if (plainCredit !== undefined && plainCredit > 0) {
    return `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
      <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Account Credit</p>
      <p style="margin: 0; color: #ffffff; font-size: 14px;"><strong>$${fmtMoney(plainCredit)}</strong> has been credited to your account for a future booking${lateCreditNote}.</p>
    </div>`;
  }
  return "";
}

// Plain-text summary of what happened to the money, for admin emails only.
function adminMoneySummary(refundResult: StripeRefundOutcome | undefined, plainCredit: number | undefined): string {
  if (refundResult) {
    if (refundResult.failed) return "refund FAILED — needs manual action";
    const parts: string[] = [];
    if (refundResult.refundedAmount > 0) parts.push(`$${fmtMoney(refundResult.refundedAmount)} refunded to their card`);
    if (refundResult.creditedAmount > 0) parts.push(`$${fmtMoney(refundResult.creditedAmount)} credited to their account`);
    return parts.join(", ");
  }
  return plainCredit !== undefined && plainCredit > 0 ? `$${fmtMoney(plainCredit)} credited to their account` : "";
}

export async function sendCancellationNotification(data: {
  parentName: string;
  email: string;
  sessionDetails: string;
  sessionType?: string;
  isLateCancel: boolean;
  lateFeeAmount?: number;
  campAdjustment?: { finalAmount: number; originalAmount: number; isPaid: boolean; creditGranted: number; stripeRefundResult?: StripeRefundOutcome };
  // Late cancellation (old, non-package/non-weekly policy only): 50%
  // credited to account. No Stripe call is ever attempted for this case, so
  // there's nothing to "fail" — it's a plain credit.
  cancelCredit?: number;
  // On-time cancellation of a Stripe-paid booking: the actual outcome of
  // trying to refund it — may be split across a real card refund and account
  // credit (see issueStripeRefund's amount_too_large fallback), or failed
  // entirely (nothing moved yet; admin alerted to complete it manually).
  stripeRefundResult?: StripeRefundOutcome;
  // Late cancellation of a package-covered session: the session itself is
  // forfeited (stays counted as "used" against the package, same as a
  // no-show) — no separate fee is ever charged. Mutually exclusive with
  // lateFeeAmount/cancelCredit/stripeRefundResult for the same booking.
  packageSessionForfeited?: boolean;
  // Late cancellation of a plain (non-package) weekly group session: full
  // forfeiture, 0% refunded — replaces the old 50%-credited path for weekly
  // specifically. Also mutually exclusive with cancelCredit/stripeRefundResult.
  fullForfeitNoRefund?: boolean;
}) {
  const resend = getResend();
  const isPickupCancel = data.sessionDetails.toLowerCase().includes("pickup");

  const somethingWasAttempted = data.cancelCredit !== undefined || !!data.stripeRefundResult;
  const lateFee = data.lateFeeAmount !== undefined
    ? data.lateFeeAmount
    : data.sessionType === "group-private" ? 125 : data.sessionType === "weekly" ? 25 : 75;
  const lateNote = data.packageSessionForfeited
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Cancellation</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This cancellation was made within 24 hours of the session. Per our policy, <strong>this session is forfeited from your package</strong> — no additional charge, but it doesn't carry over or refund.</p>
      </div>`
    : data.fullForfeitNoRefund
      ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
          <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Cancellation</p>
          <p style="margin: 0; color: #ffffff; font-size: 14px;">This cancellation was made within 24 hours of the session. Per our policy, <strong>this session is non-refundable</strong>.</p>
        </div>`
      : data.isLateCancel && !data.campAdjustment && !somethingWasAttempted
        ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
            <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Fee</p>
            <p style="margin: 0; color: #ffffff; font-size: 14px;">This cancellation was made within 24 hours of the session. Per our policy, a <strong>50% fee of $${fmtMoney(lateFee)}</strong> is still due.</p>
            ${PAYMENT_LINES}
          </div>`
        : "";

  const creditNote = !data.campAdjustment && !data.packageSessionForfeited && !data.fullForfeitNoRefund
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
    ? `<strong>$${fmtMoney(data.campAdjustment.finalAmount)}</strong> is due.`
    : "";
  const campAdjustmentNote = data.campAdjustment
    ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Updated Camp Total</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">New total: <strong>$${fmtMoney(data.campAdjustment.finalAmount)}</strong> (was $${fmtMoney(data.campAdjustment.originalAmount)}). ${campAdjustmentLine}</p>
        ${!data.campAdjustment.isPaid ? PAYMENT_LINES : ""}
      </div>${campMoneyHtml}`
    : "";

  const adminCancelSummary = adminMoneySummary(data.stripeRefundResult, data.cancelCredit);
  const adminCampSummary = data.campAdjustment?.isPaid
    ? adminMoneySummary(data.campAdjustment.stripeRefundResult, data.campAdjustment.creditGranted)
    : "";

  // Email to Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `${isPickupCancel ? "Pickup " : ""}Cancellation: ${data.parentName}`,
    html: `
      <h2>${isPickupCancel ? "Pickup " : ""}Session Cancelled</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${data.isLateCancel && data.packageSessionForfeited ? `<p><strong>⚠️ Late cancellation (within 24h) — package session forfeited, no fee charged</strong></p>` : ""}
      ${data.isLateCancel && data.fullForfeitNoRefund ? `<p><strong>⚠️ Late cancellation (within 24h) — full forfeiture, no refund</strong></p>` : ""}
      ${data.isLateCancel && !data.campAdjustment && !data.packageSessionForfeited && !data.fullForfeitNoRefund && !somethingWasAttempted ? `<p><strong>⚠️ Late cancellation (within 24h) — 50% fee ($${fmtMoney(lateFee)}) applies</strong></p>` : ""}
      ${!data.campAdjustment && !data.packageSessionForfeited && !data.fullForfeitNoRefund && adminCancelSummary ? `<p><strong>${adminCancelSummary}</strong>${data.isLateCancel ? " (late cancellation — 50% of what they paid)" : ""}</p>` : ""}
      ${data.campAdjustment ? `<p><strong>New total: $${fmtMoney(data.campAdjustment.finalAmount)} (was $${fmtMoney(data.campAdjustment.originalAmount)}).</strong> ${data.campAdjustment.isPaid ? adminCampSummary : `Due: $${fmtMoney(data.campAdjustment.finalAmount)}`}</p>` : ""}
    `,
  });
  if (adminResult.error) console.error("Resend admin cancellation email error:", adminResult.error);

  // Confirmation to parent
  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `${isPickupCancel ? "Pickup " : ""}Session Cancelled — Mesa Basketball Training`,
    html: `
      <h2>${isPickupCancel ? "Pickup " : ""}Session Cancelled</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
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
  if (clientResult.error) console.error("Resend cancellation email error:", clientResult.error, "to:", data.email);
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
  appliedAccountCredit?: number;
  kids?: string;
  referralCode?: string;
}) {
  const resend = getResend();
  const monthLabel = formatMonthYear(data.monthYear);
  const expiry = lastDayOfMonth(data.monthYear);
  // This only ever sends once payment (or full credit coverage) has already
  // succeeded (see finalizePaidPackageEnrollment) — never claim payment is
  // still "due." The fee itself was computed on whatever was left AFTER
  // account credit at enrollment (see /api/packages), not the full package
  // price — match that here, and keep "total price" (what the package is
  // worth, credit + card combined) distinct from "charged to card" (what
  // actually hit Stripe), or a partially-credit-covered package either
  // overstates its card charge or misreports its total.
  const appliedCredit = data.appliedAccountCredit ?? 0;
  const amountCharged = Math.max(0, data.totalPrice - appliedCredit);
  const fee = amountCharged > 0 ? calcServiceFee(amountCharged) : 0;
  const totalWithFee = Math.round((data.totalPrice + fee) * 100) / 100;
  const chargedToCard = Math.round((amountCharged + fee) * 100) / 100;
  const creditLine = appliedCredit > 0 ? `<p><strong>Account credit applied:</strong> $${fmtMoney(appliedCredit)}</p>` : "";
  const chargedLabel = chargedToCard > 0
    ? `<p><strong>Charged to card:</strong> $${fmtMoney(chargedToCard)}</p>`
    : `<p><strong>Charged to card:</strong> $0 (fully covered by account credit)</p>`;

  // Notify Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `New Package Enrollment: ${data.parentName} — ${data.packageType} sessions (${monthLabel})`,
    html: `
      <h2>New Monthly Package Enrollment</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
      <p><strong>Package:</strong> ${data.packageType} sessions / month</p>
      <p><strong>Month:</strong> ${monthLabel}</p>
      <p><strong>Total:</strong> $${fmtMoney(totalWithFee)}</p>
      ${creditLine}
      ${chargedLabel}
      ${data.kids ? `<p><strong>Player(s):</strong> ${escapeHtml(data.kids)}</p>` : ""}
      ${data.referralCode ? `<p><strong>Referral Code:</strong> ${escapeHtml(data.referralCode)}</p>` : ""}
    `,
  });
  if (adminResult.error) console.error("Resend admin package-confirmation email error:", adminResult.error);

  // Confirmation to parent
  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Package Confirmed — Mesa Basketball Training (${monthLabel})`,
    html: `
      <h2>You're enrolled!</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
      <p>Your <strong>${data.packageType}-session private training package</strong> for <strong>${monthLabel}</strong> is confirmed.</p>
      <h3>Package Details</h3>
      <ul>
        <li><strong>Sessions:</strong> ${data.packageType} private sessions</li>
        <li><strong>Month:</strong> ${monthLabel}</li>
        <li><strong>Sessions expire:</strong> ${expiry} — unused sessions do not carry over</li>
        <li><strong>Total price:</strong> $${fmtMoney(totalWithFee)}</li>
        ${appliedCredit > 0 ? `<li><strong>Account credit applied:</strong> $${fmtMoney(appliedCredit)}</li>` : ""}
      </ul>
      <p style="background: #162d5a; color: #d4af37; padding: 12px; border-radius: 8px; font-weight: bold; text-align: center;">${chargedToCard > 0 ? `Charged to your card: $${fmtMoney(chargedToCard)}` : "Fully covered by your account credit — no card was charged"}</p>
      <p>Your next ${data.packageType} private session bookings this month are already covered — nothing further will be charged when you book them at <a href="${BASE_URL}/schedule" style="color: #d4af37; font-weight: bold;">mesabasketballtraining.com/schedule</a>, up to your package total.</p>
      <h3>Cancellation &amp; Rescheduling Policy</h3>
      <p>Cancelling or rescheduling a session within 24 hours forfeits that session from your package — no fee, but no refund or carryover either. If it was your last session in the package, rescheduling it requires paying full price for the new session (or you can simply cancel instead). <strong>No-shows without prior notice will be charged the full session fee.</strong></p>
      <h3>Track Your Sessions</h3>
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — check how many sessions you've used this month.</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (clientResult.error) console.error("Resend package-confirmation email error:", clientResult.error, "to:", data.email);
}

/** Sent when a client cancels a never-used package (see /api/packages/cancel)
 *  — reuses the same money-outcome rendering as sendCancellationNotification
 *  so a refund/credit/split/failure reads identically everywhere in the app. */
export async function sendPackageCancellationNotification(data: {
  parentName: string;
  email: string;
  packageType: number;
  monthYear: string;
  refundOutcome: StripeRefundOutcome;
}) {
  const resend = getResend();
  const monthLabel = formatMonthYear(data.monthYear);
  const moneyNote = moneyOutcomeHtml(data.refundOutcome, undefined, "");
  const adminSummary = adminMoneySummary(data.refundOutcome, undefined);

  // Notify Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Package Cancelled: ${data.parentName}`,
    html: `
      <h2>Monthly Package Cancelled</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Package:</strong> ${data.packageType} sessions / month</p>
      <p><strong>Month:</strong> ${monthLabel}</p>
      ${adminSummary ? `<p><strong>${adminSummary}</strong></p>` : ""}
    `,
  });
  if (adminResult.error) console.error("Resend admin package-cancellation email error:", adminResult.error);

  // Confirmation to parent
  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `Package Cancelled — Mesa Basketball Training`,
    html: `
      <h2>Package Cancelled</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
      <p>Your <strong>${data.packageType}-session private training package</strong> for <strong>${monthLabel}</strong> has been cancelled.</p>
      ${moneyNote}
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (clientResult.error) console.error("Resend package-cancellation email error:", clientResult.error, "to:", data.email);
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
  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    subject: `Your Mesa Basketball sessions are expiring soon!`,
    html: `
      <h2>Don't let your sessions go to waste!</h2>
      <p>Hey ${escapeHtml(data.parentName)},</p>
      <p>Just a heads up — your <strong>${monthLabel}</strong> package has <strong>${sessionsRemaining} session${sessionsRemaining !== 1 ? "s" : ""} remaining</strong> and the month ends in 3 days.</p>
      <p>Don't let them go to waste! Book now and make the most of your training time.</p>
      <p><a href="${BASE_URL}/#private" style="color: #d4af37; font-weight: bold; font-size: 16px;">Book Your Remaining Sessions &rarr;</a></p>
      <br/>
      <p>Keep working hard — every session counts!</p>
      <p>Questions? Reach out to Artemios at (631) 599-1280 or <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (clientResult.error) console.error("Resend package-reminder email error:", clientResult.error, "to:", data.email);

  // Notify Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Package Reminder Sent: ${data.parentName} — ${sessionsRemaining} session(s) remaining`,
    html: `
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)} (${escapeHtml(data.email)})</p>
      <p><strong>Month:</strong> ${monthLabel}</p>
      <p><strong>Sessions Used:</strong> ${data.sessionsUsed} / ${data.packageType}</p>
      <p><strong>Remaining:</strong> ${sessionsRemaining}</p>
      <p>A reminder email has been sent to the parent.</p>
    `,
  });
  if (adminResult.error) console.error("Resend admin package-reminder email error:", adminResult.error);
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
    ? `<p><strong>Removed:</strong> ${data.removedPlayers.map(escapeHtml).join(", ")}</p>` : "";
  const addedList = data.addedPlayers.length > 0
    ? `<p><strong>Added:</strong> ${data.addedPlayers.map(escapeHtml).join(", ")}</p>` : "";

  const lateBlock = data.isLate && data.removedPlayers.length > 0
    ? `<div style="background:#7c1d1d;border-left:4px solid #ef4444;border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="margin:0 0 6px 0;font-size:15px;font-weight:bold;color:#fff;">⚠️ Late Removal — Fee Applies</p>
        <p style="margin:0;color:#fff;font-size:14px;">This player was removed within 24 hours of the session. Per our policy${data.lateFeeDue ? `, a fee of <strong>$${fmtMoney(data.lateFeeDue)}</strong> is still due` : ", a late cancellation fee still applies"}.</p>
        ${PAYMENT_LINES}
      </div>`
    : "";

  const priceBlock = data.priceChanged && data.newPrice !== null
    ? `<p style="background:#162d5a;padding:12px;border-radius:8px;color:#fff;">
        <strong style="color:#d4af37;">Updated Session Rate: $${fmtMoney(data.newPrice)}</strong>
        ${data.isLate && (data.sessionType === "private" || data.sessionType === "group-private")
          ? `<br/><span style="font-size:13px;opacity:0.85;">Because this change was made within 24 hours, only half the price difference was applied.</span>`
          : ""}
      </p>`
    : "";

  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Player Update${data.isLate && data.removedPlayers.length > 0 ? " ⚠️ LATE" : ""}: ${data.parentName}`,
    html: `
      <h2>Player List Updated</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${removedList}${addedList}
      <p><strong>Current Players:</strong> ${escapeHtml(data.newKids)}</p>
      ${data.priceChanged ? `<p><strong>Price:</strong> $${data.oldPrice != null ? fmtMoney(data.oldPrice) : "—"} → $${data.newPrice != null ? fmtMoney(data.newPrice) : "—"}</p>` : ""}
      ${data.isLate && data.removedPlayers.length > 0 ? `<p style="color:#ef4444;"><strong>⚠️ Late removal${data.lateFeeDue ? ` — $${fmtMoney(data.lateFeeDue)} fee due` : ""}</strong></p>` : ""}
    `,
  });
  if (adminResult.error) console.error("Resend admin player-update email error:", adminResult.error);

  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `Player List Updated — Mesa Basketball Training`,
    html: `
      <h2>Player List Updated</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
      <p>Your player list for the following session has been updated:</p>
      <p><strong>Session:</strong> ${formatSessionDetailsForEmail(data.sessionDetails)}</p>
      ${removedList}${addedList}
      <p><strong>Current Players:</strong> ${escapeHtml(data.newKids)}</p>
      ${priceBlock}
      ${lateBlock}
      <p><a href="${BASE_URL}/my-bookings" style="color:#d4af37;font-weight:bold;">View My Bookings</a></p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (clientResult.error) console.error("Resend player-update email error:", clientResult.error, "to:", data.email);
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
    changeType === "both" ? "Your upcoming session time and location have changed." :
    changeType === "location" ? "Your upcoming session location has changed. The time stays the same." :
    "Your upcoming session time has changed. Everything else stays the same.";

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

  rows.push(td("#161616", "Athletes", escapeHtml(data.kids)));

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `${subjectLabel} — Mesa Basketball Training`,
    html: `
      <h2>${subjectLabel}</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
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
  // Portion of lateFeeCredited that was applied straight to the new
  // session's price, rather than left sitting in the account balance. Set
  // whenever any of it was applied — whether that fully covered the new
  // session (priceAdjustment absent) or only partially, with the remainder
  // charged via Stripe (priceAdjustment present).
  lateFeeCreditApplied?: number;
  // Late reschedule of a package-covered session: the OLD session is
  // forfeited from the package (stays counted as "used", same as a
  // no-show) — no separate fee is charged. newSessionPackageCovered says
  // whether the package still had capacity left to cover the NEW date
  // after that forfeiture; if not, priceAdjustment carries the full-price
  // charge for the new session instead.
  packageSessionForfeited?: boolean;
  newSessionPackageCovered?: boolean;
  // Late reschedule of a plain (non-package) weekly group session: the OLD
  // session is fully forfeited (no credit carried forward at all), and the
  // new session is always charged at full undiscounted price — carried in
  // priceAdjustment as a "charge", same as above.
  fullForfeitNoRefund?: boolean;
}) {
  const resend = getResend();

  // The old flat "50% fee still due" note only applies to the original
  // (non-package, non-weekly) late-reschedule policy — package and weekly
  // now have their own dedicated notes below instead.
  const lateFeeNote = !data.packageSessionForfeited && !data.fullForfeitNoRefund && data.isLateReschedule && !data.priceAdjustment && !data.lateFeeCredited
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Fee</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This reschedule was made within 24 hours of the session. Per our policy, a <strong>50% fee${data.lateFeeAmount ? ` of $${fmtMoney(data.lateFeeAmount)}` : ""}</strong> is still due.</p>
        ${PAYMENT_LINES}
      </div>`
    : "";
  const packageForfeitNote = data.packageSessionForfeited
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Reschedule</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This reschedule was made within 24 hours of the session. Per our policy, <strong>your original session is forfeited from your package</strong>.${
          data.newSessionPackageCovered
            ? " Your new session is still covered by your package — nothing further charged."
            : " Your package no longer has a session available to cover the new date, so it was charged separately below."
        }</p>
      </div>`
    : "";
  const fullForfeitNote = data.fullForfeitNoRefund
    ? `<div style="background: #7c1d1d; border-left: 4px solid #ef4444; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">⚠️ Late Reschedule</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">This reschedule was made within 24 hours of the session. Per our policy, <strong>your original session is fully forfeited (non-refundable)</strong>, and the new session is charged at full price.</p>
      </div>`
    : "";
  function refundAdjustmentBody(adj: { refundedAmount: number; creditedAmount: number; failed: boolean }): string {
    if (adj.failed) return "Your refund is being processed — you'll receive a separate confirmation once it's complete.";
    const parts: string[] = [];
    if (adj.refundedAmount > 0) parts.push(`<strong>$${fmtMoney(adj.refundedAmount)}</strong> has been refunded to your original payment method`);
    if (adj.creditedAmount > 0) parts.push(`<strong>$${fmtMoney(adj.creditedAmount)}</strong> has been credited to your account`);
    return parts.length > 0 ? `${parts.join(", ")} (new session is lower-priced).` : "";
  }
  const leftoverLateFeeCredit = Math.max(0, (data.lateFeeCredited || 0) - (data.lateFeeCreditApplied || 0));
  const priceAdjustmentNote = data.priceAdjustment
    ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
        <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">${data.priceAdjustment.kind === "refund" ? (data.priceAdjustment.failed ? "Refund In Progress" : "Refund Issued") : "Payment Received"}</p>
        <p style="margin: 0; color: #ffffff; font-size: 14px;">${data.priceAdjustment.kind === "refund"
          ? refundAdjustmentBody(data.priceAdjustment)
          : (data.packageSessionForfeited || data.fullForfeitNoRefund)
            ? `<strong>$${fmtMoney(data.priceAdjustment.amount + calcServiceFee(data.priceAdjustment.amount))}</strong> was charged for your new session${data.fullForfeitNoRefund ? " at full price" : ""}.`
            : data.isLateReschedule
              ? `50% of your original payment${data.lateFeeCredited ? ` ($${fmtMoney(data.lateFeeCredited)})` : ""} was kept as a late reschedule fee${data.lateFeeCreditApplied ? `, <strong>$${fmtMoney(data.lateFeeCreditApplied)}</strong> of which was applied directly to your new session` : ""}, and <strong>$${fmtMoney(data.priceAdjustment.amount + calcServiceFee(data.priceAdjustment.amount))}</strong> was charged to cover the rest.`
              : `<strong>$${fmtMoney(data.priceAdjustment.amount + calcServiceFee(data.priceAdjustment.amount))}</strong> was charged to complete your reschedule (new session is higher-priced).`}</p>
      </div>`
    : !data.priceAdjustment && data.lateFeeCredited
      ? `<div style="background: #1e3a5f; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 14px 16px; margin: 16px 0;">
          <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #ffffff;">Account Credit</p>
          <p style="margin: 0; color: #ffffff; font-size: 14px;">${data.lateFeeCreditApplied
            ? `<strong>$${fmtMoney(data.lateFeeCreditApplied)}</strong> of your late reschedule fee credit was applied directly to your new session — fully covering it, nothing further charged.${leftoverLateFeeCredit > 0 ? ` The remaining <strong>$${fmtMoney(leftoverLateFeeCredit)}</strong> is in your account balance for next time.` : ""}`
            : `<strong>$${fmtMoney(data.lateFeeCredited)}</strong> has been credited to your account (50% of what you paid — this was a late reschedule, so the other half isn't refunded per our policy).`}</p>
        </div>`
      : "";

  // Email to Artemi
  const adminResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Reschedule${data.isLateReschedule ? " ⚠️ LATE" : ""}: ${data.parentName}`,
    html: `
      <h2>Session Rescheduled</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
      ${data.newTrainer ? `<p><strong>Trainer:</strong> ${escapeHtml(data.newTrainer)}</p>` : ""}
      ${data.priceAdjustment
        ? data.priceAdjustment.kind === "refund"
          ? `<p><strong>${data.priceAdjustment.failed ? "REFUND FAILED — needs manual action" : [data.priceAdjustment.refundedAmount > 0 ? `$${fmtMoney(data.priceAdjustment.refundedAmount)} refunded` : "", data.priceAdjustment.creditedAmount > 0 ? `$${fmtMoney(data.priceAdjustment.creditedAmount)} credited` : ""].filter(Boolean).join(", ")}</strong></p>`
          : `<p><strong>Charged: $${fmtMoney(data.priceAdjustment.amount + calcServiceFee(data.priceAdjustment.amount))}</strong>${data.lateFeeCreditApplied ? ` (plus $${fmtMoney(data.lateFeeCreditApplied)} late-fee credit applied)` : ""}</p>`
        : data.lateFeeCredited
          ? data.lateFeeCreditApplied
            ? `<p><strong>$${fmtMoney(data.lateFeeCreditApplied)} late-fee credit applied to new session</strong>${leftoverLateFeeCredit > 0 ? ` ($${fmtMoney(leftoverLateFeeCredit)} left in account)` : ""}</p>`
            : `<p><strong>$${fmtMoney(data.lateFeeCredited)} credited to their account</strong> (late reschedule — 50% of what they paid)</p>`
          : ""}
      ${data.packageSessionForfeited ? `<p><strong>⚠️ Late reschedule — package session forfeited</strong>${data.newSessionPackageCovered ? " (new session still covered)" : " (package exhausted)"}</p>` : ""}
      ${data.fullForfeitNoRefund ? `<p><strong>⚠️ Late reschedule — full forfeiture, no refund</strong></p>` : ""}
      ${lateFeeNote}
    `,
  });
  if (adminResult.error) console.error("Resend admin reschedule email error:", adminResult.error);

  // Confirmation to parent
  const clientResult = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.email,
    replyTo: ARTEMI_EMAIL,
    subject: `Session Rescheduled — Mesa Basketball Training`,
    html: `
      <h2>Session Rescheduled</h2>
      <p>Hi ${escapeHtml(data.parentName)},</p>
      <p>Your session has been rescheduled.</p>
      <p><strong>Old Session:</strong> ${formatSessionDetailsForEmail(data.oldSessionDetails)}</p>
      <p><strong>New Session:</strong> ${formatSessionDetailsForEmail(data.newSessionDetails)}</p>
      ${data.newTrainer ? `<p><strong>Trainer:</strong> ${escapeHtml(data.newTrainer)}</p>` : ""}
      ${packageForfeitNote}
      ${fullForfeitNote}
      ${priceAdjustmentNote}
      ${lateFeeNote}
      <p><a href="${BASE_URL}/my-bookings" style="color: #d4af37; font-weight: bold;">View My Bookings</a> — Manage all your sessions</p>
      <br/>
      <p>Questions? Contact Artemios at (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com">artemios@mesabasketballtraining.com</a>.</p>
      <p>— Mesa Basketball Training</p>
    `,
  });
  if (clientResult.error) console.error("Resend reschedule email error:", clientResult.error, "to:", data.email);
}

// Admin-only — a client started Stripe Checkout and never finished (backed
// out, closed the tab, or just let it expire). No charge happened and the
// booking was never confirmed; the slot/credit involved was already
// released automatically. This is informational, not urgent, so it goes to
// email rather than a text.
export async function sendAbandonedCheckoutEmail(data: {
  parentName: string;
  email: string;
  phone?: string | null;
  kids?: string | null;
  sessions: { sessionDetails: string; bookedDate?: string | null; sessionPrice?: number | null }[];
  // Set only when this abandonment was a reschedule's price-increase topup —
  // the client's ORIGINAL booking is deliberately left untouched until a
  // required topup payment actually succeeds (see
  // settleOldBookingForReschedule's doc comment in booking-finalize.ts), so
  // abandoning it leaves that original booking exactly as it was: nothing
  // was charged, nothing needs refunding, nothing needs fixing.
  isRescheduleTopup?: boolean;
}) {
  const resend = getResend();
  const sessionsHtml = data.sessions
    .map((s) => `<p style="margin:4px 0;">${formatSessionDetailsForEmail(s.sessionDetails)}${s.sessionPrice ? ` — $${fmtMoney(s.sessionPrice)}` : ""}</p>`)
    .join("");
  const closingNote = data.isRescheduleTopup
    ? `<p style="color: #999; font-size: 13px;">This was a reschedule's price-increase topup that was never completed — their ORIGINAL session is untouched and still fully booked, exactly as it was before they started. No charge was made, nothing to refund, nothing to fix.</p>`
    : `<p style="color: #999; font-size: 13px;">They were sent to Stripe to pay but never finished — no charge was made, this booking was never confirmed, and the slot has already been released.</p>`;
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Abandoned Checkout: ${data.parentName}`,
    html: `
      <h2>Checkout Started, Never Completed</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      ${data.phone ? `<p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>` : ""}
      ${data.kids ? `<p><strong>Players:</strong> ${escapeHtml(data.kids)}</p>` : ""}
      <p><strong>Session${data.sessions.length > 1 ? "s" : ""}:</strong></p>
      ${sessionsHtml}
      ${closingNote}
    `,
  });
  if (result.error) console.error("Resend abandoned-checkout email error:", result.error);
}

// Admin-only — same as above, for a monthly package enrollment that never
// completed checkout.
export async function sendAbandonedPackageEmail(data: {
  parentName: string;
  email: string;
  phone?: string | null;
  packageType: number;
  monthYear: string;
}) {
  const resend = getResend();
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Abandoned Package Checkout: ${data.parentName}`,
    html: `
      <h2>Package Checkout Started, Never Completed</h2>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      ${data.phone ? `<p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>` : ""}
      <p><strong>Package:</strong> ${data.packageType}-session monthly plan — ${data.monthYear}</p>
      <p style="color: #999; font-size: 13px;">No charge was made and this package was never activated.</p>
    `,
  });
  if (result.error) console.error("Resend abandoned-package email error:", result.error);
}

// Notifies a part-time trainer (not Artemios — he already gets every admin
// notification) that a session on THEIR schedule was just booked. Deliberately
// light — just who/what/when/where, none of the financial detail the admin
// email carries, since a trainer doesn't need Stripe/payment specifics to
// show up and coach. Silent no-op territory (never called) for any trainer
// with no email on file — see notifyTrainerOfNewBooking in trainer-notify.ts.
export async function sendTrainerNewBookingEmail(data: {
  to: string;
  trainerName: string;
  parentName: string;
  kids?: string;
  sessionLabel: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
}) {
  const resend = getResend();
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.to,
    subject: `New Booking: ${data.sessionLabel} — ${data.date}`,
    html: `
      <h2>New Booking on Your Schedule</h2>
      <p>Hi ${escapeHtml(data.trainerName)},</p>
      <p>A new session was just booked with you.</p>
      <p><strong>Session:</strong> ${escapeHtml(data.sessionLabel)}</p>
      <p><strong>When:</strong> ${escapeHtml(data.date)}, ${escapeHtml(data.startTime)}–${escapeHtml(data.endTime)}</p>
      <p><strong>Where:</strong> ${escapeHtml(data.location)}</p>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      ${data.kids ? `<p><strong>Player(s):</strong> ${escapeHtml(data.kids)}</p>` : ""}
      <p style="color: #999; font-size: 13px;">— Mesa Basketball Training</p>
    `,
  });
  if (result.error) console.error("Resend trainer-new-booking email error:", result.error);
}

// Same population/purpose as sendTrainerNewBookingEmail — this session is
// gone from their schedule now.
export async function sendTrainerCancellationEmail(data: {
  to: string;
  trainerName: string;
  parentName: string;
  sessionLabel: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
}) {
  const resend = getResend();
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.to,
    subject: `Cancelled: ${data.sessionLabel} — ${data.date}`,
    html: `
      <h2>Session Cancelled</h2>
      <p>Hi ${escapeHtml(data.trainerName)},</p>
      <p>This session was just cancelled — it's off your schedule.</p>
      <p><strong>Session:</strong> ${escapeHtml(data.sessionLabel)}</p>
      <p><strong>Was:</strong> ${escapeHtml(data.date)}, ${escapeHtml(data.startTime)}–${escapeHtml(data.endTime)} at ${escapeHtml(data.location)}</p>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p style="color: #999; font-size: 13px;">— Mesa Basketball Training</p>
    `,
  });
  if (result.error) console.error("Resend trainer-cancellation email error:", result.error);
}

// Same population/purpose again — the session moved to a new date/time/
// location rather than disappearing outright.
export async function sendTrainerRescheduleEmail(data: {
  to: string;
  trainerName: string;
  parentName: string;
  sessionLabel: string;
  oldDate: string;
  oldStartTime: string;
  oldEndTime: string;
  newDate: string;
  newStartTime: string;
  newEndTime: string;
  location: string;
}) {
  const resend = getResend();
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.to,
    subject: `Rescheduled: ${data.sessionLabel} — now ${data.newDate}`,
    html: `
      <h2>Session Rescheduled</h2>
      <p>Hi ${escapeHtml(data.trainerName)},</p>
      <p>This session moved to a new time.</p>
      <p><strong>Session:</strong> ${escapeHtml(data.sessionLabel)}</p>
      <p><strong>Was:</strong> ${escapeHtml(data.oldDate)}, ${escapeHtml(data.oldStartTime)}–${escapeHtml(data.oldEndTime)}</p>
      <p><strong>Now:</strong> ${escapeHtml(data.newDate)}, ${escapeHtml(data.newStartTime)}–${escapeHtml(data.newEndTime)} at ${escapeHtml(data.location)}</p>
      <p><strong>Parent:</strong> ${escapeHtml(data.parentName)}</p>
      <p style="color: #999; font-size: 13px;">— Mesa Basketball Training</p>
    `,
  });
  if (result.error) console.error("Resend trainer-reschedule email error:", result.error);
}

// The day-of/night-before "spots open" awareness email — sent to EVERY
// opted-in parent whose saved athlete fits a group running in this window
// AND isn't already registered for that specific session (reminding someone
// of a session they already booked is just spam — see the exclusion filter
// in reminder-emails.ts). One email per parent. Session-first, not
// athlete-first: two siblings matching the exact same session collapse into
// one card listing both names ("Athlete One & Athlete Two") instead of two
// near-identical cards — less to read reads as more urgent, not less.
// Branded (logo + navy/gold theme, matching the live site's actual current
// palette — src/app/globals.css, not the brown/gold one described in
// CLAUDE.md, which is stale).
// Not BCC'd to Artemios individually — with 10-15+ parents matched per run
// that would flood his inbox with one copy each. He gets a single
// consolidated summary instead, see sendReminderEmailAdminSummary below.
//
// This is a FULL html document (doctype/html/head/body), unlike every other
// email in this file which sends a bare fragment — needed because Outlook
// (web and new desktop) auto-recolors light background colors in its own
// dark mode, which turned the logo's white backing circle black and washed
// out the navy/cream palette (confirmed via a real screenshot). The <head>
// carries a `color-scheme` opt-out plus `[data-ogsc]` overrides — the
// attribute Outlook itself stamps on elements once it has dark-mode-
// recolored them — that force the real colors back. This is the
// established fix for this exact, well-documented Outlook behavior.
export async function sendReminderEmail(data: {
  to: string;
  parentName: string;
  // Every session in one run shares the same date (see
  // reminder-emails.ts) — true for the 9am run (covers later TODAY), false
  // for the 6pm run (covers TOMORROW morning).
  isToday: boolean;
  sessions: {
    group: string;
    // Pre-formatted display strings — date/time formatting is the caller's
    // job (src/lib/reminder-emails.ts), this function only interpolates.
    dateLabel: string;
    timeLabel: string;
    location: string;
    athleteNames: string[];
  }[];
}) {
  const resend = getResend();
  const whenLabel = data.isToday ? "Today" : "Tomorrow";
  const unsubscribeUrl = buildUnsubscribeUrl(BASE_URL, data.to);

  const sessionBlocks = data.sessions
    .map(
      (s) => `
        <div class="mesa-session-card" style="background: #ffffff; border: 1px solid #e5decf; border-left: 4px solid #d4af37; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px;">
          <p class="mesa-navy-text" style="margin: 0 0 6px; color: #091530; font-size: 15px; font-weight: bold;">${s.athleteNames.map(escapeHtml).join(" &amp; ")}</p>
          <p class="mesa-body-text" style="margin: 0; color: #3a3a3a; font-size: 13px; line-height: 1.5;">
            <strong class="mesa-navy-text" style="color: #091530;">${escapeHtml(s.group)}</strong><br/>
            ${escapeHtml(s.dateLabel)}, ${escapeHtml(s.timeLabel)} &middot; ${escapeHtml(s.location)}
          </p>
        </div>`
    )
    .join("");

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: data.to,
    subject: `⏰ Spots Open ${whenLabel} — Mesa Basketball Training`,
    // Gmail/Yahoo/Apple Mail read this to show their own built-in
    // "Unsubscribe" button next to the sender, and (per RFC 8058) require it
    // on mail that reads as bulk/promotional or risk bulk-foldering the
    // sender entirely — this is a recurring "Book Now" nudge, exactly that
    // category. List-Unsubscribe-Post opts into true one-click (POST,
    // no confirmation page) rather than just linking the URL.
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>Mesa Basketball Training</title>
<style>
  /* Belt-and-suspenders against client dark-mode auto-recoloring, which
     doesn't reliably respect the color-scheme meta tags above in every
     client (confirmed against a real Outlook/Chrome screenshot where the
     whole navy/cream palette got muted despite them):
     1) [data-ogsc] is the attribute Outlook (web + new desktop) stamps on
        elements it has dark-mode-recolored — these force the real
        light-mode colors back for that mechanism specifically.
     2) prefers-color-scheme:dark re-asserts the same light colors for
        clients using the standard CSS media-query mechanism instead
        (Apple Mail, Gmail app, Yahoo). */
  [data-ogsc] .mesa-outer-bg, [data-ogsc] .mesa-outer-bg td { background-color: #091530 !important; }
  [data-ogsc] .mesa-card-bg { background-color: #0f1f42 !important; }
  [data-ogsc] .mesa-content-bg { background-color: #fffbeb !important; }
  [data-ogsc] .mesa-session-card { background-color: #ffffff !important; }
  [data-ogsc] .mesa-cta-bg { background-color: #d4af37 !important; }
  [data-ogsc] .mesa-gold-text { color: #d4af37 !important; }
  [data-ogsc] .mesa-navy-text { color: #091530 !important; }
  [data-ogsc] .mesa-body-text { color: #3a3a3a !important; }
  [data-ogsc] .mesa-muted-text { color: #7d8bab !important; }
  @media (prefers-color-scheme: dark) {
    .mesa-outer-bg, .mesa-outer-bg td { background-color: #091530 !important; }
    .mesa-card-bg { background-color: #0f1f42 !important; }
    .mesa-content-bg { background-color: #fffbeb !important; }
    .mesa-session-card { background-color: #ffffff !important; }
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
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="mesa-card-bg" style="max-width: 560px; margin: 0 auto; background: #0f1f42; border-radius: 12px; overflow: hidden; border: 1px solid #1e3a6e;">
          <tr>
            <td class="mesa-outer-bg" style="background: #091530; padding: 28px 24px; text-align: center; border-bottom: 2px solid #d4af37;">
              <!-- White circle is baked directly into this image's pixels
                   (see public/logo-circle.png, generated from logo.png) —
                   not a CSS background-color — so no client's dark-mode
                   color remapping can touch it, unlike the previous
                   background-color-behind-a-transparent-logo approach
                   that Outlook was recoloring black. -->
              <img src="${BASE_URL}/logo-circle.png" width="72" height="72" alt="Mesa Basketball Training" style="display: block; margin: 0 auto;" />
              <p class="mesa-gold-text" style="margin: 10px 0 0; color: #d4af37; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; font-weight: bold;">Mesa Basketball Training</p>
            </td>
          </tr>
          <tr>
            <td class="mesa-content-bg" style="padding: 32px 28px; background: #fffbeb;">
              <h1 class="mesa-navy-text" style="margin: 0 0 20px; color: #091530; font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px; font-family: Arial, Helvetica, sans-serif;">
                ⏰ Spots Open ${whenLabel}
              </h1>
              ${sessionBlocks}
              <div style="text-align: center; margin: 28px 0 8px;">
                <a href="${BASE_URL}/schedule" class="mesa-cta-bg mesa-navy-text" style="display: inline-block; background: #d4af37; color: #091530; font-weight: bold; font-size: 15px; padding: 14px 28px; border-radius: 8px; text-decoration: none;">
                  Book Now Before It Fills Up &rarr;
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td class="mesa-outer-bg" style="background: #091530; padding: 20px 24px; text-align: center;">
              <p style="margin: 0 0 6px; color: #fffbeb; font-size: 13px;">
                Questions? Call/text (631) 599-1280 or email <a href="mailto:artemios@mesabasketballtraining.com" class="mesa-gold-text" style="color: #d4af37;">artemios@mesabasketballtraining.com</a>
              </p>
              <p class="mesa-muted-text" style="margin: 0; color: #7d8bab; font-size: 11px;">
                You're getting this because Reminder Emails are on in your <a href="${BASE_URL}/settings" class="mesa-muted-text" style="color: #7d8bab;">account settings</a> — turn them off there, or <a href="${unsubscribeUrl}" class="mesa-muted-text" style="color: #7d8bab;">unsubscribe</a> anytime.
              </p>
            </td>
          </tr>
        </table>
      </div>
</body>
</html>`,
  });
  if (result.error) console.error("Resend reminder email error:", result.error, "to:", data.to);
  return result;
}

// One consolidated email to Artemios per cron run — not a copy of each
// parent email, a single summary of everyone who got one — so he can
// confirm from his own inbox that a run actually fired without getting
// flooded with 10-15+ individual BCCs every time it runs. Sent for every
// real (non-dry-run) run, even when nobody matched, so silence never gets
// mistaken for "it's working."
export async function sendReminderEmailAdminSummary(data: {
  window: "morning" | "evening";
  targetDate: string;
  sessionsInWindow: number;
  parents: {
    email: string;
    parentName: string;
    sessions: { group: string; dateLabel: string; timeLabel: string; location: string; athleteNames: string[] }[];
  }[];
  failedEmails: string[];
}) {
  const resend = getResend();
  const windowLabel = data.window === "morning" ? "Morning (9am)" : "Evening (6pm)";

  const rows = data.parents
    .map((p) => {
      const sessionLines = p.sessions
        .map((s) => `<strong>${s.athleteNames.map(escapeHtml).join(" &amp; ")}</strong> — ${escapeHtml(s.group)}, ${escapeHtml(s.dateLabel)} ${escapeHtml(s.timeLabel)} at ${escapeHtml(s.location)}`)
        .join("<br/>");
      return `
        <tr>
          <td style="padding: 8px 10px; border-bottom: 1px solid #333; vertical-align: top; font-size: 13px;">${escapeHtml(p.parentName || "(no name on file)")}<br/><span style="color: #999;">${escapeHtml(p.email)}</span></td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #333; vertical-align: top; font-size: 13px;">${sessionLines}</td>
        </tr>`;
    })
    .join("");

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: ARTEMI_EMAIL,
    subject: `Reminder emails ${data.parents.length > 0 ? "sent" : "ran (no matches)"}: ${windowLabel} — ${data.parents.length} parent${data.parents.length !== 1 ? "s" : ""}`,
    html: `
      <h2>Reminder email run complete</h2>
      <p><strong>Window:</strong> ${windowLabel}</p>
      <p><strong>Covering:</strong> ${escapeHtml(data.targetDate)}</p>
      <p><strong>Sessions in window:</strong> ${data.sessionsInWindow}</p>
      <p><strong>Parents emailed:</strong> ${data.parents.length}</p>
      ${data.failedEmails.length > 0 ? `<p style="color: #f87171;"><strong>Failed to send (${data.failedEmails.length}):</strong> ${data.failedEmails.map(escapeHtml).join(", ")}</p>` : ""}
      ${
        data.parents.length > 0
          ? `<table cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-top: 12px;">
              <tr><th align="left" style="padding: 8px 10px; border-bottom: 2px solid #555; font-size: 12px;">Parent</th><th align="left" style="padding: 8px 10px; border-bottom: 2px solid #555; font-size: 12px;">Athlete(s) &amp; Session(s)</th></tr>
              ${rows}
            </table>`
          : `<p style="color: #999;">No saved athletes matched a session in this window.</p>`
      }
    `,
  });
  if (result.error) console.error("Resend reminder-email admin summary error:", result.error);
}
