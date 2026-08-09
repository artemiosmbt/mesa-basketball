import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth";
import { runMonthlyRevenueSync } from "@/lib/monthly-revenue-sync";

// Rebuilds the "Mesa Monthly Revenue" tracker (a separate document from the
// payroll sheet — see monthly-revenue-sync.ts) once daily. Each run rebuilds
// every month's tab from scratch, so this stays correct even after a
// same-day status change (refund, no-show correction, etc.) without any
// incremental-sync bookkeeping.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runMonthlyRevenueSync();
    console.log("Monthly revenue sync result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("Monthly revenue sync failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
