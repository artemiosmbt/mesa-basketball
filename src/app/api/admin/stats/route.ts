import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";

// Replaces the old client-side `stats` useMemo, which needed the entire
// registrations table already loaded in the browser just to `.length` a
// few filtered counts. Admin-only, same as the stats tiles themselves
// (trainer-tier accounts never see them) — so no trainer-role scoping
// needed here, only the optional `trainer` param mirroring the dashboard's
// own trainer-filter dropdown (an admin narrowing the whole page to one
// trainer's numbers, not a security boundary).
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const trainer = new URL(req.url).searchParams.get("trainer");

  function withTrainer<T extends { ilike: (col: string, val: string) => T }>(query: T): T {
    return trainer ? query.ilike("booked_trainer", trainer) : query;
  }

  const [{ count: total }, { count: confirmed }, { count: cancelled }, { count: camps }, { count: groups }] = await Promise.all([
    withTrainer(supabase.from("registrations").select("*", { count: "exact", head: true })),
    withTrainer(supabase.from("registrations").select("*", { count: "exact", head: true }).eq("status", "confirmed")),
    withTrainer(supabase.from("registrations").select("*", { count: "exact", head: true }).eq("status", "cancelled")),
    withTrainer(supabase.from("registrations").select("*", { count: "exact", head: true }).eq("type", "camp").eq("status", "confirmed")),
    withTrainer(supabase.from("registrations").select("*", { count: "exact", head: true }).eq("type", "weekly").eq("status", "confirmed")),
  ]);

  return NextResponse.json({
    total: total || 0,
    confirmed: confirmed || 0,
    cancelled: cancelled || 0,
    camps: camps || 0,
    groups: groups || 0,
  });
}
