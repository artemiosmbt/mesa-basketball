import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, ADMIN_EMAIL } from "@/lib/auth";
import { sendReminderEmail } from "@/lib/email";

// Sends a real copy of the reminder email to Artemios only, using
// caller-supplied sample data, so he can see the actual design/content in
// his inbox before trusting a live run. Never touches real client data or
// sends to any parent.
// body: { parentName?: string; athletes: { athleteName: string; sessions: { group: string; dateLabel: string; timeLabel: string; location: string }[] }[] }
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  if (!Array.isArray(body.athletes) || body.athletes.length === 0) {
    return NextResponse.json({ error: "athletes is required." }, { status: 400 });
  }

  await sendReminderEmail({
    to: ADMIN_EMAIL,
    parentName: body.parentName || "Test Parent",
    athletes: body.athletes,
  });

  return NextResponse.json({ ok: true });
}
