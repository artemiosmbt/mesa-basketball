import type { NextConfig } from "next";

// No middleware.ts and no headers were set anywhere in this app — every
// page (including /login, /signup, and the token-based /booking/[token]
// booking-management page) could be embedded in an attacker's iframe with
// no browser-level protection (clickjacking: disguising a real "Cancel
// booking" or "Log in" button under an invisible overlay). Fonts are
// self-hosted via next/font (no external font CDN), no client-side
// Stripe.js or other embedded third-party widget runs anywhere (checkout
// is a full-page redirect to Stripe-hosted Checkout), so this CSP doesn't
// need to allowlist anything beyond 'self'.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
