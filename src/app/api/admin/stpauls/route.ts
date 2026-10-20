import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin, verifyDashboardAccess } from "@/lib/auth";
import { requireTrainerNameConfigured } from "@/lib/admin-data-scope";
import { ALL_TRAINER_NAMES, OWNER_TRAINER_NAME, trainerNamesMatch } from "@/lib/trainers";
import { formatDateLong, formatTime12, STPAULS_LOCATION, STPAULS_SESSION_LABEL } from "@/lib/stpauls";
import { sendStPaulsAssignedAdminEmail, sendStPaulsCancelCoachEmail, sendStPaulsConfirmedCoachEmail } from "@/lib/email";
import { sendAdminSMS, sendSMS } from "@/lib/sms";
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

// Text the trainer gets when Artemios assigns them a practice.
function assignedText(p: { team_name: string; practice_date: string; start_time: string; end_time: string; coaches: { name?: string; phone?: string }[] | null }) {
  const coach = (p.coaches || []).find((c) => c?.name || c?.phone);
  const coachLine = coach ? ` Coach: ${[coach.name, coach.phone].filter(Boolean).join(" ")}.` : "";
  return `Mesa: You were assigned a St. Paul's team practice — ${p.team_name}, ${formatDateLong(p.practice_date)} ${formatTime12(hhmm(p.start_time))}-${formatTime12(hhmm(p.end_time))} at ${STPAULS_LOCATION}. Collect $60 cash at practice.${coachLine} It's in your dashboard under St. Paul's Practices.`;
}

// Look up the booking coach's text consent and phone (texts go only to the
// account that booked, and only with consent).
async function bookerTextTarget(p: { booked_by_user_id: string | null; booked_by_email: string; coaches: { phone?: string; email?: string }[] | null }) {
  const coaches = p.coaches || [];
  const { data: booker } = p.booked_by_user_id
    ? await getSupabaseAdmin().from("profiles").select("phone, sms_consent").eq("id", p.booked_by_user_id).maybeSingle()
    : { data: null };
  const phone = coaches.find((c) => c.email === p.booked_by_email)?.phone || booker?.phone || coaches[0]?.phone;
  return booker?.sms_consent && phone ? phone : null;
}

// Assign the trainer running a practice. A coach's booking is a pending
// REQUEST until its first trainer is assigned — that is Artemios's approval,
// and it's when the coaches get their confirmation. After that the trainer
// can be swapped, but not cleared back to pending (cancel it instead).
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
  if (previous && !trainer) {
    return NextResponse.json({ error: "This practice is already confirmed with the coach. Pick a different trainer to swap, or cancel the practice." }, { status: 400 });
  }
  const approving = !previous && !!trainer;
  const { error } = await getSupabaseAdmin().from("stpauls_practices").update({ assigned_trainer: trainer }).eq("id", id).eq("status", "booked");
  if (error) {
    console.error("St. Paul's assign failed:", error);
    return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
  }

  if (!trainerNamesMatch(previous, trainer)) {
    const date = formatDateLong(practice.practice_date);
    const time = `${formatTime12(hhmm(practice.start_time))}–${formatTime12(hhmm(practice.end_time))}`;
    // Approval (first trainer) = the coaches' real confirmation, naming the
    // trainer. A later swap tells them who the new trainer is.
    const swapped = !!previous && !!trainer;
    const coachPhone = trainer ? await bookerTextTarget(practice) : null;
    await Promise.allSettled([
      coachPhone
        ? sendSMS(coachPhone, approving
            ? `Mesa Basketball: CONFIRMED - ${practice.team_name}'s practice on ${date}, ${time} at St. Paul's is confirmed. Your trainer is ${trainer}. $60 cash to your trainer at practice. To cancel or change, text Artemios at (631) 599-1280. Reply STOP to opt out.`
            : `Mesa Basketball: Trainer update - ${practice.team_name}'s practice on ${date}, ${time} at St. Paul's is still confirmed. Your trainer is now ${trainer}. Questions? Text Artemios at (631) 599-1280. Reply STOP to opt out.`)
        : Promise.resolve(),
      ...(trainer
        ? ((practice.coaches || []) as { name?: string; email?: string }[]).filter((c) => c.email)
            .map((c) => sendStPaulsConfirmedCoachEmail({ to: c.email!, coachName: c.name || "Coach", teamName: practice.team_name, date, time, trainerName: trainer, trainerChanged: swapped }))
        : []),
      previous ? notifyTrainerOfCancellation(notifyParams(practice, previous)) : Promise.resolve(),
      trainer ? notifyTrainerOfNewBooking({ ...notifyParams(practice, trainer), smsText: assignedText(practice) }) : Promise.resolve(),
      // Artemios has no trainer contact entry — he gets the same text on his
      // own phone when he assigns himself.
      trainerNamesMatch(trainer, OWNER_TRAINER_NAME) ? sendAdminSMS(assignedText(practice)) : Promise.resolve(),
      trainer
        ? sendStPaulsAssignedAdminEmail({
            trainerName: trainer,
            isSelf: trainerNamesMatch(trainer, OWNER_TRAINER_NAME),
            teamName: practice.team_name,
            date: formatDateLong(practice.practice_date),
            time: `${formatTime12(hhmm(practice.start_time))}–${formatTime12(hhmm(practice.end_time))}`,
            coaches: practice.coaches || [],
          })
        : Promise.resolve(),
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
  // Everyone involved hears about it: Artemios, the assigned trainer, and
  // the coaches (text to the booker if they agreed to texts; email to all).
  // Cancelling a still-pending request is declining it, and is worded so.
  const wasPending = !practice.assigned_trainer;
  const when = `${formatDateLong(practice.practice_date)}, ${formatTime12(hhmm(practice.start_time))}–${formatTime12(hhmm(practice.end_time))}`;
  const coaches: { name?: string; phone?: string; email?: string }[] = practice.coaches || [];
  const bookerPhone = await bookerTextTarget(practice);
  await Promise.allSettled([
    practice.assigned_trainer ? notifyTrainerOfCancellation(notifyParams(practice, practice.assigned_trainer)) : Promise.resolve(),
    sendAdminSMS(wasPending
      ? `St. Paul's practice request DECLINED: ${practice.team_name}, ${when}. Coach notified.`
      : `St. Paul's practice CANCELLED: ${practice.team_name}, ${when} (trainer ${practice.assigned_trainer} notified).`),
    bookerPhone
      ? sendSMS(bookerPhone, wasPending
          ? `Mesa Basketball: Sorry, we couldn't confirm ${practice.team_name}'s practice request for ${when} at St. Paul's. Want another time? Text Artemios at (631) 599-1280. Reply STOP to opt out.`
          : `Mesa Basketball: ${practice.team_name}'s practice on ${when} at St. Paul's has been cancelled. Questions or a new time? Text Artemios at (631) 599-1280. Reply STOP to opt out.`)
      : Promise.resolve(),
    ...coaches.filter((c) => c.email).map((c) => sendStPaulsCancelCoachEmail({ to: c.email!, coachName: c.name || "Coach", teamName: practice.team_name, date: formatDateLong(practice.practice_date), time: `${formatTime12(hhmm(practice.start_time))}–${formatTime12(hhmm(practice.end_time))}`, wasPending })),
  ]);
  return NextResponse.json({ ok: true });
}
