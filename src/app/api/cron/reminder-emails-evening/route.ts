import { NextRequest, NextResponse } from "next/server";
import { runReminderEmailWindow } from "@/lib/reminder-emails";
import { verifyAdmin, verifyCronSecret } from "@/lib/auth";

// Runs at 6:00pm ET (vercel.json: 22:00 UTC) — covers every group session
// running before 12:00pm the next day.
export async function GET(req: NextRequest) {
  // The real Vercel Cron invocation authenticates with CRON_SECRET; a
  // logged-in admin session is also accepted so Artemios can manually
  // trigger/test this (dry-run or otherwise) from the dashboard without
  // needing to go dig the raw secret out of Vercel's env vars.
  if (!verifyCronSecret(req) && !(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runReminderEmailWindow("evening", { dryRun });
  return NextResponse.json(result);
}
