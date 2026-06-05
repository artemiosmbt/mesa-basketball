import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { countConfirmedPrivateSessions, setPackageSessions } from "@/lib/supabase";

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

  // Recalculate sessions_used and attach booked_dates found for each package (for diagnostics)
  const normalizedPackages = await Promise.all(packages.map(async (pkg) => {
    const { data: regs } = await supabase
      .from("registrations")
      .select("booked_date")
      .eq("email", pkg.email.toLowerCase().trim())
      .eq("status", "confirmed")
      .in("type", ["private", "group-private"])
      .not("booked_date", "is", null)
      .order("booked_date", { ascending: true });

    const bookedDates: string[] = (regs || []).map((r: { booked_date: string }) => r.booked_date);

    const actual = await countConfirmedPrivateSessions(pkg.email, pkg.month_year, pkg.phone);
    const corrected = Math.min(actual, pkg.package_type);
    if (corrected !== pkg.sessions_used) {
      await setPackageSessions(pkg.id, corrected);
      pkg.sessions_used = corrected;
    }
    return { ...pkg, booked_dates: bookedDates };
  }));

  return NextResponse.json({ packages: normalizedPackages });
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
