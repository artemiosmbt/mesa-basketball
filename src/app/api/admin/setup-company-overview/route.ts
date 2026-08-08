import { NextRequest, NextResponse } from "next/server";
import { setupCompanyOverview } from "@/lib/company-overview-setup";

// ONE-TIME structural setup for the company revenue/profit view — not a
// recurring cron (contrast with /api/cron/payroll-sync, which runs daily).
// Meant to be triggered once by hand after this deploys. CRON_SECRET-gated
// rather than admin-session-gated so it can be triggered directly with curl,
// matching every other automation route in this codebase.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // TEMPORARY diagnostic — remove once the mismatch is found. Exposes only
    // short hash prefixes (never the raw secret) so we can compare what the
    // request actually sent against what this deployment actually has
    // configured, without ever putting a real credential in a response body.
    const hash = async (s: string) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    };
    return NextResponse.json(
      {
        error: "Unauthorized",
        debug: {
          receivedHeaderPresent: !!authHeader,
          receivedHeaderLength: authHeader?.length ?? 0,
          receivedHeaderHashPrefix: authHeader ? await hash(authHeader) : null,
          expectedHeaderLength: `Bearer ${process.env.CRON_SECRET ?? ""}`.length,
          expectedHeaderHashPrefix: await hash(`Bearer ${process.env.CRON_SECRET ?? ""}`),
          cronSecretConfigured: !!process.env.CRON_SECRET,
        },
      },
      { status: 401 }
    );
  }

  try {
    const result = await setupCompanyOverview();
    console.log("Company overview setup result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("Company overview setup failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
