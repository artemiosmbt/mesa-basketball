import { NextRequest, NextResponse } from "next/server";
import { getReferralCredits } from "@/lib/supabase";
import { resolveRequestEmail } from "@/lib/request-email";

export async function GET(req: NextRequest) {
  const email = await resolveRequestEmail(req);
  if (!email) return NextResponse.json({ credits: 0 });
  const credits = await getReferralCredits(email).catch(() => 0);
  return NextResponse.json({ credits });
}
