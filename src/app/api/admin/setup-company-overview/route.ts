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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
