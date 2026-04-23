import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification, sendReferralCreditNotification } from "@/lib/email";
import { addPrivateSessionToCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import twilio from "twilio";

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function sendConfirmationSMS(phone: string, message: string) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !from) return;
    const client = twilio(accountSid, authToken);
    await client.messages.create({ body: message, from, to: formatPhone(phone) });
  } catch (err) {
    console.error("SMS confirmation failed:", err);
  }
}
import {
  addRegistrationWithRewards,
  isNewClient,
  getReferralCredits,
  decrementReferralCredit,
  addReferralCredit,
  findReferrerByCode,
  findReferrerInfoByCode,
  generateUniqueReferralCode,
  checkGroupSessionCapacity,
  checkDuplicateRegistration,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
} from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      parentName,
      email,
      phone,
      kids,
      type,
      sessionDetails,
      totalParticipants,
      bookedDate,
      bookedStartTime,
      bookedEndTime,
      bookedLocation,
      skipEmail,
      emailOnly,
      submittedReferralCode,
      smsConsent,
      // Weekly multi-session fields
      weeklySessions,
      weeklyTotalPrice,
      // Camp multi-day fields
      campSessions,
      campTotalPrice,
      campTotalDays,
    } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Handle weekly multi-session registration
    if (type === "weekly" && weeklySessions && weeklySessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

      // Check referral BEFORE saving (isNewClient returns false after registration is stored)
      let weeklyReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const info = await findReferrerInfoByCode(submittedReferralCode);
          if (info && info.email !== email) {
            weeklyReferrer = info;
          }
        }
      }

      // Check capacity for all selected sessions
      const capacityChecks = await Promise.all(
        weeklySessions.map((s: { date: string; startTime: string; endTime: string; location: string; group: string; maxSpots: number }) =>
          checkGroupSessionCapacity(s.date, s.startTime, s.maxSpots)
        )
      );

      const fullSessions = weeklySessions.filter(
        (_: unknown, i: number) => !capacityChecks[i].available
      );
      if (fullSessions.length > 0) {
        const fullDates = fullSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `The following sessions are full: ${fullDates}. Please deselect them and try again.` },
          { status: 400 }
        );
      }

      // Check for duplicate registrations
      const duplicateChecks = await Promise.all(
        weeklySessions.map((s: { date: string; startTime: string }) =>
          checkDuplicateRegistration(email, s.date, s.startTime)
        )
      );
      const duplicateSessions = weeklySessions.filter((_: unknown, i: number) => duplicateChecks[i]);
      if (duplicateSessions.length > 0) {
        const dupDates = duplicateSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `This email is already registered for the following session${duplicateSessions.length > 1 ? "s" : ""}: ${dupDates}. Please deselect ${duplicateSessions.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      // Create one registration row per selected session
      for (const session of weeklySessions) {
        const perSessionPrice = session.price ? session.price * (totalParticipants || 1) : undefined;
        await addRegistrationWithRewards({
          parentName,
          email,
          phone,
          kids,
          type: "weekly",
          sessionDetails: `${session.group} — ${session.date} ${session.startTime}-${session.endTime} at ${session.location}`,
          totalParticipants: totalParticipants || 1,
          bookedDate: session.date,
          bookedStartTime: session.startTime,
          bookedEndTime: session.endTime,
          bookedLocation: session.location,
          referralCode,
          isFree: false,
          smsConsent: !!smsConsent,
          sessionPrice: perSessionPrice,
        });
      }

      // Send ONE consolidated email
      const allSessionsList = weeklySessions
        .map((s: { date: string; startTime: string; endTime: string; location: string }) =>
          `${s.date} ${s.startTime}-${s.endTime} at ${s.location}`
        )
        .join("<br/>");

      const priceNote = weeklyTotalPrice
        ? `<p><strong>Total:</strong> $${weeklyTotalPrice}</p>`
        : "";

      await sendRegistrationNotification({
        parentName,
        email,
        phone,
        kids,
        type: "weekly",
        sessionDetails: `Group Session${weeklySessions.length !== 1 ? "s" : ""} (${weeklySessions.length} ${weeklySessions.length !== 1 ? "dates" : "date"}):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
        totalParticipants: totalParticipants || 1,
        referralCode,
        referredBy: weeklyReferrer?.name,
        calendarEvent: weeklySessions[0] ? { date: weeklySessions[0].date, startTime: weeklySessions[0].startTime, endTime: weeklySessions[0].endTime, location: weeklySessions[0].location } : undefined,
      });

      if (weeklyReferrer) {
        await addReferralCredit(weeklyReferrer.email);
        await sendReferralCreditNotification({ referrerName: weeklyReferrer.name, referrerEmail: weeklyReferrer.email, newClientName: parentName });
      }

      if (smsConsent) {
        await sendConfirmationSMS(phone, `Mesa Basketball: You're registered for ${weeklySessions.length} group session${weeklySessions.length !== 1 ? "s" : ""}! Check your email for details. Reply STOP to opt out.`);
      }

      // Update Google Calendar for each weekly session
      for (const session of weeklySessions) {
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "weekly",
            sessionLabel: session.group || "Group Session",
            bookedDate: session.date,
            bookedStartTime: session.startTime,
            bookedEndTime: session.endTime,
            bookedLocation: session.location,
            maxSpots: session.maxSpots,
            kidsJustRegistered: kids,
            participantsJustRegistered: totalParticipants || 1,
          });
        } catch (err) {
          console.error("Calendar sync error (weekly):", err);
        }
      }

      return NextResponse.json({ success: true, count: weeklySessions.length });
    }

    // Handle camp multi-day registration
    if (type === "camp" && campSessions && campSessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

      // Check referral BEFORE saving (isNewClient returns false after registration is stored)
      let campReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const info = await findReferrerInfoByCode(submittedReferralCode);
          if (info && info.email !== email) {
            campReferrer = info;
          }
        }
      }

      // Check for duplicate camp day registrations
      const campDuplicateChecks = await Promise.all(
        campSessions.map((s: { date: string; startTime: string }) =>
          checkDuplicateRegistration(email, s.date, s.startTime)
        )
      );
      const duplicateCampDays = campSessions.filter((_: unknown, i: number) => campDuplicateChecks[i]);
      if (duplicateCampDays.length > 0) {
        const dupDates = duplicateCampDays.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `This email is already registered for the following camp day${duplicateCampDays.length > 1 ? "s" : ""}: ${dupDates}. Please deselect ${duplicateCampDays.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      // Parse total price string (e.g. "$290" or "$290 (Early Bird)") to a number
      const campTotalNum = campTotalPrice ? parseInt(String(campTotalPrice).replace(/\D/g, "")) || 0 : 0;

      // Determine if this is a full camp purchase or drop-in days
      // campSessions comes from the selected days; we need the total available days to compare.
      // The frontend passes campTotalDays alongside campSessions for this check.
      const isFullCamp = campTotalDays != null
        ? campSessions.length === campTotalDays
        : false;

      // Full camp: store total price paid (for 50% fee on full cancel).
      // Drop-in: store per-day price (for 50% fee on individual day cancel).
      const sessionPrice = campTotalNum > 0
        ? isFullCamp
          ? campTotalNum
          : Math.round(campTotalNum / campSessions.length)
        : undefined;

      for (const session of campSessions) {
        await addRegistrationWithRewards({
          parentName,
          email,
          phone,
          kids,
          type: "camp",
          sessionDetails: `${session.campName}${session.gradeGroup ? ` — ${session.gradeGroup}` : ""} — ${session.date} ${session.startTime}${session.endTime ? `-${session.endTime}` : ""} at ${session.location}`,
          totalParticipants: totalParticipants || 1,
          bookedDate: session.date,
          bookedStartTime: session.startTime,
          bookedEndTime: session.endTime || "",
          bookedLocation: session.location,
          referralCode,
          isFree: false,
          smsConsent: !!smsConsent,
          sessionPrice,
          isFullCamp,
        });
      }

      const daysList = campSessions
        .map((s: { date: string; startTime: string; endTime: string }) => `${s.date} ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}`)
        .join("<br/>");
      const priceNote = campTotalPrice ? `<br/><strong>Total:</strong> ${campTotalPrice}` : "";
      const firstSession = campSessions[0];

      await sendRegistrationNotification({
        parentName,
        email,
        phone,
        kids,
        type: "camp",
        sessionDetails: `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}<br/>Days registered (${campSessions.length}):<br/>${daysList}${priceNote}`,
        totalParticipants: totalParticipants || 1,
        referralCode,
        referredBy: campReferrer?.name,
        calendarEvent: { date: firstSession.date, startTime: firstSession.startTime, endTime: firstSession.endTime || firstSession.startTime, location: firstSession.location },
      });

      if (campReferrer) {
        await addReferralCredit(campReferrer.email);
        await sendReferralCreditNotification({ referrerName: campReferrer.name, referrerEmail: campReferrer.email, newClientName: parentName });
      }

      if (smsConsent) {
        const priceText = campTotalPrice ? ` Total: ${campTotalPrice}.` : "";
        await sendConfirmationSMS(phone, `Mesa Basketball: Camp registration confirmed for ${campSessions.length} day${campSessions.length !== 1 ? "s" : ""}!${priceText} Check your email for details. Reply STOP to opt out.`);
      }

      // Update Google Calendar for each camp day
      for (const session of campSessions) {
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "camp",
            sessionLabel: session.campName || "Camp",
            bookedDate: session.date,
            bookedStartTime: session.startTime,
            bookedEndTime: session.endTime || session.startTime,
            bookedLocation: session.location,
            kidsJustRegistered: kids,
            participantsJustRegistered: totalParticipants || 1,
          });
        } catch (err) {
          console.error("Calendar sync error (camp):", err);
        }
      }

      return NextResponse.json({ success: true, count: campSessions.length });
    }

    const isPrivateType = type === "private" || type === "group-private";
    let manageToken: string | undefined;
    let isFree = false;
    let isFirstTime = false;
    let packageSessionsRemaining: number | undefined;
    let packageType: number | undefined;
    const referralCode = await generateUniqueReferralCode(parentName, email);
    let privateReferrer: { email: string; name: string } | null = null;

    // Save to Supabase (unless this is an email-only request)
    if (!emailOnly) {
      // Check new-client status and referral BEFORE saving
      const newClient = await isNewClient(email, phone);
      if (submittedReferralCode && newClient) {
        const info = await findReferrerInfoByCode(submittedReferralCode);
        if (info && info.email !== email) {
          privateReferrer = info;
        }
      }

      // Check first-time discount and referral credit
      if (isPrivateType) {
        if (newClient) {
          isFree = true; // first-time 50% off
          isFirstTime = true;
        } else {
          const credits = await getReferralCredits(email);
          if (credits > 0) {
            isFree = true; // referral half-off credit
            await decrementReferralCredit(email);
          }
        }
      }

      const result = await addRegistrationWithRewards({
        parentName,
        email,
        phone,
        kids,
        type,
        sessionDetails,
        totalParticipants: totalParticipants || 1,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        referralCode,
        isFree,
        smsConsent: !!smsConsent,
      });
      manageToken = result.manageToken;

      // If booking a private session with a booked_date, check for active package
      if (isPrivateType && bookedDate && !emailOnly) {
        const d = new Date(bookedDate);
        const bookingMonth = isNaN(d.getTime())
          ? null
          : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const activePkg = bookingMonth ? await getActivePackage(email, bookingMonth) : null;
        if (activePkg && bookingMonth) {
          const confirmedCount = await countConfirmedPrivateSessions(email, bookingMonth);
          const newUsed = Math.min(activePkg.package_type, confirmedCount);
          await setPackageSessions(activePkg.id, newUsed);
          if (newUsed <= activePkg.package_type) {
            packageSessionsRemaining = activePkg.package_type - newUsed;
            packageType = activePkg.package_type;
          }
        }
      }

      // Award referral credit to referrer and notify them
      if (privateReferrer) {
        await addReferralCredit(privateReferrer.email);
        await sendReferralCreditNotification({ referrerName: privateReferrer.name, referrerEmail: privateReferrer.email, newClientName: parentName });
      }
    }

    // Send emails (unless this registration should skip email)
    if (!skipEmail) {
      await sendRegistrationNotification({
        parentName,
        email,
        phone,
        kids,
        type,
        sessionDetails,
        totalParticipants: totalParticipants || 1,
        manageToken,
        isFree,
        isFirstTime,
        packageSessionsRemaining,
        packageType,
        referralCode,
        referredBy: privateReferrer?.name,
        calendarEvent: bookedDate && bookedStartTime ? { date: bookedDate, startTime: bookedStartTime, endTime: bookedEndTime || bookedStartTime, location: bookedLocation || "" } : undefined,
      });

      if (smsConsent && !emailOnly) {
        const typeLabel = isPrivateType ? "private session" : "session";
        await sendConfirmationSMS(phone, `Mesa Basketball: Your ${typeLabel} is confirmed! Check your email for details. Reply STOP to opt out.`);
      }
    }

    // Add to Google Calendar (private sessions only; group/camp handled above)
    if (!emailOnly && bookedDate && bookedStartTime && bookedEndTime) {
      if (isPrivateType) {
        try {
          await addPrivateSessionToCalendar({
            parentName,
            email,
            phone,
            kids,
            bookedDate,
            bookedStartTime,
            bookedEndTime,
            bookedLocation: bookedLocation || "",
          });
        } catch (err) {
          console.error("Calendar sync error (private):", err);
        }
      }
    }

    return NextResponse.json({ success: true, isFree });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 }
    );
  }
}
