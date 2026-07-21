import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";


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
    .select("id, referral_code, total_participants, session_price, created_at")
    .eq("type", "weekly")
    .is("session_price", null)
    .not("referral_code", "is", null)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ updated: 0, message: "Nothing to backfill" });

  // referral_code alone is NOT a unique purchase id — it's the client's
  // permanent code, identical across every weekly booking they've ever made
  // (same lesson learned as admin/update-payment.ts). Grouping purely by
  // code would blend two unrelated purchase batches from the same client
  // together, miscounting the volume-discount tier and writing one wrong
  // blended price across both. A single checkout's rows are always created
  // within milliseconds of each other, so within each referral_code, split
  // into a new group whenever the gap to the previous row exceeds 5 minutes.
  const BATCH_GAP_MS = 5 * 60 * 1000;
  const byCode = new Map<string, typeof rows>();
  for (const r of rows) {
    const code = r.referral_code as string;
    const existing = byCode.get(code);
    if (existing) existing.push(r);
    else byCode.set(code, [r]);
  }

  const groups = new Map<string, { ids: string[]; totalParticipants: number }>();
  for (const [code, codeRows] of byCode) {
    let batchIndex = 0;
    let lastCreatedAt: number | null = null;
    for (const r of codeRows) {
      const createdAt = new Date(r.created_at).getTime();
      if (lastCreatedAt !== null && createdAt - lastCreatedAt > BATCH_GAP_MS) batchIndex++;
      lastCreatedAt = createdAt;
      const key = `${code}#${batchIndex}`;
      const existing = groups.get(key);
      if (existing) {
        existing.ids.push(r.id);
        existing.totalParticipants = Math.max(existing.totalParticipants, r.total_participants || 1);
      } else {
        groups.set(key, { ids: [r.id], totalParticipants: r.total_participants || 1 });
      }
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
