import { NextRequest, NextResponse } from "next/server";
import { getAccountCreditBalance } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) return NextResponse.json({ balance: 0 });
  const balance = await getAccountCreditBalance(email.toLowerCase().trim()).catch(() => 0);
  return NextResponse.json({ balance });
}
