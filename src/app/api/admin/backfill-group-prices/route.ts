import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email === ADMIN_EMAIL;
}

// Backfills session_price for past weekly group session bookings that had volume discounts
// but never stored the discounted price (registered before that fix was in place).
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch all weekly sessions that are missing a stored price
  const { data: rows, error } = await supabase
    .from("registrations")
    .select("id, referral_code, total_participants, session_price")
    .eq("type", "weekly")
    .is("session_price", null)
    .not("referral_code", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ updated: 0, message: "Nothing to backfill" });

  // Group by referral_code to count sessions per booking group
  const groups = new Map<string, { ids: string[]; totalParticipants: number }>();
  for (const r of rows) {
    const code = r.referral_code as string;
    const existing = groups.get(code);
    if (existing) {
      existing.ids.push(r.id);
      existing.totalParticipants = Math.max(existing.totalParticipants, r.total_participants || 1);
    } else {
      groups.set(code, { ids: [r.id], totalParticipants: r.total_participants || 1 });
    }
  }

  // Update rows that qualify for a volume discount (4+ sessions booked together)
  let updated = 0;
  const skipped: string[] = [];
  for (const [code, { ids, totalParticipants }] of groups) {
    const count = ids.length;
    if (count < 4) {
      skipped.push(`${code} (${count} sessions — no discount)`);
      continue;
    }
    const discountRate = count >= 8 ? 0.15 : 0.10;
    const discountedPrice = Math.round(50 * totalParticipants * (1 - discountRate));
    const { error: updateError } = await supabase
      .from("registrations")
      .update({ session_price: discountedPrice })
      .in("id", ids);
    if (updateError) {
      return NextResponse.json({ error: `Failed to update group ${code}: ${updateError.message}` }, { status: 500 });
    }
    updated += ids.length;
  }

  return NextResponse.json({
    updated,
    skipped: skipped.length,
    message: `Backfilled ${updated} session rows. ${skipped.length} group(s) with fewer than 4 sessions were left at full price.`,
  });
}
