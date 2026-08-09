import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authClient } from "@/lib/auth";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await authClient.auth.getUser(token);
  return user;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabase();
  let { data } = await supabase.from("user_training_profiles").select("*").eq("user_id", user.id).single();

  // Auto-create profile if it doesn't exist
  if (!data) {
    const { data: created } = await supabase
      .from("user_training_profiles")
      .insert({ user_id: user.id })
      .select()
      .single();
    data = created;
  }

  return NextResponse.json({ profile: data });
}

export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  // Strip identity fields before applying — the WHERE clause already scopes
  // this to the caller's own row, but a body containing user_id would still
  // get applied as a SET, silently reassigning ownership of that row
  // (id/created_at are similarly not the caller's to set).
  const safeBody = { ...body };
  delete safeBody.user_id;
  delete safeBody.id;
  delete safeBody.created_at;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("user_training_profiles")
    .update({ ...safeBody, updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile: data });
}
