import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { countPackageSessionsUsed, setPackageSessions } from "@/lib/supabase";


export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const packages = data || [];

  // Recalculate sessions_used from registrations actually tagged with this
  // package's id on every load — exact, unlike the old "any private session
  // this email had this month" guess (which could count an individually-
  // paid overflow session against the package that never covered it).
  await Promise.all(packages.map(async (pkg) => {
    const actual = await countPackageSessionsUsed(pkg.id);
    if (actual !== pkg.sessions_used) {
      await setPackageSessions(pkg.id, actual);
      pkg.sessions_used = actual;
    }
  }));

  return NextResponse.json({ packages });
}

export async function DELETE(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Registrations reference a package by package_id, and there's no refund
  // logic anywhere in this route — deleting a package that still has real
  // bookings against it would both orphan those rows (pointing at a
  // package_id that no longer exists) and make whatever was collected for
  // it disappear with no trail. This only blocks that specific case, not a
  // genuinely-erroneous/unused package row, which is exactly what this
  // button is for.
  const sessionsUsed = await countPackageSessionsUsed(id);
  if (sessionsUsed > 0) {
    return NextResponse.json(
      { error: `This package has ${sessionsUsed} session${sessionsUsed !== 1 ? "s" : ""} already booked against it — cancel or reassign those bookings first, or handle the refund manually before deleting.` },
      { status: 400 }
    );
  }

  const { error } = await supabase.from("monthly_packages").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function PATCH(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, sessions_used } = await req.json();
  if (!id || typeof sessions_used !== "number") {
    return NextResponse.json({ error: "Missing id or sessions_used" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase
    .from("monthly_packages")
    .update({ sessions_used })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, is_paid } = await req.json();
  if (!id || typeof is_paid !== "boolean") {
    return NextResponse.json({ error: "Missing id or is_paid" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase
    .from("monthly_packages")
    .update({ is_paid })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
