import { NextRequest, NextResponse } from "next/server";
import { getReferralCredits } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ credits: 0 });
  const credits = await getReferralCredits(email.toLowerCase().trim()).catch(() => 0);
  return NextResponse.json({ credits });
}
