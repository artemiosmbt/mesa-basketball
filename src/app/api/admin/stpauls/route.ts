import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin, verifyDashboardAccess } from "@/lib/auth";
import { requireTrainerNameConfigured } from "@/lib/admin-data-scope";
import { ALL_TRAINER_NAMES, trainerNamesMatch } from "@/lib/trainers";
import { formatDateLong, formatTime12, STPAULS_LOCATION, STPAULS_SESSION_LABEL } from "@/lib/stpauls";
import { notifyTrainerOfCancellation, notifyTrainerOfNewBooking } from "@/lib/trainer-notify";

// Admin dashboard's St. Paul's Practices tab. Reading: the admin sees
// every practice; a trainer only ever receives practices assigned to them
// (the elevated overseer sees every assigned one). Writing — assigning a
// trainer, cancelling — is admin-only.

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

const hhmm = (t: string) => (t || "").slice(0, 5);

export async function GET(req: NextRequest) {
  const ctx = await verifyDashboardAccess(req);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const misconfigured = requireTrainerNameConfigured(ctx);
  if (misconfigured) return misconfigured;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  let query = getSupabaseAdmin().from("stpauls_practices").select("*").eq("status", "booked").order("practice_date").order("start_time");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) query = query.gte("practice_date", from);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) query = query.lte("practice_date", to);
  if (ctx.role !== "admin") query = query.not("assigned_trainer", "is", null);

  const { data, error } = await query;
  if (error) {
    console.error("St. Paul's admin load failed:", error);
    return NextResponse.json({ error: "Couldn't load practices." }, { status: 500 });
  }

  const rows = (data || []).filter((p) => ctx.role !== "trainer" || trainerNamesMatch(p.assigned_trainer, ctx.trainerName));
  return NextResponse.json({
    practices: rows.map((p) => ({
      id: p.id,
      date: p.practice_date,
      start: hhmm(p.start_time),
      end: hhmm(p.end_time),
      teamName: p.team_name,
      coaches: p.coaches || [],
      assignedTrainer: p.assigned_trainer,
      createdAt: p.created_at,
    })),
  });
}

async function loadPractice(id: string) {
  const { data } = await getSupabaseAdmin().from("stpauls_practices").select("*").eq("id", id).maybeSingle();
  return data;
}

function notifyParams(p: { team_name: string; practice_date: string; start_time: string; end_time: string }, trainer: string) {
  return {
    trainer,
    parentName: `${p.team_name} (team practice — $60 cash at practice)`,
    sessionLabel: STPAULS_SESSION_LABEL,
    date: formatDateLong(p.practice_date),
    startTime: formatTime12(hhmm(p.start_time)),
    endTime: formatTime12(hhmm(p.end_time)),
    location: STPAULS_LOCATION,
  };
}

// Assign (or clear, with null) the trainer running a practice.
export async function PATCH(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const requested = typeof body?.assignedTrainer === "string" ? body.assignedTrainer.trim() : "";
  const trainer = requested ? ALL_TRAINER_NAMES.find((n) => trainerNamesMatch(n, requested)) : null;
  if (!id || (requested && !trainer)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const practice = await loadPractice(id);
  if (!practice || practice.status !== "booked") return NextResponse.json({ error: "Practice not found." }, { status: 404 });

  const previous: string | null = practice.assigned_trainer;
  const { error } = await getSupabaseAdmin().from("stpauls_practices").update({ assigned_trainer: trainer }).eq("id", id).eq("status", "booked");
  if (error) {
    console.error("St. Paul's assign failed:", error);
    return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
  }

  if (!trainerNamesMatch(previous, trainer)) {
    await Promise.allSettled([
      previous ? notifyTrainerOfCancellation(notifyParams(practice, previous)) : Promise.resolve(),
      trainer ? notifyTrainerOfNewBooking(notifyParams(practice, trainer)) : Promise.resolve(),
    ]);
  }
  return NextResponse.json({ ok: true, assignedTrainer: trainer });
}

// Cancel a practice (coaches can't — they text Artemios, who cancels here).
// Frees the time for another team.
export async function DELETE(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") || "";
  const practice = id ? await loadPractice(id) : null;
  if (!practice || practice.status !== "booked") return NextResponse.json({ error: "Practice not found." }, { status: 404 });

  const { error } = await getSupabaseAdmin().from("stpauls_practices")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", id).eq("status", "booked");
  if (error) {
    console.error("St. Paul's cancel failed:", error);
    return NextResponse.json({ error: "Couldn't cancel." }, { status: 500 });
  }
  if (practice.assigned_trainer) {
    await notifyTrainerOfCancellation(notifyParams(practice, practice.assigned_trainer)).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
