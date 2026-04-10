import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await authClient.auth.getUser(token);
  return user?.email === ADMIN_EMAIL ? user : null;
}

export async function GET(req: NextRequest) {
  if (!await verifyAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data, error } = await getSupabase()
    .from("drills")
    .select("*")
    .order("category")
    .order("level")
    .order("difficulty");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drills: data });
}

export async function POST(req: NextRequest) {
  if (!await verifyAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json();
  const { data, error } = await getSupabase()
    .from("drills")
    .insert(body)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drill: data });
}
