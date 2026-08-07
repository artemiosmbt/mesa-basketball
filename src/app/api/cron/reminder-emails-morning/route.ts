import { NextRequest, NextResponse } from "next/server";
import { runReminderEmailWindow } from "@/lib/reminder-emails";

// Runs at 9:00am ET (vercel.json: 13:00 UTC) — covers every group session
// running that same day starting at 12:00pm or later.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runReminderEmailWindow("morning", { dryRun });
  return NextResponse.json(result);
}
