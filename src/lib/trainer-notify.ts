import { getTrainerContact } from "./auth";
import { sendTrainerNewBookingEmail, sendTrainerCancellationEmail, sendTrainerRescheduleEmail } from "./email";
import { sendSMS } from "./sms";

// Notifies the trainer actually assigned to a booking (not the admin — see
// sendRegistrationNotification/sendAdminSMS for that, called separately and
// unconditionally everywhere these are). Every function here is a no-op if
// `trainer` doesn't resolve to a configured TRAINER_ACCOUNTS entry (Artemios
// himself, an unrecognized/typo'd name, or a trainer with no contact info
// yet on file) — callers can invoke this unconditionally on every booking
// without checking who the trainer is first.

export async function notifyTrainerOfNewBooking(params: {
  trainer: string | null | undefined;
  parentName: string;
  kids?: string;
  sessionLabel: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
}): Promise<void> {
  const contact = getTrainerContact(params.trainer);
  if (!contact) return;
  const trainerName = contact.trainerName!;
  if (contact.email) {
    try {
      await sendTrainerNewBookingEmail({ to: contact.email, trainerName, ...params });
    } catch (err) {
      console.error("Trainer new-booking email failed:", err);
    }
  }
  if (contact.phone) {
    await sendSMS(
      contact.phone,
      `New booking: ${params.sessionLabel} with ${params.kids || params.parentName} on ${params.date} ${params.startTime}-${params.endTime} at ${params.location}.`
    );
  }
}

export async function notifyTrainerOfCancellation(params: {
  trainer: string | null | undefined;
  parentName: string;
  sessionLabel: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
}): Promise<void> {
  const contact = getTrainerContact(params.trainer);
  if (!contact) return;
  const trainerName = contact.trainerName!;
  if (contact.email) {
    try {
      await sendTrainerCancellationEmail({ to: contact.email, trainerName, ...params });
    } catch (err) {
      console.error("Trainer cancellation email failed:", err);
    }
  }
  if (contact.phone) {
    await sendSMS(
      contact.phone,
      `CANCELLED: ${params.sessionLabel} with ${params.parentName} on ${params.date} ${params.startTime}-${params.endTime} at ${params.location} — off your schedule.`
    );
  }
}

export async function notifyTrainerOfReschedule(params: {
  trainer: string | null | undefined;
  parentName: string;
  sessionLabel: string;
  oldDate: string;
  oldStartTime: string;
  oldEndTime: string;
  newDate: string;
  newStartTime: string;
  newEndTime: string;
  location: string;
}): Promise<void> {
  const contact = getTrainerContact(params.trainer);
  if (!contact) return;
  const trainerName = contact.trainerName!;
  if (contact.email) {
    try {
      await sendTrainerRescheduleEmail({ to: contact.email, trainerName, ...params });
    } catch (err) {
      console.error("Trainer reschedule email failed:", err);
    }
  }
  if (contact.phone) {
    await sendSMS(
      contact.phone,
      `RESCHEDULED: ${params.sessionLabel} with ${params.parentName} — was ${params.oldDate} ${params.oldStartTime}-${params.oldEndTime}, now ${params.newDate} ${params.newStartTime}-${params.newEndTime} at ${params.location}.`
    );
  }
}
