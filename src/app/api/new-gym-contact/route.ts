import { NextRequest, NextResponse } from "next/server";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";
import { trainerNamesMatch } from "@/lib/trainers";
import { mentionsNewGym } from "@/lib/new-gym";
import { trainerHelpContact } from "@/lib/new-gym-server";

// Who to text/call if a family can't find the new gym — for the booking
// page's new-location popup. Trainer numbers stay out of the public page
// bundle (see trainer-contacts.ts); this hands one out only for a trainer
// who actually has a session at the new gym on the live schedule (anyone
// else gets Artemios's number), so it can't be used to look up any
// trainer's number at will.
export async function GET(req: NextRequest) {
  const trainer = new URL(req.url).searchParams.get("trainer") || "";
  let atNewGym = false;
  if (trainer) {
    const [weekly, slots] = await Promise.all([
      getWeeklySchedule().catch(() => []),
      getPrivateSlots().catch(() => []),
    ]);
    atNewGym = [...weekly, ...slots].some((s) => mentionsNewGym(s.location) && trainerNamesMatch(s.trainer, trainer));
  }
  return NextResponse.json(trainerHelpContact(atNewGym ? trainer : null));
}
