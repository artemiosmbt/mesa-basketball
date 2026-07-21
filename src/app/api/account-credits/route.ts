import { NextRequest, NextResponse } from "next/server";
import { getAccountCreditBalance } from "@/lib/supabase";
import { resolveRequestEmail } from "@/lib/request-email";

export async function GET(req: NextRequest) {
  const email = await resolveRequestEmail(req);
  if (!email) return NextResponse.json({ balance: 0 });
  const balance = await getAccountCreditBalance(email).catch(() => 0);
  return NextResponse.json({ balance });
}
