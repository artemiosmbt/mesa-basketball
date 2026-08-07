import { NextRequest, NextResponse } from "next/server";
import { runPayrollSync } from "@/lib/payroll-sync";

// Sequential Supabase + Sheets API calls across (potentially) dozens of rows
// can run past the platform default — same reasoning as the other cron
// routes, just made explicit here since this one does the most round trips.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runPayrollSync();
    return NextResponse.json(result);
  } catch (err) {
    console.error("Payroll sync failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
