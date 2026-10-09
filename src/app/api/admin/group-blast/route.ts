import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { computeGroupBlast, sendGroupBlast } from "@/lib/group-blast-sms";

// Manual "spots open" text blast for one day.
//
// Admin-only and manual by design: there is deliberately no cron entry for
// this and no CRON_SECRET path, so the only way a text goes out is an
// authenticated admin pressing the button and then confirming. A preview
// never sends anything.
//
// body: { date: "YYYY-MM-DD", confirm?: true }
//   confirm omitted/false -> preview only
//   confirm === true      -> send
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "A date (YYYY-MM-DD) is required." }, { status: 400 });
  }

  try {
    if (body.confirm !== true) {
      const preview = await computeGroupBlast(date);
      return NextResponse.json({ mode: "preview", ...preview });
    }
    const result = await sendGroupBlast(date);
    return NextResponse.json({ mode: "sent", ...result });
  } catch (err) {
    console.error("Group blast failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Group blast failed" },
      { status: 500 }
    );
  }
}
