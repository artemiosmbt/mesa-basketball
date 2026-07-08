import { NextRequest, NextResponse } from "next/server";
import { findReferrerInfoByCode, isNewClient } from "@/lib/supabase";

// Public, read-only lookup so the booking form can validate a referral code before
// letting the client submit — mirrors the exact eligibility rule /api/register uses
// when actually crediting a referral, so "valid here" always means "will apply there."
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")?.trim();
  const email = req.nextUrl.searchParams.get("email")?.trim();
  const phone = req.nextUrl.searchParams.get("phone")?.trim();

  if (!code) return NextResponse.json({ valid: false, reason: "not_found" });

  const info = await findReferrerInfoByCode(code).catch(() => null);
  if (!info) {
    return NextResponse.json({ valid: false, reason: "not_found" });
  }
  if (email && info.email.toLowerCase().trim() === email.toLowerCase().trim()) {
    return NextResponse.json({ valid: false, reason: "self" });
  }
  if (email && phone) {
    const newClient = await isNewClient(email, phone).catch(() => true);
    if (!newClient) {
      return NextResponse.json({ valid: false, reason: "not_eligible" });
    }
  }

  return NextResponse.json({ valid: true, referrerName: info.name });
}
