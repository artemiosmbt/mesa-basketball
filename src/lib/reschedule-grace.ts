/**
 * "You started this before the cutoff" tokens.
 *
 * A client who opens their booking at 6:59pm — still outside the 24-hour
 * window — and finishes the change at 7:01pm shouldn't be treated as late.
 * They were on time when they started; the clock just moved while they were
 * picking a new date.
 *
 * So the server hands out a small signed token whenever it serves a booking
 * that is NOT yet late, and honours that token for ten minutes. Finish inside
 * ten minutes and the change counts as on-time. Sit on it for an hour, or a
 * day, and it's worthless — which is what stops anyone opening the page early
 * and strolling back later to dodge the fee.
 *
 * Signed rather than stored: no table, nothing to clean up, and a client can't
 * forge one or stretch its life, because the timestamp is inside the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ON_TIME_GRACE_MS = 10 * 60 * 1000;

function secret(): string {
  // Any server-only secret works — this signs a ten-minute claim about timing,
  // not anything that grants access.
  const s = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!s) throw new Error("No secret available to sign on-time tokens");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Issued only when the booking is genuinely not late yet — see the GET route. */
export function issueOnTimeToken(registrationId: string, now: number = Date.now()): string {
  const payload = `${registrationId}.${now}`;
  return `${now}.${sign(payload)}`;
}

/**
 * True when this token really was issued for this booking, by us, within the
 * last ten minutes.
 */
export function verifyOnTimeToken(
  token: string | undefined | null,
  registrationId: string,
  now: number = Date.now()
): boolean {
  if (!token || typeof token !== "string") return false;
  const [issuedAtRaw, signature] = token.split(".");
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || !signature) return false;
  if (now - issuedAt > ON_TIME_GRACE_MS) return false;
  // A token from the future means a tampered timestamp — a small clock skew
  // allowance keeps a legitimate one from failing.
  if (issuedAt - now > 60 * 1000) return false;

  let expected: string;
  try {
    expected = sign(`${registrationId}.${issuedAt}`);
  } catch {
    return false;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
