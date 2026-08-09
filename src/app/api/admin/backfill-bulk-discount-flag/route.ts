import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { getWeeklySchedule } from "@/lib/sheets";

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// One-time (safe to re-run) backfill for the new registrations.is_bulk_discounted
// column, which defaults to false for every row that already existed when the
// migration ran. Without this, every weekly booking made bulk-discounted
// BEFORE that migration but still upcoming (not yet cancelled/completed)
// would lose its correct late-cancel forfeiture treatment the moment the new
// code shipped — the exact regression this backfill exists to close. Only
// touches still-upcoming ("confirmed") weekly registrations; past ones don't
// matter since whatever cancel/reschedule decision applied to them (if any)
// already happened. Uses the same live-rate comparison the OLD code used —
// accepted here as a one-time best-effort reconciliation against the ONLY
// data available, not as an ongoing pattern (the whole point of the new
// column is to stop relying on this comparison going forward).
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = getSupabaseAdmin();

  const { data: regs, error: regsError } = await supabase
    .from("registrations")
    .select("id, booked_group, booked_date, booked_start_time, total_participants, session_price, session_details, is_bulk_discounted")
    .eq("type", "weekly")
    .eq("status", "confirmed")
    .eq("is_bulk_discounted", false); // only rows the migration defaulted — never touch one already correctly set true
  if (regsError) return NextResponse.json({ error: regsError.message }, { status: 500 });

  const sessions = await getWeeklySchedule({ noCache: true });

  let updated = 0;
  const errors: string[] = [];
  for (const reg of regs || []) {
    if (reg.session_price === null || !reg.booked_date || !reg.booked_start_time) continue;
    const groupLabel = reg.booked_group || (reg.session_details || "").split(" — ")[0] || "";
    const match = sessions.find((s) => s.group === groupLabel && s.date === reg.booked_date && s.startTime === reg.booked_start_time);
    if (!match) continue;
    const standardRate = match.price * (reg.total_participants || 1);
    if (reg.session_price >= standardRate) continue; // not discounted — leave as false

    const { error: updateError } = await supabase
      .from("registrations")
      .update({ is_bulk_discounted: true })
      .eq("id", reg.id);
    if (updateError) {
      errors.push(`registration ${reg.id}: ${updateError.message}`);
      continue;
    }
    updated++;
  }

  return NextResponse.json({ registrationsConsidered: (regs || []).length, updated, errors });
}
