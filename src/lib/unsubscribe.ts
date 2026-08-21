import { createHmac, timingSafeEqual } from "crypto";

// Signed (not stored) unsubscribe tokens: HMAC over the recipient's email,
// keyed off RESEND_API_KEY with a namespace suffix. Verifying is a pure
// recompute-and-compare — no DB round trip, no new column/migration needed,
// and a link keeps working even if the profile row moves. Mirrors the only
// two token patterns already in this codebase (registrations.manage_token,
// workout_sessions.share_token) in spirit — opaque, unguessable, looked up
// by exact match — but stateless since there's no natural existing column
// to lean on for a mailing-list unsubscribe.
function secretKey(): string {
  const base = process.env.RESEND_API_KEY;
  if (!base) throw new Error("RESEND_API_KEY is not configured");
  return `${base}:unsubscribe`;
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export function generateUnsubscribeToken(email: string): string {
  return createHmac("sha256", secretKey()).update(normalizeEmail(email)).digest("hex");
}

// timingSafeEqual requires equal-length buffers — mismatched lengths (e.g. a
// truncated/tampered token) must fail closed here rather than throw.
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  if (!email || !token) return false;
  const expected = Buffer.from(generateUnsubscribeToken(email), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function buildUnsubscribeUrl(baseUrl: string, email: string): string {
  const token = generateUnsubscribeToken(email);
  return `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}
