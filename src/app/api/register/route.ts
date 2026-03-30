import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification } from "@/lib/email";
import {
  addRegistrationWithRewards,
  isNewClient,
  getReferralCredits,
  decrementReferralCredit,
  addReferralCredit,
  findReferrerByCode,
  generateUniqueReferralCode,
  checkGroupSessionCapacity,
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

      // Create one registration row per selected session
      for (const session of weeklySessions) {
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
        sessionDetails: `Group Sessions (${weeklySessions.length} dates):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
        totalParticipants: totalParticipants || 1,
      });

      return NextResponse.json({ success: true, count: weeklySessions.length });
    }

    // Handle camp multi-day registration
    if (type === "camp" && campSessions && campSessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

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
      });

      return NextResponse.json({ success: true, count: campSessions.length });
    }

    const isPrivateType = type === "private" || type === "group-private";
    let manageToken: string | undefined;
    let isFree = false;
    let isFirstTime = false;
    let packageSessionsRemaining: number | undefined;
    let packageType: number | undefined;
    const referralCode = await generateUniqueReferralCode(parentName, email);

    // Save to Supabase (unless this is an email-only request)
    if (!emailOnly) {
      // Check first-time discount and referral credit
      if (isPrivateType) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          isFree = true; // repurposed: means "discount applied" (50% off)
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
          // Count confirmed sessions including the one just saved
          const confirmedCount = await countConfirmedPrivateSessions(email, bookingMonth);
          const newUsed = Math.min(activePkg.package_type, confirmedCount);
          await setPackageSessions(activePkg.id, newUsed);
          if (newUsed <= activePkg.package_type) {
            packageSessionsRemaining = activePkg.package_type - newUsed;
            packageType = activePkg.package_type;
          }
        }
      }

      // Handle referral: if a verified new client used a referral code, reward the referrer
      if (submittedReferralCode && isPrivateType) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const referrerEmail = await findReferrerByCode(submittedReferralCode);
          if (referrerEmail && referrerEmail !== email) {
            await addReferralCredit(referrerEmail); // referrer gets 1 half-off credit
          }
        }
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
        referralCode: isPrivateType ? referralCode : undefined,
      });
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
