import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification } from "@/lib/email";
import {
  addRegistrationWithRewards,
  isNewClient,
  getReferralCredits,
  decrementReferralCredit,
  addReferralCredit,
  findReferrerByCode,
  generateReferralCode,
  checkGroupSessionCapacity,
  getActivePackage,
  incrementPackageSessions,
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
      // Weekly multi-session fields
      weeklySessions,
      weeklyTotalPrice,
    } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Handle weekly multi-session registration
    if (type === "weekly" && weeklySessions && weeklySessions.length > 0) {
      const referralCode = generateReferralCode(parentName);

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

    const isPrivateType = type === "private" || type === "group-private";
    let manageToken: string | undefined;
    let isFree = false;
    let isFirstTime = false;
    const referralCode = generateReferralCode(parentName);

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
      });
      manageToken = result.manageToken;

      // If booking a private session with a booked_date, check for active package
      if (isPrivateType && bookedDate && !emailOnly) {
        const bookingMonth = bookedDate.substring(0, 7); // "2026-03"
        const activePkg = await getActivePackage(email, bookingMonth);
        if (activePkg && activePkg.sessions_used < activePkg.package_type) {
          await incrementPackageSessions(activePkg.id, activePkg.sessions_used);
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
