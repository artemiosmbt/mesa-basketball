import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification } from "@/lib/email";
import {
  addRegistrationWithRewards,
  getConfirmedSessionCount,
  getReferralCredits,
  addReferralCredit,
  findReferrerByCode,
  generateReferralCode,
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
    } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const isPrivateType = type === "private" || type === "group-private";
    let manageToken: string | undefined;
    let isFree = false;
    const referralCode = generateReferralCode(parentName);

    // Save to Supabase (unless this is an email-only request)
    if (!emailOnly) {
      // Check rewards eligibility for private/group-private sessions
      if (isPrivateType) {
        const sessionCount = await getConfirmedSessionCount(email);
        const credits = await getReferralCredits(email);
        // "Effective" sessions = paid sessions + referral credits
        // Free session triggers every 11th effective session (i.e., after 10 paid-equivalent)
        const effectiveCount = sessionCount + credits;
        // The NEXT session (the one being booked now) will be number effectiveCount + 1
        // It's free if (effectiveCount + 1) is a multiple of 11 (i.e., the 11th, 22nd, etc.)
        if ((effectiveCount + 1) % 11 === 0 && effectiveCount + 1 >= 11) {
          isFree = true;
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

      // Handle referral: if a new family used a valid referral code
      // After the insert above, a truly new family will have exactly 1 confirmed session
      if (submittedReferralCode && isPrivateType) {
        const currentCount = await getConfirmedSessionCount(email);
        if (currentCount <= 1) {
          const referrerEmail = await findReferrerByCode(submittedReferralCode);
          if (referrerEmail && referrerEmail !== email) {
            // Credit both the referrer and the new family
            await addReferralCredit(referrerEmail);
            await addReferralCredit(email);
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
