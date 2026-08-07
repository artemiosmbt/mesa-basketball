import { NextRequest, NextResponse } from "next/server";
import { runReminderEmailWindow } from "@/lib/reminder-emails";

// Runs at 6:00pm ET (vercel.json: 22:00 UTC) — covers every group session
// running before 12:00pm the next day.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runReminderEmailWindow("evening", { dryRun });
  return NextResponse.json(result);
}
