import { sendTimeChangeNotification } from "./email";
import { sendSMS, formatDateWithDay, resolveLocationName } from "./sms";
import { addPrivateSessionToCalendar, deletePrivateSessionFromCalendar } from "./calendar";

// Shared by src/app/api/cron/detect-time-changes/route.ts (fires on every
// sheet edit) and src/app/api/admin/sync-time-changes/route.ts (fires on
// every admin dashboard load) — same reason the matching/claim logic in
// private-schedule-matching.ts is centralized instead of duplicated: the
// two routes' weekly time-change logic already drifted apart once before
// this pattern was adopted, and this notify step (email, SMS, calendar
// resync) is the part most likely to need a matching future fix in both
// places if it ever stayed duplicated.
export async function notifyPrivateLocationChange(params: {
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  booked_date: string;
  booked_start_time: string;
  booked_end_time: string | null;
  booked_trainer: string | null;
  sms_consent: boolean | null;
  oldLocation: string;
  newLocation: string;
}): Promise<{ emailSent: boolean; smsSent: boolean }> {
  let emailSent = false;
  let smsSent = false;

  try {
    await sendTimeChangeNotification({
      parentName: params.parent_name,
      email: params.email,
      kids: params.kids,
      date: params.booked_date,
      sessionLabel: params.type === "group-private" ? "Group Private Session" : "Private Session",
      oldStartTime: params.booked_start_time,
      oldEndTime: params.booked_end_time || params.booked_start_time,
      newStartTime: params.booked_start_time,
      newEndTime: params.booked_end_time || params.booked_start_time,
      location: params.newLocation,
      changeType: "location",
      oldLocation: params.oldLocation,
    });
    emailSent = true;
  } catch (err) {
    console.error("Private location-change email failed for", params.email, err);
  }

  if (params.sms_consent && params.phone) {
    const dateStr = formatDateWithDay(params.booked_date);
    const locName = resolveLocationName(params.newLocation);
    const oldLocName = resolveLocationName(params.oldLocation);
    const timeStr = `${params.booked_start_time}${params.booked_end_time ? `-${params.booked_end_time}` : ""}`;
    try {
      await sendSMS(
        params.phone,
        `LOCATION CHANGE\nMesa Basketball: Private Session on ${dateStr}\nLocation: ${oldLocName} → ${locName}\nTime: ${timeStr}\nQuestions? (631) 599-1280. Reply STOP to opt out.`
      );
      smsSent = true;
    } catch (err) {
      console.error("Private location-change SMS failed for", params.phone, err);
    }
  }

  try {
    await deletePrivateSessionFromCalendar({ email: params.email, bookedDate: params.booked_date, bookedStartTime: params.booked_start_time });
    await addPrivateSessionToCalendar({
      parentName: params.parent_name,
      email: params.email,
      phone: params.phone,
      kids: params.kids,
      bookedDate: params.booked_date,
      bookedStartTime: params.booked_start_time,
      bookedEndTime: params.booked_end_time || params.booked_start_time,
      bookedLocation: params.newLocation,
      trainer: params.booked_trainer || undefined,
    });
  } catch (err) {
    console.error("Calendar sync error (private location change):", err);
  }

  return { emailSent, smsSent };
}
